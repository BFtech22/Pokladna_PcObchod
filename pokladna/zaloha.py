"""Šifrovaná záloha pokladny a odeslání mimo prodejnu.

Záloha = databáze (konzistentní kopie přes SQLite backup API za běhu) + nahrané faktury + certifikáty,
zabalené do tar.gz a zašifrované AES-256-GCM klíčem odvozeným z hesla (scrypt). Formát souboru:
    b"PKZALOHA1" | sůl (16 B) | nonce (12 B) | šifrovaný tar.gz

Mimo prodejnu se kopíruje:
- do složky (USB disk, síťový disk NAS) – nastavení `zaloha_slozka`,
- přes rclone (Google Disk, OneDrive, SFTP, S3 …) – nastavení `zaloha_rclone_cil`, např. „gdrive:Pokladna/Rumburk“.

Ruční použití:
    python -m pokladna.zaloha               # záloha teď
    python -m pokladna.zaloha obnov SOUBOR  # obnova (server musí být zastavený)
"""

from __future__ import annotations

import argparse
import getpass
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from . import db
from .eet_klient import PRAHA

log = logging.getLogger("pokladna.zaloha")

HLAVICKA = b"PKZALOHA1"
DATA_DIR = db.DB_CESTA.parent
ZALOHY_DIR = DATA_DIR / "zalohy"
SLOZKY_V_ZALOZE = ("faktury", "certifikaty")
STAV_SOUBOR = DATA_DIR / "zaloha_stav.json"


class ChybaZalohy(Exception):
    pass


def _klic(heslo: str, sul: bytes) -> bytes:
    return Scrypt(salt=sul, length=32, n=2 ** 15, r=8, p=1).derive(heslo.encode())


def zasifruj(data: bytes, heslo: str) -> bytes:
    sul, nonce = os.urandom(16), os.urandom(12)
    return HLAVICKA + sul + nonce + AESGCM(_klic(heslo, sul)).encrypt(nonce, data, HLAVICKA)


def desifruj(data: bytes, heslo: str) -> bytes:
    if not data.startswith(HLAVICKA):
        raise ChybaZalohy("Soubor není záloha pokladny")
    n = len(HLAVICKA)
    sul, nonce, sifra = data[n:n + 16], data[n + 16:n + 28], data[n + 28:]
    try:
        return AESGCM(_klic(heslo, sul)).decrypt(nonce, sifra, HLAVICKA)
    except Exception:
        raise ChybaZalohy("Špatné heslo nebo poškozená záloha")


def _nazev_prodejny(nast: dict) -> str:
    zaklad = nast.get("zaloha_nazev") or nast.get("provozovna") or nast.get("firma_nazev") or "pokladna"
    return re.sub(r"[^a-z0-9]+", "-", db.bez_diakritiky(zaklad)).strip("-")[:40] or "pokladna"


def cti_stav() -> dict:
    try:
        return json.loads(STAV_SOUBOR.read_text())
    except (OSError, ValueError):
        return {}


def _uloz_stav(stav: dict) -> None:
    STAV_SOUBOR.write_text(json.dumps(stav, ensure_ascii=False, indent=1))


def vytvor_zalohu(nast: Optional[dict] = None) -> dict:
    """Vytvoří šifrovanou zálohu v data/zalohy a pošle ji na nastavená místa mimo prodejnu."""
    with db.spojeni() as con:
        nast = nast or db.nastaveni(con)
    heslo = nast.get("zaloha_heslo") or ""
    if len(heslo) < 8:
        raise ChybaZalohy("Nastavte heslo zálohy (aspoň 8 znaků) v Nastavení → Záloha")

    ZALOHY_DIR.mkdir(parents=True, exist_ok=True)
    cas = datetime.now(PRAHA)
    nazev = f"pokladna-{_nazev_prodejny(nast)}-{cas:%Y%m%d-%H%M%S}.zaloha"

    with tempfile.TemporaryDirectory() as tmp:
        kopie = Path(tmp) / "pokladna.sqlite"
        zdroj = sqlite3.connect(db.DB_CESTA)
        cil = sqlite3.connect(kopie)
        with cil:
            zdroj.backup(cil)                      # konzistentní i za běhu serveru
        zdroj.close()
        kontrola = cil.execute("PRAGMA integrity_check").fetchone()[0]
        cil.close()
        if kontrola != "ok":
            raise ChybaZalohy(f"Kontrola databáze selhala: {kontrola}")

        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            tar.add(kopie, arcname="pokladna.sqlite")
            for slozka in SLOZKY_V_ZALOZE:
                if (DATA_DIR / slozka).is_dir():
                    tar.add(DATA_DIR / slozka, arcname=slozka)
            info = json.dumps({"vytvoreno": cas.isoformat(), "prodejna": _nazev_prodejny(nast),
                               "verze": 1}, ensure_ascii=False).encode()
            ti = tarfile.TarInfo("zaloha.json")
            ti.size = len(info)
            tar.addfile(ti, io.BytesIO(info))

    soubor = ZALOHY_DIR / nazev
    soubor.write_bytes(zasifruj(buf.getvalue(), heslo))
    os.chmod(soubor, 0o600)

    vysledek = {"cas": cas.isoformat(timespec="seconds"), "soubor": nazev, "velikost": soubor.stat().st_size,
                "mista": [], "chyby": []}

    slozka = (nast.get("zaloha_slozka") or "").strip()
    if slozka:
        try:
            cil_dir = Path(slozka)
            if not cil_dir.is_dir():
                raise ChybaZalohy(f"Složka {slozka} neexistuje nebo není připojená")
            shutil.copy2(soubor, cil_dir / nazev)
            _promaz(cil_dir, int(nast.get("zaloha_ponechat_venku") or 60))
            vysledek["mista"].append(f"složka {slozka}")
        except Exception as e:
            vysledek["chyby"].append(f"Složka: {e}")

    rclone_cil = (nast.get("zaloha_rclone_cil") or "").strip()
    if rclone_cil:
        try:
            _rclone("copyto", str(soubor), f"{rclone_cil.rstrip('/')}/{nazev}")
            dny = int(nast.get("zaloha_ponechat_venku") or 60)
            _rclone("delete", "--min-age", f"{dny}d", "--include", "pokladna-*.zaloha", rclone_cil)
            vysledek["mista"].append(f"rclone {rclone_cil}")
        except Exception as e:
            vysledek["chyby"].append(f"rclone: {e}")

    _promaz(ZALOHY_DIR, int(nast.get("zaloha_ponechat_lokalne") or 14), podle_poctu=True)

    stav = cti_stav()
    stav["posledni"] = vysledek
    if vysledek["mista"] and not vysledek["chyby"]:
        stav["posledni_mimo"] = vysledek["cas"]
    _uloz_stav(stav)
    if vysledek["chyby"]:
        log.warning("Záloha %s: %s", nazev, "; ".join(vysledek["chyby"]))
    else:
        log.info("Záloha %s hotová (%s)", nazev, ", ".join(vysledek["mista"]) or "jen lokálně")
    return vysledek


def _rclone(*argumenty: str) -> None:
    if not shutil.which("rclone"):
        raise ChybaZalohy("Program rclone není nainstalovaný")
    r = subprocess.run(["rclone", *argumenty], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise ChybaZalohy((r.stderr or r.stdout).strip().splitlines()[-1][:300] if (r.stderr or r.stdout) else f"kód {r.returncode}")


def _promaz(slozka: Path, limit: int, podle_poctu: bool = False) -> None:
    """Lokálně nechá posledních `limit` záloh, venku zálohy mladší než `limit` dní."""
    soubory = sorted(slozka.glob("pokladna-*.zaloha"), key=lambda p: p.stat().st_mtime, reverse=True)
    if podle_poctu:
        stare = soubory[max(limit, 1):]
    else:
        hranice = datetime.now().timestamp() - limit * 86400
        stare = [p for p in soubory[3:] if p.stat().st_mtime < hranice]   # aspoň 3 zálohy zůstanou vždy
    for p in stare:
        p.unlink(missing_ok=True)


def obnov(soubor: Path, heslo: str, cil: Path = DATA_DIR) -> dict:
    """Obnoví data ze zálohy. Původní databázi a složky přejmenuje na *.pred-obnovou-<čas>."""
    tar_data = desifruj(Path(soubor).read_bytes(), heslo)
    znacka = datetime.now().strftime("%Y%m%d-%H%M%S")
    cil.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(tar_data), mode="r:gz") as tar:
        clenove = tar.getmembers()
        for m in clenove:                          # ochrana proti cestám mimo cílovou složku
            if m.name.startswith(("/", "..")) or ".." in Path(m.name).parts or m.issym() or m.islnk():
                raise ChybaZalohy(f"Podezřelá cesta v záloze: {m.name}")
        info = json.loads(tar.extractfile("zaloha.json").read())
        for jmeno in ("pokladna.sqlite", "pokladna.sqlite-wal", "pokladna.sqlite-shm", *SLOZKY_V_ZALOZE):
            puvodni = cil / jmeno
            if puvodni.exists():
                puvodni.rename(cil / f"{jmeno}.pred-obnovou-{znacka}")
        for m in clenove:
            if m.name != "zaloha.json":
                tar.extract(m, cil)
    return info


# --------------------------------------------------------------------------- plán

class Planovac:
    """Denní záloha v nastavený čas; po startu dožene zmeškanou, když je poslední starší než den."""

    def __init__(self) -> None:
        self._vlakno: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._zamek = threading.Lock()

    def zalohuj(self) -> dict:
        with self._zamek:
            return vytvor_zalohu()

    def _smycka(self) -> None:
        while not self._stop.wait(60):
            try:
                with db.spojeni() as con:
                    nast = db.nastaveni(con)
                if len(nast.get("zaloha_heslo") or "") < 8:
                    continue
                ted = datetime.now(PRAHA)
                hh, mm = (nast.get("zaloha_cas") or "21:30").split(":")
                dnesni = ted.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
                posledni = cti_stav().get("posledni", {}).get("cas")
                posledni_dt = datetime.fromisoformat(posledni) if posledni else None
                zmeskana = posledni_dt is None or ted - posledni_dt > timedelta(hours=26)
                planovana = ted >= dnesni and (posledni_dt is None or posledni_dt < dnesni)
                if zmeskana or planovana:
                    self.zalohuj()
            except Exception:
                log.exception("Plánovaná záloha selhala")

    def spust(self) -> None:
        if self._vlakno is None:
            self._vlakno = threading.Thread(target=self._smycka, name="zaloha", daemon=True)
            self._vlakno.start()

    def zastav(self) -> None:
        self._stop.set()


planovac = Planovac()


# --------------------------------------------------------------------------- příkazová řádka

def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m pokladna.zaloha", description="Záloha a obnova pokladny")
    pod = ap.add_subparsers(dest="prikaz")
    pod.add_parser("zalohuj", help="vytvořit zálohu teď (výchozí)")
    o = pod.add_parser("obnov", help="obnovit data ze zálohy (server musí být zastavený)")
    o.add_argument("soubor", type=Path)
    o.add_argument("--cil", type=Path, default=DATA_DIR)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        if args.prikaz == "obnov":
            heslo = os.environ.get("POKLADNA_ZALOHA_HESLO") or getpass.getpass("Heslo zálohy: ")
            info = obnov(args.soubor, heslo, args.cil)
            print(f"Obnoveno: záloha z {info['vytvoreno']} ({info['prodejna']}) do {args.cil}")
        else:
            db.inicializuj()
            v = vytvor_zalohu()
            print(f"Záloha {v['soubor']} ({v['velikost'] // 1024} kB) → {', '.join(v['mista']) or 'jen lokálně'}")
            for ch in v["chyby"]:
                print("CHYBA:", ch)
            sys.exit(1 if v["chyby"] else 0)
    except ChybaZalohy as e:
        print("CHYBA:", e)
        sys.exit(2)


if __name__ == "__main__":
    main()
