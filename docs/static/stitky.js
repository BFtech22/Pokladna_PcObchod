'use strict';
/* Štítky a cenovky s čárovým kódem (EAN-13, EAN-8, Code 128 – kreslí se tady, bez knihovny),
   interní EAN pro zboží bez kódu a návrh objednávky podle minimální zásoby. */

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITA = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
// Code 128: šířky čar a mezer symbolů 0–106 (106 = stop)
const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232 2331112').split(' ');

function platnyEan(k) {
  if (!/^(\d{8}|\d{13})$/.test(k)) return false;
  const c = [...k].map(Number); const kontrola = c.pop();
  const soucet = c.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - soucet % 10) % 10 === kontrola;
}

function vzorEan(k) {
  if (k.length === 8) {
    return '101' + [...k.slice(0, 4)].map((c) => EAN_L[c]).join('') + '01010' + [...k.slice(4)].map((c) => EAN_R[c]).join('') + '101';
  }
  const parita = EAN_PARITA[k[0]];
  return '101' + [...k.slice(1, 7)].map((c, i) => (parita[i] === 'L' ? EAN_L : EAN_G)[c]).join('') + '01010' + [...k.slice(7)].map((c) => EAN_R[c]).join('') + '101';
}

function vzorCode128(text) {
  const hodnoty = [104, ...[...text].map((c) => Math.min(Math.max(c.charCodeAt(0) - 32, 0), 95))];
  const kontrola = hodnoty.reduce((s, v, i) => s + v * (i || 1), 0) % 103;
  return [...hodnoty, kontrola, 106].map((v) => [...C128[v]].map((w, i) => (i % 2 ? '0' : '1').repeat(+w)).join('')).join('');
}

// SVG čárového kódu: EAN, když je kód platný EAN, jinak Code 128. vyska v px (při tisku se škáluje).
function carovyKodSvg(kod, vyska = 40, sPopisem = true) {
  const ean = platnyEan(kod);
  const vzor = ean ? vzorEan(kod) : vzorCode128(kod);
  const klid = ean ? 9 : 10;
  const sirka = vzor.length + 2 * klid;
  let cary = '';
  for (let i = 0; i < vzor.length; i += 1) {
    if (vzor[i] !== '1') continue;
    let j = i; while (vzor[j + 1] === '1') j += 1;
    cary += `<rect x="${klid + i}" y="0" width="${j - i + 1}" height="${vyska}"/>`;
    i = j;
  }
  const popis = sPopisem ? `<text x="${sirka / 2}" y="${vyska + 9}" text-anchor="middle" font-size="9" font-family="monospace">${esc(kod)}</text>` : '';
  return `<svg class="carovy-kod" viewBox="0 0 ${sirka} ${vyska + (sPopisem ? 11 : 0)}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><g fill="#000">${cary}</g>${popis}</svg>`;
}
const code128Svg = (text, vyska = 30) => `<span style="display:inline-block;width:${Math.max(40, text.length * 11 + 35)}px;height:${vyska}px">${carovyKodSvg(text, 30, false)}</span>`;

const FORMATY_STITKU = { '50x30': 'Štítek 50 × 30 mm (tiskárna štítků)', '40x25': 'Štítek 40 × 25 mm (tiskárna štítků)', 'a4-3x8': 'Arch A4 – 24 štítků 70 × 37 mm' };

function htmlStitku(x) {
  if (x.zakazka) {
    const z = x.zakazka;
    return `<div class="stitek"><div class="st-nazev"><strong>${esc(z.cislo)}</strong> · ${esc(z.zakaznik)}</div><div class="st-mala">${esc(z.telefon || '')} · ${esc(z.zarizeni)}</div>
      <div class="st-kod">${carovyKodSvg(z.cislo, 40, false)}</div><div class="st-mala">přijato ${datumCz(z.prijato)}</div></div>`;
  }
  const z = x.zbozi; const kod = (z.eany && z.eany[0]) || z.kod || '';
  const zaJednotku = z.jednotka && z.jednotka !== 'ks' ? ` / ${esc(z.jednotka)}` : '';
  return `<div class="stitek"><div class="st-nazev">${esc(z.nazev)}</div>
    ${x.cena !== false ? `<div class="st-cena">${kc(z.cena).replace(',00 Kč', ',–')}<small>${zaJednotku}</small></div>` : ''}
    ${kod ? `<div class="st-kod">${carovyKodSvg(kod, 34)}</div>` : '<div class="st-mala">bez čárového kódu</div>'}</div>`;
}

function tiskStitku(seznam, format = '50x30') {
  const stitky = seznam.flatMap((x) => Array.from({ length: Math.max(0, Math.round(x.pocet || 0)) }, () => htmlStitku(x)));
  if (!stitky.length) return toast('Žádný štítek k tisku', 'chyba');
  const t = $('#tisk');
  t.className = 'stitky stitky-' + format;
  t.innerHTML = format.startsWith('a4') ? `<div class="arch">${stitky.join('')}</div>` : stitky.join('');
  setTimeout(() => window.print(), 50);
}

async function dialogStitky(zbozi, pocty = {}) {
  const spr = spravce();
  const bezKodu = zbozi.filter((z) => !(z.eany && z.eany.length) && !z.kod);
  const o = okno({
    titul: 'Tisk štítků a cenovek', siroke: true,
    obsah: `<div class="mrizka" style="margin-bottom:12px"><label class="pole">Formát<select id="st-format">${Object.entries(FORMATY_STITKU).map(([k, t]) => `<option value="${k}" ${k === (S.firma.stitek_format || '50x30') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="zatrh" style="align-self:end;min-height:40px"><input type="checkbox" id="st-cena" checked> S cenou</label></div>
      ${bezKodu.length ? `<div class="upozorneni">${tvar(bezKodu.length, 'položka nemá', 'položky nemají', 'položek nemá')} čárový kód.${spr ? ' <button class="btn mala" id="st-ean">Přidělit interní EAN</button>' : ''}</div>` : ''}
      <table class="tab"><thead><tr><th>Zboží</th><th>Kód</th><th class="num">Cena</th><th class="num" style="width:110px">Počet štítků</th></tr></thead><tbody>
      ${zbozi.map((z, i) => `<tr><td>${esc(z.nazev)}</td><td class="mono">${esc((z.eany && z.eany[0]) || z.kod || '—')}</td><td class="num">${kc(z.cena)}</td>
        <td class="num"><input type="text" inputmode="numeric" data-i="${i}" value="${pocty[z.id] != null ? pocty[z.id] : 1}" style="text-align:right"></td></tr>`).join('')}</tbody></table>
      <div class="mut2" style="margin-top:10px">Náhled:</div><div class="nahled-stitku" id="st-nahled"></div>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Tisknout</button>',
  });
  const nahled = () => { $('#st-nahled', o.el).innerHTML = zbozi.length ? htmlStitku({ zbozi: zbozi[0], cena: $('#st-cena', o.el).checked }) : ''; };
  $('#st-cena', o.el).onchange = nahled; nahled();
  const ean = $('#st-ean', o.el);
  if (ean) ean.onclick = async () => {
    try {
      const r = await api('POST', '/api/zbozi/interni-ean', { ids: bezKodu.map((z) => z.id) });
      r.prideleno.forEach((x) => { const z = zbozi.find((y) => y.id === x.zbozi_id); if (z) z.eany = [x.ean]; });
      toast(`Přiděleno ${tvar(r.prideleno.length, 'kód', 'kódy', 'kódů')}`, 'ok');
      const p = {}; $$('[data-i]', o.el).forEach((i) => { p[zbozi[+i.dataset.i].id] = i.value; }); o.zavri(); dialogStitky(zbozi, p);
    } catch (e) { chyba(e); }
  };
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = () => {
    const cena = $('#st-cena', o.el).checked;
    const seznam = $$('[data-i]', o.el).map((i) => ({ zbozi: zbozi[+i.dataset.i], pocet: parseInt(i.value, 10) || 0, cena }));
    o.zavri(); tiskStitku(seznam, $('#st-format', o.el).value);
  };
}

/* ------------------------------------------------------------------------ návrh objednávky */

async function skladObjednavky() {
  $('#sklad-obsah').innerHTML = '<div class="prazdno">Načítám…</div>';
  let rows; try { rows = await api('GET', '/api/sklad/objednavka'); } catch (e) { return chyba(e); }
  const skupiny = {};
  rows.forEach((r) => { const k = r.dodavatel || 'Bez dodavatele (zatím nepřijato z faktury)'; (skupiny[k] = skupiny[k] || []).push(r); });
  $('#sklad-obsah').innerHTML = rows.length ? `<p class="mut" style="margin-top:0">Zboží na minimálním stavu nebo pod ním. Návrh doplňuje do dvojnásobku minima (u rychle prodávaného do minima + prodej za 30 dní).
      Dodavatel a cena jsou z posledního příjmu. Minimální stav nastavíte na kartě zboží.</p>
    ${Object.entries(skupiny).map(([dod, pol], g) => `<div class="karta" style="margin-bottom:14px" data-g="${g}"><div class="hlav"><h2>${esc(dod)}</h2>
      <div class="radek"><button class="btn mala" data-a="kopie">Kopírovat</button><button class="btn mala" data-a="csv">CSV</button><button class="btn mala hl" data-a="tisk">Tisk objednávky</button></div></div>
      <table class="tab"><thead><tr><th style="width:30px"><input type="checkbox" data-a="vse" checked></th><th>Zboží</th><th>Kód dodavatele</th><th class="num">Skladem / min.</th><th class="num">Prodáno 30 / 90 dní</th><th class="num" style="width:100px">Objednat</th><th class="num">Nákup/MJ</th><th class="num">Celkem</th></tr></thead><tbody>
      ${pol.map((r, i) => `<tr data-i="${i}"><td><input type="checkbox" data-a="zatrh" checked></td><td>${esc(r.nazev)}<div class="mut2 mono">${esc(r.ean || r.kod || '')}</div></td><td class="mono">${esc(r.kod_dodavatele || '')}</td>
        <td class="num" style="color:var(--chyba)">${mn(r.stav)} / ${mn(r.min_stav)} ${esc(r.jednotka)}</td><td class="num">${mn(r.prodano_30)} / ${mn(r.prodano_90)}</td>
        <td class="num"><input type="text" inputmode="decimal" data-a="q" value="${mn(r.navrh)}" style="text-align:right"></td><td class="num">${r.nakupni_cena ? kc(r.nakupni_cena) : '—'}</td><td class="num" data-a="celkem"></td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="7" class="num"><strong>Celkem bez DPH</strong></td><td class="num"><strong data-a="suma"></strong></td></tr></tfoot></table></div>`).join('')}`
    : '<div class="prazdno">Nic nedochází. Zboží se sem dostane, když klesne na minimální stav (nastavuje se na kartě zboží).</div>';
  Object.values(skupiny).forEach((pol, g) => {
    const k = $(`[data-g="${g}"]`); const dod = Object.keys(skupiny)[g];
    const vybrane = () => $$('tbody tr', k).filter((tr) => $('[data-a=zatrh]', tr).checked).map((tr) => ({ ...pol[+tr.dataset.i], objednat: parseMn($('[data-a=q]', tr).value) || 0 })).filter((r) => r.objednat > 0);
    const prepocet = () => {
      let suma = 0;
      $$('tbody tr', k).forEach((tr) => { const r = pol[+tr.dataset.i]; const q = parseMn($('[data-a=q]', tr).value) || 0; const c = Math.round((r.nakupni_cena || 0) * q);
        $('[data-a=celkem]', tr).textContent = r.nakupni_cena ? kc(c) : ''; if ($('[data-a=zatrh]', tr).checked) suma += c; });
      $('[data-a=suma]', k).textContent = kc(suma);
    };
    $$('input', k).forEach((i) => { i.oninput = prepocet; i.onchange = prepocet; });
    $('[data-a=vse]', k).onchange = (e) => { $$('[data-a=zatrh]', k).forEach((c) => { c.checked = e.target.checked; }); prepocet(); };
    const text = () => vybrane().map((r) => `${r.kod_dodavatele || r.ean || ''}\t${r.nazev}\t${mn(r.objednat)} ${r.jednotka}`).join('\n');
    $('[data-a=kopie]', k).onclick = async () => {
      try { await navigator.clipboard.writeText(text()); toast('Seznam zkopírován – vložte ho do e-mailu nebo objednávky', 'ok'); } catch { toast('Kopírování prohlížeč nepovolil', 'chyba'); }
    };
    $('[data-a=csv]', k).onclick = () => {
      const csv = '﻿Kód dodavatele;EAN;Zboží;Množství;MJ;Nákupní cena bez DPH\n' + vybrane().map((r) => [r.kod_dodavatele || '', r.ean || '', `"${r.nazev.replace(/"/g, '""')}"`, String(r.objednat).replace('.', ','), r.jednotka, r.nakupni_cena ? cislo2(r.nakupni_cena) : ''].join(';')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `objednavka_${dnes()}.csv`; a.click();
    };
    $('[data-a=tisk]', k).onclick = () => {
      const v = vybrane(); if (!v.length) return toast('Nic není vybrané', 'chyba');
      const suma = v.reduce((s, r) => s + Math.round((r.nakupni_cena || 0) * r.objednat), 0);
      tisk(`<div class="papir-doklad"><div class="radek mezera"><img src="static/img/logo.png" alt="" style="height:34px"><strong style="font-size:17px">OBJEDNÁVKA</strong></div>
        <div class="radek mezera" style="margin-top:10px;align-items:flex-start"><div><strong>Odběratel</strong><br>${esc(S.firma.firma_nazev || '')}<br>${esc(S.firma.firma_adresa || '')}${S.firma.firma_ico ? `<br>IČO ${esc(S.firma.firma_ico)}` : ''}${S.firma.firma_dic ? `, DIČ ${esc(S.firma.firma_dic)}` : ''}${S.firma.provozovna ? `<br>Dodat na: ${esc(S.firma.provozovna)}` : ''}</div>
          <div><strong>Dodavatel</strong><br>${esc(dod)}${pol[0].dodavatel_ico ? `<br>IČO ${esc(pol[0].dodavatel_ico)}` : ''}<br>Datum: ${datumCz(dnes())}</div></div>
        <table class="tab" style="margin-top:12px"><thead><tr><th>Kód</th><th>Zboží</th><th class="num">Množství</th><th class="num">Cena/MJ bez DPH</th><th class="num">Celkem</th></tr></thead><tbody>
        ${v.map((r) => `<tr><td class="mono">${esc(r.kod_dodavatele || r.ean || '')}</td><td>${esc(r.nazev)}</td><td class="num">${mn(r.objednat)} ${esc(r.jednotka)}</td><td class="num">${r.nakupni_cena ? kc(r.nakupni_cena) : ''}</td><td class="num">${r.nakupni_cena ? kc(Math.round(r.nakupni_cena * r.objednat)) : ''}</td></tr>`).join('')}
        <tr><td colspan="4"><strong>Celkem bez DPH (orientačně)</strong></td><td class="num"><strong>${kc(suma)}</strong></td></tr></tbody></table>
        <div class="podpisy"><div>Vystavil: ${esc(S.uzivatel.jmeno)}</div></div></div>`, true);
    };
    prepocet();
  });
}
