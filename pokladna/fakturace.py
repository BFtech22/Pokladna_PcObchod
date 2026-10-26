"""Vydané doklady (faktura, zálohová, daňový doklad k platbě, opravný doklad, nabídka):
IBAN a QR platba, PDF (A4), ISDOC pro účetní a text e-mailu."""

from __future__ import annotations

import io
import re
import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Optional

STATIC = Path(__file__).resolve().parent / "static"
FORMY = {"PREVOD": "převodem", "HOTOVE": "hotově", "KARTA": "kartou", "DOBIRKA": "dobírkou"}

# typ dokladu → (titul plátce, titul neplátce, popisek celkové částky, DocumentType v ISDOC, klíč řady, výchozí řada)
TYPY = {
    "FAKTURA": ("Faktura – daňový doklad", "Faktura", "Celkem k úhradě", "1", "faktura_rada", "FV"),
    "ZALOHOVA": ("Zálohová faktura", "Zálohová faktura", "Záloha k úhradě", "4", "rada_zalohova", "ZF"),
    "DDZP": ("Daňový doklad k přijaté platbě", "Doklad o přijaté platbě", "Přijatá platba", "5", "rada_ddzp", "DP"),
    "OPRAVNY": ("Opravný daňový doklad", "Opravný doklad", "Celkem", "2", "rada_opravny", "OD"),
    "NABIDKA": ("Cenová nabídka", "Cenová nabídka", "Celkem", None, "rada_nabidka", "NA"),
}
TEXT_PDP = "Daň odvede zákazník (přenesení daňové povinnosti podle § 92a zákona o DPH)."

PISMA = [   # (běžné, tučné) – Debian/Raspberry Pi, macOS, Windows
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
]


class ChybaFakturace(Exception):
    pass


def titul(f: dict, platce: bool) -> str:
    t = TYPY.get(f.get("typ") or "FAKTURA", TYPY["FAKTURA"])
    return t[0] if platce else t[1]


def rada(typ: str, nast: dict) -> str:
    t = TYPY[typ]
    return (nast.get(t[4]) or t[5]).strip()


def iban_z_uctu(ucet: str) -> Optional[str]:
    """České číslo účtu (předčíslí-číslo/banka) → IBAN. Když je zadaný rovnou IBAN, vrátí ho bez mezer."""
    u = (ucet or "").replace(" ", "").upper()
    if re.fullmatch(r"CZ\d{22}", u):
        return u
    m = re.fullmatch(r"(?:(\d{1,6})-)?(\d{2,10})/(\d{4})", u)
    if not m:
        return None
    bban = m.group(3) + (m.group(1) or "").zfill(6) + m.group(2).zfill(10)
    kontrola = 98 - int(bban + "123500") % 97          # C=12, Z=35, 00
    return f"CZ{kontrola:02d}{bban}"


def spayd(iban: str, castka: int, vs: Optional[str], splatnost: Optional[str], zprava: str) -> str:
    """Řetězec QR Platby (formát SPAYD, který čtou české bankovní aplikace)."""
    casti = ["SPD", "1.0", f"ACC:{iban}", f"AM:{castka / 100:.2f}", "CC:CZK"]
    if splatnost:
        casti.append("DT:" + splatnost.replace("-", ""))
    if vs:
        casti.append(f"X-VS:{vs[:10]}")
    casti.append("MSG:" + re.sub(r"[*]", " ", zprava)[:60])
    return "*".join(casti)


def qr(text: str, svg: bool = False) -> bytes:
    import segno
    kod = segno.make(text, error="m")
    buf = io.BytesIO()
    if svg:
        kod.save(buf, kind="svg", scale=4, border=2)
    else:
        kod.save(buf, kind="png", scale=6, border=2)
    return buf.getvalue()


def rekap_dph(polozky: list, pdp: bool = False) -> list:
    """Rekapitulace podle sazeb. U přenesené daňové povinnosti jsou ceny bez DPH a daň je nulová."""
    m: dict = {}
    for p in polozky:
        m[p["sazba_dph"]] = m.get(p["sazba_dph"], 0) + p["celkem"]
    out = []
    for s in sorted(m, reverse=True):
        zaklad = m[s] if pdp else int(round(m[s] / (1 + s / 100)))
        out.append({"sazba": s, "zaklad": zaklad, "dph": m[s] - zaklad, "celkem": m[s]})
    return out


def s_qr(f: dict) -> bool:
    return (f.get("typ") or "FAKTURA") in ("FAKTURA", "ZALOHOVA") and f["forma_uhrady"] == "PREVOD" \
        and f["stav"] == "NEUHRAZENO" and f["celkem"] > 0


def kc(h: int) -> str:
    return f"{h / 100:,.2f}".replace(",", " ").replace(".", ",") + " Kč"


def _datum(iso: Optional[str]) -> str:
    if not iso:
        return ""
    d = date.fromisoformat(iso[:10])
    return f"{d.day}. {d.month}. {d.year}"


def udaje(f: dict, nast: dict, iban: Optional[str]) -> list:
    """Údaje v hlavičce dokladu podle jeho typu (pro PDF i obrazovku)."""
    typ = f.get("typ") or "FAKTURA"
    vazba = f.get("vazba") or {}
    u = [("Datum vystavení", _datum(f["datum_vystaveni"]))]
    if typ == "NABIDKA":
        return u + [("Platnost do", _datum(f["splatnost"]))]
    if typ == "DDZP":
        return u + [("Datum přijetí platby", _datum(f["duzp"])), ("Variabilní symbol", f.get("vs") or ""),
                    ("K zálohové faktuře", vazba.get("cislo") or "")]
    if typ in ("FAKTURA", "OPRAVNY"):
        u.append(("Datum zdan. plnění" if typ == "FAKTURA" else "Datum opravy", _datum(f["duzp"])))
    if typ == "OPRAVNY":
        u.append(("Opravovaný doklad", f"{vazba.get('cislo') or ''} ze dne {_datum(vazba.get('duzp'))}".strip()))
    u += [("Datum splatnosti", _datum(f["splatnost"])), ("Forma úhrady", FORMY.get(f["forma_uhrady"], f["forma_uhrady"])),
          ("Variabilní symbol", f.get("vs") or "")]
    if f["forma_uhrady"] == "PREVOD" and nast.get("faktura_ucet") and typ != "OPRAVNY":
        u += [("Bankovní účet", nast["faktura_ucet"]), ("IBAN", iban or "")]
    return u


def poznamky(f: dict, platce: bool) -> list:
    """Povinné a vysvětlující věty pod položkami."""
    typ = f.get("typ") or "FAKTURA"
    out = []
    if f.get("pdp"):
        out.append(TEXT_PDP)
    if typ == "OPRAVNY" and f.get("duvod_opravy"):
        out.append(f"Důvod opravy: {f['duvod_opravy']}")
    if typ == "ZALOHOVA" and platce:
        out.append("Zálohová faktura není daňovým dokladem. Daňový doklad vystavíme po přijetí platby.")
    if typ == "DDZP":
        out.append("Daňový doklad k přijaté platbě (záloze). Částka se odečte na konečné faktuře.")
    if typ == "NABIDKA":
        out.append("Nabídka je nezávazná a platí do uvedeného data nebo do vyprodání zásob.")
    return out


def pdf(f: dict, nast: dict) -> bytes:
    """Doklad A4 jako PDF. `f` = detail dokladu z API (včetně položek)."""
    from fpdf import FPDF

    pismo = next(((r, b) for r, b in PISMA if Path(r).is_file() and Path(b).is_file()), None)
    if not pismo:
        raise ChybaFakturace("Na serveru chybí písmo pro PDF (nainstalujte balíček fonts-dejavu-core)")
    platce = nast.get("platce_dph") == "1"
    typ = f.get("typ") or "FAKTURA"
    pdp = bool(f.get("pdp"))
    doc = FPDF(format="A4")
    doc.set_margins(15, 15, 15)
    doc.set_auto_page_break(True, 20)
    doc.add_font("P", "", pismo[0])
    doc.add_font("P", "B", pismo[1])
    doc.add_page()
    sirka = doc.w - 30

    logo = STATIC / "img" / "logo.png"
    if logo.is_file():
        doc.image(str(logo), x=15, y=13, w=58)
    doc.set_font("P", "B", 16)
    doc.set_xy(90, 15)
    doc.cell(sirka - 75, 8, titul(f, platce), align="R")
    doc.set_font("P", "", 11)
    doc.set_xy(90, 23)
    doc.cell(sirka - 75, 6, f"č. {f['cislo']}", align="R")
    if f["stav"] == "STORNO":
        doc.set_text_color(200, 0, 0)
        doc.set_xy(90, 29)
        doc.cell(sirka - 75, 6, "ZRUŠENO" if typ == "NABIDKA" else "STORNOVÁNO", align="R")
        doc.set_text_color(0, 0, 0)

    def blok(x: float, nadpis: str, radky: list) -> float:
        doc.set_xy(x, 42)
        doc.set_font("P", "B", 9)
        doc.set_text_color(120, 120, 120)
        doc.cell(85, 5, nadpis.upper())
        doc.set_text_color(0, 0, 0)
        y = 48
        for i, r in enumerate(r for r in radky if r):
            doc.set_xy(x, y)
            doc.set_font("P", "B" if i == 0 else "", 11 if i == 0 else 10)
            doc.multi_cell(85, 5.2, r)
            y = doc.get_y()
        return y

    dod = [nast.get("firma_nazev"), nast.get("firma_adresa"),
           f"IČO: {nast['firma_ico']}" if nast.get("firma_ico") else "",
           f"DIČ: {nast['firma_dic']}" if nast.get("firma_dic") else ("Neplátce DPH" if not platce else ""),
           nast.get("telefon") and f"Tel.: {nast['telefon']}"]
    odb = [f["odb_nazev"], f.get("odb_adresa"), f["odb_ico"] and f"IČO: {f['odb_ico']}", f["odb_dic"] and f"DIČ: {f['odb_dic']}"]
    y = max(blok(15, "Dodavatel", dod), blok(110, "Odběratel", odb)) + 6

    iban = iban_z_uctu(nast.get("faktura_ucet") or "")
    hl = udaje(f, nast, iban)
    doc.set_fill_color(245, 245, 247)
    doc.rect(15, y, sirka, 6 * ((len(hl) + 1) // 2) + 4, style="F")
    for i, (k, v) in enumerate(hl):
        sx = 18 + (i % 2) * (sirka / 2)
        sy = y + 3 + (i // 2) * 6
        doc.set_xy(sx, sy)
        doc.set_font("P", "", 9)
        doc.set_text_color(110, 110, 110)
        doc.cell(36, 6, k)
        doc.set_text_color(0, 0, 0)
        doc.set_font("P", "B", 10)
        doc.cell(sirka / 2 - 40, 6, v)
    y += 6 * ((len(hl) + 1) // 2) + 10

    if pdp:
        sloupce = [("Položka", 78, "L"), ("Množství", 22, "R"), ("Cena/MJ bez DPH", 30, "R"), ("DPH", 14, "R"), ("Celkem bez DPH", sirka - 144, "R")]
    elif platce:
        sloupce = [("Položka", 78, "L"), ("Množství", 22, "R"), ("Cena/MJ s DPH", 30, "R"), ("DPH", 14, "R"), ("Celkem s DPH", sirka - 144, "R")]
    else:
        sloupce = [("Položka", 92, "L"), ("Množství", 24, "R"), ("Cena/MJ", 32, "R"), ("Celkem", sirka - 148, "R")]
    doc.set_xy(15, y)
    doc.set_font("P", "B", 9)
    doc.set_fill_color(217, 48, 42)
    doc.set_text_color(255, 255, 255)
    for nazev, w, a in sloupce:
        doc.cell(w, 7, nazev, align=a, fill=True)
    doc.ln(7)
    doc.set_text_color(0, 0, 0)
    doc.set_font("P", "", 9.5)
    for p in f["polozky"]:
        hodnoty = [p["nazev"], f"{p['mnozstvi']:g}".replace(".", ",") + f" {p.get('jednotka') or ''}".rstrip(), kc(p["cena"])]
        if platce:
            hodnoty.append("PDP" if pdp else f"{p['sazba_dph']} %")
        hodnoty.append(kc(p["celkem"]))
        y0 = doc.get_y()
        doc.multi_cell(sloupce[0][1], 6, hodnoty[0], new_x="RIGHT", new_y="TOP")
        vyska = max(6, doc.get_y() - y0) if doc.get_y() > y0 else 6
        x = 15 + sloupce[0][1]
        for (nazev, w, a), v in zip(sloupce[1:], hodnoty[1:]):
            doc.set_xy(x, y0)
            doc.cell(w, 6, v, align=a)
            x += w
        doc.set_xy(15, y0 + vyska)
        doc.set_draw_color(225, 225, 230)
        doc.line(15, doc.get_y(), 15 + sirka, doc.get_y())
    doc.ln(4)

    if platce and typ != "NABIDKA" and not pdp:
        doc.set_font("P", "B", 9)
        doc.set_x(15 + sirka - 110)
        for t in ("Sazba DPH", "Základ", "DPH", "Celkem"):
            doc.cell(27.5, 6, t, align="R")
        doc.ln(6)
        doc.set_font("P", "", 9.5)
        for r in rekap_dph(f["polozky"]):
            doc.set_x(15 + sirka - 110)
            for t in (f"{r['sazba']} %", kc(r["zaklad"]), kc(r["dph"]), kc(r["celkem"])):
                doc.cell(27.5, 6, t, align="R")
            doc.ln(6)
    doc.ln(2)
    y_celkem = doc.get_y()
    doc.set_font("P", "B", 15)
    doc.set_x(15 + sirka - 110)
    doc.cell(110, 10, f"{TYPY.get(typ, TYPY['FAKTURA'])[2]}: {kc(f['celkem'])}", align="R")
    doc.ln(10)
    if f["stav"] == "UHRAZENO" and typ in ("FAKTURA", "ZALOHOVA"):
        doc.set_font("P", "B", 10)
        doc.set_text_color(31, 138, 76)
        doc.set_x(15 + sirka - 110)
        doc.cell(110, 6, f"Uhrazeno {_datum(f.get('datum_uhrady'))} – neplaťte", align="R")
        doc.set_text_color(0, 0, 0)
        doc.ln(6)

    if s_qr(f) and iban:
        obr = qr(spayd(iban, f["celkem"], f.get("vs"), f["splatnost"], f"{titul(f, False)} {f['cislo']}"))
        doc.image(io.BytesIO(obr), x=15, y=y_celkem - 2, w=32)
        doc.set_xy(49, y_celkem + 10)
        doc.set_font("P", "", 8)
        doc.set_text_color(110, 110, 110)
        doc.cell(40, 4, "QR Platba")
        doc.set_text_color(0, 0, 0)
        doc.set_y(max(doc.get_y(), y_celkem + 34))

    for t in poznamky(f, platce) + ([f["poznamka"]] if f.get("poznamka") else []):
        doc.ln(3)
        doc.set_font("P", "", 9.5)
        doc.multi_cell(sirka, 5, t)
    doc.set_y(-28)
    doc.set_font("P", "", 8)
    doc.set_text_color(120, 120, 120)
    pata = " · ".join(x for x in [nast.get("faktura_pata"), f.get("vystavil") and f"Vystavil: {f['vystavil']}"] if x)
    doc.multi_cell(sirka, 4, pata, align="C")
    return bytes(doc.output())


def email_html(f: dict, nast: dict, zprava: str = "") -> str:
    import html as h
    platce = nast.get("platce_dph") == "1"
    radky = "".join(f"<tr><td>{h.escape(p['nazev'])}</td><td align=right>{str(p['mnozstvi']).rstrip('0').rstrip('.').replace('.', ',')}</td><td align=right>{kc(p['celkem'])}</td></tr>"
                    for p in f["polozky"])
    uhrada = ""
    if s_qr(f):
        uhrada = (f"<p>Prosíme o úhradu <b>{kc(f['celkem'])}</b> do <b>{_datum(f['splatnost'])}</b> na účet "
                  f"<b>{h.escape(nast.get('faktura_ucet') or '')}</b>, variabilní symbol <b>{h.escape(f.get('vs') or '')}</b>. "
                  "QR platba je v přiloženém PDF.</p>")
    return f"""<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1f;max-width:620px">
<p>{h.escape(zprava).replace(chr(10), '<br>') if zprava else 'Dobrý den,<br>v příloze posíláme doklad.'}</p>
<h2 style="font-size:18px;margin:18px 0 6px">{h.escape(titul(f, platce))} {h.escape(f['cislo'])}</h2>
<table cellpadding=6 style="border-collapse:collapse;width:100%;border-top:1px solid #ddd">{radky}
<tr><td colspan=2><b>Celkem</b></td><td align=right><b>{kc(f['celkem'])}</b></td></tr></table>
{uhrada}
<p style="color:#777;font-size:12px">{h.escape(nast.get('firma_nazev') or '')} · {h.escape(nast.get('firma_adresa') or '')}</p></div>"""


def upominka_html(f: dict, nast: dict, dni: int, poradi: int) -> str:
    import html as h
    uvod = "Dovolujeme si Vás upozornit" if poradi <= 1 else f"Posíláme {poradi}. upomínku a znovu Vás upozorňujeme"
    return f"""<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1f;max-width:620px">
<p>Dobrý den,</p>
<p>{uvod}, že faktura <b>{h.escape(f['cislo'])}</b> na <b>{kc(f['celkem'])}</b> byla splatná <b>{_datum(f['splatnost'])}</b>
a k dnešnímu dni ji evidujeme jako neuhrazenou ({dni} dní po splatnosti).</p>
<p>Prosíme o úhradu na účet <b>{h.escape(nast.get('faktura_ucet') or '')}</b>, variabilní symbol <b>{h.escape(f.get('vs') or '')}</b>.
Fakturu s QR platbou přikládáme. Pokud jste již zaplatili, považujte prosím tuto zprávu za bezpředmětnou.</p>
<p>Děkujeme<br>{h.escape(nast.get('firma_nazev') or '')}{('<br>' + h.escape(nast['telefon'])) if nast.get('telefon') else ''}</p></div>"""


# --------------------------------------------------------------------------- ISDOC pro účetní

def _castka(h: int) -> str:
    return f"{h / 100:.2f}"


def _adresa_isdoc(text: Optional[str]) -> tuple:
    """„Náměstí 12, 408 01 Rumburk“ → (ulice, číslo, obec, PSČ). Co nejde rozpoznat, zůstane v ulici."""
    t = (text or "").strip()
    m = re.match(r"^(.*?)(?:\s+(\d+[\w/]*))?\s*,\s*(\d{3})\s?(\d{2})\s+(.+)$", t)
    if m:
        return (m.group(1) or "").strip(), m.group(2) or "", m.group(5).strip(), m.group(3) + m.group(4)
    return t, "", "", ""


def isdoc(f: dict, nast: dict) -> bytes:
    """Doklad jako ISDOC 6.0.2 (Pohoda, Money, iDoklad, ABRA… ho umí načíst)."""
    from lxml import etree

    typ = f.get("typ") or "FAKTURA"
    if TYPY[typ][3] is None:
        raise ChybaFakturace("Nabídka se do ISDOC neexportuje")
    platce = nast.get("platce_dph") == "1"
    pdp = bool(f.get("pdp"))
    NS = "http://isdoc.cz/namespace/2013"
    koren = etree.Element(f"{{{NS}}}Invoice", nsmap={None: NS}, version="6.0.2")

    def el(rodic, jmeno, text=None, **attr):
        e = etree.SubElement(rodic, f"{{{NS}}}{jmeno}", **attr)
        if text is not None:
            e.text = str(text)
        return e

    def strana(rodic, nazev, ico, dic, adresa, email=None, telefon=None):
        p = el(rodic, "Party")
        el(el(p, "PartyIdentification"), "ID", ico or "")
        el(el(p, "PartyName"), "Name", nazev or "")
        ulice, cislo, obec, psc = _adresa_isdoc(adresa)
        a = el(p, "PostalAddress")
        el(a, "StreetName", ulice)
        el(a, "BuildingNumber", cislo)
        el(a, "CityName", obec)
        el(a, "PostalZone", psc)
        c = el(a, "Country")
        el(c, "IdentificationCode", "CZ")
        el(c, "Name", "Česká republika")
        if dic:
            t = el(p, "PartyTaxScheme")
            el(t, "CompanyID", dic)
            el(t, "TaxScheme", "VAT")
        if email or telefon:
            k = el(p, "Contact")
            if telefon:
                el(k, "Telephone", telefon)
            if email:
                el(k, "ElectronicMail", email)

    el(koren, "DocumentType", TYPY[typ][3])
    el(koren, "ID", f["cislo"])
    el(koren, "UUID", str(uuid.uuid5(uuid.NAMESPACE_URL, f"pokladna-pcobchod:{nast.get('firma_ico') or ''}:{f['cislo']}")).upper())
    el(koren, "IssuingSystem", "Pokladna PcObchod")
    el(koren, "IssueDate", f["datum_vystaveni"][:10])
    if typ != "ZALOHOVA":
        el(koren, "TaxPointDate", f["duzp"][:10])
    el(koren, "VATApplicable", "true" if platce and typ != "ZALOHOVA" else "false")
    el(koren, "ElectronicPossibilityAgreementReference", "")
    poznamka = " ".join(poznamky(f, platce) + ([f["poznamka"]] if f.get("poznamka") else []))
    if poznamka:
        el(koren, "Note", poznamka[:1000])
    el(koren, "LocalCurrencyCode", "CZK")
    el(koren, "CurrRate", "1")
    el(koren, "RefCurrRate", "1")
    strana(el(koren, "AccountingSupplierParty"), nast.get("firma_nazev"), nast.get("firma_ico"), nast.get("firma_dic"),
           nast.get("firma_adresa"), telefon=nast.get("telefon"))
    strana(el(koren, "AccountingCustomerParty"), f["odb_nazev"], f.get("odb_ico"), f.get("odb_dic"), f.get("odb_adresa"),
           email=f.get("odb_email"))
    vazba = f.get("vazba") or {}
    if typ in ("OPRAVNY", "DDZP") and vazba.get("cislo"):
        o = el(el(koren, "OriginalDocumentReferences"), "OriginalDocumentReference")
        el(o, "ID", vazba["cislo"])
        el(o, "IssueDate", (vazba.get("datum_vystaveni") or f["datum_vystaveni"])[:10])

    radky = el(koren, "InvoiceLines")
    for i, p in enumerate(f["polozky"], 1):
        s = p["sazba_dph"] if platce else 0
        celkem = p["celkem"]
        zaklad = celkem if pdp or not platce or typ == "ZALOHOVA" else int(round(celkem / (1 + s / 100)))
        r = el(radky, "InvoiceLine")
        el(r, "ID", i)
        el(r, "InvoicedQuantity", f"{p['mnozstvi']:g}", unitCode=p.get("jednotka") or "ks")
        el(r, "LineExtensionAmount", _castka(zaklad))
        el(r, "LineExtensionAmountTaxInclusive", _castka(celkem))
        el(r, "LineExtensionTaxAmount", _castka(celkem - zaklad))
        q = Decimal(str(p["mnozstvi"])) or Decimal(1)
        el(r, "UnitPrice", str((Decimal(zaklad) / 100 / q).quantize(Decimal("0.0001"), ROUND_HALF_UP)))
        el(r, "UnitPriceTaxInclusive", str((Decimal(celkem) / 100 / q).quantize(Decimal("0.0001"), ROUND_HALF_UP)))
        k = el(r, "ClassifiedTaxCategory")
        el(k, "Percent", s)
        el(k, "VATCalculationMethod", "1")
        if pdp:
            el(k, "VATApplicable", "false")
        el(el(r, "Item"), "Description", p["nazev"])

    rekap = [{"sazba": 0, "zaklad": f["celkem"], "dph": 0, "celkem": f["celkem"]}] if not platce or typ == "ZALOHOVA" \
        else rekap_dph(f["polozky"], pdp)
    tt = el(koren, "TaxTotal")
    for r in rekap:
        st = el(tt, "TaxSubTotal")
        for jmeno, hodnota in (("TaxableAmount", r["zaklad"]), ("TaxAmount", r["dph"]), ("TaxInclusiveAmount", r["celkem"]),
                               ("AlreadyClaimedTaxableAmount", 0), ("AlreadyClaimedTaxAmount", 0), ("AlreadyClaimedTaxInclusiveAmount", 0),
                               ("DifferenceTaxableAmount", r["zaklad"]), ("DifferenceTaxAmount", r["dph"]), ("DifferenceTaxInclusiveAmount", r["celkem"])):
            el(st, jmeno, _castka(hodnota))
        kat = el(st, "TaxCategory")
        el(kat, "Percent", r["sazba"])
        if pdp:
            el(kat, "VATApplicable", "false")
    el(tt, "TaxAmount", _castka(sum(r["dph"] for r in rekap)))
    bez = sum(r["zaklad"] for r in rekap)
    lm = el(koren, "LegalMonetaryTotal")
    for jmeno, hodnota in (("TaxExclusiveAmount", bez), ("TaxInclusiveAmount", f["celkem"]), ("AlreadyClaimedTaxExclusiveAmount", 0),
                           ("AlreadyClaimedTaxInclusiveAmount", 0), ("DifferenceTaxExclusiveAmount", bez),
                           ("DifferenceTaxInclusiveAmount", f["celkem"]), ("PaidDepositsAmount", 0), ("PayableAmount", f["celkem"])):
        el(lm, jmeno, _castka(hodnota))

    platba = el(el(koren, "PaymentMeans"), "Payment")
    el(platba, "PaidAmount", _castka(f["celkem"]))
    el(platba, "PaymentMeansCode", {"PREVOD": "42", "HOTOVE": "10", "KARTA": "48", "DOBIRKA": "50"}.get(f["forma_uhrady"], "42"))
    ucet = (nast.get("faktura_ucet") or "").replace(" ", "")
    m = re.fullmatch(r"((?:\d{1,6}-)?\d{2,10})/(\d{4})", ucet)
    if f["forma_uhrady"] == "PREVOD" and m:
        d = el(platba, "Details")
        el(d, "PaymentDueDate", f["splatnost"][:10])
        el(d, "ID", m.group(1))
        el(d, "BankCode", m.group(2))
        el(d, "Name", "")
        el(d, "IBAN", iban_z_uctu(ucet) or "")
        el(d, "BIC", "")
        if f.get("vs"):
            el(d, "VariableSymbol", f["vs"])
    return etree.tostring(koren, xml_declaration=True, encoding="UTF-8", pretty_print=True)
