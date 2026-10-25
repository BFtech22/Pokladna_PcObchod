"""Vydané faktury: IBAN a QR platba, PDF (A4) a text e-mailu."""

from __future__ import annotations

import io
import re
from datetime import date
from pathlib import Path
from typing import Optional

STATIC = Path(__file__).resolve().parent / "static"
FORMY = {"PREVOD": "převodem", "HOTOVE": "hotově", "KARTA": "kartou", "DOBIRKA": "dobírkou"}

PISMA = [   # (běžné, tučné) – Debian/Raspberry Pi, macOS, Windows
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
]


class ChybaFakturace(Exception):
    pass


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


def rekap_dph(polozky: list) -> list:
    m: dict = {}
    for p in polozky:
        m[p["sazba_dph"]] = m.get(p["sazba_dph"], 0) + p["celkem"]
    out = []
    for s in sorted(m, reverse=True):
        zaklad = int(round(m[s] / (1 + s / 100)))
        out.append({"sazba": s, "zaklad": zaklad, "dph": m[s] - zaklad, "celkem": m[s]})
    return out


def kc(h: int) -> str:
    return f"{h / 100:,.2f}".replace(",", " ").replace(".", ",") + " Kč"


def _datum(iso: Optional[str]) -> str:
    if not iso:
        return ""
    d = date.fromisoformat(iso[:10])
    return f"{d.day}. {d.month}. {d.year}"


def pdf(f: dict, nast: dict) -> bytes:
    """Faktura A4 jako PDF. `f` = detail faktury z API (včetně položek)."""
    from fpdf import FPDF

    pismo = next(((r, b) for r, b in PISMA if Path(r).is_file() and Path(b).is_file()), None)
    if not pismo:
        raise ChybaFakturace("Na serveru chybí písmo pro PDF (nainstalujte balíček fonts-dejavu-core)")
    platce = nast.get("platce_dph") == "1"
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
    doc.cell(sirka - 75, 8, ("Faktura – daňový doklad" if platce else "Faktura"), align="R")
    doc.set_font("P", "", 11)
    doc.set_xy(90, 23)
    doc.cell(sirka - 75, 6, f"č. {f['cislo']}", align="R")
    if f["stav"] == "STORNO":
        doc.set_text_color(200, 0, 0)
        doc.set_xy(90, 29)
        doc.cell(sirka - 75, 6, "STORNOVÁNO", align="R")
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
    udaje = [("Datum vystavení", _datum(f["datum_vystaveni"])), ("Datum zdan. plnění", _datum(f["duzp"])),
             ("Datum splatnosti", _datum(f["splatnost"])), ("Forma úhrady", FORMY.get(f["forma_uhrady"], f["forma_uhrady"])),
             ("Variabilní symbol", f.get("vs") or "")]
    if f["forma_uhrady"] == "PREVOD" and nast.get("faktura_ucet"):
        udaje += [("Bankovní účet", nast["faktura_ucet"]), ("IBAN", iban or "")]
    doc.set_fill_color(245, 245, 247)
    doc.rect(15, y, sirka, 6 * ((len(udaje) + 1) // 2) + 4, style="F")
    for i, (k, v) in enumerate(udaje):
        sx = 18 + (i % 2) * (sirka / 2)
        sy = y + 3 + (i // 2) * 6
        doc.set_xy(sx, sy)
        doc.set_font("P", "", 9)
        doc.set_text_color(110, 110, 110)
        doc.cell(36, 6, k)
        doc.set_text_color(0, 0, 0)
        doc.set_font("P", "B", 10)
        doc.cell(sirka / 2 - 40, 6, v)
    y += 6 * ((len(udaje) + 1) // 2) + 10

    sloupce = [("Položka", 78, "L"), ("Množství", 22, "R"), ("Cena/MJ s DPH", 30, "R"), ("DPH", 14, "R"), ("Celkem s DPH", sirka - 144, "R")]
    if not platce:
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
            hodnoty.append(f"{p['sazba_dph']} %")
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

    if platce:
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
    doc.cell(110, 10, f"Celkem k úhradě: {kc(f['celkem'])}", align="R")
    doc.ln(10)
    if f["stav"] == "UHRAZENO":
        doc.set_font("P", "B", 10)
        doc.set_text_color(31, 138, 76)
        doc.set_x(15 + sirka - 110)
        doc.cell(110, 6, f"Uhrazeno {_datum(f.get('datum_uhrady'))} – neplaťte", align="R")
        doc.set_text_color(0, 0, 0)
        doc.ln(6)

    if f["forma_uhrady"] == "PREVOD" and iban and f["stav"] == "NEUHRAZENO":
        obr = qr(spayd(iban, f["celkem"], f.get("vs"), f["splatnost"], f"Faktura {f['cislo']}"))
        doc.image(io.BytesIO(obr), x=15, y=y_celkem - 2, w=32)
        doc.set_xy(49, y_celkem + 10)
        doc.set_font("P", "", 8)
        doc.set_text_color(110, 110, 110)
        doc.cell(40, 4, "QR Platba")
        doc.set_text_color(0, 0, 0)
        doc.set_y(max(doc.get_y(), y_celkem + 34))

    if f.get("poznamka"):
        doc.ln(4)
        doc.set_font("P", "", 9.5)
        doc.multi_cell(sirka, 5, f["poznamka"])
    doc.set_y(-28)
    doc.set_font("P", "", 8)
    doc.set_text_color(120, 120, 120)
    pata = " · ".join(x for x in [nast.get("faktura_pata"), f.get("vystavil") and f"Vystavil: {f['vystavil']}"] if x)
    doc.multi_cell(sirka, 4, pata, align="C")
    return bytes(doc.output())


def email_html(f: dict, nast: dict, zprava: str = "") -> str:
    import html as h
    radky = "".join(f"<tr><td>{h.escape(p['nazev'])}</td><td align=right>{str(p['mnozstvi']).rstrip('0').rstrip('.').replace('.', ',')}</td><td align=right>{kc(p['celkem'])}</td></tr>"
                    for p in f["polozky"])
    uhrada = ""
    if f["forma_uhrady"] == "PREVOD" and f["stav"] == "NEUHRAZENO":
        uhrada = (f"<p>Prosíme o úhradu <b>{kc(f['celkem'])}</b> do <b>{_datum(f['splatnost'])}</b> na účet "
                  f"<b>{h.escape(nast.get('faktura_ucet') or '')}</b>, variabilní symbol <b>{h.escape(f.get('vs') or '')}</b>. "
                  "QR platba je v přiloženém PDF.</p>")
    return f"""<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1f;max-width:620px">
<p>{h.escape(zprava).replace(chr(10), '<br>') if zprava else 'Dobrý den,<br>v příloze posíláme fakturu.'}</p>
<h2 style="font-size:18px;margin:18px 0 6px">Faktura {h.escape(f['cislo'])}</h2>
<table cellpadding=6 style="border-collapse:collapse;width:100%;border-top:1px solid #ddd">{radky}
<tr><td colspan=2><b>Celkem</b></td><td align=right><b>{kc(f['celkem'])}</b></td></tr></table>
{uhrada}
<p style="color:#777;font-size:12px">{h.escape(nast.get('firma_nazev') or '')} · {h.escape(nast.get('firma_adresa') or '')}</p></div>"""
