"""Databáze pokladny (SQLite). Částky v haléřích (int), množství v jednotkách zboží (float)."""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional

from .eet_klient import PRAHA

KOREN = Path(__file__).resolve().parents[1]
DB_CESTA = Path(os.environ.get("POKLADNA_DB", KOREN / "data" / "pokladna.sqlite"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS nastaveni (
    klic TEXT PRIMARY KEY,
    hodnota TEXT
);

CREATE TABLE IF NOT EXISTS uzivatele (
    id INTEGER PRIMARY KEY,
    jmeno TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('SPRAVCE', 'PRODAVAC')),
    aktivni INTEGER NOT NULL DEFAULT 1,
    vytvoreno TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relace (
    token TEXT PRIMARY KEY,
    uzivatel_id INTEGER NOT NULL REFERENCES uzivatele(id),
    vytvoreno TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zbozi (
    id INTEGER PRIMARY KEY,
    nazev TEXT NOT NULL,
    kod TEXT UNIQUE,
    kategorie TEXT,
    cena INTEGER NOT NULL DEFAULT 0,          -- prodejní cena s DPH v haléřích
    sazba_dph INTEGER NOT NULL DEFAULT 21,
    nakupni_cena INTEGER,                      -- poslední nákupní cena bez DPH v haléřích
    jednotka TEXT NOT NULL DEFAULT 'ks',
    stav REAL NOT NULL DEFAULT 0,
    min_stav REAL NOT NULL DEFAULT 0,
    aktivni INTEGER NOT NULL DEFAULT 1,
    poznamka TEXT,
    vytvoreno TEXT NOT NULL,
    upraveno TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_zbozi_nazev ON zbozi(nazev COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS zbozi_ean (
    ean TEXT PRIMARY KEY,
    zbozi_id INTEGER NOT NULL REFERENCES zbozi(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_ean_zbozi ON zbozi_ean(zbozi_id);

CREATE TABLE IF NOT EXISTS prodeje (
    id INTEGER PRIMARY KEY,
    cislo TEXT NOT NULL UNIQUE,
    cas TEXT NOT NULL,                         -- = dat_trzby pro EET, nikdy se nemění
    uzivatel_id INTEGER REFERENCES uzivatele(id),
    typ TEXT NOT NULL DEFAULT 'PRODEJ' CHECK (typ IN ('PRODEJ', 'STORNO')),
    storno_k INTEGER REFERENCES prodeje(id),
    stornovano INTEGER NOT NULL DEFAULT 0,
    platba TEXT NOT NULL CHECK (platba IN ('HOTOVE', 'KARTA')),
    mezisoucet INTEGER NOT NULL,
    zaokrouhleni INTEGER NOT NULL DEFAULT 0,
    celkem INTEGER NOT NULL,
    prijato INTEGER,
    vraceno INTEGER,
    eet_stav TEXT NOT NULL DEFAULT 'VYPNUTO' CHECK (eet_stav IN ('VYPNUTO', 'CEKA', 'OK', 'CHYBA')),
    eet_rezim TEXT,
    eet_eic TEXT,
    eet_jednotka INTEGER,
    eet_pokl TEXT,
    eet_pok TEXT,
    eet_uuid TEXT,
    eet_test INTEGER,
    eet_pokusy INTEGER NOT NULL DEFAULT 0,
    eet_posledni_pokus TEXT,
    eet_chyba TEXT,
    eet_varovani TEXT,
    eet_transaction_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_prodeje_cas ON prodeje(cas);
CREATE INDEX IF NOT EXISTS ix_prodeje_eet ON prodeje(eet_stav);

CREATE TABLE IF NOT EXISTS prodej_polozky (
    id INTEGER PRIMARY KEY,
    prodej_id INTEGER NOT NULL REFERENCES prodeje(id),
    zbozi_id INTEGER REFERENCES zbozi(id),
    nazev TEXT NOT NULL,
    ean TEXT,
    mnozstvi REAL NOT NULL,
    cena INTEGER NOT NULL,                     -- jednotková cena s DPH
    puvodni_cena INTEGER,                      -- katalogová cena, pokud prodavač cenu změnil
    sazba_dph INTEGER NOT NULL,
    celkem INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_polozky_prodej ON prodej_polozky(prodej_id);

CREATE TABLE IF NOT EXISTS prijemky (
    id INTEGER PRIMARY KEY,
    cislo TEXT NOT NULL UNIQUE,
    cas TEXT NOT NULL,
    uzivatel_id INTEGER REFERENCES uzivatele(id),
    dodavatel TEXT,
    doklad TEXT,
    poznamka TEXT,
    celkem_bez_dph INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prijemka_polozky (
    id INTEGER PRIMARY KEY,
    prijemka_id INTEGER NOT NULL REFERENCES prijemky(id),
    zbozi_id INTEGER NOT NULL REFERENCES zbozi(id),
    mnozstvi REAL NOT NULL,
    nakupni_cena INTEGER
);

CREATE TABLE IF NOT EXISTS pohyby (
    id INTEGER PRIMARY KEY,
    cas TEXT NOT NULL,
    zbozi_id INTEGER NOT NULL REFERENCES zbozi(id),
    mnozstvi REAL NOT NULL,
    typ TEXT NOT NULL CHECK (typ IN ('PRIJEM', 'PRODEJ', 'STORNO', 'KOREKCE')),
    doklad TEXT,
    uzivatel_id INTEGER REFERENCES uzivatele(id),
    poznamka TEXT,
    stav_po REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pohyby_zbozi ON pohyby(zbozi_id, cas);

CREATE TABLE IF NOT EXISTS dodavatel_kody (     -- naučené párování: kód dodavatele → naše zboží
    dodavatel TEXT NOT NULL,                     -- "ICO:12345678" nebo "NAZEV:ab computer"
    kod TEXT NOT NULL,
    zbozi_id INTEGER NOT NULL REFERENCES zbozi(id) ON DELETE CASCADE,
    koeficient REAL NOT NULL DEFAULT 1,          -- kolik našich jednotek je v jedné fakturované (balení)
    upraveno TEXT NOT NULL,
    PRIMARY KEY (dodavatel, kod)
);

CREATE TABLE IF NOT EXISTS faktury_soubory (
    id INTEGER PRIMARY KEY,
    nazev TEXT NOT NULL,
    cesta TEXT NOT NULL,
    nahrano TEXT NOT NULL,
    zdroj TEXT,
    dodavatel TEXT,
    doklad TEXT,
    prijemka_id INTEGER REFERENCES prijemky(id)
);

CREATE TABLE IF NOT EXISTS odberatele (
    id INTEGER PRIMARY KEY,
    nazev TEXT NOT NULL,
    ico TEXT,
    dic TEXT,
    ulice TEXT,
    mesto TEXT,
    psc TEXT,
    email TEXT,
    telefon TEXT,
    poznamka TEXT,
    vytvoreno TEXT NOT NULL,
    upraveno TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_odberatele_ico ON odberatele(ico);

CREATE TABLE IF NOT EXISTS faktury_vydane (
    id INTEGER PRIMARY KEY,
    cislo TEXT NOT NULL UNIQUE,
    vs TEXT,
    odberatel_id INTEGER REFERENCES odberatele(id),
    odb_nazev TEXT NOT NULL,                   -- údaje odběratele v okamžiku vystavení
    odb_ico TEXT,
    odb_dic TEXT,
    odb_adresa TEXT,
    odb_email TEXT,
    datum_vystaveni TEXT NOT NULL,
    duzp TEXT NOT NULL,
    splatnost TEXT NOT NULL,
    forma_uhrady TEXT NOT NULL CHECK (forma_uhrady IN ('PREVOD', 'HOTOVE', 'KARTA', 'DOBIRKA')),
    poznamka TEXT,
    celkem INTEGER NOT NULL,                   -- s DPH v haléřích
    stav TEXT NOT NULL DEFAULT 'NEUHRAZENO' CHECK (stav IN ('NEUHRAZENO', 'UHRAZENO', 'STORNO')),
    datum_uhrady TEXT,
    prodej_id INTEGER UNIQUE REFERENCES prodeje(id),   -- placeno na pokladně: účtenka s EET
    uzivatel_id INTEGER REFERENCES uzivatele(id),
    vytvoreno TEXT NOT NULL,
    odeslano TEXT
);
CREATE INDEX IF NOT EXISTS ix_faktury_vydane_stav ON faktury_vydane(stav, splatnost);

CREATE TABLE IF NOT EXISTS faktura_vydana_polozky (
    id INTEGER PRIMARY KEY,
    faktura_id INTEGER NOT NULL REFERENCES faktury_vydane(id),
    zbozi_id INTEGER REFERENCES zbozi(id),
    nazev TEXT NOT NULL,
    mnozstvi REAL NOT NULL,
    jednotka TEXT,
    cena INTEGER NOT NULL,                     -- jednotková cena s DPH
    sazba_dph INTEGER NOT NULL,
    celkem INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fv_polozky ON faktura_vydana_polozky(faktura_id);

CREATE TABLE IF NOT EXISTS citace (
    klic TEXT PRIMARY KEY,
    hodnota INTEGER NOT NULL
);
"""

VYCHOZI_NASTAVENI = {
    "firma_nazev": "PcObchod",
    "firma_ico": "",
    "firma_dic": "",
    "firma_adresa": "",
    "provozovna": "",
    "telefon": "",
    "platce_dph": "1",
    "zaokrouhlovat_hotovost": "1",
    "uctenka_paticka": "Děkujeme za nákup! www.pcobchod.com",
    "eet_rezim": "playground",          # vypnuto | playground | produkce
    "eet_eic": "CZ00000019",
    "eet_id_jednotky": "303",
    "eet_id_pokl": "POKLADNA-1",
    "eet_cert_cesta": str(KOREN / "_zdroje" / "eet2_dokumentace" / "certs_playground" / "CA_EET-Playground-CZ00000019.p12"),
    "eet_cert_heslo": "",
    "eet_timeout_s": "3",
    "vychozi_marze_pct": "40",
    "ai_api_klic": "",                   # Claude API pro čtení PDF faktur bez ISDOC (nepovinné)
    "ai_model": "claude-opus-5-5",
    "zaloha_heslo": "",                  # bez hesla se nezálohuje (záloha obsahuje i heslo k certifikátu)
    "zaloha_cas": "21:30",
    "zaloha_slozka": "",                 # USB disk / NAS připojený jako složka
    "zaloha_rclone_cil": "",             # např. gdrive:Pokladna/Rumburk
    "zaloha_ponechat_lokalne": "14",     # počet záloh na serveru
    "zaloha_ponechat_venku": "60",       # dní
    "zaloha_nazev": "",                  # název prodejny v názvu souboru zálohy
    "faktura_rada": "FV",
    "faktura_ucet": "",                  # např. 123456789/0800 – pro fakturu a QR platbu
    "faktura_splatnost_dni": "14",
    "faktura_pata": "",                  # např. zápis v obchodním rejstříku
    "smtp_server": "",
    "smtp_port": "587",
    "smtp_zabezpeceni": "STARTTLS",      # STARTTLS | SSL | ZADNE
    "smtp_uzivatel": "",
    "smtp_heslo": "",
    "smtp_odesilatel": "",
    "uzaverka_prijemci": "",             # e-maily oddělené čárkou
    "uzaverka_auto_cas": "",             # HH:MM = automaticky každý den, prázdné = jen ručně
}

# Sloupce přidané po prvním nasazení: (tabulka, sloupec, definice)
DOPLNENE_SLOUPCE = [
    ("prijemky", "dodavatel_ico", "TEXT"),
    ("prijemky", "soubor_id", "INTEGER REFERENCES faktury_soubory(id)"),
]


def ted() -> str:
    """Aktuální čas v Praze ve tvaru, který bere EET (2026-10-25T20:01:02+01:00)."""
    return datetime.now(PRAHA).replace(microsecond=0).isoformat()


def bez_diakritiky(s: Optional[str]) -> Optional[str]:
    """Pro hledání: „Myš“ → „mys“."""
    if s is None:
        return None
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()


def pripoj() -> sqlite3.Connection:
    DB_CESTA.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_CESTA, timeout=10, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.create_function("norm", 1, bez_diakritiky, deterministic=True)
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 10000")
    return con


@contextmanager
def spojeni() -> Iterator[sqlite3.Connection]:
    con = pripoj()
    try:
        yield con
    finally:
        con.close()


@contextmanager
def transakce(con: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def inicializuj() -> None:
    with spojeni() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(SCHEMA)
        for tabulka, sloupec, definice in DOPLNENE_SLOUPCE:
            if sloupec not in [r[1] for r in con.execute(f"PRAGMA table_info({tabulka})")]:
                con.execute(f"ALTER TABLE {tabulka} ADD COLUMN {sloupec} {definice}")
        for k, v in VYCHOZI_NASTAVENI.items():
            con.execute("INSERT OR IGNORE INTO nastaveni (klic, hodnota) VALUES (?, ?)", (k, v))
        # Heslo testovacího certifikátu je veřejné (součást balíčku finanční správy).
        if not nastaveni(con).get("eet_cert_heslo"):
            soubor = KOREN / "_zdroje" / "eet2_dokumentace" / "certs_playground" / "password_pokladni_cert_playground.txt"
            if soubor.exists():
                con.execute("UPDATE nastaveni SET hodnota = ? WHERE klic = 'eet_cert_heslo'",
                            (soubor.read_text().strip(),))


def nastaveni(con: sqlite3.Connection) -> dict:
    return {r["klic"]: r["hodnota"] for r in con.execute("SELECT klic, hodnota FROM nastaveni")}


def dalsi_cislo(con: sqlite3.Connection, rada: str) -> int:
    con.execute("INSERT OR IGNORE INTO citace (klic, hodnota) VALUES (?, 0)", (rada,))
    con.execute("UPDATE citace SET hodnota = hodnota + 1 WHERE klic = ?", (rada,))
    return con.execute("SELECT hodnota FROM citace WHERE klic = ?", (rada,)).fetchone()[0]


def hash_pin(pin: str, sul: Optional[str] = None) -> str:
    sul = sul or secrets.token_hex(8)
    h = hashlib.pbkdf2_hmac("sha256", pin.encode(), sul.encode(), 100_000).hex()
    return f"{sul}${h}"


def over_pin(pin: str, ulozeny: str) -> bool:
    sul, _ = ulozeny.split("$", 1)
    return secrets.compare_digest(hash_pin(pin, sul), ulozeny)


def pohyb(con: sqlite3.Connection, zbozi_id: int, mnozstvi: float, typ: str, doklad: str,
          uzivatel_id: Optional[int], poznamka: Optional[str] = None) -> float:
    """Zapíše skladový pohyb a vrátí nový stav. Volat uvnitř transakce."""
    con.execute("UPDATE zbozi SET stav = round(stav + ?, 3), upraveno = ? WHERE id = ?",
                (mnozstvi, ted(), zbozi_id))
    stav = con.execute("SELECT stav FROM zbozi WHERE id = ?", (zbozi_id,)).fetchone()[0]
    con.execute(
        "INSERT INTO pohyby (cas, zbozi_id, mnozstvi, typ, doklad, uzivatel_id, poznamka, stav_po) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (ted(), zbozi_id, mnozstvi, typ, doklad, uzivatel_id, poznamka, stav),
    )
    return stav
