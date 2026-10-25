"""Webový server pokladny: JSON API + statické rozhraní. Částky v API jsou v haléřích."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta

from pathlib import Path
from typing import List, Optional

import requests
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, fakturace, faktury, posta, zaloha
from . import uzaverka as uzaverky
from .eet_fronta import sluzba as eet
from .eet_klient import PRAHA, PokladniCertifikat

log = logging.getLogger("pokladna")
STATIC = Path(__file__).resolve().parent / "static"
COOKIE = "pokladna_relace"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.inicializuj()
    eet.spust()
    eet.probud()
    zaloha.planovac.spust()
    posta.planovac.spust()
    yield
    posta.planovac.zastav()
    zaloha.planovac.zastav()
    eet.zastav()


app = FastAPI(title="Pokladna PcObchod", lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# --------------------------------------------------------------------------- pomocné

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


def zaokrouhli_kc(halere: int) -> int:
    """Zaokrouhlení na celé koruny (matematicky, symetricky pro záporné částky)."""
    znam = -1 if halere < 0 else 1
    return znam * ((abs(halere) + 50) // 100 * 100)


def zbozi_dict(con: sqlite3.Connection, r: sqlite3.Row) -> dict:
    d = dict(r)
    d["eany"] = [x[0] for x in con.execute("SELECT ean FROM zbozi_ean WHERE zbozi_id = ? ORDER BY rowid", (r["id"],))]
    return d


def prodej_dict(con: sqlite3.Connection, pid: int) -> dict:
    p = con.execute(
        "SELECT p.*, u.jmeno AS prodavac FROM prodeje p LEFT JOIN uzivatele u ON u.id = p.uzivatel_id "
        "WHERE p.id = ?", (pid,)).fetchone()
    if p is None:
        raise HTTPException(404, "Účtenka nenalezena")
    d = dict(p)
    d["polozky"] = [dict(x) for x in con.execute(
        "SELECT * FROM prodej_polozky WHERE prodej_id = ? ORDER BY id", (pid,))]
    d["eet_varovani"] = json.loads(p["eet_varovani"]) if p["eet_varovani"] else []
    fv = con.execute("SELECT id, cislo FROM faktury_vydane WHERE prodej_id = ?", (pid,)).fetchone()
    d["faktura"] = dict(fv) if fv else None
    return d


# --------------------------------------------------------------------------- přihlášení

class PrvniSpravce(BaseModel):
    jmeno: str = Field(min_length=1, max_length=60)
    pin: str = Field(min_length=4, max_length=12, pattern=r"^\d+$")


class Prihlaseni(BaseModel):
    pin: str


@app.get("/api/stav")
def stav(request: Request, con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    pocet = con.execute("SELECT COUNT(*) FROM uzivatele").fetchone()[0]
    u = None
    try:
        u = uzivatel(request, con)
    except HTTPException:
        pass
    return {
        "potreba_nastaveni": pocet == 0,
        "uzivatel": {"id": u["id"], "jmeno": u["jmeno"], "role": u["role"]} if u else None,
        "firma": {k: nast.get(k) for k in ("firma_nazev", "firma_ico", "firma_dic", "firma_adresa",
                                          "provozovna", "telefon", "platce_dph", "zaokrouhlovat_hotovost",
                                          "uctenka_paticka", "faktura_ucet", "faktura_pata", "faktura_splatnost_dni")},
        "eet_rezim": nast.get("eet_rezim"),
    }


def _prihlas(response: Response, con: sqlite3.Connection, uid: int) -> None:
    token = secrets.token_urlsafe(32)
    con.execute("INSERT INTO relace (token, uzivatel_id, vytvoreno) VALUES (?, ?, ?)", (token, uid, db.ted()))
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", max_age=60 * 60 * 24 * 30)


@app.post("/api/prvni-spravce")
def prvni_spravce(data: PrvniSpravce, response: Response, con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        if con.execute("SELECT COUNT(*) FROM uzivatele").fetchone()[0]:
            raise HTTPException(409, "Správce už existuje")
        uid = con.execute("INSERT INTO uzivatele (jmeno, pin_hash, role, vytvoreno) VALUES (?, ?, 'SPRAVCE', ?)",
                          (data.jmeno.strip(), db.hash_pin(data.pin), db.ted())).lastrowid
        _prihlas(response, con, uid)
    return {"ok": True}


@app.post("/api/prihlaseni")
def prihlaseni(data: Prihlaseni, response: Response, con: sqlite3.Connection = Depends(con_dep)):
    for u in con.execute("SELECT * FROM uzivatele WHERE aktivni = 1"):
        if db.over_pin(data.pin, u["pin_hash"]):
            _prihlas(response, con, u["id"])
            return {"ok": True, "jmeno": u["jmeno"], "role": u["role"]}
    raise HTTPException(401, "Neplatný PIN")


@app.post("/api/odhlaseni")
def odhlaseni(request: Request, response: Response, con: sqlite3.Connection = Depends(con_dep)):
    token = request.cookies.get(COOKIE)
    if token:
        con.execute("DELETE FROM relace WHERE token = ?", (token,))
    response.delete_cookie(COOKIE)
    return {"ok": True}


# --------------------------------------------------------------------------- zboží

class ZboziVstup(BaseModel):
    nazev: str = Field(min_length=1, max_length=200)
    kod: Optional[str] = None
    kategorie: Optional[str] = None
    cena: int = Field(ge=0)
    sazba_dph: int = 21
    nakupni_cena: Optional[int] = Field(default=None, ge=0)
    jednotka: str = "ks"
    min_stav: float = 0
    aktivni: bool = True
    poznamka: Optional[str] = None
    eany: List[str] = []
    pocatecni_stav: Optional[float] = None


def _uloz_eany(con: sqlite3.Connection, zid: int, eany: List[str]) -> None:
    cisty = []
    for e in eany:
        e = e.strip()
        if e and e not in cisty:
            cisty.append(e)
    for e in cisty:
        jiny = con.execute("SELECT z.id, z.nazev FROM zbozi_ean x JOIN zbozi z ON z.id = x.zbozi_id "
                           "WHERE x.ean = ? AND x.zbozi_id != ?", (e, zid)).fetchone()
        if jiny:
            raise HTTPException(409, f"EAN {e} už má zboží „{jiny['nazev']}“")
    con.execute("DELETE FROM zbozi_ean WHERE zbozi_id = ?", (zid,))
    for e in cisty:
        con.execute("INSERT INTO zbozi_ean (ean, zbozi_id) VALUES (?, ?)", (e, zid))


@app.get("/api/zbozi")
def seznam_zbozi(q: str = "", vse: bool = False, filtr: str = "", limit: int = 100,
                 u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    sql = "SELECT * FROM zbozi WHERE 1=1"
    par: list = []
    if not vse:
        sql += " AND aktivni = 1"
    if filtr == "dochazi":
        sql += " AND stav <= min_stav"
    elif filtr == "zaporne":
        sql += " AND stav < 0"
    q = q.strip()
    if q:
        # Každé slovo musí být v názvu nebo kategorii, bez ohledu na diakritiku a pořadí („kabel usb c“).
        slova = db.bez_diakritiky(q).split()
        podminka = " AND ".join("(norm(nazev) LIKE ? OR norm(kategorie) LIKE ?)" for _ in slova)
        sql += f" AND (id IN (SELECT zbozi_id FROM zbozi_ean WHERE ean = ?) OR kod = ? OR ({podminka}))"
        par += [q, q] + [x for s in slova for x in (f"%{s}%", f"%{s}%")]
    sql += " ORDER BY nazev COLLATE NOCASE LIMIT ?"
    par.append(min(max(limit, 1), 1000))
    return [zbozi_dict(con, r) for r in con.execute(sql, par)]


@app.get("/api/zbozi/kod/{kod}")
def zbozi_podle_kodu(kod: str, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    r = con.execute("SELECT z.* FROM zbozi z JOIN zbozi_ean e ON e.zbozi_id = z.id WHERE e.ean = ?",
                    (kod.strip(),)).fetchone()
    if r is None:
        r = con.execute("SELECT * FROM zbozi WHERE kod = ?", (kod.strip(),)).fetchone()
    if r is None:
        raise HTTPException(404, "Kód nenalezen")
    return zbozi_dict(con, r)


@app.get("/api/zbozi/{zid}")
def detail_zbozi(zid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    r = con.execute("SELECT * FROM zbozi WHERE id = ?", (zid,)).fetchone()
    if r is None:
        raise HTTPException(404, "Zboží nenalezeno")
    d = zbozi_dict(con, r)
    d["pohyby"] = [dict(x) for x in con.execute(
        "SELECT p.*, u.jmeno AS uzivatel FROM pohyby p LEFT JOIN uzivatele u ON u.id = p.uzivatel_id "
        "WHERE zbozi_id = ? ORDER BY p.id DESC LIMIT 100", (zid,))]
    return d


@app.post("/api/zbozi")
def nove_zbozi(data: ZboziVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        try:
            zid = con.execute(
                "INSERT INTO zbozi (nazev, kod, kategorie, cena, sazba_dph, nakupni_cena, jednotka, min_stav, "
                "aktivni, poznamka, vytvoreno, upraveno) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (data.nazev.strip(), (data.kod or "").strip() or None, data.kategorie, data.cena, data.sazba_dph,
                 data.nakupni_cena, data.jednotka, data.min_stav, int(data.aktivni), data.poznamka,
                 db.ted(), db.ted())).lastrowid
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"Kód {data.kod} už existuje")
        _uloz_eany(con, zid, data.eany)
        if data.pocatecni_stav:
            db.pohyb(con, zid, data.pocatecni_stav, "KOREKCE", "založení", u["id"], "počáteční stav")
    return zbozi_dict(con, con.execute("SELECT * FROM zbozi WHERE id = ?", (zid,)).fetchone())


@app.put("/api/zbozi/{zid}")
def uprav_zbozi(zid: int, data: ZboziVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        try:
            n = con.execute(
                "UPDATE zbozi SET nazev=?, kod=?, kategorie=?, cena=?, sazba_dph=?, nakupni_cena=?, jednotka=?, "
                "min_stav=?, aktivni=?, poznamka=?, upraveno=? WHERE id=?",
                (data.nazev.strip(), (data.kod or "").strip() or None, data.kategorie, data.cena, data.sazba_dph,
                 data.nakupni_cena, data.jednotka, data.min_stav, int(data.aktivni), data.poznamka,
                 db.ted(), zid)).rowcount
        except sqlite3.IntegrityError:
            raise HTTPException(409, f"Kód {data.kod} už existuje")
        if not n:
            raise HTTPException(404, "Zboží nenalezeno")
        _uloz_eany(con, zid, data.eany)
    return zbozi_dict(con, con.execute("SELECT * FROM zbozi WHERE id = ?", (zid,)).fetchone())


# --------------------------------------------------------------------------- prodej

class PolozkaProdeje(BaseModel):
    zbozi_id: Optional[int] = None
    nazev: Optional[str] = None          # pro položku mimo katalog (služba, práce)
    mnozstvi: float = Field(ge=-99999, le=99999)
    cena: Optional[int] = None           # jednotková cena s DPH; když chybí, bere se z katalogu
    sazba_dph: Optional[int] = None


class ProdejVstup(BaseModel):
    polozky: List[PolozkaProdeje] = Field(min_length=1)
    platba: str = Field(pattern="^(HOTOVE|KARTA)$")
    prijato: Optional[int] = None


def _radky_dokladu(con: sqlite3.Connection, polozky: List[PolozkaProdeje]) -> list:
    """Řádky prodejky nebo faktury s cenami z katalogu (případně ručně změněnými)."""
    radky = []
    for pol in polozky:
        if pol.mnozstvi == 0:
            continue
        if pol.zbozi_id is not None:
            z = con.execute("SELECT * FROM zbozi WHERE id = ?", (pol.zbozi_id,)).fetchone()
            if z is None:
                raise HTTPException(400, f"Zboží {pol.zbozi_id} neexistuje")
            ean = con.execute("SELECT ean FROM zbozi_ean WHERE zbozi_id = ? ORDER BY rowid LIMIT 1",
                              (z["id"],)).fetchone()
            cena = z["cena"] if pol.cena is None else pol.cena
            radky.append(dict(zbozi_id=z["id"], nazev=z["nazev"], ean=ean[0] if ean else None,
                              mnozstvi=round(pol.mnozstvi, 3), cena=cena, jednotka=z["jednotka"],
                              puvodni_cena=z["cena"] if cena != z["cena"] else None,
                              sazba_dph=z["sazba_dph"]))
        else:
            if not (pol.nazev and pol.cena is not None):
                raise HTTPException(400, "Položka mimo katalog potřebuje název a cenu")
            radky.append(dict(zbozi_id=None, nazev=pol.nazev.strip(), ean=None, jednotka="ks",
                              mnozstvi=round(pol.mnozstvi, 3), cena=pol.cena, puvodni_cena=None,
                              sazba_dph=21 if pol.sazba_dph is None else pol.sazba_dph))
    if not radky:
        raise HTTPException(400, "Prázdný nákup")
    for r in radky:
        r["celkem"] = int(round(r["cena"] * r["mnozstvi"]))
    return radky


def _vloz_prodej(con: sqlite3.Connection, platba: str, prijato: Optional[int], radky: list, u, nast: dict) -> tuple:
    """Zapíše prodejku a výdej ze skladu (volat v transakci). Vrátí (id, stav EET)."""
    mezisoucet = sum(r["celkem"] for r in radky)
    celkem = mezisoucet
    if platba == "HOTOVE" and nast.get("zaokrouhlovat_hotovost") == "1":
        celkem = zaokrouhli_kc(mezisoucet)
    vraceno = None
    if platba == "HOTOVE":
        prijato = prijato if prijato is not None else max(celkem, 0)
        if celkem > 0 and prijato < celkem:
            raise HTTPException(400, "Přijatá hotovost je nižší než částka k úhradě")
        vraceno = prijato - celkem
    else:
        prijato = None

    cas = db.ted()
    rok = cas[:4]
    cislo = f"{rok}-{db.dalsi_cislo(con, 'prodej-' + rok):06d}"
    rezim = nast.get("eet_rezim") or "vypnuto"
    eet_stav = "VYPNUTO" if rezim == "vypnuto" else "CEKA"
    pid = con.execute(
        "INSERT INTO prodeje (cislo, cas, uzivatel_id, typ, platba, mezisoucet, zaokrouhleni, celkem, prijato, "
        "vraceno, eet_stav, eet_rezim, eet_eic, eet_jednotka, eet_pokl) "
        "VALUES (?, ?, ?, 'PRODEJ', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (cislo, cas, u["id"], platba, mezisoucet, celkem - mezisoucet, celkem, prijato, vraceno,
         eet_stav, rezim, nast.get("eet_eic"), int(nast.get("eet_id_jednotky") or 0) or None,
         nast.get("eet_id_pokl"))).lastrowid
    for r in radky:
        con.execute(
            "INSERT INTO prodej_polozky (prodej_id, zbozi_id, nazev, ean, mnozstvi, cena, puvodni_cena, "
            "sazba_dph, celkem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (pid, r["zbozi_id"], r["nazev"], r["ean"], r["mnozstvi"], r["cena"], r["puvodni_cena"],
             r["sazba_dph"], r["celkem"]))
        if r["zbozi_id"] is not None:
            db.pohyb(con, r["zbozi_id"], -r["mnozstvi"], "PRODEJ", cislo, u["id"])
    return pid, eet_stav


@app.post("/api/prodeje")
def novy_prodej(data: ProdejVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    with db.transakce(con):
        pid, eet_stav = _vloz_prodej(con, data.platba, data.prijato, _radky_dokladu(con, data.polozky), u, nast)
    if eet_stav == "CEKA":
        eet.odesli_prodej(pid)      # pokus hned při prodeji, při neúspěchu převezme fronta
    return prodej_dict(con, pid)


@app.get("/api/prodeje")
def seznam_prodeju(datum: Optional[str] = None, eet_stav: Optional[str] = None, limit: int = 200,
                   u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    sql = ("SELECT p.*, u.jmeno AS prodavac, (SELECT COUNT(*) FROM prodej_polozky WHERE prodej_id = p.id) AS pocet "
           "FROM prodeje p LEFT JOIN uzivatele u ON u.id = p.uzivatel_id WHERE 1=1")
    par: list = []
    if datum:
        sql += " AND p.cas LIKE ?"
        par.append(f"{datum}%")
    if eet_stav:
        sql += " AND p.eet_stav = ?"
        par.append(eet_stav)
    sql += " ORDER BY p.id DESC LIMIT ?"
    par.append(min(max(limit, 1), 2000))
    return [dict(r) for r in con.execute(sql, par)]


@app.get("/api/prodeje/{pid}")
def detail_prodeje(pid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    return prodej_dict(con, pid)


@app.post("/api/prodeje/{pid}/storno")
def storno(pid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    with db.transakce(con):
        p = con.execute("SELECT * FROM prodeje WHERE id = ?", (pid,)).fetchone()
        if p is None:
            raise HTTPException(404, "Účtenka nenalezena")
        if p["typ"] != "PRODEJ" or p["stornovano"]:
            raise HTTPException(409, "Účtenku nejde stornovat")
        cas = db.ted()
        rok = cas[:4]
        cislo = f"{rok}-{db.dalsi_cislo(con, 'prodej-' + rok):06d}"
        rezim = nast.get("eet_rezim") or "vypnuto"
        eet_stav = "VYPNUTO" if rezim == "vypnuto" else "CEKA"
        sid = con.execute(
            "INSERT INTO prodeje (cislo, cas, uzivatel_id, typ, storno_k, platba, mezisoucet, zaokrouhleni, celkem, "
            "prijato, vraceno, eet_stav, eet_rezim, eet_eic, eet_jednotka, eet_pokl) "
            "VALUES (?, ?, ?, 'STORNO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cislo, cas, u["id"], pid, p["platba"], -p["mezisoucet"], -p["zaokrouhleni"], -p["celkem"],
             0 if p["platba"] == "HOTOVE" else None, p["celkem"] if p["platba"] == "HOTOVE" else None,
             eet_stav, rezim, nast.get("eet_eic"), int(nast.get("eet_id_jednotky") or 0) or None,
             nast.get("eet_id_pokl"))).lastrowid
        for r in con.execute("SELECT * FROM prodej_polozky WHERE prodej_id = ?", (pid,)).fetchall():
            con.execute(
                "INSERT INTO prodej_polozky (prodej_id, zbozi_id, nazev, ean, mnozstvi, cena, puvodni_cena, sazba_dph, "
                "celkem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, r["zbozi_id"], r["nazev"], r["ean"], -r["mnozstvi"], r["cena"], r["puvodni_cena"],
                 r["sazba_dph"], -r["celkem"]))
            if r["zbozi_id"] is not None:
                db.pohyb(con, r["zbozi_id"], r["mnozstvi"], "STORNO", cislo, u["id"], f"storno {p['cislo']}")
        con.execute("UPDATE prodeje SET stornovano = 1 WHERE id = ?", (pid,))
    if eet_stav == "CEKA":
        eet.odesli_prodej(sid)
    return prodej_dict(con, sid)


@app.post("/api/prodeje/{pid}/eet")
def znovu_eet(pid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    con.execute("UPDATE prodeje SET eet_stav = 'CEKA' WHERE id = ? AND eet_stav = 'CHYBA'", (pid,))
    eet.odesli_prodej(pid, timeout=10)
    return prodej_dict(con, pid)


@app.get("/api/eet/fronta")
def eet_fronta(u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    r = con.execute(
        "SELECT SUM(eet_stav = 'CEKA') AS ceka, SUM(eet_stav = 'CHYBA') AS chyba, "
        "MIN(CASE WHEN eet_stav IN ('CEKA', 'CHYBA') THEN cas END) AS nejstarsi FROM prodeje").fetchone()
    return {"ceka": r["ceka"] or 0, "chyba": r["chyba"] or 0, "nejstarsi": r["nejstarsi"]}


@app.post("/api/eet/test")
def eet_test(u=Depends(spravce)):
    try:
        return eet.test_spojeni()
    except Exception as e:
        return {"ok": False, "text": f"{type(e).__name__}: {e}"}


# --------------------------------------------------------------------------- sklad

class PolozkaPrijemky(BaseModel):
    zbozi_id: int
    mnozstvi: float = Field(gt=0, le=99999)
    nakupni_cena: Optional[int] = Field(default=None, ge=0)   # bez DPH za jednotku
    kod_dodavatele: Optional[str] = None                      # z faktury – uloží se naučené párování
    ean_z_faktury: Optional[str] = None                       # z faktury – doplní se ke zboží, když ho nemá
    koeficient: float = Field(default=1, gt=0)
    prodejni_cena: Optional[int] = Field(default=None, ge=0)  # nová prodejní cena s DPH, když se při příjmu mění


class PrijemkaVstup(BaseModel):
    dodavatel: Optional[str] = None
    dodavatel_ico: Optional[str] = None
    doklad: Optional[str] = None
    poznamka: Optional[str] = None
    soubor_id: Optional[int] = None
    polozky: List[PolozkaPrijemky] = Field(min_length=1)


@app.post("/api/prijemky")
def nova_prijemka(data: PrijemkaVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    dod = faktury.klic_dodavatele(data.dodavatel_ico, data.dodavatel)
    with db.transakce(con):
        cas = db.ted()
        rok = cas[:4]
        cislo = f"P{rok}-{db.dalsi_cislo(con, 'prijemka-' + rok):05d}"
        celkem = sum(int(round((p.nakupni_cena or 0) * p.mnozstvi)) for p in data.polozky)
        prid = con.execute(
            "INSERT INTO prijemky (cislo, cas, uzivatel_id, dodavatel, dodavatel_ico, doklad, poznamka, celkem_bez_dph, soubor_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cislo, cas, u["id"], data.dodavatel, data.dodavatel_ico, data.doklad, data.poznamka, celkem,
             data.soubor_id)).lastrowid
        for p in data.polozky:
            if not con.execute("SELECT 1 FROM zbozi WHERE id = ?", (p.zbozi_id,)).fetchone():
                raise HTTPException(400, f"Zboží {p.zbozi_id} neexistuje")
            con.execute("INSERT INTO prijemka_polozky (prijemka_id, zbozi_id, mnozstvi, nakupni_cena) VALUES (?,?,?,?)",
                        (prid, p.zbozi_id, p.mnozstvi, p.nakupni_cena))
            db.pohyb(con, p.zbozi_id, p.mnozstvi, "PRIJEM", cislo, u["id"], data.doklad)
            if p.nakupni_cena is not None:
                con.execute("UPDATE zbozi SET nakupni_cena = ? WHERE id = ?", (p.nakupni_cena, p.zbozi_id))
            if p.prodejni_cena is not None:
                con.execute("UPDATE zbozi SET cena = ?, upraveno = ? WHERE id = ?", (p.prodejni_cena, cas, p.zbozi_id))
            if p.kod_dodavatele and dod:
                con.execute(
                    "INSERT INTO dodavatel_kody (dodavatel, kod, zbozi_id, koeficient, upraveno) VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(dodavatel, kod) DO UPDATE SET zbozi_id = excluded.zbozi_id, "
                    "koeficient = excluded.koeficient, upraveno = excluded.upraveno",
                    (dod, p.kod_dodavatele.strip(), p.zbozi_id, p.koeficient, cas))
            if p.ean_z_faktury and faktury.platny_ean(p.ean_z_faktury):
                con.execute("INSERT OR IGNORE INTO zbozi_ean (ean, zbozi_id) VALUES (?, ?)", (p.ean_z_faktury, p.zbozi_id))
        if data.soubor_id:
            con.execute("UPDATE faktury_soubory SET prijemka_id = ? WHERE id = ?", (prid, data.soubor_id))
    return {"id": prid, "cislo": cislo, "celkem_bez_dph": celkem}


# --------------------------------------------------------------------------- faktury

FAKTURY_DIR = db.DB_CESTA.parent / "faktury"
MAX_FAKTURA = 25 * 1024 * 1024


class FakturaVstup(BaseModel):
    nazev: str = Field(min_length=1, max_length=255)
    data: str                                   # obsah souboru v base64


@app.post("/api/faktury/nacti")
def nacti_fakturu(vstup: FakturaVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    try:
        obsah = base64.b64decode(vstup.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "Soubor se nepodařilo přenést")
    if len(obsah) > MAX_FAKTURA:
        raise HTTPException(413, "Soubor je větší než 25 MB")
    try:
        f = faktury.nacti(vstup.nazev, obsah, db.nastaveni(con))
    except faktury.ChybaFaktury as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("Faktura %s", vstup.nazev)
        raise HTTPException(400, f"Fakturu se nepodařilo přečíst ({type(e).__name__})")

    FAKTURY_DIR.mkdir(parents=True, exist_ok=True)
    bezpecny = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(vstup.nazev).name)[-80:]
    cesta = FAKTURY_DIR / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}_{secrets.token_hex(3)}_{bezpecny}"
    cesta.write_bytes(obsah)
    soubor_id = con.execute(
        "INSERT INTO faktury_soubory (nazev, cesta, nahrano, zdroj, dodavatel, doklad) VALUES (?, ?, ?, ?, ?, ?)",
        (vstup.nazev, str(cesta), db.ted(), f.zdroj, f.dodavatel, f.cislo)).lastrowid

    duplicita = None
    if f.cislo:
        r = con.execute(
            "SELECT cislo, cas FROM prijemky WHERE doklad = ? AND (dodavatel_ico = ? OR (? IS NULL AND dodavatel = ?)) "
            "ORDER BY id DESC LIMIT 1", (f.cislo, f.dodavatel_ico, f.dodavatel_ico, f.dodavatel)).fetchone()
        if r:
            duplicita = dict(r)
    vysledek = f.dict()
    vysledek["polozky"] = faktury.sparuj(con, f)
    return {"soubor_id": soubor_id, "faktura": vysledek, "duplicita": duplicita,
            "marze_pct": float(db.nastaveni(con).get("vychozi_marze_pct") or 40)}


@app.get("/api/faktury/{fid}/soubor")
def soubor_faktury(fid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    r = con.execute("SELECT nazev, cesta FROM faktury_soubory WHERE id = ?", (fid,)).fetchone()
    if r is None or not Path(r["cesta"]).is_file():
        raise HTTPException(404, "Soubor faktury nenalezen")
    return FileResponse(r["cesta"], filename=r["nazev"])


@app.get("/api/prijemky")
def seznam_prijemek(u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    return [dict(r) for r in con.execute(
        "SELECT p.*, u.jmeno AS uzivatel, (SELECT COUNT(*) FROM prijemka_polozky WHERE prijemka_id = p.id) AS pocet "
        "FROM prijemky p LEFT JOIN uzivatele u ON u.id = p.uzivatel_id ORDER BY p.id DESC LIMIT 200")]


DUVODY_VYDEJE = {"ODPIS": "odpis", "SPOTREBA": "vlastní spotřeba", "VRACENI": "vrácení dodavateli", "MANKO": "manko", "JINE": "jiný výdej"}


class PolozkaVydejky(BaseModel):
    zbozi_id: int
    mnozstvi: float = Field(gt=0, le=99999)


class VydejkaVstup(BaseModel):
    duvod: str = Field(pattern="^(ODPIS|SPOTREBA|VRACENI|MANKO|JINE)$")
    komu: Optional[str] = None
    poznamka: Optional[str] = None
    polozky: List[PolozkaVydejky] = Field(min_length=1)


@app.post("/api/vydejky")
def nova_vydejka(data: VydejkaVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        cas = db.ted()
        rok = cas[:4]
        cislo = f"V{rok}-{db.dalsi_cislo(con, 'vydejka-' + rok):05d}"
        vid = con.execute("INSERT INTO vydejky (cislo, cas, uzivatel_id, duvod, komu, poznamka) VALUES (?, ?, ?, ?, ?, ?)",
                          (cislo, cas, u["id"], data.duvod, (data.komu or "").strip() or None,
                           (data.poznamka or "").strip() or None)).lastrowid
        celkem = 0
        for p in data.polozky:
            z = con.execute("SELECT nakupni_cena FROM zbozi WHERE id = ?", (p.zbozi_id,)).fetchone()
            if z is None:
                raise HTTPException(400, f"Zboží {p.zbozi_id} neexistuje")
            con.execute("INSERT INTO vydejka_polozky (vydejka_id, zbozi_id, mnozstvi, nakupni_cena) VALUES (?, ?, ?, ?)",
                        (vid, p.zbozi_id, p.mnozstvi, z["nakupni_cena"]))
            db.pohyb(con, p.zbozi_id, -p.mnozstvi, "VYDEJ", cislo, u["id"], DUVODY_VYDEJE[data.duvod])
            celkem += int(round((z["nakupni_cena"] or 0) * p.mnozstvi))
        con.execute("UPDATE vydejky SET celkem_nakup = ? WHERE id = ?", (celkem, vid))
    return {"id": vid, "cislo": cislo, "celkem_nakup": celkem}


def _polozky_dokladu(con: sqlite3.Connection, tabulka: str, sloupec: str, did: int) -> list:
    return [dict(r) for r in con.execute(
        f"SELECT x.*, z.nazev, z.jednotka, (SELECT ean FROM zbozi_ean e WHERE e.zbozi_id = z.id ORDER BY rowid LIMIT 1) AS ean "
        f"FROM {tabulka} x JOIN zbozi z ON z.id = x.zbozi_id WHERE x.{sloupec} = ? ORDER BY x.id", (did,))]


@app.get("/api/prijemky/{pid}")
def detail_prijemky(pid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    r = con.execute("SELECT p.*, u.jmeno AS uzivatel FROM prijemky p LEFT JOIN uzivatele u ON u.id = p.uzivatel_id WHERE p.id = ?",
                    (pid,)).fetchone()
    if r is None:
        raise HTTPException(404, "Příjemka nenalezena")
    return {**dict(r), "typ": "PRIJEMKA", "polozky": _polozky_dokladu(con, "prijemka_polozky", "prijemka_id", pid)}


@app.get("/api/vydejky/{vid}")
def detail_vydejky(vid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    r = con.execute("SELECT v.*, u.jmeno AS uzivatel FROM vydejky v LEFT JOIN uzivatele u ON u.id = v.uzivatel_id WHERE v.id = ?",
                    (vid,)).fetchone()
    if r is None:
        raise HTTPException(404, "Výdejka nenalezena")
    return {**dict(r), "typ": "VYDEJKA", "polozky": _polozky_dokladu(con, "vydejka_polozky", "vydejka_id", vid)}


@app.post("/api/prijemky/{pid}/storno")
def storno_prijemky(pid: int, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        p = con.execute("SELECT * FROM prijemky WHERE id = ?", (pid,)).fetchone()
        if p is None or p["stornovano"]:
            raise HTTPException(409, "Příjemku nejde stornovat")
        for x in con.execute("SELECT * FROM prijemka_polozky WHERE prijemka_id = ?", (pid,)).fetchall():
            db.pohyb(con, x["zbozi_id"], -x["mnozstvi"], "STORNO", p["cislo"], u["id"], "storno příjemky")
        con.execute("UPDATE prijemky SET stornovano = 1 WHERE id = ?", (pid,))
    return detail_prijemky(pid, u, con)


@app.post("/api/vydejky/{vid}/storno")
def storno_vydejky(vid: int, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        v = con.execute("SELECT * FROM vydejky WHERE id = ?", (vid,)).fetchone()
        if v is None or v["stornovano"]:
            raise HTTPException(409, "Výdejku nejde stornovat")
        for x in con.execute("SELECT * FROM vydejka_polozky WHERE vydejka_id = ?", (vid,)).fetchall():
            db.pohyb(con, x["zbozi_id"], x["mnozstvi"], "STORNO", v["cislo"], u["id"], "storno výdejky")
        con.execute("UPDATE vydejky SET stornovano = 1 WHERE id = ?", (vid,))
    return detail_vydejky(vid, u, con)


@app.get("/api/sklad/doklady")
def skladove_doklady(typ: str = "vse", od: Optional[str] = None, do: Optional[str] = None, q: str = "",
                     u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    casti, par = [], []
    obdobi = ""
    if od:
        obdobi += " AND d.cas >= ?"
    if do:
        obdobi += " AND d.cas < ?"
    meze = ([od] if od else []) + ([(date.fromisoformat(do) + timedelta(days=1)).isoformat()] if do else [])
    hledej = " AND (d.cislo LIKE ? OR norm(COALESCE(d.partner, '')) LIKE ? OR norm(COALESCE(d.doklad, '')) LIKE ?)" if q.strip() else ""
    hpar = [f"%{q.strip()}%"] + [f"%{db.bez_diakritiky(q.strip())}%"] * 2 if q.strip() else []
    if typ in ("vse", "prijemky"):
        casti.append("SELECT 'PRIJEMKA' AS typ, p.id, p.cislo, p.cas, p.dodavatel AS partner, NULL AS duvod, p.doklad, "
                     "p.celkem_bez_dph AS celkem, p.stornovano, p.soubor_id, p.uzivatel_id, "
                     "(SELECT COUNT(*) FROM prijemka_polozky WHERE prijemka_id = p.id) AS pocet FROM prijemky p")
    if typ in ("vse", "vydejky"):
        casti.append("SELECT 'VYDEJKA' AS typ, v.id, v.cislo, v.cas, v.komu AS partner, v.duvod, v.poznamka AS doklad, "
                     "v.celkem_nakup AS celkem, v.stornovano, NULL AS soubor_id, v.uzivatel_id, "
                     "(SELECT COUNT(*) FROM vydejka_polozky WHERE vydejka_id = v.id) AS pocet FROM vydejky v")
    if not casti:
        return []
    for _ in casti:
        par += meze + hpar
    sql = " UNION ALL ".join(f"SELECT * FROM ({c}) d WHERE 1=1{obdobi}{hledej}" for c in casti)
    rows = [dict(r) for r in con.execute(f"SELECT x.*, u.jmeno AS uzivatel FROM ({sql}) x LEFT JOIN uzivatele u ON u.id = x.uzivatel_id "
                                         "ORDER BY x.cas DESC LIMIT 500", par)]
    return rows


@app.get("/api/sklad/pohyby")
def skladove_pohyby(od: Optional[str] = None, do: Optional[str] = None, typ: str = "", q: str = "", limit: int = 500,
                    u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    sql = ("SELECT p.*, z.nazev, z.jednotka, u.jmeno AS uzivatel FROM pohyby p JOIN zbozi z ON z.id = p.zbozi_id "
           "LEFT JOIN uzivatele u ON u.id = p.uzivatel_id WHERE 1=1")
    par: list = []
    if od:
        sql += " AND p.cas >= ?"
        par.append(od)
    if do:
        sql += " AND p.cas < ?"
        par.append((date.fromisoformat(do) + timedelta(days=1)).isoformat())
    if typ:
        sql += " AND p.typ = ?"
        par.append(typ)
    if q.strip():
        sql += (" AND (norm(z.nazev) LIKE ? OR p.doklad LIKE ? OR z.id IN (SELECT zbozi_id FROM zbozi_ean WHERE ean = ?))")
        par += [f"%{db.bez_diakritiky(q.strip())}%", f"%{q.strip()}%", q.strip()]
    sql += " ORDER BY p.id DESC LIMIT ?"
    par.append(min(max(limit, 1), 5000))
    return [dict(r) for r in con.execute(sql, par)]


class KorekceVstup(BaseModel):
    zbozi_id: int
    novy_stav: float
    poznamka: Optional[str] = None


@app.post("/api/sklad/korekce")
def korekce(data: KorekceVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        z = con.execute("SELECT stav FROM zbozi WHERE id = ?", (data.zbozi_id,)).fetchone()
        if z is None:
            raise HTTPException(404, "Zboží nenalezeno")
        rozdil = round(data.novy_stav - z["stav"], 3)
        if rozdil:
            db.pohyb(con, data.zbozi_id, rozdil, "KOREKCE", "inventura", u["id"], data.poznamka)
    return {"ok": True, "rozdil": rozdil}


# --------------------------------------------------------------------------- uzávěrka

@app.get("/api/uzaverka")
def uzaverka(datum: Optional[str] = None, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    vysledek = uzaverky.souhrn(con, datum or db.ted()[:10])
    vysledek["odeslano"] = posta.stav().get("uzaverka")
    return vysledek


class OdeslatVstup(BaseModel):
    datum: Optional[str] = None
    komu: Optional[str] = None                  # jinak příjemci z nastavení
    zprava: Optional[str] = None


@app.post("/api/uzaverka/odeslat")
def odeslat_uzaverku(data: OdeslatVstup, u=Depends(uzivatel)):
    try:
        return posta.odesli_uzaverku(data.datum, posta.adresy(data.komu or "") or None)
    except posta.ChybaPosty as e:
        raise HTTPException(400, str(e))


@app.get("/api/uzaverka/xlsx")
def uzaverka_xlsx(datum: Optional[str] = None, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    datum = datum or db.ted()[:10]
    return Response(posta.mesicni_xlsx(con, datum),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="report-{datum[:7]}.xlsx"'})


@app.post("/api/email/test")
def test_emailu(data: OdeslatVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    komu = posta.adresy(data.komu or "") or posta.adresy(nast.get("uzaverka_prijemci") or "")
    try:
        posta.odesli(nast, komu, "Pokladna PcObchod – zkušební e-mail",
                     "<p>Odesílání e-mailů z pokladny funguje.</p>")
    except posta.ChybaPosty as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "komu": komu}


# --------------------------------------------------------------------------- odběratelé a vydané faktury

class OdberatelVstup(BaseModel):
    id: Optional[int] = None
    nazev: str = Field(min_length=1, max_length=200)
    ico: Optional[str] = None
    dic: Optional[str] = None
    ulice: Optional[str] = None
    mesto: Optional[str] = None
    psc: Optional[str] = None
    email: Optional[str] = None
    telefon: Optional[str] = None
    poznamka: Optional[str] = None


ODB_POLE = ("nazev", "ico", "dic", "ulice", "mesto", "psc", "email", "telefon", "poznamka")


def _uloz_odberatele(con: sqlite3.Connection, o: OdberatelVstup) -> int:
    hodnoty = [((getattr(o, k) or "").strip() or None) for k in ODB_POLE]
    if o.id:
        n = con.execute(f"UPDATE odberatele SET {', '.join(k + ' = ?' for k in ODB_POLE)}, upraveno = ? WHERE id = ?",
                        (*hodnoty, db.ted(), o.id)).rowcount
        if not n:
            raise HTTPException(404, "Kontakt nenalezen")
        return o.id
    if o.ico:
        r = con.execute("SELECT id FROM odberatele WHERE ico = ?", (o.ico.strip(),)).fetchone()
        if r:                                   # stejné IČO = stejný kontakt, jen aktualizovat
            return _uloz_odberatele(con, OdberatelVstup(**{**o.model_dump(), "id": r["id"]}))
    return con.execute(f"INSERT INTO odberatele ({', '.join(ODB_POLE)}, vytvoreno, upraveno) VALUES "
                       f"({', '.join('?' * len(ODB_POLE))}, ?, ?)", (*hodnoty, db.ted(), db.ted())).lastrowid


@app.get("/api/odberatele")
def seznam_odberatelu(q: str = "", u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    sql = ("SELECT o.*, (SELECT COUNT(*) FROM faktury_vydane f WHERE f.odberatel_id = o.id AND f.stav != 'STORNO') AS faktur, "
           "(SELECT COALESCE(SUM(celkem), 0) FROM faktury_vydane f WHERE f.odberatel_id = o.id AND f.stav = 'NEUHRAZENO') AS dluzi "
           "FROM odberatele o")
    par: list = []
    if q.strip():
        sql += " WHERE norm(o.nazev) LIKE ? OR o.ico LIKE ? OR norm(o.mesto) LIKE ?"
        par = [f"%{db.bez_diakritiky(q.strip())}%", f"{q.strip()}%", f"%{db.bez_diakritiky(q.strip())}%"]
    return [dict(r) for r in con.execute(sql + " ORDER BY o.nazev COLLATE NOCASE LIMIT 300", par)]


@app.post("/api/odberatele")
def novy_odberatel(data: OdberatelVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        oid = _uloz_odberatele(con, data)
    return dict(con.execute("SELECT * FROM odberatele WHERE id = ?", (oid,)).fetchone())


@app.get("/api/ares/{ico}")
def ares(ico: str, u=Depends(uzivatel)):
    ico = re.sub(r"\D", "", ico).zfill(8)
    if len(ico) != 8:
        raise HTTPException(400, "IČO má 8 číslic")
    try:
        r = requests.get(f"https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}", timeout=8)
        d = r.json()
    except (requests.RequestException, ValueError):
        raise HTTPException(502, "ARES teď neodpovídá, vyplňte údaje ručně")
    if r.status_code != 200 or not d.get("obchodniJmeno"):
        raise HTTPException(404, f"IČO {ico} v ARES není")
    s = d.get("sidlo") or {}
    cislo = "/".join(str(x) for x in (s.get("cisloDomovni"), s.get("cisloOrientacni")) if x) + (s.get("cisloOrientacniPismeno") or "")
    ulice = " ".join(x for x in (s.get("nazevUlice") or s.get("nazevCastiObce"), cislo) if x)
    return {"nazev": d["obchodniJmeno"], "ico": ico, "dic": d.get("dic"), "ulice": ulice,
            "mesto": s.get("nazevObce"), "psc": re.sub(r"^(\d{3})(\d{2})$", r"\1 \2", str(s.get("psc") or ""))}


class FakturaVydanaVstup(BaseModel):
    odberatel: OdberatelVstup
    ulozit_kontakt: bool = True
    forma_uhrady: str = Field(pattern="^(PREVOD|HOTOVE|KARTA|DOBIRKA)$")
    datum_vystaveni: Optional[str] = None
    duzp: Optional[str] = None
    splatnost: Optional[str] = None
    poznamka: Optional[str] = None
    polozky: List[PolozkaProdeje] = []
    prijato: Optional[int] = None               # hotovost na pokladně
    prodej_id: Optional[int] = None             # faktura k již zaplacené prodejce


def _adresa(o) -> str:
    return ", ".join(x for x in [o.ulice, " ".join(y for y in [o.psc, o.mesto] if y)] if x)


def faktura_dict(con: sqlite3.Connection, fid: int) -> dict:
    f = con.execute("SELECT f.*, u.jmeno AS vystavil, p.cislo AS prodejka FROM faktury_vydane f "
                    "LEFT JOIN uzivatele u ON u.id = f.uzivatel_id LEFT JOIN prodeje p ON p.id = f.prodej_id "
                    "WHERE f.id = ?", (fid,)).fetchone()
    if f is None:
        raise HTTPException(404, "Faktura nenalezena")
    d = dict(f)
    d["polozky"] = [dict(x) for x in con.execute("SELECT * FROM faktura_vydana_polozky WHERE faktura_id = ? ORDER BY id", (fid,))]
    d["dph"] = fakturace.rekap_dph(d["polozky"])
    d["po_splatnosti"] = d["stav"] == "NEUHRAZENO" and d["splatnost"] < db.ted()[:10]
    return d


@app.get("/api/faktury-vydane")
def seznam_faktur(filtr: str = "vse", q: str = "", u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    dnes = db.ted()[:10]
    sql = "SELECT * FROM faktury_vydane WHERE 1=1"
    par: list = []
    if filtr == "neuhrazene":
        sql += " AND stav = 'NEUHRAZENO'"
    elif filtr == "po_splatnosti":
        sql += " AND stav = 'NEUHRAZENO' AND splatnost < ?"
        par.append(dnes)
    elif filtr == "uhrazene":
        sql += " AND stav = 'UHRAZENO'"
    if q.strip():
        sql += " AND (cislo LIKE ? OR norm(odb_nazev) LIKE ? OR odb_ico LIKE ?)"
        par += [f"%{q.strip()}%", f"%{db.bez_diakritiky(q.strip())}%", f"{q.strip()}%"]
    rows = [dict(r) for r in con.execute(sql + " ORDER BY id DESC LIMIT 500", par)]
    for r in rows:
        r["po_splatnosti"] = r["stav"] == "NEUHRAZENO" and r["splatnost"] < dnes
    s = con.execute(
        "SELECT COALESCE(SUM(CASE WHEN stav = 'NEUHRAZENO' THEN celkem END), 0) AS neuhrazeno, "
        "COALESCE(SUM(CASE WHEN stav = 'NEUHRAZENO' AND splatnost < ? THEN celkem END), 0) AS po_splatnosti, "
        "COUNT(CASE WHEN stav = 'NEUHRAZENO' AND splatnost < ? THEN 1 END) AS pocet_po_splatnosti, "
        "COALESCE(SUM(CASE WHEN stav != 'STORNO' AND datum_vystaveni LIKE ? THEN celkem END), 0) AS mesic "
        "FROM faktury_vydane", (dnes, dnes, dnes[:7] + "%")).fetchone()
    return {"faktury": rows, "souhrn": dict(s)}


@app.get("/api/faktury-vydane/{fid}")
def detail_faktury(fid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    d = faktura_dict(con, fid)
    nast = db.nastaveni(con)
    iban = fakturace.iban_z_uctu(nast.get("faktura_ucet") or "")
    d["iban"] = iban
    d["qr"] = bool(iban and d["forma_uhrady"] == "PREVOD" and d["stav"] == "NEUHRAZENO")
    return d


@app.post("/api/faktury-vydane")
def nova_faktura(data: FakturaVydanaVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    dnes = db.ted()[:10]
    vystaveni = data.datum_vystaveni or dnes
    dni = int(nast.get("faktura_splatnost_dni") or 14)
    splatnost = data.splatnost or (date.fromisoformat(vystaveni) + timedelta(days=dni)).isoformat()
    eet_pid = None
    with db.transakce(con):
        oid = _uloz_odberatele(con, data.odberatel) if data.ulozit_kontakt else data.odberatel.id
        rok = vystaveni[:4]
        cislo = f"{nast.get('faktura_rada') or 'FV'}{rok}{db.dalsi_cislo(con, 'faktura-' + rok):04d}"
        vs = re.sub(r"\D", "", cislo)[-10:]
        if data.prodej_id:                      # faktura k zaplacené prodejce: zboží ani EET se znovu neřeší
            p = con.execute("SELECT * FROM prodeje WHERE id = ?", (data.prodej_id,)).fetchone()
            if p is None or p["typ"] != "PRODEJ" or p["stornovano"]:
                raise HTTPException(400, "K této prodejce nejde fakturu vystavit")
            if con.execute("SELECT 1 FROM faktury_vydane WHERE prodej_id = ?", (p["id"],)).fetchone():
                raise HTTPException(409, "K této prodejce už faktura existuje")
            radky = [dict(r) for r in con.execute("SELECT * FROM prodej_polozky WHERE prodej_id = ?", (p["id"],))]
            forma, celkem, stav, uhrazeno, prodej_id = p["platba"], p["celkem"], "UHRAZENO", p["cas"][:10], p["id"]
            if p["zaokrouhleni"]:
                radky.append({"zbozi_id": None, "nazev": "Zaokrouhlení", "mnozstvi": 1, "jednotka": None,
                              "cena": p["zaokrouhleni"], "sazba_dph": 0, "celkem": p["zaokrouhleni"]})
        else:
            radky = _radky_dokladu(con, data.polozky)
            forma = data.forma_uhrady
            if forma in ("HOTOVE", "KARTA"):     # placeno hned na pokladně → prodejka s EET
                prodej_id, eet_stav = _vloz_prodej(con, forma, data.prijato, radky, u, nast)
                p = con.execute("SELECT * FROM prodeje WHERE id = ?", (prodej_id,)).fetchone()
                celkem, stav, uhrazeno = p["celkem"], "UHRAZENO", dnes
                if p["zaokrouhleni"]:
                    radky.append({"zbozi_id": None, "nazev": "Zaokrouhlení", "mnozstvi": 1, "jednotka": None,
                                  "cena": p["zaokrouhleni"], "sazba_dph": 0, "celkem": p["zaokrouhleni"]})
                if eet_stav == "CEKA":
                    eet_pid = prodej_id
            else:                               # převodem / dobírkou: výdej ze skladu, bez EET
                prodej_id, stav, uhrazeno = None, "NEUHRAZENO", None
                celkem = sum(r["celkem"] for r in radky)
                for r in radky:
                    if r["zbozi_id"] is not None:
                        db.pohyb(con, r["zbozi_id"], -r["mnozstvi"], "PRODEJ", cislo, u["id"], "faktura")
        o = data.odberatel
        fid = con.execute(
            "INSERT INTO faktury_vydane (cislo, vs, odberatel_id, odb_nazev, odb_ico, odb_dic, odb_adresa, odb_email, "
            "datum_vystaveni, duzp, splatnost, forma_uhrady, poznamka, celkem, stav, datum_uhrady, prodej_id, uzivatel_id, vytvoreno) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cislo, vs, oid, o.nazev.strip(), (o.ico or "").strip() or None, (o.dic or "").strip() or None, _adresa(o) or None,
             (o.email or "").strip() or None, vystaveni, data.duzp or vystaveni, splatnost, forma,
             (data.poznamka or "").strip() or None, celkem, stav, uhrazeno, prodej_id, u["id"], db.ted())).lastrowid
        for r in radky:
            con.execute("INSERT INTO faktura_vydana_polozky (faktura_id, zbozi_id, nazev, mnozstvi, jednotka, cena, sazba_dph, celkem) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (fid, r["zbozi_id"], r["nazev"], r["mnozstvi"], r.get("jednotka"), r["cena"], r["sazba_dph"], r["celkem"]))
    if eet_pid:
        eet.odesli_prodej(eet_pid)
    return detail_faktury(fid, u, con)


class UhradaVstup(BaseModel):
    datum: Optional[str] = None
    uhrazeno: bool = True


@app.post("/api/faktury-vydane/{fid}/uhrada")
def uhrada_faktury(fid: int, data: UhradaVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    f = faktura_dict(con, fid)
    if f["stav"] == "STORNO" or f["prodej_id"]:
        raise HTTPException(409, "U této faktury nejde úhradu měnit")
    con.execute("UPDATE faktury_vydane SET stav = ?, datum_uhrady = ? WHERE id = ?",
                ("UHRAZENO", data.datum or db.ted()[:10], fid) if data.uhrazeno else ("NEUHRAZENO", None, fid))
    return detail_faktury(fid, u, con)


@app.post("/api/faktury-vydane/{fid}/storno")
def storno_faktury(fid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        f = faktura_dict(con, fid)
        if f["stav"] != "NEUHRAZENO" or f["prodej_id"]:
            raise HTTPException(409, "Stornovat jde jen neuhrazenou fakturu převodem. Zaplacenou vraťte stornem prodejky.")
        for p in f["polozky"]:
            if p["zbozi_id"] is not None:
                db.pohyb(con, p["zbozi_id"], p["mnozstvi"], "STORNO", f["cislo"], u["id"], "storno faktury")
        con.execute("UPDATE faktury_vydane SET stav = 'STORNO' WHERE id = ?", (fid,))
    return detail_faktury(fid, u, con)


@app.get("/api/faktury-vydane/{fid}/pdf")
def pdf_faktury(fid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    f = faktura_dict(con, fid)
    try:
        obsah = fakturace.pdf(f, db.nastaveni(con))
    except fakturace.ChybaFakturace as e:
        raise HTTPException(500, str(e))
    return Response(obsah, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{f["cislo"]}.pdf"'})


@app.get("/api/faktury-vydane/{fid}/qr.svg")
def qr_faktury(fid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    f = faktura_dict(con, fid)
    iban = fakturace.iban_z_uctu(db.nastaveni(con).get("faktura_ucet") or "")
    if not iban:
        raise HTTPException(404, "Není nastavený bankovní účet")
    return Response(fakturace.qr(fakturace.spayd(iban, f["celkem"], f["vs"], f["splatnost"], f"Faktura {f['cislo']}"), svg=True),
                    media_type="image/svg+xml")


@app.post("/api/faktury-vydane/{fid}/odeslat")
def odeslat_fakturu(fid: int, data: OdeslatVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    f = faktura_dict(con, fid)
    nast = db.nastaveni(con)
    komu = posta.adresy(data.komu or f.get("odb_email") or "")
    try:
        obsah = fakturace.pdf(f, nast)
        posta.odesli(nast, komu, f"Faktura {f['cislo']} – {nast.get('firma_nazev') or ''}".strip(" –"),
                     fakturace.email_html(f, nast, data.zprava or ""), [(f"{f['cislo']}.pdf", obsah, "application/pdf")])
    except (posta.ChybaPosty, fakturace.ChybaFakturace) as e:
        raise HTTPException(400, str(e))
    con.execute("UPDATE faktury_vydane SET odeslano = ? WHERE id = ?", (db.ted(), fid))
    return {"ok": True, "komu": komu}


# --------------------------------------------------------------------------- nastavení a uživatelé

UPRAVITELNE = set(db.VYCHOZI_NASTAVENI)
TAJNE = ("eet_cert_heslo", "ai_api_klic", "zaloha_heslo", "smtp_heslo")   # do prohlížeče jen jako hvězdičky


# --------------------------------------------------------------------------- certifikát a záloha

class CertifikatVstup(BaseModel):
    nazev: str
    data: str                                   # .p12 v base64
    heslo: str = Field(min_length=1)


@app.post("/api/eet/certifikat")
def nahraj_certifikat(vstup: CertifikatVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    try:
        obsah = base64.b64decode(vstup.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "Soubor se nepodařilo přenést")
    slozka = db.DB_CESTA.parent / "certifikaty"
    slozka.mkdir(parents=True, exist_ok=True)
    os.chmod(slozka, 0o700)
    docasny = slozka / f".nahravani-{secrets.token_hex(4)}.p12"
    docasny.write_bytes(obsah)
    try:
        cert = PokladniCertifikat(docasny, vstup.heslo)
    except Exception:
        docasny.unlink(missing_ok=True)
        raise HTTPException(400, "Certifikát nejde otevřít – zkontrolujte soubor .p12 a heslo")
    eic = next((a.value for a in cert.cert.subject if a.oid.dotted_string == "2.5.4.3"), None)
    cil = slozka / f"{eic or 'certifikat'}_{cert.plati_do:%Y%m%d}.p12"
    docasny.replace(cil)
    os.chmod(cil, 0o600)
    with db.transakce(con):
        zmeny = {"eet_cert_cesta": str(cil), "eet_cert_heslo": vstup.heslo}
        if eic and re.fullmatch(r"CZ\d{8,10}", eic):
            zmeny["eet_eic"] = eic
        for k, v in zmeny.items():
            con.execute("UPDATE nastaveni SET hodnota = ? WHERE klic = ?", (v, k))
    return {"eic": eic, "plati_do": cert.plati_do.date().isoformat(), "vydal": cert.cert.issuer.rfc4514_string(),
            "test": "playground" in cert.cert.issuer.rfc4514_string().lower()}


def _stav_zalohy() -> dict:
    stav = zaloha.cti_stav()
    lokalni = sorted(zaloha.ZALOHY_DIR.glob("pokladna-*.zaloha"), key=lambda p: p.stat().st_mtime, reverse=True) \
        if zaloha.ZALOHY_DIR.is_dir() else []
    posledni_mimo = stav.get("posledni_mimo")
    stari_h = None
    if posledni_mimo:
        stari_h = (datetime.now(PRAHA) - datetime.fromisoformat(posledni_mimo)).total_seconds() / 3600
    return {**stav, "lokalni": [{"nazev": p.name, "velikost": p.stat().st_size,
                                 "cas": datetime.fromtimestamp(p.stat().st_mtime, PRAHA).isoformat(timespec="seconds")}
                                for p in lokalni[:30]],
            "rclone": bool(shutil.which("rclone")),
            "varovani": stari_h is None or stari_h > 36}


@app.get("/api/zaloha/stav")
def stav_zalohy(u=Depends(spravce)):
    return _stav_zalohy()


@app.post("/api/zaloha")
def zalohuj_ted(u=Depends(spravce)):
    try:
        zaloha.planovac.zalohuj()
    except zaloha.ChybaZalohy as e:
        raise HTTPException(400, str(e))
    return _stav_zalohy()


@app.get("/api/zaloha/soubor/{nazev}")
def stahni_zalohu(nazev: str, u=Depends(spravce)):
    if not re.fullmatch(r"pokladna-[a-z0-9-]+-\d{8}-\d{6}\.zaloha", nazev):
        raise HTTPException(400, "Neplatný název zálohy")
    cesta = zaloha.ZALOHY_DIR / nazev
    if not cesta.is_file():
        raise HTTPException(404, "Záloha nenalezena")
    return FileResponse(cesta, filename=nazev, media_type="application/octet-stream")


@app.get("/api/nastaveni")
def cti_nastaveni(u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    for k in TAJNE:
        nast[k] = "********" if nast.get(k) else ""
    return nast


@app.put("/api/nastaveni")
def uloz_nastaveni(data: dict, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    if data.get("eet_rezim") not in (None, "vypnuto", "playground", "produkce"):
        raise HTTPException(400, "Neplatný režim EET")
    with db.transakce(con):
        for k, v in data.items():
            if k not in UPRAVITELNE or (k in TAJNE and v == "********"):
                continue
            con.execute("INSERT INTO nastaveni (klic, hodnota) VALUES (?, ?) "
                        "ON CONFLICT(klic) DO UPDATE SET hodnota = excluded.hodnota", (k, "" if v is None else str(v)))
    return cti_nastaveni(u, con)


class UzivatelVstup(BaseModel):
    jmeno: str = Field(min_length=1, max_length=60)
    role: str = Field(pattern="^(SPRAVCE|PRODAVAC)$")
    pin: Optional[str] = Field(default=None, pattern=r"^\d{4,12}$")
    aktivni: bool = True


def _pin_volny(con: sqlite3.Connection, pin: str, krome: Optional[int] = None) -> None:
    for x in con.execute("SELECT id, pin_hash FROM uzivatele WHERE aktivni = 1"):
        if x["id"] != krome and db.over_pin(pin, x["pin_hash"]):
            raise HTTPException(409, "Tento PIN už používá někdo jiný")


@app.get("/api/uzivatele")
def seznam_uzivatelu(u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    return [dict(r) for r in con.execute("SELECT id, jmeno, role, aktivni, vytvoreno FROM uzivatele ORDER BY jmeno")]


@app.post("/api/uzivatele")
def novy_uzivatel(data: UzivatelVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    if not data.pin:
        raise HTTPException(400, "Zadejte PIN")
    _pin_volny(con, data.pin)
    uid = con.execute("INSERT INTO uzivatele (jmeno, pin_hash, role, aktivni, vytvoreno) VALUES (?, ?, ?, ?, ?)",
                      (data.jmeno.strip(), db.hash_pin(data.pin), data.role, int(data.aktivni), db.ted())).lastrowid
    return {"id": uid}


@app.put("/api/uzivatele/{uid}")
def uprav_uzivatele(uid: int, data: UzivatelVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    if uid == u["id"] and (data.role != "SPRAVCE" or not data.aktivni):
        raise HTTPException(400, "Sám sebe nemůžete odebrat ze správců")
    if data.pin:
        _pin_volny(con, data.pin, uid)
        con.execute("UPDATE uzivatele SET pin_hash = ? WHERE id = ?", (db.hash_pin(data.pin), uid))
    con.execute("UPDATE uzivatele SET jmeno = ?, role = ?, aktivni = ? WHERE id = ?",
                (data.jmeno.strip(), data.role, int(data.aktivni), uid))
    if not data.aktivni:
        con.execute("DELETE FROM relace WHERE uzivatel_id = ?", (uid,))
    return {"ok": True}


# --------------------------------------------------------------------------- rozhraní

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return {
        "name": "Pokladna PcObchod", "short_name": "Pokladna", "start_url": "/", "display": "standalone",
        "background_color": "#ffffff", "theme_color": "#d6312b", "lang": "cs",
        "icons": [{"src": "/static/img/favicon-192.png", "sizes": "192x192", "type": "image/png"}],
    }
