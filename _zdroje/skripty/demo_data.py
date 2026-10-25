"""Naplní vývojovou databázi ukázkovým zbožím (jen pro zkoušení, ne pro prodejnu).

Spuštění z kořene projektu: .venv/bin/python -I _zdroje/skripty/demo_data.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from pokladna import db  # noqa: E402

ZBOZI = [
    # název, EAN, kategorie, cena s DPH Kč, nákup bez DPH Kč, stav, jednotka
    ("Kabel USB-C – USB-C 1 m, 60 W", "8595680412013", "Kabely", 199, 62, 24, "ks"),
    ("Kabel Lightning – USB-A 1 m", "8595680412020", "Kabely", 249, 78, 15, "ks"),
    ("Nabíječka 20 W USB-C PD", "8595680412037", "Nabíječky", 399, 145, 9, "ks"),
    ("Nabíječka do auta 2× USB 36 W", "8595680412044", "Nabíječky", 349, 120, 6, "ks"),
    ("Tvrzené sklo iPhone 15", "8595680412051", "Ochranná skla a fólie", 299, 35, 30, "ks"),
    ("Tvrzené sklo Samsung A55", "8595680412068", "Ochranná skla a fólie", 299, 35, 18, "ks"),
    ("Silikonový obal iPhone 15 černý", "8595680412075", "Pouzdra a obaly", 349, 60, 12, "ks"),
    ("Flip pouzdro Samsung A15", "8595680412082", "Pouzdra a obaly", 399, 90, 7, "ks"),
    ("Myš bezdrátová Logitech M185", "5099206027312", "Periferie", 349, 210, 5, "ks"),
    ("Klávesnice USB CZ/SK", "8595680412099", "Periferie", 299, 160, 4, "ks"),
    ("Flash disk 64 GB USB 3.2", "8595680412105", "Paměti", 229, 120, 20, "ks"),
    ("microSD 128 GB + adaptér", "8595680412112", "Paměti", 399, 210, 10, "ks"),
    ("Powerbanka 10 000 mAh", "8595680412129", "Nabíječky", 599, 290, 3, "ks"),
    ("UTP kabel Cat6 (metráž)", "8595680412136", "Metráž", 15, 6, 120, "m"),
    ("Sluchátka do uší s mikrofonem", "8595680412143", "Audio", 249, 85, 8, "ks"),
]


def main() -> None:
    db.inicializuj()
    with db.spojeni() as con, db.transakce(con):
        if con.execute("SELECT COUNT(*) FROM zbozi").fetchone()[0]:
            print("Zboží už v databázi je, nic nepřidávám.")
            return
        for nazev, ean, kat, cena, nakup, stav, jed in ZBOZI:
            zid = con.execute(
                "INSERT INTO zbozi (nazev, kategorie, cena, sazba_dph, nakupni_cena, jednotka, min_stav, vytvoreno, upraveno) "
                "VALUES (?, ?, ?, 21, ?, ?, ?, ?, ?)",
                (nazev, kat, cena * 100, nakup * 100, jed, 2 if jed == "ks" else 20, db.ted(), db.ted())).lastrowid
            con.execute("INSERT INTO zbozi_ean (ean, zbozi_id) VALUES (?, ?)", (ean, zid))
            db.pohyb(con, zid, stav, "KOREKCE", "demo", None, "ukázková data")
        con.execute("UPDATE nastaveni SET hodnota = ? WHERE klic = 'firma_nazev'", ("PcObchod – TEST",))
        con.execute("UPDATE nastaveni SET hodnota = ? WHERE klic = 'provozovna'", ("tř. 9. května 853/32, Rumburk",))
    print(f"Přidáno {len(ZBOZI)} položek.")


if __name__ == "__main__":
    main()
