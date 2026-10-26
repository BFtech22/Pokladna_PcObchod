"""Import katalogu a stavu skladu z Trellu (export skladových karet pro e-shop, XML).

Trell exportuje jen název, počet kusů, prodejní cenu s DPH, sklad a jeden kód s předponou „X“.
Sazba DPH se proto bere 21 %, jednotka ks, nákupní cena zůstane prázdná až do prvního příjmu.
Stav skladu se zapíše jako inventurní pohyb „import Trell“. Opakovaný import (např. finální převod
k 31. 12.) najde existující zboží podle EAN, kódu nebo názvu, aktualizuje ho a stav dorovná.

Ruční spuštění: python -m pokladna.import_trell SOUBOR.xml [--provest] [--zaporne-na-nulu] [--bez-serii]
"""

from __future__ import annotations

import argparse
import collections
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from lxml import etree

from . import db
from .faktury import platny_ean

DOKLAD = "import Trell"
# Zařízení, u kterých se při prodeji načítá IMEI / sériové číslo (když je volba zapnutá): podle celého názvu
# kategorie nebo podle začátku názvu karty (v Trellu jsou telefony i v „Ostatní“) – ne příslušenství.
KATEGORIE_SE_SERII = re.compile(r"^(mobilní telef\w*|tablety?|notebooky?|počítače|mini pc|pc)$", re.I)
NAZEV_ZARIZENI = re.compile(r"^(MT|NTB|Mobiln[ií] telefon|Smartphone|Tablet|Notebook)\b", re.I)
NAZEV_PRISLUSENSTVI = re.compile(r"\b(pouzdr\w*|sklo|skla|fólie|folie|kabel\w*|nabíje\w*|kryt\w*|bateri\w*|držák\w*|brašn\w*|obal\w*|"
                                 r"adaptér\w*|stylus|klávesnic\w*|myš\w*|taška|batoh|podložk\w*|dock\w*|redukc\w*)\b", re.I)


def eviduje_serii(k: "Karta") -> bool:
    zarizeni = bool(k.kategorie and KATEGORIE_SE_SERII.search(k.kategorie)) or bool(NAZEV_ZARIZENI.search(k.nazev))
    return zarizeni and not NAZEV_PRISLUSENSTVI.search(k.nazev)


class ChybaImportu(Exception):
    pass


@dataclass
class Karta:
    nazev: str
    kategorie: Optional[str]
    cena: int                                   # s DPH v haléřích
    stav: float
    kod_trell: str
    eany: List[str] = field(default_factory=list)
    kod: Optional[str] = None                   # interní kód (co není platný EAN)
    sklad: Optional[str] = None
    poznamky: List[str] = field(default_factory=list)


def _text(data: bytes) -> str:
    """Trell píše v hlavičce iso-8859-2, data jsou ale ve windows-1250 (š, ť, ž by se rozbily)."""
    hlavicka = data[:200].decode("ascii", "ignore").lower()
    if "utf-8" in hlavicka:
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            pass
    return data.decode("cp1250", errors="replace")


def _cislo(t: Optional[str]) -> Optional[float]:
    t = re.sub(r"[\s ]", "", t or "").replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def nacti(data: bytes) -> Tuple[List[Karta], List[str]]:
    text = _text(data)
    opravenych = len(re.findall(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)", text))
    text = re.sub(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)", "&amp;", text)
    text = re.sub(r'encoding\s*=\s*"[^"]+"', 'encoding="utf-8"', text, count=1)
    try:
        koren = etree.fromstring(text.encode("utf-8"), etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True))
    except etree.XMLSyntaxError as e:
        raise ChybaImportu(f"Soubor není platný export z Trellu: {e}")
    if koren.tag != "sortiment":
        raise ChybaImportu("Čekám export skladových karet z Trellu (XML se značkou <sortiment>)")
    varovani = [f"Opraveno {opravenych}× neošetřené „&“ v názvu"] if opravenych else []

    # Kategorie se v Trellu píšou různě („Myši“ i „myši“) – sloučit a vzít nejčastější tvar.
    tvary: dict = collections.defaultdict(collections.Counter)
    surove = []
    for k in koren.iter("kategorie"):
        kat = (k.findtext("kategorie_desc") or "").strip()
        for it in k.findall("item"):
            surove.append((kat, it))
            if kat:
                tvary[kat.lower()][kat] += 1
    def kategorie(k: str) -> Optional[str]:
        if not k:
            return None
        t = tvary[k.lower()].most_common(1)[0][0]
        return t[:1].upper() + t[1:]

    karty: List[Karta] = []
    pouzite_eany: dict = {}
    pouzite_kody: dict = {}
    for kat, it in surove:
        nazev = (it.findtext("item_name") or "").strip()
        kod_trell = (it.findtext("item_code") or "").strip()
        kod = kod_trell[1:] if kod_trell.startswith("X") and len(kod_trell) > 1 else kod_trell
        cena = _cislo(it.findtext("item_price"))
        stav = _cislo(it.findtext("item_kusu"))
        karta = Karta(nazev=nazev or f"(bez názvu) {kod}", kategorie=kategorie(kat), cena=int(round((cena or 0) * 100)),
                      stav=stav or 0, kod_trell=kod_trell, sklad=(it.findtext("item_sklad") or "").strip() or None)
        if not nazev:
            karta.poznamky.append("v Trellu bez názvu")
        if cena is None:
            karta.poznamky.append("neplatná cena")
        if karta.sklad and karta.sklad != "PcObchod":
            karta.poznamky.append(f"v Trellu na skladu {karta.sklad}")
        if kod.isdigit() and platny_ean(kod):
            kandidati = [kod] + (["0" + kod] if len(kod) == 12 else [])      # UPC-A: čtečka může poslat 12 i 13 číslic
            for e in kandidati:
                if e in pouzite_eany:
                    karta.poznamky.append(f"EAN {e} má už „{pouzite_eany[e]}“")
                else:
                    pouzite_eany[e] = karta.nazev
                    karta.eany.append(e)
            if not karta.eany and kod not in pouzite_kody:     # EAN má jiná karta – kód aspoň jako interní, ať jde kartu najít
                pouzite_kody[kod] = karta.nazev
                karta.kod = kod
        elif kod:
            if kod in pouzite_kody:
                karta.poznamky.append(f"kód {kod} má už „{pouzite_kody[kod]}“")
            else:
                pouzite_kody[kod] = karta.nazev
                karta.kod = kod
        karty.append(karta)
    if not karty:
        raise ChybaImportu("V exportu nejsou žádné skladové karty")
    return karty, varovani


def _najdi(con, k: Karta, nove: frozenset = frozenset()) -> Optional[int]:
    """Existující zboží pro kartu: podle EAN, pak kódu; podle názvu jen karta bez kódu.
    Zboží založené tímtéž importem (`nove`) se nepočítá – v Trellu bývá víc karet se stejným názvem."""
    for e in k.eany:
        r = con.execute("SELECT zbozi_id FROM zbozi_ean WHERE ean = ?", (e,)).fetchone()
        if r:
            return r[0]
    if k.kod:
        r = con.execute("SELECT id FROM zbozi WHERE kod = ?", (k.kod,)).fetchone()
        if r:
            return r[0]
    if k.eany or k.kod:
        return None
    r = con.execute("SELECT id FROM zbozi WHERE nazev = ? ORDER BY id LIMIT 2", (k.nazev,)).fetchall()
    return r[0][0] if len(r) == 1 and r[0][0] not in nove else None


def nahled(con, karty: List[Karta], zaporne_na_nulu: bool = False, serie: bool = True) -> dict:
    existuje = sum(1 for k in karty if _najdi(con, k))
    skladem = [k for k in karty if k.stav > 0]
    kategorie = collections.Counter(k.kategorie or "(bez kategorie)" for k in karty)
    return {
        "pocet": len(karty), "nove": len(karty) - existuje, "existuje": existuje,
        "skladem": len(skladem), "nula": sum(1 for k in karty if k.stav == 0), "zaporne": sum(1 for k in karty if k.stav < 0),
        "kusu": sum(k.stav for k in skladem), "hodnota": sum(int(round(k.cena * k.stav)) for k in skladem),
        "s_ean": sum(1 for k in karty if k.eany), "s_kodem": sum(1 for k in karty if k.kod), "bez_kodu": sum(1 for k in karty if not k.eany and not k.kod),
        "bez_ceny": sum(1 for k in karty if not k.cena), "se_serii": sum(1 for k in karty if serie and eviduje_serii(k)),
        "kategorii": len(kategorie), "kategorie": kategorie.most_common(12),
        "upozorneni": [{"nazev": k.nazev, "kod": k.kod_trell, "text": "; ".join(k.poznamky)} for k in karty if k.poznamky][:50],
        "pocet_upozorneni": sum(1 for k in karty if k.poznamky),
        "ukazka": [{"nazev": k.nazev, "kategorie": k.kategorie, "cena": k.cena, "stav": (0 if zaporne_na_nulu and k.stav < 0 else k.stav),
                    "eany": k.eany, "kod": k.kod} for k in skladem[:12]],
        "zaporne_na_nulu": zaporne_na_nulu,
    }


def importuj(con, karty: List[Karta], uid: Optional[int], zaporne_na_nulu: bool = False, serie: bool = True) -> dict:
    """Zapíše karty do katalogu a dorovná stav skladu. Vše v jedné transakci."""
    vysl = {"nove": 0, "aktualizovane": 0, "korekce": 0, "eanu": 0}
    ted = db.ted()
    nove: set = set()
    with db.transakce(con):
        for k in karty:
            cil = 0.0 if zaporne_na_nulu and k.stav < 0 else k.stav
            se_serii = int(serie and eviduje_serii(k))
            poznamka = "; ".join(k.poznamky) or None
            zid = _najdi(con, k, frozenset(nove))
            if zid is None:
                zid = con.execute(
                    "INSERT INTO zbozi (nazev, kod, kategorie, cena, sazba_dph, nakupni_cena, jednotka, min_stav, aktivni, poznamka, "
                    "vytvoreno, upraveno, seriova_cisla, zaruka_mesice) VALUES (?, ?, ?, ?, 21, NULL, 'ks', 0, 1, ?, ?, ?, ?, 24)",
                    (k.nazev, k.kod, k.kategorie, k.cena, poznamka, ted, ted, se_serii)).lastrowid
                nove.add(zid)
                vysl["nove"] += 1
            else:
                con.execute("UPDATE zbozi SET nazev = ?, kategorie = COALESCE(?, kategorie), cena = ?, upraveno = ?, "
                            "kod = COALESCE(kod, ?) WHERE id = ?", (k.nazev, k.kategorie, k.cena, ted, k.kod, zid))
                vysl["aktualizovane"] += 1
            for e in k.eany:
                n = con.execute("INSERT OR IGNORE INTO zbozi_ean (ean, zbozi_id) VALUES (?, ?)", (e, zid)).rowcount
                vysl["eanu"] += n
            stav = con.execute("SELECT stav FROM zbozi WHERE id = ?", (zid,)).fetchone()[0]
            rozdil = round(cil - stav, 3)
            if rozdil:
                db.pohyb(con, zid, rozdil, "KOREKCE", DOKLAD, uid, "stav z Trellu")
                vysl["korekce"] += 1
    return vysl


def main() -> None:
    ap = argparse.ArgumentParser(description="Import katalogu a stavu skladu z Trellu (XML export skladových karet)")
    ap.add_argument("soubor")
    ap.add_argument("--provest", action="store_true", help="opravdu zapsat (bez toho jen náhled)")
    ap.add_argument("--zaporne-na-nulu", action="store_true", help="záporné stavy z Trellu zapsat jako 0")
    ap.add_argument("--bez-serii", action="store_true", help="u telefonů, tabletů a notebooků nezapínat načítání IMEI / SN")
    a = ap.parse_args()
    db.inicializuj()
    with open(a.soubor, "rb") as f:
        karty, varovani = nacti(f.read())
    with db.spojeni() as con:
        n = nahled(con, karty, a.zaporne_na_nulu, not a.bez_serii)
        print(f"Karet {n['pocet']} (nových {n['nove']}, existujících {n['existuje']}), skladem {n['skladem']}, nula {n['nula']}, "
              f"záporných {n['zaporne']}, hodnota {n['hodnota'] / 100:,.0f} Kč, s EAN {n['s_ean']}, s interním kódem {n['s_kodem']}")
        for v in varovani:
            print("!", v)
        if a.provest:
            print("Zapsáno:", importuj(con, karty, None, a.zaporne_na_nulu, not a.bez_serii))
        else:
            print("Jen náhled – zapíše se s --provest")


if __name__ == "__main__":
    main()
