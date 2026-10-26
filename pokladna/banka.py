"""Bankovní výpisy: čtení GPC (ABO), camt.053 (XML) a CSV a párování příchozích plateb s fakturami.

Faktura se spáruje, když sedí variabilní symbol a částka (celá, nebo snížená o opravné doklady).
Pohyb se zapisuje jen jednou – opakované načtení stejného výpisu nic nezdvojí.
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import List, Optional

from lxml import etree


class ChybaVypisu(Exception):
    pass


@dataclass
class Pohyb:
    datum: str                     # RRRR-MM-DD
    castka: int                    # v haléřích, kladná = příchozí
    vs: Optional[str] = None
    protiucet: Optional[str] = None
    nazev: Optional[str] = None
    zprava: Optional[str] = None
    id_banky: Optional[str] = None

    def otisk(self) -> str:
        t = "|".join(str(x or "") for x in (self.id_banky, self.datum, self.castka, self.vs, self.protiucet, self.zprava))
        return hashlib.sha1(t.encode()).hexdigest()


def _text(data: bytes) -> str:
    for kod in ("utf-8-sig", "cp1250"):
        try:
            return data.decode(kod)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def _vs(t: Optional[str]) -> Optional[str]:
    t = re.sub(r"\D", "", t or "").lstrip("0")
    return t or None


def _halere(t: str) -> Optional[int]:
    t = (t or "").strip().replace(" ", "").replace(" ", "").replace("CZK", "")
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".")
    else:
        t = t.replace(",", ".")
    try:
        return int((Decimal(t) * 100).quantize(Decimal("1")))
    except InvalidOperation:
        return None


def _datum(t: str) -> Optional[str]:
    t = (t or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return m.group(0)
    m = re.match(r"^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})", t)
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    return None


# --------------------------------------------------------------------------- GPC (ABO)

def cti_gpc(text: str) -> List[Pohyb]:
    """Formát ABO/GPC: věty 075 s pevnými pozicemi (Fio, ČSOB, KB, MONETA, Raiffeisen…)."""
    out = []
    for radek in text.splitlines():
        if not radek.startswith("075") or len(radek) < 97:
            continue
        protiucet = radek[19:35].lstrip("0")
        castka = int(radek[48:60] or 0)
        kod = radek[60:61]
        if kod in ("1", "5"):          # debet a storno kreditu snižují zůstatek
            castka = -castka
        ks = radek[71:81]
        banka = ks[2:6] if len(ks) >= 6 else ""
        valuta = radek[91:97]
        try:
            datum = date(2000 + int(valuta[4:6]), int(valuta[2:4]), int(valuta[0:2])).isoformat()
        except ValueError:
            continue
        out.append(Pohyb(datum=datum, castka=castka, vs=_vs(radek[61:71]), id_banky=radek[35:48].strip() or None,
                         protiucet=f"{protiucet}/{banka}" if protiucet and banka.strip("0") else (protiucet or None),
                         nazev=radek[97:117].strip() or None))
    return out


# --------------------------------------------------------------------------- camt.053

def cti_camt(data: bytes) -> List[Pohyb]:
    try:
        koren = etree.fromstring(data, parser=etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError as e:
        raise ChybaVypisu(f"XML výpisu nejde přečíst: {e}")

    def najdi(el, *cesta):
        for jmeno in cesta:
            if el is None:
                return None
            el = next((c for c in el.iter() if isinstance(c.tag, str) and etree.QName(c).localname == jmeno), None)
        return el

    def text(el, *cesta):
        x = najdi(el, *cesta)
        return x.text.strip() if x is not None and x.text else None

    out = []
    for ntry in (e for e in koren.iter() if isinstance(e.tag, str) and etree.QName(e).localname == "Ntry"):
        castka = _halere(text(ntry, "Amt") or "")
        if castka is None:
            continue
        if text(ntry, "CdtDbtInd") == "DBIT":
            castka = -castka
        datum = _datum(text(ntry, "BookgDt", "Dt") or text(ntry, "BookgDt", "DtTm") or text(ntry, "ValDt", "Dt") or "")
        zprava = " ".join(x.text.strip() for x in ntry.iter() if isinstance(x.tag, str) and etree.QName(x).localname == "Ustrd" and x.text)
        reference = " ".join(filter(None, [text(ntry, "EndToEndId"), text(ntry, "CdtrRefInf", "Ref"), zprava]))
        m = re.search(r"VS[:/ ]*(\d{1,10})", reference, re.I) or re.search(r"(?<!\d)(\d{4,10})(?!\d)", text(ntry, "EndToEndId") or "")
        protiucet = text(ntry, "DbtrAcct", "IBAN") or text(ntry, "DbtrAcct", "Othr", "Id")
        out.append(Pohyb(datum=datum or date.today().isoformat(), castka=castka, vs=_vs(m.group(1)) if m else None,
                         protiucet=protiucet, nazev=text(ntry, "Dbtr", "Nm"), zprava=zprava or None,
                         id_banky=text(ntry, "AcctSvcrRef") or text(ntry, "NtryRef")))
    return out


# --------------------------------------------------------------------------- CSV

SLOUPCE = {
    "datum": ("datum", "date", "datum zaúčtování", "datum provedení"),
    "castka": ("objem", "částka", "castka", "amount", "suma"),
    "vs": ("vs", "variabilní symbol", "variabilni symbol"),
    "protiucet": ("protiúčet", "protiucet", "číslo protiúčtu", "účet protistrany", "cislo protiuctu"),
    "banka": ("kód banky", "kod banky", "banka protiúčtu"),
    "nazev": ("název protiúčtu", "nazev protiuctu", "protistrana", "název protistrany", "jméno protistrany"),
    "zprava": ("zpráva pro příjemce", "zprava pro prijemce", "poznámka", "popis", "zpráva", "informace pro příjemce"),
    "id": ("id pohybu", "id transakce", "číslo transakce"),
}


def cti_csv(text: str) -> List[Pohyb]:
    radky = text.splitlines()
    zacatek = next((i for i, r in enumerate(radky) if re.search(r"datum|date", r, re.I) and re.search(r"objem|částka|castka|amount", r, re.I)), None)
    if zacatek is None:
        raise ChybaVypisu("V CSV jsem nenašel hlavičku se sloupci Datum a Částka")
    oddelovac = ";" if radky[zacatek].count(";") >= radky[zacatek].count(",") else ","
    cteni = csv.reader(io.StringIO("\n".join(radky[zacatek:])), delimiter=oddelovac)
    hlavicka = [h.strip().strip('"').lower() for h in next(cteni)]

    def sloupec(klic):
        for nazev in SLOUPCE[klic]:
            if nazev in hlavicka:
                return hlavicka.index(nazev)
        return None

    idx = {k: sloupec(k) for k in SLOUPCE}
    if idx["datum"] is None or idx["castka"] is None:
        raise ChybaVypisu("V CSV chybí sloupec Datum nebo Částka")
    out = []
    for r in cteni:
        if len(r) <= max(i for i in (idx["datum"], idx["castka"]) if i is not None):
            continue
        hodnota = lambda k: (r[idx[k]].strip() if idx[k] is not None and idx[k] < len(r) else "")
        castka = _halere(hodnota("castka"))
        datum = _datum(hodnota("datum"))
        if castka is None or not datum:
            continue
        ucet = hodnota("protiucet")
        if ucet and hodnota("banka") and "/" not in ucet:
            ucet = f"{ucet}/{hodnota('banka')}"
        zprava = hodnota("zprava") or None
        vs = _vs(hodnota("vs"))
        if not vs and zprava:
            m = re.search(r"VS[:/ ]*(\d{1,10})", zprava, re.I)
            vs = _vs(m.group(1)) if m else None
        out.append(Pohyb(datum=datum, castka=castka, vs=vs, protiucet=ucet or None, nazev=hodnota("nazev") or None,
                         zprava=zprava, id_banky=hodnota("id") or None))
    return out


def cti(nazev: str, data: bytes) -> List[Pohyb]:
    jmeno = nazev.lower()
    if data.lstrip()[:1] == b"<" or jmeno.endswith(".xml"):
        return cti_camt(data)
    text = _text(data)
    if jmeno.endswith((".gpc", ".abo")) or text.startswith("074"):
        return cti_gpc(text)
    return cti_csv(text)


# --------------------------------------------------------------------------- párování

def najdi_fakturu(con, p: Pohyb) -> tuple:
    """(faktura, důvod) – faktura k úhradě se stejným VS a částkou, jinak None a proč."""
    if p.castka <= 0:
        return None, "odchozí platba"
    if not p.vs:
        return None, "platba bez variabilního symbolu"
    kandidati = [dict(r) for r in con.execute(
        "SELECT f.*, f.celkem + COALESCE((SELECT SUM(o.celkem) FROM faktury_vydane o WHERE o.vazba_id = f.id "
        "AND o.typ = 'OPRAVNY' AND o.stav != 'STORNO'), 0) AS k_uhrade FROM faktury_vydane f "
        "WHERE f.typ IN ('FAKTURA', 'ZALOHOVA') AND f.stav = 'NEUHRAZENO'")
        if (r["vs"] or "").lstrip("0") == p.vs]
    if not kandidati:
        return None, f"žádná neuhrazená faktura s VS {p.vs}"
    for f in kandidati:
        if p.castka in (f["celkem"], f["k_uhrade"]):
            return f, None
    return None, f"VS {p.vs} sedí na {kandidati[0]['cislo']}, ale částka ne (faktura {kandidati[0]['k_uhrade'] / 100:.2f} Kč)"
