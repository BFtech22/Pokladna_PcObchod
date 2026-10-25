"""Webový server pokladny: JSON API + statické rozhraní. Částky v API jsou v haléřích."""

from __future__ import annotations

import json
import logging
import secrets
import sqlite3
from contextlib import asynccontextmanager

from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db
from .eet_fronta import sluzba as eet

log = logging.getLogger("pokladna")
STATIC = Path(__file__).resolve().parent / "static"
COOKIE = "pokladna_relace"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.inicializuj()
    eet.spust()
    eet.probud()
    yield
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
                                          "uctenka_paticka")},
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


@app.post("/api/prodeje")
def novy_prodej(data: ProdejVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    with db.transakce(con):
        radky = []
        for pol in data.polozky:
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
                                  mnozstvi=round(pol.mnozstvi, 3), cena=cena,
                                  puvodni_cena=z["cena"] if cena != z["cena"] else None,
                                  sazba_dph=z["sazba_dph"]))
            else:
                if not (pol.nazev and pol.cena is not None):
                    raise HTTPException(400, "Položka mimo katalog potřebuje název a cenu")
                radky.append(dict(zbozi_id=None, nazev=pol.nazev.strip(), ean=None,
                                  mnozstvi=round(pol.mnozstvi, 3), cena=pol.cena, puvodni_cena=None,
                                  sazba_dph=21 if pol.sazba_dph is None else pol.sazba_dph))
        if not radky:
            raise HTTPException(400, "Prázdný nákup")
        for r in radky:
            r["celkem"] = int(round(r["cena"] * r["mnozstvi"]))
        mezisoucet = sum(r["celkem"] for r in radky)
        celkem = mezisoucet
        if data.platba == "HOTOVE" and nast.get("zaokrouhlovat_hotovost") == "1":
            celkem = zaokrouhli_kc(mezisoucet)
        prijato = vraceno = None
        if data.platba == "HOTOVE":
            prijato = data.prijato if data.prijato is not None else max(celkem, 0)
            if celkem > 0 and prijato < celkem:
                raise HTTPException(400, "Přijatá hotovost je nižší než částka k úhradě")
            vraceno = prijato - celkem

        cas = db.ted()
        rok = cas[:4]
        cislo = f"{rok}-{db.dalsi_cislo(con, 'prodej-' + rok):06d}"
        rezim = nast.get("eet_rezim") or "vypnuto"
        eet_stav = "VYPNUTO" if rezim == "vypnuto" else "CEKA"
        pid = con.execute(
            "INSERT INTO prodeje (cislo, cas, uzivatel_id, typ, platba, mezisoucet, zaokrouhleni, celkem, prijato, "
            "vraceno, eet_stav, eet_rezim, eet_eic, eet_jednotka, eet_pokl) "
            "VALUES (?, ?, ?, 'PRODEJ', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cislo, cas, u["id"], data.platba, mezisoucet, celkem - mezisoucet, celkem, prijato, vraceno,
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
    mnozstvi: float
    nakupni_cena: Optional[int] = Field(default=None, ge=0)   # bez DPH za jednotku


class PrijemkaVstup(BaseModel):
    dodavatel: Optional[str] = None
    doklad: Optional[str] = None
    poznamka: Optional[str] = None
    polozky: List[PolozkaPrijemky] = Field(min_length=1)


@app.post("/api/prijemky")
def nova_prijemka(data: PrijemkaVstup, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        cas = db.ted()
        rok = cas[:4]
        cislo = f"P{rok}-{db.dalsi_cislo(con, 'prijemka-' + rok):05d}"
        celkem = sum(int(round((p.nakupni_cena or 0) * p.mnozstvi)) for p in data.polozky)
        prid = con.execute(
            "INSERT INTO prijemky (cislo, cas, uzivatel_id, dodavatel, doklad, poznamka, celkem_bez_dph) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (cislo, cas, u["id"], data.dodavatel, data.doklad, data.poznamka, celkem)).lastrowid
        for p in data.polozky:
            if not con.execute("SELECT 1 FROM zbozi WHERE id = ?", (p.zbozi_id,)).fetchone():
                raise HTTPException(400, f"Zboží {p.zbozi_id} neexistuje")
            con.execute("INSERT INTO prijemka_polozky (prijemka_id, zbozi_id, mnozstvi, nakupni_cena) VALUES (?,?,?,?)",
                        (prid, p.zbozi_id, p.mnozstvi, p.nakupni_cena))
            db.pohyb(con, p.zbozi_id, p.mnozstvi, "PRIJEM", cislo, u["id"], data.doklad)
            if p.nakupni_cena is not None:
                con.execute("UPDATE zbozi SET nakupni_cena = ? WHERE id = ?", (p.nakupni_cena, p.zbozi_id))
    return {"id": prid, "cislo": cislo, "celkem_bez_dph": celkem}


@app.get("/api/prijemky")
def seznam_prijemek(u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    return [dict(r) for r in con.execute(
        "SELECT p.*, u.jmeno AS uzivatel, (SELECT COUNT(*) FROM prijemka_polozky WHERE prijemka_id = p.id) AS pocet "
        "FROM prijemky p LEFT JOIN uzivatele u ON u.id = p.uzivatel_id ORDER BY p.id DESC LIMIT 200")]


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
    datum = datum or db.ted()[:10]
    vzor = f"{datum}%"
    platby = {r["platba"]: dict(r) for r in con.execute(
        "SELECT platba, COUNT(*) AS pocet, SUM(celkem) AS celkem FROM prodeje WHERE cas LIKE ? GROUP BY platba",
        (vzor,))}
    typy = {r["typ"]: dict(r) for r in con.execute(
        "SELECT typ, COUNT(*) AS pocet, SUM(celkem) AS celkem FROM prodeje WHERE cas LIKE ? GROUP BY typ", (vzor,))}
    dph = [dict(r) for r in con.execute(
        "SELECT i.sazba_dph, SUM(i.celkem) AS celkem FROM prodej_polozky i JOIN prodeje p ON p.id = i.prodej_id "
        "WHERE p.cas LIKE ? GROUP BY i.sazba_dph ORDER BY i.sazba_dph DESC", (vzor,))]
    for r in dph:
        zaklad = int(round(r["celkem"] / (1 + r["sazba_dph"] / 100)))
        r["zaklad"], r["dph"] = zaklad, r["celkem"] - zaklad
    zaokr = con.execute("SELECT COALESCE(SUM(zaokrouhleni), 0) FROM prodeje WHERE cas LIKE ?", (vzor,)).fetchone()[0]
    eet_stavy = {r[0]: r[1] for r in con.execute(
        "SELECT eet_stav, COUNT(*) FROM prodeje WHERE cas LIKE ? GROUP BY eet_stav", (vzor,))}
    prodavaci = [dict(r) for r in con.execute(
        "SELECT u.jmeno, COUNT(*) AS pocet, SUM(p.celkem) AS celkem FROM prodeje p "
        "LEFT JOIN uzivatele u ON u.id = p.uzivatel_id WHERE p.cas LIKE ? GROUP BY p.uzivatel_id", (vzor,))]
    return {"datum": datum, "platby": platby, "typy": typy, "dph": dph, "zaokrouhleni": zaokr,
            "eet": eet_stavy, "prodavaci": prodavaci,
            "celkem": sum((v["celkem"] or 0) for v in platby.values())}


# --------------------------------------------------------------------------- nastavení a uživatelé

UPRAVITELNE = set(db.VYCHOZI_NASTAVENI)


@app.get("/api/nastaveni")
def cti_nastaveni(u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    nast["eet_cert_heslo"] = "********" if nast.get("eet_cert_heslo") else ""
    return nast


@app.put("/api/nastaveni")
def uloz_nastaveni(data: dict, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    if data.get("eet_rezim") not in (None, "vypnuto", "playground", "produkce"):
        raise HTTPException(400, "Neplatný režim EET")
    with db.transakce(con):
        for k, v in data.items():
            if k not in UPRAVITELNE or (k == "eet_cert_heslo" and v == "********"):
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
