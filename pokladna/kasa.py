"""Pokladní kniha: hotovost v šuplíku, pokladní doklady (vklad, výběr, odvod tržby) a spočítání pokladny.

Stav hotovosti = hotové prodejky (včetně storen a vratek) + příjmové doklady − výdajové doklady.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import db
from .web import con_dep, spravce, uzivatel

router = APIRouter()

DRUHY = {
    "POCATECNI": ("PRIJEM", "Počáteční stav"),
    "VKLAD": ("PRIJEM", "Vklad do pokladny"),
    "VYBER": ("VYDEJ", "Výběr z pokladny"),
    "ODVOD": ("VYDEJ", "Odvod tržby"),
    "NAKUP": ("VYDEJ", "Nákup za hotové"),
    "ROZDIL": (None, "Rozdíl při počítání"),
    "JINE": (None, "Jiný pohyb"),
}
NOMINALY = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]   # Kč


def stav(con: sqlite3.Connection, pred: Optional[str] = None) -> int:
    """Hotovost v pokladně (v haléřích). `pred` = jen pohyby s časem menším než tento (ISO, stačí datum)."""
    podm, par = ("AND cas < ?", [pred]) if pred else ("", [])
    trzby = con.execute(f"SELECT COALESCE(SUM(celkem), 0) FROM prodeje WHERE platba = 'HOTOVE' {podm}", par).fetchone()[0]
    doklady = con.execute(
        f"SELECT COALESCE(SUM(CASE typ WHEN 'PRIJEM' THEN castka ELSE -castka END), 0) FROM pokladni_doklady "
        f"WHERE stornovano = 0 {podm}", par).fetchone()[0]
    return trzby + doklady


def den(con: sqlite3.Connection, datum: str) -> dict:
    """Pohyb hotovosti za den: ráno, tržby, příjmy, výdaje, večer (pro uzávěrku)."""
    zitra = (date.fromisoformat(datum) + timedelta(days=1)).isoformat()
    trzby = con.execute("SELECT COALESCE(SUM(celkem), 0) FROM prodeje WHERE platba = 'HOTOVE' AND cas LIKE ?",
                        (f"{datum}%",)).fetchone()[0]
    r = con.execute(
        "SELECT COALESCE(SUM(CASE WHEN typ = 'PRIJEM' THEN castka END), 0) AS prijmy, "
        "COALESCE(SUM(CASE WHEN typ = 'VYDEJ' THEN castka END), 0) AS vydaje FROM pokladni_doklady "
        "WHERE stornovano = 0 AND cas LIKE ?", (f"{datum}%",)).fetchone()
    pocitani = con.execute(
        "SELECT c.*, u.jmeno AS uzivatel FROM pokladna_pocitani c LEFT JOIN uzivatele u ON u.id = c.uzivatel_id "
        "WHERE c.cas LIKE ? ORDER BY c.id DESC LIMIT 1", (f"{datum}%",)).fetchone()
    return {"datum": datum, "rano": stav(con, datum), "trzby": trzby, "prijmy": r["prijmy"], "vydaje": r["vydaje"],
            "vecer": stav(con, zitra), "pocitani": _pocitani_dict(pocitani) if pocitani else None}


def prodejek(n: int) -> str:
    return f"{n} prodejka" if n == 1 else f"{n} prodejky" if 2 <= n <= 4 else f"{n} prodejek"


def _pocitani_dict(r) -> dict:
    d = dict(r)
    d["rozpis"] = json.loads(d["rozpis"]) if d.get("rozpis") else {}
    d["rozdil"] = d["spocitano"] - d["ocekavano"]
    return d


def _doklad_dict(con: sqlite3.Connection, did: int) -> dict:
    r = con.execute("SELECT d.*, u.jmeno AS uzivatel FROM pokladni_doklady d LEFT JOIN uzivatele u ON u.id = d.uzivatel_id "
                    "WHERE d.id = ?", (did,)).fetchone()
    if r is None:
        raise HTTPException(404, "Pokladní doklad nenalezen")
    d = dict(r)
    d["druh_text"] = DRUHY.get(d["druh"], (None, d["druh"]))[1]
    return d


def vloz_doklad(con: sqlite3.Connection, typ: str, druh: str, castka: int, ucel: Optional[str], osoba: Optional[str],
                uid: Optional[int]) -> int:
    """Zapíše pokladní doklad (volat v transakci). Příjmový PP…, výdajový VP…"""
    cas = db.ted()
    rok = cas[:4]
    pref = "PP" if typ == "PRIJEM" else "VP"
    cislo = f"{pref}{rok}-{db.dalsi_cislo(con, f'pokl-{pref}-{rok}'):05d}"
    return con.execute(
        "INSERT INTO pokladni_doklady (cislo, cas, typ, druh, castka, ucel, osoba, uzivatel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (cislo, cas, typ, druh, castka, ucel, osoba, uid)).lastrowid


class DokladVstup(BaseModel):
    druh: str
    typ: Optional[str] = Field(default=None, pattern="^(PRIJEM|VYDEJ)$")   # jen u druhu JINE
    castka: int = Field(gt=0, le=100_000_000)
    ucel: Optional[str] = Field(default=None, max_length=300)
    osoba: Optional[str] = Field(default=None, max_length=120)


@router.get("/api/pokladna/stav")
def stav_pokladny(u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    posledni = con.execute(
        "SELECT c.*, u.jmeno AS uzivatel FROM pokladna_pocitani c LEFT JOIN uzivatele u ON u.id = c.uzivatel_id "
        "ORDER BY c.id DESC LIMIT 1").fetchone()
    return {"stav": stav(con), "dnes": den(con, db.ted()[:10]), "posledni_pocitani": _pocitani_dict(posledni) if posledni else None,
            "nominaly": NOMINALY}


@router.post("/api/pokladna/doklady")
def novy_doklad(data: DokladVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    if data.druh not in DRUHY or data.druh == "ROZDIL":
        raise HTTPException(400, "Neznámý druh pokladního dokladu")
    typ = DRUHY[data.druh][0] or data.typ
    if not typ:
        raise HTTPException(400, "Vyberte, jestli jde o příjem, nebo výdej")
    if data.druh == "POCATECNI" and u["role"] != "SPRAVCE":
        raise HTTPException(403, "Počáteční stav zadává správce")
    with db.transakce(con):
        if typ == "VYDEJ":
            v_pokladne = stav(con)
            if data.castka > v_pokladne:
                raise HTTPException(400, f"V pokladně je podle evidence jen {v_pokladne / 100:,.2f} Kč".replace(",", " ").replace(".", ","))
        did = vloz_doklad(con, typ, data.druh, data.castka, (data.ucel or "").strip() or DRUHY[data.druh][1],
                          (data.osoba or "").strip() or None, u["id"])
    return _doklad_dict(con, did)


@router.get("/api/pokladna/doklady/{did}")
def detail_dokladu(did: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    return _doklad_dict(con, did)


@router.post("/api/pokladna/doklady/{did}/storno")
def storno_dokladu(did: int, u=Depends(spravce), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        d = _doklad_dict(con, did)
        if d["stornovano"]:
            raise HTTPException(409, "Doklad už je stornovaný")
        con.execute("UPDATE pokladni_doklady SET stornovano = 1 WHERE id = ?", (did,))
        con.execute("UPDATE pokladna_pocitani SET doklad_id = NULL WHERE doklad_id = ?", (did,))
    return _doklad_dict(con, did)


@router.get("/api/pokladna/kniha")
def kniha(mesic: Optional[str] = None, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    """Pokladní kniha za měsíc: pokladní doklady a hotové tržby po dnech s průběžným zůstatkem."""
    mesic = (mesic or db.ted()[:7])[:7]
    zacatek = f"{mesic}-01"
    pocatek = stav(con, zacatek)
    radky = []
    for r in con.execute(
            "SELECT d.*, u.jmeno AS uzivatel FROM pokladni_doklady d LEFT JOIN uzivatele u ON u.id = d.uzivatel_id "
            "WHERE d.cas LIKE ? ORDER BY d.cas", (f"{mesic}%",)):
        d = dict(r)
        radky.append({"druh": d["druh"], "id": d["id"], "cas": d["cas"], "datum": d["cas"][:10], "cislo": d["cislo"],
                      "text": d["ucel"] or DRUHY.get(d["druh"], (None, d["druh"]))[1], "osoba": d["osoba"], "uzivatel": d["uzivatel"],
                      "stornovano": d["stornovano"],
                      "prijem": d["castka"] if d["typ"] == "PRIJEM" else 0, "vydej": d["castka"] if d["typ"] == "VYDEJ" else 0})
    # Hotové prodejky se sčítají do jednoho řádku za úsek dne mezi pokladními doklady, aby zůstatek seděl v každém okamžiku.
    hranice = sorted(r["cas"] for r in radky)
    useky: dict = {}
    for r in con.execute("SELECT cas, celkem FROM prodeje WHERE platba = 'HOTOVE' AND cas LIKE ? ORDER BY cas", (f"{mesic}%",)):
        dalsi = next((h for h in hranice if h > r["cas"] and h[:10] == r["cas"][:10]), None)
        u_ = useky.setdefault((r["cas"][:10], dalsi), {"pocet": 0, "celkem": 0, "cas": r["cas"]})
        u_["pocet"] += 1
        u_["celkem"] += r["celkem"]
        u_["cas"] = r["cas"]
    for (datum, _), u_ in useky.items():
        if u_["celkem"]:
            radky.append({"druh": "TRZBY", "cas": u_["cas"], "datum": datum, "cislo": None,
                          "text": f"Tržby hotově ({prodejek(u_['pocet'])})", "prijem": max(u_["celkem"], 0), "vydej": max(-u_["celkem"], 0)})
    radky.sort(key=lambda x: x["cas"])
    zustatek = pocatek
    for r in radky:
        if not r.get("stornovano"):
            zustatek += r["prijem"] - r["vydej"]
        r["zustatek"] = zustatek
    pocitani = [_pocitani_dict(r) for r in con.execute(
        "SELECT c.*, u.jmeno AS uzivatel FROM pokladna_pocitani c LEFT JOIN uzivatele u ON u.id = c.uzivatel_id "
        "WHERE c.cas LIKE ? ORDER BY c.id", (f"{mesic}%",))]
    return {"mesic": mesic, "pocatek": pocatek, "konec": zustatek, "radky": radky, "pocitani": pocitani,
            "prijmy": sum(r["prijem"] for r in radky if not r.get("stornovano")),
            "vydaje": sum(r["vydej"] for r in radky if not r.get("stornovano"))}


class PocitaniVstup(BaseModel):
    rozpis: Dict[str, int]                      # {"500": 3, "1": 12}
    zauctovat: bool = True                      # rozdíl zapsat pokladním dokladem
    poznamka: Optional[str] = Field(default=None, max_length=300)


@router.post("/api/pokladna/pocitani")
def spocitat(data: PocitaniVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    rozpis = {}
    for k, v in data.rozpis.items():
        if not v:
            continue
        try:
            nominal = int(k)
        except ValueError:
            raise HTTPException(400, f"Neznámý nominál {k}")
        if nominal not in NOMINALY or v < 0:
            raise HTTPException(400, f"Neplatný počet u {k} Kč")
        rozpis[str(nominal)] = int(v)
    spocitano = sum(int(k) * 100 * v for k, v in rozpis.items())
    with db.transakce(con):
        ocekavano = stav(con)
        rozdil = spocitano - ocekavano
        did = None
        if data.zauctovat and rozdil:
            did = vloz_doklad(con, "PRIJEM" if rozdil > 0 else "VYDEJ", "ROZDIL", abs(rozdil),
                              "Přebytek při počítání pokladny" if rozdil > 0 else "Manko při počítání pokladny", None, u["id"])
        pid = con.execute(
            "INSERT INTO pokladna_pocitani (cas, ocekavano, spocitano, rozpis, doklad_id, uzivatel_id, poznamka) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (db.ted(), ocekavano, spocitano, json.dumps(rozpis), did, u["id"], (data.poznamka or "").strip() or None)).lastrowid
    r = con.execute("SELECT c.*, u.jmeno AS uzivatel FROM pokladna_pocitani c LEFT JOIN uzivatele u ON u.id = c.uzivatel_id "
                    "WHERE c.id = ?", (pid,)).fetchone()
    return _pocitani_dict(r)
