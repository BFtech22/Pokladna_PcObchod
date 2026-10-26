"""Servis a reklamace: zakázky na opravu a reklamace zboží (zákonná lhůta 30 dní), díly a práce,
předání do servisu dodavatele, záloha přes pokladnu a výdej zákazníkovi s prodejkou (EET) nebo výdejkou."""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import db, posta
from .web import con_dep, uzivatel

router = APIRouter()

STAVY = {
    "PRIJATO": "Přijato",
    "DIAGNOSTIKA": "Diagnostika",
    "CEKA_ZAKAZNIK": "Čeká na souhlas zákazníka",
    "CEKA_DIL": "Čeká na díl",
    "V_OPRAVE": "V opravě",
    "U_DODAVATELE": "U dodavatele / výrobce",
    "HOTOVO": "Připraveno k vyzvednutí",
    "VYDANO": "Vydáno",
    "ZRUSENO": "Zrušeno",
}
AKTIVNI = ("PRIJATO", "DIAGNOSTIKA", "CEKA_ZAKAZNIK", "CEKA_DIL", "V_OPRAVE", "U_DODAVATELE", "HOTOVO")
VYRIZENI = {
    "OPRAVA": "Uznána – opraveno",
    "VYMENA": "Uznána – vyměněno za nové",
    "SLEVA": "Uznána – přiměřená sleva",
    "VRACENI_PENEZ": "Uznána – vráceny peníze",
    "ZAMITNUTO": "Zamítnuta",
    "OPRAVENO": "Opraveno",
    "NEOPRAVITELNE": "Nelze opravit",
    "ODMITNUTO": "Zákazník opravu odmítl",
}
POLE = ("zakaznik", "telefon", "email", "zarizeni", "sn", "prislusenstvi", "vzhled", "heslo", "zavada", "pozadavek", "odhad",
        "max_cena", "termin", "prodej_id", "doklad_koupe", "datum_koupe", "technik_id", "dodavatel", "dodavatel_rma", "vyjadreni",
        "poznamka", "odberatel_id")


def _soucet(polozky: list) -> int:
    return sum(int(round(p["cena"] * p["mnozstvi"])) for p in polozky)


def zakazka_dict(con: sqlite3.Connection, zid: int) -> dict:
    r = con.execute(
        "SELECT z.*, u.jmeno AS prijal, t.jmeno AS technik, v.jmeno AS vydal, p.cislo AS prodejka_koupe, p.cas AS cas_koupe, "
        "pv.cislo AS prodejka_vydani, f.cislo AS faktura, vy.cislo AS vydejka FROM servis_zakazky z "
        "LEFT JOIN uzivatele u ON u.id = z.uzivatel_id LEFT JOIN uzivatele t ON t.id = z.technik_id "
        "LEFT JOIN uzivatele v ON v.id = z.vydal_id LEFT JOIN prodeje p ON p.id = z.prodej_id "
        "LEFT JOIN prodeje pv ON pv.id = z.prodej_vydani_id LEFT JOIN faktury_vydane f ON f.id = z.faktura_id "
        "LEFT JOIN vydejky vy ON vy.id = z.vydejka_id WHERE z.id = ?", (zid,)).fetchone()
    if r is None:
        raise HTTPException(404, "Zakázka nenalezena")
    d = dict(r)
    d["polozky"] = [dict(x) for x in con.execute("SELECT * FROM servis_polozky WHERE zakazka_id = ? ORDER BY id", (zid,))]
    for p in d["polozky"]:
        p["celkem"] = int(round(p["cena"] * p["mnozstvi"]))
    d["celkem"] = _soucet(d["polozky"])
    d["doplatit"] = d["celkem"] - (d["zaloha"] or 0)
    d["historie"] = [dict(x) for x in con.execute(
        "SELECT h.*, u.jmeno AS uzivatel FROM servis_historie h LEFT JOIN uzivatele u ON u.id = h.uzivatel_id "
        "WHERE h.zakazka_id = ? ORDER BY h.id DESC", (zid,))]
    d["stav_text"] = STAVY.get(d["stav"], d["stav"])
    d["vyrizeni_text"] = VYRIZENI.get(d["vyrizeni"] or "", "")
    d["dni_do_lhuty"] = (date.fromisoformat(d["lhuta"]) - date.fromisoformat(db.ted()[:10])).days if d["lhuta"] else None
    if d["typ"] == "REKLAMACE" and d["prijato"]:
        konec = d["vyrizeno"] or d["vydano"] or db.ted()
        d["doba_vyrizeni_dni"] = (date.fromisoformat(konec[:10]) - date.fromisoformat(d["prijato"][:10])).days
    return d


def _historie(con: sqlite3.Connection, zid: int, uid: Optional[int], stav: Optional[str], text: Optional[str]) -> None:
    con.execute("INSERT INTO servis_historie (zakazka_id, cas, uzivatel_id, stav, text) VALUES (?, ?, ?, ?, ?)",
                (zid, db.ted(), uid, stav, text))
    con.execute("UPDATE servis_zakazky SET upraveno = ? WHERE id = ?", (db.ted(), zid))


class ZakazkaVstup(BaseModel):
    typ: str = Field(default="OPRAVA", pattern="^(OPRAVA|REKLAMACE)$")
    zakaznik: str = Field(min_length=1, max_length=200)
    telefon: Optional[str] = None
    email: Optional[str] = None
    zarizeni: str = Field(min_length=1, max_length=200)
    sn: Optional[str] = None
    prislusenstvi: Optional[str] = None
    vzhled: Optional[str] = None
    heslo: Optional[str] = None
    zavada: str = Field(min_length=1, max_length=4000)
    pozadavek: Optional[str] = None
    odhad: Optional[int] = Field(default=None, ge=0)
    max_cena: Optional[int] = Field(default=None, ge=0)
    termin: Optional[str] = None
    prodej_id: Optional[int] = None
    doklad_koupe: Optional[str] = None
    datum_koupe: Optional[str] = None
    technik_id: Optional[int] = None
    dodavatel: Optional[str] = None
    dodavatel_rma: Optional[str] = None
    vyjadreni: Optional[str] = None
    poznamka: Optional[str] = None
    odberatel_id: Optional[int] = None


def _ciste(data: BaseModel) -> dict:
    out = {}
    for k in POLE:
        v = getattr(data, k, None)
        if isinstance(v, str):
            v = v.strip() or None
        out[k] = v
    return out


@router.get("/api/servis")
def seznam(filtr: str = "aktivni", q: str = "", u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    dnes = db.ted()[:10]
    sql = ("SELECT z.*, t.jmeno AS technik, (SELECT CAST(COALESCE(SUM(ROUND(cena * mnozstvi)), 0) AS INTEGER) FROM servis_polozky WHERE zakazka_id = z.id) AS celkem "
           "FROM servis_zakazky z LEFT JOIN uzivatele t ON t.id = z.technik_id WHERE 1=1")
    par: list = []
    misto = ", ".join("?" * len(AKTIVNI))
    if filtr == "aktivni":
        sql += f" AND z.stav IN ({misto})"
        par += AKTIVNI
    elif filtr in ("reklamace", "opravy"):
        sql += f" AND z.typ = ? AND z.stav IN ({misto})"
        par += ["REKLAMACE" if filtr == "reklamace" else "OPRAVA", *AKTIVNI]
    elif filtr == "u_dodavatele":
        sql += " AND z.stav = 'U_DODAVATELE'"
    elif filtr == "hotove":
        sql += " AND z.stav = 'HOTOVO'"
    elif filtr == "lhuta":                       # reklamace, které do 7 dnů (nebo už) překročí zákonnou lhůtu
        sql += " AND z.typ = 'REKLAMACE' AND z.vyrizeno IS NULL AND z.stav NOT IN ('VYDANO', 'ZRUSENO') AND z.lhuta <= ?"
        par.append((date.fromisoformat(dnes) + timedelta(days=7)).isoformat())
    elif filtr == "vydane":
        sql += " AND z.stav IN ('VYDANO', 'ZRUSENO')"
    q = q.strip()
    if q:
        t = f"%{db.bez_diakritiky(q)}%"
        sql += (" AND (z.cislo LIKE ? OR norm(z.zakaznik) LIKE ? OR REPLACE(z.telefon, ' ', '') LIKE ? OR z.sn LIKE ? OR norm(z.zarizeni) LIKE ? "
                "OR z.dodavatel_rma LIKE ?)")
        par += [f"%{q}%", t, f"%{q.replace(' ', '')}%", f"%{q}%", t, f"%{q}%"]
    rows = [dict(r) for r in con.execute(sql + " ORDER BY CASE WHEN z.stav IN ('VYDANO', 'ZRUSENO') THEN 1 ELSE 0 END, z.id DESC LIMIT 500", par)]
    for r in rows:
        r["stav_text"] = STAVY.get(r["stav"], r["stav"])
        r["dni_do_lhuty"] = (date.fromisoformat(r["lhuta"]) - date.fromisoformat(dnes)).days if r["lhuta"] else None
        r["heslo"] = "••••" if r["heslo"] else None
    pocty = {k: v for k, v in con.execute(f"SELECT stav, COUNT(*) FROM servis_zakazky WHERE stav IN ({misto}) GROUP BY stav", AKTIVNI)}
    hori = con.execute("SELECT COUNT(*) FROM servis_zakazky WHERE typ = 'REKLAMACE' AND vyrizeno IS NULL AND stav NOT IN ('VYDANO', 'ZRUSENO') "
                       "AND lhuta <= ?", ((date.fromisoformat(dnes) + timedelta(days=7)).isoformat(),)).fetchone()[0]
    return {"zakazky": rows, "pocty": pocty, "hori_lhuta": hori, "stavy": STAVY, "vyrizeni": VYRIZENI}


@router.get("/api/servis/{zid}")
def detail(zid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    return zakazka_dict(con, zid)


@router.post("/api/servis")
def nova(data: ZakazkaVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    nast = db.nastaveni(con)
    cas = db.ted()
    pole = _ciste(data)
    if data.typ == "REKLAMACE" and not (pole["prodej_id"] or pole["doklad_koupe"] or pole["datum_koupe"]):
        raise HTTPException(400, "U reklamace vyplňte doklad o koupi nebo datum nákupu")
    lhuta = (date.fromisoformat(cas[:10]) + timedelta(days=int(nast.get("servis_lhuta_dni") or 30))).isoformat() \
        if data.typ == "REKLAMACE" else None
    with db.transakce(con):
        cislo = f"{'R' if data.typ == 'REKLAMACE' else 'S'}{cas[:4]}-{db.dalsi_cislo(con, f'servis-{data.typ}-{cas[:4]}'):05d}"
        sloupce = ["cislo", "typ", "stav", "prijato", "lhuta", "uzivatel_id", "upraveno", *POLE]
        zid = con.execute(f"INSERT INTO servis_zakazky ({', '.join(sloupce)}) VALUES ({', '.join('?' * len(sloupce))})",
                          (cislo, data.typ, "PRIJATO", cas, lhuta, u["id"], cas, *(pole[k] for k in POLE))).lastrowid
        _historie(con, zid, u["id"], "PRIJATO", "Zakázka přijata" if data.typ == "OPRAVA" else "Reklamace uplatněna")
    return zakazka_dict(con, zid)


@router.put("/api/servis/{zid}")
def uprav(zid: int, data: ZakazkaVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        z = zakazka_dict(con, zid)
        if z["stav"] in ("VYDANO", "ZRUSENO"):
            raise HTTPException(409, "Uzavřenou zakázku už nejde měnit")
        pole = _ciste(data)
        if pole["heslo"] == "••••":
            pole["heslo"] = z["heslo"]
        con.execute(f"UPDATE servis_zakazky SET {', '.join(k + ' = ?' for k in POLE)}, upraveno = ? WHERE id = ?",
                    (*(pole[k] for k in POLE), db.ted(), zid))
    return zakazka_dict(con, zid)


class StavVstup(BaseModel):
    stav: str
    text: Optional[str] = Field(default=None, max_length=2000)
    vyrizeni: Optional[str] = None
    vyjadreni: Optional[str] = None
    dodavatel: Optional[str] = None
    dodavatel_rma: Optional[str] = None


@router.post("/api/servis/{zid}/stav")
def zmen_stav(zid: int, data: StavVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    if data.stav not in STAVY or data.stav == "VYDANO":
        raise HTTPException(400, "Neplatný stav (vydání zákazníkovi je samostatné tlačítko)")
    with db.transakce(con):
        z = zakazka_dict(con, zid)
        if z["stav"] in ("VYDANO", "ZRUSENO"):
            raise HTTPException(409, "Zakázka je uzavřená")
        zmeny = {"stav": data.stav}
        if data.vyjadreni is not None:
            zmeny["vyjadreni"] = data.vyjadreni.strip() or None
        if data.stav == "U_DODAVATELE":
            dodavatel = (data.dodavatel or z["dodavatel"] or "").strip()
            if not dodavatel:
                raise HTTPException(400, "Vyplňte, komu se zařízení posílá (dodavatel, výrobce, servis)")
            zmeny.update(dodavatel=dodavatel, dodavatel_rma=(data.dodavatel_rma or z["dodavatel_rma"] or "").strip() or None,
                         odeslano_dodavateli=db.ted())
        if z["stav"] == "U_DODAVATELE" and data.stav != "U_DODAVATELE":
            zmeny["vraceno_od_dodavatele"] = db.ted()
        if data.stav == "HOTOVO":
            vyrizeni = data.vyrizeni or z["vyrizeni"]
            if vyrizeni not in VYRIZENI:
                raise HTTPException(400, "Vyberte, jak byla zakázka vyřízena")
            zmeny.update(vyrizeni=vyrizeni, vyrizeno=z["vyrizeno"] or db.ted())
        if data.stav == "ZRUSENO" and z["zaloha"]:
            raise HTTPException(409, "Zakázka má zaplacenou zálohu – vydejte ji zákazníkovi a zálohu vraťte vratkou")
        con.execute(f"UPDATE servis_zakazky SET {', '.join(k + ' = ?' for k in zmeny)} WHERE id = ?", (*zmeny.values(), zid))
        popis = STAVY[data.stav]
        if data.stav == "U_DODAVATELE":
            popis += f": {zmeny['dodavatel']}" + (f", RMA {zmeny['dodavatel_rma']}" if zmeny.get("dodavatel_rma") else "")
        if data.stav == "HOTOVO":
            popis += f" – {VYRIZENI[zmeny['vyrizeni']]}"
        _historie(con, zid, u["id"], data.stav, popis + (f". {data.text.strip()}" if (data.text or "").strip() else ""))
    return zakazka_dict(con, zid)


class PoznamkaVstup(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/api/servis/{zid}/poznamka")
def poznamka(zid: int, data: PoznamkaVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    zakazka_dict(con, zid)
    with db.transakce(con):
        _historie(con, zid, u["id"], None, data.text.strip())
    return zakazka_dict(con, zid)


class PolozkaVstup(BaseModel):
    zbozi_id: Optional[int] = None
    nazev: Optional[str] = None
    mnozstvi: float = Field(default=1, gt=0, le=9999)
    cena: Optional[int] = Field(default=None, ge=0)
    sazba_dph: int = 21


@router.post("/api/servis/{zid}/polozky")
def pridej_polozku(zid: int, data: PolozkaVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    with db.transakce(con):
        z = zakazka_dict(con, zid)
        if z["stav"] in ("VYDANO", "ZRUSENO"):
            raise HTTPException(409, "Zakázka je uzavřená")
        if data.zbozi_id:
            zb = con.execute("SELECT * FROM zbozi WHERE id = ?", (data.zbozi_id,)).fetchone()
            if zb is None:
                raise HTTPException(404, "Zboží nenalezeno")
            nazev, cena, sazba = zb["nazev"], zb["cena"] if data.cena is None else data.cena, zb["sazba_dph"]
        else:
            if not (data.nazev or "").strip() or data.cena is None:
                raise HTTPException(400, "Práce nebo díl mimo katalog potřebuje název a cenu")
            nazev, cena, sazba = data.nazev.strip(), data.cena, data.sazba_dph
        con.execute("INSERT INTO servis_polozky (zakazka_id, zbozi_id, nazev, mnozstvi, cena, sazba_dph) VALUES (?, ?, ?, ?, ?, ?)",
                    (zid, data.zbozi_id, nazev, data.mnozstvi, cena, sazba))
        con.execute("UPDATE servis_zakazky SET upraveno = ? WHERE id = ?", (db.ted(), zid))
    return zakazka_dict(con, zid)


@router.delete("/api/servis/{zid}/polozky/{pid}")
def smaz_polozku(zid: int, pid: int, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    z = zakazka_dict(con, zid)
    if z["stav"] in ("VYDANO", "ZRUSENO"):
        raise HTTPException(409, "Zakázka je uzavřená")
    con.execute("DELETE FROM servis_polozky WHERE id = ? AND zakazka_id = ?", (pid, zid))
    return zakazka_dict(con, zid)


class ZalohaVstup(BaseModel):
    castka: int = Field(gt=0)
    platba: str = Field(pattern="^(HOTOVE|KARTA)$")
    prijato: Optional[int] = None


@router.post("/api/servis/{zid}/zaloha")
def zaloha(zid: int, data: ZalohaVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    """Záloha na opravu se platí na pokladně: vznikne prodejka s EET, při výdeji se odečte."""
    from .eet_fronta import sluzba as eet
    from .server import _vloz_prodej, prodej_dict
    nast = db.nastaveni(con)
    with db.transakce(con):
        z = zakazka_dict(con, zid)
        if z["stav"] in ("VYDANO", "ZRUSENO"):
            raise HTTPException(409, "Zakázka je uzavřená")
        radky = [{"zbozi_id": None, "nazev": f"Záloha na opravu {z['cislo']}", "ean": None, "jednotka": "ks", "mnozstvi": 1,
                  "cena": data.castka, "puvodni_cena": None, "sazba_dph": 21, "celkem": data.castka}]
        pid, eet_stav = _vloz_prodej(con, data.platba, data.prijato, radky, u, nast)
        con.execute("UPDATE servis_zakazky SET zaloha = zaloha + ? WHERE id = ?", (data.castka, zid))
        _historie(con, zid, u["id"], None, f"Přijata záloha {data.castka / 100:,.2f} Kč ({'hotově' if data.platba == 'HOTOVE' else 'kartou'})".replace(",", " ").replace(".", ","))
    if eet_stav == "CEKA":
        eet.odesli_prodej(pid)
    return {"zakazka": zakazka_dict(con, zid), "prodej": prodej_dict(con, pid)}


class VydejVstup(BaseModel):
    platba: str = Field(pattern="^(HOTOVE|KARTA|ZDARMA|FAKTURA)$")
    prijato: Optional[int] = None
    faktura_id: Optional[int] = None            # faktura vystavená předem z položek zakázky
    text: Optional[str] = None


@router.post("/api/servis/{zid}/vydat")
def vydat(zid: int, data: VydejVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    """Výdej zákazníkovi: placená oprava → prodejka s EET (záloha se odečte), záruční / zdarma → díly výdejkou."""
    from .eet_fronta import sluzba as eet
    from .server import _vloz_prodej, prodej_dict
    nast = db.nastaveni(con)
    eet_pid = None
    with db.transakce(con):
        z = zakazka_dict(con, zid)
        if z["stav"] in ("VYDANO", "ZRUSENO"):
            raise HTTPException(409, "Zakázka už je uzavřená")
        if z["typ"] == "REKLAMACE" and not z["vyrizeni"]:
            raise HTTPException(400, "Nejdřív zapište, jak byla reklamace vyřízena (stav Připraveno k vyzvednutí)")
        zmeny = {"stav": "VYDANO", "vydano": db.ted(), "vydal_id": u["id"]}
        if not z["vyrizeno"]:
            zmeny["vyrizeno"] = db.ted()
        if data.platba in ("HOTOVE", "KARTA"):
            radky = [{"zbozi_id": p["zbozi_id"], "nazev": p["nazev"], "ean": None, "jednotka": "ks", "mnozstvi": p["mnozstvi"],
                      "cena": p["cena"], "puvodni_cena": None, "sazba_dph": p["sazba_dph"], "celkem": p["celkem"]} for p in z["polozky"]]
            if z["zaloha"]:
                radky.append({"zbozi_id": None, "nazev": f"Odečtení zálohy {z['cislo']}", "ean": None, "jednotka": "ks", "mnozstvi": 1,
                              "cena": -z["zaloha"], "puvodni_cena": None, "sazba_dph": 21, "celkem": -z["zaloha"]})
            if not radky:
                raise HTTPException(400, "Zakázka nemá žádnou práci ani díl k zaplacení – vydejte ji jako bezplatnou")
            pid, eet_stav = _vloz_prodej(con, data.platba, data.prijato, radky, u, nast)
            zmeny["prodej_vydani_id"] = pid
            if eet_stav == "CEKA":
                eet_pid = pid
        elif data.platba == "FAKTURA":
            f = con.execute("SELECT id, stav FROM faktury_vydane WHERE id = ?", (data.faktura_id,)).fetchone()
            if f is None or f["stav"] == "STORNO":
                raise HTTPException(400, "Faktura k zakázce nenalezena")
            zmeny["faktura_id"] = f["id"]
        else:
            if z["zaloha"]:
                raise HTTPException(409, "Zakázka má zaplacenou zálohu – vydejte ji s platbou (záloha se odečte) nebo ji vraťte vratkou")
            dily = [p for p in z["polozky"] if p["zbozi_id"]]
            if dily:                                # díly na záruční opravu ze skladu → výdejka vlastní spotřeba
                cas = db.ted()
                cislo = f"V{cas[:4]}-{db.dalsi_cislo(con, 'vydejka-' + cas[:4]):05d}"
                vid = con.execute("INSERT INTO vydejky (cislo, cas, uzivatel_id, duvod, komu, poznamka) VALUES (?, ?, ?, 'SPOTREBA', ?, ?)",
                                  (cislo, cas, u["id"], f"servis {z['cislo']}", "díly na bezplatnou / záruční opravu")).lastrowid
                celkem = 0
                for p in dily:
                    nak = con.execute("SELECT nakupni_cena FROM zbozi WHERE id = ?", (p["zbozi_id"],)).fetchone()[0]
                    con.execute("INSERT INTO vydejka_polozky (vydejka_id, zbozi_id, mnozstvi, nakupni_cena) VALUES (?, ?, ?, ?)",
                                (vid, p["zbozi_id"], p["mnozstvi"], nak))
                    db.pohyb(con, p["zbozi_id"], -p["mnozstvi"], "VYDEJ", cislo, u["id"], f"servis {z['cislo']}")
                    celkem += int(round((nak or 0) * p["mnozstvi"]))
                con.execute("UPDATE vydejky SET celkem_nakup = ? WHERE id = ?", (celkem, vid))
                zmeny["vydejka_id"] = vid
        con.execute(f"UPDATE servis_zakazky SET {', '.join(k + ' = ?' for k in zmeny)} WHERE id = ?", (*zmeny.values(), zid))
        _historie(con, zid, u["id"], "VYDANO", "Vydáno zákazníkovi" + {"HOTOVE": ", zaplaceno hotově", "KARTA": ", zaplaceno kartou",
                                                                     "FAKTURA": ", na fakturu", "ZDARMA": " bez platby"}[data.platba]
                  + (f". {data.text.strip()}" if (data.text or "").strip() else ""))
    if eet_pid:
        eet.odesli_prodej(eet_pid)
    pid = zmeny.get("prodej_vydani_id")
    return {"zakazka": zakazka_dict(con, zid), "prodej": prodej_dict(con, pid) if pid else None}


class EmailVstup(BaseModel):
    druh: str = Field(pattern="^(prijato|pripraveno|vlastni)$")
    zprava: Optional[str] = None
    komu: Optional[str] = None


@router.post("/api/servis/{zid}/email")
def email(zid: int, data: EmailVstup, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    import html as h
    z = zakazka_dict(con, zid)
    nast = db.nastaveni(con)
    komu = posta.adresy(data.komu or z["email"] or "")
    if not komu:
        raise HTTPException(400, "Zákazník nemá e-mail")
    firma = nast.get("firma_nazev") or ""
    if data.druh == "pripraveno":
        predmet = f"Zakázka {z['cislo']} je připravena k vyzvednutí"
        vychozi = (f"Dobrý den,\nVaše zařízení {z['zarizeni']} (zakázka {z['cislo']}) je připravené k vyzvednutí."
                   + (f"\nVýsledek: {z['vyrizeni_text']}." if z["vyrizeni_text"] else "")
                   + (f"\nK úhradě: {z['doplatit'] / 100:,.2f} Kč.".replace(",", " ").replace(".", ",") if z["doplatit"] > 0 else "")
                   + f"\n\nOtevírací dobu najdete na www.pcobchod.com. S sebou vezměte převzetí zakázky.\n\n{firma}")
    elif data.druh == "prijato":
        predmet = f"Potvrzení přijetí {'reklamace' if z['typ'] == 'REKLAMACE' else 'zakázky'} {z['cislo']}"
        vychozi = (f"Dobrý den,\npotvrzujeme převzetí zařízení {z['zarizeni']}" + (f" (SN {z['sn']})" if z["sn"] else "")
                   + f" dne {z['prijato'][8:10]}. {z['prijato'][5:7]}. {z['prijato'][:4]} pod číslem {z['cislo']}."
                   + (f"\nReklamaci vyřídíme nejpozději do {z['lhuta'][8:10]}. {z['lhuta'][5:7]}. {z['lhuta'][:4]}." if z["lhuta"] else "")
                   + f"\nPopis závady: {z['zavada']}\n\nO průběhu Vás budeme informovat.\n\n{firma}")
    else:
        predmet = f"Zakázka {z['cislo']} – {firma}"
        vychozi = ""
    text = (data.zprava or vychozi).strip()
    if not text:
        raise HTTPException(400, "Napište zprávu")
    try:
        posta.odesli(nast, komu, predmet, f"<div style=\"font-family:Arial,sans-serif;font-size:14px\">{h.escape(text).replace(chr(10), '<br>')}</div>")
    except posta.ChybaPosty as e:
        raise HTTPException(400, str(e))
    with db.transakce(con):
        _historie(con, zid, u["id"], None, f"E-mail zákazníkovi ({', '.join(komu)}): {predmet}")
    return {"ok": True, "komu": komu}


@router.get("/api/serie")
def hledej_serii(q: str, u=Depends(uzivatel), con: sqlite3.Connection = Depends(con_dep)):
    """Dohledání prodaného kusu podle sériového čísla / IMEI – pro reklamaci a záruku."""
    q = q.strip()
    if len(q) < 3:
        return []
    out = []
    for r in con.execute(
            "SELECT s.*, p.cislo AS prodejka, p.stornovano, f.cislo AS faktura FROM serie s LEFT JOIN prodeje p ON p.id = s.prodej_id "
            "LEFT JOIN faktury_vydane f ON f.id = s.faktura_id WHERE s.sn LIKE ? ORDER BY s.id DESC LIMIT 20", (f"%{q}%",)):
        d = dict(r)
        d["v_zaruce"] = bool(d["zaruka_do"] and d["zaruka_do"] >= db.ted()[:10])
        out.append(d)
    return out
