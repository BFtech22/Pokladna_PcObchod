"""Klient EET 2.0 (rozhraní v4.1): sestavení, podpis (WS-Security) a odeslání datové zprávy evidované tržby.

Podle dokumentu „Formát a struktura údajů o evidované tržbě a popis datového rozhraní“ v1.2 (25. 8. 2026):
- SOAP 1.1, podpis XMLDSig v hlavičce WS-Security, podepisuje se jen <soapenv:Body>,
- Exclusive C14N, digest SHA-256, podpis RSA-SHA256, certifikát v BinarySecurityToken,
- celá zpráva max. 12 kB, kódování UTF-8, Content-Type text/xml; charset=utf-8.
"""

from __future__ import annotations

import base64
import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import pkcs12
from lxml import etree

URL_PLAYGROUND = "https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4"
URL_PRODUKCE = "https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4"
SOAP_ACTION = "http://fs.gov.cz/eet/OdeslaniTrzby"

NS_SOAP = "http://schemas.xmlsoap.org/soap/envelope/"
NS_EET = "http://fs.gov.cz/eet/schema/v4"
NS_WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
NS_WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
NS_DS = "http://www.w3.org/2000/09/xmldsig#"
NS_EC = "http://www.w3.org/2001/10/xml-exc-c14n#"

ALG_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#"
ALG_RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
ALG_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256"
TYPE_B64 = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
TYPE_X509 = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"

MAX_VELIKOST = 12 * 1024
PRAHA = ZoneInfo("Europe/Prague")

_RE_TEXT = re.compile(r"^[0-9a-zA-Z.,:;/#\-_ ]+$")


def cas_eet(dt: Optional[datetime] = None) -> str:
    """Datum a čas ve tvaru rrrr-mm-ddThh:mm:ss+01:00 / +02:00 (SEČ/SELČ), bez mikrosekund."""
    dt = (dt or datetime.now(PRAHA)).astimezone(PRAHA).replace(microsecond=0)
    return dt.isoformat()


def castka_eet(castka) -> str:
    """Částka s právě dvěma desetinnými místy, bez vedoucích nul a bez „-0.00“."""
    d = Decimal(str(castka)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if d == 0:
        return "0.00"
    return f"{d:.2f}"


@dataclass
class Trzba:
    eic_popl: str
    id_jednotky: int
    id_pokl: str
    porad_cis: str
    celk_trzba: object
    dat_trzby: Optional[str] = None
    urceno_cerp_zuct: object = None
    cerp_zuct: object = None
    eic_poverujiciho: Optional[str] = None

    def zkontroluj(self) -> None:
        if not re.fullmatch(r"CZ[0-9]{8,10}", self.eic_popl):
            raise ValueError(f"Chybné EIČ: {self.eic_popl}")
        if not (1 <= int(self.id_jednotky) <= 999_999_999):
            raise ValueError(f"Chybné označení evidenční jednotky: {self.id_jednotky}")
        if not (_RE_TEXT.match(self.id_pokl) and len(self.id_pokl) <= 20):
            raise ValueError(f"Chybné označení pokladny: {self.id_pokl!r}")
        if not (_RE_TEXT.match(self.porad_cis) and len(self.porad_cis) <= 25):
            raise ValueError(f"Chybné pořadové číslo: {self.porad_cis!r}")


@dataclass
class Odpoved:
    ok: bool
    pok: Optional[str]
    kod_chyby: Optional[int]
    text_chyby: Optional[str]
    varovani: list
    test: bool
    uuid_zpravy: Optional[str]
    transaction_id: Optional[str]
    http_status: int
    xml: str


class PokladniCertifikat:
    """Pokladní certifikát (PKCS#12) s privátním klíčem."""

    def __init__(self, p12_cesta: Path, heslo: str):
        data = Path(p12_cesta).read_bytes()
        klic, cert, _ = pkcs12.load_key_and_certificates(data, heslo.encode())
        if klic is None or cert is None:
            raise ValueError("V souboru PKCS#12 chybí klíč nebo certifikát")
        self.klic = klic
        self.cert = cert
        self.der_b64 = base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()
        self.eic = cert.subject.rfc4514_string()
        self.plati_do = cert.not_valid_after_utc

    def podepis(self, data: bytes) -> bytes:
        return self.klic.sign(data, padding.PKCS1v15(), hashes.SHA256())


def _q(ns: str, jmeno: str) -> str:
    return f"{{{ns}}}{jmeno}"


def _c14n(el, prefixy) -> bytes:
    return etree.tostring(el, method="c14n", exclusive=True, with_comments=False,
                          inclusive_ns_prefixes=list(prefixy))


def sestav_zpravu(trzba: Trzba, cert: PokladniCertifikat, *, prvni_zaslani: bool = True,
                  overeni: bool = False, dat_odesl: Optional[str] = None,
                  uuid_zpravy: Optional[str] = None) -> tuple[bytes, str]:
    """Vrátí (podepsaná SOAP zpráva v UTF-8, uuid_zpravy)."""
    trzba.zkontroluj()
    uuid_zpravy = uuid_zpravy or str(uuid.uuid4())
    sufix = uuid.uuid4().hex.upper()
    id_body, id_token = f"id-{sufix}", f"X509-{sufix}"

    env = etree.Element(_q(NS_SOAP, "Envelope"), nsmap={"soapenv": NS_SOAP, "v4": NS_EET})
    header = etree.SubElement(env, _q(NS_SOAP, "Header"))
    body = etree.SubElement(env, _q(NS_SOAP, "Body"), nsmap={"wsu": NS_WSU})
    body.set(_q(NS_WSU, "Id"), id_body)

    el_trzba = etree.SubElement(body, _q(NS_EET, "Trzba"))
    hl = etree.SubElement(el_trzba, _q(NS_EET, "Hlavicka"))
    hl.set("uuid_zpravy", uuid_zpravy)
    hl.set("dat_odesl", dat_odesl or cas_eet())
    hl.set("prvni_zaslani", "true" if prvni_zaslani else "false")
    if overeni:
        hl.set("overeni", "true")

    d = etree.SubElement(el_trzba, _q(NS_EET, "Data"))
    d.set("eic_popl", trzba.eic_popl)
    if trzba.eic_poverujiciho:
        d.set("eic_poverujiciho", trzba.eic_poverujiciho)
    d.set("id_jednotky", str(int(trzba.id_jednotky)))
    d.set("id_pokl", trzba.id_pokl)
    d.set("porad_cis", trzba.porad_cis)
    d.set("dat_trzby", trzba.dat_trzby or cas_eet())
    d.set("celk_trzba", castka_eet(trzba.celk_trzba))
    if trzba.urceno_cerp_zuct is not None:
        d.set("urceno_cerp_zuct", castka_eet(trzba.urceno_cerp_zuct))
    if trzba.cerp_zuct is not None:
        d.set("cerp_zuct", castka_eet(trzba.cerp_zuct))

    sec = etree.SubElement(header, _q(NS_WSSE, "Security"), nsmap={"wsse": NS_WSSE, "wsu": NS_WSU})
    bst = etree.SubElement(sec, _q(NS_WSSE, "BinarySecurityToken"))
    bst.set("EncodingType", TYPE_B64)
    bst.set("ValueType", TYPE_X509)
    bst.set(_q(NS_WSU, "Id"), id_token)
    bst.text = cert.der_b64

    sig = etree.SubElement(sec, _q(NS_DS, "Signature"), nsmap={"ds": NS_DS})
    sig.set("Id", f"SIG-{sufix}")
    si = etree.SubElement(sig, _q(NS_DS, "SignedInfo"))
    cm = etree.SubElement(si, _q(NS_DS, "CanonicalizationMethod"), Algorithm=ALG_C14N)
    etree.SubElement(cm, _q(NS_EC, "InclusiveNamespaces"), nsmap={"ec": NS_EC}, PrefixList="soapenv v4")
    etree.SubElement(si, _q(NS_DS, "SignatureMethod"), Algorithm=ALG_RSA_SHA256)
    ref = etree.SubElement(si, _q(NS_DS, "Reference"), URI=f"#{id_body}")
    tr = etree.SubElement(etree.SubElement(ref, _q(NS_DS, "Transforms")), _q(NS_DS, "Transform"), Algorithm=ALG_C14N)
    etree.SubElement(tr, _q(NS_EC, "InclusiveNamespaces"), nsmap={"ec": NS_EC}, PrefixList="v4")
    etree.SubElement(ref, _q(NS_DS, "DigestMethod"), Algorithm=ALG_SHA256)
    etree.SubElement(ref, _q(NS_DS, "DigestValue"))
    etree.SubElement(sig, _q(NS_DS, "SignatureValue"))

    ki = etree.SubElement(sig, _q(NS_DS, "KeyInfo"))
    ki.set("Id", f"KI-{sufix}")
    strf = etree.SubElement(ki, _q(NS_WSSE, "SecurityTokenReference"))
    strf.set(_q(NS_WSU, "Id"), f"STR-{sufix}")
    etree.SubElement(strf, _q(NS_WSSE, "Reference"), URI=f"#{id_token}", ValueType=TYPE_X509)

    # Kanonizace podstromu přímo na sestaveném stromu je v lxml nespolehlivá: občas vynechá
    # jmenný prostor z InclusiveNamespaces (v4) a otisk pak nesedí. Proto se obálka nejdřív
    # zapíše a znovu načte a otisk i podpis se počítají z toho, co se skutečně odešle.
    doc = etree.fromstring(etree.tostring(env))
    ns = {"soapenv": NS_SOAP, "ds": NS_DS}
    doc.find(".//ds:DigestValue", ns).text = base64.b64encode(
        hashlib.sha256(_c14n(doc.find("soapenv:Body", ns), ["v4"])).digest()).decode()
    doc.find(".//ds:SignatureValue", ns).text = base64.b64encode(
        cert.podepis(_c14n(doc.find(".//ds:SignedInfo", ns), ["soapenv", "v4"]))).decode()

    xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8")
    if not over_podpis(xml):
        raise RuntimeError("Podpis datové zprávy se nepodařilo ověřit")
    if len(xml) > MAX_VELIKOST:
        raise ValueError(f"Zpráva má {len(xml)} B, limit je {MAX_VELIKOST} B")
    return xml, uuid_zpravy


def over_podpis(xml: bytes) -> bool:
    """Ověří digest těla a podpis SignedInfo vůči certifikátu v BinarySecurityToken (pro testy i odpovědi)."""
    from cryptography import x509

    doc = etree.fromstring(xml)
    ns = {"soapenv": NS_SOAP, "ds": NS_DS, "wsse": NS_WSSE, "ec": NS_EC}
    si = doc.find(".//ds:SignedInfo", ns)
    ref = si.find("ds:Reference", ns)
    cil_id = ref.get("URI").lstrip("#")
    cil = next(el for el in doc.iter() if el.get(_q(NS_WSU, "Id")) == cil_id)
    def prefixy(el):
        # InclusiveNamespaces je nepovinné, odpovědi finanční správy ho neobsahují.
        return (el.get("PrefixList") or "").split() if el is not None else []

    pref_ref = prefixy(ref.find(".//ec:InclusiveNamespaces", ns))
    digest = base64.b64encode(hashlib.sha256(_c14n(cil, pref_ref)).digest()).decode()
    if digest != ref.findtext("ds:DigestValue", namespaces=ns).strip():
        return False
    pref_si = prefixy(si.find("ds:CanonicalizationMethod/ec:InclusiveNamespaces", ns))
    der = base64.b64decode(doc.findtext(".//wsse:BinarySecurityToken", namespaces=ns))
    pub = x509.load_der_x509_certificate(der).public_key()
    podpis = base64.b64decode(doc.findtext(".//ds:SignatureValue", namespaces=ns))
    try:
        pub.verify(podpis, _c14n(si, pref_si), padding.PKCS1v15(), hashes.SHA256())
        return True
    except Exception:
        return False


def precti_odpoved(xml: bytes, http_status: int, transaction_id: Optional[str]) -> Odpoved:
    doc = etree.fromstring(xml)
    ns = {"e": NS_EET}
    hl = doc.find(".//e:Odpoved/e:Hlavicka", ns)
    potv = doc.find(".//e:Odpoved/e:Potvrzeni", ns)
    chyba = doc.find(".//e:Odpoved/e:Chyba", ns)
    varovani = [(int(v.get("kod_varov")), (v.text or "").strip()) for v in doc.findall(".//e:Odpoved/e:Varovani", ns)]
    test = (potv if potv is not None else chyba)
    return Odpoved(
        ok=potv is not None,
        pok=potv.get("pok") if potv is not None else None,
        kod_chyby=int(chyba.get("kod")) if chyba is not None else None,
        text_chyby=(chyba.text or "").strip() if chyba is not None else None,
        varovani=varovani,
        test=test is not None and test.get("test") in ("true", "1"),
        uuid_zpravy=hl.get("uuid_zpravy") if hl is not None else None,
        transaction_id=transaction_id,
        http_status=http_status,
        xml=xml.decode("utf-8", "replace"),
    )


def odesli(xml: bytes, url: str = URL_PLAYGROUND, timeout: float = 5.0) -> Odpoved:
    r = requests.post(url, data=xml, timeout=timeout, headers={
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": SOAP_ACTION,
    })
    return precti_odpoved(r.content, r.status_code, r.headers.get("X-Global-Transaction-Id"))
