# Pokladna PcObchod

Lokální pokladna se skladem a EET 2.0 pro prodejny PcObchod (Rumburk, Varnsdorf). Server běží v prodejně, obsluha je ve webovém prohlížeči z libovolného zařízení na síti prodejny. Každá prodejna má vlastní instalaci a databázi, protože jde o dvě firmy s vlastním EIČ a certifikátem.

## Co umí (stav 25. 10. 2026)

- **Prodej:** načtení čtečkou EAN (`3*kód` = 3 kusy), hledání podle názvu bez ohledu na diakritiku, změna ceny a sleva, položka mimo katalog, vratka, platba hotově se zaokrouhlením a výpočtem vrácení, platba kartou. Klávesy F2 (hotově), F3 (kartou) a F8 (zrušit).
- **EET 2.0:** tržba se odesílá hned při prodeji (mezní doba odezvy, výchozí 3 s). Když to nejde, fronta na pozadí zkouší odeslání každých 30 s (zákonná lhůta je 48 h). Storno odešle zápornou tržbu. V hlavičce je ukazatel stavu EET.
- **Prodejky:** přehled po dnech, detail, storno, ruční opakované odeslání do EET a tisk na 80mm tiskárnu (zjednodušený daňový doklad s rekapitulací DPH).
- **Faktury vydané (po vzoru iDokladu):**
  - přehled se souhrnem neuhrazených a po splatnosti, záložky Vše / Neuhrazené / Po splatnosti / Uhrazené,
  - adresář kontaktů a doplnění firmy z ARES podle IČO,
  - faktura z košíku, k už zaplacené prodejce nebo nová; placená hotově nebo kartou vytvoří i prodejku s EET, převodem vydá zboží ze skladu bez EET,
  - náhled a tisk A4, PDF s QR platbou, odeslání e-mailem, označení úhrady, storno a kopie.
- **Uzávěrka e-mailem:** souhrn dne v těle e-mailu a měsíční přehled v Excelu (dny, prodejky, prodané zboží). Odesílá se tlačítkem nebo automaticky v nastavený čas přes SMTP účet prodejny.
- **Zboží:** katalog s více EAN na položku, kategorie, prodejní a nákupní cena, marže, minimální stav a historie pohybů.
- **Sklad:** stav a hodnota skladu, příjem zboží čtečkou (příjemka) a inventura.
- **Naskladnění z faktury:** nahraje se faktura dodavatele a pokladna z ní vytáhne položky a spáruje je s katalogem.
  - Formáty: ISDOC, ISDOCX nebo PDF. Z PDF se nejdřív zkusí vložený ISDOC, pak čtení přes Claude (když je v nastavení API klíč) a nakonec odhad z textu PDF.
  - Párování: podle EAN, podle zapamatovaného kódu dodavatele, podle interního kódu a nakonec podle podobného názvu (jen jako návrh ke kontrole).
  - Pokladna si pamatuje i počet kusů v balení. Neznámé položky jde rovnou založit, cena se navrhne podle výchozí marže. Doprava a poplatky se přeskakují.
  - Upozorní na fakturu, která už byla naskladněna. Soubor faktury se uloží k příjemce.
- **Uzávěrka:** tržba hotově a kartou, storna, DPH, přehled po prodavačích a EET, tisk.
- **Uživatelé:** přihlášení PINem, role prodavač a správce.
- **Záloha:** každý den šifrovaná záloha (AES-256) databáze, faktur a certifikátů. Odchází mimo prodejnu přes rclone (Google Disk a další) nebo na USB disk či NAS. Správce vidí upozornění, když 36 h neodešla, obnova je jedním příkazem.
- **Certifikát EET:** nahrává se přes rozhraní (soubor .p12 a heslo), EIČ se vyplní samo.
- **Čtečka na české klávesnici:** kód napsaný jako „áříř…“ se sám převede na číslice.

Zatím chybí: import exportu z Trellu.

**Instalace do prodejny** (mini PC s Debianem nebo Raspberry Pi), záloha, obnova a nastavení pokladního PC: [instalace/README.md](instalace/README.md).

![Prodejní obrazovka](_zdroje/nahledy/prodej_2026-10-25.jpg)

## Demo v prohlížeči

**https://bftech22.github.io/Pokladna_PcObchod/** – vyzkoušení bez instalace, i na mobilu. PIN šéf `1234`, prodavač `1111`. Data zůstávají jen v prohlížeči toho, kdo demo zkouší, a EET se jen předstírá. Vzorová faktura ISDOC ke zkoušení naskladnění se stáhne z lišty dema.

Demo je složka `docs/` (GitHub Pages: Settings → Pages → Deploy from branch `main`, složka `/docs`). Po změně rozhraní se znovu sestaví příkazem `.venv/bin/python -I _zdroje/skripty/postav_demo.py`. Napodobenina serveru je v `demo/demo.js`.

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
- Vzorové faktury se smyšleným dodavatelem jsou v `_zdroje/vzorove_faktury/`. Znovu je vytvoří `.venv/bin/python -I _zdroje/skripty/vzorove_faktury.py`, PDF se generuje přes Google Chrome.
- Certifikáty, databáze ani logy se do repozitáře nedávají (viz `.gitignore`).

## Struktura

| Cesta | Obsah |
|---|---|
| `pokladna/eet_klient.py` | sestavení, podpis (WS-Security, RSA-SHA256, Exclusive C14N) a odeslání datové zprávy EET 2.0 |
| `pokladna/eet_fronta.py` | odeslání při prodeji a fronta na pozadí |
| `pokladna/db.py` | SQLite schéma, částky v haléřích |
| `pokladna/faktury.py` | čtení faktur (ISDOC, PDF, Claude API) a párování položek s katalogem |
| `pokladna/fakturace.py` | vydané faktury: PDF, QR platba (SPAYD), IBAN |
| `pokladna/posta.py` | e-maily přes SMTP, uzávěrka s Excelem, automatické odeslání |
| `pokladna/uzaverka.py` | souhrn dne a měsíční přehled |
| `pokladna/zaloha.py` | šifrovaná záloha, odeslání mimo prodejnu, plán a obnova (`python -m pokladna.zaloha`) |
| `instalace/` | instalační skript, služba systemd a návod pro prodejnu |
| `pokladna/server.py` | FastAPI: JSON API a statické rozhraní |
| `pokladna/static/` | webové rozhraní (bez sestavování), loga PcObchod |
| `_zdroje/eet2_dokumentace/` | oficiální dokumentace EET 2.0, XSD, WSDL a testovací certifikáty |

## EET – přechod na ostrý provoz

1. V DIS+ (MOJE daně) zaregistrovat evidenční jednotku (provozovnu) a vygenerovat pokladní certifikát (.p12). Musí to udělat podnikatel sám, a to od 1. 11. 2026 zvlášť za každou firmu.
2. V Nastavení → EET vyplnit EIČ (DIČ), označení evidenční jednotky z DIS+, označení pokladny, cestu k certifikátu a heslo.
3. Tlačítkem „Otestovat spojení“ ověřit spojení a pak přepnout režim na „Produkce“.

Poznámka k podpisu: kanonizace podstromu přímo na sestaveném stromu lxml je nespolehlivá (občas vynechá jmenný prostor `v4`), proto se obálka před podpisem zapíše a znovu načte. Každá zpráva se před odesláním ověří.
