"""Test klienta EET 2.0 proti vzorovým zprávám finanční správy a proti Playgroundu.

Spuštění: .venv/bin/python -I eet/test_playground.py
"""

import sys
from datetime import datetime
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pokladna import eet_klient as eet  # noqa: E402

KOREN = Path(__file__).resolve().parents[1]
DOK = KOREN / "_zdroje" / "eet2_dokumentace"
CERTS = DOK / "certs_playground"
LOG = KOREN / "eet" / "log"


def validuj_trzbu(xml: bytes) -> None:
    schema = etree.XMLSchema(etree.parse(str(DOK / "EETXMLSchema.xsd")))
    trzba = etree.fromstring(xml).find(f".//{{{eet.NS_EET}}}Trzba")
    schema.assertValid(etree.ElementTree(trzba))


def main() -> int:
    LOG.mkdir(exist_ok=True)

    print("1) Kontrola podpisu na vzorových zprávách finanční správy")
    for f in sorted(DOK.glob("*.eet.v4.req.xml")):
        print(f"   {f.name}: {'OK' if eet.over_podpis(f.read_bytes()) else 'NESEDÍ'}")

    heslo = (CERTS / "password_pokladni_cert_playground.txt").read_text().strip()
    cert = eet.PokladniCertifikat(CERTS / "CA_EET-Playground-CZ00000019.p12", heslo)
    print(f"2) Certifikát: {cert.eic}, platí do {cert.plati_do:%d. %m. %Y}")

    cislo = datetime.now(eet.PRAHA).strftime("%Y%m%d-%H%M%S")
    trzba = eet.Trzba(eic_popl="CZ00000019", id_jednotky=303, id_pokl="PCO-RBK-1",
                      porad_cis=f"T-{cislo}", celk_trzba="1299.00")

    for overeni in (True, False):
        mod = "ověřovací" if overeni else "ostrý"
        xml, uid = eet.sestav_zpravu(trzba, cert, overeni=overeni)
        validuj_trzbu(xml)
        assert eet.over_podpis(xml), "vlastní podpis nesedí"
        (LOG / f"{cislo}_{'over' if overeni else 'ostry'}_req.xml").write_bytes(xml)
        print(f"3) {mod} mód: zpráva {len(xml)} B, XSD OK, podpis OK, uuid {uid}")
        odp = eet.odesli(xml)
        (LOG / f"{cislo}_{'over' if overeni else 'ostry'}_resp.xml").write_text(odp.xml, encoding="utf-8")
        print(f"   HTTP {odp.http_status}, X-Global-Transaction-Id {odp.transaction_id}")
        if odp.ok:
            print(f"   POTVRZENO  POK {odp.pok}  test={odp.test}")
        else:
            print(f"   CHYBA {odp.kod_chyby}: {odp.text_chyby}  test={odp.test}")
        for kod, text in odp.varovani:
            print(f"   varování {kod}: {text}")
        if odp.ok and "Signature" in odp.xml:
            print(f"   podpis odpovědi: {'OK' if eet.over_podpis(odp.xml.encode()) else 'NESEDÍ'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
