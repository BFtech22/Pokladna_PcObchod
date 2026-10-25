"""Vytvoří vzorové faktury pro test naskladnění: ISDOC, PDF (přes Chrome) a PDF s vloženým ISDOC.

Dodavatel i čísla jsou smyšlené. Spuštění z kořene projektu:
.venv/bin/python -I _zdroje/skripty/vzorove_faktury.py
"""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from pokladna.faktury import platny_ean  # noqa: E402

CIL = Path(__file__).resolve().parents[1] / "vzorove_faktury"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def ean(zaklad: str) -> str:
    return next(zaklad + str(c) for c in range(10) if platny_ean(zaklad + str(c)))


NOVY_EAN = ean("859568041216")
POLOZKY = [
    # název, kód dodavatele, EAN, množství, jednotka, cena/j bez DPH
    ("Kabel USB-C - USB-C 1m 60W", "KAB-CC-1M", "8595680412013", 10, "ks", 60.00),
    ("Tvrzené sklo iPhone 15 (bal. 10 ks)", "TG-IP15-10", "", 2, "bal", 300.00),
    ("Myš Logitech M185 bezdrátová", "LOG-M185", "5099206027312", 3, "ks", 205.00),
    ("Magnetický nabíjecí kabel USB-C 2 m", "KAB-MAG-2M", NOVY_EAN, 5, "ks", 95.00),
    ("Silikonovy obal iPhone 15 cerny", "", "", 4, "ks", 58.00),
    ("Doprava PPL", "", "", 1, "ks", 99.00),
]
DODAVATEL = ("Testovací Distribuce s.r.o.", "99999991", "CZ99999991")
CISLO = "FV2026-0815"


def isdoc() -> str:
    radky = []
    for i, (nazev, kod, e, q, j, c) in enumerate(POLOZKY, 1):
        radky.append(f"""
    <InvoiceLine>
      <ID>{i}</ID>
      <InvoicedQuantity unitCode="{j}">{q}</InvoicedQuantity>
      <LineExtensionAmount>{q * c:.2f}</LineExtensionAmount>
      <LineExtensionAmountTaxInclusive>{q * c * 1.21:.2f}</LineExtensionAmountTaxInclusive>
      <LineExtensionTaxAmount>{q * c * 0.21:.2f}</LineExtensionTaxAmount>
      <UnitPrice>{c:.2f}</UnitPrice>
      <UnitPriceTaxInclusive>{c * 1.21:.2f}</UnitPriceTaxInclusive>
      <ClassifiedTaxCategory><Percent>21</Percent><VATCalculationMethod>0</VATCalculationMethod></ClassifiedTaxCategory>
      <Item>
        <Description>{nazev}</Description>
        {f'<SellersItemIdentification><ID>{kod}</ID></SellersItemIdentification>' if kod else ''}
        {f'<StandardItemIdentification><ID schemeID="GTIN">{e}</ID></StandardItemIdentification>' if e else ''}
      </Item>
    </InvoiceLine>""")
    zaklad = sum(q * c for *_, q, _, c in POLOZKY)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <DocumentType>1</DocumentType>
  <ID>{CISLO}</ID>
  <UUID>6F2A1B3C-1111-4222-8333-944455556666</UUID>
  <IssueDate>2026-10-24</IssueDate>
  <VATApplicable>true</VATApplicable>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <CurrRate>1</CurrRate><RefCurrRate>1</RefCurrRate>
  <AccountingSupplierParty><Party>
    <PartyIdentification><ID>{DODAVATEL[1]}</ID></PartyIdentification>
    <PartyName><Name>{DODAVATEL[0]}</Name></PartyName>
    <PostalAddress><StreetName>Zkušební</StreetName><BuildingNumber>1</BuildingNumber><CityName>Praha</CityName><PostalZone>11000</PostalZone><Country><IdentificationCode>CZ</IdentificationCode><Name>Česká republika</Name></Country></PostalAddress>
    <PartyTaxScheme><CompanyID>{DODAVATEL[2]}</CompanyID><TaxScheme>VAT</TaxScheme></PartyTaxScheme>
  </Party></AccountingSupplierParty>
  <InvoiceLines>{''.join(radky)}
  </InvoiceLines>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>{zaklad:.2f}</TaxExclusiveAmount>
    <TaxInclusiveAmount>{zaklad * 1.21:.2f}</TaxInclusiveAmount>
    <PayableAmount>{zaklad * 1.21:.2f}</PayableAmount>
  </LegalMonetaryTotal>
</Invoice>
"""


def html() -> str:
    def kc(x):
        return f"{x:,.2f}".replace(",", " ").replace(".", ",")
    radky = "".join(
        f"<tr><td>{kod}</td><td>{nazev}{'<br><small>EAN ' + e + '</small>' if e else ''}</td><td class=r>{q} {j}</td>"
        f"<td class=r>{kc(c)}</td><td class=r>21 %</td><td class=r>{kc(q * c)}</td></tr>"
        for nazev, kod, e, q, j, c in POLOZKY)
    zaklad = sum(q * c for *_, q, _, c in POLOZKY)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{font-family:Arial,sans-serif;font-size:12px;margin:24px}} table{{width:100%;border-collapse:collapse}}
td,th{{border-bottom:1px solid #ccc;padding:4px;text-align:left}} .r{{text-align:right}}</style></head><body>
<h2>Faktura – daňový doklad č. {CISLO}</h2>
<p><b>Dodavatel:</b> {DODAVATEL[0]}, Zkušební 1, Praha, IČO: {DODAVATEL[1]}, DIČ: {DODAVATEL[2]}<br>
<b>Datum vystavení:</b> 24. 10. 2026</p>
<table><tr><th>Kód</th><th>Popis</th><th class=r>Množství</th><th class=r>Cena/MJ bez DPH</th><th class=r>DPH</th><th class=r>Celkem bez DPH</th></tr>
{radky}</table><p class=r><b>Celkem bez DPH: {kc(zaklad)} Kč</b></p></body></html>"""


def main() -> None:
    CIL.mkdir(exist_ok=True)
    (CIL / f"{CISLO}.isdoc").write_text(isdoc(), encoding="utf-8")
    (CIL / f"{CISLO}.html").write_text(html(), encoding="utf-8")
    pdf = CIL / f"{CISLO}.pdf"
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                    f"--print-to-pdf={pdf}", (CIL / f"{CISLO}.html").as_uri()],
                   check=True, capture_output=True, timeout=60)
    from pypdf import PdfReader, PdfWriter
    w = PdfWriter(clone_from=PdfReader(str(pdf)))
    w.add_attachment(f"{CISLO}.isdoc", (CIL / f"{CISLO}.isdoc").read_bytes())
    with open(CIL / f"{CISLO}_s_isdoc.pdf", "wb") as fh:
        w.write(fh)
    print("Hotovo:", ", ".join(sorted(p.name for p in CIL.iterdir())), "| nový EAN", NOVY_EAN)


if __name__ == "__main__":
    main()
