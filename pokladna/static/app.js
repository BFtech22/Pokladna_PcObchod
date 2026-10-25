'use strict';

/* ======================================================================== pomocné */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cislo2 = (h) => (h / 100).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kc = (h) => (h == null ? '—' : cislo2(h) + ' Kč');
const mn = (q) => Number(q).toLocaleString('cs-CZ', { maximumFractionDigits: 3 });
const datumCas = (iso) => (iso ? new Date(iso).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const cas = (iso) => (iso ? new Date(iso).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : '');
const dnes = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

function parseKc(s) {
  const t = String(s ?? '').replace(/\s|Kč/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
function parseMn(s) {
  const n = Number(String(s ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

const S = {
  uzivatel: null,
  firma: {},
  eetRezim: 'vypnuto',
  kosik: nactiLokalne('kosik', []),
  vratka: false,
  prijem: nactiLokalne('prijem', { dodavatel: '', dodavatel_ico: '', doklad: '', poznamka: '', soubor_id: null, polozky: [] }),
};
const spravce = () => S.uzivatel && S.uzivatel.role === 'SPRAVCE';

function nactiLokalne(klic, vychozi) {
  try { const v = localStorage.getItem('pokladna.' + klic); return v ? JSON.parse(v) : vychozi; } catch { return vychozi; }
}
function ulozLokalne(klic, hodnota) {
  try { localStorage.setItem('pokladna.' + klic, JSON.stringify(hodnota)); } catch { /* bez úložiště to jede dál */ }
}

async function api(metoda, url, telo) {
  const opt = { method: metoda, credentials: 'same-origin', headers: {} };
  if (telo !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(telo); }
  let r;
  try { r = await fetch(url, opt); } catch { throw new Error('Server pokladny neodpovídá'); }
  let data = null;
  try { data = await r.json(); } catch { /* prázdná odpověď */ }
  if (r.status === 401 && !url.startsWith('/api/prihlaseni')) {
    S.uzivatel = null; zavriVsechnaOkna(); vykresliPrihlaseni();
    throw new Error('Přihlaste se znovu');
  }
  if (!r.ok) {
    let msg = `Chyba ${r.status}`;
    if (data && Array.isArray(data.detail)) msg = data.detail.map((d) => d.msg).join(', ');
    else if (data && data.detail) msg = data.detail;
    throw new Error(msg);
  }
  return data;
}

function toast(text, typ = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + typ;
  t.textContent = text;
  $('#toasty').appendChild(t);
  setTimeout(() => t.remove(), typ === 'chyba' ? 6000 : 3500);
}
const chyba = (e) => toast(e.message || String(e), 'chyba');

/* ======================================================================== modální okna */

const okna = [];
function okno({ titul, obsah, pata = '', siroke = false, poZavreni }) {
  const z = document.createElement('div');
  z.className = 'zavoj';
  z.innerHTML = `<div class="okno ${siroke ? 'siroke' : ''}" role="dialog" aria-modal="true">
      <div class="hlav"><h2>${esc(titul)}</h2><button class="zavrit" aria-label="Zavřít">×</button></div>
      <div class="telo">${obsah}</div>${pata ? `<div class="pata">${pata}</div>` : ''}</div>`;
  document.body.appendChild(z);
  const o = { el: z, zavri() { const i = okna.indexOf(o); if (i < 0) return; okna.splice(i, 1); z.remove(); poZavreni && poZavreni(); fokusSken(); } };
  okna.push(o);
  $('.zavrit', z).onclick = () => o.zavri();
  z.addEventListener('mousedown', (e) => { if (e.target === z) o.zavri(); });
  setTimeout(() => { const f = $('[autofocus]', z) || $('input, select, textarea, button.hl, button.ok', $('.telo', z)) || $('.pata .hl, .pata .ok', z); f && f.focus(); f && f.select && f.select(); }, 30);
  return o;
}
function zavriVsechnaOkna() { while (okna.length) okna[okna.length - 1].zavri(); }
function potvrd(titul, text, tlacitko = 'Potvrdit', nebezpecne = false) {
  return new Promise((ok) => {
    let vysledek = false;
    const o = okno({
      titul, obsah: `<p style="margin:0">${text}</p>`,
      pata: `<button class="btn" data-ne>Zpět</button><button class="btn ${nebezpecne ? 'nebezp' : 'hl'}" data-ano>${esc(tlacitko)}</button>`,
      poZavreni: () => ok(vysledek),
    });
    $('[data-ne]', o.el).onclick = () => o.zavri();
    $('[data-ano]', o.el).onclick = () => { vysledek = true; o.zavri(); };
    $('[data-ano]', o.el).focus();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && okna.length) { e.preventDefault(); okna[okna.length - 1].zavri(); }
});

/* ======================================================================== start, přihlášení, kostra */

async function start() {
  try {
    const st = await api('GET', '/api/stav');
    S.firma = st.firma; S.eetRezim = st.eet_rezim;
    if (st.potreba_nastaveni) return vykresliPrvniSpravce();
    if (!st.uzivatel) return vykresliPrihlaseni();
    S.uzivatel = st.uzivatel;
    vykresliKostru();
    route();
  } catch (e) {
    $('#aplikace').innerHTML = `<div class="prihlaseni"><div class="karta"><img class="logo" src="static/img/logo.webp" alt="PcObchod"><p class="chyba-text">${esc(e.message)}</p><button class="btn hl" onclick="location.reload()">Zkusit znovu</button></div></div>`;
  }
}

function vykresliPrvniSpravce() {
  $('#aplikace').innerHTML = `<div class="prihlaseni"><form class="karta" id="f">
    <img class="logo" src="static/img/logo.webp" alt="PcObchod">
    <h2 style="margin:0 0 6px">První spuštění</h2>
    <p class="mut" style="margin:0 0 16px">Založte správce pokladny. PIN slouží k přihlášení (4–12 číslic).</p>
    <div style="display:grid;gap:10px;text-align:left">
      <label class="pole">Jméno<input type="text" name="jmeno" required autofocus></label>
      <label class="pole">PIN<input type="password" name="pin" inputmode="numeric" pattern="\\d{4,12}" required></label>
      <label class="pole">PIN znovu<input type="password" name="pin2" inputmode="numeric" required></label>
    </div>
    <div class="chyba-text" id="ch"></div>
    <button class="btn hl" style="width:100%;margin-top:6px">Založit a přihlásit</button></form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get('pin') !== f.get('pin2')) { $('#ch').textContent = 'PINy se neshodují'; return; }
    try { await api('POST', '/api/prvni-spravce', { jmeno: f.get('jmeno'), pin: f.get('pin') }); start(); }
    catch (er) { $('#ch').textContent = er.message; }
  };
}

function vykresliPrihlaseni() {
  let pin = '';
  $('#aplikace').innerHTML = `<div class="prihlaseni"><div class="karta">
    <img class="logo" src="static/img/logo.webp" alt="PcObchod">
    <div class="mut">Zadejte svůj PIN</div>
    <div class="pin-tecky" id="tecky"></div>
    <div class="klavesnice">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-c="${n}">${n}</button>`).join('')}
      <button data-c="smaz" title="Smazat">⌫</button><button data-c="0">0</button><button data-c="ok" style="background:var(--brand);color:#fff;border-color:var(--brand)">OK</button></div>
    <div class="chyba-text" id="ch"></div></div></div>`;
  const tecky = () => { $('#tecky').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<span class="${i < pin.length ? 'plna' : ''}"></span>`).join(''); };
  const odeslat = async () => {
    if (!pin) return;
    try {
      const r = await api('POST', '/api/prihlaseni', { pin });
      document.removeEventListener('keydown', klav);
      S.uzivatel = { jmeno: r.jmeno, role: r.role };
      start();
    } catch (e) { pin = ''; tecky(); $('#ch').textContent = e.message; }
  };
  const stisk = (c) => {
    $('#ch').textContent = '';
    if (c === 'smaz') pin = pin.slice(0, -1);
    else if (c === 'ok') return odeslat();
    else if (pin.length < 12) pin += c;
    tecky();
  };
  const klav = (e) => {
    if (!$('#tecky')) return document.removeEventListener('keydown', klav);
    if (/^\d$/.test(e.key)) stisk(e.key);
    else if (e.key === 'Backspace') stisk('smaz');
    else if (e.key === 'Enter') stisk('ok');
  };
  document.addEventListener('keydown', klav);
  $$('.klavesnice button').forEach((b) => { b.onclick = () => stisk(b.dataset.c); });
  tecky();
}

const MENU = [
  ['prodej', 'Prodej'], ['uctenky', 'Prodejky'], ['faktury', 'Faktury'], ['zbozi', 'Zboží'], ['sklad', 'Sklad'], ['uzaverka', 'Uzávěrka'], ['nastaveni', 'Nastavení', true],
];

function vykresliKostru() {
  $('#aplikace').innerHTML = `<header class="lista">
      <a href="#prodej"><img class="logo" src="static/img/logo.webp" alt="PcObchod"></a>
      <nav class="menu">${MENU.filter((m) => !m[2] || spravce()).map(([k, t]) => `<a href="#${k}" data-m="${k}">${t}</a>`).join('')}</nav>
      <div class="uzivatel">
        ${S.eetRezim === 'playground' ? '<span class="rezim-test" title="Tržby jdou do testovacího prostředí finanční správy">EET TEST</span>' : ''}
        <a href="#nastaveni/zaloha" class="eet-ind chyba skryt" id="zaloha-ind" title="Data nejsou zálohovaná mimo prodejnu" style="text-decoration:none">Záloha!</a>
        <span class="eet-ind" id="eet-ind">EET</span>
        <span class="mut">${esc(S.uzivatel.jmeno)}</span>
        <button class="btn mala" id="odhlasit">Odhlásit</button>
      </div></header><main id="obsah"></main>`;
  $('#odhlasit').onclick = async () => { await api('POST', '/api/odhlaseni').catch(() => {}); S.uzivatel = null; vykresliPrihlaseni(); };
  obnovEet();
  obnovZalohu();
}

async function obnovEet() {
  const el = $('#eet-ind');
  if (!el) return;
  if (S.eetRezim === 'vypnuto') { el.className = 'eet-ind'; el.textContent = 'EET vypnuto'; return; }
  try {
    const f = await api('GET', '/api/eet/fronta');
    if (f.chyba) { el.className = 'eet-ind chyba'; el.textContent = `EET: ${f.chyba} chyb`; el.title = 'Některé tržby finanční správa odmítla – viz Účtenky'; }
    else if (f.ceka) { el.className = 'eet-ind ceka'; el.textContent = `EET: ${f.ceka} čeká`; el.title = `Nejstarší neodeslaná tržba: ${datumCas(f.nejstarsi)} (zákonná lhůta 48 h)`; }
    else { el.className = 'eet-ind ok'; el.textContent = 'EET OK'; el.title = 'Všechny tržby jsou odeslané'; }
  } catch { /* nic */ }
}
setInterval(obnovEet, 30000);

function route() {
  if (!S.uzivatel || !$('#obsah')) return;
  const [cast, pod] = (location.hash.slice(1) || 'prodej').split('/');
  $$('nav.menu a').forEach((a) => a.classList.toggle('aktivni', a.dataset.m === cast));
  const v = { prodej: viewProdej, uctenky: viewUctenky, faktury: viewFaktury, zbozi: viewZbozi, sklad: viewSklad, uzaverka: viewUzaverka, nastaveni: viewNastaveni }[cast] || viewProdej;
  zavriVsechnaOkna();
  v(pod);
}
window.addEventListener('hashchange', route);

/* ======================================================================== prodej */

function fokusSken() {
  const s = $('#sken');
  if (s && !okna.length) setTimeout(() => s.focus(), 0);
}

function viewProdej() {
  $('#obsah').innerHTML = `<div class="prodej">
    <div>
      <div class="sken-box">
        <input id="sken" class="sken" type="text" autocomplete="off" spellcheck="false" placeholder="Načtěte čárový kód nebo pište název…  (3* = 3 kusy)">
        <div id="nasep" class="naseptavac skryt"></div>
      </div>
      <div class="karta kosik">
        <table class="tab"><thead><tr><th>Zboží</th><th style="width:150px;text-align:center">Množství</th><th class="num" style="width:120px">Cena</th><th class="num" style="width:130px">Celkem</th><th style="width:44px"></th></tr></thead>
        <tbody id="kosik-telo"></tbody></table>
        <div id="kosik-prazdny" class="prazdno">Košík je prázdný. Načtěte zboží čtečkou.</div>
      </div>
    </div>
    <aside class="souhrn">
      <div class="karta celkem-box">
        <div class="celkem-label" id="celkem-label">K úhradě</div>
        <div class="celkem" id="celkem">0,00 Kč</div>
        <div class="sub"><span>Položek</span><span id="pocet">0</span></div>
        <div class="sub" id="zaokr-radek"><span>Hotově po zaokrouhlení</span><span id="zaokr"></span></div>
      </div>
      <div class="platby">
        <button class="btn hl velka" id="b-hotove">Hotově <span class="klavesa">F2</span></button>
        <button class="btn velka" id="b-karta">Kartou <span class="klavesa">F3</span></button>
      </div>
      <div class="akce-mrizka">
        <button class="btn" id="b-vratka">Vratka</button>
        <button class="btn" id="b-mimo">Mimo katalog</button>
        <button class="btn" id="b-faktura">Na fakturu</button>
        <button class="btn" id="b-posledni">Poslední prodejka</button>
        <button class="btn nebezp" id="b-zrusit">Zrušit <span class="klavesa">F8</span></button>
      </div>
      <div class="mut2" style="text-align:center">Čtečka píše do pole nahoře. Šipky a Enter vybírají z nabídky.</div>
    </aside></div>`;

  const sken = $('#sken');
  const nasep = $('#nasep');
  let vysledky = [];
  let vybrany = -1;
  let casovac = null;

  const zavriNasep = () => { nasep.classList.add('skryt'); vysledky = []; vybrany = -1; };
  const ukazNasep = () => {
    if (!vysledky.length) return zavriNasep();
    nasep.innerHTML = vysledky.map((z, i) => `<div class="pol ${i === vybrany ? 'vybrana' : ''}" data-i="${i}">
        <span class="n">${esc(z.nazev)}<div class="mut2">${esc(z.eany[0] || z.kod || '')}${z.kategorie ? ' · ' + esc(z.kategorie) : ''}</div></span>
        <span class="mut2">skladem ${mn(z.stav)} ${esc(z.jednotka)}</span><strong class="num">${kc(z.cena)}</strong></div>`).join('');
    nasep.classList.remove('skryt');
    $$('.pol', nasep).forEach((p) => { p.onmousedown = (e) => { e.preventDefault(); vyber(vysledky[+p.dataset.i]); }; });
  };
  const hledej = async (q) => {
    try { vysledky = await api('GET', '/api/zbozi?limit=15&q=' + encodeURIComponent(q)); vybrany = vysledky.length ? 0 : -1; ukazNasep(); } catch (e) { chyba(e); }
  };
  const rozeberVstup = (v = sken.value) => rozeberSken(v);
  const vyber = (z) => {
    const { mnozstvi } = rozeberVstup();
    pridejDoKosiku(z, mnozstvi);
    sken.value = ''; zavriNasep(); fokusSken();
  };
  // Načtené kódy se zpracují postupně v pořadí, v jakém přišly. Pole se vyprázdní hned při Enteru,
  // takže rychle za sebou načtené kódy se nepomíchají s čekáním na odpověď serveru.
  let fronta = Promise.resolve();
  const zpracujKod = async ({ text, mnozstvi }) => {
    try {
      pridejDoKosiku(await api('GET', '/api/zbozi/kod/' + encodeURIComponent(text)), mnozstvi);
    } catch (er) {
      const nalez = await api('GET', '/api/zbozi?limit=15&q=' + encodeURIComponent(text)).catch(() => []);
      if (nalez.length === 1) return pridejDoKosiku(nalez[0], mnozstvi);
      if (nalez.length > 1) { sken.value = (mnozstvi !== 1 ? mn(mnozstvi) + '*' : '') + text; vysledky = nalez; vybrany = 0; ukazNasep(); return; }
      neznamyKod(text, mnozstvi);
    }
  };

  sken.addEventListener('input', () => {
    clearTimeout(casovac);
    const { text } = rozeberVstup();
    if (text.length < 2 || /^\d{8,}$/.test(text)) { zavriNasep(); return; }   // dlouhé číslo = čtečka, nehledat po znacích
    casovac = setTimeout(() => hledej(text), 180);
  });
  sken.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' && vysledky.length) { e.preventDefault(); vybrany = (vybrany + 1) % vysledky.length; ukazNasep(); return; }
    if (e.key === 'ArrowUp' && vysledky.length) { e.preventDefault(); vybrany = (vybrany - 1 + vysledky.length) % vysledky.length; ukazNasep(); return; }
    if (e.key === 'Escape') { zavriNasep(); sken.value = ''; return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(casovac);
    const vstup = rozeberVstup();
    if (!vstup.text) return;
    if (vybrany >= 0 && vysledky[vybrany] && !nasep.classList.contains('skryt')) return vyber(vysledky[vybrany]);
    sken.value = ''; zavriNasep();
    fronta = fronta.then(() => zpracujKod(vstup));
  });
  sken.addEventListener('blur', () => setTimeout(zavriNasep, 150));

  $('#b-hotove').onclick = () => zaplat('HOTOVE');
  $('#b-karta').onclick = () => zaplat('KARTA');
  $('#b-zrusit').onclick = async () => { if (S.kosik.length && await potvrd('Zrušit nákup', 'Vyprázdnit celý košík?', 'Vyprázdnit', true)) { S.kosik = []; S.vratka = false; ulozKosik(); } };
  $('#b-vratka').onclick = () => { S.vratka = !S.vratka; vykresliKosik(); fokusSken(); };
  $('#b-mimo').onclick = () => polozkaMimo();
  $('#b-faktura').onclick = () => {
    if (!S.kosik.length) return toast('Košík je prázdný');
    formularFaktury({ polozky: S.kosik.map((r) => ({ zbozi_id: r.zbozi_id, nazev: r.nazev, mnozstvi: r.mnozstvi, cena: r.cena, sazba_dph: r.sazba_dph, jednotka: r.jednotka })), zKosiku: true });
  };
  $('#b-posledni').onclick = async () => {
    try { const p = await api('GET', '/api/prodeje?limit=1'); if (p.length) detailUctenky(p[0].id); else toast('Zatím žádná prodejka'); } catch (e) { chyba(e); }
  };
  vykresliKosik();
  fokusSken();
}

// Na prodejní obrazovce se fokus po každém kliknutí vrací do pole pro čtečku.
document.addEventListener('mouseup', (e) => {
  if ($('#sken') && !e.target.closest('input, select, textarea, .naseptavac, .zavoj')) fokusSken();
});

document.addEventListener('keydown', (e) => {
  if (!$('#sken') || okna.length) return;
  if (e.key === 'F2') { e.preventDefault(); zaplat('HOTOVE'); }
  if (e.key === 'F3') { e.preventDefault(); zaplat('KARTA'); }
  if (e.key === 'F8') { e.preventDefault(); $('#b-zrusit').click(); }
});

// Čtečka píše jako klávesnice. Na české klávesnici z „8595…“ udělá „áříř…“ – číselnou řadu převedeme zpět.
const CZ_CISLA = { '+': '1', 'ě': '2', 'š': '3', 'č': '4', 'ř': '5', 'ž': '6', 'ý': '7', 'á': '8', 'í': '9', 'é': '0' };
function opravKlavesnici(t) {
  return /^[+ěščřžýáíé0-9*]+$/.test(t) && /[+ěščřžýáíé]/.test(t) && t.length >= 6
    ? t.replace(/[+ěščřžýáíé]/g, (c) => CZ_CISLA[c]) : t;
}

// „3*kód“ = 3 kusy. Násobitel nad 9999 se nebere (je to spíš omylem slepený kód).
function rozeberSken(v) {
  const t = opravKlavesnici(String(v || '').trim());
  const m = t.match(/^(\d{1,4}(?:[.,]\d{1,3})?)\s*\*\s*(.*)$/);
  return m ? { mnozstvi: parseMn(m[1]), text: m[2].trim() } : { mnozstvi: 1, text: t };
}

function ulozKosik() { ulozLokalne('kosik', S.kosik); vykresliKosik(); }

function pridejDoKosiku(z, mnozstvi = 1) {
  if (!Number.isFinite(mnozstvi) || mnozstvi === 0) mnozstvi = 1;
  if (Math.abs(mnozstvi) > 9999) { toast('Nesmyslné množství, zkontrolujte načtený kód', 'chyba'); return; }
  const q = S.vratka ? -Math.abs(mnozstvi) : mnozstvi;
  const exist = S.kosik.find((r) => r.zbozi_id === z.id && r.cena === z.cena && Math.sign(r.mnozstvi) === Math.sign(q));
  if (exist) { exist.mnozstvi = Math.round((exist.mnozstvi + q) * 1000) / 1000; exist.nova = true; }
  else {
    S.kosik.push({ klic: Date.now() + Math.random(), zbozi_id: z.id, nazev: z.nazev, ean: z.eany ? z.eany[0] : null, cena: z.cena, katalog: z.cena,
      sazba_dph: z.sazba_dph, jednotka: z.jednotka, stav: z.stav, mnozstvi: q, nova: true });
  }
  if (q > 0 && z.stav - q < 0 && z.id) toast(`„${z.nazev}“ – na skladě evidováno ${mn(z.stav)} ${z.jednotka}`);
  ulozKosik();
}

function soucty() {
  const mezisoucet = S.kosik.reduce((s, r) => s + Math.round(r.cena * r.mnozstvi), 0);
  const zaokr = S.firma.zaokrouhlovat_hotovost === '1' ? Math.sign(mezisoucet) * Math.round(Math.abs(mezisoucet) / 100) * 100 : mezisoucet;
  return { mezisoucet, hotove: zaokr };
}

function vykresliKosik() {
  const telo = $('#kosik-telo');
  if (!telo) return;
  telo.innerHTML = S.kosik.map((r) => `<tr data-k="${r.klic}" class="${r.mnozstvi < 0 ? 'zaporna' : ''} ${r.nova ? 'nova' : ''}">
      <td><div class="nazev">${esc(r.nazev)}</div><div class="mut2">${esc(r.ean || (r.zbozi_id ? '' : 'mimo katalog'))}${r.mnozstvi < 0 ? ' · <strong style="color:var(--varovani)">vratka</strong>' : ''}</div></td>
      <td style="text-align:center"><span class="mnoz"><button class="btn ikona" data-a="minus">−</button><input type="text" inputmode="decimal" value="${mn(r.mnozstvi)}" data-a="mn"><button class="btn ikona" data-a="plus">+</button></span></td>
      <td class="num"><span class="cena-klik ${r.cena !== r.katalog && r.zbozi_id ? 'cena-zmenena' : ''}" data-a="cena" title="Změnit cenu">${kc(r.cena)}</span></td>
      <td class="num"><strong>${kc(Math.round(r.cena * r.mnozstvi))}</strong></td>
      <td><button class="btn ikona nebezp" data-a="smaz" title="Odebrat">×</button></td></tr>`).join('');
  S.kosik.forEach((r) => delete r.nova);
  $('#kosik-prazdny').classList.toggle('skryt', S.kosik.length > 0);
  const { mezisoucet, hotove } = soucty();
  $('#celkem').textContent = kc(mezisoucet);
  $('#celkem-label').textContent = mezisoucet < 0 ? 'Vrátit zákazníkovi' : 'K úhradě';
  $('#pocet').textContent = mn(S.kosik.reduce((s, r) => s + Math.abs(r.mnozstvi), 0));
  $('#zaokr-radek').classList.toggle('skryt', hotove === mezisoucet);
  $('#zaokr').textContent = kc(hotove);
  $('#b-vratka').classList.toggle('hl', S.vratka);
  $('#b-vratka').textContent = S.vratka ? 'Vratka zapnuta' : 'Vratka';
  $('#sken').classList.toggle('vratka', S.vratka);

  $$('tr[data-k]', telo).forEach((tr) => {
    const r = S.kosik.find((x) => String(x.klic) === tr.dataset.k);
    tr.querySelector('[data-a=minus]').onclick = () => { r.mnozstvi = Math.round((r.mnozstvi - 1) * 1000) / 1000; if (r.mnozstvi === 0) S.kosik.splice(S.kosik.indexOf(r), 1); ulozKosik(); };
    tr.querySelector('[data-a=plus]').onclick = () => { r.mnozstvi = Math.round((r.mnozstvi + 1) * 1000) / 1000; if (r.mnozstvi === 0) S.kosik.splice(S.kosik.indexOf(r), 1); ulozKosik(); };
    const inp = tr.querySelector('[data-a=mn]');
    inp.onchange = () => { const q = parseMn(inp.value); if (!Number.isFinite(q)) return vykresliKosik(); if (q === 0) S.kosik.splice(S.kosik.indexOf(r), 1); else r.mnozstvi = q; ulozKosik(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { inp.blur(); fokusSken(); } };
    tr.querySelector('[data-a=smaz]').onclick = () => { S.kosik.splice(S.kosik.indexOf(r), 1); ulozKosik(); };
    tr.querySelector('[data-a=cena]').onclick = () => zmenCenu(r);
  });
}

function zmenCenu(r) {
  const o = okno({
    titul: 'Změna ceny',
    obsah: `<p class="mut" style="margin-top:0">${esc(r.nazev)}${r.zbozi_id ? ` · katalogová cena ${kc(r.katalog)}` : ''}</p>
      <label class="pole">Cena za ${esc(r.jednotka || 'ks')} s DPH (Kč)<input type="text" inputmode="decimal" id="nc" value="${cislo2(r.cena)}" autofocus></label>
      <div class="chipy" style="margin-top:10px">${[5, 10, 15, 20].map((p) => `<button class="btn mala" data-sleva="${p}">sleva ${p} %</button>`).join('')}</div>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Použít</button>',
  });
  const ok = () => { const c = parseKc($('#nc', o.el).value); if (!Number.isFinite(c) || c < 0) return toast('Neplatná cena', 'chyba'); r.cena = c; o.zavri(); ulozKosik(); };
  $$('[data-sleva]', o.el).forEach((b) => { b.onclick = () => { $('#nc', o.el).value = cislo2(Math.round(r.katalog * (100 - b.dataset.sleva) / 100)); }; });
  $('#nc', o.el).onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  $('[data-ok]', o.el).onclick = ok;
  $('[data-zpet]', o.el).onclick = () => o.zavri();
}

function polozkaMimo() {
  const o = okno({
    titul: 'Položka mimo katalog',
    obsah: `<div class="mrizka">
      <label class="pole siroke">Název<input type="text" id="mn-nazev" placeholder="např. Servis – práce" autofocus></label>
      <label class="pole">Cena s DPH (Kč)<input type="text" inputmode="decimal" id="mn-cena"></label>
      <label class="pole">Množství<input type="text" inputmode="decimal" id="mn-q" value="1"></label>
      <label class="pole">Sazba DPH<select id="mn-dph"><option>21</option><option>12</option><option>0</option></select></label></div>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Přidat</button>',
  });
  const ok = () => {
    const nazev = $('#mn-nazev', o.el).value.trim(); const cena = parseKc($('#mn-cena', o.el).value); const q = parseMn($('#mn-q', o.el).value);
    if (!nazev || !Number.isFinite(cena) || cena == null || !Number.isFinite(q) || !q) return toast('Vyplňte název, cenu a množství', 'chyba');
    S.kosik.push({ klic: Date.now(), zbozi_id: null, nazev, ean: null, cena, katalog: cena, sazba_dph: +$('#mn-dph', o.el).value, jednotka: 'ks', stav: 0, mnozstvi: S.vratka ? -Math.abs(q) : q, nova: true });
    o.zavri(); ulozKosik();
  };
  $('[data-ok]', o.el).onclick = ok;
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $$('input', o.el).forEach((i) => { i.onkeydown = (e) => { if (e.key === 'Enter') ok(); }; });
}

function neznamyKod(kod, mnozstvi) {
  const o = okno({
    titul: 'Kód nenalezen',
    obsah: `<p style="margin-top:0">Kód <strong class="mono">${esc(kod)}</strong> v katalogu není.</p>
      ${spravce() ? '<p class="mut">Můžete zboží rovnou založit. Po uložení se přidá do košíku.</p>' : '<p class="mut">Zboží musí založit správce. Mezitím ho můžete prodat jako položku mimo katalog.</p>'}`,
    pata: `<button class="btn" data-zpet>Zpět</button><button class="btn" data-mimo>Mimo katalog</button>${spravce() ? '<button class="btn hl" data-zalozit>Založit zboží</button>' : ''}`,
  });
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-mimo]', o.el).onclick = () => { o.zavri(); polozkaMimo(); };
  const z = $('[data-zalozit]', o.el);
  if (z) z.onclick = () => { o.zavri(); formularZbozi(null, { ean: kod }, (nove) => pridejDoKosiku(nove, mnozstvi)); };
}

function zaplat(platba) {
  if (!S.kosik.length) return toast('Košík je prázdný');
  const { mezisoucet, hotove } = soucty();
  const castka = platba === 'HOTOVE' ? hotove : mezisoucet;
  if (castka < 0 || (castka === 0 && mezisoucet <= 0)) {
    return potvrd('Vratka', `Vrátit zákazníkovi <strong>${kc(-castka)}</strong> ${platba === 'HOTOVE' ? 'v hotovosti' : 'na kartu'}?`, 'Vrátit peníze')
      .then((ano) => ano && odesliProdej(platba, platba === 'HOTOVE' ? 0 : undefined));
  }
  if (platba === 'KARTA') {
    return potvrd('Platba kartou', `<span style="font-size:20px">Zaplaceno kartou na terminálu: <strong>${kc(castka)}</strong>?</span>`, 'Zaplaceno')
      .then((ano) => ano && odesliProdej('KARTA'));
  }
  const bankovky = [10000, 20000, 50000, 100000, 200000, 500000].filter((b) => b > castka).slice(0, 3);
  const o = okno({
    titul: 'Platba hotově',
    obsah: `<div class="mut" style="text-align:center">K úhradě${hotove !== mezisoucet ? ' (zaokrouhleno)' : ''}</div>
      <div class="velke-cislo">${kc(castka)}</div>
      <label class="pole">Přijato od zákazníka (Kč)<input type="text" inputmode="decimal" id="prijato" style="font-size:24px;min-height:54px" placeholder="${cislo2(castka)}" autofocus></label>
      <div class="rychle"><button class="btn" data-c="${castka}">Přesně</button>${bankovky.map((b) => `<button class="btn" data-c="${b}">${b / 100} Kč</button>`).join('')}</div>
      <div class="vraceni" id="vraceni">K vrácení: 0,00 Kč</div>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn ok" data-ok style="min-width:160px">Dokončit (Enter)</button>',
  });
  const inp = $('#prijato', o.el);
  const prepocet = () => {
    const p = inp.value.trim() === '' ? castka : parseKc(inp.value);
    const v = $('#vraceni', o.el);
    if (!Number.isFinite(p) || p < castka) { v.className = 'vraceni malo'; v.textContent = Number.isFinite(p) ? `Chybí ${kc(castka - p)}` : 'Neplatná částka'; return null; }
    v.className = 'vraceni'; v.textContent = `K vrácení: ${kc(p - castka)}`; return p;
  };
  inp.oninput = prepocet;
  $$('[data-c]', o.el).forEach((b) => { b.onclick = () => { inp.value = cislo2(+b.dataset.c); prepocet(); inp.focus(); }; });
  const ok = () => { const p = prepocet(); if (p == null) return; o.zavri(); odesliProdej('HOTOVE', p); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  $('[data-ok]', o.el).onclick = ok;
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  prepocet();
}

let odesilam = false;
async function odesliProdej(platba, prijato) {
  if (odesilam) return;
  odesilam = true;
  try {
    const telo = {
      platba, prijato,
      polozky: S.kosik.map((r) => (r.zbozi_id ? { zbozi_id: r.zbozi_id, mnozstvi: r.mnozstvi, cena: r.cena }
        : { nazev: r.nazev, mnozstvi: r.mnozstvi, cena: r.cena, sazba_dph: r.sazba_dph })),
    };
    const p = await api('POST', '/api/prodeje', telo);
    S.kosik = []; S.vratka = false; ulozKosik();
    obnovEet();
    hotovo(p);
  } catch (e) { chyba(e); } finally { odesilam = false; }
}

function eetText(p) {
  if (p.eet_stav === 'OK') return `<span class="stitek ok">EET odesláno</span>${p.eet_test ? ' <span class="stitek info">test</span>' : ''}`;
  if (p.eet_stav === 'CEKA') return '<span class="stitek ceka">EET čeká na odeslání</span>';
  if (p.eet_stav === 'CHYBA') return '<span class="stitek chyba">EET odmítnuto</span>';
  return '<span class="stitek sedy">EET vypnuto</span>';
}

function hotovo(p) {
  const o = okno({
    titul: p.celkem < 0 ? 'Vratka hotová' : 'Prodej dokončen',
    obsah: `<div style="text-align:center">
      <div class="mut">Účtenka ${esc(p.cislo)} · ${p.platba === 'HOTOVE' ? 'hotově' : 'kartou'}</div>
      <div class="velke-cislo">${kc(p.celkem)}</div>
      ${p.platba === 'HOTOVE' && p.vraceno ? `<div class="vraceni">Vrátit: ${kc(p.vraceno)}</div>` : ''}
      <div style="margin-top:14px">${eetText(p)}</div>
      ${p.eet_stav === 'CEKA' ? '<div class="mut2" style="margin-top:6px">Spojení s finanční správou teď nejde. Pokladna tržbu odešle sama, jakmile to půjde.</div>' : ''}
      ${p.eet_stav === 'CHYBA' ? `<div class="mut2" style="margin-top:6px">${esc(p.eet_chyba || '')}</div>` : ''}</div>`,
    pata: '<button class="btn" data-tisk>Tisk účtenky</button><button class="btn hl" data-novy autofocus>Nový nákup (Enter)</button>',
  });
  $('[data-tisk]', o.el).onclick = () => tiskUctenky(p);
  $('[data-novy]', o.el).onclick = () => o.zavri();
  $('[data-novy]', o.el).focus();
}

/* ======================================================================== tisk */

function rekapDph(polozky) {
  const m = {};
  polozky.forEach((i) => { m[i.sazba_dph] = (m[i.sazba_dph] || 0) + i.celkem; });
  return Object.keys(m).sort((a, b) => b - a).map((s) => { const c = m[s]; const z = Math.round(c / (1 + s / 100)); return { sazba: s, celkem: c, zaklad: z, dph: c - z }; });
}

function hlavickaTisku() {
  const f = S.firma;
  return `<img class="logo-tisk" src="static/img/logo.png" alt="">
    <div class="stred"><strong>${esc(f.firma_nazev || '')}</strong><br>${esc(f.firma_adresa || '')}
    ${f.firma_ico ? `<br>IČO: ${esc(f.firma_ico)}` : ''}${f.firma_dic ? ` · DIČ: ${esc(f.firma_dic)}` : ''}
    ${f.provozovna ? `<br>Provozovna: ${esc(f.provozovna)}` : ''}${f.telefon ? `<br>Tel.: ${esc(f.telefon)}` : ''}</div>`;
}

function tisk(html, a4 = false) {
  const t = $('#tisk');
  t.className = a4 ? 'a4' : '';
  t.innerHTML = html;
  // Tisk až po načtení obrázků (logo, QR platba).
  Promise.all($$('img', t).map((i) => (i.complete ? null : new Promise((ok) => { i.onload = ok; i.onerror = ok; }))))
    .then(() => setTimeout(() => window.print(), 50));
}

function tiskUctenky(p) {
  const platce = S.firma.platce_dph === '1';
  const dph = rekapDph(p.polozky);
  tisk(`${hlavickaTisku()}<div class="cara"></div>
    <div class="stred"><strong>${p.typ === 'STORNO' ? 'STORNO – opravný doklad' : (platce ? 'Zjednodušený daňový doklad' : 'Účtenka')}</strong><br>
    č. ${esc(p.cislo)} · ${datumCas(p.cas)}${p.prodavac ? `<br>Prodal: ${esc(p.prodavac)}` : ''}</div><div class="cara"></div>
    <table>${p.polozky.map((i) => `<tr><td colspan="2">${esc(i.nazev)}</td></tr>
      <tr><td>&nbsp;&nbsp;${mn(i.mnozstvi)} × ${cislo2(i.cena)}${platce ? ` (${i.sazba_dph} %)` : ''}</td><td class="r">${cislo2(i.celkem)}</td></tr>`).join('')}
    ${p.zaokrouhleni ? `<tr><td>Zaokrouhlení</td><td class="r">${cislo2(p.zaokrouhleni)}</td></tr>` : ''}</table>
    <div class="cara"></div>
    <table><tr class="velke"><td>CELKEM</td><td class="r">${kc(p.celkem)}</td></tr>
      <tr><td>${p.platba === 'HOTOVE' ? 'Hotově' : 'Kartou'}${p.platba === 'HOTOVE' && p.prijato ? ` – přijato ${cislo2(p.prijato)}` : ''}</td><td class="r">${p.platba === 'HOTOVE' && p.vraceno ? `vráceno ${cislo2(p.vraceno)}` : ''}</td></tr></table>
    ${platce ? `<div class="cara"></div><table><tr><td>DPH</td><td class="r">základ</td><td class="r">daň</td><td class="r">celkem</td></tr>
      ${dph.map((d) => `<tr><td>${d.sazba} %</td><td class="r">${cislo2(d.zaklad)}</td><td class="r">${cislo2(d.dph)}</td><td class="r">${cislo2(d.celkem)}</td></tr>`).join('')}</table>` : ''}
    <div class="cara"></div>
    <div style="font-size:9px">${p.eet_stav === 'VYPNUTO' ? '' : `Evidence tržeb: EIČ ${esc(p.eet_eic || '')}, ev. jednotka ${esc(p.eet_jednotka || '')}, pokladna ${esc(p.eet_pokl || '')}<br>
      ${p.eet_pok ? `POK: ${esc(p.eet_pok)}` : 'Tržba bude zaevidována dodatečně.'}${p.eet_rezim === 'playground' ? '<br><strong>TESTOVACÍ REŽIM EET – neplatný doklad</strong>' : ''}`}</div>
    <div class="stred" style="margin-top:3mm">${esc(S.firma.uctenka_paticka || '')}</div>`);
}

/* ======================================================================== účtenky */

async function viewUctenky() {
  $('#obsah').innerHTML = `<div class="karta"><div class="hlav"><h2>Prodejky</h2>
      <div class="radek"><input type="date" id="u-datum" value="${dnes()}" style="width:170px">
      <select id="u-filtr" style="width:200px"><option value="">Všechny</option><option value="CEKA">EET čeká</option><option value="CHYBA">EET odmítnuto</option></select></div></div>
    <div id="u-seznam"></div></div>`;
  const nacti = async () => {
    const filtr = $('#u-filtr').value;
    const q = filtr ? `eet_stav=${filtr}` : `datum=${$('#u-datum').value}`;
    $('#u-datum').disabled = !!filtr;
    try {
      const rows = await api('GET', '/api/prodeje?' + q);
      $('#u-seznam').innerHTML = rows.length ? `<table class="tab"><thead><tr><th>Čas</th><th>Číslo</th><th>Prodavač</th><th class="num">Položek</th><th>Platba</th><th class="num">Celkem</th><th>EET</th></tr></thead><tbody>
        ${rows.map((p) => `<tr class="klik" data-id="${p.id}"><td>${filtr ? datumCas(p.cas) : cas(p.cas)}</td><td class="mono">${esc(p.cislo)} ${p.typ === 'STORNO' ? '<span class="stitek chyba">storno</span>' : ''}${p.stornovano ? '<span class="stitek sedy">stornováno</span>' : ''}</td>
          <td>${esc(p.prodavac || '')}</td><td class="num">${p.pocet}</td><td>${p.platba === 'HOTOVE' ? 'hotově' : 'kartou'}</td><td class="num"><strong>${kc(p.celkem)}</strong></td><td>${eetText(p)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="prazdno">Žádné prodejky</div>';
      $$('#u-seznam tr[data-id]').forEach((tr) => { tr.onclick = () => detailUctenky(+tr.dataset.id, nacti); });
    } catch (e) { chyba(e); }
  };
  $('#u-datum').onchange = nacti;
  $('#u-filtr').onchange = nacti;
  nacti();
}

async function detailUctenky(id, poZmene) {
  let p;
  try { p = await api('GET', '/api/prodeje/' + id); } catch (e) { return chyba(e); }
  const o = okno({
    titul: `${p.typ === 'STORNO' ? 'Storno ' : 'Prodejka '}${p.cislo}`, siroke: true,
    obsah: `<div class="radek mezera" style="margin-bottom:12px"><div class="mut">${datumCas(p.cas)} · ${esc(p.prodavac || '')} · ${p.platba === 'HOTOVE' ? 'hotově' : 'kartou'}</div><div>${eetText(p)}</div></div>
      ${p.stornovano ? '<div class="upozorneni">Tato prodejka byla stornována.</div>' : ''}
      ${p.faktura ? `<div class="upozorneni" style="background:var(--info-svetla);color:var(--info)">K prodejce je vystavená faktura <a href="#faktury" data-fv="${p.faktura.id}">${esc(p.faktura.cislo)}</a>.</div>` : ''}
      <table class="tab"><thead><tr><th>Zboží</th><th class="num">Množství</th><th class="num">Cena</th><th class="num">DPH</th><th class="num">Celkem</th></tr></thead><tbody>
      ${p.polozky.map((i) => `<tr><td>${esc(i.nazev)}<div class="mut2">${esc(i.ean || '')}${i.puvodni_cena ? ` · katalog ${kc(i.puvodni_cena)}` : ''}</div></td><td class="num">${mn(i.mnozstvi)}</td><td class="num">${kc(i.cena)}</td><td class="num">${i.sazba_dph} %</td><td class="num">${kc(i.celkem)}</td></tr>`).join('')}
      ${p.zaokrouhleni ? `<tr><td colspan="4">Zaokrouhlení</td><td class="num">${kc(p.zaokrouhleni)}</td></tr>` : ''}
      <tr><td colspan="4"><strong>Celkem</strong></td><td class="num"><strong>${kc(p.celkem)}</strong></td></tr></tbody></table>
      ${p.platba === 'HOTOVE' ? `<p class="mut">Přijato ${kc(p.prijato)} · vráceno ${kc(p.vraceno)}</p>` : ''}
      ${p.eet_stav !== 'VYPNUTO' ? `<div class="karta" style="margin-top:12px;box-shadow:none"><div class="telo mut2" style="line-height:1.7">
        <strong>EET</strong> · režim ${esc(p.eet_rezim)} · EIČ ${esc(p.eet_eic)} · jednotka ${esc(p.eet_jednotka)} · pokladna ${esc(p.eet_pokl)}<br>
        POK: <span class="mono">${esc(p.eet_pok || '—')}</span> · pokusů ${p.eet_pokusy}${p.eet_posledni_pokus ? ` · naposledy ${datumCas(p.eet_posledni_pokus)}` : ''}
        ${p.eet_chyba && p.eet_stav !== 'OK' ? `<br><span style="color:var(--chyba)">${esc(p.eet_chyba)}</span>` : ''}
        ${p.eet_varovani.map((v) => `<br><span style="color:var(--varovani)">Varování ${v[0]}: ${esc(v[1])}</span>`).join('')}</div></div>` : ''}`,
    pata: `${p.typ === 'PRODEJ' && !p.stornovano ? '<button class="btn nebezp" data-storno>Stornovat</button>' : ''}
      ${['CEKA', 'CHYBA'].includes(p.eet_stav) ? '<button class="btn" data-eet>Odeslat do EET</button>' : ''}
      ${p.typ === 'PRODEJ' && !p.stornovano && !p.faktura ? '<button class="btn" data-fakt>Vystavit fakturu</button>' : ''}
      <span class="vypln"></span><button class="btn" data-tisk>Tisk</button><button class="btn hl" data-zavrit>Zavřít</button>`,
  });
  $('[data-zavrit]', o.el).onclick = () => o.zavri();
  $('[data-tisk]', o.el).onclick = () => tiskUctenky(p);
  const fk = $('[data-fakt]', o.el);
  if (fk) fk.onclick = () => { o.zavri(); formularFaktury({ prodej: p }); };
  const fvOdkaz = $('[data-fv]', o.el);
  if (fvOdkaz) fvOdkaz.onclick = (e) => { e.preventDefault(); o.zavri(); detailFaktury(+fvOdkaz.dataset.fv); };
  const st = $('[data-storno]', o.el);
  if (st) st.onclick = async () => {
    if (!await potvrd('Storno prodejky', `Stornovat prodejku ${esc(p.cislo)} na ${kc(p.celkem)}? Zboží se vrátí na sklad a do EET odejde záporná tržba.${p.platba === 'HOTOVE' ? ' Vraťte zákazníkovi hotovost.' : ''}`, 'Stornovat', true)) return;
    try { const s = await api('POST', `/api/prodeje/${p.id}/storno`); o.zavri(); toast(`Storno ${s.cislo} hotové`, 'ok'); obnovEet(); poZmene && poZmene(); detailUctenky(s.id, poZmene); } catch (e) { chyba(e); }
  };
  const ee = $('[data-eet]', o.el);
  if (ee) ee.onclick = async () => {
    ee.disabled = true;
    try { const r = await api('POST', `/api/prodeje/${p.id}/eet`); o.zavri(); toast(r.eet_stav === 'OK' ? 'Tržba odeslána' : `Neodesláno: ${r.eet_chyba}`, r.eet_stav === 'OK' ? 'ok' : 'chyba'); obnovEet(); poZmene && poZmene(); } catch (e) { chyba(e); ee.disabled = false; }
  };
}

/* ======================================================================== zboží */

async function viewZbozi() {
  $('#obsah').innerHTML = `<div class="karta"><div class="hlav"><h2>Zboží</h2>
      <div class="radek"><input type="search" id="z-q" placeholder="Hledat název, EAN, kód, kategorii…" style="width:320px">
      <label class="zatrh"><input type="checkbox" id="z-vse"> i neaktivní</label>
      ${spravce() ? '<button class="btn hl" id="z-nove">+ Nové zboží</button>' : ''}</div></div>
    <div id="z-seznam"></div></div>`;
  let casovac;
  const nacti = async () => {
    try {
      const rows = await api('GET', `/api/zbozi?limit=500&vse=${$('#z-vse').checked}&q=${encodeURIComponent($('#z-q').value.trim())}`);
      $('#z-seznam').innerHTML = rows.length ? `<table class="tab"><thead><tr><th>Název</th><th>EAN</th><th>Kód</th><th class="num">Cena s DPH</th><th class="num">DPH</th><th class="num">Skladem</th></tr></thead><tbody>
        ${rows.map((z) => `<tr class="klik" data-id="${z.id}" style="${z.aktivni ? '' : 'opacity:.5'}"><td><strong>${esc(z.nazev)}</strong>${z.kategorie ? `<div class="mut2">${esc(z.kategorie)}</div>` : ''}</td>
          <td class="mono">${esc(z.eany.join(', '))}</td><td class="mono">${esc(z.kod || '')}</td><td class="num">${kc(z.cena)}</td><td class="num">${z.sazba_dph} %</td>
          <td class="num" style="${z.stav <= z.min_stav ? 'color:var(--chyba);font-weight:700' : ''}">${mn(z.stav)} ${esc(z.jednotka)}</td></tr>`).join('')}</tbody></table>
        ${rows.length === 500 ? '<div class="prazdno">Zobrazeno prvních 500, upřesněte hledání.</div>' : ''}`
        : '<div class="prazdno">Nic nenalezeno</div>';
      $$('#z-seznam tr[data-id]').forEach((tr) => { tr.onclick = () => formularZbozi(+tr.dataset.id, null, nacti); });
    } catch (e) { chyba(e); }
  };
  $('#z-q').oninput = () => { clearTimeout(casovac); casovac = setTimeout(nacti, 200); };
  $('#z-q').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(casovac); nacti(); } };
  $('#z-vse').onchange = nacti;
  if ($('#z-nove')) $('#z-nove').onclick = () => formularZbozi(null, null, nacti);
  $('#z-q').focus();
  nacti();
}

async function formularZbozi(id, predvyplnit, poUlozeni) {
  let z = { nazev: '', kod: '', kategorie: '', cena: 0, sazba_dph: 21, nakupni_cena: null, jednotka: 'ks', min_stav: 0, aktivni: 1, poznamka: '', eany: [], pohyby: [], stav: 0 };
  if (id) { try { z = await api('GET', '/api/zbozi/' + id); } catch (e) { return chyba(e); } }
  if (predvyplnit && predvyplnit.ean) z.eany = [predvyplnit.ean];
  const lze = spravce();
  const dis = lze ? '' : 'disabled';
  const eany = [...z.eany];
  const o = okno({
    titul: id ? z.nazev : 'Nové zboží', siroke: true,
    obsah: `<form id="fz" class="mrizka" autocomplete="off">
      <label class="pole siroke">Název<input type="text" name="nazev" value="${esc(z.nazev)}" required ${dis} autofocus></label>
      <div class="pole siroke"><label class="pole">EAN / čárové kódy (načtěte čtečkou, Enter přidá)<input type="text" id="ean-vstup" ${dis} placeholder="naskenujte…"></label><div class="chipy" id="ean-chipy"></div></div>
      <label class="pole">Interní kód<input type="text" name="kod" value="${esc(z.kod || '')}" ${dis}></label>
      <label class="pole">Kategorie<input type="text" name="kategorie" value="${esc(z.kategorie || '')}" ${dis} list="kategorie-dl"></label>
      <label class="pole">Prodejní cena s DPH (Kč)<input type="text" inputmode="decimal" name="cena" value="${cislo2(z.cena)}" required ${dis}></label>
      <label class="pole">Sazba DPH<select name="sazba_dph" ${dis}>${[21, 12, 0].map((s) => `<option ${s === z.sazba_dph ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="pole">Nákupní cena bez DPH (Kč)<input type="text" inputmode="decimal" name="nakupni_cena" value="${z.nakupni_cena == null ? '' : cislo2(z.nakupni_cena)}" ${dis}></label>
      <div class="pole"><span>Marže</span><div id="marze" style="min-height:40px;display:flex;align-items:center;font-weight:700;color:var(--text)"></div></div>
      <label class="pole">Jednotka<select name="jednotka" ${dis}>${['ks', 'm', 'bal', 'sada', 'hod'].map((j) => `<option ${j === z.jednotka ? 'selected' : ''}>${j}</option>`).join('')}</select></label>
      <label class="pole">Minimální stav<input type="text" inputmode="decimal" name="min_stav" value="${mn(z.min_stav)}" ${dis}></label>
      ${id ? `<div class="pole"><span>Skladem</span><div style="min-height:40px;display:flex;align-items:center;font-weight:700">${mn(z.stav)} ${esc(z.jednotka)}</div></div>`
        : `<label class="pole">Počáteční stav<input type="text" inputmode="decimal" name="pocatecni_stav" value="0" ${dis}></label>`}
      <label class="zatrh" style="align-self:end;min-height:40px"><input type="checkbox" name="aktivni" ${z.aktivni ? 'checked' : ''} ${dis}> Aktivní (prodává se)</label>
      <label class="pole siroke">Poznámka<textarea name="poznamka" ${dis}>${esc(z.poznamka || '')}</textarea></label>
      <datalist id="kategorie-dl"></datalist></form>
      ${id && z.pohyby.length ? `<h3 style="margin:18px 0 8px;font-size:15px">Pohyby na skladě</h3><div style="max-height:260px;overflow:auto"><table class="tab"><thead><tr><th>Kdy</th><th>Typ</th><th>Doklad</th><th class="num">Změna</th><th class="num">Stav po</th><th>Kdo</th></tr></thead><tbody>
        ${z.pohyby.map((p) => `<tr><td>${datumCas(p.cas)}</td><td>${esc(p.typ.toLowerCase())}</td><td class="mono">${esc(p.doklad || '')}${p.poznamka ? ` <span class="mut2">${esc(p.poznamka)}</span>` : ''}</td><td class="num" style="color:${p.mnozstvi < 0 ? 'var(--chyba)' : 'var(--ok)'}">${p.mnozstvi > 0 ? '+' : ''}${mn(p.mnozstvi)}</td><td class="num">${mn(p.stav_po)}</td><td>${esc(p.uzivatel || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
    pata: lze ? '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ulozit>Uložit</button>' : '<button class="btn hl" data-zpet>Zavřít</button>',
  });
  const f = $('#fz', o.el);
  const chipy = () => {
    $('#ean-chipy', o.el).innerHTML = eany.map((e, i) => `<span class="chip">${esc(e)}${lze ? `<button type="button" data-i="${i}">×</button>` : ''}</span>`).join('') || '<span class="mut2">bez čárového kódu</span>';
    $$('#ean-chipy button', o.el).forEach((b) => { b.onclick = () => { eany.splice(+b.dataset.i, 1); chipy(); }; });
  };
  const eanVstup = $('#ean-vstup', o.el);
  eanVstup.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = opravKlavesnici(eanVstup.value.trim()); if (v && !eany.includes(v)) eany.push(v); eanVstup.value = ''; chipy(); } };
  const marze = () => {
    const c = parseKc(f.cena.value); const n = parseKc(f.nakupni_cena.value); const s = +f.sazba_dph.value;
    if (!Number.isFinite(c) || !Number.isFinite(n) || !n) { $('#marze', o.el).textContent = '—'; return; }
    const bez = c / (1 + s / 100);
    $('#marze', o.el).textContent = `${kc(Math.round(bez - n))} (${Math.round((bez - n) / n * 100)} %)`;
  };
  ['cena', 'nakupni_cena', 'sazba_dph'].forEach((k) => f[k].addEventListener('input', marze));
  chipy(); marze();
  api('GET', '/api/zbozi?limit=1000&vse=true').then((r) => { $('#kategorie-dl', o.el).innerHTML = [...new Set(r.map((x) => x.kategorie).filter(Boolean))].sort().map((k) => `<option value="${esc(k)}">`).join(''); }).catch(() => {});
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  const ul = $('[data-ulozit]', o.el);
  if (!ul) return;
  const uloz = async () => {
    const v = opravKlavesnici(eanVstup.value.trim()); if (v && !eany.includes(v)) eany.push(v);
    const cena = parseKc(f.cena.value); const nak = parseKc(f.nakupni_cena.value);
    if (!f.nazev.value.trim()) return toast('Vyplňte název', 'chyba');
    if (!Number.isFinite(cena) || cena == null) return toast('Neplatná prodejní cena', 'chyba');
    if (Number.isNaN(nak)) return toast('Neplatná nákupní cena', 'chyba');
    const data = { nazev: f.nazev.value.trim(), kod: f.kod.value.trim() || null, kategorie: f.kategorie.value.trim() || null, cena, sazba_dph: +f.sazba_dph.value,
      nakupni_cena: nak, jednotka: f.jednotka.value, min_stav: parseMn(f.min_stav.value) || 0, aktivni: f.aktivni.checked, poznamka: f.poznamka.value.trim() || null, eany };
    if (!id) data.pocatecni_stav = parseMn(f.pocatecni_stav.value) || 0;
    try {
      const r = await api(id ? 'PUT' : 'POST', id ? '/api/zbozi/' + id : '/api/zbozi', data);
      o.zavri(); toast('Uloženo', 'ok'); poUlozeni && poUlozeni(r);
    } catch (e) { chyba(e); }
  };
  ul.onclick = uloz;
  f.onsubmit = (e) => { e.preventDefault(); uloz(); };
}

/* ======================================================================== sklad */

function viewSklad(pod = 'stav') {
  $('#obsah').innerHTML = `<div class="zalozky"><a href="#sklad/stav" class="${pod === 'stav' ? 'aktivni' : ''}">Stav skladu</a>
    ${spravce() ? `<a href="#sklad/prijem" class="${pod === 'prijem' ? 'aktivni' : ''}">Příjem zboží</a>` : ''}
    <a href="#sklad/prijemky" class="${pod === 'prijemky' ? 'aktivni' : ''}">Příjemky</a></div><div id="sklad-obsah"></div>`;
  if (pod === 'prijem' && spravce()) return skladPrijem();
  if (pod === 'prijemky') return skladPrijemky();
  return skladStav();
}

function skladStav() {
  $('#sklad-obsah').innerHTML = `<div class="karta"><div class="hlav"><h2>Stav skladu</h2>
    <div class="radek"><input type="search" id="s-q" placeholder="Hledat…" style="width:280px">
    <select id="s-filtr" style="width:190px"><option value="">Vše</option><option value="dochazi">Dochází (≤ minimum)</option><option value="zaporne">Záporný stav</option></select></div></div>
    <div id="s-seznam"></div></div>`;
  let casovac;
  const nacti = async () => {
    try {
      const rows = await api('GET', `/api/zbozi?limit=1000&filtr=${$('#s-filtr').value}&q=${encodeURIComponent($('#s-q').value.trim())}`);
      const hodnota = rows.reduce((s, z) => s + Math.max(z.stav, 0) * (z.nakupni_cena || 0), 0);
      $('#s-seznam').innerHTML = rows.length ? `<table class="tab"><thead><tr><th>Zboží</th><th>EAN</th><th class="num">Skladem</th><th class="num">Minimum</th><th class="num">Nákup bez DPH</th><th class="num">Hodnota</th>${spravce() ? '<th></th>' : ''}</tr></thead><tbody>
        ${rows.map((z) => `<tr><td><strong>${esc(z.nazev)}</strong>${z.kategorie ? `<div class="mut2">${esc(z.kategorie)}</div>` : ''}</td><td class="mono">${esc(z.eany[0] || '')}</td>
          <td class="num" style="${z.stav <= z.min_stav ? 'color:var(--chyba);font-weight:700' : ''}">${mn(z.stav)} ${esc(z.jednotka)}</td><td class="num">${mn(z.min_stav)}</td>
          <td class="num">${kc(z.nakupni_cena)}</td><td class="num">${z.nakupni_cena ? kc(Math.round(Math.max(z.stav, 0) * z.nakupni_cena)) : '—'}</td>
          ${spravce() ? `<td style="text-align:right"><button class="btn mala" data-inv="${z.id}">Inventura</button></td>` : ''}</tr>`).join('')}</tbody></table>
        <div class="telo radek mezera"><span class="mut">${rows.length} položek</span><strong>Hodnota skladu v nákupních cenách: ${kc(Math.round(hodnota))}</strong></div>`
        : '<div class="prazdno">Nic nenalezeno</div>';
      $$('[data-inv]').forEach((b) => { b.onclick = () => inventura(rows.find((z) => z.id === +b.dataset.inv), nacti); });
    } catch (e) { chyba(e); }
  };
  $('#s-q').oninput = () => { clearTimeout(casovac); casovac = setTimeout(nacti, 200); };
  $('#s-filtr').onchange = nacti;
  nacti();
}

function inventura(z, poUlozeni) {
  const o = okno({
    titul: 'Inventura – ' + z.nazev,
    obsah: `<p class="mut" style="margin-top:0">V systému: <strong>${mn(z.stav)} ${esc(z.jednotka)}</strong></p>
      <label class="pole">Skutečný stav (spočítáno)<input type="text" inputmode="decimal" id="inv-q" value="${mn(z.stav)}" autofocus></label>
      <label class="pole" style="margin-top:10px">Poznámka<input type="text" id="inv-p" placeholder="např. inventura 12/2026, poškozeno…"></label>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Uložit stav</button>',
  });
  const ok = async () => {
    const q = parseMn($('#inv-q', o.el).value);
    if (!Number.isFinite(q)) return toast('Neplatné množství', 'chyba');
    try { const r = await api('POST', '/api/sklad/korekce', { zbozi_id: z.id, novy_stav: q, poznamka: $('#inv-p', o.el).value.trim() || null }); o.zavri(); toast(r.rozdil ? `Stav upraven o ${r.rozdil > 0 ? '+' : ''}${mn(r.rozdil)}` : 'Stav sedí', 'ok'); poUlozeni(); } catch (e) { chyba(e); }
  };
  $('#inv-q', o.el).onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  $('[data-ok]', o.el).onclick = ok;
  $('[data-zpet]', o.el).onclick = () => o.zavri();
}

function skladPrijem() {
  const P = S.prijem;
  $('#sklad-obsah').innerHTML = `<div class="karta"><div class="hlav"><div><h2>Příjem zboží</h2><span class="mut2">Rozpracovaný příjem se průběžně ukládá v tomto prohlížeči.</span></div>
    <div class="radek">${P.soubor_id ? `<a class="btn mala" href="/api/faktury/${P.soubor_id}/soubor" target="_blank">Otevřít fakturu</a>` : ''}
      <label class="btn hl" id="p-faktura-btn">Nahrát fakturu (PDF / ISDOC)<input type="file" id="p-faktura" accept=".pdf,.isdoc,.isdocx,.xml" class="skryt"></label></div></div><div class="telo">
    <div class="mrizka"><label class="pole">Dodavatel<input type="text" id="p-dod" value="${esc(P.dodavatel)}"></label>
      <label class="pole">Číslo faktury / dodacího listu<input type="text" id="p-dok" value="${esc(P.doklad)}"></label>
      <label class="pole siroke">Poznámka<input type="text" id="p-pozn" value="${esc(P.poznamka)}"></label></div>
    <div class="sken-box" style="margin-top:14px"><input id="p-sken" class="sken" type="text" autocomplete="off" placeholder="Načtěte čárový kód přijímaného zboží…  (5* = 5 kusů)"></div></div>
    <table class="tab"><thead><tr><th>Zboží</th><th class="num" style="width:130px">Množství</th><th class="num" style="width:170px">Nákup/ks bez DPH</th><th class="num" style="width:140px">Celkem</th><th style="width:44px"></th></tr></thead><tbody id="p-telo"></tbody></table>
    <div id="p-prazdno" class="prazdno">Zatím nic. Načtěte zboží čtečkou.</div>
    <div class="telo radek mezera"><button class="btn nebezp" id="p-zahodit">Zahodit příjem</button><div class="radek"><strong id="p-celkem"></strong><button class="btn hl" id="p-ulozit">Naskladnit</button></div></div></div>`;
  const uloz = () => ulozLokalne('prijem', S.prijem);
  ['dod', 'dok', 'pozn'].forEach((k, i) => { $('#p-' + k).oninput = (e) => { P[['dodavatel', 'doklad', 'poznamka'][i]] = e.target.value; uloz(); }; });
  const vykresli = () => {
    $('#p-telo').innerHTML = P.polozky.map((r, i) => `<tr data-i="${i}"><td><strong>${esc(r.nazev)}</strong><div class="mut2">${esc(r.ean || '')} · skladem ${mn(r.stav)}</div></td>
      <td class="num"><input type="text" inputmode="decimal" data-a="q" value="${mn(r.mnozstvi)}" style="text-align:right"></td>
      <td class="num"><input type="text" inputmode="decimal" data-a="c" value="${r.nakupni_cena == null ? '' : cislo2(r.nakupni_cena)}" style="text-align:right"></td>
      <td class="num">${r.nakupni_cena == null ? '—' : kc(Math.round(r.nakupni_cena * r.mnozstvi))}</td><td><button class="btn ikona nebezp" data-a="x">×</button></td></tr>`).join('');
    $('#p-prazdno').classList.toggle('skryt', P.polozky.length > 0);
    $('#p-celkem').textContent = `Celkem bez DPH: ${kc(P.polozky.reduce((s, r) => s + Math.round((r.nakupni_cena || 0) * r.mnozstvi), 0))}`;
    $$('#p-telo tr').forEach((tr) => {
      const r = P.polozky[+tr.dataset.i];
      $('[data-a=q]', tr).onchange = (e) => { const q = parseMn(e.target.value); if (Number.isFinite(q) && q > 0) r.mnozstvi = q; uloz(); vykresli(); };
      $('[data-a=c]', tr).onchange = (e) => { const c = parseKc(e.target.value); r.nakupni_cena = Number.isFinite(c) ? c : null; uloz(); vykresli(); };
      $('[data-a=x]', tr).onclick = () => { P.polozky.splice(+tr.dataset.i, 1); uloz(); vykresli(); };
    });
  };
  const pridej = (z, q) => {
    const ex = P.polozky.find((r) => r.zbozi_id === z.id);
    if (ex) ex.mnozstvi = Math.round((ex.mnozstvi + q) * 1000) / 1000;
    else P.polozky.push({ zbozi_id: z.id, nazev: z.nazev, ean: z.eany[0] || null, stav: z.stav, mnozstvi: q, nakupni_cena: z.nakupni_cena });
    uloz(); vykresli();
  };
  const sken = $('#p-sken');
  sken.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = sken.value.trim(); sken.value = '';
    if (!v) return;
    const { mnozstvi: q, text: kod } = rozeberSken(v);
    try { pridej(await api('GET', '/api/zbozi/kod/' + encodeURIComponent(kod)), q); }
    catch {
      const nalez = await api('GET', '/api/zbozi?limit=2&q=' + encodeURIComponent(kod)).catch(() => []);
      if (nalez.length === 1) return pridej(nalez[0], q);
      if (await potvrd('Neznámý kód', `Kód <strong class="mono">${esc(kod)}</strong> v katalogu není. Založit nové zboží?`, 'Založit')) {
        formularZbozi(null, { ean: kod }, (z) => pridej(z, q));
      }
    }
    sken.focus();
  };
  $('#p-zahodit').onclick = async () => {
    if (!P.polozky.length || await potvrd('Zahodit příjem', 'Smazat rozpracovaný příjem?', 'Zahodit', true)) {
      S.prijem = prazdnyPrijem(); ulozLokalne('prijem', S.prijem); skladPrijem();
    }
  };
  $('#p-ulozit').onclick = async () => {
    if (!P.polozky.length) return toast('Příjem je prázdný');
    try {
      const r = await api('POST', '/api/prijemky', {
        dodavatel: P.dodavatel || null, dodavatel_ico: P.dodavatel_ico || null, doklad: P.doklad || null,
        poznamka: P.poznamka || null, soubor_id: P.soubor_id || null,
        polozky: P.polozky.map((x) => ({ zbozi_id: x.zbozi_id, mnozstvi: x.mnozstvi, nakupni_cena: x.nakupni_cena,
          kod_dodavatele: x.kod_dodavatele || null, ean_z_faktury: x.ean_z_faktury || null, koeficient: x.koeficient || 1 })) });
      toast(`Naskladněno – příjemka ${r.cislo}`, 'ok');
      S.prijem = prazdnyPrijem(); ulozLokalne('prijem', S.prijem); skladPrijem();
    } catch (e) { chyba(e); }
  };
  $('#p-faktura').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) nahratFakturu(f); };
  vykresli();
  sken.focus();
}

async function skladPrijemky() {
  $('#sklad-obsah').innerHTML = '<div class="karta"><div class="hlav"><h2>Příjemky</h2></div><div id="pr-seznam"></div></div>';
  try {
    const rows = await api('GET', '/api/prijemky');
    $('#pr-seznam').innerHTML = rows.length ? `<table class="tab"><thead><tr><th>Datum</th><th>Číslo</th><th>Dodavatel</th><th>Doklad</th><th class="num">Položek</th><th class="num">Celkem bez DPH</th><th>Přijal</th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td>${datumCas(p.cas)}</td><td class="mono">${esc(p.cislo)}</td><td>${esc(p.dodavatel || '')}</td>
        <td class="mono">${p.soubor_id ? `<a href="/api/faktury/${p.soubor_id}/soubor" target="_blank">${esc(p.doklad || 'faktura')}</a>` : esc(p.doklad || '')}</td>
        <td class="num">${p.pocet}</td><td class="num">${kc(p.celkem_bez_dph)}</td><td>${esc(p.uzivatel || '')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="prazdno">Zatím žádné příjemky</div>';
  } catch (e) { chyba(e); }
}

/* ======================================================================== faktury */

const prazdnyPrijem = () => ({ dodavatel: '', dodavatel_ico: '', doklad: '', poznamka: '', soubor_id: null, polozky: [] });
const ZDROJE = {
  isdoc: ['ok', 'ISDOC – přesná data'], 'pdf-isdoc': ['ok', 'PDF s vloženým ISDOC – přesná data'],
  ai: ['info', 'PDF přečetl Claude – zkontrolujte'], text: ['ceka', 'Odhad z textu PDF – zkontrolujte'],
};

function nahratFakturu(soubor) {
  const ctecka = new FileReader();
  ctecka.onload = async () => {
    const data = String(ctecka.result).split(',')[1] || '';
    const btn = $('#p-faktura-btn');
    if (btn) { btn.classList.add('skryt'); btn.insertAdjacentHTML('afterend', '<span class="mut" id="p-nacitam">Načítám fakturu…</span>'); }
    try { kontrolaFaktury(await api('POST', '/api/faktury/nacti', { nazev: soubor.name, data })); }
    catch (e) { chyba(e); }
    finally { $('#p-nacitam')?.remove(); btn?.classList.remove('skryt'); }
  };
  ctecka.onerror = () => toast('Soubor nejde přečíst', 'chyba');
  ctecka.readAsDataURL(soubor);
}

// U fakturovaného balení zkusí z názvu vyčíst počet kusů: „Sklo (bal. 10 ks)“ → 10.
function kusyVBaleni(p) {
  if (!/bal|pack|sad|krab/i.test(p.jednotka || '') && !/bal\.|balení/i.test(p.nazev)) return 1;
  const m = p.nazev.match(/(\d{1,4})\s*(?:ks|kus)/i);
  return m ? +m[1] : 1;
}

function navrhCeny(r, marze) {
  if (r.cena_bez_dph == null) return null;
  const sazba = r.nove.sazba;
  const nakupKs = r.cena_bez_dph / (r.koeficient || 1);
  return Math.ceil(nakupKs * (1 + marze / 100) * (1 + sazba / 100) / 100) * 100;
}

function kontrolaFaktury(v) {
  const f = v.faktura;
  const radky = f.polozky.map((p, i) => {
    const r = { ...p, i, zbozi_id: p.navrh ? p.navrh.zbozi_id : null, zbozi: p.zbozi, zpusob: p.navrh ? p.navrh.zpusob : null,
      koeficient: p.navrh && p.navrh.koeficient !== 1 ? p.navrh.koeficient : kusyVBaleni(p), nove: { nazev: p.nazev, sazba: p.sazba_dph ?? 21, cena: null } };
    r.nove.cena = navrhCeny(r, v.marze_pct);
    return r;
  });
  const [tz, tt] = ZDROJE[f.zdroj] || ['sedy', f.zdroj];
  const o = okno({
    titul: 'Kontrola faktury', siroke: true,
    obsah: `<div class="radek mezera" style="margin-bottom:10px">
        <div><strong style="font-size:16px">${esc(f.dodavatel || 'Neznámý dodavatel')}</strong>${f.dodavatel_ico ? ` <span class="mut">IČO ${esc(f.dodavatel_ico)}</span>` : ''}
        <div class="mut">Doklad ${esc(f.cislo || '—')}${f.datum ? ' · ' + esc(f.datum) : ''}${f.celkem_bez_dph ? ' · celkem bez DPH ' + kc(f.celkem_bez_dph) : ''}</div></div>
        <span class="stitek ${tz}">${esc(tt)}</span></div>
      ${v.duplicita ? `<div class="upozorneni chyba">Tahle faktura už byla naskladněna: příjemka ${esc(v.duplicita.cislo)} z ${datumCas(v.duplicita.cas)}.</div>` : ''}
      ${f.dobropis ? '<div class="upozorneni chyba">Jde o dobropis. Vrácené zboží odečtěte ze skladu inventurou, příjem se tu nedělá.</div>' : ''}
      ${f.varovani.map((x) => `<div class="upozorneni">${esc(x)}</div>`).join('')}
      <div style="overflow:auto"><table class="tab" id="kf"><thead><tr><th>Na faktuře</th><th class="num">Množství</th><th class="num">Cena/MJ bez DPH</th><th style="width:150px">Co udělat</th><th>Zboží v pokladně</th><th style="width:150px">Kusů v MJ</th></tr></thead><tbody></tbody></table></div>`,
    pata: '<span class="mut" id="kf-souhrn"></span><span class="vypln"></span><button class="btn" data-zpet>Zrušit</button><button class="btn hl" data-ok>Převzít do příjmu</button>',
  });
  o.el.querySelector('.okno').style.maxWidth = '1240px';

  const ZPUSOBY = { EAN: 'ok', 'naučené': 'ok', 'kód': 'ok', 'název': 'ceka', 'ručně': 'info', 'nové': 'info' };
  const bunkaZbozi = (r) => {
    if (r.akce === 'PRESKOCIT') return '<span class="mut2">nenaskladní se</span>';
    if (r.akce === 'NOVE') {
      return `<div class="radek" style="flex-wrap:nowrap"><input type="text" data-a="nn" value="${esc(r.nove.nazev)}" style="min-width:220px">
        <input type="text" inputmode="decimal" data-a="nc" value="${r.nove.cena == null ? '' : cislo2(r.nove.cena)}" style="width:100px" title="Prodejní cena s DPH">
        <select data-a="nd" style="width:72px">${[21, 12, 0].map((s) => `<option ${s === r.nove.sazba ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="mut2">prodejní cena s DPH (návrh: marže ${v.marze_pct} %)${r.ean ? ' · EAN ' + esc(r.ean) : ''}</div>`;
    }
    const volby = [];
    if (r.zbozi_id && !r.kandidati.some((k) => k.zbozi_id === r.zbozi_id)) volby.push({ zbozi_id: r.zbozi_id, nazev: r.zbozi ? r.zbozi.nazev : '#' + r.zbozi_id });
    volby.push(...r.kandidati);
    const z = r.zbozi;
    let info = '';
    if (z && z.id === r.zbozi_id && r.cena_bez_dph != null) {
      const nakup = r.cena_bez_dph / (r.koeficient || 1); const bez = z.cena / (1 + z.sazba_dph / 100);
      const m = nakup ? Math.round((bez - nakup) / nakup * 100) : null;
      info = `<div class="mut2">skladem ${mn(z.stav)} · prodej ${kc(z.cena)}${m != null ? ` · marže <strong style="color:${m < 10 ? 'var(--chyba)' : 'inherit'}">${m} %</strong>` : ''}</div>`;
    }
    return `<div class="radek" style="flex-wrap:nowrap">${r.zpusob ? `<span class="stitek ${ZPUSOBY[r.zpusob] || 'sedy'}">${esc(r.zpusob)}</span>` : ''}
      <select data-a="z" style="min-width:240px">${volby.length ? '' : '<option value="">— vyberte —</option>'}${volby.map((k) => `<option value="${k.zbozi_id}" ${k.zbozi_id === r.zbozi_id ? 'selected' : ''}>${esc(k.nazev)}${k.jistota && k.jistota < 1 ? ` (${Math.round(k.jistota * 100)} %)` : ''}</option>`).join('')}</select>
      <button class="btn mala" data-a="hledat">Jiné…</button></div>${info}`;
  };
  const vykresli = () => {
    $('#kf tbody', o.el).innerHTML = radky.map((r) => `<tr data-i="${r.i}" style="${r.akce === 'PRESKOCIT' ? 'opacity:.55' : ''}">
      <td><strong>${esc(r.nazev)}</strong><div class="mut2">${[r.kod_dodavatele && 'kód ' + esc(r.kod_dodavatele), r.ean && 'EAN ' + esc(r.ean), r.sazba_dph != null && r.sazba_dph + ' %'].filter(Boolean).join(' · ')}</div></td>
      <td class="num">${mn(r.mnozstvi)} ${esc(r.jednotka || '')}</td><td class="num">${kc(r.cena_bez_dph)}</td>
      <td><select data-a="akce"><option value="PRIJMOUT" ${r.akce === 'PRIJMOUT' ? 'selected' : ''}>Naskladnit</option><option value="NOVE" ${r.akce === 'NOVE' ? 'selected' : ''}>Založit nové</option><option value="PRESKOCIT" ${r.akce === 'PRESKOCIT' ? 'selected' : ''}>Přeskočit</option></select></td>
      <td>${bunkaZbozi(r)}</td>
      <td>${r.akce === 'PRESKOCIT' ? '' : `<div class="radek" style="flex-wrap:nowrap">× <input type="text" inputmode="decimal" data-a="k" value="${mn(r.koeficient)}" style="width:64px"> <span class="mut2">= ${mn(r.mnozstvi * r.koeficient)}</span></div>`}</td></tr>`).join('');
    const n = (a) => radky.filter((r) => r.akce === a).length;
    $('#kf-souhrn', o.el).textContent = `Naskladní se ${n('PRIJMOUT') + n('NOVE')} položek, z toho ${n('NOVE')} nových, přeskočí se ${n('PRESKOCIT')}.`;
    $$('#kf tbody tr', o.el).forEach((tr) => {
      const r = radky[+tr.dataset.i];
      $('[data-a=akce]', tr).onchange = (e) => { r.akce = e.target.value; vykresli(); };
      const z = $('[data-a=z]', tr);
      if (z) z.onchange = () => { r.zbozi_id = +z.value || null; r.zpusob = 'ručně'; r.zbozi = null; vykresli(); };
      const h = $('[data-a=hledat]', tr);
      if (h) h.onclick = () => vyberZbozi(r.nazev, (zb) => { r.zbozi_id = zb.id; r.zbozi = zb; r.zpusob = 'ručně'; if (!r.kandidati.some((k) => k.zbozi_id === zb.id)) r.kandidati.unshift({ zbozi_id: zb.id, nazev: zb.nazev }); vykresli(); });
      const k = $('[data-a=k]', tr);
      if (k) k.onchange = () => { const q = parseMn(k.value); if (Number.isFinite(q) && q > 0) { r.koeficient = q; r.nove.cena = navrhCeny(r, v.marze_pct); } vykresli(); };
      const nn = $('[data-a=nn]', tr); if (nn) nn.oninput = () => { r.nove.nazev = nn.value; };
      const nc = $('[data-a=nc]', tr); if (nc) nc.onchange = () => { r.nove.cena = parseKc(nc.value); };
      const nd = $('[data-a=nd]', tr); if (nd) nd.onchange = () => { r.nove.sazba = +nd.value; r.nove.cena = navrhCeny(r, v.marze_pct); vykresli(); };
    });
  };
  vykresli();
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = async (e) => {
    const chybne = radky.find((r) => (r.akce === 'PRIJMOUT' && !r.zbozi_id) || (r.akce === 'NOVE' && (!r.nove.nazev.trim() || !Number.isFinite(r.nove.cena) || r.nove.cena == null)));
    if (chybne) return toast(`Doplňte řádek „${chybne.nazev}“ – vyberte zboží nebo vyplňte název a cenu`, 'chyba');
    e.target.disabled = true;
    try {
      for (const r of radky.filter((x) => x.akce === 'NOVE')) {
        const z = await api('POST', '/api/zbozi', { nazev: r.nove.nazev.trim(), cena: r.nove.cena, sazba_dph: r.nove.sazba,
          nakupni_cena: r.cena_bez_dph == null ? null : Math.round(r.cena_bez_dph / r.koeficient), eany: r.ean ? [r.ean] : [], pocatecni_stav: 0 });
        Object.assign(r, { akce: 'PRIJMOUT', zbozi_id: z.id, zbozi: z, zpusob: 'nové' });   // při chybě dalšího řádku se znovu nezaloží
      }
      const P = S.prijem.polozky.length ? S.prijem : prazdnyPrijem();
      Object.assign(P, { dodavatel: f.dodavatel || P.dodavatel, dodavatel_ico: f.dodavatel_ico || P.dodavatel_ico, doklad: f.cislo || P.doklad,
        soubor_id: v.soubor_id, poznamka: P.poznamka || (f.datum ? `faktura ze dne ${f.datum}` : '') });
      const detaily = await Promise.all(radky.filter((r) => r.akce === 'PRIJMOUT').map(async (r) => ({ r, z: r.zbozi && r.zbozi.eany ? r.zbozi : await api('GET', '/api/zbozi/' + r.zbozi_id) })));
      for (const { r, z } of detaily) {
        P.polozky.push({ zbozi_id: z.id, nazev: z.nazev, ean: (z.eany && z.eany[0]) || r.ean || null, stav: z.stav,
          mnozstvi: Math.round(r.mnozstvi * r.koeficient * 1000) / 1000,
          nakupni_cena: r.cena_bez_dph == null ? z.nakupni_cena : Math.round(r.cena_bez_dph / r.koeficient),
          kod_dodavatele: r.kod_dodavatele, ean_z_faktury: r.ean, koeficient: r.koeficient });
      }
      S.prijem = P; ulozLokalne('prijem', P);
      o.zavri(); skladPrijem();
      toast('Položky z faktury jsou v příjmu. Zkontrolujte je a klikněte na Naskladnit.', 'ok');
    } catch (er) { chyba(er); e.target.disabled = false; vykresli(); }
  };
}

function vyberZbozi(text, poVyberu) {
  const o = okno({
    titul: 'Vybrat zboží',
    obsah: `<input type="search" id="vz-q" value="${esc(text)}" autofocus><div id="vz-v" style="margin-top:10px;max-height:360px;overflow:auto"></div>`,
    pata: '<button class="btn" data-zpet>Zpět</button>',
  });
  let casovac;
  const hledej = async () => {
    const rows = await api('GET', '/api/zbozi?limit=30&q=' + encodeURIComponent($('#vz-q', o.el).value.trim())).catch(() => []);
    $('#vz-v', o.el).innerHTML = rows.map((z, i) => `<div class="pol" data-i="${i}" style="padding:9px 10px;border-bottom:1px solid var(--linka);cursor:pointer">
      <strong>${esc(z.nazev)}</strong><div class="mut2">${esc(z.eany[0] || z.kod || '')} · skladem ${mn(z.stav)} · ${kc(z.cena)}</div></div>`).join('') || '<div class="prazdno">Nic nenalezeno</div>';
    $$('#vz-v .pol', o.el).forEach((d) => { d.onclick = () => { o.zavri(); poVyberu(rows[+d.dataset.i]); }; });
  };
  $('#vz-q', o.el).oninput = () => { clearTimeout(casovac); casovac = setTimeout(hledej, 200); };
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  // Hledání podle celého názvu z faktury bývá moc přísné – začne se prvními dvěma slovy.
  $('#vz-q', o.el).value = text.split(/\s+/).slice(0, 2).join(' ');
  hledej();
}

/* ======================================================================== uzávěrka */

async function viewUzaverka() {
  $('#obsah').innerHTML = `<div class="radek mezera" style="margin-bottom:14px"><h1 class="titul" style="margin:0">Uzávěrka</h1>
    <div class="radek"><input type="date" id="uz-datum" value="${dnes()}" style="width:170px"><button class="btn" id="uz-tisk">Tisk uzávěrky</button>
      <button class="btn" id="uz-xlsx">Excel</button><button class="btn hl" id="uz-mail">Odeslat e-mailem</button></div></div>
    <div id="uz-odeslano" class="mut2" style="margin:-6px 0 12px"></div><div id="uz-obsah"></div>`;
  let data;
  const nacti = async () => {
    try { data = await api('GET', '/api/uzaverka?datum=' + $('#uz-datum').value); } catch (e) { return chyba(e); }
    const h = data.platby.HOTOVE || { pocet: 0, celkem: 0 }; const k = data.platby.KARTA || { pocet: 0, celkem: 0 };
    const pr = data.typy.PRODEJ || { pocet: 0, celkem: 0 }; const st = data.typy.STORNO || { pocet: 0, celkem: 0 };
    const platce = S.firma.platce_dph === '1';
    const od = data.odeslano;
    $('#uz-odeslano').textContent = od && od.datum === data.datum ? `Odesláno e-mailem ${datumCas(od.odeslano)} na ${od.komu.join(', ')}` : '';
    $('#uz-obsah').innerHTML = `<div class="dlazdice">
        <div class="karta"><div class="pop">Tržba celkem</div><div class="hod">${kc(data.celkem)}</div></div>
        <div class="karta"><div class="pop">Hotově (do kasy)</div><div class="hod">${kc(h.celkem || 0)}</div></div>
        <div class="karta"><div class="pop">Kartou</div><div class="hod">${kc(k.celkem || 0)}</div></div>
        <div class="karta"><div class="pop">Účtenek</div><div class="hod">${pr.pocet}</div></div>
        <div class="karta"><div class="pop">Storna</div><div class="hod">${st.pocet} · ${kc(st.celkem || 0)}</div></div>
        <div class="karta"><div class="pop">Zaokrouhlení</div><div class="hod">${kc(data.zaokrouhleni)}</div></div></div>
      <div class="mrizka" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        ${platce ? `<div class="karta"><div class="hlav"><h2>DPH</h2></div><table class="tab"><thead><tr><th>Sazba</th><th class="num">Základ</th><th class="num">DPH</th><th class="num">Celkem</th></tr></thead><tbody>
          ${data.dph.map((d) => `<tr><td>${d.sazba_dph} %</td><td class="num">${kc(d.zaklad)}</td><td class="num">${kc(d.dph)}</td><td class="num">${kc(d.celkem)}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">—</td></tr>'}</tbody></table></div>` : ''}
        <div class="karta"><div class="hlav"><h2>Prodavači</h2></div><table class="tab"><thead><tr><th>Jméno</th><th class="num">Dokladů</th><th class="num">Celkem</th></tr></thead><tbody>
          ${data.prodavaci.map((p) => `<tr><td>${esc(p.jmeno || '')}</td><td class="num">${p.pocet}</td><td class="num">${kc(p.celkem)}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">—</td></tr>'}</tbody></table></div>
        <div class="karta"><div class="hlav"><h2>EET</h2></div><div class="telo" style="line-height:2">
          ${Object.keys(data.eet).length ? Object.entries(data.eet).map(([s, n]) => `${eetText({ eet_stav: s })} ${n}×`).join('<br>') : '<span class="mut">Žádné tržby</span>'}</div></div></div>`;
  };
  $('#uz-datum').onchange = nacti;
  $('#uz-xlsx').onclick = () => {
    if (window.POKLADNA_DEMO) return toast('V demu se Excel nestahuje – ve skutečné pokladně přijde měsíční přehled jako příloha uzávěrky.');
    location.href = '/api/uzaverka/xlsx?datum=' + $('#uz-datum').value;
  };
  $('#uz-mail').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/uzaverka/odeslat', { datum: $('#uz-datum').value });
      toast(`Uzávěrka odeslána na ${r.komu.join(', ')}`, 'ok'); nacti();
    } catch (er) { chyba(er); } finally { e.target.disabled = false; }
  };
  $('#uz-tisk').onclick = () => {
    if (!data) return;
    const h = data.platby.HOTOVE || { celkem: 0 }; const k = data.platby.KARTA || { celkem: 0 };
    tisk(`${hlavickaTisku()}<div class="cara"></div><div class="stred velke">UZÁVĚRKA ${new Date(data.datum).toLocaleDateString('cs-CZ')}</div><div class="cara"></div>
      <table><tr><td>Hotově</td><td class="r">${kc(h.celkem || 0)}</td></tr><tr><td>Kartou</td><td class="r">${kc(k.celkem || 0)}</td></tr>
      <tr><td>Zaokrouhlení</td><td class="r">${kc(data.zaokrouhleni)}</td></tr><tr class="velke"><td>CELKEM</td><td class="r">${kc(data.celkem)}</td></tr>
      <tr><td>Účtenek / storen</td><td class="r">${(data.typy.PRODEJ || { pocet: 0 }).pocet} / ${(data.typy.STORNO || { pocet: 0 }).pocet}</td></tr></table>
      ${S.firma.platce_dph === '1' ? `<div class="cara"></div><table>${data.dph.map((d) => `<tr><td>DPH ${d.sazba_dph} %</td><td class="r">${cislo2(d.zaklad)}</td><td class="r">${cislo2(d.dph)}</td></tr>`).join('')}</table>` : ''}
      <div class="cara"></div><table>${data.prodavaci.map((p) => `<tr><td>${esc(p.jmeno || '')}</td><td class="r">${kc(p.celkem)}</td></tr>`).join('')}</table>
      <div class="cara"></div><div>EET: ${Object.entries(data.eet).map(([s, n]) => `${s} ${n}`).join(', ') || '—'}</div>
      <div style="margin-top:3mm">Vytištěno ${datumCas(new Date().toISOString())} · ${esc(S.uzivatel.jmeno)}</div>`);
  };
  nacti();
}

/* ======================================================================== faktury vydané (po vzoru iDokladu) */

const FORMY_FV = { PREVOD: 'Převodem', HOTOVE: 'Hotově', KARTA: 'Kartou', DOBIRKA: 'Dobírkou' };
const stavFv = (f) => (f.stav === 'STORNO' ? ['sedy', 'Stornováno'] : f.stav === 'UHRAZENO' ? ['ok', 'Uhrazeno'] : f.po_splatnosti ? ['chyba', 'Po splatnosti'] : ['ceka', 'Neuhrazeno']);
const datumCz = (iso) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('cs-CZ') : '');
const plusDni = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const adresaOdb = (o) => [o.ulice, [o.psc, o.mesto].filter(Boolean).join(' ')].filter(Boolean).join(', ');

function viewFaktury(pod) {
  $('#obsah').innerHTML = `<div class="zalozky"><a href="#faktury" class="${pod !== 'kontakty' ? 'aktivni' : ''}">Faktury vydané</a>
    <a href="#faktury/kontakty" class="${pod === 'kontakty' ? 'aktivni' : ''}">Kontakty</a></div><div id="fv-obsah"></div>`;
  return pod === 'kontakty' ? fvKontakty() : fvSeznam();
}

let fvFiltr = 'vse';
async function fvSeznam() {
  $('#fv-obsah').innerHTML = `<div class="dlazdice" id="fv-dl"></div>
    <div class="karta"><div class="hlav"><div class="filtry">${[['vse', 'Vše'], ['neuhrazene', 'Neuhrazené'], ['po_splatnosti', 'Po splatnosti'], ['uhrazene', 'Uhrazené']]
    .map(([k, t]) => `<button class="filtr ${fvFiltr === k ? 'aktivni' : ''}" data-f="${k}">${t}</button>`).join('')}</div>
      <div class="radek"><input type="search" id="fv-q" placeholder="Číslo, odběratel, IČO…" style="width:240px"><button class="btn ok" id="fv-nova">+ Nová faktura</button></div></div>
    <div id="fv-seznam"></div></div>`;
  let casovac;
  const nacti = async () => {
    let d;
    try { d = await api('GET', `/api/faktury-vydane?filtr=${fvFiltr}&q=${encodeURIComponent($('#fv-q').value.trim())}`); } catch (e) { return chyba(e); }
    const s = d.souhrn;
    $('#fv-dl').innerHTML = `<div class="karta"><div class="pop">Neuhrazeno</div><div class="hod">${kc(s.neuhrazeno)}</div></div>
      <div class="karta" style="${s.po_splatnosti ? 'border-color:#efc4c4' : ''}"><div class="pop">Po splatnosti${s.pocet_po_splatnosti ? ` (${s.pocet_po_splatnosti})` : ''}</div><div class="hod" style="${s.po_splatnosti ? 'color:var(--chyba)' : ''}">${kc(s.po_splatnosti)}</div></div>
      <div class="karta"><div class="pop">Vystaveno tento měsíc</div><div class="hod">${kc(s.mesic)}</div></div>`;
    $('#fv-seznam').innerHTML = d.faktury.length ? `<table class="tab"><thead><tr><th>Číslo</th><th>Odběratel</th><th>Vystaveno</th><th>Splatnost</th><th>Úhrada</th><th class="num">Částka</th><th>Stav</th></tr></thead><tbody>
      ${d.faktury.map((f) => { const [t, n] = stavFv(f); return `<tr class="klik" data-id="${f.id}" style="${f.stav === 'STORNO' ? 'opacity:.55' : ''}"><td class="mono"><strong>${esc(f.cislo)}</strong></td>
        <td>${esc(f.odb_nazev)}${f.odb_ico ? `<div class="mut2">IČO ${esc(f.odb_ico)}</div>` : ''}</td><td>${datumCz(f.datum_vystaveni)}</td><td style="${f.po_splatnosti ? 'color:var(--chyba);font-weight:700' : ''}">${datumCz(f.splatnost)}</td>
        <td>${FORMY_FV[f.forma_uhrady]}</td><td class="num"><strong>${kc(f.celkem)}</strong></td><td><span class="stitek ${t}">${n}</span>${f.odeslano ? ' <span class="mut2" title="Odesláno e-mailem">✉</span>' : ''}</td></tr>`; }).join('')}</tbody></table>`
      : `<div class="prazdno">${fvFiltr === 'vse' ? 'Zatím žádné faktury. Vystavte první tlačítkem „+ Nová faktura“, nebo z prodejky.' : 'Nic nenalezeno'}</div>`;
    $$('#fv-seznam tr[data-id]').forEach((tr) => { tr.onclick = () => detailFaktury(+tr.dataset.id, nacti); });
  };
  $$('#fv-obsah [data-f]').forEach((b) => { b.onclick = () => { fvFiltr = b.dataset.f; fvSeznam(); }; });
  $('#fv-q').oninput = () => { clearTimeout(casovac); casovac = setTimeout(nacti, 200); };
  $('#fv-nova').onclick = () => formularFaktury({});
  nacti();
}

async function fvKontakty() {
  $('#fv-obsah').innerHTML = `<div class="karta"><div class="hlav"><h2>Kontakty</h2><div class="radek"><input type="search" id="ko-q" placeholder="Název, IČO, město…" style="width:240px">
    <button class="btn ok" id="ko-novy">+ Nový kontakt</button></div></div><div id="ko-seznam"></div></div>`;
  let casovac;
  const nacti = async () => {
    let rows; try { rows = await api('GET', '/api/odberatele?q=' + encodeURIComponent($('#ko-q').value.trim())); } catch (e) { return chyba(e); }
    $('#ko-seznam').innerHTML = rows.length ? `<table class="tab"><thead><tr><th>Název</th><th>IČO</th><th>Město</th><th>E-mail</th><th class="num">Faktur</th><th class="num">Dluží</th></tr></thead><tbody>
      ${rows.map((o) => `<tr class="klik" data-id="${o.id}"><td><strong>${esc(o.nazev)}</strong></td><td class="mono">${esc(o.ico || '')}</td><td>${esc(o.mesto || '')}</td><td>${esc(o.email || '')}</td>
        <td class="num">${o.faktur}</td><td class="num" style="${o.dluzi ? 'color:var(--chyba);font-weight:700' : ''}">${o.dluzi ? kc(o.dluzi) : '—'}</td></tr>`).join('')}</tbody></table>`
      : '<div class="prazdno">Zatím žádné kontakty. Ukládají se samy při vystavení faktury.</div>';
    $$('#ko-seznam tr[data-id]').forEach((tr) => { tr.onclick = () => formularKontaktu(rows.find((o) => o.id === +tr.dataset.id), nacti); });
  };
  $('#ko-q').oninput = () => { clearTimeout(casovac); casovac = setTimeout(nacti, 200); };
  $('#ko-novy').onclick = () => formularKontaktu(null, nacti);
  nacti();
}

const POLE_ODB = [['nazev', 'Název / jméno', 'siroke'], ['ico', 'IČO', ''], ['dic', 'DIČ', ''], ['ulice', 'Ulice a číslo', 'siroke'], ['psc', 'PSČ', ''], ['mesto', 'Město', ''], ['email', 'E-mail', 'siroke']];
const polaOdberatele = (o, pref) => `<div class="mrizka mrizka2">${POLE_ODB.map(([k, t, c]) => `<label class="pole ${c}">${t}${k === 'ico'
  ? `<div class="radek" style="flex-wrap:nowrap"><input type="text" id="${pref}-${k}" value="${esc(o[k] || '')}" inputmode="numeric"><button type="button" class="btn mala" id="${pref}-ares" title="Doplnit údaje z obchodního rejstříku">ARES</button></div>`
  : `<input type="${k === 'email' ? 'email' : 'text'}" id="${pref}-${k}" value="${esc(o[k] || '')}">`}</label>`).join('')}</div>`;
const ctiOdberatele = (root, pref) => Object.fromEntries(POLE_ODB.map(([k]) => [k, $(`#${pref}-${k}`, root).value.trim() || null]));
function napojAres(root, pref) {
  $(`#${pref}-ares`, root).onclick = async () => {
    const ico = $(`#${pref}-ico`, root).value.replace(/\D/g, '');
    if (ico.length < 6) return toast('Zadejte IČO', 'chyba');
    try {
      const a = await api('GET', '/api/ares/' + ico);
      ['nazev', 'ico', 'dic', 'ulice', 'psc', 'mesto'].forEach((k) => { if (a[k]) $(`#${pref}-${k}`, root).value = a[k]; });
      toast('Údaje doplněny z ARES', 'ok');
    } catch (e) { chyba(e); }
  };
  $(`#${pref}-ico`, root).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $(`#${pref}-ares`, root).click(); } };
}

function formularKontaktu(o, poUlozeni) {
  const ok = okno({
    titul: o ? o.nazev : 'Nový kontakt',
    obsah: `${polaOdberatele(o || {}, 'ko')}<label class="pole" style="margin-top:12px">Poznámka<textarea id="ko-pozn">${esc((o && o.poznamka) || '')}</textarea></label>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Uložit</button>',
  });
  napojAres(ok.el, 'ko');
  $('[data-zpet]', ok.el).onclick = () => ok.zavri();
  $('[data-ok]', ok.el).onclick = async () => {
    const d = { ...ctiOdberatele(ok.el, 'ko'), poznamka: $('#ko-pozn', ok.el).value.trim() || null, id: o ? o.id : null };
    if (!d.nazev) return toast('Vyplňte název', 'chyba');
    try { await api('POST', '/api/odberatele', d); ok.zavri(); toast('Uloženo', 'ok'); poUlozeni && poUlozeni(); } catch (e) { chyba(e); }
  };
}

function formularFaktury({ prodej, polozky, zKosiku, odberatel }) {
  const dnesni = dnes();
  const dni = +(S.firma.faktura_splatnost_dni || 14);
  const F = {
    odb: odberatel || {}, vystaveni: dnesni, duzp: prodej ? prodej.cas.slice(0, 10) : dnesni, splatnost: plusDni(dnesni, prodej ? 0 : dni),
    forma: prodej ? prodej.platba : 'PREVOD', poznamka: '',
    polozky: prodej ? prodej.polozky.map((p) => ({ ...p })) : (polozky || []).map((p) => ({ ...p })),
  };
  const zamceno = !!prodej;
  const o = okno({
    titul: prodej ? `Faktura k prodejce ${prodej.cislo}` : 'Nová faktura', siroke: true,
    obsah: `<div class="fv-sloupce">
        <div class="fv-blok"><h3>Odběratel</h3>
          <div class="sken-box" style="margin-bottom:10px"><input type="search" id="ff-hledat" placeholder="Vyhledat v kontaktech…" autocomplete="off"><div class="naseptavac skryt" id="ff-nasep"></div></div>
          ${polaOdberatele(F.odb, 'ff')}</div>
        <div class="fv-blok"><h3>Doklad</h3><div class="mrizka mrizka2">
          <label class="pole">Datum vystavení<input type="date" id="ff-vyst" value="${F.vystaveni}"></label>
          <label class="pole">Datum zdan. plnění<input type="date" id="ff-duzp" value="${F.duzp}" ${zamceno ? 'disabled' : ''}></label>
          <label class="pole">Splatnost<input type="date" id="ff-spl" value="${F.splatnost}"></label>
          <div class="pole"><span>&nbsp;</span><div class="radek">${[7, 14, 30].map((n) => `<button type="button" class="btn mala" data-dni="${n}">${n} dní</button>`).join('')}</div></div>
          <label class="pole siroke">Forma úhrady<select id="ff-forma" ${zamceno ? 'disabled' : ''}>${Object.entries(FORMY_FV).map(([k, t]) => `<option value="${k}" ${k === F.forma ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
          <div class="mut2" id="ff-info" style="margin-top:10px"></div></div>
      </div>
      <div class="fv-blok" style="margin-top:14px"><h3>Položky</h3>
        <table class="tab" id="ff-pol"><thead><tr><th>Název</th><th class="num" style="width:110px">Množství</th><th class="num" style="width:130px">Cena s DPH</th><th style="width:84px">DPH</th><th class="num" style="width:120px">Celkem</th><th style="width:40px"></th></tr></thead><tbody></tbody></table>
        ${zamceno ? '' : `<div class="radek" style="margin-top:10px"><div class="sken-box vypln"><input type="text" id="ff-zbozi" placeholder="Přidat zboží – čtečka nebo název…" autocomplete="off"><div class="naseptavac skryt" id="ff-znasep"></div></div>
          <button type="button" class="btn" id="ff-vlastni">+ Vlastní položka</button></div>`}</div>
      <div class="fv-pata"><label class="pole vypln">Poznámka na faktuře<textarea id="ff-pozn" placeholder="např. Děkujeme za objednávku"></textarea></label><div class="fv-soucty" id="ff-soucty"></div></div>`,
    pata: '<button class="btn" data-zpet>Zrušit</button><button class="btn ok" data-ok style="min-width:170px">Vystavit fakturu</button>',
  });
  o.el.querySelector('.okno').style.maxWidth = '1100px';
  napojAres(o.el, 'ff');

  const info = () => {
    const forma = $('#ff-forma', o.el).value;
    $('#ff-info', o.el).textContent = zamceno ? `Zaplaceno na pokladně (${FORMY_FV[forma].toLowerCase()}), EET už proběhlo. Faktura se vystaví jako uhrazená.`
      : forma === 'HOTOVE' || forma === 'KARTA' ? 'Placeno hned na pokladně: vznikne i prodejka s EET a faktura bude uhrazená.'
        : 'Zboží se vydá ze skladu, faktura čeká na úhradu. Bez EET (platba převodem se neeviduje).';
  };
  const vykresli = () => {
    $('#ff-pol tbody', o.el).innerHTML = F.polozky.map((p, i) => `<tr data-i="${i}"><td>${zamceno || p.zbozi_id ? esc(p.nazev) : `<input type="text" data-a="n" value="${esc(p.nazev)}">`}</td>
      <td class="num">${zamceno ? mn(p.mnozstvi) : `<input type="text" inputmode="decimal" data-a="q" value="${mn(p.mnozstvi)}" style="text-align:right">`}</td>
      <td class="num">${zamceno ? kc(p.cena) : `<input type="text" inputmode="decimal" data-a="c" value="${cislo2(p.cena)}" style="text-align:right">`}</td>
      <td>${zamceno || p.zbozi_id ? `${p.sazba_dph} %` : `<select data-a="d">${[21, 12, 0].map((s) => `<option ${s === p.sazba_dph ? 'selected' : ''}>${s}</option>`).join('')}</select>`}</td>
      <td class="num"><strong>${kc(Math.round(p.cena * p.mnozstvi))}</strong></td><td>${zamceno ? '' : '<button class="btn ikona nebezp" data-a="x">×</button>'}</td></tr>`).join('')
      || '<tr><td colspan="6" class="prazdno">Přidejte zboží nebo vlastní položku</td></tr>';
    const celkem = F.polozky.reduce((s, p) => s + Math.round(p.cena * p.mnozstvi), 0);
    const dph = rekapDph(F.polozky.map((p) => ({ sazba_dph: p.sazba_dph, celkem: Math.round(p.cena * p.mnozstvi) })));
    $('#ff-soucty', o.el).innerHTML = `${S.firma.platce_dph === '1' ? dph.map((d) => `<div class="radek mezera"><span class="mut">Základ ${d.sazba} %</span><span>${kc(d.zaklad)}</span></div>
      <div class="radek mezera"><span class="mut">DPH ${d.sazba} %</span><span>${kc(d.dph)}</span></div>`).join('') : ''}
      <div class="radek mezera fv-celkem"><span>Celkem</span><span>${kc(celkem)}</span></div>`;
    $$('#ff-pol tbody tr[data-i]', o.el).forEach((tr) => {
      const p = F.polozky[+tr.dataset.i];
      const q = $('[data-a=q]', tr); if (q) q.onchange = () => { const v = parseMn(q.value); if (Number.isFinite(v) && v > 0) p.mnozstvi = v; vykresli(); };
      const c = $('[data-a=c]', tr); if (c) c.onchange = () => { const v = parseKc(c.value); if (Number.isFinite(v) && v >= 0) p.cena = v; vykresli(); };
      const n = $('[data-a=n]', tr); if (n) n.oninput = () => { p.nazev = n.value; };
      const d = $('[data-a=d]', tr); if (d) d.onchange = () => { p.sazba_dph = +d.value; vykresli(); };
      const x = $('[data-a=x]', tr); if (x) x.onclick = () => { F.polozky.splice(+tr.dataset.i, 1); vykresli(); };
    });
  };

  // Odběratel z kontaktů
  const hl = $('#ff-hledat', o.el); const hn = $('#ff-nasep', o.el); let kontakty = []; let ch;
  hl.oninput = () => { clearTimeout(ch); ch = setTimeout(async () => {
    const q = hl.value.trim(); if (q.length < 2) { hn.classList.add('skryt'); return; }
    kontakty = await api('GET', '/api/odberatele?q=' + encodeURIComponent(q)).catch(() => []);
    hn.innerHTML = kontakty.map((k, i) => `<div class="pol" data-i="${i}"><span class="n">${esc(k.nazev)}<div class="mut2">${esc([k.ico && 'IČO ' + k.ico, k.mesto].filter(Boolean).join(' · '))}</div></span></div>`).join('') || '<div class="pol mut2">Nic nenalezeno – vyplňte údaje nebo IČO a ARES</div>';
    hn.classList.remove('skryt');
    $$('.pol[data-i]', hn).forEach((d) => { d.onmousedown = (e) => { e.preventDefault(); const k = kontakty[+d.dataset.i]; F.odb = k; POLE_ODB.forEach(([kk]) => { $(`#ff-${kk}`, o.el).value = k[kk] || ''; }); hl.value = ''; hn.classList.add('skryt'); }; });
  }, 200); };
  hl.onblur = () => setTimeout(() => hn.classList.add('skryt'), 150);

  // Zboží z katalogu
  const zi = $('#ff-zbozi', o.el); const zn = $('#ff-znasep', o.el);
  const pridej = (z, q = 1) => {
    const ex = F.polozky.find((p) => p.zbozi_id === z.id && p.cena === z.cena);
    if (ex) ex.mnozstvi += q; else F.polozky.push({ zbozi_id: z.id, nazev: z.nazev, mnozstvi: q, cena: z.cena, sazba_dph: z.sazba_dph, jednotka: z.jednotka });
    zi.value = ''; zn.classList.add('skryt'); vykresli(); zi.focus();
  };
  if (zi) {
    let zc; let nalez = [];
    zi.oninput = () => { clearTimeout(zc); const { text } = rozeberSken(zi.value); if (text.length < 2 || /^\d{8,}$/.test(text)) { zn.classList.add('skryt'); return; }
      zc = setTimeout(async () => { nalez = await api('GET', '/api/zbozi?limit=12&q=' + encodeURIComponent(text)).catch(() => []);
        zn.innerHTML = nalez.map((z, i) => `<div class="pol" data-i="${i}"><span class="n">${esc(z.nazev)}<div class="mut2">skladem ${mn(z.stav)}</div></span><strong>${kc(z.cena)}</strong></div>`).join('');
        zn.classList.toggle('skryt', !nalez.length);
        $$('.pol', zn).forEach((d) => { d.onmousedown = (e) => { e.preventDefault(); pridej(nalez[+d.dataset.i]); }; });
      }, 180); };
    zi.onkeydown = async (e) => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const { text, mnozstvi } = rozeberSken(zi.value); if (!text) return;
      try { pridej(await api('GET', '/api/zbozi/kod/' + encodeURIComponent(text)), mnozstvi); }
      catch { if (nalez.length === 1) pridej(nalez[0], mnozstvi); else toast('Zboží nenalezeno – vyberte z nabídky nebo přidejte vlastní položku'); }
    };
    zi.onblur = () => setTimeout(() => zn.classList.add('skryt'), 150);
    $('#ff-vlastni', o.el).onclick = () => { F.polozky.push({ zbozi_id: null, nazev: '', mnozstvi: 1, cena: 0, sazba_dph: 21, jednotka: 'ks' }); vykresli(); const v = $$('#ff-pol [data-a=n]', o.el).pop(); v && v.focus(); };
  }
  $$('[data-dni]', o.el).forEach((b) => { b.onclick = () => { $('#ff-spl', o.el).value = plusDni($('#ff-vyst', o.el).value, +b.dataset.dni); }; });
  $('#ff-forma', o.el).onchange = info;
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = async (e) => {
    const odb = { ...ctiOdberatele(o.el, 'ff'), id: F.odb.id || null };
    if (!odb.nazev) return toast('Vyplňte odběratele', 'chyba');
    if (!F.polozky.length) return toast('Faktura nemá žádnou položku', 'chyba');
    if (F.polozky.some((p) => !p.nazev.trim())) return toast('Vyplňte název u vlastní položky', 'chyba');
    e.target.disabled = true;
    try {
      const f = await api('POST', '/api/faktury-vydane', {
        odberatel: odb, forma_uhrady: $('#ff-forma', o.el).value, datum_vystaveni: $('#ff-vyst', o.el).value, duzp: $('#ff-duzp', o.el).value,
        splatnost: $('#ff-spl', o.el).value, poznamka: $('#ff-pozn', o.el).value.trim() || null, prodej_id: prodej ? prodej.id : null,
        polozky: zamceno ? [] : F.polozky.map((p) => (p.zbozi_id ? { zbozi_id: p.zbozi_id, mnozstvi: p.mnozstvi, cena: p.cena } : { nazev: p.nazev.trim(), mnozstvi: p.mnozstvi, cena: p.cena, sazba_dph: p.sazba_dph })),
      });
      if (zKosiku) { S.kosik = []; ulozKosik(); }
      o.zavri(); toast(`Faktura ${f.cislo} vystavena`, 'ok'); obnovEet();
      if (location.hash.startsWith('#faktury')) fvSeznam();
      detailFaktury(f.id);
    } catch (er) { chyba(er); e.target.disabled = false; }
  };
  info(); vykresli();
}

function htmlFaktury(f) {
  const fi = S.firma; const platce = fi.platce_dph === '1';
  const udaje = [['Datum vystavení', datumCz(f.datum_vystaveni)], ['Datum zdan. plnění', datumCz(f.duzp)], ['Datum splatnosti', datumCz(f.splatnost)],
    ['Forma úhrady', FORMY_FV[f.forma_uhrady]], ['Variabilní symbol', f.vs || '']];
  if (f.forma_uhrady === 'PREVOD' && fi.faktura_ucet) udaje.push(['Bankovní účet', fi.faktura_ucet], ['IBAN', f.iban || '']);
  return `<div class="fa">
    <div class="fa-hlav"><img src="static/img/logo.png" alt="" class="fa-logo"><div class="fa-titul"><div>${platce ? 'Faktura – daňový doklad' : 'Faktura'}</div><span>č. ${esc(f.cislo)}</span>
      ${f.stav === 'STORNO' ? '<em>STORNOVÁNO</em>' : ''}</div></div>
    <div class="fa-strany"><div><h4>Dodavatel</h4><strong>${esc(fi.firma_nazev || '')}</strong><br>${esc(fi.firma_adresa || '')}${fi.firma_ico ? `<br>IČO: ${esc(fi.firma_ico)}` : ''}${fi.firma_dic ? `<br>DIČ: ${esc(fi.firma_dic)}` : (platce ? '' : '<br>Neplátce DPH')}</div>
      <div><h4>Odběratel</h4><strong>${esc(f.odb_nazev)}</strong>${f.odb_adresa ? `<br>${esc(f.odb_adresa)}` : ''}${f.odb_ico ? `<br>IČO: ${esc(f.odb_ico)}` : ''}${f.odb_dic ? `<br>DIČ: ${esc(f.odb_dic)}` : ''}</div></div>
    <div class="fa-udaje">${udaje.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <table class="fa-pol"><thead><tr><th>Položka</th><th>Množství</th><th>Cena/MJ s DPH</th>${platce ? '<th>DPH</th>' : ''}<th>Celkem s DPH</th></tr></thead><tbody>
      ${f.polozky.map((p) => `<tr><td>${esc(p.nazev)}</td><td>${mn(p.mnozstvi)} ${esc(p.jednotka || '')}</td><td>${kc(p.cena)}</td>${platce ? `<td>${p.sazba_dph} %</td>` : ''}<td>${kc(p.celkem)}</td></tr>`).join('')}</tbody></table>
    <div class="fa-spodek"><div>${f.qr && !window.POKLADNA_DEMO ? `<img src="/api/faktury-vydane/${f.id}/qr.svg" alt="QR platba" class="fa-qr" onerror="this.remove()"><div class="mut2">QR Platba</div>` : ''}</div>
      <div class="fa-soucty">${platce ? `<table><tr><th>Sazba</th><th>Základ</th><th>DPH</th><th>Celkem</th></tr>${f.dph.map((d) => `<tr><td>${d.sazba} %</td><td>${kc(d.zaklad)}</td><td>${kc(d.dph)}</td><td>${kc(d.celkem)}</td></tr>`).join('')}</table>` : ''}
        <div class="fa-celkem">Celkem k úhradě: ${kc(f.celkem)}</div>${f.stav === 'UHRAZENO' ? `<div class="fa-uhr">Uhrazeno ${datumCz(f.datum_uhrady)} – neplaťte</div>` : ''}</div></div>
    ${f.poznamka ? `<p class="fa-pozn">${esc(f.poznamka)}</p>` : ''}
    <div class="fa-pata">${esc([fi.faktura_pata, f.vystavil && 'Vystavil: ' + f.vystavil].filter(Boolean).join(' · '))}</div></div>`;
}

async function detailFaktury(id, poZmene) {
  let f; try { f = await api('GET', '/api/faktury-vydane/' + id); } catch (e) { return chyba(e); }
  const [t, n] = stavFv(f);
  const o = okno({
    titul: `Faktura ${f.cislo}`, siroke: true,
    obsah: `<div class="radek mezera" style="margin-bottom:12px"><div><span class="stitek ${t}">${n}</span>${f.prodejka ? ` <span class="mut2">· k prodejce ${esc(f.prodejka)}</span>` : ''}${f.odeslano ? ` <span class="mut2">· odesláno ${datumCas(f.odeslano)}</span>` : ''}</div>
      <div class="radek">${f.stav === 'NEUHRAZENO' ? '<button class="btn ok mala" data-uhr>Označit jako uhrazenou</button>' : ''}${f.stav === 'UHRAZENO' && !f.prodej_id ? '<button class="btn mala" data-neuhr>Vrátit na neuhrazenou</button>' : ''}</div></div>
      <div class="papir">${htmlFaktury(f)}</div>`,
    pata: `${f.stav === 'NEUHRAZENO' && !f.prodej_id ? '<button class="btn nebezp" data-storno>Stornovat</button>' : ''}<span class="vypln"></span>
      <button class="btn" data-tisk>Tisk</button>${window.POKLADNA_DEMO ? '' : '<button class="btn" data-pdf>PDF</button>'}<button class="btn" data-mail>Odeslat e-mailem</button>
      <button class="btn" data-kopie title="Nová faktura se stejným odběratelem a položkami">Kopírovat</button><button class="btn hl" data-zavrit>Zavřít</button>`,
  });
  o.el.querySelector('.okno').style.maxWidth = '960px';
  const zmena = () => { o.zavri(); poZmene && poZmene(); detailFaktury(id, poZmene); };
  $('[data-zavrit]', o.el).onclick = () => o.zavri();
  $('[data-tisk]', o.el).onclick = () => tisk(htmlFaktury(f), true);
  const pdf = $('[data-pdf]', o.el); if (pdf) pdf.onclick = () => window.open(`/api/faktury-vydane/${id}/pdf`, '_blank');
  const uhr = $('[data-uhr]', o.el); if (uhr) uhr.onclick = async () => { try { await api('POST', `/api/faktury-vydane/${id}/uhrada`, { uhrazeno: true }); toast('Faktura uhrazena', 'ok'); zmena(); } catch (e) { chyba(e); } };
  const neu = $('[data-neuhr]', o.el); if (neu) neu.onclick = async () => { try { await api('POST', `/api/faktury-vydane/${id}/uhrada`, { uhrazeno: false }); zmena(); } catch (e) { chyba(e); } };
  const st = $('[data-storno]', o.el);
  if (st) st.onclick = async () => {
    if (!await potvrd('Storno faktury', `Stornovat fakturu ${esc(f.cislo)}? Zboží se vrátí na sklad.`, 'Stornovat', true)) return;
    try { await api('POST', `/api/faktury-vydane/${id}/storno`); toast('Faktura stornována', 'ok'); zmena(); } catch (e) { chyba(e); }
  };
  $('[data-kopie]', o.el).onclick = () => {
    o.zavri();
    formularFaktury({ odberatel: { id: f.odberatel_id, nazev: f.odb_nazev, ico: f.odb_ico, dic: f.odb_dic, email: f.odb_email, ...rozdelAdresu(f.odb_adresa) },
      polozky: f.polozky.filter((p) => p.nazev !== 'Zaokrouhlení').map((p) => ({ zbozi_id: p.zbozi_id, nazev: p.nazev, mnozstvi: p.mnozstvi, cena: p.cena, sazba_dph: p.sazba_dph, jednotka: p.jednotka })) });
  };
  $('[data-mail]', o.el).onclick = () => {
    if (window.POKLADNA_DEMO) return toast('V demu se e-maily neodesílají – ve skutečné pokladně odejde faktura jako PDF s QR platbou.');
    const m = okno({
      titul: `Odeslat fakturu ${f.cislo}`,
      obsah: `<label class="pole">Komu<input type="email" id="fm-komu" value="${esc(f.odb_email || '')}" placeholder="email@odberatele.cz" autofocus></label>
        <label class="pole" style="margin-top:10px">Zpráva<textarea id="fm-zprava" style="min-height:120px">Dobrý den,\nv příloze posíláme fakturu ${esc(f.cislo)} na ${kc(f.celkem)}${f.stav === 'NEUHRAZENO' ? ` se splatností ${datumCz(f.splatnost)}` : ''}.\n\nDěkujeme\n${esc(S.firma.firma_nazev || '')}</textarea></label>
        <p class="mut2">Faktura se přiloží jako PDF${f.qr ? ' s QR platbou' : ''}.</p>`,
      pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Odeslat</button>',
    });
    $('[data-zpet]', m.el).onclick = () => m.zavri();
    $('[data-ok]', m.el).onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api('POST', `/api/faktury-vydane/${id}/odeslat`, { komu: $('#fm-komu', m.el).value, zprava: $('#fm-zprava', m.el).value }); m.zavri(); toast(`Odesláno na ${r.komu.join(', ')}`, 'ok'); zmena(); }
      catch (er) { chyba(er); e.target.disabled = false; }
    };
  };
}

function rozdelAdresu(a) {
  const m = String(a || '').match(/^(.*?),\s*(\d{3}\s?\d{2})\s+(.+)$/);
  return m ? { ulice: m[1], psc: m[2], mesto: m[3] } : { ulice: a || null };
}

/* ======================================================================== nastavení */

function viewNastaveni(pod = 'firma') {
  if (!spravce()) { location.hash = '#prodej'; return; }
  $('#obsah').innerHTML = `<div class="zalozky"><a href="#nastaveni/firma" class="${pod === 'firma' ? 'aktivni' : ''}">Firma a účtenka</a>
    <a href="#nastaveni/eet" class="${pod === 'eet' ? 'aktivni' : ''}">EET</a><a href="#nastaveni/faktury" class="${pod === 'faktury' ? 'aktivni' : ''}">Faktury</a>
    <a href="#nastaveni/fakturace" class="${pod === 'fakturace' ? 'aktivni' : ''}">Fakturace</a><a href="#nastaveni/email" class="${pod === 'email' ? 'aktivni' : ''}">E-mail</a>
    <a href="#nastaveni/zaloha" class="${pod === 'zaloha' ? 'aktivni' : ''}">Záloha</a>
    <a href="#nastaveni/uzivatele" class="${pod === 'uzivatele' ? 'aktivni' : ''}">Uživatelé</a></div><div id="n-obsah"></div>`;
  if (pod === 'eet') return nastaveniEet();
  if (pod === 'faktury') return nastaveniFaktury();
  if (pod === 'zaloha') return nastaveniZaloha();
  if (pod === 'fakturace') return nastaveniFakturace();
  if (pod === 'email') return nastaveniEmail();
  if (pod === 'uzivatele') return nastaveniUzivatele();
  return nastaveniFirma();
}

async function ulozNastaveni(data) {
  const n = await api('PUT', '/api/nastaveni', data);
  const st = await api('GET', '/api/stav');
  S.firma = st.firma; S.eetRezim = st.eet_rezim;
  toast('Nastavení uloženo', 'ok');
  return n;
}

async function nastaveniFirma() {
  let n; try { n = await api('GET', '/api/nastaveni'); } catch (e) { return chyba(e); }
  $('#n-obsah').innerHTML = `<form class="karta" id="nf"><div class="hlav"><h2>Firma a účtenka</h2></div><div class="telo mrizka">
    <label class="pole">Název na účtence<input type="text" name="firma_nazev" value="${esc(n.firma_nazev)}"></label>
    <label class="pole">IČO<input type="text" name="firma_ico" value="${esc(n.firma_ico)}"></label>
    <label class="pole">DIČ<input type="text" name="firma_dic" value="${esc(n.firma_dic)}"></label>
    <label class="pole">Telefon<input type="text" name="telefon" value="${esc(n.telefon)}"></label>
    <label class="pole siroke">Sídlo / adresa firmy<input type="text" name="firma_adresa" value="${esc(n.firma_adresa)}"></label>
    <label class="pole siroke">Provozovna<input type="text" name="provozovna" value="${esc(n.provozovna)}"></label>
    <label class="pole siroke">Patička účtenky<input type="text" name="uctenka_paticka" value="${esc(n.uctenka_paticka)}"></label>
    <label class="zatrh"><input type="checkbox" name="platce_dph" ${n.platce_dph === '1' ? 'checked' : ''}> Plátce DPH (rekapitulace DPH na účtence)</label>
    <label class="zatrh"><input type="checkbox" name="zaokrouhlovat_hotovost" ${n.zaokrouhlovat_hotovost === '1' ? 'checked' : ''}> Zaokrouhlovat platby v hotovosti na celé koruny</label>
    </div><div class="telo" style="border-top:1px solid var(--linka);text-align:right"><button class="btn hl">Uložit</button></div></form>`;
  $('#nf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target; const d = {};
    ['firma_nazev', 'firma_ico', 'firma_dic', 'telefon', 'firma_adresa', 'provozovna', 'uctenka_paticka'].forEach((k) => { d[k] = f[k].value.trim(); });
    d.platce_dph = f.platce_dph.checked ? '1' : '0'; d.zaokrouhlovat_hotovost = f.zaokrouhlovat_hotovost.checked ? '1' : '0';
    try { await ulozNastaveni(d); } catch (er) { chyba(er); }
  };
}

async function nastaveniEet() {
  let n; try { n = await api('GET', '/api/nastaveni'); } catch (e) { return chyba(e); }
  $('#n-obsah').innerHTML = `<form class="karta" id="ne"><div class="hlav"><h2>Evidence tržeb (EET 2.0)</h2></div><div class="telo">
    <div class="upozorneni ${n.eet_rezim === 'produkce' ? 'skryt' : ''}" id="ne-upoz">Pokladna je v režimu <strong>${n.eet_rezim === 'vypnuto' ? 'bez EET' : 'test (playground)'}</strong>. Tržby se nezapočítávají jako evidované. Pro ostrý provoz od 1. 1. 2027 nastavte režim „Produkce“ a ostrý pokladní certifikát z DIS+.</div>
    <div class="mrizka">
      <label class="pole">Režim<select name="eet_rezim">${[['vypnuto', 'Vypnuto'], ['playground', 'Test (playground)'], ['produkce', 'Produkce (ostrý)']].map(([v, t]) => `<option value="${v}" ${v === n.eet_rezim ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="pole">EIČ (DIČ)<input type="text" name="eet_eic" value="${esc(n.eet_eic)}" placeholder="CZ12345678"></label>
      <label class="pole">Označení evidenční jednotky<input type="text" name="eet_id_jednotky" value="${esc(n.eet_id_jednotky)}" inputmode="numeric"></label>
      <label class="pole">Označení pokladny<input type="text" name="eet_id_pokl" value="${esc(n.eet_id_pokl)}"></label>
      <div class="pole siroke"><span>Pokladní certifikát (.p12 z DIS+)</span>
        <div class="radek"><input type="text" name="eet_cert_cesta" value="${esc(n.eet_cert_cesta)}" class="vypln" title="Cesta k souboru na serveru">
        <label class="btn">Nahrát certifikát<input type="file" id="ne-cert" accept=".p12,.pfx" class="skryt"></label></div></div>
      <label class="pole">Heslo k certifikátu<input type="password" name="eet_cert_heslo" value="${esc(n.eet_cert_heslo)}" autocomplete="new-password"></label>
      <label class="pole">Mezní doba odezvy (s, min. 2)<input type="text" name="eet_timeout_s" value="${esc(n.eet_timeout_s)}" inputmode="decimal"></label></div>
    <div id="ne-vysledek" style="margin-top:14px"></div></div>
    <div class="telo radek mezera" style="border-top:1px solid var(--linka)"><button type="button" class="btn" id="ne-test">Otestovat spojení</button><button class="btn hl">Uložit</button></div></form>`;
  const f = $('#ne');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = {}; ['eet_rezim', 'eet_eic', 'eet_id_jednotky', 'eet_id_pokl', 'eet_cert_cesta', 'eet_cert_heslo', 'eet_timeout_s'].forEach((k) => { d[k] = f[k].value.trim(); });
    if (d.eet_rezim === 'produkce' && /playground/i.test(d.eet_cert_cesta)) return toast('Pro produkci je potřeba ostrý certifikát, ne testovací', 'chyba');
    if (+d.eet_timeout_s < 2) return toast('Mezní doba odezvy musí být aspoň 2 s', 'chyba');
    if (d.eet_rezim === 'produkce' && !await potvrd('Ostrý režim EET', 'Od teď se každá tržba ostře eviduje u finanční správy. Pokračovat?', 'Zapnout produkci')) return;
    try { await ulozNastaveni(d); vykresliKostru(); route(); } catch (er) { chyba(er); }
  };
  $('#ne-cert').onchange = (e) => {
    const soubor = e.target.files[0]; e.target.value = '';
    if (!soubor) return;
    const o = okno({
      titul: 'Nahrát pokladní certifikát',
      obsah: `<p class="mut" style="margin-top:0">${esc(soubor.name)}</p><label class="pole">Heslo k certifikátu (zadané při jeho vytvoření v DIS+)<input type="password" id="nc-h" autocomplete="off" autofocus></label>`,
      pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Nahrát</button>',
    });
    $('[data-zpet]', o.el).onclick = () => o.zavri();
    const ok = () => {
      const ctecka = new FileReader();
      ctecka.onload = async () => {
        try {
          const r = await api('POST', '/api/eet/certifikat', { nazev: soubor.name, data: String(ctecka.result).split(',')[1], heslo: $('#nc-h', o.el).value });
          o.zavri(); toast(`Certifikát ${r.eic} nahrán, platí do ${new Date(r.plati_do).toLocaleDateString('cs-CZ')}${r.test ? ' (testovací)' : ''}`, 'ok'); nastaveniEet();
        } catch (er) { chyba(er); }
      };
      ctecka.readAsDataURL(soubor);
    };
    $('[data-ok]', o.el).onclick = ok;
    $('#nc-h', o.el).onkeydown = (ev) => { if (ev.key === 'Enter') ok(); };
  };
  $('#ne-test').onclick = async () => {
    const v = $('#ne-vysledek'); v.innerHTML = '<span class="mut">Zkouším spojení…</span>';
    try {
      const r = await api('POST', '/api/eet/test');
      v.innerHTML = r.ok ? `<div class="upozorneni" style="background:var(--ok-svetla);color:var(--ok)">Spojení funguje${r.test ? ' (testovací prostředí)' : ''}. Certifikát ${esc(r.certifikat)}, platí do ${esc(r.certifikat_plati_do)}.
          ${r.varovani && r.varovani.length ? '<br>' + r.varovani.map((x) => `Varování ${x[0]}: ${esc(x[1])}`).join('<br>') : ''}</div>`
        : `<div class="upozorneni chyba">Spojení nefunguje: ${esc(r.kod != null ? r.kod + ': ' : '')}${esc(r.text)}</div>`;
    } catch (e) { v.innerHTML = `<div class="upozorneni chyba">${esc(e.message)}</div>`; }
  };
}

async function nastaveniFaktury() {
  let n; try { n = await api('GET', '/api/nastaveni'); } catch (e) { return chyba(e); }
  $('#n-obsah').innerHTML = `<form class="karta" id="nfa"><div class="hlav"><h2>Naskladnění z faktur</h2></div><div class="telo">
    <p class="mut" style="margin-top:0">Faktury ve formátu ISDOC (i vložené v PDF) se čtou přesně a bez internetu. PDF bez ISDOC umí přečíst Claude, když sem zadáte API klíč z console.anthropic.com. Bez klíče se položky odhadnou z textu PDF.</p>
    <div class="mrizka">
      <label class="pole">Výchozí marže pro nové zboží (%)<input type="text" inputmode="decimal" name="vychozi_marze_pct" value="${esc(n.vychozi_marze_pct)}"></label>
      <label class="pole">Claude API klíč (nepovinné)<input type="password" name="ai_api_klic" value="${esc(n.ai_api_klic)}" autocomplete="new-password" placeholder="sk-ant-…"></label>
      <label class="pole">Model<input type="text" name="ai_model" value="${esc(n.ai_model)}"></label></div></div>
    <div class="telo" style="border-top:1px solid var(--linka);text-align:right"><button class="btn hl">Uložit</button></div></form>`;
  $('#nfa').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const m = parseMn(f.vychozi_marze_pct.value);
    if (!Number.isFinite(m) || m < 0) return toast('Neplatná marže', 'chyba');
    try { await ulozNastaveni({ vychozi_marze_pct: String(m), ai_api_klic: f.ai_api_klic.value.trim(), ai_model: f.ai_model.value.trim() || 'claude-opus-5-5' }); } catch (er) { chyba(er); }
  };
}

async function nastaveniFakturace() {
  let n; try { n = await api('GET', '/api/nastaveni'); } catch (e) { return chyba(e); }
  $('#n-obsah').innerHTML = `<form class="karta" id="nfk"><div class="hlav"><h2>Fakturace</h2></div><div class="telo"><div class="mrizka">
      <label class="pole">Bankovní účet (pro fakturu a QR platbu)<input type="text" name="faktura_ucet" value="${esc(n.faktura_ucet)}" placeholder="123456789/0800"></label>
      <div class="pole"><span>IBAN</span><div id="nfk-iban" class="mono" style="min-height:40px;display:flex;align-items:center"></div></div>
      <label class="pole">Splatnost (dní)<input type="text" name="faktura_splatnost_dni" value="${esc(n.faktura_splatnost_dni)}" inputmode="numeric"></label>
      <label class="pole">Číselná řada<input type="text" name="faktura_rada" value="${esc(n.faktura_rada)}" placeholder="FV"></label>
      <label class="pole siroke">Patička faktury (zápis v rejstříku, živnostenský list…)<input type="text" name="faktura_pata" value="${esc(n.faktura_pata)}"></label></div>
      <p class="mut2">Dodavatel na faktuře se bere z karty Firma a účtenka. Faktury se číslují FV + rok + pořadí (např. FV20260001), variabilní symbol je číslo faktury.</p></div>
    <div class="telo" style="border-top:1px solid var(--linka);text-align:right"><button class="btn hl">Uložit</button></div></form>`;
  const f = $('#nfk');
  const iban = () => { $('#nfk-iban').textContent = ibanZUctu(f.faktura_ucet.value) || (f.faktura_ucet.value.trim() ? 'neplatné číslo účtu' : '—'); };
  f.faktura_ucet.oninput = iban; iban();
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.faktura_ucet.value.trim() && !ibanZUctu(f.faktura_ucet.value)) return toast('Číslo účtu zadejte ve tvaru 123456789/0800 nebo jako IBAN', 'chyba');
    try { await ulozNastaveni({ faktura_ucet: f.faktura_ucet.value.trim(), faktura_splatnost_dni: String(parseInt(f.faktura_splatnost_dni.value, 10) || 14),
      faktura_rada: f.faktura_rada.value.trim().toUpperCase() || 'FV', faktura_pata: f.faktura_pata.value.trim() }); } catch (er) { chyba(er); }
  };
}

function ibanZUctu(ucet) {
  const u = String(ucet || '').replace(/\s/g, '').toUpperCase();
  if (/^CZ\d{22}$/.test(u)) return u;
  const m = u.match(/^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/);
  if (!m) return null;
  const bban = m[3] + (m[1] || '').padStart(6, '0') + m[2].padStart(10, '0');
  const zbytek = [...(bban + '123500')].reduce((r, c) => (r * 10 + +c) % 97, 0);
  return 'CZ' + String(98 - zbytek).padStart(2, '0') + bban;
}

async function nastaveniEmail() {
  let n; try { n = await api('GET', '/api/nastaveni'); } catch (e) { return chyba(e); }
  $('#n-obsah').innerHTML = `<form class="karta" id="nem"><div class="hlav"><h2>E-mail</h2></div><div class="telo">
    <p class="mut" style="margin-top:0">Pokladna posílá uzávěrky a faktury přes váš e-mailový účet (SMTP). Údaje najdete u poskytovatele schránky – u Seznamu smtp.seznam.cz, u Gmailu smtp.gmail.com s heslem aplikace.</p>
    <div class="mrizka">
      <label class="pole">SMTP server<input type="text" name="smtp_server" value="${esc(n.smtp_server)}" placeholder="smtp.seznam.cz"></label>
      <label class="pole">Port<input type="text" name="smtp_port" value="${esc(n.smtp_port)}" inputmode="numeric"></label>
      <label class="pole">Zabezpečení<select name="smtp_zabezpeceni">${[['STARTTLS', 'STARTTLS (port 587)'], ['SSL', 'SSL (port 465)'], ['ZADNE', 'Žádné']].map(([v, t]) => `<option value="${v}" ${v === n.smtp_zabezpeceni ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="pole">Uživatel<input type="text" name="smtp_uzivatel" value="${esc(n.smtp_uzivatel)}" autocomplete="off"></label>
      <label class="pole">Heslo<input type="password" name="smtp_heslo" value="${esc(n.smtp_heslo)}" autocomplete="new-password"></label>
      <label class="pole">Odesílatel<input type="email" name="smtp_odesilatel" value="${esc(n.smtp_odesilatel)}" placeholder="rumburk@pcobchod.com"></label>
      <label class="pole siroke">Příjemci uzávěrky (oddělte čárkou)<input type="text" name="uzaverka_prijemci" value="${esc(n.uzaverka_prijemci)}" placeholder="sef@…, ucetni@…"></label>
      <label class="pole">Automaticky odeslat uzávěrku v<input type="text" name="uzaverka_auto_cas" value="${esc(n.uzaverka_auto_cas)}" placeholder="např. 17:30 (prázdné = jen ručně)"></label></div>
    <div id="nem-vysl" style="margin-top:12px"></div></div>
    <div class="telo radek mezera" style="border-top:1px solid var(--linka)"><button type="button" class="btn" id="nem-test">Poslat zkušební e-mail</button><button class="btn hl">Uložit</button></div></form>`;
  const f = $('#nem');
  const data = () => Object.fromEntries(['smtp_server', 'smtp_port', 'smtp_zabezpeceni', 'smtp_uzivatel', 'smtp_heslo', 'smtp_odesilatel', 'uzaverka_prijemci', 'uzaverka_auto_cas'].map((k) => [k, f[k].value.trim()]));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = data();
    if (d.uzaverka_auto_cas && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.uzaverka_auto_cas)) return toast('Čas zadejte jako HH:MM', 'chyba');
    try { await ulozNastaveni(d); } catch (er) { chyba(er); }
  };
  $('#nem-test').onclick = async () => {
    const v = $('#nem-vysl'); v.innerHTML = '<span class="mut">Ukládám a odesílám…</span>';
    try { await ulozNastaveni(data()); const r = await api('POST', '/api/email/test', {}); v.innerHTML = `<div class="upozorneni" style="background:var(--ok-svetla);color:var(--ok)">Zkušební e-mail odešel na ${esc(r.komu.join(', '))}.</div>`; }
    catch (er) { v.innerHTML = `<div class="upozorneni chyba">${esc(er.message)}</div>`; }
  };
}

async function nastaveniZaloha() {
  let n; let st;
  try { [n, st] = await Promise.all([api('GET', '/api/nastaveni'), api('GET', '/api/zaloha/stav')]); } catch (e) { return chyba(e); }
  const p = st.posledni;
  $('#n-obsah').innerHTML = `<div class="karta" style="margin-bottom:14px"><div class="hlav"><h2>Stav zálohy</h2><button class="btn hl" id="nz-ted">Zálohovat teď</button></div><div class="telo">
      ${st.varovani ? '<div class="upozorneni chyba">Za posledních 36 hodin neodešla žádná záloha mimo prodejnu. Při požáru nebo krádeži serveru by se data ztratila.</div>' : ''}
      ${p ? `<p style="margin-top:0">Poslední záloha <strong>${datumCas(p.cas)}</strong> · ${Math.round(p.velikost / 1024)} kB · ${p.mista.length ? 'odesláno: ' + esc(p.mista.join(', ')) : '<span style="color:var(--chyba)">jen na tomto serveru</span>'}</p>
        ${p.chyby.map((x) => `<div class="upozorneni chyba">${esc(x)}</div>`).join('')}` : '<p class="mut" style="margin-top:0">Zatím žádná záloha.</p>'}
      ${st.lokalni.length ? `<details><summary class="mut" style="cursor:pointer">Zálohy na serveru (${st.lokalni.length})</summary><table class="tab" style="margin-top:8px"><tbody>
        ${st.lokalni.map((z) => `<tr><td class="mono">${esc(z.nazev)}</td><td>${datumCas(z.cas)}</td><td class="num">${Math.round(z.velikost / 1024)} kB</td><td><a class="btn mala" href="/api/zaloha/soubor/${encodeURIComponent(z.nazev)}">Stáhnout</a></td></tr>`).join('')}</tbody></table></details>` : ''}
    </div></div>
    <form class="karta" id="nz"><div class="hlav"><h2>Nastavení zálohy</h2></div><div class="telo">
      <p class="mut" style="margin-top:0">Záloha obsahuje databázi, nahrané faktury a certifikáty a je zašifrovaná heslem. <strong>Heslo si uložte mimo pokladnu</strong>, bez něj zálohu nikdo neobnoví.</p>
      <div class="mrizka">
        <label class="pole">Heslo zálohy (min. 8 znaků)<input type="password" name="zaloha_heslo" value="${esc(n.zaloha_heslo)}" autocomplete="new-password"></label>
        <label class="pole">Denní záloha v<input type="text" name="zaloha_cas" value="${esc(n.zaloha_cas)}" placeholder="21:30"></label>
        <label class="pole">Název prodejny v souboru<input type="text" name="zaloha_nazev" value="${esc(n.zaloha_nazev)}" placeholder="Rumburk"></label>
        <label class="pole siroke">Cíl na internetu přes rclone${st.rclone ? '' : ' <span style="color:var(--chyba)">(rclone na serveru chybí)</span>'}<input type="text" name="zaloha_rclone_cil" value="${esc(n.zaloha_rclone_cil)}" placeholder="gdrive:Pokladna/Rumburk"></label>
        <label class="pole siroke">Složka mimo server (USB disk, NAS)<input type="text" name="zaloha_slozka" value="${esc(n.zaloha_slozka)}" placeholder="/mnt/zaloha"></label>
        <label class="pole">Ponechat na serveru (počet)<input type="text" name="zaloha_ponechat_lokalne" value="${esc(n.zaloha_ponechat_lokalne)}" inputmode="numeric"></label>
        <label class="pole">Ponechat venku (dní)<input type="text" name="zaloha_ponechat_venku" value="${esc(n.zaloha_ponechat_venku)}" inputmode="numeric"></label></div></div>
      <div class="telo" style="border-top:1px solid var(--linka);text-align:right"><button class="btn hl">Uložit</button></div></form>`;
  $('#nz').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target; const d = {};
    ['zaloha_heslo', 'zaloha_cas', 'zaloha_nazev', 'zaloha_rclone_cil', 'zaloha_slozka', 'zaloha_ponechat_lokalne', 'zaloha_ponechat_venku'].forEach((k) => { d[k] = f[k].value.trim(); });
    if (d.zaloha_heslo && d.zaloha_heslo !== '********' && d.zaloha_heslo.length < 8) return toast('Heslo zálohy musí mít aspoň 8 znaků', 'chyba');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.zaloha_cas)) return toast('Čas zálohy zadejte jako HH:MM', 'chyba');
    try { await ulozNastaveni(d); nastaveniZaloha(); } catch (er) { chyba(er); }
  };
  $('#nz-ted').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Zálohuji…';
    try { const r = await api('POST', '/api/zaloha'); toast(r.posledni.chyby.length ? 'Záloha vytvořena, ale odeslání selhalo' : 'Záloha hotová', r.posledni.chyby.length ? 'chyba' : 'ok'); nastaveniZaloha(); obnovZalohu(); }
    catch (er) { chyba(er); e.target.disabled = false; e.target.textContent = 'Zálohovat teď'; }
  };
}

async function obnovZalohu() {
  const el = $('#zaloha-ind');
  if (!el || !spravce()) return;
  try { const st = await api('GET', '/api/zaloha/stav'); el.classList.toggle('skryt', !st.varovani); } catch { /* nic */ }
}
setInterval(obnovZalohu, 30 * 60 * 1000);

async function nastaveniUzivatele() {
  let rows; try { rows = await api('GET', '/api/uzivatele'); } catch (e) { return chyba(e); }
  $('#n-obsah').innerHTML = `<div class="karta"><div class="hlav"><h2>Uživatelé</h2><button class="btn hl" id="nu-novy">+ Přidat</button></div>
    <table class="tab"><thead><tr><th>Jméno</th><th>Role</th><th>Stav</th></tr></thead><tbody>
    ${rows.map((u) => `<tr class="klik" data-id="${u.id}"><td><strong>${esc(u.jmeno)}</strong></td><td>${u.role === 'SPRAVCE' ? 'správce' : 'prodavač'}</td><td>${u.aktivni ? '<span class="stitek ok">aktivní</span>' : '<span class="stitek sedy">vypnutý</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  const form = (u) => {
    const o = okno({
      titul: u ? u.jmeno : 'Nový uživatel',
      obsah: `<div class="mrizka"><label class="pole siroke">Jméno<input type="text" id="u-j" value="${esc(u ? u.jmeno : '')}" autofocus></label>
        <label class="pole">Role<select id="u-r"><option value="PRODAVAC" ${u && u.role === 'PRODAVAC' ? 'selected' : ''}>Prodavač</option><option value="SPRAVCE" ${u && u.role === 'SPRAVCE' ? 'selected' : ''}>Správce</option></select></label>
        <label class="pole">${u ? 'Nový PIN (nechte prázdné = beze změny)' : 'PIN (4–12 číslic)'}<input type="password" id="u-p" inputmode="numeric" autocomplete="new-password"></label>
        ${u ? `<label class="zatrh"><input type="checkbox" id="u-a" ${u.aktivni ? 'checked' : ''}> Aktivní</label>` : ''}</div>
        <p class="mut2">Prodavač prodává, storuje a vidí sklad. Správce navíc zakládá zboží, přijímá zboží, dělá inventury a mění nastavení.</p>`,
      pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Uložit</button>',
    });
    $('[data-zpet]', o.el).onclick = () => o.zavri();
    $('[data-ok]', o.el).onclick = async () => {
      const d = { jmeno: $('#u-j', o.el).value.trim(), role: $('#u-r', o.el).value, pin: $('#u-p', o.el).value.trim() || null, aktivni: u ? $('#u-a', o.el).checked : true };
      try { await api(u ? 'PUT' : 'POST', u ? '/api/uzivatele/' + u.id : '/api/uzivatele', d); o.zavri(); toast('Uloženo', 'ok'); nastaveniUzivatele(); } catch (e) { chyba(e); }
    };
  };
  $('#nu-novy').onclick = () => form(null);
  $$('#n-obsah tr[data-id]').forEach((tr) => { tr.onclick = () => form(rows.find((u) => u.id === +tr.dataset.id)); });
}

start();
