'use strict';
/* Uzávěrka, pokladní kniha (hotovost v šuplíku, vklady, výběry, odvody, spočítání pokladny) a export pro účetní. */

const DRUHY_POKL = {
  PRIJEM: [['VKLAD', 'Vklad do pokladny'], ['POCATECNI', 'Počáteční stav pokladny'], ['JINE', 'Jiný příjem']],
  VYDEJ: [['VYBER', 'Výběr z pokladny'], ['ODVOD', 'Odvod tržby (do banky, majiteli)'], ['NAKUP', 'Nákup za hotové'], ['JINE', 'Jiný výdej']],
};
const NOMINALY = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const MESICE_CZ = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

function viewUzaverka(pod = '') {
  const z = [['', 'Denní uzávěrka'], ['kniha', 'Pokladní kniha'], ...(spravce() ? [['export', 'Export pro účetní']] : [])];
  $('#obsah').innerHTML = `<div class="zalozky">${z.map(([h, t]) => `<a href="#uzaverka${h ? '/' + h : ''}" class="${(pod || '') === h ? 'aktivni' : ''}">${t}</a>`).join('')}</div><div id="uz-root"></div>`;
  if (pod === 'kniha') return uzKniha();
  if (pod === 'export' && spravce()) return uzExport();
  return uzDen();
}

async function uzDen() {
  $('#uz-root').innerHTML = `<div class="radek mezera" style="margin-bottom:14px"><h1 class="titul" style="margin:0">Uzávěrka</h1>
    <div class="radek"><input type="date" id="uz-datum" value="${dnes()}" style="width:170px"><button class="btn" id="uz-tisk">Tisk uzávěrky</button>
      <button class="btn" id="uz-xlsx">Excel</button><button class="btn hl" id="uz-mail">Odeslat e-mailem</button></div></div>
    <div id="uz-odeslano" class="mut2" style="margin:-6px 0 12px"></div><div id="uz-obsah"></div>`;
  let data;
  const nacti = async () => {
    try { data = await api('GET', '/api/uzaverka?datum=' + $('#uz-datum').value); } catch (e) { return chyba(e); }
    const h = data.platby.HOTOVE || { pocet: 0, celkem: 0 }; const k = data.platby.KARTA || { pocet: 0, celkem: 0 };
    const pr = data.typy.PRODEJ || { pocet: 0, celkem: 0 }; const st = data.typy.STORNO || { pocet: 0, celkem: 0 };
    const platce = S.firma.platce_dph === '1';
    const od = data.odeslano; const ho = data.hotovost; const poc = ho.pocitani;
    const dnesni = data.datum === dnes();
    $('#uz-odeslano').textContent = od && od.datum === data.datum ? `Odesláno e-mailem ${datumCas(od.odeslano)} na ${od.komu.join(', ')}` : '';
    $('#uz-obsah').innerHTML = `<div class="dlazdice">
        <div class="karta"><div class="pop">Tržba celkem</div><div class="hod">${kc(data.celkem)}</div></div>
        <div class="karta"><div class="pop">Hotově (do kasy)</div><div class="hod">${kc(h.celkem || 0)}</div></div>
        <div class="karta"><div class="pop">Kartou</div><div class="hod">${kc(k.celkem || 0)}</div></div>
        <div class="karta"><div class="pop">Účtenek</div><div class="hod">${pr.pocet}</div></div>
        <div class="karta"><div class="pop">Storna</div><div class="hod">${st.pocet} · ${kc(st.celkem || 0)}</div></div>
        <div class="karta"><div class="pop">Zaokrouhlení</div><div class="hod">${kc(data.zaokrouhleni)}</div></div></div>
      <div class="karta" style="margin-bottom:14px"><div class="hlav"><h2>Hotovost v pokladně</h2>${dnesni ? `<div class="radek"><button class="btn" data-kasa="PRIJEM">+ Vklad</button><button class="btn" data-kasa="VYDEJ">− Výběr / odvod</button><button class="btn hl" id="uz-spocitat">Spočítat pokladnu</button></div>` : ''}</div>
        <div class="telo"><div class="mrizka" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
          <div><div class="mut2">Ráno v pokladně</div><strong>${kc(ho.rano)}</strong></div>
          <div><div class="mut2">+ tržby hotově</div><strong>${kc(ho.trzby)}</strong></div>
          <div><div class="mut2">+ vklady a příjmy</div><strong>${kc(ho.prijmy)}</strong></div>
          <div><div class="mut2">− výběry a odvody</div><strong>${kc(ho.vydaje)}</strong></div>
          <div><div class="mut2">${dnesni ? 'Má být v pokladně' : 'Večer v pokladně'}</div><strong style="font-size:20px">${kc(ho.vecer)}</strong></div></div>
          ${poc ? `<div class="upozorneni" style="margin:12px 0 0;${poc.rozdil ? '' : 'background:var(--ok-svetla);color:var(--ok)'}">Spočítáno ${datumCas(poc.cas)} (${esc(poc.uzivatel || '')}): ${kc(poc.spocitano)}${poc.rozdil ? ` – ${poc.rozdil > 0 ? 'přebytek' : 'manko'} ${kc(Math.abs(poc.rozdil))}${poc.doklad_id ? ', zapsáno do pokladní knihy' : ''}` : ' – sedí'}</div>`
    : (dnesni ? '<p class="mut2" style="margin:12px 0 0">Na konci dne pokladnu spočítejte. Pokladna porovná hotovost se záznamy a případný rozdíl zapíše.</p>' : '')}</div></div>
      <div class="mrizka" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        ${platce ? `<div class="karta"><div class="hlav"><h2>DPH</h2></div><table class="tab"><thead><tr><th>Sazba</th><th class="num">Základ</th><th class="num">DPH</th><th class="num">Celkem</th></tr></thead><tbody>
          ${data.dph.map((d) => `<tr><td>${d.sazba_dph} %</td><td class="num">${kc(d.zaklad)}</td><td class="num">${kc(d.dph)}</td><td class="num">${kc(d.celkem)}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">—</td></tr>'}</tbody></table></div>` : ''}
        <div class="karta"><div class="hlav"><h2>Prodavači</h2></div><table class="tab"><thead><tr><th>Jméno</th><th class="num">Dokladů</th><th class="num">Celkem</th></tr></thead><tbody>
          ${data.prodavaci.map((p) => `<tr><td>${esc(p.jmeno || '')}</td><td class="num">${p.pocet}</td><td class="num">${kc(p.celkem)}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">—</td></tr>'}</tbody></table></div>
        <div class="karta"><div class="hlav"><h2>EET</h2></div><div class="telo" style="line-height:2">
          ${Object.keys(data.eet).length ? Object.entries(data.eet).map(([s, n]) => `${eetText({ eet_stav: s })} ${n}×`).join('<br>') : '<span class="mut">Žádné tržby</span>'}</div></div></div>`;
    $$('[data-kasa]', $('#uz-obsah')).forEach((b) => { b.onclick = () => pokladniDoklad(b.dataset.kasa, nacti); });
    const sp = $('#uz-spocitat'); if (sp) sp.onclick = () => spocitatPokladnu(nacti);
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
    const h = data.platby.HOTOVE || { celkem: 0 }; const k = data.platby.KARTA || { celkem: 0 }; const ho = data.hotovost;
    tisk(`${hlavickaTisku()}<div class="cara"></div><div class="stred velke">UZÁVĚRKA ${new Date(data.datum).toLocaleDateString('cs-CZ')}</div><div class="cara"></div>
      <table><tr><td>Hotově</td><td class="r">${kc(h.celkem || 0)}</td></tr><tr><td>Kartou</td><td class="r">${kc(k.celkem || 0)}</td></tr>
      <tr><td>Zaokrouhlení</td><td class="r">${kc(data.zaokrouhleni)}</td></tr><tr class="velke"><td>CELKEM</td><td class="r">${kc(data.celkem)}</td></tr>
      <tr><td>Účtenek / storen</td><td class="r">${(data.typy.PRODEJ || { pocet: 0 }).pocet} / ${(data.typy.STORNO || { pocet: 0 }).pocet}</td></tr></table>
      <div class="cara"></div><table><tr><td>Ráno v pokladně</td><td class="r">${kc(ho.rano)}</td></tr><tr><td>+ vklady</td><td class="r">${kc(ho.prijmy)}</td></tr>
      <tr><td>− výběry, odvody</td><td class="r">${kc(ho.vydaje)}</td></tr><tr class="velke"><td>V POKLADNĚ</td><td class="r">${kc(ho.vecer)}</td></tr>
      ${ho.pocitani ? `<tr><td>Spočítáno</td><td class="r">${kc(ho.pocitani.spocitano)}</td></tr><tr><td>Rozdíl</td><td class="r">${kc(ho.pocitani.rozdil)}</td></tr>` : ''}</table>
      ${S.firma.platce_dph === '1' ? `<div class="cara"></div><table>${data.dph.map((d) => `<tr><td>DPH ${d.sazba_dph} %</td><td class="r">${cislo2(d.zaklad)}</td><td class="r">${cislo2(d.dph)}</td></tr>`).join('')}</table>` : ''}
      <div class="cara"></div><table>${data.prodavaci.map((p) => `<tr><td>${esc(p.jmeno || '')}</td><td class="r">${kc(p.celkem)}</td></tr>`).join('')}</table>
      <div class="cara"></div><div>EET: ${Object.entries(data.eet).map(([s, n]) => `${s} ${n}`).join(', ') || '—'}</div>
      <div style="margin-top:3mm">Vytištěno ${datumCas(new Date().toISOString())} · ${esc(S.uzivatel.jmeno)}</div>`);
  };
  nacti();
}

/* ------------------------------------------------------------------------ hotovost */

async function menuHotovosti() {
  let st; try { st = await api('GET', '/api/pokladna/stav'); } catch (e) { return chyba(e); }
  const o = okno({
    titul: 'Hotovost v pokladně',
    obsah: `<div style="text-align:center"><div class="mut">Podle záznamů má být v pokladně</div><div class="velke-cislo">${kc(st.stav)}</div>
      ${st.posledni_pocitani ? `<div class="mut2">Naposledy spočítáno ${datumCas(st.posledni_pocitani.cas)}: ${kc(st.posledni_pocitani.spocitano)}</div>` : ''}</div>
      <div class="akce-mrizka" style="margin-top:16px"><button class="btn" data-k="PRIJEM">+ Vklad do pokladny</button><button class="btn" data-k="VYDEJ">− Výběr / odvod tržby</button>
        <button class="btn hl" data-k="pocitat" style="grid-column:span 2">Spočítat pokladnu</button></div>`,
    pata: '<a class="btn" href="#uzaverka/kniha">Pokladní kniha</a><button class="btn hl" data-zavrit>Zavřít</button>',
  });
  $('[data-zavrit]', o.el).onclick = () => o.zavri();
  $$('[data-k]', o.el).forEach((b) => { b.onclick = () => { o.zavri(); if (b.dataset.k === 'pocitat') spocitatPokladnu(); else pokladniDoklad(b.dataset.k); }; });
}

function pokladniDoklad(typ, poUlozeni) {
  const druhy = DRUHY_POKL[typ].filter(([k]) => k !== 'POCATECNI' || spravce());
  const o = okno({
    titul: typ === 'PRIJEM' ? 'Příjem do pokladny' : 'Výdej z pokladny',
    obsah: `<div class="mrizka">
      <label class="pole siroke">Druh<select id="pd-druh">${druhy.map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
      <label class="pole">Částka (Kč)<input type="text" inputmode="decimal" id="pd-castka" autofocus style="font-size:20px"></label>
      <label class="pole">${typ === 'PRIJEM' ? 'Od koho' : 'Komu (převzal)'}<input type="text" id="pd-osoba" placeholder="jméno"></label>
      <label class="pole siroke">Účel / poznámka<input type="text" id="pd-ucel" placeholder="${typ === 'PRIJEM' ? 'např. rozměňovací peníze' : 'např. odvod tržby do banky'}"></label></div>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Zapsat a vytisknout</button><button class="btn ok" data-jen>Jen zapsat</button>',
  });
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  const ok = async (tisknout) => {
    const castka = parseKc($('#pd-castka', o.el).value);
    if (!Number.isFinite(castka) || !castka || castka <= 0) return toast('Zadejte částku', 'chyba');
    try {
      const d = await api('POST', '/api/pokladna/doklady', { druh: $('#pd-druh', o.el).value, typ, castka,
        ucel: $('#pd-ucel', o.el).value.trim() || null, osoba: $('#pd-osoba', o.el).value.trim() || null });
      o.zavri(); toast(`${d.cislo} zapsán`, 'ok'); poUlozeni && poUlozeni();
      if (tisknout) tisk(htmlPokladnihoDokladu(d), true);
    } catch (e) { chyba(e); }
  };
  $('[data-ok]', o.el).onclick = () => ok(true);
  $('[data-jen]', o.el).onclick = () => ok(false);
  $('#pd-castka', o.el).onkeydown = (e) => { if (e.key === 'Enter') ok(false); };
}

// Částka slovy pro pokladní doklad: 1234 → „jedentisícdvěstětřicetčtyři“.
function korunySlovy(kc0) {
  const j = ['', 'jedna', 'dva', 'tři', 'čtyři', 'pět', 'šest', 'sedm', 'osm', 'devět', 'deset', 'jedenáct', 'dvanáct', 'třináct', 'čtrnáct', 'patnáct', 'šestnáct', 'sedmnáct', 'osmnáct', 'devatenáct'];
  const d = ['', '', 'dvacet', 'třicet', 'čtyřicet', 'padesát', 'šedesát', 'sedmdesát', 'osmdesát', 'devadesát'];
  const st = ['', 'sto', 'dvěstě', 'třista', 'čtyřista', 'pětset', 'šestset', 'sedmset', 'osmset', 'devětset'];
  const do999 = (n) => st[Math.floor(n / 100)] + (n % 100 < 20 ? j[n % 100] : d[Math.floor(n % 100 / 10)] + j[n % 10]);
  const n = Math.floor(Math.abs(kc0));
  if (n === 0) return 'nula';
  const mil = Math.floor(n / 1e6); const tis = Math.floor(n / 1000) % 1000; const zb = n % 1000;
  const cast = (x, jedna, dve, pet, zen) => (!x ? '' : x === 1 ? jedna : x < 5 ? (x === 2 && zen ? 'dva' : do999(x)) + dve : do999(x) + pet);
  return cast(mil, 'jedenmilion', 'miliony', 'milionů') + cast(tis, 'tisíc', 'tisíce', 'tisíc') + (zb === 1 && n > 1 ? 'jedna' : do999(zb));
}

function htmlPokladnihoDokladu(d) {
  const f = S.firma; const prijem = d.typ === 'PRIJEM';
  return `<div class="papir-doklad">
    <div class="radek mezera"><img src="static/img/logo.png" alt="" style="height:34px"><div style="text-align:right"><strong style="font-size:17px">${prijem ? 'PŘÍJMOVÝ' : 'VÝDAJOVÝ'} POKLADNÍ DOKLAD</strong><br>č. ${esc(d.cislo)}</div></div>
    <p><strong>${esc(f.firma_nazev || '')}</strong>, ${esc(f.firma_adresa || '')}${f.firma_ico ? `, IČO ${esc(f.firma_ico)}` : ''}${f.provozovna ? `<br>Provozovna: ${esc(f.provozovna)}` : ''}</p>
    <table class="tab"><tbody>
      <tr><td style="width:34%">Datum</td><td><strong>${datumCas(d.cas)}</strong></td></tr>
      <tr><td>${prijem ? 'Přijato od' : 'Vyplaceno komu'}</td><td><strong>${esc(d.osoba || '')}</strong></td></tr>
      <tr><td>Účel</td><td>${esc(d.ucel || d.druh_text)}</td></tr>
      <tr><td>Částka</td><td><strong style="font-size:18px">${kc(d.castka)}</strong></td></tr>
      <tr><td>Slovy</td><td>${korunySlovy(d.castka / 100)} korun${d.castka % 100 ? ` ${d.castka % 100} haléřů` : ''}</td></tr></tbody></table>
    ${d.stornovano ? '<p style="color:var(--chyba);font-weight:700">STORNOVÁNO</p>' : ''}
    <div class="podpisy"><div>Vystavil: ${esc(d.uzivatel || '')}</div><div>${prijem ? 'Předal' : 'Přijal'}: ……………………………</div><div>Schválil: ……………………………</div></div></div>`;
}

async function detailPokladnihoDokladu(id, poZmene) {
  let d; try { d = await api('GET', '/api/pokladna/doklady/' + id); } catch (e) { return chyba(e); }
  const o = okno({
    titul: `${d.typ === 'PRIJEM' ? 'Příjmový' : 'Výdajový'} doklad ${d.cislo}`, siroke: true,
    obsah: `<div class="papir">${htmlPokladnihoDokladu(d)}</div>`,
    pata: `${!d.stornovano && spravce() ? '<button class="btn nebezp" data-storno>Stornovat</button>' : ''}<span class="vypln"></span><button class="btn" data-tisk>Tisk</button><button class="btn hl" data-zavrit>Zavřít</button>`,
  });
  $('[data-zavrit]', o.el).onclick = () => o.zavri();
  $('[data-tisk]', o.el).onclick = () => tisk(htmlPokladnihoDokladu(d), true);
  const s = $('[data-storno]', o.el);
  if (s) s.onclick = async () => {
    if (!await potvrd('Storno pokladního dokladu', `Stornovat ${esc(d.cislo)} na ${kc(d.castka)}? Stav pokladny se vrátí.`, 'Stornovat', true)) return;
    try { await api('POST', `/api/pokladna/doklady/${id}/storno`); o.zavri(); toast('Stornováno', 'ok'); poZmene && poZmene(); } catch (e) { chyba(e); }
  };
}

async function spocitatPokladnu(poUlozeni) {
  let st; try { st = await api('GET', '/api/pokladna/stav'); } catch (e) { return chyba(e); }
  const pocty = {};
  const o = okno({
    titul: 'Spočítat pokladnu', siroke: true,
    obsah: `<p class="mut" style="margin-top:0">Zadejte počet kusů bankovek a mincí v šuplíku. Pokladna to porovná s tím, co má podle záznamů být.</p>
      <div class="mrizka nominaly" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">${NOMINALY.map((n) => `<label class="pole">${n} Kč${n >= 100 ? ' (bankovka)' : ''}<input type="text" inputmode="numeric" data-n="${n}" placeholder="0"></label>`).join('')}</div>
      <div class="dlazdice" style="margin-top:14px"><div class="karta"><div class="pop">Spočítáno</div><div class="hod" id="sp-spoc">0,00 Kč</div></div>
        <div class="karta"><div class="pop">Má být</div><div class="hod">${kc(st.stav)}</div></div><div class="karta" id="sp-rozdil-k"><div class="pop">Rozdíl</div><div class="hod" id="sp-rozdil">—</div></div></div>
      <label class="zatrh"><input type="checkbox" id="sp-zapsat" checked> Rozdíl zapsat do pokladní knihy (manko nebo přebytek)</label>
      <label class="pole" style="margin-top:10px">Poznámka<input type="text" id="sp-pozn" placeholder="např. konec směny"></label>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Uložit</button>',
  });
  const prepocet = () => {
    let celkem = 0;
    $$('[data-n]', o.el).forEach((i) => { const v = parseInt(i.value, 10) || 0; pocty[i.dataset.n] = v; celkem += v * i.dataset.n * 100; });
    const rozdil = celkem - st.stav;
    $('#sp-spoc', o.el).textContent = kc(celkem);
    $('#sp-rozdil', o.el).textContent = rozdil ? `${rozdil > 0 ? 'přebytek ' : 'manko '}${kc(Math.abs(rozdil))}` : 'sedí';
    $('#sp-rozdil', o.el).style.color = rozdil ? 'var(--chyba)' : 'var(--ok)';
    return celkem;
  };
  $$('[data-n]', o.el).forEach((i) => { i.oninput = prepocet; i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const vse = $$('[data-n]', o.el); const dalsi = vse[vse.indexOf(i) + 1]; if (dalsi) dalsi.focus(); else $('[data-ok]', o.el).focus(); } }; });
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = async () => {
    const celkem = prepocet();
    if (!celkem && !await potvrd('Prázdná pokladna', 'V pokladně není nic? Uložit spočítáno 0 Kč?', 'Uložit')) return;
    try {
      const r = await api('POST', '/api/pokladna/pocitani', { rozpis: pocty, zauctovat: $('#sp-zapsat', o.el).checked, poznamka: $('#sp-pozn', o.el).value.trim() || null });
      o.zavri(); toast(r.rozdil ? `Uloženo – ${r.rozdil > 0 ? 'přebytek' : 'manko'} ${kc(Math.abs(r.rozdil))}` : 'Pokladna sedí', r.rozdil ? 'chyba' : 'ok'); poUlozeni && poUlozeni();
      tisk(`${hlavickaTisku()}<div class="cara"></div><div class="stred velke">STAV POKLADNY</div><div class="stred">${datumCas(r.cas)} · ${esc(r.uzivatel || '')}</div><div class="cara"></div>
        <table>${NOMINALY.filter((n) => r.rozpis[n]).map((n) => `<tr><td>${n} Kč × ${r.rozpis[n]}</td><td class="r">${kc(n * 100 * r.rozpis[n])}</td></tr>`).join('')}</table><div class="cara"></div>
        <table><tr class="velke"><td>SPOČÍTÁNO</td><td class="r">${kc(r.spocitano)}</td></tr><tr><td>Má být</td><td class="r">${kc(r.ocekavano)}</td></tr><tr><td>Rozdíl</td><td class="r">${kc(r.rozdil)}</td></tr></table>
        <div style="margin-top:8mm">Podpis: ……………………………</div>`);
    } catch (e) { chyba(e); }
  };
  setTimeout(() => $('[data-n]', o.el).focus(), 40);
}

async function uzKniha() {
  const mesic = (nactiLokalne('kniha-mesic', null) || dnes().slice(0, 7));
  $('#uz-root').innerHTML = `<div class="radek mezera" style="margin-bottom:14px"><h1 class="titul" style="margin:0">Pokladní kniha</h1>
    <div class="radek"><input type="month" id="pk-mesic" value="${mesic}" style="width:170px"><button class="btn" data-kasa="PRIJEM">+ Příjem</button><button class="btn" data-kasa="VYDEJ">− Výdej</button>
      <button class="btn" id="pk-spocitat">Spočítat pokladnu</button><button class="btn" id="pk-tisk">Tisk knihy</button></div></div>
    <div class="dlazdice" id="pk-dl"></div><div class="karta"><div id="pk-seznam"></div></div>`;
  let data;
  const nacti = async () => {
    const m = $('#pk-mesic').value; ulozLokalne('kniha-mesic', m);
    try { data = await api('GET', '/api/pokladna/kniha?mesic=' + m); } catch (e) { return chyba(e); }
    $('#pk-dl').innerHTML = `<div class="karta"><div class="pop">Počáteční stav</div><div class="hod">${kc(data.pocatek)}</div></div>
      <div class="karta"><div class="pop">Příjmy</div><div class="hod" style="color:var(--ok)">${kc(data.prijmy)}</div></div>
      <div class="karta"><div class="pop">Výdaje</div><div class="hod" style="color:var(--chyba)">${kc(data.vydaje)}</div></div>
      <div class="karta"><div class="pop">Konečný stav</div><div class="hod">${kc(data.konec)}</div></div>`;
    $('#pk-seznam').innerHTML = data.radky.length ? `<table class="tab"><thead><tr><th>Datum</th><th>Doklad</th><th>Text</th><th>Osoba</th><th class="num">Příjem</th><th class="num">Výdej</th><th class="num">Zůstatek</th><th>Kdo</th></tr></thead><tbody>
      ${data.radky.map((r) => `<tr class="${r.id ? 'klik' : ''}" ${r.id ? `data-id="${r.id}"` : ''} style="${r.stornovano ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${r.id ? datumCas(r.cas) : datumCz(r.datum)}</td><td class="mono">${esc(r.cislo || '')}</td>
        <td>${esc(r.text)}</td><td>${esc(r.osoba || '')}</td><td class="num">${r.prijem ? kc(r.prijem) : ''}</td><td class="num">${r.vydej ? kc(r.vydej) : ''}</td><td class="num"><strong>${kc(r.zustatek)}</strong></td><td>${esc(r.uzivatel || '')}</td></tr>`).join('')}</tbody></table>
      ${data.pocitani.length ? `<div class="telo mut2">Spočítání pokladny: ${data.pocitani.map((p) => `${datumCas(p.cas)} ${kc(p.spocitano)}${p.rozdil ? ` (${p.rozdil > 0 ? '+' : ''}${cislo2(p.rozdil)})` : ''}`).join(' · ')}</div>` : ''}`
      : '<div class="prazdno">V tomto měsíci žádné pohyby hotovosti.</div>';
    $$('#pk-seznam tr[data-id]').forEach((tr) => { tr.onclick = () => detailPokladnihoDokladu(+tr.dataset.id, nacti); });
  };
  $('#pk-mesic').onchange = nacti;
  $$('#uz-root [data-kasa]').forEach((b) => { b.onclick = () => pokladniDoklad(b.dataset.kasa, nacti); });
  $('#pk-spocitat').onclick = () => spocitatPokladnu(nacti);
  $('#pk-tisk').onclick = () => {
    if (!data) return;
    const [r, m] = data.mesic.split('-');
    tisk(`<div class="papir-doklad"><div class="radek mezera"><strong style="font-size:17px">POKLADNÍ KNIHA – ${MESICE_CZ[+m - 1]} ${r}</strong><span>${esc(S.firma.firma_nazev || '')}</span></div>
      <table class="tab" style="margin-top:4mm"><thead><tr><th>Datum</th><th>Doklad</th><th>Text</th><th class="num">Příjem</th><th class="num">Výdej</th><th class="num">Zůstatek</th></tr></thead><tbody>
      <tr><td colspan="5">Počáteční stav</td><td class="num">${kc(data.pocatek)}</td></tr>
      ${data.radky.map((x) => `<tr style="${x.stornovano ? 'text-decoration:line-through' : ''}"><td>${datumCz(x.datum)}</td><td>${esc(x.cislo || '')}</td><td>${esc(x.text)}</td><td class="num">${x.prijem ? kc(x.prijem) : ''}</td><td class="num">${x.vydej ? kc(x.vydej) : ''}</td><td class="num">${kc(x.zustatek)}</td></tr>`).join('')}
      <tr><td colspan="3"><strong>Celkem</strong></td><td class="num"><strong>${kc(data.prijmy)}</strong></td><td class="num"><strong>${kc(data.vydaje)}</strong></td><td class="num"><strong>${kc(data.konec)}</strong></td></tr></tbody></table>
      <div class="podpisy"><div>Vytiskl: ${esc(S.uzivatel.jmeno)}</div><div>Kontroloval: ……………………………</div></div></div>`, true);
  };
  nacti();
}

/* ------------------------------------------------------------------------ export pro účetní */

async function uzExport() {
  const d = new Date(); if (d.getDate() <= 15) d.setMonth(d.getMonth() - 1);
  const vychozi = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  let n = {}; try { if (!window.POKLADNA_DEMO) n = await api('GET', '/api/nastaveni'); } catch { /* bez nastavení */ }
  $('#uz-root').innerHTML = `<div class="karta"><div class="hlav"><h2>Export pro účetní</h2></div><div class="telo">
    <p style="margin-top:0">Jeden ZIP se vším, co účetní za měsíc potřebuje:</p>
    <ul class="mut" style="line-height:1.7;margin-top:0"><li><strong>Přehled v Excelu</strong> – souhrn DPH, tržby po dnech, prodejky, vydané doklady, příjemky, výdejky, pokladní doklady a stav skladu ke konci měsíce</li>
      <li><strong>Vydané doklady</strong> v PDF a v <strong>ISDOC</strong> – Pohoda, Money, iDoklad, ABRA i další je načtou bez přepisování</li>
      <li><strong>Přijaté faktury</strong> dodavatelů nahrané při naskladnění</li></ul>
    <div class="mrizka" style="max-width:640px"><label class="pole">Měsíc<input type="month" id="ex-mesic" value="${vychozi}"></label>
      <label class="pole">E-mail účetní<input type="email" id="ex-komu" value="${esc(n.ucetni_email || '')}" placeholder="ucetni@…"></label></div></div>
    <div class="telo radek" style="border-top:1px solid var(--linka);justify-content:flex-end"><button class="btn" id="ex-stahnout">Stáhnout ZIP</button><button class="btn hl" id="ex-poslat">Odeslat účetní</button></div></div>`;
  $('#ex-stahnout').onclick = () => {
    if (window.POKLADNA_DEMO) return toast('V demu se export nestahuje – ve skutečné pokladně se stáhne ZIP s přehledem, PDF a ISDOC.');
    location.href = '/api/export/ucetni?mesic=' + $('#ex-mesic').value;
  };
  $('#ex-poslat').onclick = async (e) => {
    if (window.POKLADNA_DEMO) return toast('V demu se e-maily neodesílají.');
    const komu = $('#ex-komu').value.trim();
    if (!komu) return toast('Zadejte e-mail účetní', 'chyba');
    if (!await potvrd('Odeslat účetní', `Poslat podklady za ${$('#ex-mesic').value} na ${esc(komu)}?`, 'Odeslat')) return;
    e.target.disabled = true;
    try {
      if (komu !== (n.ucetni_email || '')) await api('PUT', '/api/nastaveni', { ucetni_email: komu });
      const r = await api('POST', '/api/export/ucetni/odeslat', { mesic: $('#ex-mesic').value, komu });
      toast(`Odesláno na ${r.komu.join(', ')} (${Math.round(r.velikost / 1024)} kB)`, 'ok');
    } catch (er) { chyba(er); } finally { e.target.disabled = false; }
  };
}
