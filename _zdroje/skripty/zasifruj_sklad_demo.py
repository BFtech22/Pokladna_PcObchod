"""Zašifruje sklad z Trellu heslem pro online demo (demo/sklad-varnsdorf.enc).

Na GitHub jde jen šifrovaný soubor, demo ho po zadání hesla rozšifruje v prohlížeči
(PBKDF2-SHA256 600 000× + AES-256-GCM, data jsou před šifrováním zabalená gzipem).
Katalog se nejdřív naimportuje do dočasné databáze stejně jako ve skutečné pokladně,
takže demo ukazuje přesně to, co by ukázal import (párování EAN, interní kódy, IMEI).

Spuštění z kořene projektu:
    .venv/bin/python -I _zdroje/skripty/zasifruj_sklad_demo.py [EXPORT.xml] [--heslo HESLO]
Bez --heslo se heslo vezme z data/demo_heslo.txt; když soubor chybí, heslo se vygeneruje a uloží tam
(složka data/ do repozitáře nejde). Pak znovu sestavit demo: _zdroje/skripty/postav_demo.py.
"""

import argparse
import gzip
import json
import os
import secrets
import sys
import tempfile
from pathlib import Path

KOREN = Path(__file__).resolve().parents[2]
HESLO_SOUBOR = KOREN / "data" / "demo_heslo.txt"
CIL = KOREN / "demo" / "sklad-varnsdorf.enc"
ITERACI = 600_000
ZNAKY = "abcdefghjkmnpqrstuvwxyz23456789"   # bez l/1/o/0/i, ať se heslo dá opsat


def heslo_ze_souboru() -> str:
    if HESLO_SOUBOR.exists():
        return HESLO_SOUBOR.read_text(encoding="utf-8").strip()
    heslo = "-".join("".join(secrets.choice(ZNAKY) for _ in range(4)) for _ in range(4))
    HESLO_SOUBOR.parent.mkdir(parents=True, exist_ok=True)
    HESLO_SOUBOR.write_text(heslo + "\n", encoding="utf-8")
    HESLO_SOUBOR.chmod(0o600)
    print(f"Vygenerováno nové heslo do {HESLO_SOUBOR.relative_to(KOREN)}")
    return heslo


def sklad(export: Path) -> dict:
    """Naimportuje export do dočasné databáze a vrátí zboží v kompaktním tvaru pro demo."""
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["POKLADNA_DB"] = str(Path(tmp) / "demo.sqlite")
        sys.path.insert(0, str(KOREN))
        from pokladna import db, import_trell
        db.inicializuj()
        karty, varovani = import_trell.nacti(export.read_bytes())
        with db.spojeni() as con:
            import_trell.importuj(con, karty, None)
            eany: dict = {}
            for e, zid in con.execute("SELECT ean, zbozi_id FROM zbozi_ean ORDER BY ean"):
                eany.setdefault(zid, []).append(e)
            zbozi = [[r["nazev"], r["kategorie"], r["cena"], r["stav"], eany.get(r["id"], []), r["kod"], r["seriova_cisla"], r["poznamka"]]
                     for r in con.execute("SELECT * FROM zbozi ORDER BY id")]
    return {"verze": 1, "prodejna": "Varnsdorf", "export": os.path.getmtime(export), "varovani": varovani,
            "sloupce": ["nazev", "kategorie", "cena", "stav", "eany", "kod", "seriova_cisla", "poznamka"], "zbozi": zbozi}


def zasifruj(data: bytes, heslo: str) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    sul, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    klic = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=sul, iterations=ITERACI).derive(heslo.encode("utf-8"))
    return b"PKS1" + sul + iv + AESGCM(klic).encrypt(iv, data, None)


def main() -> None:
    ap = argparse.ArgumentParser(description="Zašifruje sklad z Trellu heslem pro online demo")
    ap.add_argument("export", nargs="?", default=str(KOREN / "data" / "trell" / "Varnsdorf" / "TRELL-NEXT.xml"))
    ap.add_argument("--heslo", help="vlastní heslo (jinak data/demo_heslo.txt)")
    a = ap.parse_args()
    heslo = a.heslo or heslo_ze_souboru()
    if a.heslo:
        HESLO_SOUBOR.parent.mkdir(parents=True, exist_ok=True)
        HESLO_SOUBOR.write_text(heslo + "\n", encoding="utf-8")
        HESLO_SOUBOR.chmod(0o600)
    obsah = sklad(Path(a.export))
    surova = json.dumps(obsah, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sifra = zasifruj(gzip.compress(surova, 9, mtime=0), heslo)
    CIL.write_bytes(sifra)
    skladem = sum(1 for z in obsah["zbozi"] if z[3] > 0)
    print(f"{CIL.relative_to(KOREN)}: {len(obsah['zbozi'])} karet, {skladem} skladem, {len(sifra) // 1024} kB "
          f"(nezašifrovaně {len(surova) // 1024} kB)")


if __name__ == "__main__":
    main()
