# Instalace pokladny do prodejny

Každá prodejna má vlastní malý server, na kterém běží pokladna i databáze. Prodává se z libovolného zařízení s prohlížečem na síti prodejny, tedy z PC u pultu, notebooku nebo tabletu. Server se po zapnutí spustí sám a každý večer pošle šifrovanou zálohu mimo prodejnu.

```
  PC u pultu (Chrome)  ─┐
  tablet / mobil       ─┼── Wi-Fi / LAN prodejny ── server (mini PC) ── internet ── EET, záloha
  čtečka EAN, tiskárna ─┘                                 │
                                                          └─ USB disk (druhá kopie zálohy)
```

## 1. Hardware

| Co | Doporučení | Orientační cena |
|---|---|---|
| Server | Mini PC s Intel N100 nebo N150, 8 GB RAM, SSD 256 GB, bez ventilátoru, síťový port. Případně Raspberry Pi 5 (4 GB) se SSD přes USB nebo NVMe, ne na SD kartě, protože ty se opotřebují. | 3–4 tis. Kč |
| Záložní zdroj (UPS) | Malá UPS pro server a router, ať výpadek proudu nepoškodí databázi. | 1,5 tis. Kč |
| Čtečka EAN | Jakákoli USB čtečka, která se chová jako klávesnice (HID). Musí na konci kódu posílat Enter. | od 500 Kč |
| Tiskárna účtenek | Termotiskárna 80 mm (USB nebo síťová) s ovladačem pro Windows nebo Mac. Tiskne se z prohlížeče na pokladním PC, ne ze serveru. | 2–3 tis. Kč |
| USB disk | Pro druhou kopii zálohy přímo na serveru (nepovinné). | 300 Kč |

- **Síť:** server připojte kabelem do routeru a v routeru mu dejte pevnou adresu (rezervace DHCP).
- **Napájení:** v BIOSu mini PC zapněte start po obnovení napájení („Restore on AC power loss: Power On“).
- **Platební terminál:** zůstává samostatný od banky, v pokladně se jen zvolí platba kartou.

## 2. Systém na server

1. Na server nainstalujte **Debian 12** (mini PC) nebo **Raspberry Pi OS Lite 64bit** (Raspberry Pi), bez grafického prostředí a se zapnutým SSH.
2. Přihlaste se na server (přes SSH nebo klávesnici a monitor) a přeneste na něj složku s pokladnou:
   - z GitHubu: `git clone https://github.com/BFtech22/Pokladna_PcObchod.git`,
   - nebo z USB disku či přes `scp`.

## 3. Instalace pokladny

Ve složce s pokladnou spusťte:

```bash
sudo sh instalace/instaluj.sh --nazev pokladna-rumburk
```

Pro Varnsdorf zvolte název `pokladna-varnsdorf`. Skript udělá tohle:
- nainstaluje potřebné programy (Python, rclone pro zálohu na internet, avahi pro adresu `.local`, automatické bezpečnostní aktualizace),
- nastaví český čas a jeho synchronizaci, protože EET kontroluje čas tržby,
- zkopíruje pokladnu do `/opt/pokladna` a data uloží do `/var/lib/pokladna`,
- spustí službu `pokladna`, která naběhne po každém zapnutí serveru.

Pak v prohlížeči otevřete **http://pokladna-rumburk.local**. Kdyby adresa `.local` nefungovala (některé Windows a Androidy), použijte IP adresu serveru, kterou skript vypíše.

## 4. První nastavení v prohlížeči

1. **Správce:** při prvním otevření se zakládá správce. Zvolte jméno a PIN.
2. **Nastavení → Firma a účtenka:** název, IČO, DIČ, adresa, provozovna, plátce DPH.
3. **Nastavení → Uživatelé:** založte prodavače, každý má vlastní PIN.
4. **Nastavení → EET:**
   - Po instalaci je zapnutý **testovací režim** (Playground) s testovacím certifikátem finanční správy. Tržby se nikam ostře neevidují, dá se tedy bez obav zkoušet.
   - Ostrý provoz (od 1. 1. 2027):
     1. V portálu MOJE daně (DIS+) zaregistrujte evidenční jednotku (prodejnu) a vygenerujte pokladní certifikát (.p12). Musí to udělat podnikatel sám, každá firma zvlášť. Postup popisuje [eet.gov.cz – Jak začít evidovat](https://eet.gov.cz/cs/zacinam-s-eet/jak-zacit-evidovat).
     2. Tlačítkem **Nahrát certifikát** ho nahrajte s heslem. EIČ se vyplní samo.
     3. Doplňte **označení evidenční jednotky** z DIS+ a **označení pokladny** (třeba `RUMBURK-1`).
     4. **Otestovat spojení** a pak přepněte režim na **Produkce**.
5. **Nastavení → Záloha:** viz další kapitola. Bez ní pokladnu do provozu nepouštějte.
6. **Zboží:** import z Trellu, případně ruční založení nebo naskladnění z faktur (Sklad → Příjem zboží → Nahrát fakturu).

## 5. Záloha mimo prodejnu

Záloha obsahuje databázi, nahrané faktury a certifikáty. Je zašifrovaná heslem, které nastavíte v **Nastavení → Záloha**. **Heslo si uložte mimo pokladnu**, třeba do správce hesel nebo do sejfu. Bez něj zálohu nikdo neobnoví, ani my.

Záloha se dělá každý den v nastavený čas (výchozí 21:30). Když server v tu dobu neběží, udělá se po zapnutí. Na serveru zůstává posledních 14 záloh. Když 36 hodin neodejde žádná záloha mimo prodejnu, správce uvidí v hlavičce červené upozornění **Záloha!**.

**A) Google Disk přes rclone (doporučeno)**

1. Na svém počítači (Mac nebo Windows) nainstalujte [rclone](https://rclone.org/downloads/) a spusťte:
   ```bash
   rclone authorize "drive"
   ```
   Otevře se prohlížeč. Přihlaste se Google účtem, kam se má zálohovat, a zkopírujte vypsaný token (celý řádek `{"access_token":...}`).
2. Na serveru spusťte průvodce:
   ```bash
   sudo -u pokladna env RCLONE_CONFIG=/var/lib/pokladna/rclone.conf rclone config
   ```
   V průvodci zvolte:
   - `n` (nové připojení) s názvem `gdrive`,
   - typ `drive`, client_id a secret nechte prázdné,
   - scope `drive.file`,
   - „Use web browser“: `n`, a vložte token z bodu 1.
3. V pokladně v **Nastavení → Záloha** vyplňte cíl `gdrive:Pokladna/Rumburk` a klikněte na **Zálohovat teď**. Výsledek se zobrazí nahoře.

Stejně jde zálohovat na OneDrive, Dropbox, SFTP nebo NAS se SFTP (viz [rclone.org](https://rclone.org/overview/)).

**B) USB disk nebo NAS jako složka**

Disk připojte trvale do `/mnt/zaloha` (záznam v `/etc/fstab`, vlastník uživatel `pokladna`) a v nastavení vyplňte složku `/mnt/zaloha`. USB disk v prodejně chrání před poruchou serveru, ne před požárem nebo krádeží. Proto ho berte jen jako doplněk k zálohám na internet.

**Ruční stažení:** v **Nastavení → Záloha → Zálohy na serveru** jde každou zálohu stáhnout do počítače.

## 6. Obnova ze zálohy

Například na nový server po poruše:

1. Nainstalujte pokladnu podle kapitol 2 a 3.
2. Zálohu (`pokladna-….zaloha`) nahrajte na server, třeba do `/tmp`.
3. Obnovte ji:
   ```bash
   sudo systemctl stop pokladna
   cd /opt/pokladna
   sudo -u pokladna env POKLADNA_DB=/var/lib/pokladna/pokladna.sqlite .venv/bin/python -m pokladna.zaloha obnov /tmp/pokladna-...zaloha
   sudo systemctl start pokladna
   ```
   Program se zeptá na heslo zálohy. Původní data na serveru nesmaže, přejmenuje je na `*.pred-obnovou-<čas>`.

## 7. Pokladní PC u pultu

- **Prohlížeč:** stačí Google Chrome. Na plochu dejte zástupce, který otevře pokladnu jako samostatné okno a tiskne účtenky rovnou na výchozí tiskárnu bez dialogu:
  ```
  chrome.exe --app=http://pokladna-rumburk.local --kiosk-printing
  ```
  Ve Windows: pravým tlačítkem na plochu → Nový → Zástupce → cesta k `chrome.exe` s parametry výše.
- **Tiskárna účtenek:** termotiskárnu nastavte ve Windows jako výchozí, papír 80 mm a okraje minimální.
- **Čtečka:** pokladna sama opraví kód napsaný na české klávesnici (`áříř…` → `8595…`). Kdyby i tak čtečka psala nesmysly, přepněte ji podle návodu výrobce na „US keyboard“.
- **Tablety a mobily** fungují také: stačí otevřít adresu pokladny. Na Androidu jde přidat na plochu jako aplikaci.

## 8. Aktualizace na novou verzi

Ve složce s novou verzí (třeba po `git pull`) spusťte:

```bash
sudo sh instalace/aktualizuj.sh
```

Před aktualizací se udělá záloha. Data a nastavení zůstanou.

## 9. Když něco nejde

| Problém | Co udělat |
|---|---|
| Pokladna se neotevře | `sudo systemctl status pokladna` a `journalctl -u pokladna -n 100` |
| EET hlásí, že tržby čekají | zkontrolovat internet na serveru; pokladna je odešle sama, zákonná lhůta je 48 h |
| Záloha neodchází | Nastavení → Záloha ukazuje přesnou chybu rclone; obnovit token (kapitola 5) |
| Špatný čas na účtenkách | `timedatectl`, musí být `System clock synchronized: yes` |
| Restart serveru | `sudo systemctl restart pokladna` (nebo vypnout a zapnout) |
