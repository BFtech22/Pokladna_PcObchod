# Pokladna PcObchod

Lokální pokladna se skladem a EET 2.0 pro prodejny PcObchod (Rumburk, Varnsdorf). Server běží v prodejně, obsluha je ve webovém prohlížeči z libovolného zařízení na síti prodejny. Každá prodejna má vlastní instalaci a databázi, protože jde o dvě firmy s vlastním EIČ a certifikátem.

## Co umí (stav 25. 10. 2026)

- **Prodej:** načtení čtečkou EAN (`3*kód` = 3 kusy), hledání podle názvu bez ohledu na diakritiku, změna ceny a sleva, položka mimo katalog, vratka, platba hotově se zaokrouhlením a výpočtem vrácení, platba kartou. Klávesy F2 (hotově), F3 (kartou) a F8 (zrušit).
- **EET 2.0:** tržba se odesílá hned při prodeji (mezní doba odezvy, výchozí 3 s). Když to nejde, fronta na pozadí zkouší odeslání každých 30 s (zákonná lhůta je 48 h). Storno odešle zápornou tržbu. V hlavičce je ukazatel stavu EET.
- **Účtenky:** přehled po dnech, detail, storno, ruční opakované odeslání do EET a tisk na 80mm tiskárnu (zjednodušený daňový doklad s rekapitulací DPH).
- **Zboží:** katalog s více EAN na položku, kategorie, prodejní a nákupní cena, marže, minimální stav a historie pohybů.
- **Sklad:** stav a hodnota skladu, příjem zboží čtečkou podle faktury (příjemka) a inventura.
- **Uzávěrka:** tržba hotově a kartou, storna, DPH, přehled po prodavačích a EET, tisk.
- **Uživatelé:** přihlášení PINem, role prodavač a správce.

Zatím chybí: naskladnění přímo z PDF/ISDOC faktury, import exportu z Trellu, automatická záloha databáze mimo prodejnu a instalace na server v prodejně.

![Prodejní obrazovka](_zdroje/nahledy/prodej_2026-10-25.jpg)

## Instalace a spuštění

Je potřeba Python 3.9 nebo novější.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
sh _zdroje/skripty/stahni_testovaci_certifikaty.sh
.venv/bin/python -I _zdroje/skripty/demo_data.py
.venv/bin/python -m pokladna --port 8080
```

Kroky postupně: vytvoří prostředí, nainstalují knihovny, stáhnou veřejné testovací certifikáty finanční správy pro Playground, naplní ukázkové zboží (nepovinné) a spustí pokladnu.

Pak otevřít http://localhost:8080, z jiného zařízení v síti `http://<adresa-serveru>:8080`. Při prvním spuštění s prázdnou databází se zakládá správce. Výchozí režim EET je test (Playground), takže se nic ostře neeviduje.

- Databáze: `data/pokladna.sqlite` (jiná cesta přes proměnnou `POKLADNA_DB`).
- Test EET proti Playgroundu: `.venv/bin/python -I eet/test_playground.py`. Ověří podpis na vzorových zprávách finanční správy a odešle zkušební tržbu (potřebuje stažené testovací certifikáty). Úplná dokumentace EET 2.0 je na [eet.gov.cz](https://eet.gov.cz/cs/o-eet/dokumenty-k-eet-2-0), v repozitáři je jen schéma XSD, WSDL a vzorové zprávy.
- Certifikáty, databáze ani logy se do repozitáře nedávají (viz `.gitignore`).

## Struktura

| Cesta | Obsah |
|---|---|
| `pokladna/eet_klient.py` | sestavení, podpis (WS-Security, RSA-SHA256, Exclusive C14N) a odeslání datové zprávy EET 2.0 |
| `pokladna/eet_fronta.py` | odeslání při prodeji a fronta na pozadí |
| `pokladna/db.py` | SQLite schéma, částky v haléřích |
| `pokladna/server.py` | FastAPI: JSON API a statické rozhraní |
| `pokladna/static/` | webové rozhraní (bez sestavování), loga PcObchod |
| `_zdroje/eet2_dokumentace/` | oficiální dokumentace EET 2.0, XSD, WSDL a testovací certifikáty |

## EET – přechod na ostrý provoz

1. V DIS+ (MOJE daně) zaregistrovat evidenční jednotku (provozovnu) a vygenerovat pokladní certifikát (.p12). Musí to udělat podnikatel sám, a to od 1. 11. 2026 zvlášť za každou firmu.
2. V Nastavení → EET vyplnit EIČ (DIČ), označení evidenční jednotky z DIS+, označení pokladny, cestu k certifikátu a heslo.
3. Tlačítkem „Otestovat spojení“ ověřit spojení a pak přepnout režim na „Produkce“.

Poznámka k podpisu: kanonizace podstromu přímo na sestaveném stromu lxml je nespolehlivá (občas vynechá jmenný prostor `v4`), proto se obálka před podpisem zapíše a znovu načte. Každá zpráva se před odesláním ověří.
