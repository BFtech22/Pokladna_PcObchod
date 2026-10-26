'use strict';
/* Doklady vydané po vzoru iDokladu: faktury, zálohové faktury, daňové doklady k platbě, opravné doklady, nabídky,
   kontakty a párování plateb z bankovního výpisu. Používá pomocné funkce z app.js. */

const FORMY_FV = { PREVOD: 'Převodem', HOTOVE: 'Hotově', KARTA: 'Kartou', DOBIRKA: 'Dobírkou' };
const TYPY_FV = {
  FAKTURA: { titul: (p) => (p ? 'Faktura – daňový doklad' : 'Faktura'), celkem: 'Celkem k úhradě', novy: 'Nová faktura', tlacitko: 'Vystavit fakturu' },
  ZALOHOVA: { titul: () => 'Zálohová faktura', celkem: 'Záloha k úhradě', novy: 'Nová zálohová faktura', tlacitko: 'Vystavit zálohovou fakturu' },
  DDZP: { titul: (p) => (p ? 'Daňový doklad k přijaté platbě' : 'Doklad o přijaté platbě'), celkem: 'Přijatá platba' },
  OPRAVNY: { titul: (p) => (p ? 'Opravný daňový doklad' : 'Opravný doklad'), celkem: 'Celkem', novy: 'Opravný doklad', tlacitko: 'Vystavit opravný doklad' },
  NABIDKA: { titul: () => 'Cenová nabídka', celkem: 'Celkem', novy: 'Nová nabídka', tlacitko: 'Uložit nabídku' },
};
const ZALOZKY_FV = [['', 'FAKTURA', 'Faktury'], ['zalohove', 'ZALOHOVA', 'Zálohové'], ['opravne', 'OPRAVNY', 'Opravné doklady'],
  ['nabidky', 'NABIDKA', 'Nabídky'], ['banka', null, 'Banka'], ['kontakty', null, 'Kontakty']];
const TEXT_PDP = 'Daň odvede zákazník (přenesení daňové povinnosti podle § 92a zákona o DPH).';
const platceDph = () => S.firma.platce_dph === '1';

const datumCz = (iso) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('cs-CZ') : '');
const plusDni = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const adresaOdb = (o) => [o.ulice, [o.psc, o.mesto].filter(Boolean).join(' ')].filter(Boolean).join(', ');

function stavFv(f) {
  if (f.typ === 'NABIDKA') {
    if (f.stav === 'STORNO') return ['sedy', 'Zrušená'];
    if (f.stav === 'UHRAZENO') return ['ok', 'Přijatá'];
    return f.splatnost < dnes() ? ['sedy', 'Propadlá'] : ['ceka', 'Otevřená'];
  }
  if (f.stav === 'STORNO') return ['sedy', 'Stornováno'];
  if (f.typ === 'OPRAVNY') return f.stav === 'UHRAZENO' ? ['ok', 'Vyrovnáno'] : ['ceka', 'K vrácení'];
  if (f.stav === 'UHRAZENO') return ['ok', 'Uhrazeno'];
  return f.po_splatnosti ? ['chyba', 'Po splatnosti'] : ['ceka', 'Neuhrazeno'];
}

function viewFaktury(pod = '') {
  $('#obsah').innerHTML = `<div class="zalozky">${ZALOZKY_FV.map(([h, , t]) => `<a href="#faktury${h ? '/' + h : ''}" class="${(pod || '') === h ? 'aktivni' : ''}">${t}</a>`).join('')}</div><div id="fv-obsah"></div>`;
  if (pod === 'kontakty') return fvKontakty();
  if (pod === 'banka') return fvBanka();
  const z = ZALOZKY_FV.find((x) => x[0] === (pod || '')) || ZALOZKY_FV[0];
  return fvSeznam(z[1]);
}

const fvFiltry = {};
async function fvSeznam(typ = 'FAKTURA') {
  const filtr = fvFiltry[typ] || 'vse';
  const nab = typ === 'NABIDKA'; const opr = typ === 'OPRAVNY';
  const volby = nab ? [['vse', 'Vše'], ['neuhrazene', 'Otevřené'], ['uhrazene', 'Přijaté']]
    : opr ? [['vse', 'Vše'], ['neuhrazene', 'K vrácení'], ['uhrazene', 'Vyrovnané']]
      : [['vse', 'Vše'], ['neuhrazene', 'Neuhrazené'], ['po_splatnosti', 'Po splatnosti'], ['uhrazene', 'Uhrazené']];
  $('#fv-obsah').innerHTML = `<div class="dlazdice" id="fv-dl"></div>
    <div class="karta"><div class="hlav"><div class="filtry">${volby.map(([k, t]) => `<button class="filtr ${filtr === k ? 'aktivni' : ''}" data-f="${k}">${t}</button>`).join('')}</div>
      <div class="radek"><input type="search" id="fv-q" placeholder="Číslo, odběratel, IČO…" style="width:240px">
        <button class="btn skryt" id="fv-upom">Upomenout</button>${opr ? '' : `<button class="btn ok" id="fv-nova">+ ${TYPY_FV[typ].novy}</button>`}</div></div>
    <div id="fv-seznam"></div></div>`;
  let casovac;
  const nacti = async () => {
    let d;
    try { d = await api('GET', `/api/faktury-vydane?typ=${typ}&filtr=${filtr}&q=${encodeURIComponent($('#fv-q').value.trim())}`); } catch (e) { return chyba(e); }
    const s = d.souhrn;
    $('#fv-dl').innerHTML = nab ? `<div class="karta"><div class="pop">Otevřené nabídky</div><div class="hod">${kc(s.neuhrazeno)}</div></div>
        <div class="karta"><div class="pop">Nabídnuto tento měsíc</div><div class="hod">${kc(s.mesic)}</div></div>`
      : opr ? `<div class="karta"><div class="pop">K vrácení zákazníkům</div><div class="hod">${kc(-s.neuhrazeno)}</div></div>
        <div class="karta"><div class="pop">Opraveno tento měsíc</div><div class="hod">${kc(s.mesic)}</div></div>`
        : `<div class="karta"><div class="pop">Neuhrazeno</div><div class="hod">${kc(s.neuhrazeno)}</div></div>
        <div class="karta" style="${s.po_splatnosti ? 'border-color:#efc4c4' : ''}"><div class="pop">Po splatnosti${s.pocet_po_splatnosti ? ` (${s.pocet_po_splatnosti})` : ''}</div><div class="hod" style="${s.po_splatnosti ? 'color:var(--chyba)' : ''}">${kc(s.po_splatnosti)}</div></div>
        <div class="karta"><div class="pop">Vystaveno tento měsíc</div><div class="hod">${kc(s.mesic)}</div></div>`;
    const upom = $('#fv-upom');
    upom.classList.toggle('skryt', !(s.k_upominani > 0 && typ !== 'NABIDKA'));
    upom.textContent = `Upomenout po splatnosti (${s.k_upominani})`;
    $('#fv-seznam').innerHTML = d.faktury.length ? `<table class="tab"><thead><tr><th>Číslo</th><th>Odběratel</th><th>Vystaveno</th><th>${nab ? 'Platnost' : 'Splatnost'}</th>${nab ? '' : '<th>Úhrada</th>'}<th class="num">Částka</th><th>Stav</th></tr></thead><tbody>
      ${d.faktury.map((f) => { const [t, n] = stavFv(f); return `<tr class="klik" data-id="${f.id}" style="${f.stav === 'STORNO' ? 'opacity:.55' : ''}"><td class="mono"><strong>${esc(f.cislo)}</strong>${f.typ === 'DDZP' ? '<div class="mut2">daňový doklad k platbě</div>' : ''}${f.pdp ? '<div class="mut2">přenesená daň. pov.</div>' : ''}</td>
        <td>${esc(f.odb_nazev)}${f.odb_ico ? `<div class="mut2">IČO ${esc(f.odb_ico)}</div>` : ''}</td><td>${datumCz(f.datum_vystaveni)}</td><td style="${f.po_splatnosti ? 'color:var(--chyba);font-weight:700' : ''}">${datumCz(f.splatnost)}</td>
        ${nab ? '' : `<td>${FORMY_FV[f.forma_uhrady]}</td>`}<td class="num"><strong>${kc(f.celkem)}</strong></td><td><span class="stitek ${t}">${n}</span>${f.odeslano ? ' <span class="mut2" title="Odesláno e-mailem">✉</span>' : ''}${f.upominek ? ` <span class="mut2" title="Odeslané upomínky">⚠${f.upominek}</span>` : ''}</td></tr>`; }).join('')}</tbody></table>`
      : `<div class="prazdno">${filtr === 'vse' ? (opr ? 'Zatím žádné opravné doklady. Vystavují se z detailu faktury tlačítkem „Opravný doklad“.' : `Zatím nic. Začněte tlačítkem „+ ${TYPY_FV[typ].novy}“${typ === 'FAKTURA' ? ', nebo z prodejky' : ''}.`) : 'Nic nenalezeno'}</div>`;
    $$('#fv-seznam tr[data-id]').forEach((tr) => { tr.onclick = () => detailFaktury(+tr.dataset.id, nacti); });
  };
  $$('#fv-obsah [data-f]').forEach((b) => { b.onclick = () => { fvFiltry[typ] = b.dataset.f; fvSeznam(typ); }; });
  $('#fv-q').oninput = () => { clearTimeout(casovac); casovac = setTimeout(nacti, 200); };
  const nova = $('#fv-nova'); if (nova) nova.onclick = () => formularFaktury({ typ });
  $('#fv-upom').onclick = async (e) => {
    if (window.POKLADNA_DEMO) return toast('V demu se e-maily neodesílají – ve skutečné pokladně odejde upomínka s fakturou v PDF.');
    if (!await potvrd('Upomínky', 'Poslat upomínku e-mailem všem odběratelům s fakturou po splatnosti? Kdo dostal upomínku v posledních 7 dnech, ten ji znovu nedostane.', 'Poslat upomínky')) return;
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/faktury-vydane/upominky');
      toast(`Odesláno: ${tvar(r.odeslano.length, 'upomínka', 'upomínky', 'upomínek')}${r.chyby.length ? `, ${r.chyby.length} se nepodařilo: ${r.chyby.map((x) => x.cislo + ' – ' + x.chyba).join('; ')}` : ''}`, r.chyby.length ? 'chyba' : 'ok');
      nacti();
    } catch (er) { chyba(er); } finally { e.target.disabled = false; }
  };
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

const odberatelZDokladu = (f) => ({ id: f.odberatel_id, nazev: f.odb_nazev, ico: f.odb_ico, dic: f.odb_dic, email: f.odb_email, ...rozdelAdresu(f.odb_adresa) });
const polozkyZDokladu = (f, znamenko = 1) => f.polozky.filter((p) => p.nazev !== 'Zaokrouhlení' && !p.nazev.startsWith('Odpočet zálohy'))
  .map((p) => ({ zbozi_id: p.zbozi_id, nazev: p.nazev, mnozstvi: p.mnozstvi * znamenko, cena: p.cena, sazba_dph: p.sazba_dph, jednotka: p.jednotka }));
const bezDph = (cena, sazba) => Math.round(cena / (1 + sazba / 100));
const sDph = (cena, sazba) => Math.round(cena * (1 + sazba / 100));

/* Formulář dokladu. typ: FAKTURA | ZALOHOVA | OPRAVNY | NABIDKA; vazba = nabídka, záloha nebo opravovaná faktura. */
function formularFaktury({ typ = 'FAKTURA', prodej, polozky, zKosiku, odberatel, vazba, pdp = false, poVystaveni }) {
  const dnesni = dnes();
  const dni = typ === 'NABIDKA' ? 14 : +(S.firma.faktura_splatnost_dni || 14);
  const opr = typ === 'OPRAVNY'; const zal = typ === 'ZALOHOVA'; const nab = typ === 'NABIDKA';
  const F = {
    odb: odberatel || {}, vystaveni: dnesni, duzp: prodej ? prodej.cas.slice(0, 10) : dnesni, splatnost: plusDni(dnesni, prodej ? 0 : dni),
    forma: prodej ? prodej.platba : 'PREVOD', poznamka: '', pdp: !!pdp,
    polozky: prodej ? prodej.polozky.map((p) => ({ ...p })) : (polozky || []).map((p) => ({ ...p })),
  };
  const zamceno = !!prodej;
  const lzePdp = platceDph() && !zal && !zamceno;
  const formy = opr ? ['PREVOD', 'DOBIRKA'] : zal ? ['PREVOD'] : Object.keys(FORMY_FV);
  const titul = prodej ? `Faktura k prodejce ${prodej.cislo}` : vazba ? `${TYPY_FV[typ].novy} k ${vazba.cislo}` : TYPY_FV[typ].novy;
  const o = okno({
    titul, siroke: true,
    obsah: `<div class="fv-sloupce">
        <div class="fv-blok"><h3>Odběratel</h3>
          <div class="sken-box" style="margin-bottom:10px"><input type="search" id="ff-hledat" placeholder="Vyhledat v kontaktech…" autocomplete="off"><div class="naseptavac skryt" id="ff-nasep"></div></div>
          ${polaOdberatele(F.odb, 'ff')}</div>
        <div class="fv-blok"><h3>${nab ? 'Nabídka' : 'Doklad'}</h3><div class="mrizka mrizka2">
          <label class="pole">Datum vystavení<input type="date" id="ff-vyst" value="${F.vystaveni}"></label>
          ${zal || nab ? '' : `<label class="pole">${opr ? 'Datum opravy' : 'Datum zdan. plnění'}<input type="date" id="ff-duzp" value="${F.duzp}" ${zamceno ? 'disabled' : ''}></label>`}
          <label class="pole">${nab ? 'Platnost do' : 'Splatnost'}<input type="date" id="ff-spl" value="${F.splatnost}"></label>
          <div class="pole"><span>&nbsp;</span><div class="radek">${[7, 14, 30].map((n) => `<button type="button" class="btn mala" data-dni="${n}">${n} dní</button>`).join('')}</div></div>
          <label class="pole ${lzePdp ? '' : 'siroke'}">Forma úhrady<select id="ff-forma" ${zamceno || zal ? 'disabled' : ''}>${formy.map((k) => `<option value="${k}" ${k === F.forma ? 'selected' : ''}>${FORMY_FV[k]}</option>`).join('')}</select></label>
          ${lzePdp ? `<label class="zatrh" style="align-self:end;min-height:40px" title="Mobily, notebooky, tablety a herní konzole nad 100 000 Kč bez DPH pro plátce DPH"><input type="checkbox" id="ff-pdp" ${F.pdp ? 'checked' : ''} ${opr ? 'disabled' : ''}> Přenesená daňová povinnost</label>` : ''}
          ${opr ? `<label class="pole siroke">Důvod opravy (povinný)<input type="text" id="ff-duvod" placeholder="např. vrácení zboží, sleva za vadu, chyba v ceně"></label>
            <label class="zatrh siroke"><input type="checkbox" id="ff-sklad" checked> Vrácené zboží naskladnit zpět</label>` : ''}</div>
          <div class="mut2" id="ff-info" style="margin-top:10px"></div></div>
      </div>
      <div class="fv-blok" style="margin-top:14px"><h3>Položky</h3>
        <table class="tab" id="ff-pol"><thead><tr><th>Název</th><th class="num" style="width:110px">Množství</th><th class="num" style="width:130px" id="ff-hcena">Cena s DPH</th><th style="width:84px">DPH</th><th class="num" style="width:120px">Celkem</th><th style="width:40px"></th></tr></thead><tbody></tbody></table>
        ${zamceno ? '' : `<div class="radek" style="margin-top:10px"><div class="sken-box vypln"><input type="text" id="ff-zbozi" placeholder="Přidat zboží – čtečka nebo název…" autocomplete="off"><div class="naseptavac skryt" id="ff-znasep"></div></div>
          <button type="button" class="btn" id="ff-vlastni">+ Vlastní položka</button></div>`}</div>
      <div class="fv-pata"><label class="pole vypln">Poznámka na dokladu<textarea id="ff-pozn" placeholder="${nab ? 'např. Ceny platí při odběru celé sestavy' : 'např. Děkujeme za objednávku'}"></textarea></label><div class="fv-soucty" id="ff-soucty"></div></div>`,
    pata: `<button class="btn" data-zpet>Zrušit</button><button class="btn ok" data-ok style="min-width:170px">${TYPY_FV[typ].tlacitko}</button>`,
  });
  o.el.querySelector('.okno').style.maxWidth = '1100px';
  napojAres(o.el, 'ff');

  const info = () => {
    const forma = $('#ff-forma', o.el).value;
    let t;
    if (zamceno) t = `Zaplaceno na pokladně (${FORMY_FV[forma].toLowerCase()}), EET už proběhlo. Faktura se vystaví jako uhrazená.`;
    else if (nab) t = 'Nabídka nehýbe skladem ani tržbou. Z nabídky pak jedním tlačítkem vystavíte fakturu nebo zálohu.';
    else if (zal) t = `Zálohová faktura neodepisuje zboží ze skladu.${platceDph() ? ' Po zaplacení vznikne sám daňový doklad k přijaté platbě.' : ''} Zálohu odečte konečná faktura.`;
    else if (opr) t = 'Zboží vracené zákazníkem zadejte se záporným množstvím, slevu jako vlastní položku se zápornou cenou. Opravný doklad se pak vyrovná vrácením peněz nebo započtením s platbou faktury.';
    else if (vazba && vazba.typ === 'ZALOHOVA') t = `Záloha ${vazba.cislo} (${kc(vazba.celkem)}) se na faktuře odečte automaticky. Zboží se vydá ze skladu.`;
    else t = forma === 'HOTOVE' || forma === 'KARTA' ? 'Placeno hned na pokladně: vznikne i prodejka s EET a faktura bude uhrazená.'
      : 'Zboží se vydá ze skladu, faktura čeká na úhradu. Bez EET (platba převodem se neeviduje).';
    if (F.pdp) t += ' Přenesená daňová povinnost: ceny jsou bez DPH, daň přizná odběratel (musí mít DIČ).';
    $('#ff-info', o.el).textContent = t;
    const pdpBox = $('#ff-pdp', o.el);
    if (pdpBox && !opr) { pdpBox.disabled = !['PREVOD', 'DOBIRKA'].includes(forma); if (pdpBox.disabled && F.pdp) prepniPdp(false); }
  };
  const prepniPdp = (zapnout) => {
    if (zapnout === F.pdp) return;
    F.pdp = zapnout;
    // Zpět se vrací původní cena s DPH, aby přepínání nedělalo haléřové rozdíly.
    F.polozky.forEach((p) => {
      if (zapnout) { p.puvodniSDph = p.cena; p.cena = bezDph(p.cena, p.sazba_dph); p.prepoctena = p.cena; }
      else { p.cena = p.prepoctena === p.cena && p.puvodniSDph != null ? p.puvodniSDph : sDph(p.cena, p.sazba_dph); }
    });
    const box = $('#ff-pdp', o.el); if (box) box.checked = zapnout;
    vykresli(); info();
  };
  const vykresli = () => {
    $('#ff-hcena', o.el).textContent = F.pdp ? 'Cena bez DPH' : (platceDph() ? 'Cena s DPH' : 'Cena');
    $('#ff-pol tbody', o.el).innerHTML = F.polozky.map((p, i) => `<tr data-i="${i}"><td>${zamceno || p.zbozi_id ? esc(p.nazev) : `<input type="text" data-a="n" value="${esc(p.nazev)}">`}${p.serie && p.serie.length ? `<div class="mut2 mono">${p.serie.map(esc).join(', ')}</div>` : ''}</td>
      <td class="num">${zamceno || (p.serie && p.serie.length) ? mn(p.mnozstvi) : `<input type="text" inputmode="decimal" data-a="q" value="${mn(p.mnozstvi)}" style="text-align:right">`}</td>
      <td class="num">${zamceno ? kc(p.cena) : `<input type="text" inputmode="decimal" data-a="c" value="${cislo2(p.cena)}" style="text-align:right">`}</td>
      <td>${zamceno || p.zbozi_id ? `${p.sazba_dph} %` : `<select data-a="d">${[21, 12, 0].map((s) => `<option ${s === p.sazba_dph ? 'selected' : ''}>${s}</option>`).join('')}</select>`}</td>
      <td class="num"><strong>${kc(Math.round(p.cena * p.mnozstvi))}</strong></td><td>${zamceno ? '' : '<button class="btn ikona nebezp" data-a="x">×</button>'}</td></tr>`).join('')
      || '<tr><td colspan="6" class="prazdno">Přidejte zboží nebo vlastní položku</td></tr>';
    const celkem = F.polozky.reduce((s, p) => s + Math.round(p.cena * p.mnozstvi), 0);
    const zaloha = !zamceno && vazba && vazba.typ === 'ZALOHOVA' && typ === 'FAKTURA' ? vazba.celkem : 0;
    const dph = rekapDph(F.polozky.map((p) => ({ sazba_dph: p.sazba_dph, celkem: Math.round(p.cena * p.mnozstvi) })));
    $('#ff-soucty', o.el).innerHTML = `${platceDph() && !F.pdp && !nab && !zal ? dph.map((d) => `<div class="radek mezera"><span class="mut">Základ ${d.sazba} %</span><span>${kc(d.zaklad)}</span></div>
      <div class="radek mezera"><span class="mut">DPH ${d.sazba} %</span><span>${kc(d.dph)}</span></div>`).join('') : ''}
      ${F.pdp ? '<div class="radek mezera"><span class="mut">DPH</span><span>odvede zákazník</span></div>' : ''}
      ${zaloha ? `<div class="radek mezera"><span class="mut">Odpočet zálohy</span><span>${kc(-zaloha)}</span></div>` : ''}
      <div class="radek mezera fv-celkem"><span>${esc(TYPY_FV[typ].celkem)}</span><span>${kc(celkem - zaloha)}</span></div>`;
    $$('#ff-pol tbody tr[data-i]', o.el).forEach((tr) => {
      const p = F.polozky[+tr.dataset.i];
      const q = $('[data-a=q]', tr); if (q) q.onchange = () => { const v = parseMn(q.value); if (Number.isFinite(v) && v !== 0 && (opr || v > 0)) p.mnozstvi = v; vykresli(); };
      const c = $('[data-a=c]', tr); if (c) c.onchange = () => { const v = parseKc(c.value); if (Number.isFinite(v) && v != null && (v >= 0 || (opr && !p.zbozi_id))) p.cena = v; vykresli(); };
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
  const pridej = async (z, q = 1) => {
    const cena = F.pdp ? bezDph(z.cena, z.sazba_dph) : z.cena;
    const mnoz = opr ? -Math.abs(q) : q;
    zi.value = ''; zn.classList.add('skryt');
    if (z.seriova_cisla && mnoz > 0 && !nab && !zal) {          // zboží se sériovými čísly: každý kus zvlášť se SN
      const sn = await nactiSerie(z, Math.round(mnoz));
      if (sn) F.polozky.push({ zbozi_id: z.id, nazev: z.nazev, mnozstvi: sn.length, cena, sazba_dph: z.sazba_dph, jednotka: z.jednotka, serie: sn });
      vykresli(); zi.focus(); return;
    }
    const ex = F.polozky.find((p) => p.zbozi_id === z.id && p.cena === cena && !p.serie);
    if (ex) ex.mnozstvi += mnoz; else F.polozky.push({ zbozi_id: z.id, nazev: z.nazev, mnozstvi: mnoz, cena, sazba_dph: z.sazba_dph, jednotka: z.jednotka });
    vykresli(); zi.focus();
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
    $('#ff-vlastni', o.el).onclick = () => { F.polozky.push({ zbozi_id: null, nazev: opr ? 'Sleva' : '', mnozstvi: 1, cena: 0, sazba_dph: 21, jednotka: 'ks' }); vykresli(); const v = $$('#ff-pol [data-a=n]', o.el).pop(); v && v.focus(); };
  }
  $$('[data-dni]', o.el).forEach((b) => { b.onclick = () => { $('#ff-spl', o.el).value = plusDni($('#ff-vyst', o.el).value, +b.dataset.dni); }; });
  $('#ff-forma', o.el).onchange = info;
  const pdpBox = $('#ff-pdp', o.el); if (pdpBox) pdpBox.onchange = () => prepniPdp(pdpBox.checked);
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = async (e) => {
    const odb = { ...ctiOdberatele(o.el, 'ff'), id: F.odb.id || null };
    if (!odb.nazev) return toast('Vyplňte odběratele', 'chyba');
    if (!F.polozky.length) return toast('Doklad nemá žádnou položku', 'chyba');
    if (F.polozky.some((p) => !String(p.nazev || '').trim())) return toast('Vyplňte název u vlastní položky', 'chyba');
    if (F.pdp && !odb.dic) return toast('Při přenesené daňové povinnosti musí mít odběratel DIČ', 'chyba');
    const duvod = opr ? $('#ff-duvod', o.el).value.trim() : null;
    if (opr && !duvod) return toast('Uveďte důvod opravy', 'chyba');
    e.target.disabled = true;
    try {
      const f = await api('POST', '/api/faktury-vydane', {
        typ, odberatel: odb, forma_uhrady: $('#ff-forma', o.el).value, datum_vystaveni: $('#ff-vyst', o.el).value, duzp: $('#ff-duzp', o.el) ? $('#ff-duzp', o.el).value : null,
        splatnost: $('#ff-spl', o.el).value, poznamka: $('#ff-pozn', o.el).value.trim() || null, prodej_id: prodej ? prodej.id : null,
        vazba_id: vazba ? vazba.id : null, pdp: F.pdp, duvod_opravy: duvod, vratit_na_sklad: opr ? $('#ff-sklad', o.el).checked : true,
        polozky: zamceno ? [] : F.polozky.map((p) => (p.zbozi_id ? { zbozi_id: p.zbozi_id, mnozstvi: p.mnozstvi, cena: p.cena, serie: p.serie || [] } : { nazev: p.nazev.trim(), mnozstvi: p.mnozstvi, cena: p.cena, sazba_dph: p.sazba_dph })),
      });
      if (zKosiku) { S.kosik = []; ulozKosik(); }
      o.zavri(); toast(`${TYPY_FV[f.typ].titul(platceDph())} ${f.cislo} ${f.typ === 'NABIDKA' ? 'uložena' : 'vystaven' + (f.typ === 'FAKTURA' || f.typ === 'ZALOHOVA' ? 'a' : '')}`, 'ok'); obnovEet();
      if (location.hash.startsWith('#faktury')) route();
      if (poVystaveni) poVystaveni(f);
      detailFaktury(f.id);
    } catch (er) { chyba(er); e.target.disabled = false; }
  };
  info(); vykresli();
}

function udajeFv(f) {
  const fi = S.firma; const v = f.vazba || {};
  const u = [['Datum vystavení', datumCz(f.datum_vystaveni)]];
  if (f.typ === 'NABIDKA') return [...u, ['Platnost do', datumCz(f.splatnost)]];
  if (f.typ === 'DDZP') return [...u, ['Datum přijetí platby', datumCz(f.duzp)], ['Variabilní symbol', f.vs || ''], ['K zálohové faktuře', v.cislo || '']];
  if (f.typ === 'FAKTURA' || f.typ === 'OPRAVNY') u.push([f.typ === 'FAKTURA' ? 'Datum zdan. plnění' : 'Datum opravy', datumCz(f.duzp)]);
  if (f.typ === 'OPRAVNY') u.push(['Opravovaný doklad', `${v.cislo || ''} ze dne ${datumCz(v.duzp)}`]);
  u.push(['Datum splatnosti', datumCz(f.splatnost)], ['Forma úhrady', FORMY_FV[f.forma_uhrady]], ['Variabilní symbol', f.vs || '']);
  if (f.forma_uhrady === 'PREVOD' && fi.faktura_ucet && f.typ !== 'OPRAVNY') u.push(['Bankovní účet', fi.faktura_ucet], ['IBAN', f.iban || '']);
  return u;
}

function poznamkyFv(f) {
  const out = [];
  if (f.pdp) out.push(TEXT_PDP);
  if (f.typ === 'OPRAVNY' && f.duvod_opravy) out.push('Důvod opravy: ' + f.duvod_opravy);
  if (f.typ === 'ZALOHOVA' && platceDph()) out.push('Zálohová faktura není daňovým dokladem. Daňový doklad vystavíme po přijetí platby.');
  if (f.typ === 'DDZP') out.push('Daňový doklad k přijaté platbě (záloze). Částka se odečte na konečné faktuře.');
  if (f.typ === 'NABIDKA') out.push('Nabídka je nezávazná a platí do uvedeného data nebo do vyprodání zásob.');
  return out;
}

function htmlFaktury(f) {
  const fi = S.firma; const platce = platceDph(); const typ = f.typ || 'FAKTURA';
  const rekap = platce && !f.pdp && typ !== 'NABIDKA';
  return `<div class="fa">
    <div class="fa-hlav"><img src="static/img/logo.png" alt="" class="fa-logo"><div class="fa-titul"><div>${esc(TYPY_FV[typ].titul(platce))}</div><span>č. ${esc(f.cislo)}</span>
      ${f.stav === 'STORNO' ? `<em>${typ === 'NABIDKA' ? 'ZRUŠENO' : 'STORNOVÁNO'}</em>` : ''}</div></div>
    <div class="fa-strany"><div><h4>Dodavatel</h4><strong>${esc(fi.firma_nazev || '')}</strong><br>${esc(fi.firma_adresa || '')}${fi.firma_ico ? `<br>IČO: ${esc(fi.firma_ico)}` : ''}${fi.firma_dic ? `<br>DIČ: ${esc(fi.firma_dic)}` : (platce ? '' : '<br>Neplátce DPH')}</div>
      <div><h4>Odběratel</h4><strong>${esc(f.odb_nazev)}</strong>${f.odb_adresa ? `<br>${esc(f.odb_adresa)}` : ''}${f.odb_ico ? `<br>IČO: ${esc(f.odb_ico)}` : ''}${f.odb_dic ? `<br>DIČ: ${esc(f.odb_dic)}` : ''}</div></div>
    <div class="fa-udaje">${udajeFv(f).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <table class="fa-pol"><thead><tr><th>Položka</th><th>Množství</th><th>Cena/MJ ${f.pdp ? 'bez DPH' : (platce ? 's DPH' : '')}</th>${platce ? '<th>DPH</th>' : ''}<th>Celkem ${f.pdp ? 'bez DPH' : (platce ? 's DPH' : '')}</th></tr></thead><tbody>
      ${f.polozky.map((p) => `<tr><td>${esc(p.nazev)}</td><td>${mn(p.mnozstvi)} ${esc(p.jednotka || '')}</td><td>${kc(p.cena)}</td>${platce ? `<td>${f.pdp ? 'PDP' : p.sazba_dph + ' %'}</td>` : ''}<td>${kc(p.celkem)}</td></tr>`).join('')}</tbody></table>
    <div class="fa-spodek"><div>${f.qr && !window.POKLADNA_DEMO ? `<img src="/api/faktury-vydane/${f.id}/qr.svg" alt="QR platba" class="fa-qr" onerror="this.remove()"><div class="mut2">QR Platba</div>` : ''}</div>
      <div class="fa-soucty">${rekap ? `<table><tr><th>Sazba</th><th>Základ</th><th>DPH</th><th>Celkem</th></tr>${f.dph.map((d) => `<tr><td>${d.sazba} %</td><td>${kc(d.zaklad)}</td><td>${kc(d.dph)}</td><td>${kc(d.celkem)}</td></tr>`).join('')}</table>` : ''}
        <div class="fa-celkem">${esc(TYPY_FV[typ].celkem)}: ${kc(f.celkem)}</div>${f.stav === 'UHRAZENO' && (typ === 'FAKTURA' || typ === 'ZALOHOVA') ? `<div class="fa-uhr">Uhrazeno ${datumCz(f.datum_uhrady)} – neplaťte</div>` : ''}</div></div>
    ${[...poznamkyFv(f), f.poznamka].filter(Boolean).map((t) => `<p class="fa-pozn">${esc(t)}</p>`).join('')}
    <div class="fa-pata">${esc([fi.faktura_pata, f.vystavil && 'Vystavil: ' + f.vystavil].filter(Boolean).join(' · '))}</div></div>`;
}

async function detailFaktury(id, poZmene) {
  let f; try { f = await api('GET', '/api/faktury-vydane/' + id); } catch (e) { return chyba(e); }
  const [t, n] = stavFv(f);
  const typ = f.typ || 'FAKTURA';
  const aktivni = f.stav !== 'STORNO';
  const vyuctovano = f.navazne.some((x) => x.typ === 'FAKTURA' && x.stav !== 'STORNO');
  const akce = [];
  if (f.stav === 'NEUHRAZENO' && (typ === 'FAKTURA' || typ === 'ZALOHOVA')) akce.push('<button class="btn ok mala" data-uhr>Označit jako uhrazenou</button>');
  if (f.stav === 'NEUHRAZENO' && typ === 'OPRAVNY') akce.push('<button class="btn ok mala" data-uhr>Peníze vráceny / započteno</button>');
  if (f.stav === 'UHRAZENO' && !f.prodej_id && (typ === 'FAKTURA' || typ === 'OPRAVNY' || (typ === 'ZALOHOVA' && !f.navazne.some((x) => x.typ === 'DDZP')))) akce.push('<button class="btn mala" data-neuhr>Vrátit na neuhrazenou</button>');
  if (f.po_splatnosti) akce.push(`<button class="btn mala" data-upom>Upomínka${f.upominek ? ` (už ${f.upominek}×)` : ''}</button>`);
  const navazne = [f.vazba && `navazuje na <a href="#" data-fv="${f.vazba.id}">${esc(f.vazba.cislo)}</a>`,
    ...f.navazne.map((x) => `${x.typ === 'DDZP' ? 'daňový doklad' : x.typ === 'OPRAVNY' ? 'opravný doklad' : x.typ === 'ZALOHOVA' ? 'záloha' : 'faktura'} <a href="#" data-fv="${x.id}">${esc(x.cislo)}</a>${x.stav === 'STORNO' ? ' (storno)' : ''}`)].filter(Boolean);
  const o = okno({
    titul: `${TYPY_FV[typ].titul(platceDph())} ${f.cislo}`, siroke: true,
    obsah: `<div class="radek mezera" style="margin-bottom:12px"><div><span class="stitek ${t}">${n}</span>${f.prodejka ? ` <span class="mut2">· k prodejce ${esc(f.prodejka)}</span>` : ''}${f.odeslano ? ` <span class="mut2">· odesláno ${datumCas(f.odeslano)}</span>` : ''}${f.posledni_upominka ? ` <span class="mut2">· upomínka ${datumCas(f.posledni_upominka)}</span>` : ''}
        ${navazne.length ? `<div class="mut2" style="margin-top:6px">${navazne.join(' · ')}</div>` : ''}
        ${typ === 'FAKTURA' && f.k_uhrade !== f.celkem && aktivni ? `<div style="margin-top:6px"><strong>Po opravných dokladech k úhradě ${kc(f.k_uhrade)}</strong></div>` : ''}</div>
      <div class="radek">${akce.join('')}</div></div>
      <div class="papir">${htmlFaktury(f)}</div>`,
    pata: `${f.stav === 'NEUHRAZENO' && !f.prodej_id && typ !== 'DDZP' ? `<button class="btn nebezp" data-storno>${typ === 'NABIDKA' ? 'Zrušit nabídku' : 'Stornovat'}</button>` : ''}
      ${typ === 'NABIDKA' && f.stav === 'NEUHRAZENO' ? '<button class="btn ok" data-zfa>Vystavit fakturu</button><button class="btn" data-zzal>Zálohová faktura</button>' : ''}
      ${typ === 'ZALOHOVA' && f.stav === 'UHRAZENO' && !vyuctovano ? '<button class="btn ok" data-konec>Vystavit konečnou fakturu</button>' : ''}
      ${typ === 'FAKTURA' && aktivni && !f.prodej_id ? '<button class="btn" data-oprava>Opravný doklad</button>' : ''}
      <span class="vypln"></span>
      <button class="btn" data-tisk>Tisk</button>${window.POKLADNA_DEMO ? '' : `<button class="btn" data-pdf>PDF</button>${typ !== 'NABIDKA' ? '<button class="btn" data-isdoc title="Strojově čitelná faktura pro účetní program">ISDOC</button>' : ''}`}
      <button class="btn" data-mail>Odeslat e-mailem</button>
      ${typ === 'FAKTURA' || typ === 'NABIDKA' ? '<button class="btn" data-kopie title="Nový doklad se stejným odběratelem a položkami">Kopírovat</button>' : ''}<button class="btn hl" data-zavrit>Zavřít</button>`,
  });
  o.el.querySelector('.okno').style.maxWidth = '980px';
  const zmena = () => { o.zavri(); poZmene && poZmene(); detailFaktury(id, poZmene); };
  const klik = (sel, fn) => { const b = $(sel, o.el); if (b) b.onclick = fn; };
  klik('[data-zavrit]', () => o.zavri());
  klik('[data-tisk]', () => tisk(htmlFaktury(f), true));
  klik('[data-pdf]', () => window.open(`/api/faktury-vydane/${id}/pdf`, '_blank'));
  klik('[data-isdoc]', () => { location.href = `/api/faktury-vydane/${id}/isdoc`; });
  $$('[data-fv]', o.el).forEach((a) => { a.onclick = (e) => { e.preventDefault(); o.zavri(); detailFaktury(+a.dataset.fv, poZmene); }; });
  klik('[data-uhr]', async () => { try { await api('POST', `/api/faktury-vydane/${id}/uhrada`, { uhrazeno: true }); toast(typ === 'ZALOHOVA' && platceDph() ? 'Záloha uhrazena, daňový doklad k platbě vystaven' : 'Uhrazeno', 'ok'); zmena(); } catch (e) { chyba(e); } });
  klik('[data-neuhr]', async () => { try { await api('POST', `/api/faktury-vydane/${id}/uhrada`, { uhrazeno: false }); zmena(); } catch (e) { chyba(e); } });
  klik('[data-storno]', async () => {
    const text = typ === 'NABIDKA' ? `Zrušit nabídku ${esc(f.cislo)}?` : `Stornovat ${esc(f.cislo)}?${typ === 'FAKTURA' ? ' Zboží se vrátí na sklad.' : typ === 'OPRAVNY' ? ' Vrácené zboží se zase odepíše ze skladu.' : ''}`;
    if (!await potvrd(typ === 'NABIDKA' ? 'Zrušit nabídku' : 'Storno dokladu', text, typ === 'NABIDKA' ? 'Zrušit' : 'Stornovat', true)) return;
    try { await api('POST', `/api/faktury-vydane/${id}/storno`); toast('Hotovo', 'ok'); zmena(); } catch (e) { chyba(e); }
  });
  klik('[data-zfa]', () => { o.zavri(); formularFaktury({ typ: 'FAKTURA', odberatel: odberatelZDokladu(f), polozky: polozkyZDokladu(f), vazba: f, pdp: !!f.pdp }); });
  klik('[data-zzal]', () => { o.zavri(); formularFaktury({ typ: 'ZALOHOVA', odberatel: odberatelZDokladu(f), polozky: f.pdp ? polozkyZDokladu(f).map((p) => ({ ...p, cena: sDph(p.cena, p.sazba_dph) })) : polozkyZDokladu(f), vazba: f }); });
  klik('[data-konec]', () => { o.zavri(); formularFaktury({ typ: 'FAKTURA', odberatel: odberatelZDokladu(f), polozky: polozkyZDokladu(f), vazba: f }); });
  klik('[data-oprava]', () => { o.zavri(); formularFaktury({ typ: 'OPRAVNY', odberatel: odberatelZDokladu(f), polozky: polozkyZDokladu(f, -1), vazba: f, pdp: !!f.pdp }); });
  klik('[data-kopie]', () => { o.zavri(); formularFaktury({ typ, odberatel: odberatelZDokladu(f), polozky: polozkyZDokladu(f), pdp: !!f.pdp }); });
  klik('[data-upom]', async () => {
    if (window.POKLADNA_DEMO) return toast('V demu se e-maily neodesílají – ve skutečné pokladně odejde upomínka s fakturou v PDF.');
    if (!f.odb_email) return toast('Odběratel nemá e-mail – doplňte ho v kontaktech', 'chyba');
    if (!await potvrd('Upomínka', `Poslat upomínku k faktuře ${esc(f.cislo)} na ${esc(f.odb_email)}?`, 'Poslat')) return;
    try { const r = await api('POST', `/api/faktury-vydane/${id}/upominka`, {}); toast(`Upomínka odeslána na ${r.komu.join(', ')}`, 'ok'); zmena(); } catch (e) { chyba(e); }
  });
  klik('[data-mail]', () => {
    if (window.POKLADNA_DEMO) return toast('V demu se e-maily neodesílají – ve skutečné pokladně odejde doklad jako PDF s QR platbou.');
    const nazev = TYPY_FV[typ].titul(platceDph()).toLowerCase();
    const m = okno({
      titul: `Odeslat ${f.cislo}`,
      obsah: `<label class="pole">Komu<input type="email" id="fm-komu" value="${esc(f.odb_email || '')}" placeholder="email@odberatele.cz" autofocus></label>
        <label class="pole" style="margin-top:10px">Zpráva<textarea id="fm-zprava" style="min-height:120px">Dobrý den,\nv příloze posíláme ${esc(nazev)} ${esc(f.cislo)} na ${kc(f.celkem)}${f.stav === 'NEUHRAZENO' && (typ === 'FAKTURA' || typ === 'ZALOHOVA') ? ` se splatností ${datumCz(f.splatnost)}` : typ === 'NABIDKA' ? ` s platností do ${datumCz(f.splatnost)}` : ''}.\n\nDěkujeme\n${esc(S.firma.firma_nazev || '')}</textarea></label>
        <p class="mut2">Doklad se přiloží jako PDF${f.qr ? ' s QR platbou' : ''}.</p>`,
      pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Odeslat</button>',
    });
    $('[data-zpet]', m.el).onclick = () => m.zavri();
    $('[data-ok]', m.el).onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api('POST', `/api/faktury-vydane/${id}/odeslat`, { komu: $('#fm-komu', m.el).value, zprava: $('#fm-zprava', m.el).value }); m.zavri(); toast(`Odesláno na ${r.komu.join(', ')}`, 'ok'); zmena(); }
      catch (er) { chyba(er); e.target.disabled = false; }
    };
  });
}

function rozdelAdresu(a) {
  const m = String(a || '').match(/^(.*?),\s*(\d{3}\s?\d{2})\s+(.+)$/);
  return m ? { ulice: m[1], psc: m[2], mesto: m[3] } : { ulice: a || null };
}

/* ------------------------------------------------------------------------ banka */

let bankaFiltr = 'nesparovane';
async function fvBanka() {
  $('#fv-obsah').innerHTML = `<div class="karta" style="margin-bottom:14px"><div class="hlav"><h2>Bankovní výpis</h2><label class="btn hl">Načíst výpis…<input type="file" id="bk-soubor" accept=".gpc,.abo,.xml,.csv,.txt" class="skryt"></label></div>
      <div class="telo"><p class="mut" style="margin:0">Stáhněte z internetového bankovnictví výpis ve formátu <strong>GPC (ABO)</strong>, <strong>XML camt.053</strong> nebo <strong>CSV</strong> a nahrajte ho sem.
        Pokladna spáruje příchozí platby s fakturami a zálohami podle variabilního symbolu a částky a označí je jako uhrazené. Stejný výpis můžete nahrát i víckrát, nic se nezdvojí.</p>
      <div id="bk-vysl" style="margin-top:12px"></div></div></div>
    <div class="karta"><div class="hlav"><div class="filtry">${[['nesparovane', 'Nespárované'], ['sparovane', 'Spárované'], ['vse', 'Vše']].map(([k, t]) => `<button class="filtr ${bankaFiltr === k ? 'aktivni' : ''}" data-f="${k}">${t}</button>`).join('')}</div></div>
      <div id="bk-seznam"></div></div>`;
  let otevrene = [];
  const nacti = async () => {
    let rows;
    try {
      [rows, otevrene] = await Promise.all([api('GET', '/api/banka/pohyby?stav=' + bankaFiltr),
        api('GET', '/api/faktury-vydane?typ=vse&filtr=neuhrazene').then((d) => d.faktury.filter((x) => x.typ === 'FAKTURA' || x.typ === 'ZALOHOVA'))]);
    } catch (e) { return chyba(e); }
    $('#bk-seznam').innerHTML = rows.length ? `<table class="tab"><thead><tr><th>Datum</th><th class="num">Částka</th><th>VS</th><th>Protistrana</th><th>Zpráva</th><th>${bankaFiltr === 'nesparovane' ? 'Spárovat s dokladem' : 'Doklad'}</th></tr></thead><tbody>
      ${rows.map((b) => `<tr data-id="${b.id}"><td>${datumCz(b.datum)}</td><td class="num" style="color:${b.castka < 0 ? 'var(--chyba)' : 'var(--ok)'}"><strong>${kc(b.castka)}</strong></td><td class="mono">${esc(b.vs || '')}</td>
        <td>${esc(b.nazev || '')}<div class="mut2 mono">${esc(b.protiucet || '')}</div></td><td>${esc(b.zprava || '')}${b.poznamka ? `<div class="mut2">${esc(b.poznamka)}</div>` : ''}</td>
        <td>${b.faktura ? `<span class="stitek ok">${esc(b.faktura)}</span>` : b.ignorovano ? '<span class="stitek sedy">nesouvisí</span>' : `<div class="radek" style="flex-wrap:nowrap"><select data-a="f" style="min-width:200px"><option value="">— vyberte doklad —</option>
          ${otevrene.map((f) => `<option value="${f.id}" ${String(f.vs || '').replace(/^0+/, '') === String(b.vs || '') || f.celkem === b.castka ? 'selected' : ''}>${esc(f.cislo)} · ${esc(f.odb_nazev)} · ${kc(f.celkem)}</option>`).join('')}</select>
          <button class="btn mala ok" data-a="p">Spárovat</button><button class="btn mala" data-a="i" title="Platba nesouvisí s fakturami (nájem, vklad…)">Nesouvisí</button></div>`}</td></tr>`).join('')}</tbody></table>`
      : `<div class="prazdno">${bankaFiltr === 'nesparovane' ? 'Všechny příchozí platby jsou spárované.' : 'Zatím žádné pohyby.'}</div>`;
    $$('#bk-seznam tr[data-id]').forEach((tr) => {
      const bid = +tr.dataset.id;
      const p = $('[data-a=p]', tr); if (p) p.onclick = async () => {
        const fid = +$('[data-a=f]', tr).value; if (!fid) return toast('Vyberte doklad', 'chyba');
        try { await api('POST', `/api/banka/pohyby/${bid}`, { faktura_id: fid }); toast('Spárováno, doklad je uhrazený', 'ok'); nacti(); } catch (e) { chyba(e); }
      };
      const i = $('[data-a=i]', tr); if (i) i.onclick = async () => { try { await api('POST', `/api/banka/pohyby/${bid}`, { ignorovat: true }); nacti(); } catch (e) { chyba(e); } };
    });
  };
  $$('#fv-obsah [data-f]').forEach((b) => { b.onclick = () => { bankaFiltr = b.dataset.f; fvBanka(); }; });
  $('#bk-soubor').onchange = (e) => {
    const soubor = e.target.files[0]; e.target.value = '';
    if (!soubor) return;
    const ctecka = new FileReader();
    ctecka.onload = async () => {
      try {
        const r = await api('POST', '/api/banka/import', { nazev: soubor.name, data: String(ctecka.result).split(',')[1] });
        $('#bk-vysl').innerHTML = `<div class="upozorneni" style="background:var(--ok-svetla);color:var(--ok)">Načteno ${tvar(r.nacteno, 'pohyb', 'pohyby', 'pohybů')}, nových ${r.novych}. Spárováno ${r.sparovano.length}${r.sparovano.length ? ': ' + r.sparovano.map((x) => `${esc(x.cislo)} (${kc(x.castka)})`).join(', ') : ''}.
          ${r.nesparovano.length ? `<br>Nespárováno ${r.nesparovano.length} – přiřaďte je níže ručně.` : ''}</div>`;
        nacti();
      } catch (er) { $('#bk-vysl').innerHTML = `<div class="upozorneni chyba">${esc(er.message)}</div>`; }
    };
    ctecka.readAsDataURL(soubor);
  };
  nacti();
}
