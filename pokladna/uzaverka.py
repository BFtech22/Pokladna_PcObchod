"""Souhrny tržeb: denní uzávěrka a měsíční přehled po dnech (pro obrazovku, e-mail i Excel)."""

from __future__ import annotations

import calendar
import sqlite3
from datetime import date


def _dph(con: sqlite3.Connection, vzor: str) -> list:
    rows = [dict(r) for r in con.execute(
        "SELECT i.sazba_dph, SUM(i.celkem) AS celkem FROM prodej_polozky i JOIN prodeje p ON p.id = i.prodej_id "
        "WHERE p.cas LIKE ? GROUP BY i.sazba_dph ORDER BY i.sazba_dph DESC", (vzor,))]
    for r in rows:
        zaklad = int(round(r["celkem"] / (1 + r["sazba_dph"] / 100)))
        r["zaklad"], r["dph"] = zaklad, r["celkem"] - zaklad
    return rows


def souhrn(con: sqlite3.Connection, datum: str) -> dict:
    vzor = f"{datum}%"
    platby = {r["platba"]: dict(r) for r in con.execute(
        "SELECT platba, COUNT(*) AS pocet, SUM(celkem) AS celkem FROM prodeje WHERE cas LIKE ? GROUP BY platba", (vzor,))}
    typy = {r["typ"]: dict(r) for r in con.execute(
        "SELECT typ, COUNT(*) AS pocet, SUM(celkem) AS celkem FROM prodeje WHERE cas LIKE ? GROUP BY typ", (vzor,))}
    zaokr = con.execute("SELECT COALESCE(SUM(zaokrouhleni), 0) FROM prodeje WHERE cas LIKE ?", (vzor,)).fetchone()[0]
    eet = {r[0]: r[1] for r in con.execute("SELECT eet_stav, COUNT(*) FROM prodeje WHERE cas LIKE ? GROUP BY eet_stav", (vzor,))}
    prodavaci = [dict(r) for r in con.execute(
        "SELECT u.jmeno, COUNT(*) AS pocet, SUM(p.celkem) AS celkem FROM prodeje p "
        "LEFT JOIN uzivatele u ON u.id = p.uzivatel_id WHERE p.cas LIKE ? GROUP BY p.uzivatel_id", (vzor,))]
    faktury = [dict(r) for r in con.execute(
        "SELECT forma_uhrady, COUNT(*) AS pocet, SUM(celkem) AS celkem FROM faktury_vydane "
        "WHERE datum_vystaveni = ? AND stav != 'STORNO' AND typ = 'FAKTURA' GROUP BY forma_uhrady", (datum,))]
    return {"datum": datum, "platby": platby, "typy": typy, "dph": _dph(con, vzor), "zaokrouhleni": zaokr,
            "eet": eet, "prodavaci": prodavaci, "faktury": faktury,
            "celkem": sum((v["celkem"] or 0) for v in platby.values())}


def uctenky(con: sqlite3.Connection, datum: str) -> list:
    return [dict(r) for r in con.execute(
        "SELECT p.cas, p.cislo, p.typ, p.platba, p.celkem, p.eet_stav, u.jmeno AS prodavac FROM prodeje p "
        "LEFT JOIN uzivatele u ON u.id = p.uzivatel_id WHERE p.cas LIKE ? ORDER BY p.id", (f"{datum}%",))]


def prodane_zbozi(con: sqlite3.Connection, datum: str) -> list:
    return [dict(r) for r in con.execute(
        "SELECT i.nazev, i.ean, SUM(i.mnozstvi) AS mnozstvi, SUM(i.celkem) AS celkem FROM prodej_polozky i "
        "JOIN prodeje p ON p.id = i.prodej_id WHERE p.cas LIKE ? GROUP BY i.nazev, i.ean "
        "HAVING SUM(i.mnozstvi) != 0 ORDER BY celkem DESC",
        (f"{datum}%",))]


def mesic(con: sqlite3.Connection, datum: str) -> list:
    """Řádek za každý den měsíce do `datum` včetně (jako dnešní měsíční reporty prodejen)."""
    d = date.fromisoformat(datum)
    dny = []
    for den in range(1, min(d.day, calendar.monthrange(d.year, d.month)[1]) + 1):
        iso = date(d.year, d.month, den).isoformat()
        s = souhrn(con, iso)
        dph = {r["sazba_dph"]: r for r in s["dph"]}
        dny.append({
            "datum": iso,
            "uctenek": (s["typy"].get("PRODEJ") or {}).get("pocet", 0),
            "storen": (s["typy"].get("STORNO") or {}).get("pocet", 0),
            "hotove": (s["platby"].get("HOTOVE") or {}).get("celkem") or 0,
            "kartou": (s["platby"].get("KARTA") or {}).get("celkem") or 0,
            "celkem": s["celkem"],
            "zaklad21": (dph.get(21) or {}).get("zaklad", 0), "dph21": (dph.get(21) or {}).get("dph", 0),
            "zaklad12": (dph.get(12) or {}).get("zaklad", 0), "dph12": (dph.get(12) or {}).get("dph", 0),
            "zaklad0": (dph.get(0) or {}).get("zaklad", 0),
            "faktury_prevodem": sum(f["celkem"] or 0 for f in s["faktury"] if f["forma_uhrady"] in ("PREVOD", "DOBIRKA")),
        })
    return dny
