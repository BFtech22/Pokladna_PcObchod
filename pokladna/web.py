"""Společné závislosti API: připojení k databázi a přihlášený uživatel."""

from __future__ import annotations

import sqlite3

from fastapi import Depends, HTTPException, Request

from . import db

COOKIE = "pokladna_relace"


def con_dep():
    con = db.pripoj()
    try:
        yield con
    finally:
        con.close()


def uzivatel(request: Request, con: sqlite3.Connection = Depends(con_dep)) -> sqlite3.Row:
    token = request.cookies.get(COOKIE)
    u = None
    if token:
        u = con.execute(
            "SELECT u.* FROM relace r JOIN uzivatele u ON u.id = r.uzivatel_id "
            "WHERE r.token = ? AND u.aktivni = 1", (token,)).fetchone()
    if u is None:
        raise HTTPException(401, "Nepřihlášen")
    return u


def spravce(u: sqlite3.Row = Depends(uzivatel)) -> sqlite3.Row:
    if u["role"] != "SPRAVCE":
        raise HTTPException(403, "Jen pro správce")
    return u
