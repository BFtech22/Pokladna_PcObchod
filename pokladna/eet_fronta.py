"""Odesílání tržeb do EET: hned při prodeji (mezní doba odezvy) a pak opakovaně na pozadí.

ZoET § 19–20: mezní doba odezvy je nejméně 2 s; když se nestihne, tržba se musí poslat
bezodkladně po obnovení spojení, nejpozději do 48 hodin od uskutečnění.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Optional

from . import db
from . import eet_klient as eet

log = logging.getLogger("pokladna.eet")

INTERVAL_S = 30
TRVALE_CHYBY = {2, 3, 4, 6, 7, 8}   # chyby zprávy, opakování nepomůže


class EetSluzba:
    def __init__(self) -> None:
        self._udalost = threading.Event()
        self._zamek = threading.Lock()
        self._cert: Optional[eet.PokladniCertifikat] = None
        self._cert_klic: Optional[tuple] = None
        self._vlakno: Optional[threading.Thread] = None
        self._stop = False

    # --- certifikát -------------------------------------------------------
    def certifikat(self, nast: dict) -> eet.PokladniCertifikat:
        cesta = Path(nast.get("eet_cert_cesta") or "")
        if not cesta.is_file():
            raise RuntimeError(f"Pokladní certifikát nenalezen: {cesta}")
        klic = (str(cesta), cesta.stat().st_mtime, nast.get("eet_cert_heslo") or "")
        if klic != self._cert_klic:
            self._cert = eet.PokladniCertifikat(cesta, klic[2])
            self._cert_klic = klic
        return self._cert

    @staticmethod
    def url(rezim: str) -> str:
        return eet.URL_PRODUKCE if rezim == "produkce" else eet.URL_PLAYGROUND

    # --- odeslání jedné tržby ----------------------------------------------
    def odesli_prodej(self, prodej_id: int, timeout: Optional[float] = None) -> dict:
        with self._zamek, db.spojeni() as con:
            p = con.execute("SELECT * FROM prodeje WHERE id = ?", (prodej_id,)).fetchone()
            if p is None or p["eet_stav"] not in ("CEKA", "CHYBA"):
                return dict(p) if p else {}
            nast = db.nastaveni(con)
            timeout = timeout or max(2.0, float(nast.get("eet_timeout_s") or 3))
            zmena = {"eet_pokusy": p["eet_pokusy"] + 1, "eet_posledni_pokus": db.ted()}
            try:
                cert = self.certifikat(nast)
                trzba = eet.Trzba(eic_popl=p["eet_eic"], id_jednotky=p["eet_jednotka"], id_pokl=p["eet_pokl"],
                                  porad_cis=p["cislo"], dat_trzby=p["cas"], celk_trzba=p["celkem"] / 100)
                xml, uid = eet.sestav_zpravu(trzba, cert, prvni_zaslani=p["eet_pokusy"] == 0)
                zmena["eet_uuid"] = uid
                odp = eet.odesli(xml, self.url(p["eet_rezim"]), timeout=timeout)
                zmena["eet_transaction_id"] = odp.transaction_id
                zmena["eet_test"] = 1 if odp.test else 0
                if odp.varovani:
                    zmena["eet_varovani"] = json.dumps(odp.varovani, ensure_ascii=False)
                if odp.ok:
                    zmena.update(eet_stav="OK", eet_pok=odp.pok, eet_chyba=None)
                elif odp.kod_chyby in TRVALE_CHYBY:
                    zmena.update(eet_stav="CHYBA", eet_chyba=f"{odp.kod_chyby}: {odp.text_chyby}")
                else:
                    zmena.update(eet_stav="CEKA", eet_chyba=f"{odp.kod_chyby}: {odp.text_chyby}")
            except Exception as e:  # síť, timeout, nečitelná odpověď, chybějící certifikát
                zmena.update(eet_stav="CEKA", eet_chyba=f"{type(e).__name__}: {e}"[:300])
            sloupce = ", ".join(f"{k} = ?" for k in zmena)
            con.execute(f"UPDATE prodeje SET {sloupce} WHERE id = ?", (*zmena.values(), prodej_id))
            if zmena["eet_stav"] != "OK":
                log.warning("EET %s: %s", p["cislo"], zmena.get("eet_chyba"))
            return dict(con.execute("SELECT * FROM prodeje WHERE id = ?", (prodej_id,)).fetchone())

    def test_spojeni(self) -> dict:
        """Ověřovací zpráva (overeni=true) s nastavením pokladny; nic se neeviduje."""
        with db.spojeni() as con:
            nast = db.nastaveni(con)
        cert = self.certifikat(nast)
        trzba = eet.Trzba(eic_popl=nast["eet_eic"], id_jednotky=int(nast["eet_id_jednotky"]),
                          id_pokl=nast["eet_id_pokl"], porad_cis="TEST-SPOJENI", celk_trzba="0.00")
        xml, _ = eet.sestav_zpravu(trzba, cert, overeni=True)
        odp = eet.odesli(xml, self.url(nast["eet_rezim"]), timeout=10)
        return {"ok": odp.kod_chyby == 0, "kod": odp.kod_chyby, "text": odp.text_chyby,
                "varovani": odp.varovani, "test": odp.test, "certifikat": cert.eic,
                "certifikat_plati_do": cert.plati_do.date().isoformat()}

    # --- smyčka na pozadí -------------------------------------------------
    def probud(self) -> None:
        self._udalost.set()

    def _smycka(self) -> None:
        while not self._stop:
            self._udalost.wait(INTERVAL_S)
            self._udalost.clear()
            try:
                with db.spojeni() as con:
                    ids = [r[0] for r in con.execute(
                        "SELECT id FROM prodeje WHERE eet_stav = 'CEKA' ORDER BY id LIMIT 50")]
                for pid in ids:
                    if self._stop:
                        break
                    if self.odesli_prodej(pid).get("eet_stav") != "OK":
                        break   # spojení zřejmě nejde, další pokus v dalším kole
            except Exception:
                log.exception("Chyba ve frontě EET")

    def spust(self) -> None:
        if self._vlakno is None:
            self._vlakno = threading.Thread(target=self._smycka, name="eet-fronta", daemon=True)
            self._vlakno.start()

    def zastav(self) -> None:
        self._stop = True
        self._udalost.set()


sluzba = EetSluzba()
