/* Demo pokladny pro GitHub Pages: napodobenina serveru přímo v prohlížeči.
 *
 * Zachytává volání fetch('/api/...') z app.js a odpovídá stejně jako pokladna/server.py.
 * Data jsou v localStorage tohoto prohlížeče, EET se jen předstírá (žádné spojení s finanční správou).
 * Načítá se před app.js jen v sestaveném demu (docs/), skutečná pokladna ho neobsahuje.
 */
(function () {
  'use strict';

  const KLIC = 'pokladna.demo.db';
  const VERZE = 4;
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

  function novaDb() {
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
      },
      uzivatele: [
        { id: 1, jmeno: 'Šéf (demo)', pin: '1234', role: 'SPRAVCE', aktivni: 1, vytvoreno: ted() },
        { id: 2, jmeno: 'Prodavač (demo)', pin: '1111', role: 'PRODAVAC', aktivni: 1, vytvoreno: ted() },
      ],
      zbozi: [], eany: {}, prodeje: [], polozky: [], prijemky: [], prijemka_polozky: [], pohyby: [], dodavatel_kody: {},
      odberatele: [], faktury: [], faktura_polozky: [], vydejky: [], vydejka_polozky: [],
    };
    db.dalsi.vydejka = 1;
    db.dalsi.odberatel = 1; db.dalsi.faktura = 1; db.dalsi.fpol = 1;
    for (const [nazev, ean, kat, cena, nakup, stav, jed] of ZBOZI) {
      const id = db.dalsi.zbozi++;
      db.zbozi.push({ id, nazev, kod: null, kategorie: kat, cena: cena * 100, sazba_dph: 21, nakupni_cena: nakup * 100, jednotka: jed,
        stav: 0, min_stav: jed === 'ks' ? 2 : 20, aktivni: 1, poznamka: null, vytvoreno: ted(), upraveno: ted() });
      db.eany[ean] = id;
      pohyb(db, id, stav, 'KOREKCE', 'demo', null, 'ukázková data');
    }
    // Dvě ukázkové účtenky, ať účtenky a uzávěrka nejsou prázdné.
    db.relace = 2;
    prodej(db, { platba: 'HOTOVE', prijato: 100000, polozky: [{ zbozi_id: 1, mnozstvi: 2 }, { zbozi_id: 5, mnozstvi: 1 }] });
    prodej(db, { platba: 'KARTA', polozky: [{ zbozi_id: 13, mnozstvi: 1 }] });
    // Ukázkový kontakt a dvě faktury převodem: jedna po splatnosti, jedna uhrazená.
    const o = { id: db.dalsi.odberatel++, nazev: 'Ukázková firma s.r.o.', ico: '12345678', dic: 'CZ12345678', ulice: 'Náměstí 1', psc: '408 01', mesto: 'Rumburk', email: 'nakup@example.com', telefon: null, poznamka: null, vytvoreno: ted(), upraveno: ted() };
    db.odberatele.push(o);
    const pred = (dni) => { const d = new Date(); d.setDate(d.getDate() - dni); return d.toISOString().slice(0, 10); };
    fakturaPrevodem(db, o, [{ zbozi_id: 9, mnozstvi: 2 }, { zbozi_id: 10, mnozstvi: 2 }], pred(20), null);
    fakturaPrevodem(db, o, [{ zbozi_id: 12, mnozstvi: 3 }], pred(10), pred(3));
    db.relace = null;
    return db;
  }

  let DB;
  function nacti() {
    try { const d = JSON.parse(localStorage.getItem(KLIC)); if (d && d.verze === VERZE) return d; } catch { /* nové demo */ }
    return novaDb();
  }
  function uloz() { try { localStorage.setItem(KLIC, JSON.stringify(DB)); } catch { /* bez úložiště demo jede jen do obnovení stránky */ } }

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
  const eanyZbozi = (id) => Object.keys(DB.eany).filter((e) => DB.eany[e] === id);
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

  function prodejDict(p) {
    const u = DB.uzivatele.find((x) => x.id === p.uzivatel_id);
    const f = (DB.faktury || []).find((x) => x.prodej_id === p.id);
    return { ...p, prodavac: u ? u.jmeno : null, eet_varovani: [], polozky: DB.polozky.filter((i) => i.prodej_id === p.id), faktura: f ? { id: f.id, cislo: f.cislo } : null };
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
        radky.push({ zbozi_id: z.id, nazev: z.nazev, ean: Object.keys(db.eany).find((e) => db.eany[e] === z.id) || null,
          mnozstvi: Math.round(pol.mnozstvi * 1000) / 1000, cena, puvodni_cena: cena !== z.cena ? z.cena : null, sazba_dph: z.sazba_dph });
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
    for (const r of radky) {
      db.polozky.push({ id: db.dalsi.polozka++, prodej_id: p.id, ...r });
      if (r.zbozi_id != null) pohyb(db, r.zbozi_id, -r.mnozstvi, 'PRODEJ', p.cislo, db.relace);
    }
    eetOdesli(p);
    return p;
  }

  /* ------------------------------------------------------------------ vydané faktury */

  function radkyDokladu(db, polozky) {
    return polozky.filter((p) => p.mnozstvi).map((p) => {
      if (p.zbozi_id != null) {
        const z = db.zbozi.find((x) => x.id === p.zbozi_id); if (!z) throw new Chyba(400, `Zboží ${p.zbozi_id} neexistuje`);
        const cena = p.cena == null ? z.cena : p.cena;
        return { zbozi_id: z.id, nazev: z.nazev, mnozstvi: p.mnozstvi, jednotka: z.jednotka, cena, sazba_dph: z.sazba_dph, celkem: Math.round(cena * p.mnozstvi) };
      }
      if (!p.nazev || p.cena == null) throw new Chyba(400, 'Položka mimo katalog potřebuje název a cenu');
      return { zbozi_id: null, nazev: p.nazev, mnozstvi: p.mnozstvi, jednotka: 'ks', cena: p.cena, sazba_dph: p.sazba_dph ?? 21, celkem: Math.round(p.cena * p.mnozstvi) };
    });
  }
  const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const adresa = (o) => [o.ulice, [o.psc, o.mesto].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;

  function novaFaktura(db, o, data) {
    const rok = data.vystaveni.slice(0, 4);
    const cislo = `${db.nastaveni.faktura_rada || 'FV'}${rok}${String(dalsiCislo(db, 'faktura-' + rok)).padStart(4, '0')}`;
    const f = { id: db.dalsi.faktura++, cislo, vs: cislo.replace(/\D/g, '').slice(-10), odberatel_id: o.id || null, odb_nazev: o.nazev, odb_ico: o.ico || null, odb_dic: o.dic || null,
      odb_adresa: adresa(o), odb_email: o.email || null, datum_vystaveni: data.vystaveni, duzp: data.duzp || data.vystaveni,
      splatnost: data.splatnost || plus(data.vystaveni, +db.nastaveni.faktura_splatnost_dni || 14), forma_uhrady: data.forma, poznamka: data.poznamka || null,
      celkem: data.radky.reduce((s, r) => s + r.celkem, 0), stav: data.stav, datum_uhrady: data.uhrazeno || null, prodej_id: data.prodej_id || null,
      uzivatel_id: db.relace, vytvoreno: ted(), odeslano: null };
    db.faktury.push(f);
    data.radky.forEach((r) => db.faktura_polozky.push({ id: db.dalsi.fpol++, faktura_id: f.id, ...r }));
    return f;
  }

  function fakturaPrevodem(db, o, polozky, vystaveni, uhrazeno) {
    const radky = radkyDokladu(db, polozky);
    const f = novaFaktura(db, o, { vystaveni, forma: 'PREVOD', radky, stav: uhrazeno ? 'UHRAZENO' : 'NEUHRAZENO', uhrazeno });
    radky.forEach((r) => { if (r.zbozi_id != null) pohyb(db, r.zbozi_id, -r.mnozstvi, 'PRODEJ', f.cislo, db.relace, 'faktura'); });
    return f;
  }

  function rekap(polozky) {
    const m = {}; polozky.forEach((p) => { m[p.sazba_dph] = (m[p.sazba_dph] || 0) + p.celkem; });
    return Object.keys(m).sort((a, b) => b - a).map((s) => { const c = m[s]; const z = Math.round(c / (1 + s / 100)); return { sazba: +s, zaklad: z, dph: c - z, celkem: c }; });
  }

  function ibanZUctu(ucet) {
    const m = String(ucet || '').replace(/\s/g, '').match(/^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/);
    if (!m) return null;
    const bban = m[3] + (m[1] || '').padStart(6, '0') + m[2].padStart(10, '0');
    return 'CZ' + String(98 - [...(bban + '123500')].reduce((r, c) => (r * 10 + +c) % 97, 0)).padStart(2, '0') + bban;
  }

  function fakturaDict(f) {
    const polozky = DB.faktura_polozky.filter((p) => p.faktura_id === f.id);
    const p = f.prodej_id ? DB.prodeje.find((x) => x.id === f.prodej_id) : null;
    const dnes = ted().slice(0, 10);
    const iban = ibanZUctu(DB.nastaveni.faktura_ucet);
    return { ...f, polozky, dph: rekap(polozky), vystavil: (DB.uzivatele.find((u) => u.id === f.uzivatel_id) || {}).jmeno || null, prodejka: p ? p.cislo : null,
      po_splatnosti: f.stav === 'NEUHRAZENO' && f.splatnost < dnes, iban, qr: !!(iban && f.forma_uhrady === 'PREVOD' && f.stav === 'NEUHRAZENO') };
  }

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
  const ZBOZI_POLE = ['nazev', 'kod', 'kategorie', 'cena', 'sazba_dph', 'nakupni_cena', 'jednotka', 'min_stav', 'poznamka'];

  function ulozEany(zid, eany) {
    const ciste = [...new Set((eany || []).map((e) => String(e).trim()).filter(Boolean))];
    for (const e of ciste) {
      if (DB.eany[e] && DB.eany[e] !== zid) throw new Chyba(409, `EAN ${e} už má zboží „${zbozi(DB.eany[e]).nazev}“`);
    }
    for (const e of eanyZbozi(zid)) delete DB.eany[e];
    ciste.forEach((e) => { DB.eany[e] = zid; });
  }

  const routes = [
    ['GET', /^\/api\/stav$/, () => {
      const u = ja(); const n = DB.nastaveni;
      return { potreba_nastaveni: false, uzivatel: u ? { id: u.id, jmeno: u.jmeno, role: u.role } : null, eet_rezim: n.eet_rezim,
        firma: Object.fromEntries(['firma_nazev', 'firma_ico', 'firma_dic', 'firma_adresa', 'provozovna', 'telefon', 'platce_dph', 'zaokrouhlovat_hotovost', 'uctenka_paticka',
          'faktura_ucet', 'faktura_pata', 'faktura_splatnost_dni'].map((k) => [k, n[k]])) };
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
      const t = (q.get('q') || '').trim();
      if (t) {
        const sl = norm(t).split(/\s+/);
        r = r.filter((z) => DB.eany[t] === z.id || z.kod === t || sl.every((s) => norm(z.nazev).includes(s) || norm(z.kategorie).includes(s)));
      }
      return r.sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs')).slice(0, Math.min(+(q.get('limit') || 100), 1000)).map(zboziDict);
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
      return { ...zboziDict(z), pohyby };
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
      z.aktivni = b.aktivni === false ? 0 : 1; z.upraveno = ted();
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
        if (p.ean_z_faktury && !DB.eany[p.ean_z_faktury]) DB.eany[p.ean_z_faktury] = p.zbozi_id;
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
        prodavaci: Object.values(prod), celkem: den.reduce((s, p) => s + p.celkem, 0) };
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
        .map((o) => ({ ...o, faktur: DB.faktury.filter((f) => f.odberatel_id === o.id && f.stav !== 'STORNO').length,
          dluzi: DB.faktury.filter((f) => f.odberatel_id === o.id && f.stav === 'NEUHRAZENO').reduce((s, f) => s + f.celkem, 0) }))
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
      let r = DB.faktury.slice().reverse();
      if (filtr === 'neuhrazene') r = r.filter((f) => f.stav === 'NEUHRAZENO');
      if (filtr === 'po_splatnosti') r = r.filter((f) => f.stav === 'NEUHRAZENO' && f.splatnost < dnes);
      if (filtr === 'uhrazene') r = r.filter((f) => f.stav === 'UHRAZENO');
      if (t) r = r.filter((f) => f.cislo.toLowerCase().includes(t) || norm(f.odb_nazev).includes(t) || (f.odb_ico || '').startsWith(t));
      const nu = DB.faktury.filter((f) => f.stav === 'NEUHRAZENO'); const ps = nu.filter((f) => f.splatnost < dnes);
      return { faktury: r.map((f) => ({ ...f, po_splatnosti: f.stav === 'NEUHRAZENO' && f.splatnost < dnes })),
        souhrn: { neuhrazeno: nu.reduce((s, f) => s + f.celkem, 0), po_splatnosti: ps.reduce((s, f) => s + f.celkem, 0), pocet_po_splatnosti: ps.length,
          mesic: DB.faktury.filter((f) => f.stav !== 'STORNO' && f.datum_vystaveni.startsWith(dnes.slice(0, 7))).reduce((s, f) => s + f.celkem, 0) } };
    }],
    ['GET', /^\/api\/faktury-vydane\/(\d+)$/, (m) => { prihlasen(); const f = DB.faktury.find((x) => x.id === +m[1]); if (!f) throw new Chyba(404, 'Faktura nenalezena'); return fakturaDict(f); }],
    ['POST', /^\/api\/faktury-vydane$/, (m, q, b) => {
      const u = prihlasen(); const dnes = ted().slice(0, 10);
      const o = { ...b.odberatel }; if (!o.nazev) throw new Chyba(422, 'Vyplňte odběratele');
      const ulozeny = b.ulozit_kontakt === false ? o : ulozOdberatele(o);
      const zaklad = { vystaveni: b.datum_vystaveni || dnes, duzp: b.duzp, splatnost: b.splatnost, poznamka: b.poznamka };
      let f;
      if (b.prodej_id) {
        const p = DB.prodeje.find((x) => x.id === b.prodej_id);
        if (!p || p.typ !== 'PRODEJ' || p.stornovano) throw new Chyba(400, 'K této prodejce nejde fakturu vystavit');
        if (DB.faktury.some((x) => x.prodej_id === p.id)) throw new Chyba(409, 'K této prodejce už faktura existuje');
        const radky = DB.polozky.filter((i) => i.prodej_id === p.id).map(({ zbozi_id, nazev, mnozstvi, cena, sazba_dph, celkem }) => ({ zbozi_id, nazev, mnozstvi, jednotka: null, cena, sazba_dph, celkem }));
        if (p.zaokrouhleni) radky.push({ zbozi_id: null, nazev: 'Zaokrouhlení', mnozstvi: 1, jednotka: null, cena: p.zaokrouhleni, sazba_dph: 0, celkem: p.zaokrouhleni });
        f = novaFaktura(DB, { ...ulozeny, id: ulozeny.id }, { ...zaklad, duzp: p.cas.slice(0, 10), forma: p.platba, radky, stav: 'UHRAZENO', uhrazeno: p.cas.slice(0, 10), prodej_id: p.id });
      } else if (b.forma_uhrady === 'HOTOVE' || b.forma_uhrady === 'KARTA') {
        const p = prodej(DB, { platba: b.forma_uhrady, prijato: b.prijato, polozky: b.polozky });
        const radky = DB.polozky.filter((i) => i.prodej_id === p.id).map(({ zbozi_id, nazev, mnozstvi, cena, sazba_dph, celkem }) => ({ zbozi_id, nazev, mnozstvi, jednotka: null, cena, sazba_dph, celkem }));
        if (p.zaokrouhleni) radky.push({ zbozi_id: null, nazev: 'Zaokrouhlení', mnozstvi: 1, jednotka: null, cena: p.zaokrouhleni, sazba_dph: 0, celkem: p.zaokrouhleni });
        f = novaFaktura(DB, ulozeny, { ...zaklad, forma: b.forma_uhrady, radky, stav: 'UHRAZENO', uhrazeno: dnes, prodej_id: p.id });
      } else {
        const radky = radkyDokladu(DB, b.polozky || []);
        if (!radky.length) throw new Chyba(400, 'Faktura nemá žádnou položku');
        f = novaFaktura(DB, ulozeny, { ...zaklad, forma: b.forma_uhrady, radky, stav: 'NEUHRAZENO' });
        radky.forEach((r) => { if (r.zbozi_id != null) pohyb(DB, r.zbozi_id, -r.mnozstvi, 'PRODEJ', f.cislo, u.id, 'faktura'); });
      }
      return fakturaDict(f);
    }],
    ['POST', /^\/api\/faktury-vydane\/(\d+)\/uhrada$/, (m, q, b) => {
      prihlasen(); const f = DB.faktury.find((x) => x.id === +m[1]); if (!f) throw new Chyba(404, 'Faktura nenalezena');
      if (f.stav === 'STORNO' || f.prodej_id) throw new Chyba(409, 'U této faktury nejde úhradu měnit');
      if (b.uhrazeno === false) Object.assign(f, { stav: 'NEUHRAZENO', datum_uhrady: null }); else Object.assign(f, { stav: 'UHRAZENO', datum_uhrady: b.datum || ted().slice(0, 10) });
      return fakturaDict(f);
    }],
    ['POST', /^\/api\/faktury-vydane\/(\d+)\/storno$/, (m) => {
      const u = prihlasen(); const f = DB.faktury.find((x) => x.id === +m[1]); if (!f) throw new Chyba(404, 'Faktura nenalezena');
      if (f.stav !== 'NEUHRAZENO' || f.prodej_id) throw new Chyba(409, 'Stornovat jde jen neuhrazenou fakturu převodem. Zaplacenou vraťte stornem prodejky.');
      DB.faktura_polozky.filter((p) => p.faktura_id === f.id && p.zbozi_id != null).forEach((p) => pohyb(DB, p.zbozi_id, p.mnozstvi, 'STORNO', f.cislo, u.id, 'storno faktury'));
      f.stav = 'STORNO'; return fakturaDict(f);
    }],
    ['POST', /^\/api\/faktury-vydane\/(\d+)\/odeslat$/, () => { throw new Chyba(400, 'V demu se e-maily neodesílají.'); }],
    ['POST', /^\/api\/uzaverka\/odeslat$/, () => { prihlasen(); throw new Chyba(400, 'V demu se e-maily neodesílají – ve skutečné pokladně odejde uzávěrka se souhrnem a měsíčním Excelem.'); }],
    ['POST', /^\/api\/email\/test$/, () => { spravce(); throw new Chyba(400, 'V demu se e-maily neodesílají.'); }],

    ['GET', /^\/api\/zaloha\/stav$/, () => { spravce(); return { posledni: null, lokalni: [], rclone: false, varovani: false }; }],
    ['POST', /^\/api\/zaloha$/, () => { spravce(); throw new Chyba(400, 'V demu se nezálohuje – data jsou jen ve vašem prohlížeči.'); }],
  ];

  /* ------------------------------------------------------------------ fetch */

  DB = nacti(); uloz();   // až po definici všech pomocných funkcí (const nejsou hoistované)

  const puvodniFetch = window.fetch.bind(window);
  window.fetch = async function (vstup, init) {
    init = init || {};
    const url = new URL(typeof vstup === 'string' ? vstup : vstup.url, location.href);
    const i = url.pathname.indexOf('/api/');
    if (i < 0) return puvodniFetch(vstup, init);
    const cesta = url.pathname.slice(i);
    const metoda = (init.method || 'GET').toUpperCase();
    await new Promise((r) => setTimeout(r, 40));
    const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    try {
      const telo = init.body ? JSON.parse(init.body) : {};
      for (const [m, re, fn] of routes) {
        const shoda = m === metoda && cesta.match(re);
        if (shoda) { const v = await fn(shoda, url.searchParams, telo); uloz(); return json(v === undefined ? {} : v, 200); }
      }
      return json({ detail: 'Not Found' }, 404);
    } catch (e) {
      uloz();
      if (e instanceof Chyba) return json({ detail: e.detail }, e.status);
      console.error(e);
      return json({ detail: 'Chyba dema: ' + (e && e.message) }, 500);
    }
  };

  /* ------------------------------------------------------------------ lišta dema */

  function lista() {
    const el = document.createElement('div');
    el.id = 'demo-lista';
    el.innerHTML = `<strong>DEMO</strong> · PIN šéf <b>1234</b>, prodavač <b>1111</b> · data jen v tomto prohlížeči ·
      <a href="vzorova_faktura.isdoc" download>vzorová faktura</a> · <a href="#" id="demo-reset">začít znovu</a> <button id="demo-skryt" title="Skrýt">×</button>`;
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:70;background:#1d1d1f;color:#fff;padding:8px 12px;border-radius:10px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:calc(100vw - 24px)';
    el.querySelectorAll('a').forEach((a) => { a.style.color = '#ffd9d6'; });
    const b = el.querySelector('#demo-skryt'); b.style.cssText = 'background:none;border:0;color:#aaa;font-size:16px;cursor:pointer;margin-left:6px';
    b.onclick = () => el.remove();
    el.querySelector('#demo-reset').onclick = (e) => {
      e.preventDefault();
      if (confirm('Smazat všechny změny v demu a začít znovu?')) {
        ['pokladna.demo.db', 'pokladna.kosik', 'pokladna.prijem'].forEach((k) => localStorage.removeItem(k));
        location.hash = ''; location.reload();
      }
    };
    document.body.appendChild(el);
  }
  // Odkazy na stažení souborů ze serveru (faktury, zálohy) v demu nejsou.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/api/"]');
    if (a) { e.preventDefault(); alert('V demu se soubory nestahují.'); }
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', lista); else lista();
})();
