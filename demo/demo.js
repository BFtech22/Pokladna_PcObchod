/* Demo pokladny pro GitHub Pages: napodobenina serveru přímo v prohlížeči.
 *
 * Zachytává volání fetch('/api/...') z app.js a odpovídá stejně jako pokladna/server.py.
 * Data jsou v localStorage tohoto prohlížeče, EET se jen předstírá (žádné spojení s finanční správou).
 * Načítá se před app.js jen v sestaveném demu (docs/), skutečná pokladna ho neobsahuje.
 */
(function () {
  'use strict';

  const KLIC = 'pokladna.demo.db';
  const REZIM_KLIC = 'pokladna.demo.rezim';   // 'sklad' = skutečný sklad z Trellu (v IndexedDB, do localStorage se nevejde)
  const VERZE = 6;
  window.POKLADNA_DEMO = true;

  const ZBOZI = [
    ['Kabel USB-C – USB-C 1 m, 60 W', '8595680412013', 'Kabely', 199, 62, 24, 'ks'],
    ['Kabel Lightning – USB-A 1 m', '8595680412020', 'Kabely', 249, 78, 15, 'ks'],
    ['Nabíječka 20 W USB-C PD', '8595680412037', 'Nabíječky', 399, 145, 9, 'ks'],
    ['Nabíječka do auta 2× USB 36 W', '8595680412044', 'Nabíječky', 349, 120, 6, 'ks'],
    ['Tvrzené sklo iPhone 15', '8595680412051', 'Ochranná skla a fólie', 299, 35, 30, 'ks'],
    ['Tvrzené sklo Samsung A55', '8595680412068', 'Ochranná skla a fólie', 299, 35, 18, 'ks'],
    ['Silikonový obal iPhone 15 černý', '8595680412075', 'Pouzdra a obaly', 349, 60, 12, 'ks'],
    ['Flip pouzdro Samsung A15', '8595680412082', 'Pouzdra a obaly', 399, 90, 7, 'ks'],
    ['Myš bezdrátová Logitech M185', '5099206027312', 'Periferie', 349, 210, 5, 'ks'],
    ['Klávesnice USB CZ/SK', '8595680412099', 'Periferie', 299, 160, 4, 'ks'],
    ['Flash disk 64 GB USB 3.2', '8595680412105', 'Paměti', 229, 120, 20, 'ks'],
    ['microSD 128 GB + adaptér', '8595680412112', 'Paměti', 399, 210, 10, 'ks'],
    ['Powerbanka 10 000 mAh', '8595680412129', 'Nabíječky', 599, 290, 3, 'ks'],
    ['UTP kabel Cat6 (metráž)', '8595680412136', 'Metráž', 15, 6, 120, 'm'],
    ['Sluchátka do uší s mikrofonem', '8595680412143', 'Audio', 249, 85, 8, 'ks'],
    ['Mobil Samsung Galaxy A15 128 GB', '8806095351234', 'Telefony', 3990, 2650, 4, 'ks'],
  ];

  // Ukázková faktura pro nahrání PDF (PDF se v demu nečte, ISDOC ano).
  const DEMO_FAKTURA = {
    dodavatel: 'Testovací Distribuce s.r.o.', dodavatel_ico: '99999991', dodavatel_dic: 'CZ99999991', cislo: 'FV2026-0815', datum: '2026-10-24',
    polozky: [
      ['Kabel USB-C - USB-C 1m 60W', 'KAB-CC-1M', '8595680412013', 10, 'ks', 6000],
      ['Tvrzené sklo iPhone 15 (bal. 10 ks)', 'TG-IP15-10', null, 2, 'bal', 30000],
      ['Myš Logitech M185 bezdrátová', 'LOG-M185', '5099206027312', 3, 'ks', 20500],
      ['Magnetický nabíjecí kabel USB-C 2 m', 'KAB-MAG-2M', '8595680412165', 5, 'ks', 9500],
      ['Silikonovy obal iPhone 15 cerny', null, null, 4, 'ks', 5800],
      ['Doprava PPL', null, null, 1, 'ks', 9900],
    ],
  };

  /* ------------------------------------------------------------------ úložiště */

  function ted() {
    const d = new Date(); const o = -d.getTimezoneOffset();
    const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(o / 60)}:${p(o % 60)}`;
  }

  function novaDb(sklad) {
    const db = {
      verze: VERZE, citace: {}, relace: null, dalsi: { zbozi: 1, prodej: 1, polozka: 1, prijemka: 1, pohyb: 1, uzivatel: 3 },
      nastaveni: {
        firma_nazev: 'PcObchod – DEMO', firma_ico: '', firma_dic: '', firma_adresa: '', provozovna: 'Ukázková prodejna', telefon: '',
        platce_dph: '1', zaokrouhlovat_hotovost: '1', uctenka_paticka: 'Děkujeme za nákup! www.pcobchod.com',
        eet_rezim: 'playground', eet_eic: 'CZ00000019', eet_id_jednotky: '303', eet_id_pokl: 'DEMO-1', eet_cert_cesta: '(demo)', eet_cert_heslo: '',
        eet_timeout_s: '3', vychozi_marze_pct: '40', ai_api_klic: '', ai_model: 'claude-opus-5-5',
        zaloha_heslo: '', zaloha_cas: '21:30', zaloha_slozka: '', zaloha_rclone_cil: '', zaloha_ponechat_lokalne: '14', zaloha_ponechat_venku: '60', zaloha_nazev: '',
        faktura_rada: 'FV', faktura_ucet: '123456789/9999', faktura_splatnost_dni: '14', faktura_pata: 'DEMO – neplatný doklad',
        smtp_server: '', smtp_port: '587', smtp_zabezpeceni: 'STARTTLS', smtp_uzivatel: '', smtp_heslo: '', smtp_odesilatel: '', uzaverka_prijemci: '', uzaverka_auto_cas: '',
        rada_zalohova: 'ZF', rada_ddzp: 'DP', rada_opravny: 'OD', rada_nabidka: 'NA', nabidka_platnost_dni: '14', ucetni_email: '',
        zarucni_podminky: 'Záruka se nevztahuje na vady způsobené mechanickým poškozením, vodou, neodborným zásahem nebo běžným opotřebením. Reklamaci uplatněte v prodejně s tímto listem nebo dokladem o koupi.',
        servis_podminky: 'Zákazník souhlasí s provedením diagnostiky. Opravu nad odsouhlasenou částku provedeme jen po jeho souhlasu. Za data v zařízení neručíme, doporučujeme zálohu. Zařízení nevyzvednuté do 6 měsíců od výzvy k vyzvednutí můžeme prodat (§ 2428 občanského zákoníku).',
        servis_lhuta_dni: '30', stitek_format: '50x30',
      },
      uzivatele: [
        { id: 1, jmeno: 'Šéf (demo)', pin: '1234', role: 'SPRAVCE', aktivni: 1, vytvoreno: ted() },
        { id: 2, jmeno: 'Prodavač (demo)', pin: '1111', role: 'PRODAVAC', aktivni: 1, vytvoreno: ted() },
      ],
      zbozi: [], eany: {}, prodeje: [], polozky: [], prijemky: [], prijemka_polozky: [], pohyby: [], dodavatel_kody: {},
      odberatele: [], faktury: [], faktura_polozky: [], vydejky: [], vydejka_polozky: [],
      pokladni_doklady: [], pocitani: [], serie: [], servis: [], servis_polozky: [], servis_historie: [],
    };
    db.dalsi.vydejka = 1;
    Object.assign(db.dalsi, { pokl: 1, poc: 1, serie: 1, servis: 1, spol: 1, shist: 1 });
    db.dalsi.odberatel = 1; db.dalsi.faktura = 1; db.dalsi.fpol = 1;
    if (sklad) naplnSklad(db, sklad);
    else {
      for (const [nazev, ean, kat, cena, nakup, , jed] of ZBOZI) {
        const id = db.dalsi.zbozi++;
        db.zbozi.push({ id, nazev, kod: null, kategorie: kat, cena: cena * 100, sazba_dph: 21, nakupni_cena: nakup * 100, jednotka: jed,
          stav: 0, min_stav: jed === 'ks' ? 2 : 20, aktivni: 1, poznamka: null, vytvoreno: ted(), upraveno: ted(), seriova_cisla: kat === 'Telefony' ? 1 : 0, zaruka_mesice: 24 });
        db.eany[ean] = id;
      }
      // Dva starší nákupy od dodavatelů, ať je na kartě zboží vidět historie nákupních cen. Zbytek stavu je inventura.
      ukazkovaPrijemka(db, 45, 'Testovací Distribuce s.r.o.', '99999991', 'FV2026-0612', [[1, 10, 5800], [3, 5, 13900], [5, 20, 3200], [9, 3, 21000]]);
      ukazkovaPrijemka(db, 14, 'Ukázkový velkoobchod s.r.o.', '99999992', '2026-1187', [[1, 10, 6200], [3, 4, 14500], [5, 10, 3500], [16, 4, 265000]]);
      ZBOZI.forEach(([, , , , , stav], i) => { const z = db.zbozi[i]; if (stav - z.stav) pohyb(db, z.id, stav - z.stav, 'KOREKCE', 'demo', null, 'ukázková data'); });
    }
    // Dvě ukázkové účtenky, ať účtenky a uzávěrka nejsou prázdné.
    db.relace = 2;
    vlozPokladniDoklad(db, 'PRIJEM', 'POCATECNI', 200000, 'Počáteční stav', null, 1);
    const pred = (dni) => { const d = new Date(); d.setDate(d.getDate() - dni); return d.toISOString().slice(0, 10); };
    if (!sklad) {
      prodej(db, { platba: 'HOTOVE', prijato: 100000, polozky: [{ zbozi_id: 1, mnozstvi: 2 }, { zbozi_id: 5, mnozstvi: 1 }] });
      prodej(db, { platba: 'KARTA', polozky: [{ zbozi_id: 13, mnozstvi: 1 }] });
      // Ukázkový kontakt a dvě faktury převodem: jedna po splatnosti, jedna uhrazená.
      const o = { id: db.dalsi.odberatel++, nazev: 'Ukázková firma s.r.o.', ico: '12345678', dic: 'CZ12345678', ulice: 'Náměstí 1', psc: '408 01', mesto: 'Rumburk', email: 'nakup@example.com', telefon: null, poznamka: null, vytvoreno: ted(), upraveno: ted() };
      db.odberatele.push(o);
      fakturaPrevodem(db, o, [{ zbozi_id: 9, mnozstvi: 2 }, { zbozi_id: 10, mnozstvi: 2 }], pred(20), null);
      fakturaPrevodem(db, o, [{ zbozi_id: 12, mnozstvi: 3 }], pred(10), pred(3));
      novaFaktura(db, o, { typ: 'NABIDKA', vystaveni: pred(2), splatnost: plus(pred(2), 14), forma: 'PREVOD', stav: 'NEUHRAZENO',
        radky: radkyDokladu(db, [{ zbozi_id: 16, mnozstvi: 3 }, { nazev: 'Přenos dat a nastavení telefonu', mnozstvi: 3, cena: 30000, sazba_dph: 21 }], false, false) });
    }
    // Ukázkové zakázky v servisu: oprava a reklamace.
    novaZakazka(db, { typ: 'OPRAVA', zakaznik: 'Petr Ukázkový', telefon: '777 000 111', zarizeni: 'iPhone 12 černý', sn: '353000000000001',
      zavada: 'Prasklý displej, dotyk funguje', vzhled: 'oděrky na rámu', prislusenstvi: 'bez příslušenství', odhad: 290000, max_cena: 350000 }, 1);
    novaZakazka(db, { typ: 'REKLAMACE', zakaznik: 'Jana Ukázková', telefon: '603 000 222', zarizeni: 'Sluchátka do uší s mikrofonem', zavada: 'Nehraje levé sluchátko',
      pozadavek: 'výměna za nové', datum_koupe: pred(40), doklad_koupe: 'účtenka 2026-000123' }, 2);
    db.relace = null;
    return db;
  }

  // Skutečný sklad z Trellu (rozšifrovaný soubor sklad-varnsdorf.enc) zapíše stejně jako import v pokladně.
  function naplnSklad(db, s) {
    const i = Object.fromEntries(s.sloupce.map((n, k) => [n, k]));
    const cas = ted();
    Object.assign(db.nastaveni, { firma_nazev: 'PcObchod Vdf s.r.o. – DEMO', provozovna: `Prodejna ${s.prodejna} – sklad z Trellu ${new Date(s.export * 1000).toLocaleDateString('cs-CZ')}` });
    for (const r of s.zbozi) {
      const id = db.dalsi.zbozi++;
      db.zbozi.push({ id, nazev: r[i.nazev], kod: r[i.kod], kategorie: r[i.kategorie], cena: r[i.cena], sazba_dph: 21, nakupni_cena: null, jednotka: 'ks',
        stav: r[i.stav], min_stav: 0, aktivni: 1, poznamka: r[i.poznamka], vytvoreno: cas, upraveno: cas, seriova_cisla: r[i.seriova_cisla], zaruka_mesice: 24 });
      r[i.eany].forEach((e) => { db.eany[e] = id; });
      if (r[i.stav]) db.pohyby.push({ id: db.dalsi.pohyb++, cas, zbozi_id: id, mnozstvi: r[i.stav], typ: 'KOREKCE', doklad: 'import Trell', uzivatel_id: null, poznamka: 'stav z Trellu', stav_po: r[i.stav] });
    }
    db.zdroj = { prodejna: s.prodejna, export: s.export };
  }

  async function rozsifrujSklad(heslo) {
    const r = await puvodniFetch('static/sklad-varnsdorf.enc', { cache: 'no-cache' });
    if (!r.ok) throw new Error('Soubor se skladem se nepodařilo stáhnout.');
    const b = new Uint8Array(await r.arrayBuffer());
    if (new TextDecoder().decode(b.slice(0, 4)) !== 'PKS1') throw new Error('Neznámý formát souboru se skladem.');
    if (!window.crypto || !crypto.subtle || !window.DecompressionStream) throw new Error('Tento prohlížeč je na rozšifrování skladu moc starý, zkuste aktuální Chrome nebo Safari.');
    // Stejně jako zasifruj_sklad_demo.py: nezáleží na velikosti písmen, mezerách, pomlčkách ani na číslicích psaných bez Shiftu (ě š č…).
    const ciste = [...heslo.normalize('NFC').toLowerCase()].map((c) => { const i = '+ěščřžýáíé'.indexOf(c); return i < 0 ? c : '1234567890'[i]; })
      .filter((c) => !/[\s\-_.]/.test(c)).join('');
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(ciste), 'PBKDF2', false, ['deriveKey']);
    const klic = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b.slice(4, 20), iterations: 600000, hash: 'SHA-256' }, material,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let gz;
    try { gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(20, 32) }, klic, b.slice(32)); } catch { throw new Error('Špatné heslo. Zkontrolujte ho přes „Zobrazit heslo“.'); }
    return JSON.parse(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  }

  function idb(akce, hodnota) {
    return new Promise((ok, chyba) => {
      const r = indexedDB.open('pokladna-demo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('db');
      r.onerror = () => chyba(r.error);
      r.onsuccess = () => {
        const t = r.result.transaction('db', akce === 'get' ? 'readonly' : 'readwrite');
        const s = t.objectStore('db');
        const q = akce === 'get' ? s.get('db') : akce === 'put' ? s.put(hodnota, 'db') : s.clear();
        t.oncomplete = () => { r.result.close(); ok(q.result); };
        t.onerror = t.onabort = () => { r.result.close(); chyba(t.error); };
      };
    });
  }
  const skladovyRezim = () => { try { return localStorage.getItem(REZIM_KLIC) === 'sklad'; } catch { return false; } };

  function ukazkovaPrijemka(db, predDny, dodavatel, ico, doklad, radky) {
    const d = new Date(); d.setDate(d.getDate() - predDny); d.setHours(10, 15, 0, 0);
    const cas = ted().replace(/^.{19}/, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T10:15:00`);
    const cislo = `P${cas.slice(0, 4)}-${String(dalsiCislo(db, 'prijemka-' + cas.slice(0, 4))).padStart(5, '0')}`;
    const id = db.dalsi.prijemka++;
    db.prijemky.push({ id, cislo, cas, uzivatel_id: 1, dodavatel, dodavatel_ico: ico, doklad, poznamka: null, soubor_id: null, stornovano: 0,
      celkem_bez_dph: radky.reduce((s, [, q, c]) => s + q * c, 0) });
    for (const [zid, q, c] of radky) {
      const z = db.zbozi.find((x) => x.id === zid);
      db.prijemka_polozky.push({ prijemka_id: id, zbozi_id: zid, mnozstvi: q, nakupni_cena: c });
      z.stav += q;
      db.pohyby.push({ id: db.dalsi.pohyb++, cas, zbozi_id: zid, mnozstvi: q, typ: 'PRIJEM', doklad: cislo, uzivatel_id: 1, poznamka: doklad, stav_po: z.stav });
    }
  }

  // Historie zboží pro kartu zboží (stejně jako _historie_zbozi v server.py).
  function historieDemo(z) {
    const jmeno = (uid) => (DB.uzivatele.find((u) => u.id === uid) || {}).jmeno || null;
    const nakupy = DB.prijemka_polozky.filter((x) => x.zbozi_id === z.id).map((x) => {
      const pr = DB.prijemky.find((y) => y.id === x.prijemka_id) || {};
      return { prijemka_id: pr.id, cislo: pr.cislo, cas: pr.cas, dodavatel: pr.dodavatel, dodavatel_ico: pr.dodavatel_ico, doklad: pr.doklad, soubor_id: null,
        stornovano: pr.stornovano || 0, mnozstvi: x.mnozstvi, nakupni_cena: x.nakupni_cena, uzivatel: jmeno(pr.uzivatel_id) };
    }).sort((a, b) => b.cas.localeCompare(a.cas) || b.prijemka_id - a.prijemka_id).slice(0, 200);
    const platne = nakupy.filter((n) => !n.stornovano && n.nakupni_cena != null && n.mnozstvi > 0);
    const kusu = platne.reduce((s, n) => s + n.mnozstvi, 0);
    const ceny = platne.map((n) => n.nakupni_cena);
    const souhrn = { pocet: platne.length, kusu, posledni: platne[0] || null,
      prumer: kusu ? Math.round(platne.reduce((s, n) => s + n.nakupni_cena * n.mnozstvi, 0) / kusu) : null,
      min: ceny.length ? Math.min(...ceny) : null, max: ceny.length ? Math.max(...ceny) : null,
      dodavatelu: new Set(platne.map((n) => (n.dodavatel_ico || n.dodavatel || '').trim().toLowerCase())).size };
    const uctenky = DB.polozky.filter((x) => x.zbozi_id === z.id).map((x) => {
      const p = DB.prodeje.find((y) => y.id === x.prodej_id);
      return { zdroj: 'UCTENKA', id: p.id, cislo: p.cislo, cas: p.cas, typ: p.typ, stornovano: p.stornovano ? 1 : 0, mnozstvi: x.mnozstvi, cena: x.cena, celkem: x.celkem, odberatel: null };
    });
    const faktury = DB.faktura_polozky.filter((x) => x.zbozi_id === z.id).map((x) => [x, DB.faktury.find((f) => f.id === x.faktura_id)])
      .filter(([, f]) => f && ['FAKTURA', 'OPRAVNY'].includes(f.typ) && !f.prodej_id)
      .map(([x, f]) => ({ zdroj: 'FAKTURA', id: f.id, cislo: f.cislo, cas: f.datum_vystaveni + 'T12:00:00', typ: f.typ, stornovano: f.stav === 'STORNO' ? 1 : 0,
        mnozstvi: x.mnozstvi, cena: x.cena, celkem: x.celkem, odberatel: f.odb_nazev }));
    const prodeje = [...uctenky, ...faktury].sort((a, b) => b.cas.localeCompare(a.cas)).slice(0, 100);
    const od = (dni) => { const d = new Date(); d.setDate(d.getDate() - dni); return d.toISOString().slice(0, 10); };
    const prodano = (o) => prodeje.filter((x) => x.cas >= o && !x.stornovano && x.typ !== 'STORNO').reduce((s, x) => s + x.mnozstvi, 0);
    return { nakupy, nakupy_souhrn: souhrn, prodeje, prodano_30: prodano(od(30)), prodano_365: prodano(od(365)),
      posledni_prodej: (prodeje.find((x) => x.typ !== 'STORNO' && x.mnozstvi > 0) || {}).cas || null };
  }

  let DB;
  let revEany = null;   // zboží → jeho EANy; počítá se jednou za požadavek (sklad z Trellu má přes 13 000 EANů)
  function nacti() {
    try { const d = JSON.parse(localStorage.getItem(KLIC)); if (d && d.verze === VERZE) return d; } catch { /* nové demo */ }
    return novaDb();
  }
  function uloz(metoda) {
    if (DB.zdroj) { if (metoda !== 'GET') idb('put', DB).catch((e) => console.error('Demo: sklad se neuložil', e)); return; }
    try { localStorage.setItem(KLIC, JSON.stringify(DB)); } catch { /* bez úložiště demo jede jen do obnovení stránky */ }
  }

  /* ------------------------------------------------------------------ pomocné */

  class Chyba { constructor(status, detail) { this.status = status; this.detail = detail; } }
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const zaokrouhliKc = (h) => Math.sign(h) * Math.floor((Math.abs(h) + 50) / 100) * 100;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));
  const dalsiCislo = (db, rada) => { db.citace[rada] = (db.citace[rada] || 0) + 1; return db.citace[rada]; };
  const ja = () => DB.uzivatele.find((u) => u.id === DB.relace && u.aktivni);
  function prihlasen() { const u = ja(); if (!u) throw new Chyba(401, 'Nepřihlášen'); return u; }
  function spravce() { const u = prihlasen(); if (u.role !== 'SPRAVCE') throw new Chyba(403, 'Jen pro správce'); return u; }
  const zbozi = (id) => DB.zbozi.find((z) => z.id === id);
  const eanyZbozi = (id) => {
    if (!revEany) { revEany = {}; for (const [e, z] of Object.entries(DB.eany)) (revEany[z] = revEany[z] || []).push(e); }
    return revEany[id] || [];
  };
  const KOLATOR = new Intl.Collator('cs');
  const zboziDict = (z) => ({ ...z, eany: eanyZbozi(z.id) });

  function pohyb(db, zid, mnozstvi, typ, doklad, uid, poznamka) {
    const z = db.zbozi.find((x) => x.id === zid);
    z.stav = Math.round((z.stav + mnozstvi) * 1000) / 1000; z.upraveno = ted();
    db.pohyby.push({ id: db.dalsi.pohyb++, cas: ted(), zbozi_id: zid, mnozstvi, typ, doklad, uzivatel_id: uid, poznamka: poznamka || null, stav_po: z.stav });
  }

  function eetOdesli(p) {
    if (p.eet_stav === 'VYPNUTO') return;
    Object.assign(p, { eet_stav: 'OK', eet_pok: `${uuid()}-ff`, eet_uuid: uuid(), eet_test: 1, eet_pokusy: p.eet_pokusy + 1, eet_posledni_pokus: ted(), eet_chyba: null });
  }

  function plusMesice(iso, m) {
    const d = new Date(iso.slice(0, 10) + 'T12:00:00'); const den = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + m);
    d.setDate(Math.min(den, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return d.toISOString().slice(0, 10);
  }
  function zapisSerie(db, r, serie, zaruka, cas, vazba) {
    (serie || []).forEach((sn) => db.serie.push({ id: db.dalsi.serie++, sn, zbozi_id: r.zbozi_id, nazev: r.nazev, prodej_id: null, faktura_id: null, ...vazba,
      cas, zaruka_do: zaruka ? plusMesice(cas, zaruka) : null }));
  }

  function prodejDict(p) {
    const u = DB.uzivatele.find((x) => x.id === p.uzivatel_id);
    const f = (DB.faktury || []).find((x) => x.prodej_id === p.id);
    const polozky = DB.polozky.filter((i) => i.prodej_id === p.id).map((i) => ({ ...i, zaruka_mesice: i.zbozi_id ? (zbozi(i.zbozi_id) || {}).zaruka_mesice : null }));
    const serie = DB.serie.filter((x) => x.prodej_id === (p.storno_k || p.id)).map(({ sn, zbozi_id, nazev, zaruka_do }) => ({ sn, zbozi_id, nazev, zaruka_do }));
    return { ...p, prodavac: u ? u.jmeno : null, eet_varovani: [], polozky, serie, faktura: f ? { id: f.id, cislo: f.cislo } : null };
  }

  function novaUctenka(db, data) {
    const n = db.nastaveni; const cas = ted(); const rok = cas.slice(0, 4);
    const rezim = n.eet_rezim || 'vypnuto';
    return { id: db.dalsi.prodej++, cislo: `${rok}-${String(dalsiCislo(db, 'prodej-' + rok)).padStart(6, '0')}`, cas, uzivatel_id: db.relace,
      typ: 'PRODEJ', storno_k: null, stornovano: 0, eet_stav: rezim === 'vypnuto' ? 'VYPNUTO' : 'CEKA', eet_rezim: rezim, eet_eic: n.eet_eic,
      eet_jednotka: +n.eet_id_jednotky || null, eet_pokl: n.eet_id_pokl, eet_pok: null, eet_uuid: null, eet_test: null, eet_pokusy: 0,
      eet_posledni_pokus: null, eet_chyba: null, eet_transaction_id: null, ...data };
  }

  function prodej(db, data) {
    if (!data.polozky || !data.polozky.length) throw new Chyba(400, 'Prázdný nákup');
    const radky = [];
    for (const pol of data.polozky) {
      if (!pol.mnozstvi) continue;
      if (Math.abs(pol.mnozstvi) > 99999) throw new Chyba(422, 'Nesmyslné množství');
      if (pol.zbozi_id != null) {
        const z = db.zbozi.find((x) => x.id === pol.zbozi_id);
        if (!z) throw new Chyba(400, `Zboží ${pol.zbozi_id} neexistuje`);
        const cena = pol.cena == null ? z.cena : pol.cena;
        const serie = (pol.serie || []).map((x) => String(x).trim()).filter(Boolean);
        if (z.seriova_cisla && pol.mnozstvi > 0 && serie.length !== Math.round(pol.mnozstvi)) throw new Chyba(400, `U „${z.nazev}“ načtěte sériové číslo / IMEI každého kusu (${serie.length} z ${pol.mnozstvi})`);
        radky.push({ zbozi_id: z.id, nazev: z.nazev, ean: Object.keys(db.eany).find((e) => db.eany[e] === z.id) || null,
          mnozstvi: Math.round(pol.mnozstvi * 1000) / 1000, cena, puvodni_cena: cena !== z.cena ? z.cena : null, sazba_dph: z.sazba_dph,
          _serie: pol.mnozstvi > 0 ? serie : [], _zaruka: z.zaruka_mesice || 0 });
      } else {
        if (!pol.nazev || pol.cena == null) throw new Chyba(400, 'Položka mimo katalog potřebuje název a cenu');
        radky.push({ zbozi_id: null, nazev: pol.nazev.trim(), ean: null, mnozstvi: Math.round(pol.mnozstvi * 1000) / 1000, cena: pol.cena,
          puvodni_cena: null, sazba_dph: pol.sazba_dph == null ? 21 : pol.sazba_dph });
      }
    }
    if (!radky.length) throw new Chyba(400, 'Prázdný nákup');
    radky.forEach((r) => { r.celkem = Math.round(r.cena * r.mnozstvi); });
    const mezisoucet = radky.reduce((s, r) => s + r.celkem, 0);
    let celkem = mezisoucet; let prijato = null; let vraceno = null;
    if (data.platba === 'HOTOVE' && db.nastaveni.zaokrouhlovat_hotovost === '1') celkem = zaokrouhliKc(mezisoucet);
    if (data.platba === 'HOTOVE') {
      prijato = data.prijato != null ? data.prijato : Math.max(celkem, 0);
      if (celkem > 0 && prijato < celkem) throw new Chyba(400, 'Přijatá hotovost je nižší než částka k úhradě');
      vraceno = prijato - celkem;
    }
    const p = novaUctenka(db, { platba: data.platba, mezisoucet, zaokrouhleni: celkem - mezisoucet, celkem, prijato, vraceno });
    db.prodeje.push(p);
    for (const { _serie, _zaruka, ...r } of radky) {
      db.polozky.push({ id: db.dalsi.polozka++, prodej_id: p.id, ...r });
      if (r.zbozi_id != null) pohyb(db, r.zbozi_id, -r.mnozstvi, 'PRODEJ', p.cislo, db.relace);
      zapisSerie(db, r, _serie, _zaruka, p.cas, { prodej_id: p.id });
    }
    eetOdesli(p);
    return p;
  }

  /* ------------------------------------------------------------------ vydané faktury */

  function radkyDokladu(db, polozky, pdp = false, seriePovinne = true) {
    return polozky.filter((p) => p.mnozstvi).map((p) => {
      if (p.zbozi_id != null) {
        const z = db.zbozi.find((x) => x.id === p.zbozi_id); if (!z) throw new Chyba(400, `Zboží ${p.zbozi_id} neexistuje`);
        const katalog = pdp ? Math.round(z.cena / (1 + z.sazba_dph / 100)) : z.cena;
        const cena = p.cena == null ? katalog : p.cena;
        const serie = (p.serie || []).filter(Boolean);
        if (seriePovinne && z.seriova_cisla && p.mnozstvi > 0 && serie.length !== Math.round(p.mnozstvi)) throw new Chyba(400, `U „${z.nazev}“ načtěte sériové číslo / IMEI každého kusu`);
        return { zbozi_id: z.id, nazev: z.nazev, mnozstvi: p.mnozstvi, jednotka: z.jednotka, cena, sazba_dph: z.sazba_dph, celkem: Math.round(cena * p.mnozstvi), _serie: serie, _zaruka: z.zaruka_mesice || 0 };
      }
      if (!p.nazev || p.cena == null) throw new Chyba(400, 'Položka mimo katalog potřebuje název a cenu');
      return { zbozi_id: null, nazev: p.nazev, mnozstvi: p.mnozstvi, jednotka: 'ks', cena: p.cena, sazba_dph: p.sazba_dph ?? 21, celkem: Math.round(p.cena * p.mnozstvi) };
    });
  }
  const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const adresa = (o) => [o.ulice, [o.psc, o.mesto].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  const RADY = { FAKTURA: ['faktura_rada', 'FV'], ZALOHOVA: ['rada_zalohova', 'ZF'], DDZP: ['rada_ddzp', 'DP'], OPRAVNY: ['rada_opravny', 'OD'], NABIDKA: ['rada_nabidka', 'NA'] };
  const PREDCISLI_VS = { ZALOHOVA: '9', OPRAVNY: '8', NABIDKA: '7', DDZP: '6' };

  function novaFaktura(db, o, data) {
    const typ = data.typ || 'FAKTURA';
    const rok = data.vystaveni.slice(0, 4);
    const n = dalsiCislo(db, typ === 'FAKTURA' ? 'faktura-' + rok : `doklad-${typ}-${rok}`);
    const cislo = `${db.nastaveni[RADY[typ][0]] || RADY[typ][1]}${rok}${String(n).padStart(4, '0')}`;
    const vs = data.vs || (typ === 'FAKTURA' ? cislo.replace(/\D/g, '').slice(-10) : `${PREDCISLI_VS[typ]}${rok.slice(2)}${String(n).padStart(5, '0')}`);
    const dni = +(typ === 'NABIDKA' ? db.nastaveni.nabidka_platnost_dni : db.nastaveni.faktura_splatnost_dni) || 14;
    const f = { id: db.dalsi.faktura++, cislo, vs, odberatel_id: o.id || null, odb_nazev: o.nazev, odb_ico: o.ico || null, odb_dic: o.dic || null,
      odb_adresa: o.odb_adresa || adresa(o), odb_email: o.email || o.odb_email || null, datum_vystaveni: data.vystaveni, duzp: data.duzp || data.vystaveni,
      splatnost: data.splatnost || plus(data.vystaveni, dni), forma_uhrady: data.forma, poznamka: data.poznamka || null,
      celkem: data.radky.reduce((s, r) => s + r.celkem, 0), stav: data.stav, datum_uhrady: data.uhrazeno || null, prodej_id: data.prodej_id || null,
      uzivatel_id: db.relace, vytvoreno: ted(), odeslano: null, typ, vazba_id: data.vazba_id || null, pdp: data.pdp ? 1 : 0, duvod_opravy: data.duvod_opravy || null,
      upominek: 0, posledni_upominka: null };
    db.faktury.push(f);
    data.radky.forEach(({ _serie, _zaruka, ...r }) => {
      db.faktura_polozky.push({ id: db.dalsi.fpol++, faktura_id: f.id, ...r });
      if (data.serie) zapisSerie(db, r, _serie, _zaruka, ted(), { faktura_id: f.id });
    });
    return f;
  }

  function fakturaPrevodem(db, o, polozky, vystaveni, uhrazeno) {
    const radky = radkyDokladu(db, polozky);
    const f = novaFaktura(db, o, { vystaveni, forma: 'PREVOD', radky, stav: uhrazeno ? 'UHRAZENO' : 'NEUHRAZENO', uhrazeno, serie: true });
    radky.forEach((r) => { if (r.zbozi_id != null) pohyb(db, r.zbozi_id, -r.mnozstvi, 'PRODEJ', f.cislo, db.relace, 'faktura'); });
    return f;
  }

  function rekap(polozky, pdp = false) {
    const m = {}; polozky.forEach((p) => { m[p.sazba_dph] = (m[p.sazba_dph] || 0) + p.celkem; });
    return Object.keys(m).sort((a, b) => b - a).map((s) => { const c = m[s]; const z = pdp ? c : Math.round(c / (1 + s / 100)); return { sazba: +s, zaklad: z, dph: c - z, celkem: c }; });
  }

  function ibanZUctu(ucet) {
    const m = String(ucet || '').replace(/\s/g, '').match(/^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/);
    if (!m) return null;
    const bban = m[3] + (m[1] || '').padStart(6, '0') + m[2].padStart(10, '0');
    return 'CZ' + String(98 - [...(bban + '123500')].reduce((r, c) => (r * 10 + +c) % 97, 0)).padStart(2, '0') + bban;
  }

  const poSplatnosti = (f) => ['FAKTURA', 'ZALOHOVA'].includes(f.typ) && f.stav === 'NEUHRAZENO' && f.splatnost < ted().slice(0, 10);
  function fakturaDict(f) {
    const polozky = DB.faktura_polozky.filter((p) => p.faktura_id === f.id);
    const p = f.prodej_id ? DB.prodeje.find((x) => x.id === f.prodej_id) : null;
    const iban = ibanZUctu(DB.nastaveni.faktura_ucet);
    const v = f.vazba_id ? DB.faktury.find((x) => x.id === f.vazba_id) : null;
    const navazne = DB.faktury.filter((x) => x.vazba_id === f.id).map(({ id, cislo, typ, datum_vystaveni, celkem, stav }) => ({ id, cislo, typ, datum_vystaveni, celkem, stav }));
    return { ...f, polozky, dph: rekap(polozky, !!f.pdp), vystavil: (DB.uzivatele.find((u) => u.id === f.uzivatel_id) || {}).jmeno || null, prodejka: p ? p.cislo : null,
      po_splatnosti: poSplatnosti(f), iban, qr: !!(iban && ['FAKTURA', 'ZALOHOVA'].includes(f.typ) && f.forma_uhrady === 'PREVOD' && f.stav === 'NEUHRAZENO' && f.celkem > 0),
      vazba: v ? { id: v.id, cislo: v.cislo, typ: v.typ, datum_vystaveni: v.datum_vystaveni, duzp: v.duzp, celkem: v.celkem, stav: v.stav } : null, navazne,
      k_uhrade: f.celkem + navazne.filter((x) => x.typ === 'OPRAVNY' && x.stav !== 'STORNO').reduce((s, x) => s + x.celkem, 0) };
  }

  function uhrad(f, datum) {
    Object.assign(f, { stav: 'UHRAZENO', datum_uhrady: datum });
    if (f.typ !== 'ZALOHOVA' || DB.nastaveni.platce_dph !== '1' || DB.faktury.some((x) => x.vazba_id === f.id && x.typ === 'DDZP')) return;
    const radky = DB.faktura_polozky.filter((p) => p.faktura_id === f.id).map(({ nazev, mnozstvi, jednotka, cena, sazba_dph, celkem }) => ({ zbozi_id: null, nazev, mnozstvi, jednotka, cena, sazba_dph, celkem }));
    novaFaktura(DB, { id: f.odberatel_id, nazev: f.odb_nazev, ico: f.odb_ico, dic: f.odb_dic, odb_adresa: f.odb_adresa, odb_email: f.odb_email },
      { typ: 'DDZP', vystaveni: ted().slice(0, 10), duzp: datum, splatnost: datum, forma: f.forma_uhrady, radky, stav: 'UHRAZENO', uhrazeno: datum, vazba_id: f.id, vs: f.vs });
  }

  /* ------------------------------------------------------------------ pokladní kniha */

  const DRUHY_POKL = { POCATECNI: ['PRIJEM', 'Počáteční stav'], VKLAD: ['PRIJEM', 'Vklad do pokladny'], VYBER: ['VYDEJ', 'Výběr z pokladny'], ODVOD: ['VYDEJ', 'Odvod tržby'],
    NAKUP: ['VYDEJ', 'Nákup za hotové'], ROZDIL: [null, 'Rozdíl při počítání'], JINE: [null, 'Jiný pohyb'] };
  function vlozPokladniDoklad(db, typ, druh, castka, ucel, osoba, uid) {
    const cas = ted(); const pref = typ === 'PRIJEM' ? 'PP' : 'VP';
    const d = { id: db.dalsi.pokl++, cislo: `${pref}${cas.slice(0, 4)}-${String(dalsiCislo(db, `pokl-${pref}-${cas.slice(0, 4)}`)).padStart(5, '0')}`, cas, typ, druh, castka,
      ucel: ucel || DRUHY_POKL[druh][1], osoba: osoba || null, uzivatel_id: uid, stornovano: 0 };
    db.pokladni_doklady.push(d); return d;
  }
  function stavPokladny(pred) {
    const trzby = DB.prodeje.filter((p) => p.platba === 'HOTOVE' && (!pred || p.cas < pred)).reduce((s, p) => s + p.celkem, 0);
    return trzby + DB.pokladni_doklady.filter((d) => !d.stornovano && (!pred || d.cas < pred)).reduce((s, d) => s + (d.typ === 'PRIJEM' ? d.castka : -d.castka), 0);
  }
  const pocitaniDict = (c) => ({ ...c, rozdil: c.spocitano - c.ocekavano, uzivatel: (DB.uzivatele.find((u) => u.id === c.uzivatel_id) || {}).jmeno || null });
  function denPokladny(datum) {
    const zitra = plus(datum, 1);
    const dok = DB.pokladni_doklady.filter((d) => !d.stornovano && d.cas.startsWith(datum));
    const poc = DB.pocitani.filter((c) => c.cas.startsWith(datum)).pop();
    return { datum, rano: stavPokladny(datum), trzby: DB.prodeje.filter((p) => p.platba === 'HOTOVE' && p.cas.startsWith(datum)).reduce((s, p) => s + p.celkem, 0),
      prijmy: dok.filter((d) => d.typ === 'PRIJEM').reduce((s, d) => s + d.castka, 0), vydaje: dok.filter((d) => d.typ === 'VYDEJ').reduce((s, d) => s + d.castka, 0),
      vecer: stavPokladny(zitra), pocitani: poc ? pocitaniDict(poc) : null };
  }
  const pokladniDict = (d) => ({ ...d, druh_text: (DRUHY_POKL[d.druh] || [null, d.druh])[1], uzivatel: (DB.uzivatele.find((u) => u.id === d.uzivatel_id) || {}).jmeno || null });

  /* ------------------------------------------------------------------ servis */

  const STAVY_SV = { PRIJATO: 'Přijato', DIAGNOSTIKA: 'Diagnostika', CEKA_ZAKAZNIK: 'Čeká na souhlas zákazníka', CEKA_DIL: 'Čeká na díl', V_OPRAVE: 'V opravě',
    U_DODAVATELE: 'U dodavatele / výrobce', HOTOVO: 'Připraveno k vyzvednutí', VYDANO: 'Vydáno', ZRUSENO: 'Zrušeno' };
  const AKTIVNI_SV = ['PRIJATO', 'DIAGNOSTIKA', 'CEKA_ZAKAZNIK', 'CEKA_DIL', 'V_OPRAVE', 'U_DODAVATELE', 'HOTOVO'];
  const VYRIZENI_SV = { OPRAVA: 'Uznána – opraveno', VYMENA: 'Uznána – vyměněno za nové', SLEVA: 'Uznána – přiměřená sleva', VRACENI_PENEZ: 'Uznána – vráceny peníze',
    ZAMITNUTO: 'Zamítnuta', OPRAVENO: 'Opraveno', NEOPRAVITELNE: 'Nelze opravit', ODMITNUTO: 'Zákazník opravu odmítl' };
  const POLE_SV = ['zakaznik', 'telefon', 'email', 'zarizeni', 'sn', 'prislusenstvi', 'vzhled', 'heslo', 'zavada', 'pozadavek', 'odhad', 'max_cena', 'termin', 'prodej_id',
    'doklad_koupe', 'datum_koupe', 'technik_id', 'dodavatel', 'dodavatel_rma', 'vyjadreni', 'poznamka', 'odberatel_id'];
  const dniDo = (iso) => Math.round((new Date(iso.slice(0, 10) + 'T12:00:00') - new Date(ted().slice(0, 10) + 'T12:00:00')) / 864e5);
  function historie(db, zid, uid, stav, text) { db.servis_historie.push({ id: db.dalsi.shist++, zakazka_id: zid, cas: ted(), uzivatel_id: uid, stav, text }); const z = db.servis.find((x) => x.id === zid); if (z) z.upraveno = ted(); }
  function novaZakazka(db, b, uid) {
    const cas = ted(); const rekl = b.typ === 'REKLAMACE';
    const z = { id: db.dalsi.servis++, cislo: `${rekl ? 'R' : 'S'}${cas.slice(0, 4)}-${String(dalsiCislo(db, `servis-${b.typ}-${cas.slice(0, 4)}`)).padStart(5, '0')}`, typ: b.typ, stav: 'PRIJATO',
      prijato: cas, lhuta: rekl ? plus(cas.slice(0, 10), +db.nastaveni.servis_lhuta_dni || 30) : null, uzivatel_id: uid, upraveno: cas, zaloha: 0, odeslano_dodavateli: null,
      vraceno_od_dodavatele: null, vyrizeni: null, vyrizeno: null, vydano: null, vydal_id: null, prodej_vydani_id: null, faktura_id: null, vydejka_id: null };
    POLE_SV.forEach((k) => { const v = b[k]; z[k] = typeof v === 'string' ? (v.trim() || null) : (v ?? null); });
    db.servis.push(z);
    historie(db, z.id, uid, 'PRIJATO', rekl ? 'Reklamace uplatněna' : 'Zakázka přijata');
    return z;
  }
  function zakazkaDict(z) {
    const jm = (id) => (DB.uzivatele.find((u) => u.id === id) || {}).jmeno || null;
    const polozky = DB.servis_polozky.filter((p) => p.zakazka_id === z.id).map((p) => ({ ...p, celkem: Math.round(p.cena * p.mnozstvi) }));
    const celkem = polozky.reduce((s, p) => s + p.celkem, 0);
    const pk = z.prodej_id ? DB.prodeje.find((p) => p.id === z.prodej_id) : null;
    const pv = z.prodej_vydani_id ? DB.prodeje.find((p) => p.id === z.prodej_vydani_id) : null;
    const d = { ...z, prijal: jm(z.uzivatel_id), technik: jm(z.technik_id), vydal: jm(z.vydal_id), prodejka_koupe: pk ? pk.cislo : null, cas_koupe: pk ? pk.cas : null,
      prodejka_vydani: pv ? pv.cislo : null, faktura: z.faktura_id ? (DB.faktury.find((f) => f.id === z.faktura_id) || {}).cislo : null,
      vydejka: z.vydejka_id ? (DB.vydejky.find((v) => v.id === z.vydejka_id) || {}).cislo : null,
      polozky, celkem, doplatit: celkem - (z.zaloha || 0), stav_text: STAVY_SV[z.stav], vyrizeni_text: VYRIZENI_SV[z.vyrizeni] || '',
      historie: DB.servis_historie.filter((h) => h.zakazka_id === z.id).slice().reverse().map((h) => ({ ...h, uzivatel: jm(h.uzivatel_id) })),
      dni_do_lhuty: z.lhuta ? dniDo(z.lhuta) : null };
    if (z.typ === 'REKLAMACE') d.doba_vyrizeni_dni = Math.round((new Date((z.vyrizeno || z.vydano || ted()).slice(0, 10)) - new Date(z.prijato.slice(0, 10))) / 864e5);
    return d;
  }
  const zakazka = (id) => { const z = DB.servis.find((x) => x.id === +id); if (!z) throw new Chyba(404, 'Zakázka nenalezena'); return z; };
  const otevrena = (z) => { if (['VYDANO', 'ZRUSENO'].includes(z.stav)) throw new Chyba(409, 'Zakázka je uzavřená'); };

  function ulozOdberatele(o) {
    const pole = ['nazev', 'ico', 'dic', 'ulice', 'mesto', 'psc', 'email', 'telefon', 'poznamka'];
    let z = o.id ? DB.odberatele.find((x) => x.id === o.id) : (o.ico ? DB.odberatele.find((x) => x.ico === o.ico) : null);
    if (!z) { z = { id: DB.dalsi.odberatel++, vytvoreno: ted() }; DB.odberatele.push(z); }
    pole.forEach((k) => { z[k] = (o[k] && String(o[k]).trim()) || null; }); z.upraveno = ted();
    return z;
  }

  /* ------------------------------------------------------------------ faktury */

  function slova(s) { return norm(s).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' '); }
  function podobnost(a, b) {   // Diceův koeficient nad dvojicemi znaků
    if (!a || !b) return 0;
    const dv = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
    const x = dv(a); const y = dv(b); let spol = 0;
    for (const [k, n] of x) spol += Math.min(n, y.get(k) || 0);
    return (2 * spol) / Math.max(1, a.length - 1 + b.length - 1);
  }
  const NESKLADOVE = /doprav|po[sš]tovn|baln[eé]|zaokrouhl|recykla|poplatek|dob[ií]rk|z[aá]loh|slev/i;

  function nactiIsdoc(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Chyba(400, 'ISDOC nejde přečíst');
    const prvni = (el, ...cesta) => { for (const j of cesta) { if (!el) return null; el = [...el.children].find((c) => c.localName === j) || null; } return el; };
    const txt = (el, ...cesta) => { const x = prvni(el, ...cesta); return x && x.textContent.trim() ? x.textContent.trim() : null; };
    const koren = doc.documentElement;
    if (koren.localName !== 'Invoice') throw new Chyba(400, 'Soubor není faktura ISDOC');
    const party = prvni(koren, 'AccountingSupplierParty', 'Party');
    const hal = (v) => (v == null ? null : Math.round(parseFloat(v) * 100));
    const radky = prvni(koren, 'InvoiceLines');
    const polozky = [...(radky ? radky.children : [])].filter((r) => r.localName === 'InvoiceLine').map((r) => {
      const item = prvni(r, 'Item'); const q = prvni(r, 'InvoicedQuantity');
      const ean = [txt(item, 'StandardItemIdentification', 'ID'), txt(item, 'CatalogueItemIdentification', 'ID')].find((e) => e && /^\d{8,14}$/.test(e)) || null;
      const sazba = txt(r, 'ClassifiedTaxCategory', 'Percent');
      return { nazev: txt(item, 'Description') || '(bez názvu)', mnozstvi: q ? parseFloat(q.textContent) : 1, jednotka: q ? q.getAttribute('unitCode') : null,
        cena_bez_dph: hal(txt(r, 'UnitPrice')), celkem_bez_dph: hal(txt(r, 'LineExtensionAmount')), sazba_dph: sazba == null ? null : Math.round(+sazba),
        kod_dodavatele: txt(item, 'SellersItemIdentification', 'ID'), ean };
    });
    return { zdroj: 'isdoc', dodavatel: txt(party, 'PartyName', 'Name'), dodavatel_ico: txt(party, 'PartyIdentification', 'ID'),
      dodavatel_dic: txt(party, 'PartyTaxScheme', 'CompanyID'), cislo: txt(koren, 'ID'), datum: txt(koren, 'IssueDate'),
      dobropis: ['2', '3'].includes(txt(koren, 'DocumentType')), celkem_bez_dph: hal(txt(koren, 'LegalMonetaryTotal', 'TaxExclusiveAmount')), polozky, varovani: [] };
  }

  const DUVODY_D = { ODPIS: 'odpis', SPOTREBA: 'vlastní spotřeba', VRACENI: 'vrácení dodavateli', MANKO: 'manko', JINE: 'jiný výdej' };
  function skladDoklad(druh, id) {
    const prijem = druh === 'prijemky';
    const d = (prijem ? DB.prijemky : DB.vydejky).find((x) => x.id === id);
    if (!d) throw new Chyba(404, 'Doklad nenalezen');
    const pol = (prijem ? DB.prijemka_polozky.filter((x) => x.prijemka_id === id) : DB.vydejka_polozky.filter((x) => x.vydejka_id === id))
      .map((x) => { const z = zbozi(x.zbozi_id) || {}; return { ...x, nazev: z.nazev, jednotka: z.jednotka, ean: eanyZbozi(x.zbozi_id)[0] || null }; });
    return { ...d, stornovano: d.stornovano || 0, typ: prijem ? 'PRIJEMKA' : 'VYDEJKA', uzivatel: (DB.uzivatele.find((u) => u.id === d.uzivatel_id) || {}).jmeno || null, polozky: pol };
  }

  const klicDodavatele = (ico, nazev) => (ico ? 'ICO:' + ico.replace(/\D/g, '') : nazev ? 'NAZEV:' + norm(nazev).trim() : null);

  function sparuj(f) {
    const dod = klicDodavatele(f.dodavatel_ico, f.dodavatel);
    const katalog = DB.zbozi.filter((z) => z.aktivni);
    const normy = katalog.map((z) => [z, slova(z.nazev)]);
    return f.polozky.map((p) => {
      let navrh = null;
      if (p.ean && DB.eany[p.ean] && zbozi(DB.eany[p.ean])) navrh = { zbozi_id: DB.eany[p.ean], zpusob: 'EAN', jistota: 1, koeficient: 1 };
      const nauc = dod && p.kod_dodavatele ? DB.dodavatel_kody[dod + '|' + p.kod_dodavatele] : null;
      if (!navrh && nauc && zbozi(nauc.zbozi_id)) navrh = { zbozi_id: nauc.zbozi_id, zpusob: 'naučené', jistota: 1, koeficient: nauc.koeficient };
      if (!navrh && p.kod_dodavatele) { const z = katalog.find((x) => x.kod === p.kod_dodavatele); if (z) navrh = { zbozi_id: z.id, zpusob: 'kód', jistota: 0.95, koeficient: 1 }; }
      const cil = slova(p.nazev);
      const kandidati = normy.map(([z, n]) => ({ zbozi_id: z.id, nazev: z.nazev, jistota: Math.round(podobnost(cil, n) * 100) / 100 }))
        .sort((a, b) => b.jistota - a.jistota).slice(0, 5).filter((k) => k.jistota >= 0.5);
      if (!navrh && kandidati.length && kandidati[0].jistota >= 0.6) navrh = { zbozi_id: kandidati[0].zbozi_id, zpusob: 'název', jistota: kandidati[0].jistota, koeficient: 1 };
      let akce;
      if (navrh && navrh.zpusob !== 'název') akce = 'PRIJMOUT';
      else if (NESKLADOVE.test(p.nazev)) akce = 'PRESKOCIT';
      else akce = navrh ? 'PRIJMOUT' : 'NOVE';
      const z = navrh ? zbozi(navrh.zbozi_id) : null;
      return { ...p, akce, navrh, kandidati, zbozi: z ? { id: z.id, nazev: z.nazev, kod: z.kod, cena: z.cena, sazba_dph: z.sazba_dph, nakupni_cena: z.nakupni_cena, jednotka: z.jednotka, stav: z.stav } : null };
    });
  }

  /* ------------------------------------------------------------------ API */

  const TAJNE = ['eet_cert_heslo', 'ai_api_klic', 'zaloha_heslo'];
  const nastaveniVen = () => { const n = { ...DB.nastaveni }; TAJNE.forEach((k) => { n[k] = n[k] ? '********' : ''; }); return n; };
  const ZBOZI_POLE = ['nazev', 'kod', 'kategorie', 'cena', 'sazba_dph', 'nakupni_cena', 'jednotka', 'min_stav', 'poznamka', 'zaruka_mesice'];

  function ulozEany(zid, eany) {
    const ciste = [...new Set((eany || []).map((e) => String(e).trim()).filter(Boolean))];
    for (const e of ciste) {
      if (DB.eany[e] && DB.eany[e] !== zid) throw new Chyba(409, `EAN ${e} už má zboží „${zbozi(DB.eany[e]).nazev}“`);
    }
    for (const e of eanyZbozi(zid)) delete DB.eany[e];
    ciste.forEach((e) => { DB.eany[e] = zid; });
    revEany = null;
  }

  const routes = [
    ['GET', /^\/api\/stav$/, () => {
      const u = ja(); const n = DB.nastaveni;
      return { potreba_nastaveni: false, uzivatel: u ? { id: u.id, jmeno: u.jmeno, role: u.role } : null, eet_rezim: n.eet_rezim,
        firma: Object.fromEntries(['firma_nazev', 'firma_ico', 'firma_dic', 'firma_adresa', 'provozovna', 'telefon', 'platce_dph', 'zaokrouhlovat_hotovost', 'uctenka_paticka',
          'faktura_ucet', 'faktura_pata', 'faktura_splatnost_dni', 'servis_podminky', 'zarucni_podminky', 'servis_lhuta_dni', 'stitek_format'].map((k) => [k, n[k]])) };
    }],
    ['POST', /^\/api\/prihlaseni$/, (m, q, b) => {
      const u = DB.uzivatele.find((x) => x.aktivni && x.pin === String(b.pin));
      if (!u) throw new Chyba(401, 'Neplatný PIN');
      DB.relace = u.id; return { ok: true, jmeno: u.jmeno, role: u.role };
    }],
    ['POST', /^\/api\/odhlaseni$/, () => { DB.relace = null; return { ok: true }; }],

    ['GET', /^\/api\/zbozi$/, (m, q) => {
      prihlasen();
      let r = DB.zbozi.filter((z) => q.get('vse') === 'true' || z.aktivni);
      if (q.get('filtr') === 'dochazi') r = r.filter((z) => z.stav <= z.min_stav);
      if (q.get('filtr') === 'zaporne') r = r.filter((z) => z.stav < 0);
      if (q.get('filtr') === 'skladem') r = r.filter((z) => z.stav > 0);
      if (q.get('filtr') === 'bez_nakupni') r = r.filter((z) => z.stav > 0 && z.nakupni_cena == null);
      const t = (q.get('q') || '').trim();
      if (t) {
        const sl = norm(t).split(/\s+/);
        r = r.filter((z) => DB.eany[t] === z.id || z.kod === t || sl.every((s) => norm(z.nazev).includes(s) || norm(z.kategorie).includes(s)));
      }
      const razeni = { stav: (a, b) => b.stav - a.stav, hodnota: (a, b) => Math.max(b.stav, 0) * b.cena - Math.max(a.stav, 0) * a.cena }[q.get('razeni')];
      return r.sort((a, b) => (razeni && razeni(a, b)) || KOLATOR.compare(a.nazev, b.nazev)).slice(0, Math.min(+(q.get('limit') || 100), 1000)).map(zboziDict);
    }],
    ['GET', /^\/api\/sklad\/souhrn$/, () => {
      prihlasen(); const r = DB.zbozi.filter((z) => z.aktivni); const s = r.filter((z) => z.stav > 0);
      return { karet: r.length, skladem: s.length, kusu: s.reduce((x, z) => x + z.stav, 0),
        hodnota_prodej: Math.round(s.reduce((x, z) => x + z.stav * z.cena, 0)),
        hodnota_nakup: Math.round(s.reduce((x, z) => x + z.stav * (z.nakupni_cena || 0), 0)),
        bez_nakupni: s.filter((z) => z.nakupni_cena == null).length, zaporne: r.filter((z) => z.stav < 0).length,
        dochazi: r.filter((z) => z.min_stav > 0 && z.stav <= z.min_stav).length };
    }],
    ['GET', /^\/api\/zbozi\/kod\/(.+)$/, (m) => {
      prihlasen(); const kod = decodeURIComponent(m[1]).trim();
      const z = zbozi(DB.eany[kod]) || DB.zbozi.find((x) => x.kod === kod);
      if (!z) throw new Chyba(404, 'Kód nenalezen'); return zboziDict(z);
    }],
    ['GET', /^\/api\/zbozi\/(\d+)$/, (m) => {
      prihlasen(); const z = zbozi(+m[1]); if (!z) throw new Chyba(404, 'Zboží nenalezeno');
      const pohyby = DB.pohyby.filter((p) => p.zbozi_id === z.id).slice(-100).reverse()
        .map((p) => ({ ...p, uzivatel: (DB.uzivatele.find((u) => u.id === p.uzivatel_id) || {}).jmeno || null }));
      return { ...zboziDict(z), pohyby, ...historieDemo(z) };
    }],
    ['POST', /^\/api\/zbozi$/, (m, q, b) => {
      const u = spravce();
      if (b.kod && DB.zbozi.some((z) => z.kod === b.kod)) throw new Chyba(409, `Kód ${b.kod} už existuje`);
      const id = DB.dalsi.zbozi;
      ulozEany(id, b.eany);
      DB.dalsi.zbozi++;
      const z = { id, stav: 0, aktivni: b.aktivni === false ? 0 : 1, vytvoreno: ted(), upraveno: ted() };
      ZBOZI_POLE.forEach((k) => { z[k] = b[k] === undefined ? null : b[k]; });
      z.nazev = String(b.nazev || '').trim(); z.sazba_dph = b.sazba_dph ?? 21; z.jednotka = b.jednotka || 'ks'; z.min_stav = b.min_stav || 0; z.cena = b.cena || 0;
      z.seriova_cisla = b.seriova_cisla ? 1 : 0; z.zaruka_mesice = b.zaruka_mesice ?? 24;
      if (!z.nazev) throw new Chyba(422, 'Vyplňte název');
      DB.zbozi.push(z);
      if (b.pocatecni_stav) pohyb(DB, id, b.pocatecni_stav, 'KOREKCE', 'založení', u.id, 'počáteční stav');
      return zboziDict(z);
    }],
    ['PUT', /^\/api\/zbozi\/(\d+)$/, (m, q, b) => {
      spravce(); const z = zbozi(+m[1]); if (!z) throw new Chyba(404, 'Zboží nenalezeno');
      if (b.kod && DB.zbozi.some((x) => x.kod === b.kod && x.id !== z.id)) throw new Chyba(409, `Kód ${b.kod} už existuje`);
      ulozEany(z.id, b.eany);
      ZBOZI_POLE.forEach((k) => { if (b[k] !== undefined) z[k] = b[k]; });
      z.aktivni = b.aktivni === false ? 0 : 1; z.seriova_cisla = b.seriova_cisla ? 1 : 0; z.upraveno = ted();
      return zboziDict(z);
    }],

    ['POST', /^\/api\/prodeje$/, (m, q, b) => { prihlasen(); return prodejDict(prodej(DB, b)); }],
    ['GET', /^\/api\/prodeje$/, (m, q) => {
      prihlasen();
      let r = DB.prodeje.slice();
      if (q.get('datum')) r = r.filter((p) => p.cas.startsWith(q.get('datum')));
      if (q.get('eet_stav')) r = r.filter((p) => p.eet_stav === q.get('eet_stav'));
      return r.reverse().slice(0, +(q.get('limit') || 200)).map((p) => ({ ...prodejDict(p), pocet: DB.polozky.filter((i) => i.prodej_id === p.id).length }));
    }],
    ['GET', /^\/api\/prodeje\/(\d+)$/, (m) => {
      prihlasen(); const p = DB.prodeje.find((x) => x.id === +m[1]); if (!p) throw new Chyba(404, 'Účtenka nenalezena'); return prodejDict(p);
    }],
    ['POST', /^\/api\/prodeje\/(\d+)\/storno$/, (m) => {
      const u = prihlasen(); const p = DB.prodeje.find((x) => x.id === +m[1]);
      if (!p) throw new Chyba(404, 'Účtenka nenalezena');
      if (p.typ !== 'PRODEJ' || p.stornovano) throw new Chyba(409, 'Účtenku nejde stornovat');
      const s = novaUctenka(DB, { typ: 'STORNO', storno_k: p.id, platba: p.platba, mezisoucet: -p.mezisoucet, zaokrouhleni: -p.zaokrouhleni, celkem: -p.celkem,
        prijato: p.platba === 'HOTOVE' ? 0 : null, vraceno: p.platba === 'HOTOVE' ? p.celkem : null });
      DB.prodeje.push(s);
      for (const r of DB.polozky.filter((i) => i.prodej_id === p.id)) {
        DB.polozky.push({ ...r, id: DB.dalsi.polozka++, prodej_id: s.id, mnozstvi: -r.mnozstvi, celkem: -r.celkem });
        if (r.zbozi_id != null) pohyb(DB, r.zbozi_id, r.mnozstvi, 'STORNO', s.cislo, u.id, `storno ${p.cislo}`);
      }
      p.stornovano = 1; eetOdesli(s);
      return prodejDict(s);
    }],
    ['POST', /^\/api\/prodeje\/(\d+)\/eet$/, (m) => {
      prihlasen(); const p = DB.prodeje.find((x) => x.id === +m[1]); if (!p) throw new Chyba(404, 'Účtenka nenalezena');
      if (p.eet_stav !== 'OK') eetOdesli(p); return prodejDict(p);
    }],
    ['GET', /^\/api\/eet\/fronta$/, () => { prihlasen(); return { ceka: 0, chyba: 0, nejstarsi: null }; }],
    ['POST', /^\/api\/eet\/test$/, () => { spravce(); return { ok: true, kod: 0, text: 'Demo – spojení se jen předstírá', varovani: [], test: true, certifikat: 'CN=CZ00000019 (demo)', certifikat_plati_do: '2027-05-14' }; }],
    ['POST', /^\/api\/eet\/certifikat$/, () => { spravce(); throw new Chyba(400, 'V demu se certifikát nenahrává – v prodejně ho nahrajete z DIS+.'); }],

    ['POST', /^\/api\/prijemky$/, (m, q, b) => {
      const u = spravce(); const cas = ted(); const rok = cas.slice(0, 4);
      const cislo = `P${rok}-${String(dalsiCislo(DB, 'prijemka-' + rok)).padStart(5, '0')}`;
      const dod = klicDodavatele(b.dodavatel_ico, b.dodavatel);
      const celkem = b.polozky.reduce((s, p) => s + Math.round((p.nakupni_cena || 0) * p.mnozstvi), 0);
      const id = DB.dalsi.prijemka++;
      DB.prijemky.push({ id, cislo, cas, uzivatel_id: u.id, dodavatel: b.dodavatel, dodavatel_ico: b.dodavatel_ico, doklad: b.doklad, poznamka: b.poznamka, celkem_bez_dph: celkem, soubor_id: null, stornovano: 0 });
      for (const p of b.polozky) {
        if (!zbozi(p.zbozi_id)) throw new Chyba(400, `Zboží ${p.zbozi_id} neexistuje`);
        DB.prijemka_polozky.push({ prijemka_id: id, zbozi_id: p.zbozi_id, mnozstvi: p.mnozstvi, nakupni_cena: p.nakupni_cena });
        pohyb(DB, p.zbozi_id, p.mnozstvi, 'PRIJEM', cislo, u.id, b.doklad);
        if (p.nakupni_cena != null) zbozi(p.zbozi_id).nakupni_cena = p.nakupni_cena;
        if (p.prodejni_cena != null) zbozi(p.zbozi_id).cena = p.prodejni_cena;
        if (p.kod_dodavatele && dod) DB.dodavatel_kody[dod + '|' + p.kod_dodavatele] = { zbozi_id: p.zbozi_id, koeficient: p.koeficient || 1 };
        if (p.ean_z_faktury && !DB.eany[p.ean_z_faktury]) { DB.eany[p.ean_z_faktury] = p.zbozi_id; revEany = null; }
      }
      return { id, cislo, celkem_bez_dph: celkem };
    }],
    ['GET', /^\/api\/prijemky$/, () => {
      prihlasen();
      return DB.prijemky.slice().reverse().map((p) => ({ ...p, uzivatel: (DB.uzivatele.find((u) => u.id === p.uzivatel_id) || {}).jmeno,
        pocet: DB.prijemka_polozky.filter((x) => x.prijemka_id === p.id).length }));
    }],
    ['POST', /^\/api\/vydejky$/, (m, q, b) => {
      const u = spravce(); const cas = ted(); const rok = cas.slice(0, 4);
      const cislo = `V${rok}-${String(dalsiCislo(DB, 'vydejka-' + rok)).padStart(5, '0')}`;
      const id = DB.dalsi.vydejka++; let celkem = 0;
      const v = { id, cislo, cas, uzivatel_id: u.id, duvod: b.duvod, komu: b.komu || null, poznamka: b.poznamka || null, celkem_nakup: 0, stornovano: 0 };
      for (const p of b.polozky) {
        const z = zbozi(p.zbozi_id); if (!z) throw new Chyba(400, `Zboží ${p.zbozi_id} neexistuje`);
        DB.vydejka_polozky.push({ vydejka_id: id, zbozi_id: z.id, mnozstvi: p.mnozstvi, nakupni_cena: z.nakupni_cena });
        pohyb(DB, z.id, -p.mnozstvi, 'VYDEJ', cislo, u.id, DUVODY_D[b.duvod]);
        celkem += Math.round((z.nakupni_cena || 0) * p.mnozstvi);
      }
      v.celkem_nakup = celkem; DB.vydejky.push(v);
      return { id, cislo, celkem_nakup: celkem };
    }],
    ['GET', /^\/api\/(prijemky|vydejky)\/(\d+)$/, (m) => { prihlasen(); return skladDoklad(m[1], +m[2]); }],
    ['POST', /^\/api\/(prijemky|vydejky)\/(\d+)\/storno$/, (m) => {
      const u = spravce(); const prijem = m[1] === 'prijemky';
      const d = (prijem ? DB.prijemky : DB.vydejky).find((x) => x.id === +m[2]);
      if (!d || d.stornovano) throw new Chyba(409, 'Doklad nejde stornovat');
      (prijem ? DB.prijemka_polozky.filter((x) => x.prijemka_id === d.id) : DB.vydejka_polozky.filter((x) => x.vydejka_id === d.id))
        .forEach((x) => pohyb(DB, x.zbozi_id, prijem ? -x.mnozstvi : x.mnozstvi, 'STORNO', d.cislo, u.id, prijem ? 'storno příjemky' : 'storno výdejky'));
      d.stornovano = 1; return skladDoklad(m[1], d.id);
    }],
    ['GET', /^\/api\/sklad\/doklady$/, (m, q) => {
      prihlasen(); const typ = q.get('typ') || 'vse'; const od = q.get('od') || ''; const doD = q.get('do') || ''; const t = norm((q.get('q') || '').trim());
      const jm = (id) => (DB.uzivatele.find((x) => x.id === id) || {}).jmeno || null;
      let r = [];
      if (typ !== 'vydejky') r = r.concat(DB.prijemky.map((p) => ({ typ: 'PRIJEMKA', id: p.id, cislo: p.cislo, cas: p.cas, partner: p.dodavatel, duvod: null, doklad: p.doklad,
        celkem: p.celkem_bez_dph, stornovano: p.stornovano || 0, soubor_id: null, uzivatel: jm(p.uzivatel_id), pocet: DB.prijemka_polozky.filter((x) => x.prijemka_id === p.id).length })));
      if (typ !== 'prijemky') r = r.concat(DB.vydejky.map((v) => ({ typ: 'VYDEJKA', id: v.id, cislo: v.cislo, cas: v.cas, partner: v.komu, duvod: v.duvod, doklad: v.poznamka,
        celkem: v.celkem_nakup, stornovano: v.stornovano, soubor_id: null, uzivatel: jm(v.uzivatel_id), pocet: DB.vydejka_polozky.filter((x) => x.vydejka_id === v.id).length })));
      r = r.filter((d) => (!od || d.cas.slice(0, 10) >= od) && (!doD || d.cas.slice(0, 10) <= doD)
        && (!t || d.cislo.toLowerCase().includes(t) || norm(d.partner).includes(t) || norm(d.doklad).includes(t)));
      return r.sort((a, b) => (a.cas < b.cas ? 1 : -1));
    }],
    ['GET', /^\/api\/sklad\/pohyby$/, (m, q) => {
      prihlasen(); const od = q.get('od') || ''; const doD = q.get('do') || ''; const typ = q.get('typ') || ''; const t = norm((q.get('q') || '').trim());
      return DB.pohyby.slice().reverse().map((p) => { const z = zbozi(p.zbozi_id) || {}; return { ...p, nazev: z.nazev, jednotka: z.jednotka, uzivatel: (DB.uzivatele.find((x) => x.id === p.uzivatel_id) || {}).jmeno || null }; })
        .filter((p) => (!od || p.cas.slice(0, 10) >= od) && (!doD || p.cas.slice(0, 10) <= doD) && (!typ || p.typ === typ)
          && (!t || norm(p.nazev).includes(t) || (p.doklad || '').toLowerCase().includes(t) || DB.eany[t] === p.zbozi_id)).slice(0, 500);
    }],
    ['POST', /^\/api\/sklad\/korekce$/, (m, q, b) => {
      const u = spravce(); const z = zbozi(b.zbozi_id); if (!z) throw new Chyba(404, 'Zboží nenalezeno');
      const rozdil = Math.round((b.novy_stav - z.stav) * 1000) / 1000;
      if (rozdil) pohyb(DB, z.id, rozdil, 'KOREKCE', 'inventura', u.id, b.poznamka);
      return { ok: true, rozdil };
    }],
    ['POST', /^\/api\/faktury\/nacti$/, (m, q, b) => {
      spravce();
      let text = '';
      try { text = new TextDecoder().decode(Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0))); } catch { /* binární soubor */ }
      let f;
      if (/^\s*</.test(text) || /\.(isdoc|xml)$/i.test(b.nazev)) f = nactiIsdoc(text);
      else {
        f = { zdroj: 'text', ...DEMO_FAKTURA, dobropis: false, celkem_bez_dph: null,
          polozky: DEMO_FAKTURA.polozky.map(([nazev, kod, ean, mn, jed, cena]) => ({ nazev, kod_dodavatele: kod, ean, mnozstvi: mn, jednotka: jed, cena_bez_dph: cena, celkem_bez_dph: cena * mn, sazba_dph: 21 })),
          varovani: ['V demu se PDF nečte – místo vaší faktury se načetla ukázková. Skutečná pokladna čte ISDOC, PDF s ISDOC i běžná PDF.'] };
      }
      const prijata = f.cislo && DB.prijemky.slice().reverse().find((p) => p.doklad === f.cislo && (p.dodavatel_ico === f.dodavatel_ico || (!f.dodavatel_ico && p.dodavatel === f.dodavatel)));
      return { soubor_id: null, faktura: { ...f, polozky: sparuj(f) }, duplicita: prijata ? { cislo: prijata.cislo, cas: prijata.cas } : null,
        marze_pct: +DB.nastaveni.vychozi_marze_pct || 40 };
    }],

    ['GET', /^\/api\/uzaverka$/, (m, q) => {
      prihlasen();
      const datum = q.get('datum') || ted().slice(0, 10);
      const den = DB.prodeje.filter((p) => p.cas.startsWith(datum));
      const skup = (pole) => den.reduce((a, p) => { const k = p[pole]; a[k] = a[k] || { [pole]: k, pocet: 0, celkem: 0 }; a[k].pocet++; a[k].celkem += p.celkem; return a; }, {});
      const dphMap = {};
      DB.polozky.filter((i) => den.some((p) => p.id === i.prodej_id)).forEach((i) => { dphMap[i.sazba_dph] = (dphMap[i.sazba_dph] || 0) + i.celkem; });
      const dph = Object.keys(dphMap).sort((a, b) => b - a).map((s) => { const c = dphMap[s]; const z = Math.round(c / (1 + s / 100)); return { sazba_dph: +s, celkem: c, zaklad: z, dph: c - z }; });
      const eet = den.reduce((a, p) => { a[p.eet_stav] = (a[p.eet_stav] || 0) + 1; return a; }, {});
      const prod = {};
      den.forEach((p) => { const j = (DB.uzivatele.find((u) => u.id === p.uzivatel_id) || {}).jmeno; prod[j] = prod[j] || { jmeno: j, pocet: 0, celkem: 0 }; prod[j].pocet++; prod[j].celkem += p.celkem; });
      return { datum, platby: skup('platba'), typy: skup('typ'), dph, zaokrouhleni: den.reduce((s, p) => s + p.zaokrouhleni, 0), eet,
        prodavaci: Object.values(prod), celkem: den.reduce((s, p) => s + p.celkem, 0), hotovost: denPokladny(datum) };
    }],

    ['GET', /^\/api\/nastaveni$/, () => { spravce(); return nastaveniVen(); }],
    ['PUT', /^\/api\/nastaveni$/, (m, q, b) => {
      spravce();
      if (b.eet_rezim === 'produkce') throw new Chyba(400, 'V demu jde EET jen v testovacím režimu.');
      Object.entries(b).forEach(([k, v]) => { if (k in DB.nastaveni && !(TAJNE.includes(k) && v === '********')) DB.nastaveni[k] = v == null ? '' : String(v); });
      return nastaveniVen();
    }],
    ['GET', /^\/api\/uzivatele$/, () => { spravce(); return DB.uzivatele.map(({ pin, ...u }) => u); }],
    ['POST', /^\/api\/uzivatele$/, (m, q, b) => {
      spravce();
      if (!b.pin) throw new Chyba(400, 'Zadejte PIN');
      if (DB.uzivatele.some((u) => u.aktivni && u.pin === b.pin)) throw new Chyba(409, 'Tento PIN už používá někdo jiný');
      const id = DB.dalsi.uzivatel++;
      DB.uzivatele.push({ id, jmeno: b.jmeno.trim(), pin: b.pin, role: b.role, aktivni: b.aktivni === false ? 0 : 1, vytvoreno: ted() });
      return { id };
    }],
    ['PUT', /^\/api\/uzivatele\/(\d+)$/, (m, q, b) => {
      const ja2 = spravce(); const u = DB.uzivatele.find((x) => x.id === +m[1]); if (!u) throw new Chyba(404, 'Uživatel nenalezen');
      if (u.id === ja2.id && (b.role !== 'SPRAVCE' || !b.aktivni)) throw new Chyba(400, 'Sám sebe nemůžete odebrat ze správců');
      if (b.pin) {
        if (DB.uzivatele.some((x) => x.aktivni && x.id !== u.id && x.pin === b.pin)) throw new Chyba(409, 'Tento PIN už používá někdo jiný');
        u.pin = b.pin;
      }
      Object.assign(u, { jmeno: b.jmeno.trim(), role: b.role, aktivni: b.aktivni ? 1 : 0 });
      return { ok: true };
    }],

    ['GET', /^\/api\/odberatele$/, (m, q) => {
      prihlasen(); const t = norm((q.get('q') || '').trim());
      return DB.odberatele.filter((o) => !t || norm(o.nazev).includes(t) || (o.ico || '').startsWith(t) || norm(o.mesto).includes(t))
        .map((o) => ({ ...o, faktur: DB.faktury.filter((f) => f.odberatel_id === o.id && f.stav !== 'STORNO' && f.typ === 'FAKTURA').length,
          dluzi: DB.faktury.filter((f) => f.odberatel_id === o.id && f.stav === 'NEUHRAZENO' && ['FAKTURA', 'ZALOHOVA'].includes(f.typ)).reduce((s, f) => s + f.celkem, 0) }))
        .sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
    }],
    ['POST', /^\/api\/odberatele$/, (m, q, b) => { prihlasen(); if (!b.nazev) throw new Chyba(422, 'Vyplňte název'); return ulozOdberatele(b); }],
    ['GET', /^\/api\/ares\/(\d+)$/, async (m) => {
      prihlasen(); const ico = m[1].padStart(8, '0');
      let d;
      try { d = await (await puvodniFetch(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`)).json(); }
      catch { throw new Chyba(502, 'ARES teď neodpovídá, vyplňte údaje ručně'); }
      if (!d.obchodniJmeno) throw new Chyba(404, `IČO ${ico} v ARES není`);
      const s = d.sidlo || {};
      const cislo = [s.cisloDomovni, s.cisloOrientacni].filter(Boolean).join('/') + (s.cisloOrientacniPismeno || '');
      return { nazev: d.obchodniJmeno, ico, dic: d.dic || null, ulice: [s.nazevUlice || s.nazevCastiObce, cislo].filter(Boolean).join(' '),
        mesto: s.nazevObce || null, psc: String(s.psc || '').replace(/^(\d{3})(\d{2})$/, '$1 $2') };
    }],
    ['GET', /^\/api\/faktury-vydane$/, (m, q) => {
      prihlasen(); const dnes = ted().slice(0, 10); const filtr = q.get('filtr') || 'vse'; const t = norm((q.get('q') || '').trim());
      const typy = { FAKTURA: ['FAKTURA'], ZALOHOVA: ['ZALOHOVA', 'DDZP'], OPRAVNY: ['OPRAVNY'], NABIDKA: ['NABIDKA'], vse: Object.keys(RADY) }[q.get('typ') || 'FAKTURA'] || ['FAKTURA'];
      const vse = DB.faktury.filter((f) => typy.includes(f.typ));
      let r = vse.slice().reverse();
      if (filtr === 'neuhrazene') r = r.filter((f) => f.stav === 'NEUHRAZENO');
      if (filtr === 'po_splatnosti') r = r.filter((f) => f.stav === 'NEUHRAZENO' && f.splatnost < dnes);
      if (filtr === 'uhrazene') r = r.filter((f) => f.stav === 'UHRAZENO');
      if (t) r = r.filter((f) => f.cislo.toLowerCase().includes(t) || norm(f.odb_nazev).includes(t) || (f.odb_ico || '').startsWith(t));
      const nu = vse.filter((f) => f.stav === 'NEUHRAZENO'); const ps = nu.filter((f) => f.splatnost < dnes);
      return { faktury: r.map((f) => ({ ...f, po_splatnosti: poSplatnosti(f) })),
        souhrn: { neuhrazeno: nu.reduce((s, f) => s + f.celkem, 0), po_splatnosti: ps.reduce((s, f) => s + f.celkem, 0), pocet_po_splatnosti: ps.length,
          k_upominani: ps.filter((f) => f.odb_email).length,
          mesic: vse.filter((f) => f.stav !== 'STORNO' && f.typ !== 'DDZP' && f.datum_vystaveni.startsWith(dnes.slice(0, 7))).reduce((s, f) => s + f.celkem, 0) } };
    }],
    ['GET', /^\/api\/faktury-vydane\/(\d+)$/, (m) => { prihlasen(); const f = DB.faktury.find((x) => x.id === +m[1]); if (!f) throw new Chyba(404, 'Doklad nenalezen'); return fakturaDict(f); }],
    ['POST', /^\/api\/faktury-vydane$/, (m, q, b) => {
      const u = prihlasen(); const dnes = ted().slice(0, 10); const typ = b.typ || 'FAKTURA'; const forma = b.forma_uhrady; const platce = DB.nastaveni.platce_dph === '1';
      const o = { ...b.odberatel }; if (!o.nazev) throw new Chyba(422, 'Vyplňte odběratele');
      if (b.pdp && (!platce || typ === 'ZALOHOVA' || !['PREVOD', 'DOBIRKA'].includes(forma) || b.prodej_id)) throw new Chyba(400, 'Přenesení daňové povinnosti jde jen u dokladu plátce DPH placeného převodem nebo dobírkou');
      if (b.pdp && !o.dic) throw new Chyba(400, 'Při přenesení daňové povinnosti musí mít odběratel DIČ');
      if (typ === 'ZALOHOVA' && forma !== 'PREVOD') throw new Chyba(400, 'Zálohová faktura se platí převodem');
      const vazba = b.vazba_id ? DB.faktury.find((x) => x.id === b.vazba_id) : null;
      if (typ === 'OPRAVNY') {
        if (!vazba || vazba.typ !== 'FAKTURA' || vazba.stav === 'STORNO' || vazba.prodej_id) throw new Chyba(400, 'Opravný doklad jde vystavit jen k faktuře placené převodem nebo dobírkou');
        if (!(b.duvod_opravy || '').trim()) throw new Chyba(400, 'Uveďte důvod opravy');
      }
      const ulozeny = b.ulozit_kontakt === false ? o : ulozOdberatele(o);
      const zaklad = { typ, vystaveni: b.datum_vystaveni || dnes, duzp: b.duzp, splatnost: b.splatnost, poznamka: b.poznamka, vazba_id: vazba ? vazba.id : null, pdp: !!b.pdp, duvod_opravy: b.duvod_opravy };
      let f;
      if (b.prodej_id) {
        const p = DB.prodeje.find((x) => x.id === b.prodej_id);
        if (!p || p.typ !== 'PRODEJ' || p.stornovano) throw new Chyba(400, 'K této prodejce nejde fakturu vystavit');
        if (DB.faktury.some((x) => x.prodej_id === p.id)) throw new Chyba(409, 'K této prodejce už faktura existuje');
        const radky = DB.polozky.filter((i) => i.prodej_id === p.id).map(({ zbozi_id, nazev, mnozstvi, cena, sazba_dph, celkem }) => ({ zbozi_id, nazev, mnozstvi, jednotka: null, cena, sazba_dph, celkem }));
        if (p.zaokrouhleni) radky.push({ zbozi_id: null, nazev: 'Zaokrouhlení', mnozstvi: 1, jednotka: null, cena: p.zaokrouhleni, sazba_dph: 0, celkem: p.zaokrouhleni });
        f = novaFaktura(DB, { ...ulozeny, id: ulozeny.id }, { ...zaklad, duzp: p.cas.slice(0, 10), forma: p.platba, radky, stav: 'UHRAZENO', uhrazeno: p.cas.slice(0, 10), prodej_id: p.id });
      } else {
        const radky = radkyDokladu(DB, b.polozky || [], !!b.pdp, typ === 'FAKTURA');
        if (!radky.length) throw new Chyba(400, 'Doklad nemá žádnou položku');
        if (typ === 'FAKTURA' && vazba && vazba.typ === 'ZALOHOVA') {
          if (vazba.stav !== 'UHRAZENO') throw new Chyba(400, `Zálohová faktura ${vazba.cislo} ještě není zaplacená`);
          if (DB.faktury.some((x) => x.vazba_id === vazba.id && x.typ === 'FAKTURA' && x.stav !== 'STORNO')) throw new Chyba(409, `Záloha ${vazba.cislo} už je vyúčtovaná`);
          const zdroj = DB.faktury.find((x) => x.vazba_id === vazba.id && x.typ === 'DDZP') || vazba;
          rekap(DB.faktura_polozky.filter((x) => x.faktura_id === zdroj.id)).forEach((r) => radky.push({ zbozi_id: null, nazev: `Odpočet zálohy ${zdroj.cislo}`, mnozstvi: 1, jednotka: null, cena: -r.celkem, sazba_dph: r.sazba, celkem: -r.celkem }));
        }
        if (typ === 'OPRAVNY' && radky.reduce((s, r) => s + r.celkem, 0) >= 0) throw new Chyba(400, 'Opravný doklad musí částku snižovat: zadejte vrácené množství nebo slevu se záporným znaménkem');
        if (typ === 'FAKTURA' && (forma === 'HOTOVE' || forma === 'KARTA')) {
          const p = prodej(DB, { platba: forma, prijato: b.prijato, polozky: b.polozky });
          const rp = DB.polozky.filter((i) => i.prodej_id === p.id).map(({ zbozi_id, nazev, mnozstvi, cena, sazba_dph, celkem }) => ({ zbozi_id, nazev, mnozstvi, jednotka: null, cena, sazba_dph, celkem }));
          if (p.zaokrouhleni) rp.push({ zbozi_id: null, nazev: 'Zaokrouhlení', mnozstvi: 1, jednotka: null, cena: p.zaokrouhleni, sazba_dph: 0, celkem: p.zaokrouhleni });
          f = novaFaktura(DB, ulozeny, { ...zaklad, forma, radky: rp, stav: 'UHRAZENO', uhrazeno: dnes, prodej_id: p.id });
        } else {
          const celkem = radky.reduce((s, r) => s + r.celkem, 0);
          const uhrazeno = typ === 'FAKTURA' && celkem <= 0;
          f = novaFaktura(DB, ulozeny, { ...zaklad, forma, radky, stav: uhrazeno ? 'UHRAZENO' : 'NEUHRAZENO', uhrazeno: uhrazeno ? zaklad.vystaveni : null, serie: typ === 'FAKTURA' });
          radky.forEach((r) => {
            if (r.zbozi_id == null) return;
            if (typ === 'FAKTURA') pohyb(DB, r.zbozi_id, -r.mnozstvi, 'PRODEJ', f.cislo, u.id, 'faktura');
            else if (typ === 'OPRAVNY' && b.vratit_na_sklad !== false && r.mnozstvi < 0) pohyb(DB, r.zbozi_id, -r.mnozstvi, 'PRODEJ', f.cislo, u.id, 'opravný doklad – vráceno');
          });
        }
      }
      if (vazba && vazba.typ === 'NABIDKA' && ['FAKTURA', 'ZALOHOVA'].includes(typ) && vazba.stav === 'NEUHRAZENO') Object.assign(vazba, { stav: 'UHRAZENO', datum_uhrady: dnes });
      return fakturaDict(f);
    }],
    ['POST', /^\/api\/faktury-vydane\/(\d+)\/uhrada$/, (m, q, b) => {
      prihlasen(); const f = DB.faktury.find((x) => x.id === +m[1]); if (!f) throw new Chyba(404, 'Doklad nenalezen');
      if (f.stav === 'STORNO' || f.prodej_id || ['DDZP', 'NABIDKA'].includes(f.typ)) throw new Chyba(409, 'U tohoto dokladu nejde úhradu měnit');
      if (b.uhrazeno === false) {
        if (DB.faktury.some((x) => x.vazba_id === f.id && x.typ === 'DDZP')) throw new Chyba(409, 'K záloze už je vystavený daňový doklad k platbě, úhradu nejde vrátit');
        Object.assign(f, { stav: 'NEUHRAZENO', datum_uhrady: null });
      } else uhrad(f, b.datum || ted().slice(0, 10));
      return fakturaDict(f);
    }],
    ['POST', /^\/api\/faktury-vydane\/(\d+)\/storno$/, (m) => {
      const u = prihlasen(); const f = DB.faktury.find((x) => x.id === +m[1]); if (!f) throw new Chyba(404, 'Doklad nenalezen');
      if (f.typ === 'DDZP') throw new Chyba(409, 'Daňový doklad k přijaté platbě nejde stornovat');
      if (f.stav !== 'NEUHRAZENO' || f.prodej_id) throw new Chyba(409, 'Stornovat jde jen neuhrazený doklad placený převodem. Zaplacený nákup vraťte stornem prodejky.');
      const aktivni = DB.faktury.filter((x) => x.vazba_id === f.id && x.stav !== 'STORNO').map((x) => x.cislo);
      if (aktivni.length) throw new Chyba(409, `Na doklad navazuje ${aktivni.join(', ')} – nejdřív stornujte ten`);
      DB.pohyby.filter((p) => p.doklad === f.cislo && p.typ === 'PRODEJ').forEach((p) => pohyb(DB, p.zbozi_id, -p.mnozstvi, 'STORNO', f.cislo, u.id, 'storno dokladu'));
      f.stav = 'STORNO'; return fakturaDict(f);
    }],
    ['POST', /^\/api\/faktury-vydane\/(\d+)\/odeslat$/, () => { throw new Chyba(400, 'V demu se e-maily neodesílají.'); }],
    ['POST', /^\/api\/faktury-vydane\/(\d+)\/upominka$/, () => { throw new Chyba(400, 'V demu se e-maily neodesílají.'); }],
    ['POST', /^\/api\/faktury-vydane\/upominky$/, () => { throw new Chyba(400, 'V demu se e-maily neodesílají.'); }],
    ['POST', /^\/api\/banka\/import$/, () => { prihlasen(); throw new Chyba(400, 'V demu se bankovní výpisy nenačítají. Ve skutečné pokladně nahrajete výpis (GPC, XML camt.053 nebo CSV) a platby se spárují s fakturami samy.'); }],
    ['GET', /^\/api\/banka\/pohyby$/, () => { prihlasen(); return []; }],

    ['GET', /^\/api\/pokladna\/stav$/, () => {
      prihlasen(); const posl = DB.pocitani[DB.pocitani.length - 1];
      return { stav: stavPokladny(), dnes: denPokladny(ted().slice(0, 10)), posledni_pocitani: posl ? pocitaniDict(posl) : null, nominaly: [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] };
    }],
    ['POST', /^\/api\/pokladna\/doklady$/, (m, q, b) => {
      const u = prihlasen();
      if (!DRUHY_POKL[b.druh] || b.druh === 'ROZDIL') throw new Chyba(400, 'Neznámý druh pokladního dokladu');
      const typ = DRUHY_POKL[b.druh][0] || b.typ;
      if (b.druh === 'POCATECNI' && u.role !== 'SPRAVCE') throw new Chyba(403, 'Počáteční stav zadává správce');
      if (!(b.castka > 0)) throw new Chyba(422, 'Zadejte částku');
      if (typ === 'VYDEJ' && b.castka > stavPokladny()) throw new Chyba(400, `V pokladně je podle evidence jen ${(stavPokladny() / 100).toLocaleString('cs-CZ', { minimumFractionDigits: 2 })} Kč`);
      return pokladniDict(vlozPokladniDoklad(DB, typ, b.druh, b.castka, (b.ucel || '').trim(), (b.osoba || '').trim(), u.id));
    }],
    ['GET', /^\/api\/pokladna\/doklady\/(\d+)$/, (m) => { prihlasen(); const d = DB.pokladni_doklady.find((x) => x.id === +m[1]); if (!d) throw new Chyba(404, 'Pokladní doklad nenalezen'); return pokladniDict(d); }],
    ['POST', /^\/api\/pokladna\/doklady\/(\d+)\/storno$/, (m) => {
      spravce(); const d = DB.pokladni_doklady.find((x) => x.id === +m[1]); if (!d) throw new Chyba(404, 'Pokladní doklad nenalezen');
      if (d.stornovano) throw new Chyba(409, 'Doklad už je stornovaný'); d.stornovano = 1; return pokladniDict(d);
    }],
    ['GET', /^\/api\/pokladna\/kniha$/, (m, q) => {
      prihlasen(); const mesic = (q.get('mesic') || ted().slice(0, 7)).slice(0, 7); const pocatek = stavPokladny(`${mesic}-01`);
      const radky = DB.pokladni_doklady.filter((d) => d.cas.startsWith(mesic)).map((d) => ({ druh: d.druh, id: d.id, cas: d.cas, datum: d.cas.slice(0, 10), cislo: d.cislo,
        text: d.ucel || DRUHY_POKL[d.druh][1], osoba: d.osoba, uzivatel: pokladniDict(d).uzivatel, stornovano: d.stornovano,
        prijem: d.typ === 'PRIJEM' ? d.castka : 0, vydej: d.typ === 'VYDEJ' ? d.castka : 0 }));
      const hranice = radky.map((r) => r.cas).sort(); const useky = new Map();
      DB.prodeje.filter((p) => p.platba === 'HOTOVE' && p.cas.startsWith(mesic)).sort((a, b) => (a.cas < b.cas ? -1 : 1)).forEach((p) => {
        const k = p.cas.slice(0, 10) + '|' + (hranice.find((h) => h > p.cas && h.slice(0, 10) === p.cas.slice(0, 10)) || '');
        const u = useky.get(k) || { pocet: 0, celkem: 0, cas: p.cas }; u.pocet++; u.celkem += p.celkem; u.cas = p.cas; useky.set(k, u);
      });
      for (const [k, u] of useky) if (u.celkem) radky.push({ druh: 'TRZBY', cas: u.cas, datum: k.slice(0, 10), cislo: null, text: `Tržby hotově (${u.pocet} ${u.pocet === 1 ? 'prodejka' : u.pocet < 5 ? 'prodejky' : 'prodejek'})`, prijem: Math.max(u.celkem, 0), vydej: Math.max(-u.celkem, 0) });
      radky.sort((a, b) => (a.cas < b.cas ? -1 : 1));
      let zustatek = pocatek; radky.forEach((r) => { if (!r.stornovano) zustatek += r.prijem - r.vydej; r.zustatek = zustatek; });
      return { mesic, pocatek, konec: zustatek, radky, pocitani: DB.pocitani.filter((c) => c.cas.startsWith(mesic)).map(pocitaniDict),
        prijmy: radky.filter((r) => !r.stornovano).reduce((s, r) => s + r.prijem, 0), vydaje: radky.filter((r) => !r.stornovano).reduce((s, r) => s + r.vydej, 0) };
    }],
    ['POST', /^\/api\/pokladna\/pocitani$/, (m, q, b) => {
      const u = prihlasen(); const rozpis = {};
      Object.entries(b.rozpis || {}).forEach(([k, v]) => { if (+v > 0) rozpis[k] = +v; });
      const spocitano = Object.entries(rozpis).reduce((s, [k, v]) => s + k * 100 * v, 0); const ocekavano = stavPokladny(); const rozdil = spocitano - ocekavano;
      let did = null;
      if (b.zauctovat !== false && rozdil) did = vlozPokladniDoklad(DB, rozdil > 0 ? 'PRIJEM' : 'VYDEJ', 'ROZDIL', Math.abs(rozdil), rozdil > 0 ? 'Přebytek při počítání pokladny' : 'Manko při počítání pokladny', null, u.id).id;
      const c = { id: DB.dalsi.poc++, cas: ted(), ocekavano, spocitano, rozpis, doklad_id: did, uzivatel_id: u.id, poznamka: b.poznamka || null };
      DB.pocitani.push(c); return pocitaniDict(c);
    }],

    ['GET', /^\/api\/servis$/, (m, q) => {
      prihlasen(); const filtr = q.get('filtr') || 'aktivni'; const t = norm((q.get('q') || '').trim()); const tyden = plus(ted().slice(0, 10), 7);
      const hori = (z) => z.typ === 'REKLAMACE' && !z.vyrizeno && !['VYDANO', 'ZRUSENO'].includes(z.stav) && z.lhuta <= tyden;
      let r = DB.servis.slice();
      if (filtr === 'aktivni') r = r.filter((z) => AKTIVNI_SV.includes(z.stav));
      if (filtr === 'reklamace' || filtr === 'opravy') r = r.filter((z) => z.typ === (filtr === 'reklamace' ? 'REKLAMACE' : 'OPRAVA') && AKTIVNI_SV.includes(z.stav));
      if (filtr === 'u_dodavatele') r = r.filter((z) => z.stav === 'U_DODAVATELE');
      if (filtr === 'hotove') r = r.filter((z) => z.stav === 'HOTOVO');
      if (filtr === 'lhuta') r = r.filter(hori);
      if (filtr === 'vydane') r = r.filter((z) => ['VYDANO', 'ZRUSENO'].includes(z.stav));
      if (t) r = r.filter((z) => z.cislo.toLowerCase().includes(t) || norm(z.zakaznik).includes(t) || (z.telefon || '').replace(/\s/g, '').includes(t.replace(/\s/g, '')) || (z.sn || '').includes(t) || norm(z.zarizeni).includes(t) || (z.dodavatel_rma || '').toLowerCase().includes(t));
      const pocty = {}; DB.servis.filter((z) => AKTIVNI_SV.includes(z.stav)).forEach((z) => { pocty[z.stav] = (pocty[z.stav] || 0) + 1; });
      return { zakazky: r.sort((a, b) => (['VYDANO', 'ZRUSENO'].includes(a.stav) - ['VYDANO', 'ZRUSENO'].includes(b.stav)) || b.id - a.id).map((z) => { const d = zakazkaDict(z); return { ...d, heslo: z.heslo ? '••••' : null }; }),
        pocty, hori_lhuta: DB.servis.filter(hori).length, stavy: STAVY_SV, vyrizeni: VYRIZENI_SV };
    }],
    ['GET', /^\/api\/servis\/(\d+)$/, (m) => { prihlasen(); return zakazkaDict(zakazka(m[1])); }],
    ['POST', /^\/api\/servis$/, (m, q, b) => {
      const u = prihlasen();
      if (!b.zakaznik || !b.zarizeni || !b.zavada) throw new Chyba(422, 'Vyplňte zákazníka, zařízení a závadu');
      if (b.typ === 'REKLAMACE' && !(b.prodej_id || b.doklad_koupe || b.datum_koupe)) throw new Chyba(400, 'U reklamace vyplňte doklad o koupi nebo datum nákupu');
      return zakazkaDict(novaZakazka(DB, b, u.id));
    }],
    ['PUT', /^\/api\/servis\/(\d+)$/, (m, q, b) => {
      prihlasen(); const z = zakazka(m[1]); otevrena(z);
      POLE_SV.forEach((k) => { if (k === 'heslo' && b.heslo === '••••') return; const v = b[k]; z[k] = typeof v === 'string' ? (v.trim() || null) : (v ?? null); }); z.upraveno = ted();
      return zakazkaDict(z);
    }],
    ['POST', /^\/api\/servis\/(\d+)\/stav$/, (m, q, b) => {
      const u = prihlasen(); const z = zakazka(m[1]); otevrena(z);
      if (!STAVY_SV[b.stav] || b.stav === 'VYDANO') throw new Chyba(400, 'Neplatný stav');
      let popis = STAVY_SV[b.stav];
      if (b.vyjadreni != null) z.vyjadreni = b.vyjadreni.trim() || null;
      if (b.stav === 'U_DODAVATELE') {
        const dod = (b.dodavatel || z.dodavatel || '').trim(); if (!dod) throw new Chyba(400, 'Vyplňte, komu se zařízení posílá (dodavatel, výrobce, servis)');
        Object.assign(z, { dodavatel: dod, dodavatel_rma: (b.dodavatel_rma || z.dodavatel_rma || '').trim() || null, odeslano_dodavateli: ted() });
        popis += `: ${dod}${z.dodavatel_rma ? ', RMA ' + z.dodavatel_rma : ''}`;
      }
      if (z.stav === 'U_DODAVATELE' && b.stav !== 'U_DODAVATELE') z.vraceno_od_dodavatele = ted();
      if (b.stav === 'HOTOVO') {
        const v = b.vyrizeni || z.vyrizeni; if (!VYRIZENI_SV[v]) throw new Chyba(400, 'Vyberte, jak byla zakázka vyřízena');
        Object.assign(z, { vyrizeni: v, vyrizeno: z.vyrizeno || ted() }); popis += ` – ${VYRIZENI_SV[v]}`;
      }
      if (b.stav === 'ZRUSENO' && z.zaloha) throw new Chyba(409, 'Zakázka má zaplacenou zálohu – vydejte ji zákazníkovi a zálohu vraťte vratkou');
      z.stav = b.stav; historie(DB, z.id, u.id, b.stav, popis + (b.text ? `. ${b.text}` : ''));
      return zakazkaDict(z);
    }],
    ['POST', /^\/api\/servis\/(\d+)\/poznamka$/, (m, q, b) => { const u = prihlasen(); const z = zakazka(m[1]); historie(DB, z.id, u.id, null, String(b.text || '').trim()); return zakazkaDict(z); }],
    ['POST', /^\/api\/servis\/(\d+)\/polozky$/, (m, q, b) => {
      prihlasen(); const z = zakazka(m[1]); otevrena(z);
      let pol;
      if (b.zbozi_id) { const zb = zbozi(b.zbozi_id); if (!zb) throw new Chyba(404, 'Zboží nenalezeno'); pol = { zbozi_id: zb.id, nazev: zb.nazev, cena: b.cena == null ? zb.cena : b.cena, sazba_dph: zb.sazba_dph }; }
      else { if (!b.nazev || b.cena == null) throw new Chyba(400, 'Práce nebo díl mimo katalog potřebuje název a cenu'); pol = { zbozi_id: null, nazev: b.nazev.trim(), cena: b.cena, sazba_dph: b.sazba_dph ?? 21 }; }
      DB.servis_polozky.push({ id: DB.dalsi.spol++, zakazka_id: z.id, mnozstvi: b.mnozstvi || 1, ...pol }); z.upraveno = ted();
      return zakazkaDict(z);
    }],
    ['DELETE', /^\/api\/servis\/(\d+)\/polozky\/(\d+)$/, (m) => {
      prihlasen(); const z = zakazka(m[1]); otevrena(z);
      DB.servis_polozky = DB.servis_polozky.filter((p) => !(p.id === +m[2] && p.zakazka_id === z.id)); return zakazkaDict(z);
    }],
    ['POST', /^\/api\/servis\/(\d+)\/zaloha$/, (m, q, b) => {
      const u = prihlasen(); const z = zakazka(m[1]); otevrena(z);
      const p = prodej(DB, { platba: b.platba, prijato: b.prijato, polozky: [{ nazev: `Záloha na opravu ${z.cislo}`, mnozstvi: 1, cena: b.castka, sazba_dph: 21 }] });
      z.zaloha = (z.zaloha || 0) + b.castka; historie(DB, z.id, u.id, null, `Přijata záloha ${(b.castka / 100).toLocaleString('cs-CZ', { minimumFractionDigits: 2 })} Kč (${b.platba === 'HOTOVE' ? 'hotově' : 'kartou'})`);
      return { zakazka: zakazkaDict(z), prodej: prodejDict(p) };
    }],
    ['POST', /^\/api\/servis\/(\d+)\/vydat$/, (m, q, b) => {
      const u = prihlasen(); const z = zakazka(m[1]); otevrena(z); const d = zakazkaDict(z);
      if (z.typ === 'REKLAMACE' && !z.vyrizeni) throw new Chyba(400, 'Nejdřív zapište, jak byla reklamace vyřízena');
      let p = null;
      if (b.platba === 'HOTOVE' || b.platba === 'KARTA') {
        const pol = d.polozky.map((x) => (x.zbozi_id ? { zbozi_id: x.zbozi_id, mnozstvi: x.mnozstvi, cena: x.cena } : { nazev: x.nazev, mnozstvi: x.mnozstvi, cena: x.cena, sazba_dph: x.sazba_dph }));
        if (z.zaloha) pol.push({ nazev: `Odečtení zálohy ${z.cislo}`, mnozstvi: 1, cena: -z.zaloha, sazba_dph: 21 });
        if (!pol.length) throw new Chyba(400, 'Zakázka nemá žádnou práci ani díl k zaplacení – vydejte ji jako bezplatnou');
        p = prodej(DB, { platba: b.platba, prijato: b.prijato, polozky: pol }); z.prodej_vydani_id = p.id;
      } else if (b.platba === 'FAKTURA') z.faktura_id = b.faktura_id;
      else {
        if (z.zaloha) throw new Chyba(409, 'Zakázka má zaplacenou zálohu – vydejte ji s platbou nebo zálohu vraťte vratkou');
        const dily = d.polozky.filter((x) => x.zbozi_id);
        if (dily.length) {
          const cas = ted(); const cislo = `V${cas.slice(0, 4)}-${String(dalsiCislo(DB, 'vydejka-' + cas.slice(0, 4))).padStart(5, '0')}`; const vid = DB.dalsi.vydejka++;
          let celkem = 0;
          dily.forEach((x) => { const zb = zbozi(x.zbozi_id); DB.vydejka_polozky.push({ vydejka_id: vid, zbozi_id: zb.id, mnozstvi: x.mnozstvi, nakupni_cena: zb.nakupni_cena }); pohyb(DB, zb.id, -x.mnozstvi, 'VYDEJ', cislo, u.id, `servis ${z.cislo}`); celkem += Math.round((zb.nakupni_cena || 0) * x.mnozstvi); });
          DB.vydejky.push({ id: vid, cislo, cas, uzivatel_id: u.id, duvod: 'SPOTREBA', komu: `servis ${z.cislo}`, poznamka: 'díly na bezplatnou / záruční opravu', celkem_nakup: celkem, stornovano: 0 });
          z.vydejka_id = vid;
        }
      }
      Object.assign(z, { stav: 'VYDANO', vydano: ted(), vydal_id: u.id, vyrizeno: z.vyrizeno || ted() });
      historie(DB, z.id, u.id, 'VYDANO', 'Vydáno zákazníkovi' + { HOTOVE: ', zaplaceno hotově', KARTA: ', zaplaceno kartou', FAKTURA: ', na fakturu', ZDARMA: ' bez platby' }[b.platba]);
      return { zakazka: zakazkaDict(z), prodej: p ? prodejDict(p) : null };
    }],
    ['POST', /^\/api\/servis\/(\d+)\/email$/, () => { throw new Chyba(400, 'V demu se e-maily neodesílají.'); }],
    ['GET', /^\/api\/serie$/, (m, q) => {
      prihlasen(); const t = (q.get('q') || '').trim(); if (t.length < 3) return [];
      return DB.serie.filter((x) => x.sn.includes(t)).slice(-20).reverse().map((x) => {
        const p = x.prodej_id ? DB.prodeje.find((y) => y.id === x.prodej_id) : null; const f = x.faktura_id ? DB.faktury.find((y) => y.id === x.faktura_id) : null;
        return { ...x, prodejka: p ? p.cislo : null, stornovano: p ? p.stornovano : 0, faktura: f ? f.cislo : null, v_zaruce: !!(x.zaruka_do && x.zaruka_do >= ted().slice(0, 10)) };
      });
    }],
    ['POST', /^\/api\/zbozi\/interni-ean$/, (m, q, b) => {
      spravce(); const prideleno = [];
      const ids = (b.ids && b.ids.length) ? b.ids : DB.zbozi.filter((z) => z.aktivni && !eanyZbozi(z.id).length).map((z) => z.id);
      ids.forEach((zid) => {
        if (eanyZbozi(zid).length) return;
        let kod;
        do { const z12 = '29' + String(dalsiCislo(DB, 'interni-ean')).padStart(10, '0'); const s = [...z12].reduce((a, c, i) => a + +c * (i % 2 ? 3 : 1), 0); kod = z12 + ((10 - s % 10) % 10); } while (DB.eany[kod]);
        DB.eany[kod] = zid; revEany = null; prideleno.push({ zbozi_id: zid, ean: kod });
      });
      return { prideleno };
    }],
    ['GET', /^\/api\/sklad\/objednavka$/, () => {
      prihlasen(); const od30 = plus(ted().slice(0, 10), -30); const od90 = plus(ted().slice(0, 10), -90);
      return DB.zbozi.filter((z) => z.aktivni && z.min_stav > 0 && z.stav <= z.min_stav).sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs')).map((z) => {
        const prodano = (od) => Math.max(0, -DB.pohyby.filter((p) => p.zbozi_id === z.id && p.typ === 'PRODEJ' && p.cas.slice(0, 10) >= od).reduce((s, p) => s + p.mnozstvi, 0));
        const pp = DB.prijemka_polozky.filter((x) => x.zbozi_id === z.id).map((x) => ({ ...x, p: DB.prijemky.find((y) => y.id === x.prijemka_id) })).filter((x) => x.p && !x.p.stornovano).pop();
        const dod = pp ? klicDodavatele(pp.p.dodavatel_ico, pp.p.dodavatel) : null;
        const kod = dod ? Object.entries(DB.dodavatel_kody).filter(([k, v]) => k.startsWith(dod + '|') && v.zbozi_id === z.id).map(([k]) => k.split('|')[1]).pop() || null : null;
        const p30 = prodano(od30);
        return { zbozi_id: z.id, nazev: z.nazev, kod: z.kod, ean: eanyZbozi(z.id)[0] || null, jednotka: z.jednotka, stav: z.stav, min_stav: z.min_stav, prodano_30: p30, prodano_90: prodano(od90),
          navrh: Math.max(Math.ceil(Math.max(2 * z.min_stav, z.min_stav + p30) - z.stav), 1), nakupni_cena: (pp && pp.nakupni_cena) || z.nakupni_cena,
          dodavatel: pp ? pp.p.dodavatel : null, dodavatel_ico: pp ? pp.p.dodavatel_ico : null, posledni_prijem: pp ? pp.p.cas.slice(0, 10) : null, kod_dodavatele: kod };
      });
    }],
    ['POST', /^\/api\/uzaverka\/odeslat$/, () => { prihlasen(); throw new Chyba(400, 'V demu se e-maily neodesílají – ve skutečné pokladně odejde uzávěrka se souhrnem a měsíčním Excelem.'); }],
    ['POST', /^\/api\/email\/test$/, () => { spravce(); throw new Chyba(400, 'V demu se e-maily neodesílají.'); }],

    ['GET', /^\/api\/zaloha\/stav$/, () => { spravce(); return { posledni: null, lokalni: [], rclone: false, varovani: false }; }],
    ['POST', /^\/api\/zaloha$/, () => { spravce(); throw new Chyba(400, 'V demu se nezálohuje – data jsou jen ve vašem prohlížeči.'); }],
  ];

  /* ------------------------------------------------------------------ fetch */

  // až po definici všech pomocných funkcí (const nejsou hoistované); skutečný sklad se čte z IndexedDB asynchronně
  let pripraveno = Promise.resolve();
  if (skladovyRezim()) {
    pripraveno = idb('get').then((d) => { DB = d && d.zdroj && d.verze >= 5 ? Object.assign(d, { verze: VERZE }) : null; }, () => {}).then(() => {
      if (!DB) { try { localStorage.removeItem(REZIM_KLIC); } catch { /* nic */ } DB = nacti(); uloz(); }
    });
  } else { DB = nacti(); uloz(); }

  const puvodniFetch = window.fetch.bind(window);
  window.fetch = async function (vstup, init) {
    init = init || {};
    const url = new URL(typeof vstup === 'string' ? vstup : vstup.url, location.href);
    const i = url.pathname.indexOf('/api/');
    if (i < 0) return puvodniFetch(vstup, init);
    const cesta = url.pathname.slice(i);
    const metoda = (init.method || 'GET').toUpperCase();
    await pripraveno;
    revEany = null;
    await new Promise((r) => setTimeout(r, 40));
    const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    try {
      const telo = init.body ? JSON.parse(init.body) : {};
      for (const [m, re, fn] of routes) {
        const shoda = m === metoda && cesta.match(re);
        if (shoda) { const v = await fn(shoda, url.searchParams, telo); uloz(metoda); return json(v === undefined ? {} : v, 200); }
      }
      return json({ detail: 'Not Found' }, 404);
    } catch (e) {
      uloz(metoda);
      if (e instanceof Chyba) return json({ detail: e.detail }, e.status);
      console.error(e);
      return json({ detail: 'Chyba dema: ' + (e && e.message) }, 500);
    }
  };

  /* ------------------------------------------------------------------ lišta dema */

  function lista() {
    const el = document.createElement('div');
    el.id = 'demo-lista';
    el.innerHTML = `<strong>DEMO</strong> · PIN šéf <b>1234</b>, prodavač <b>1111</b> · ${DB.zdroj
      ? `<b>skutečný sklad ${DB.zdroj.prodejna}</b> · jen v tomto prohlížeči · <a href="#" id="demo-reset">zpět na ukázková data</a>`
      : `data jen v tomto prohlížeči · <a href="vzorova_faktura.isdoc" download>vzorová faktura</a> · <a href="#" id="demo-sklad">🔒 skutečný sklad Varnsdorf</a> · <a href="#" id="demo-reset">začít znovu</a>`}
      <button id="demo-skryt" title="Skrýt">×</button>`;
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:70;background:#1d1d1f;color:#fff;padding:8px 12px;border-radius:10px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:calc(100vw - 24px)';
    el.querySelectorAll('a').forEach((a) => { a.style.color = '#ffd9d6'; });
    const b = el.querySelector('#demo-skryt'); b.style.cssText = 'background:none;border:0;color:#aaa;font-size:16px;cursor:pointer;margin-left:6px';
    b.onclick = () => el.remove();
    el.querySelector('#demo-reset').onclick = async (e) => {
      e.preventDefault();
      if (DB.zdroj) {
        if (!confirm('Zavřít skutečný sklad a vrátit ukázková data? Sklad z tohoto prohlížeče zmizí, příště bude potřeba znovu heslo.')) return;
        await idb('clear').catch(() => {});
        [REZIM_KLIC, 'pokladna.kosik', 'pokladna.prijem'].forEach((k) => localStorage.removeItem(k));
      } else {
        if (!confirm('Smazat všechny změny v demu a začít znovu?')) return;
        ['pokladna.demo.db', 'pokladna.kosik', 'pokladna.prijem'].forEach((k) => localStorage.removeItem(k));
      }
      location.hash = ''; location.reload();
    };
    const sk = el.querySelector('#demo-sklad');
    if (sk) sk.onclick = (e) => { e.preventDefault(); odemknoutSklad(); };
    document.body.appendChild(el);
  }
  // Odkazy na stažení souborů ze serveru (faktury, zálohy) v demu nejsou.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/api/"]');
    if (a) { e.preventDefault(); alert('V demu se soubory nestahují.'); }
  }, true);
  function odemknoutSklad() {
    const z = document.createElement('div');
    z.className = 'zavoj'; z.style.zIndex = 90;
    z.innerHTML = `<form class="okno" style="max-width:420px" autocomplete="on"><div class="hlav"><h2>Skutečný sklad Varnsdorf</h2></div>
      <div class="telo"><p class="mut" style="margin-top:0">Katalog a stav skladu z Trellu jsou na GitHubu zašifrované. Po zadání hesla se rozšifrují
        jen v tomto prohlížeči a místo ukázkových dat uvidíte celý sklad (13 639 karet). Nikam se nic neposílá.</p>
        <input type="text" name="username" value="sklad-varnsdorf" autocomplete="username" hidden>
        <input type="password" id="demo-heslo" placeholder="Heslo" autocomplete="current-password" autocapitalize="off" spellcheck="false" required>
        <label class="zatrh" style="margin-top:8px"><input type="checkbox" id="demo-ukaz"> Zobrazit heslo</label>
        <p class="mut2" style="margin:6px 0 0">Na velikosti písmen, mezerách ani pomlčkách nezáleží.</p>
        <div class="chyba-text" id="demo-chyba"></div></div>
      <div class="pata"><button type="button" class="btn" data-zpet>Zpět</button><button type="submit" class="btn hl">Odemknout</button></div></form>`;
    const f = z.querySelector('form'); const tl = f.querySelector('[type=submit]');
    const zavri = () => z.remove();
    z.querySelector('[data-zpet]').onclick = zavri;
    z.querySelector('#demo-ukaz').onchange = (e) => { z.querySelector('#demo-heslo').type = e.target.checked ? 'text' : 'password'; };
    z.addEventListener('keydown', (e) => { if (e.key === 'Escape') zavri(); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      tl.disabled = true; tl.textContent = 'Rozšifrovávám…'; z.querySelector('#demo-chyba').textContent = '';
      try {
        const s = await rozsifrujSklad(z.querySelector('#demo-heslo').value);
        await idb('put', novaDb(s));
        localStorage.setItem(REZIM_KLIC, 'sklad');
        ['pokladna.kosik', 'pokladna.prijem'].forEach((k) => localStorage.removeItem(k));
        location.hash = '#sklad/stav'; location.reload();
      } catch (er) {
        z.querySelector('#demo-chyba').textContent = er.message || String(er);
        tl.disabled = false; tl.textContent = 'Odemknout';
      }
    };
    document.body.appendChild(z);
    z.querySelector('#demo-heslo').focus();
  }
  const start = () => pripraveno.then(lista);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
