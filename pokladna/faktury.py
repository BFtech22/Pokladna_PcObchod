"""Načtení přijaté faktury (ISDOC, ISDOCX, PDF) a spárování položek s katalogem.

Pořadí podle spolehlivosti:
1. ISDOC / ISDOCX – strojová data, přesné.
2. PDF s vloženým ISDOC (Pohoda, Money, iDoklad a další ho do PDF přikládají).
3. PDF přes Claude API – když je v nastavení API klíč.
4. PDF z textu – odhad podle řádků „množství × cena = celkem“, vždy ke kontrole.
"""

from __future__ import annotations

import base64
import difflib
import io
import json
import re
import zipfile
from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation
from typing import List, Optional

from lxml import etree

from . import db


@dataclass
class Polozka:
    nazev: str
    mnozstvi: float
    cena_bez_dph: Optional[int]          # jednotková cena bez DPH v haléřích
    celkem_bez_dph: Optional[int] = None
    sazba_dph: Optional[int] = None
    jednotka: Optional[str] = None
    kod_dodavatele: Optional[str] = None
    ean: Optional[str] = None


@dataclass
class Faktura:
    zdroj: str                           # isdoc | pdf-isdoc | ai | text
    dodavatel: Optional[str] = None
    dodavatel_ico: Optional[str] = None
    dodavatel_dic: Optional[str] = None
    cislo: Optional[str] = None
    datum: Optional[str] = None
    dobropis: bool = False
    celkem_bez_dph: Optional[int] = None
    polozky: List[Polozka] = field(default_factory=list)
    varovani: List[str] = field(default_factory=list)

    def dict(self) -> dict:
        return asdict(self)


class ChybaFaktury(Exception):
    pass


NESKLADOVE = re.compile(r"doprav|po[sš]tovn|baln[eé]|zaokrouhl|recykla|poplatek|dob[ií]rk|z[aá]loh|slev", re.I)
RE_EAN = re.compile(r"(?<!\d)(\d{13}|\d{8})(?!\d)")


def _halere(hodnota) -> Optional[int]:
    if hodnota is None:
        return None
    t = re.sub(r"[\s\u00a0\u2009\u202f]", "", str(hodnota))
    if not t:
        return None
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".")
    else:
        t = t.replace(",", ".")
    try:
        return int((Decimal(t) * 100).quantize(Decimal("1")))
    except InvalidOperation:
        return None


def _cislo(hodnota) -> Optional[float]:
    h = _halere(hodnota)
    return None if h is None else h / 100


def ean_z_textu(ean: str) -> bool:
    """13místné číslo bereme jako EAN vždy, 8místné jen s platnou kontrolní číslicí (jinak to bývá IČO)."""
    return bool(ean) and ean.isdigit() and (len(ean) in (12, 13, 14) or platny_ean(ean))


def platny_ean(ean: str) -> bool:
    if not ean or not ean.isdigit() or len(ean) not in (8, 12, 13, 14):
        return False
    cisla = [int(c) for c in ean]
    kontrola = cisla.pop()
    soucet = sum(c * (3 if i % 2 == 0 else 1) for i, c in enumerate(reversed(cisla)))
    return (10 - soucet % 10) % 10 == kontrola


# --------------------------------------------------------------------------- ISDOC

def _lokalni(el, *cesta):
    """Najde potomka podle lokálních jmen (ISDOC má různé verze jmenných prostorů)."""
    for jmeno in cesta:
        if el is None:
            return None
        el = next((c for c in el if isinstance(c.tag, str) and etree.QName(c).localname == jmeno), None)
    return el


def _text(el, *cesta) -> Optional[str]:
    x = _lokalni(el, *cesta)
    return x.text.strip() if x is not None and x.text and x.text.strip() else None


def nacti_isdoc(data: bytes, zdroj: str = "isdoc") -> Faktura:
    if data[:2] == b"PK":                       # ISDOCX = zip s .isdoc uvnitř
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            jmeno = next((n for n in z.namelist() if n.lower().endswith(".isdoc")), None)
            if not jmeno:
                raise ChybaFaktury("V souboru ISDOCX není ISDOC")
            data = z.read(jmeno)
    try:
        koren = etree.fromstring(data, parser=etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError as e:
        raise ChybaFaktury(f"ISDOC nejde přečíst: {e}")
    if etree.QName(koren).localname != "Invoice":
        raise ChybaFaktury("Soubor není faktura ISDOC")

    party = _lokalni(koren, "AccountingSupplierParty", "Party")
    f = Faktura(
        zdroj=zdroj,
        dodavatel=_text(party, "PartyName", "Name"),
        dodavatel_ico=_text(party, "PartyIdentification", "ID"),
        dodavatel_dic=_text(party, "PartyTaxScheme", "CompanyID"),
        cislo=_text(koren, "ID"),
        datum=_text(koren, "IssueDate"),
        dobropis=_text(koren, "DocumentType") in ("2", "3"),
        celkem_bez_dph=_halere(_text(koren, "LegalMonetaryTotal", "TaxExclusiveAmount")),
    )
    mena = _text(koren, "LocalCurrencyCode")
    if mena and mena != "CZK":
        f.varovani.append(f"Faktura je v měně {mena}, ceny se berou tak, jak jsou")

    radky = _lokalni(koren, "InvoiceLines")
    for r in (radky if radky is not None else []):
        if not isinstance(r.tag, str) or etree.QName(r).localname != "InvoiceLine":
            continue
        item = _lokalni(r, "Item")
        q_el = _lokalni(r, "InvoicedQuantity")
        mnozstvi = _cislo(q_el.text) if q_el is not None else None
        celkem = _halere(_text(r, "LineExtensionAmount"))
        cena = _halere(_text(r, "UnitPrice"))
        if cena is None and celkem is not None and mnozstvi:
            cena = int(round(celkem / mnozstvi))
        ean = None
        for k in ("StandardItemIdentification", "CatalogueItemIdentification"):
            kand = _text(item, k, "ID")
            if kand and kand.isdigit() and len(kand) in (8, 12, 13, 14):
                ean = kand
                break
        sazba = _cislo(_text(r, "ClassifiedTaxCategory", "Percent"))
        f.polozky.append(Polozka(
            nazev=_text(item, "Description") or _text(r, "Note") or "(bez názvu)",
            mnozstvi=mnozstvi if mnozstvi is not None else 1,
            cena_bez_dph=cena, celkem_bez_dph=celkem,
            sazba_dph=int(sazba) if sazba is not None else None,
            jednotka=(q_el.get("unitCode") if q_el is not None else None),
            kod_dodavatele=_text(item, "SellersItemIdentification", "ID"),
            ean=ean,
        ))
    if not f.polozky:
        f.varovani.append("ISDOC neobsahuje žádné položky")
    return f


# --------------------------------------------------------------------------- PDF

def _vlozeny_isdoc(data: bytes) -> Optional[bytes]:
    from pypdf import PdfReader
    try:
        reader = PdfReader(io.BytesIO(data))
        for jmeno, obsahy in (reader.attachments or {}).items():
            if jmeno.lower().endswith((".isdoc", ".isdocx")) and obsahy:
                return obsahy[0]
    except Exception:
        return None
    return None


def _text_pdf(data: bytes, rozlozeni: bool = True) -> str:
    """Text PDF. V režimu rozvržení zůstávají sloupce tabulky na řádku vedle sebe (lépe se čtou položky)."""
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    stranky = []
    for p in reader.pages:
        try:
            t = p.extract_text(extraction_mode="layout") if rozlozeni else p.extract_text()
        except Exception:
            t = p.extract_text()
        stranky.append(t or "")
    return "\n".join(stranky)


RE_CASTKA = re.compile(r"(?<![\w,.])-?\d{1,3}(?:[ \u00a0\u2009\u202f]\d{3})*(?:,\d{2}|\.\d{2})(?![\d])|(?<![\w,.])-?\d+(?:,\d{2}|\.\d{2})(?![\d])")
RE_SAZBA = re.compile(r"(?<![\d,.])(21|12|15|10|0)(?:[.,]00?)?\s?%")
RE_EAN_POPIS = re.compile(r"(?:EAN|GTIN)\s*:?\s*(?=\d{8,14})", re.I)
RE_MNOZSTVI = re.compile(r"(?<![\w,.])(\d{1,5}(?:,\d{1,3})?)\s*(ks|kus|kusů|m|bal|sada|pcs|hod|h)?\.?(?![\w,.])", re.I)
RE_KOD = re.compile(r"^[A-Z0-9][A-Z0-9\-./]{2,}$")
RE_SOUHRN = re.compile(r"^\s*(celkem|celkov\w*|součet|soucet|základ|zaklad|sazba|dph|k úhradě|k uhrade|k platbě|zaokrouhlení|zaokrouhleni|zálohy|zalohy|"
                       r"rekapitulace|mezisoučet|total|summe|uhrazeno|zbývá|zbyva|neplaťte|platba|cena celkem)\b", re.I)
RE_ICO = re.compile(r"\bIČO?\s*:?\s*(\d(?:\s?\d){7})\b|\bIČ\s*:?\s*(\d(?:\s?\d){7})\b")
RE_DIC = re.compile(r"\b(?:DIČ|IČ DPH|VAT)\s*:?\s*([A-Z]{2}\s?\d{8,10})\b")
RE_CISLO = [
    re.compile(r"(?:číslo|cislo)\s+(?:faktury|dokladu)\s*:?\s*([A-Z]{0,4}[-/]?\d[\w/-]{3,})", re.I),
    re.compile(r"(?:faktura|daňový doklad|danovy doklad|invoice|rechnung|predfakt[úu]ra|zálohová faktura|dobropis)\b[^\n]{0,30}?"
               r"(?:č\.|číslo|cislo|no\.?|nr\.?|number|#)\s*:?\s*([A-Z]{0,4}[-/]?\d[\w/-]{3,})", re.I),
    re.compile(r"(?:faktura|daňový doklad k přijaté platbě|daňový doklad|invoice)\s*(?:–|-)?\s*(?:daňový doklad)?\s{2,}([A-Z]{0,4}\d[\w/-]{4,})", re.I),
    re.compile(r"(?:variabilní symbol|variabilni symbol|variabilný symbol|VS)\s*:?\s*(\d{4,10})", re.I),
]


RE_HLAVICKA = re.compile(r"(položk|polozk|název|nazev|označení dodávky|popis|služb|zboží|zbozi|description|artikel|bezeichnung|množství|mnozstvi|počet|pocet)", re.I)


def _rozeber_radek(radek: str, v_tabulce: bool = True, predchozi: Optional[str] = None) -> Optional[Polozka]:
    """Řádek položky: množství × cena ≈ celkem, celkem je obvykle poslední částka na řádku.
    Řádek bez množství (služby) se bere jako 1 ks, když má sazbu DPH a název."""
    s = RE_EAN_POPIS.sub(" ", radek)
    if RE_SOUHRN.match(s):
        return None
    ean = next((e for e in RE_EAN.findall(s) if ean_z_textu(e)), None)
    if ean:
        s = s.replace(ean, " ")
    sazba = RE_SAZBA.search(s)
    s = RE_SAZBA.sub(" ", s)
    castky = [(m.start(), _halere(m.group())) for m in RE_CASTKA.finditer(s)]
    castky = [(i, c) for i, c in castky if c is not None and c > 0]
    if not castky:
        return None
    bez_castek = RE_CASTKA.sub(lambda m: " " * len(m.group()), s)
    bez_castek = re.sub(r"\b\d{1,2}\.\d{1,2}\.\d{4}\b(\s*-\s*\d{1,2}\.\d{1,2}\.\d{4})?", " ", bez_castek)   # období u služeb
    s_dph = (1 + int(sazba.group(1)) / 100) if sazba else None

    def hotova(nazev_text: str, q: float, p: int, t: int, jednotka: Optional[str]) -> Optional[Polozka]:
        tokeny = nazev_text.split()
        kod = None
        if len(tokeny) > 1 and RE_KOD.match(tokeny[0]) and re.search(r"[\d\-]", tokeny[0]):
            kod = tokeny.pop(0)
        nazev = re.sub(r"(?<!\w)(Kč|CZK)(?!\w)", " ", " ".join(tokeny))
        nazev = re.sub(r"\s{2,}", " ", re.sub(r"(\s-)+\s*$", " ", nazev)).strip(" .,:;-\t")
        if not re.search(r"[A-Za-zÁ-ž]{3}", re.sub(r"\b(kód|kod|code|art\.?|č\.)\b", "", nazev, flags=re.I)):
            nazev = ""                                 # jen popisky sloupců – název bývá o řádek výš
        if len(nazev) < 3 and not predchozi:
            return None
        nazev = nazev if len(nazev) >= 3 else predchozi
        # Když jsou na řádku ceny s DPH i bez, bereme bez DPH.
        if s_dph:
            mensi = [c for _, c in castky if abs(c * s_dph - t) <= max(2, t * 0.005)]
            if mensi:
                t = mensi[0]
                p = int(round(t / q))
        return Polozka(nazev=nazev, mnozstvi=q, cena_bez_dph=p, celkem_bez_dph=t,
                       sazba_dph=int(sazba.group(1)) if sazba else None,
                       jednotka=(jednotka or "").lower() or None, kod_dodavatele=kod, ean=ean)

    mnozstvi = [(m, _cislo(m.group(1))) for m in RE_MNOZSTVI.finditer(bez_castek)]
    if len(castky) >= 2:
        for ti in range(len(castky) - 1, 0, -1):
            t = castky[ti][1]
            for _, p in castky[:ti]:
                for m, q in reversed(mnozstvi):
                    if q and 0 < q <= 10000 and abs(q * p - t) <= max(2, t * 0.005):
                        return hotova(bez_castek[:m.start()] + " " + bez_castek[m.end():], q, p, t, m.group(2))
    if v_tabulce and sazba and re.match(r"^\s{0,6}\S", radek):          # služba bez množství: název, sazba DPH, částka
        t = castky[-1][1] if not s_dph else next((c for _, c in castky if any(abs(c * s_dph - d) <= max(2, d * 0.005) for _, d in castky)), castky[0][1])
        nazev = bez_castek[:castky[0][0]]
        if len(nazev.strip()) >= 6:
            return hotova(nazev, 1, t, t, None)
    return None


def nacti_pdf_text(data: bytes, nastaveni: Optional[dict] = None) -> Faktura:
    """Odhad položek z textu PDF – pro faktury bez ISDOC, když není nastavené čtení přes Claude."""
    nastaveni = nastaveni or {}
    text = _text_pdf(data)
    f = Faktura(zdroj="text")
    f.varovani.append("Položky jsou odhadnuté z textu PDF. Zkontrolujte množství a ceny. Přesně (i naskenované PDF) "
                      "přečte fakturu Claude, když je v Nastavení → Faktury zadaný API klíč.")
    vlastni_ico = re.sub(r"\D", "", nastaveni.get("firma_ico") or "")
    vlastni_dic = re.sub(r"\s", "", nastaveni.get("firma_dic") or "").upper()
    for r in RE_CISLO:
        m = next((m for m in r.finditer(text) if len(re.sub(r"\D", "", m.group(1))) >= 4 and not re.search(r"sb\.?$", m.group(1), re.I)), None)
        if m:
            f.cislo = m.group(1).strip("/-")
            break
    ica = [re.sub(r"\s", "", m.group(1) or m.group(2)) for m in RE_ICO.finditer(text)]
    f.dodavatel_ico = next((i for i in ica if i != vlastni_ico), None)
    dic = [re.sub(r"\s", "", m.group(1)).upper() for m in RE_DIC.finditer(text)]
    f.dodavatel_dic = next((d for d in dic if d != vlastni_dic and not (vlastni_ico and vlastni_ico in d)), None)
    radky_textu = text.splitlines()
    for i, radek in enumerate(radky_textu):         # „Dodavatel: Název“, nebo štítek a název na dalším řádku (dvousloupcové PDF)
        m = re.search(r"Dod[aá]vate[lľ]\w*\s*:?", radek, re.I)
        if not m:
            continue
        zbytek = re.split(r"\s{3,}", radek[m.end():].strip())[0] if radek[m.end():].strip() else ""
        if not zbytek or re.match(r"(odběratel|odberatel|odberateľ|kupující)", zbytek, re.I):
            sloupec = m.start()
            dalsi = next((r for r in radky_textu[i + 1:i + 4] if r.strip()), "")
            zbytek = re.split(r"\s{3,}", dalsi[max(0, sloupec - 2):].strip() if len(dalsi) > sloupec else dalsi.strip())[0]
        kand = re.split(r",\s+(?=[^,]*\d)|,?\s+IČ", zbytek.strip())[0].strip(" :,")
        if len(kand) >= 3 and not re.match(r"(odběratel|odberatel|odberateľ|daňový|faktura|sídlo|kontakt)", kand, re.I):
            f.dodavatel = kand
            break
    if not f.dodavatel:
        m = re.search(r"([^\n]{3,80}?(?:s\.\s?r\.\s?o\.|a\.\s?s\.|spol\. s r\. o\.|GmbH|k\.\s?s\.|v\.\s?o\.\s?s\.))", text)
        f.dodavatel = m.group(1).strip() if m else None
    # Řádky bez množství (služby) se berou jen v tabulce položek: od záhlaví (Položka, Název, Popis…) do prvního součtu.
    v_tabulce = False
    predchozi = None                            # text bez částek o řádek výš – u dvouřádkových položek je tam název
    for radek in text.splitlines():
        if not radek.strip():
            continue
        if not RE_CASTKA.search(radek) and RE_HLAVICKA.search(radek):
            v_tabulce, predchozi = True, None
            continue
        if RE_SOUHRN.match(radek):
            v_tabulce, predchozi = False, None
            continue
        p = _rozeber_radek(radek, v_tabulce, predchozi)
        if p:
            f.polozky.append(p)
            predchozi = None
        elif not RE_CASTKA.search(radek):
            t = re.split(r"\s{3,}", radek.strip())[0].strip()
            predchozi = t if re.search(r"[A-Za-zÁ-ž]{3}", t) and len(t) >= 6 else None
    if not f.polozky:
        f.varovani.append("V textu PDF se nepodařilo najít žádné položky. Pomůže ISDOC od dodavatele nebo API klíč pro čtení přes Claude.")
    if len(text.strip()) < 50:
        f.varovani.append("PDF je naskenované (obrázek bez textu). Přečte ho jen Claude – zadejte API klíč v Nastavení → Faktury.")
    return f


AI_SCHEMA = {
    "type": "object",
    "properties": {
        "dodavatel": {"type": "string", "description": "název dodavatele, prázdné když není"},
        "dodavatel_ico": {"type": "string", "description": "IČO dodavatele, jen číslice"},
        "dodavatel_dic": {"type": "string"},
        "cislo_dokladu": {"type": "string"},
        "datum_vystaveni": {"type": "string", "description": "RRRR-MM-DD"},
        "dobropis": {"type": "boolean"},
        "polozky": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "nazev": {"type": "string"},
                    "kod_dodavatele": {"type": "string", "description": "katalogové číslo dodavatele, prázdné když není"},
                    "ean": {"type": "string", "description": "EAN/GTIN čárový kód, prázdné když na faktuře není"},
                    "mnozstvi": {"type": "number"},
                    "jednotka": {"type": "string"},
                    "cena_za_jednotku_bez_dph": {"type": "number", "description": "v Kč"},
                    "celkem_bez_dph": {"type": "number", "description": "v Kč"},
                    "sazba_dph": {"type": "integer"},
                },
                "required": ["nazev", "kod_dodavatele", "ean", "mnozstvi", "jednotka",
                             "cena_za_jednotku_bez_dph", "celkem_bez_dph", "sazba_dph"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["dodavatel", "dodavatel_ico", "dodavatel_dic", "cislo_dokladu", "datum_vystaveni", "dobropis", "polozky"],
    "additionalProperties": False,
}

AI_ZADANI = (
    "Toto je přijatá faktura dodavatele pro maloobchod s elektronikou. Vypiš všechny řádky zboží a služeb "
    "přesně tak, jak jsou na faktuře – nic nedopočítávej ani neslučuj. Ceny uváděj v Kč bez DPH. "
    "EAN uveď jen tehdy, když je na faktuře opravdu vytištěný. Neznámé textové údaje nech prázdné."
)


def nacti_pdf_ai(data: bytes, api_klic: str, model: str) -> Faktura:
    import anthropic

    client = anthropic.Anthropic(api_key=api_klic, timeout=120, max_retries=2)
    try:
        odp = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": AI_SCHEMA}},
            messages=[{"role": "user", "content": [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                "data": base64.b64encode(data).decode()}},
                {"type": "text", "text": AI_ZADANI},
            ]}],
        )
    except anthropic.AuthenticationError:
        raise ChybaFaktury("Neplatný API klíč pro Claude (Nastavení → Faktury)")
    except anthropic.RateLimitError:
        raise ChybaFaktury("Claude API je teď přetížené, zkuste to za chvíli")
    except anthropic.APIStatusError as e:
        raise ChybaFaktury(f"Chyba Claude API {e.status_code}: {e.message}")
    except anthropic.APIConnectionError:
        raise ChybaFaktury("Claude API není dostupné – zkontrolujte připojení k internetu")
    if odp.stop_reason == "refusal":
        raise ChybaFaktury("Claude fakturu odmítl zpracovat")
    if odp.stop_reason == "max_tokens":
        raise ChybaFaktury("Faktura je příliš dlouhá na jedno načtení")
    text = next((b.text for b in odp.content if b.type == "text"), None)
    if not text:
        raise ChybaFaktury("Claude nevrátil žádná data")
    d = json.loads(text)
    f = Faktura(zdroj="ai", dodavatel=d["dodavatel"] or None, dodavatel_ico=re.sub(r"\D", "", d["dodavatel_ico"]) or None,
                dodavatel_dic=d["dodavatel_dic"] or None, cislo=d["cislo_dokladu"] or None,
                datum=d["datum_vystaveni"] or None, dobropis=bool(d["dobropis"]))
    f.varovani.append("Položky přečetl Claude z PDF. Před naskladněním je zkontrolujte.")
    for p in d["polozky"]:
        ean = re.sub(r"\D", "", p["ean"] or "")
        f.polozky.append(Polozka(
            nazev=p["nazev"].strip() or "(bez názvu)", mnozstvi=float(p["mnozstvi"] or 0) or 1,
            cena_bez_dph=int(round(float(p["cena_za_jednotku_bez_dph"]) * 100)),
            celkem_bez_dph=int(round(float(p["celkem_bez_dph"]) * 100)),
            sazba_dph=p["sazba_dph"], jednotka=p["jednotka"] or None,
            kod_dodavatele=p["kod_dodavatele"] or None, ean=ean if ean_z_textu(ean) else None))
    return f


def nacti(nazev: str, data: bytes, nastaveni: dict) -> Faktura:
    jmeno = nazev.lower()
    if jmeno.endswith((".isdoc", ".isdocx", ".xml")) or data[:5] == b"<?xml":
        return nacti_isdoc(data)
    if data[:4] != b"%PDF":
        raise ChybaFaktury("Podporované jsou faktury ve formátu ISDOC, ISDOCX a PDF")
    vlozeny = _vlozeny_isdoc(data)
    if vlozeny:
        return nacti_isdoc(vlozeny, zdroj="pdf-isdoc")
    klic = (nastaveni.get("ai_api_klic") or "").strip()
    if klic:
        return nacti_pdf_ai(data, klic, nastaveni.get("ai_model") or "claude-opus-5-5")
    return nacti_pdf_text(data, nastaveni)


# --------------------------------------------------------------------------- párování

def klic_dodavatele(ico: Optional[str], nazev: Optional[str]) -> Optional[str]:
    if ico:
        return "ICO:" + re.sub(r"\D", "", ico)
    if nazev:
        return "NAZEV:" + db.bez_diakritiky(nazev).strip()
    return None


def _slova(s: str) -> str:
    """Normalizovaný název pro porovnání: bez diakritiky a interpunkce, slova seřazená."""
    return " ".join(sorted(re.sub(r"[^a-z0-9 ]+", " ", db.bez_diakritiky(s or "")).split()))


def sparuj(con, f: Faktura) -> List[dict]:
    """Ke každé položce najde zboží v katalogu: EAN → naučený kód dodavatele → interní kód → podobný název."""
    dod = klic_dodavatele(f.dodavatel_ico, f.dodavatel)
    katalog = [dict(r) for r in con.execute("SELECT id, nazev, kod, cena, sazba_dph, nakupni_cena, jednotka, stav FROM zbozi WHERE aktivni = 1")]
    podle_id = {z["id"]: z for z in katalog}
    normy = {z["id"]: _slova(z["nazev"]) for z in katalog}
    vysledek = []
    for p in f.polozky:
        navrh = None
        if p.ean:
            r = con.execute("SELECT zbozi_id FROM zbozi_ean WHERE ean = ?", (p.ean,)).fetchone()
            if r and r[0] in podle_id:
                navrh = {"zbozi_id": r[0], "zpusob": "EAN", "jistota": 1.0, "koeficient": 1}
        if navrh is None and p.kod_dodavatele and dod:
            r = con.execute("SELECT zbozi_id, koeficient FROM dodavatel_kody WHERE dodavatel = ? AND kod = ?",
                            (dod, p.kod_dodavatele)).fetchone()
            if r and r[0] in podle_id:
                navrh = {"zbozi_id": r[0], "zpusob": "naučené", "jistota": 1.0, "koeficient": r[1] or 1}
        if navrh is None and p.kod_dodavatele:
            r = con.execute("SELECT id FROM zbozi WHERE kod = ? AND aktivni = 1", (p.kod_dodavatele,)).fetchone()
            if r:
                navrh = {"zbozi_id": r[0], "zpusob": "kód", "jistota": 0.95, "koeficient": 1}
        kandidati = []
        cil = _slova(p.nazev)
        if cil:
            skore = sorted(((difflib.SequenceMatcher(None, cil, n).ratio(), zid) for zid, n in normy.items()), reverse=True)[:5]
            kandidati = [{"zbozi_id": zid, "jistota": round(s, 2)} for s, zid in skore if s >= 0.5]
        if navrh is None and kandidati and kandidati[0]["jistota"] >= 0.6:
            navrh = {"zbozi_id": kandidati[0]["zbozi_id"], "zpusob": "název", "jistota": kandidati[0]["jistota"], "koeficient": 1}
        # Jistá shoda se naskladní, doprava a poplatky se přeskočí, podobný název je jen návrh ke kontrole.
        if navrh and navrh["zpusob"] != "název":
            akce = "PRIJMOUT"
        elif NESKLADOVE.search(p.nazev):
            akce = "PRESKOCIT"
        else:
            akce = "PRIJMOUT" if navrh else "NOVE"
        vysledek.append({
            **asdict(p),
            "akce": akce,
            "navrh": navrh,
            "kandidati": [{**k, "nazev": podle_id[k["zbozi_id"]]["nazev"]} for k in kandidati],
            "zbozi": podle_id.get(navrh["zbozi_id"]) if navrh else None,
        })
    return vysledek
