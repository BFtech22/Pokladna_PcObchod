'use strict';
/* Servis a reklamace: zakázky na opravu a reklamace (lhůta 30 dní), díly a práce, záloha, předání dodavateli,
   výdej zákazníkovi a protokoly k tisku. Navíc záruční list k prodejce a načítání sériových čísel / IMEI. */

const STAVY_S = {
  PRIJATO: ['info', 'Přijato'], DIAGNOSTIKA: ['info', 'Diagnostika'], CEKA_ZAKAZNIK: ['ceka', 'Čeká na souhlas zákazníka'], CEKA_DIL: ['ceka', 'Čeká na díl'],
  V_OPRAVE: ['info', 'V opravě'], U_DODAVATELE: ['ceka', 'U dodavatele / výrobce'], HOTOVO: ['ok', 'Připraveno k vyzvednutí'], VYDANO: ['sedy', 'Vydáno'], ZRUSENO: ['sedy', 'Zrušeno'],
};
const VYRIZENI_S = {
  REKLAMACE: [['OPRAVA', 'Uznána – opraveno'], ['VYMENA', 'Uznána – vyměněno za nové'], ['SLEVA', 'Uznána – přiměřená sleva'], ['VRACENI_PENEZ', 'Uznána – vráceny peníze'], ['ZAMITNUTO', 'Zamítnuta']],
  OPRAVA: [['OPRAVENO', 'Opraveno'], ['NEOPRAVITELNE', 'Nelze opravit'], ['ODMITNUTO', 'Zákazník opravu odmítl']],
};
const POZADAVKY = ['oprava', 'výměna za nové', 'přiměřená sleva', 'odstoupení od smlouvy (vrácení peněz)'];
const FILTRY_S = [['aktivni', 'Rozpracované'], ['reklamace', 'Reklamace'], ['opravy', 'Opravy'], ['u_dodavatele', 'U dodavatele'], ['hotove', 'K vyzvednutí'], ['lhuta', 'Hoří lhůta'], ['vydane', 'Uzavřené']];
const stitekS = (z) => { const [t, n] = STAVY_S[z.stav] || ['sedy', z.stav]; return `<span class="stitek ${t}">${esc(n)}</span>`; };
const lhutaText = (z) => {
  if (!z.lhuta || ['VYDANO', 'ZRUSENO'].includes(z.stav) || z.vyrizeno) return '';
  const d = z.dni_do_lhuty;
  return `<span style="${d <= 5 ? 'color:var(--chyba);font-weight:700' : ''}">${datumCz(z.lhuta)} (${d < 0 ? `${-d} dní po lhůtě!` : d === 0 ? 'dnes' : `zbývá ${tvar(d, 'den', 'dny', 'dní')}`})</span>`;
};

let servisFiltr = 'aktivni';
async function viewServis() {
  $('#obsah').innerHTML = `<div class="radek mezera" style="margin-bottom:14px"><h1 class="titul" style="margin:0">Servis a reklamace</h1>
      <div class="radek"><button class="btn" id="sv-rekl">+ Reklamace</button><button class="btn ok" id="sv-nova">+ Zakázka na opravu</button></div></div>
    <div class="dlazdice" id="sv-dl"></div>
    <div class="karta"><div class="hlav"><div class="filtry" id="sv-filtry"></div>
      <input type="search" id="sv-q" placeholder="Číslo, zákazník, telefon, IMEI / SN, RMA…" style="width:280px"></div><div id="sv-seznam"></div></div>`;
  let casovac;
  const nacti = async () => {
    let d; try { d = await api('GET', `/api/servis?filtr=${servisFiltr}&q=${encodeURIComponent($('#sv-q').value.trim())}`); } catch (e) { return chyba(e); }
    const p = d.pocty; const soucet = (...k) => k.reduce((s, x) => s + (p[x] || 0), 0);
    $('#sv-dl').innerHTML = `<div class="karta"><div class="pop">Rozpracované</div><div class="hod">${soucet('PRIJATO', 'DIAGNOSTIKA', 'CEKA_ZAKAZNIK', 'CEKA_DIL', 'V_OPRAVE', 'U_DODAVATELE')}</div></div>
      <div class="karta"><div class="pop">Čeká na díl / zákazníka</div><div class="hod">${soucet('CEKA_DIL', 'CEKA_ZAKAZNIK')}</div></div>
      <div class="karta"><div class="pop">U dodavatele</div><div class="hod">${soucet('U_DODAVATELE')}</div></div>
      <div class="karta"><div class="pop">K vyzvednutí</div><div class="hod" style="color:var(--ok)">${soucet('HOTOVO')}</div></div>
      <div class="karta" style="${d.hori_lhuta ? 'border-color:#efc4c4' : ''}"><div class="pop">Reklamace – lhůta do 7 dní</div><div class="hod" style="${d.hori_lhuta ? 'color:var(--chyba)' : ''}">${d.hori_lhuta}</div></div>`;
    $('#sv-filtry').innerHTML = FILTRY_S.map(([k, t]) => `<button class="filtr ${servisFiltr === k ? 'aktivni' : ''}" data-f="${k}">${t}${k === 'lhuta' && d.hori_lhuta ? ` (${d.hori_lhuta})` : ''}</button>`).join('');
    $$('#sv-filtry [data-f]').forEach((b) => { b.onclick = () => { servisFiltr = b.dataset.f; nacti(); }; });
    $('#sv-seznam').innerHTML = d.zakazky.length ? `<table class="tab"><thead><tr><th>Číslo</th><th>Přijato</th><th>Zákazník</th><th>Zařízení</th><th>Stav</th><th>Lhůta / termín</th><th class="num">Částka</th></tr></thead><tbody>
      ${d.zakazky.map((z) => `<tr class="klik" data-id="${z.id}"><td class="mono"><strong>${esc(z.cislo)}</strong><div class="mut2">${z.typ === 'REKLAMACE' ? 'reklamace' : 'oprava'}</div></td>
        <td>${datumCz(z.prijato)}</td><td>${esc(z.zakaznik)}${z.telefon ? `<div class="mut2">${esc(z.telefon)}</div>` : ''}</td>
        <td>${esc(z.zarizeni)}${z.sn ? `<div class="mut2 mono">${esc(z.sn)}</div>` : ''}${z.dodavatel && z.stav === 'U_DODAVATELE' ? `<div class="mut2">→ ${esc(z.dodavatel)}</div>` : ''}</td>
        <td>${stitekS(z)}</td><td>${lhutaText(z) || (z.termin && !['VYDANO', 'ZRUSENO'].includes(z.stav) ? `termín ${datumCz(z.termin)}` : '')}</td><td class="num">${z.celkem ? kc(z.celkem) : ''}</td></tr>`).join('')}</tbody></table>`
      : `<div class="prazdno">${servisFiltr === 'aktivni' ? 'Žádné rozpracované zakázky. Přijměte zařízení tlačítkem „+ Zakázka na opravu“ nebo „+ Reklamace“.' : 'Nic nenalezeno'}</div>`;
    $$('#sv-seznam tr[data-id]').forEach((tr) => { tr.onclick = () => detailZakazky(+tr.dataset.id, nacti); });
  };
  $('#sv-q').oninput = () => { clearTimeout(casovac); casovac = setTimeout(nacti, 200); };
  $('#sv-nova').onclick = () => formularZakazky({ typ: 'OPRAVA' }, nacti);
  $('#sv-rekl').onclick = () => formularZakazky({ typ: 'REKLAMACE' }, nacti);
  nacti();
}

function formularZakazky(z, poUlozeni) {
  const rekl = z.typ === 'REKLAMACE'; const nova = !z.id;
  const o = okno({
    titul: nova ? (rekl ? 'Nová reklamace' : 'Nová zakázka na opravu') : `Úprava ${z.cislo}`, siroke: true,
    obsah: `<div class="fv-sloupce">
      <div class="fv-blok"><h3>Zákazník</h3>
        <div class="sken-box" style="margin-bottom:10px"><input type="search" id="zk-hledat" placeholder="Vyhledat v kontaktech…" autocomplete="off"><div class="naseptavac skryt" id="zk-nasep"></div></div>
        <div class="mrizka mrizka2"><label class="pole siroke">Jméno / firma<input type="text" id="zk-zakaznik" value="${esc(z.zakaznik || '')}"></label>
        <label class="pole">Telefon<input type="tel" id="zk-telefon" value="${esc(z.telefon || '')}"></label>
        <label class="pole">E-mail<input type="email" id="zk-email" value="${esc(z.email || '')}"></label></div>
        ${rekl ? `<h3 style="margin-top:16px">Nákup</h3><div class="mrizka mrizka2">
          <label class="pole siroke">IMEI / sériové číslo – dohledá prodej<div class="radek" style="flex-wrap:nowrap"><input type="text" id="zk-sn-hledat" value="${esc(z.sn || '')}"><button type="button" class="btn mala" id="zk-dohledat">Dohledat</button></div></label>
          <label class="pole">Doklad o koupi<input type="text" id="zk-doklad" value="${esc(z.doklad_koupe || z.prodejka_koupe || '')}" placeholder="číslo prodejky / faktury"></label>
          <label class="pole">Datum koupě<input type="date" id="zk-datumk" value="${esc((z.datum_koupe || (z.cas_koupe || '')).slice(0, 10))}"></label>
          <div class="mut2 siroke" id="zk-nalez"></div></div>` : ''}</div>
      <div class="fv-blok"><h3>Zařízení</h3><div class="mrizka mrizka2">
        <label class="pole siroke">Zařízení (druh, značka, model)<input type="text" id="zk-zarizeni" value="${esc(z.zarizeni || '')}" placeholder="např. iPhone 12 černý, notebook Lenovo IdeaPad 5"></label>
        <label class="pole">IMEI / sériové číslo<input type="text" id="zk-sn" value="${esc(z.sn || '')}"></label>
        <label class="pole">Kód odemčení<input type="text" id="zk-heslo" value="${esc(z.heslo || '')}" autocomplete="off" placeholder="když ho zákazník nechá"></label>
        <label class="pole siroke">Příslušenství<input type="text" id="zk-prisl" value="${esc(z.prislusenstvi || '')}" placeholder="nabíječka, obal, SIM, paměťová karta…"></label>
        <label class="pole siroke">Stav při převzetí<input type="text" id="zk-vzhled" value="${esc(z.vzhled || '')}" placeholder="oděrky, prasklé sklo, vlhkost…"></label>
        <label class="pole siroke">${rekl ? 'Popis vady (jak ji popsal zákazník)' : 'Závada / co se má udělat'}<textarea id="zk-zavada">${esc(z.zavada || '')}</textarea></label>
        ${rekl ? `<label class="pole siroke">Požadovaný způsob vyřízení<select id="zk-pozadavek">${POZADAVKY.map((t) => `<option ${t === z.pozadavek ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`
    : `<label class="pole">Předběžná cena (Kč)<input type="text" inputmode="decimal" id="zk-odhad" value="${z.odhad != null ? cislo2(z.odhad) : ''}"></label>
        <label class="pole">Souhlas s opravou do (Kč)<input type="text" inputmode="decimal" id="zk-max" value="${z.max_cena != null ? cislo2(z.max_cena) : ''}"></label>`}
        <label class="pole">Slíbený termín<input type="date" id="zk-termin" value="${esc(z.termin || '')}"></label>
        <label class="pole siroke">Interní poznámka (zákazník ji nevidí)<input type="text" id="zk-pozn" value="${esc(z.poznamka || '')}"></label></div></div></div>`,
    pata: `<button class="btn" data-zpet>Zrušit</button><button class="btn ok" data-ok style="min-width:170px">${nova ? (rekl ? 'Přijmout reklamaci' : 'Přijmout zakázku') : 'Uložit'}</button>`,
  });
  o.el.querySelector('.okno').style.maxWidth = '1100px';
  let prodejId = z.prodej_id || null; let odberatelId = z.odberatel_id || null;
  const hl = $('#zk-hledat', o.el); const hn = $('#zk-nasep', o.el); let ch;
  hl.oninput = () => { clearTimeout(ch); ch = setTimeout(async () => {
    const q = hl.value.trim(); if (q.length < 2) { hn.classList.add('skryt'); return; }
    const k = await api('GET', '/api/odberatele?q=' + encodeURIComponent(q)).catch(() => []);
    hn.innerHTML = k.map((x, i) => `<div class="pol" data-i="${i}"><span class="n">${esc(x.nazev)}<div class="mut2">${esc([x.telefon, x.email, x.mesto].filter(Boolean).join(' · '))}</div></span></div>`).join('') || '<div class="pol mut2">Nic nenalezeno</div>';
    hn.classList.remove('skryt');
    $$('.pol[data-i]', hn).forEach((d) => { d.onmousedown = (e) => { e.preventDefault(); const x = k[+d.dataset.i]; odberatelId = x.id; $('#zk-zakaznik', o.el).value = x.nazev; $('#zk-telefon', o.el).value = x.telefon || ''; $('#zk-email', o.el).value = x.email || ''; hl.value = ''; hn.classList.add('skryt'); }; });
  }, 200); };
  hl.onblur = () => setTimeout(() => hn.classList.add('skryt'), 150);
  const dohledat = $('#zk-dohledat', o.el);
  if (dohledat) dohledat.onclick = async () => {
    const q = $('#zk-sn-hledat', o.el).value.trim(); if (q.length < 3) return toast('Zadejte aspoň 3 znaky IMEI / SN', 'chyba');
    const r = await api('GET', '/api/serie?q=' + encodeURIComponent(q)).catch((e) => { chyba(e); return []; });
    if (!r.length) { $('#zk-nalez', o.el).innerHTML = '<span style="color:var(--varovani)">Prodej s tímto číslem v pokladně není – vyplňte doklad o koupi ručně.</span>'; return; }
    const x = r[0];
    prodejId = x.prodej_id; $('#zk-sn', o.el).value = x.sn; $('#zk-doklad', o.el).value = x.prodejka || x.faktura || ''; $('#zk-datumk', o.el).value = x.cas.slice(0, 10);
    if (!$('#zk-zarizeni', o.el).value.trim()) $('#zk-zarizeni', o.el).value = x.nazev || '';
    $('#zk-nalez', o.el).innerHTML = `Prodáno ${datumCz(x.cas)} (${esc(x.prodejka || x.faktura || '')})${x.stornovano ? ', <strong>prodej byl stornován</strong>' : ''} · záruka do ${datumCz(x.zaruka_do)} · ${x.v_zaruce ? '<span style="color:var(--ok);font-weight:700">v záruce</span>' : '<span style="color:var(--chyba);font-weight:700">po záruce</span>'}`;
  };
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = async (e) => {
    const v = (id) => { const el = $(id, o.el); return el ? el.value.trim() || null : null; };
    const d = { typ: z.typ, zakaznik: v('#zk-zakaznik'), telefon: v('#zk-telefon'), email: v('#zk-email'), zarizeni: v('#zk-zarizeni'), sn: v('#zk-sn'),
      heslo: v('#zk-heslo'), prislusenstvi: v('#zk-prisl'), vzhled: v('#zk-vzhled'), zavada: v('#zk-zavada'), pozadavek: v('#zk-pozadavek'),
      termin: v('#zk-termin'), poznamka: v('#zk-pozn'), prodej_id: prodejId, doklad_koupe: v('#zk-doklad'), datum_koupe: v('#zk-datumk'), odberatel_id: odberatelId,
      odhad: $('#zk-odhad', o.el) ? parseKc($('#zk-odhad', o.el).value) : null, max_cena: $('#zk-max', o.el) ? parseKc($('#zk-max', o.el).value) : null,
      dodavatel: z.dodavatel || null, dodavatel_rma: z.dodavatel_rma || null, vyjadreni: z.vyjadreni || null, technik_id: z.technik_id || null };
    if (!d.zakaznik) return toast('Vyplňte zákazníka', 'chyba');
    if (!d.telefon && !d.email) return toast('Vyplňte telefon nebo e-mail, ať můžete zákazníkovi dát vědět', 'chyba');
    if (!d.zarizeni) return toast('Vyplňte zařízení', 'chyba');
    if (!d.zavada) return toast(rekl ? 'Popište vadu' : 'Popište závadu', 'chyba');
    if (rekl && !d.prodej_id && !d.doklad_koupe && !d.datum_koupe) return toast('U reklamace vyplňte doklad o koupi nebo datum nákupu', 'chyba');
    if (Number.isNaN(d.odhad) || Number.isNaN(d.max_cena)) return toast('Neplatná částka', 'chyba');
    e.target.disabled = true;
    try {
      const r = await api(nova ? 'POST' : 'PUT', nova ? '/api/servis' : `/api/servis/${z.id}`, d);
      o.zavri(); toast(nova ? `${r.typ === 'REKLAMACE' ? 'Reklamace' : 'Zakázka'} ${r.cislo} přijata` : 'Uloženo', 'ok'); poUlozeni && poUlozeni();
      detailZakazky(r.id, poUlozeni);
      if (nova) tisk(htmlPrevzeti(r), true);
    } catch (er) { chyba(er); e.target.disabled = false; }
  };
}

async function detailZakazky(id, poZmene) {
  let z; try { z = await api('GET', '/api/servis/' + id); } catch (e) { return chyba(e); }
  const rekl = z.typ === 'REKLAMACE'; const uzavreno = ['VYDANO', 'ZRUSENO'].includes(z.stav);
  const dalsi = Object.keys(STAVY_S).filter((s) => !['VYDANO', z.stav].includes(s) && !(s === 'ZRUSENO' && z.zaloha));
  const o = okno({
    titul: `${rekl ? 'Reklamace' : 'Zakázka'} ${z.cislo}`, siroke: true,
    obsah: `<div class="radek mezera" style="margin-bottom:12px"><div>${stitekS(z)} ${z.vyrizeni_text ? `<span class="stitek ${z.vyrizeni === 'ZAMITNUTO' ? 'chyba' : 'ok'}">${esc(z.vyrizeni_text)}</span>` : ''}
        <span class="mut2">· přijato ${datumCas(z.prijato)}${z.prijal ? ' (' + esc(z.prijal) + ')' : ''}</span>${rekl && !z.vyrizeno && !uzavreno ? ` · lhůta ${lhutaText(z)}` : ''}
        ${rekl && z.doba_vyrizeni_dni != null && z.vyrizeno ? `<span class="mut2"> · vyřízeno za ${tvar(z.doba_vyrizeni_dni, 'den', 'dny', 'dní')}</span>` : ''}</div>
      ${uzavreno ? '' : `<div class="radek"><select id="zd-stav" style="width:230px"><option value="">Změnit stav…</option>${dalsi.map((s) => `<option value="${s}">${STAVY_S[s][1]}</option>`).join('')}</select></div>`}</div>
      <div class="fv-sloupce">
        <div class="fv-blok"><h3>Zákazník</h3><strong>${esc(z.zakaznik)}</strong><div>${esc(z.telefon || '')}${z.telefon && z.email ? ' · ' : ''}${esc(z.email || '')}</div>
          <h3 style="margin-top:14px">Zařízení</h3><strong>${esc(z.zarizeni)}</strong>${z.sn ? `<div class="mono">${esc(z.sn)}</div>` : ''}
          <div class="mut2" style="margin-top:4px">${[z.prislusenstvi && 'Příslušenství: ' + esc(z.prislusenstvi), z.vzhled && 'Stav: ' + esc(z.vzhled), z.heslo && 'Kód odemčení: <span class="mono">' + esc(z.heslo) + '</span>'].filter(Boolean).join('<br>')}</div>
          ${rekl ? `<h3 style="margin-top:14px">Nákup</h3><div>${esc(z.prodejka_koupe || z.doklad_koupe || '—')}${z.datum_koupe || z.cas_koupe ? ` ze dne ${datumCz(z.datum_koupe || z.cas_koupe)}` : ''}</div><div class="mut2">Požadavek zákazníka: ${esc(z.pozadavek || '—')}</div>` : ''}
          ${z.dodavatel ? `<h3 style="margin-top:14px">Servis dodavatele</h3><div>${esc(z.dodavatel)}${z.dodavatel_rma ? ` · RMA <span class="mono">${esc(z.dodavatel_rma)}</span>` : ''}</div>
            <div class="mut2">${z.odeslano_dodavateli ? 'odesláno ' + datumCz(z.odeslano_dodavateli) : ''}${z.vraceno_od_dodavatele ? ' · vráceno ' + datumCz(z.vraceno_od_dodavatele) : ''}</div>` : ''}</div>
        <div class="fv-blok"><h3>${rekl ? 'Vada' : 'Závada'}</h3><div style="white-space:pre-wrap">${esc(z.zavada)}</div>
          ${!rekl && (z.odhad != null || z.max_cena != null) ? `<div class="mut2" style="margin-top:6px">${z.odhad != null ? 'Předběžně ' + kc(z.odhad) : ''}${z.max_cena != null ? ` · souhlas do ${kc(z.max_cena)}` : ''}</div>` : ''}
          ${z.termin ? `<div class="mut2">Slíbený termín ${datumCz(z.termin)}</div>` : ''}
          ${z.vyjadreni ? `<h3 style="margin-top:14px">Výsledek</h3><div style="white-space:pre-wrap">${esc(z.vyjadreni)}</div>` : ''}
          ${z.poznamka ? `<div class="upozorneni" style="margin-top:10px">Interní: ${esc(z.poznamka)}</div>` : ''}</div></div>
      <div class="fv-blok" style="margin-top:14px"><h3>Práce a díly</h3>
        <table class="tab"><thead><tr><th>Položka</th><th class="num">Množství</th><th class="num">Cena</th><th class="num">Celkem</th><th style="width:40px"></th></tr></thead><tbody>
          ${z.polozky.map((p) => `<tr><td>${esc(p.nazev)}${p.zbozi_id ? '<div class="mut2">ze skladu</div>' : ''}</td><td class="num">${mn(p.mnozstvi)}</td><td class="num">${kc(p.cena)}</td><td class="num">${kc(p.celkem)}</td>
            <td>${uzavreno ? '' : `<button class="btn ikona nebezp" data-smaz="${p.id}">×</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="prazdno">Zatím nic</td></tr>'}</tbody></table>
        ${uzavreno ? '' : `<div class="radek" style="margin-top:10px"><div class="sken-box vypln"><input type="text" id="zd-dil" placeholder="Díl ze skladu – čtečka nebo název…" autocomplete="off"><div class="naseptavac skryt" id="zd-dnasep"></div></div>
          <button class="btn" id="zd-prace">+ Práce / vlastní položka</button></div>`}
        <div class="radek mezera" style="margin-top:10px;justify-content:flex-end;gap:24px"><span>Celkem <strong>${kc(z.celkem)}</strong></span>${z.zaloha ? `<span>Záloha <strong>${kc(z.zaloha)}</strong></span><span>Doplatit <strong>${kc(z.doplatit)}</strong></span>` : ''}</div></div>
      <div class="fv-blok" style="margin-top:14px"><h3>Historie</h3>
        ${uzavreno ? '' : '<div class="radek" style="margin-bottom:8px"><input type="text" id="zd-pozn" class="vypln" placeholder="Poznámka do historie (volal zákazník, objednán díl…)"><button class="btn" id="zd-pridat">Přidat</button></div>'}
        <div style="max-height:220px;overflow:auto">${z.historie.map((h) => `<div class="radek" style="gap:10px;padding:5px 0;border-bottom:1px solid var(--linka);flex-wrap:nowrap"><span class="mut2" style="white-space:nowrap">${datumCas(h.cas)}</span><span class="vypln">${esc(h.text || '')}</span><span class="mut2">${esc(h.uzivatel || '')}</span></div>`).join('')}</div></div>`,
    pata: `${uzavreno ? '' : `<button class="btn" data-upravit>Upravit</button>${!rekl ? '<button class="btn" data-zaloha>Záloha</button>' : ''}`}
      <span class="vypln"></span>
      <button class="btn" data-tisk-prevzeti>${rekl ? 'Reklamační protokol' : 'Převzetí'}</button>
      ${z.stav === 'HOTOVO' || uzavreno ? '<button class="btn" data-tisk-vyrizeni>Protokol o vyřízení</button>' : ''}
      <button class="btn" data-stitek title="Štítek na zařízení s číslem zakázky">Štítek</button>
      ${z.email && !uzavreno ? `<button class="btn" data-mail>${z.stav === 'HOTOVO' ? 'E-mail: připraveno' : 'E-mail'}</button>` : ''}
      ${z.stav === 'HOTOVO' ? '<button class="btn ok" data-vydat>Vydat zákazníkovi</button>' : ''}<button class="btn hl" data-zavrit>Zavřít</button>`,
  });
  o.el.querySelector('.okno').style.maxWidth = '1100px';
  const znovu = () => { o.zavri(); poZmene && poZmene(); detailZakazky(id, poZmene); };
  const klik = (sel, fn) => { const b = $(sel, o.el); if (b) b.onclick = fn; };
  klik('[data-zavrit]', () => o.zavri());
  klik('[data-upravit]', () => { o.zavri(); formularZakazky(z, poZmene); });
  klik('[data-tisk-prevzeti]', () => tisk(htmlPrevzeti(z), true));
  klik('[data-tisk-vyrizeni]', () => tisk(htmlVyrizeni(z), true));
  klik('[data-stitek]', () => tiskStitku([{ zakazka: z, pocet: 1 }], S.firma.stitek_format || '50x30'));
  klik('[data-zaloha]', () => zalohaZakazky(z, znovu));
  klik('[data-vydat]', () => vydatZakazku(z, znovu));
  klik('[data-mail]', () => emailZakazky(z, znovu));
  klik('#zd-pridat', async () => { const t = $('#zd-pozn', o.el).value.trim(); if (!t) return; try { await api('POST', `/api/servis/${id}/poznamka`, { text: t }); znovu(); } catch (e) { chyba(e); } });
  const pozn = $('#zd-pozn', o.el); if (pozn) pozn.onkeydown = (e) => { if (e.key === 'Enter') $('#zd-pridat', o.el).click(); };
  $$('[data-smaz]', o.el).forEach((b) => { b.onclick = async () => { try { await api('DELETE', `/api/servis/${id}/polozky/${b.dataset.smaz}`); znovu(); } catch (e) { chyba(e); } }; });
  klik('#zd-prace', () => {
    const m = okno({
      titul: 'Práce nebo díl mimo katalog',
      obsah: `<div class="mrizka"><label class="pole siroke">Název<input type="text" id="zp-n" placeholder="např. Výměna displeje – práce" autofocus></label>
        <label class="pole">Cena s DPH (Kč)<input type="text" inputmode="decimal" id="zp-c"></label><label class="pole">Množství<input type="text" inputmode="decimal" id="zp-q" value="1"></label>
        <label class="pole">Sazba DPH<select id="zp-d"><option>21</option><option>12</option><option>0</option></select></label></div>`,
      pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Přidat</button>',
    });
    $('[data-zpet]', m.el).onclick = () => m.zavri();
    $('[data-ok]', m.el).onclick = async () => {
      const cena = parseKc($('#zp-c', m.el).value); const q = parseMn($('#zp-q', m.el).value);
      if (!$('#zp-n', m.el).value.trim() || !Number.isFinite(cena) || cena == null || !(q > 0)) return toast('Vyplňte název, cenu a množství', 'chyba');
      try { await api('POST', `/api/servis/${id}/polozky`, { nazev: $('#zp-n', m.el).value.trim(), cena, mnozstvi: q, sazba_dph: +$('#zp-d', m.el).value }); m.zavri(); znovu(); } catch (e) { chyba(e); }
    };
  });
  const di = $('#zd-dil', o.el);
  if (di) {
    const dn = $('#zd-dnasep', o.el); let nalez = []; let dc;
    const pridej = async (zb, q = 1) => { try { await api('POST', `/api/servis/${id}/polozky`, { zbozi_id: zb.id, mnozstvi: q }); znovu(); } catch (e) { chyba(e); } };
    di.oninput = () => { clearTimeout(dc); const { text } = rozeberSken(di.value); if (text.length < 2 || /^\d{8,}$/.test(text)) { dn.classList.add('skryt'); return; }
      dc = setTimeout(async () => { nalez = await api('GET', '/api/zbozi?limit=12&q=' + encodeURIComponent(text)).catch(() => []);
        dn.innerHTML = nalez.map((x, i) => `<div class="pol" data-i="${i}"><span class="n">${esc(x.nazev)}<div class="mut2">skladem ${mn(x.stav)}</div></span><strong>${kc(x.cena)}</strong></div>`).join('');
        dn.classList.toggle('skryt', !nalez.length);
        $$('.pol', dn).forEach((d) => { d.onmousedown = (e) => { e.preventDefault(); pridej(nalez[+d.dataset.i]); }; });
      }, 180); };
    di.onkeydown = async (e) => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const { text, mnozstvi } = rozeberSken(di.value); if (!text) return;
      try { pridej(await api('GET', '/api/zbozi/kod/' + encodeURIComponent(text)), mnozstvi); } catch { if (nalez.length === 1) pridej(nalez[0], mnozstvi); else toast('Díl nenalezen – vyberte z nabídky nebo přidejte vlastní položku'); }
    };
    di.onblur = () => setTimeout(() => dn.classList.add('skryt'), 150);
  }
  const vs = $('#zd-stav', o.el);
  if (vs) vs.onchange = () => { const s = vs.value; vs.value = ''; if (s) zmenStavZakazky(z, s, znovu); };
}

function zmenStavZakazky(z, stav, poZmene) {
  const potrebuje = stav === 'U_DODAVATELE' || stav === 'HOTOVO' || stav === 'ZRUSENO';
  const ulozit = async (data) => {
    try { await api('POST', `/api/servis/${z.id}/stav`, { stav, ...data }); toast(STAVY_S[stav][1], 'ok'); poZmene(); } catch (e) { chyba(e); }
  };
  if (!potrebuje) return ulozit({});
  const o = okno({
    titul: STAVY_S[stav][1],
    obsah: stav === 'U_DODAVATELE' ? `<div class="mrizka"><label class="pole siroke">Komu se zařízení posílá<input type="text" id="zs-dod" value="${esc(z.dodavatel || '')}" placeholder="dodavatel, výrobce, autorizovaný servis" autofocus></label>
        <label class="pole siroke">Číslo reklamace u dodavatele (RMA)<input type="text" id="zs-rma" value="${esc(z.dodavatel_rma || '')}"></label>
        <label class="pole siroke">Poznámka<input type="text" id="zs-text" placeholder="např. odesláno PPL"></label></div>`
      : stav === 'HOTOVO' ? `<div class="mrizka"><label class="pole siroke">${z.typ === 'REKLAMACE' ? 'Jak byla reklamace vyřízena' : 'Výsledek opravy'}<select id="zs-vyr">${VYRIZENI_S[z.typ].map(([k, t]) => `<option value="${k}" ${k === z.vyrizeni ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="pole siroke">${z.typ === 'REKLAMACE' ? 'Vyjádření pro zákazníka (u zamítnutí důvod)' : 'Co se udělalo'}<textarea id="zs-vyj" style="min-height:90px">${esc(z.vyjadreni || '')}</textarea></label></div>
        ${z.typ === 'REKLAMACE' ? '<p class="mut2">Datum vyřízení se zapíše dnes. Zamítnutí reklamace musí mít písemné odůvodnění.</p>' : ''}`
        : '<label class="pole">Proč se zakázka ruší<input type="text" id="zs-text" autofocus></label>',
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Uložit</button>',
  });
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = () => {
    const v = (s) => { const el = $(s, o.el); return el ? el.value.trim() : ''; };
    if (stav === 'HOTOVO' && v('#zs-vyr') === 'ZAMITNUTO' && !v('#zs-vyj')) return toast('Napište důvod zamítnutí', 'chyba');
    o.zavri();
    ulozit({ dodavatel: v('#zs-dod') || null, dodavatel_rma: v('#zs-rma') || null, text: v('#zs-text') || null,
      vyrizeni: v('#zs-vyr') || null, vyjadreni: stav === 'HOTOVO' ? v('#zs-vyj') : undefined });
  };
}

function zalohaZakazky(z, poZmene) {
  const o = okno({
    titul: `Záloha na ${z.cislo}`,
    obsah: `<p class="mut" style="margin-top:0">Záloha se zaplatí na pokladně jako prodejka (s EET) a při výdeji se od ceny odečte.</p>
      <label class="pole">Částka (Kč)<input type="text" inputmode="decimal" id="za-c" value="${z.odhad ? cislo2(Math.round(z.odhad / 2 / 100) * 100) : ''}" autofocus style="font-size:20px"></label>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn" data-k>Kartou</button><button class="btn hl" data-h>Hotově</button>',
  });
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  const zaplat = async (platba) => {
    const castka = parseKc($('#za-c', o.el).value);
    if (!(castka > 0)) return toast('Zadejte částku', 'chyba');
    try {
      const r = await api('POST', `/api/servis/${z.id}/zaloha`, { castka, platba });
      o.zavri(); toast(`Záloha ${kc(castka)} zaplacena (${r.prodej.cislo})`, 'ok'); obnovEet(); poZmene();
      tiskUctenky(r.prodej);
    } catch (e) { chyba(e); }
  };
  $('[data-h]', o.el).onclick = () => zaplat('HOTOVE');
  $('[data-k]', o.el).onclick = () => zaplat('KARTA');
}

function vydatZakazku(z, poZmene) {
  const zdarma = z.doplatit <= 0 && !z.zaloha;
  const o = okno({
    titul: `Vydat ${z.cislo}`,
    obsah: `<div style="text-align:center"><div class="mut">${z.doplatit < 0 ? 'Vrátit zákazníkovi (záloha byla vyšší)' : 'K úhradě'}</div><div class="velke-cislo">${kc(Math.abs(z.doplatit))}</div>
      ${z.zaloha ? `<div class="mut2">celkem ${kc(z.celkem)} − záloha ${kc(z.zaloha)}</div>` : ''}</div>
      <p class="mut2" style="margin-top:14px">${zdarma ? 'Bez platby (záruční oprava, reklamace): díly ze skladu se odepíšou výdejkou.' : 'Při platbě vznikne prodejka s EET, díly se odepíšou ze skladu.'}</p>
      ${!zdarma ? '<label class="pole">Přijato hotově (Kč, nepovinné)<input type="text" inputmode="decimal" id="vz-prijato"></label>' : ''}`,
    pata: `<button class="btn" data-zpet>Zpět</button>${zdarma ? '<button class="btn hl" data-p="ZDARMA">Vydat bez platby</button>'
      : `<button class="btn" data-p="FAKTURA">Na fakturu</button><button class="btn" data-p="KARTA">Kartou</button><button class="btn hl" data-p="HOTOVE">Hotově</button>`}`,
  });
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $$('[data-p]', o.el).forEach((b) => {
    b.onclick = async () => {
      const platba = b.dataset.p;
      if (platba === 'FAKTURA') {
        o.zavri();
        return formularFaktury({ odberatel: { nazev: z.zakaznik, email: z.email }, polozky: z.polozky.map((p) => ({ zbozi_id: p.zbozi_id, nazev: p.nazev, mnozstvi: p.mnozstvi, cena: p.cena, sazba_dph: p.sazba_dph })),
          poVystaveni: async (f) => { try { await api('POST', `/api/servis/${z.id}/vydat`, { platba: 'FAKTURA', faktura_id: f.id }); toast(`${z.cislo} vydáno na fakturu ${f.cislo}`, 'ok'); poZmene(); } catch (e) { chyba(e); } } });
      }
      const prijato = $('#vz-prijato', o.el) && $('#vz-prijato', o.el).value.trim() ? parseKc($('#vz-prijato', o.el).value) : undefined;
      try {
        const r = await api('POST', `/api/servis/${z.id}/vydat`, { platba, prijato });
        o.zavri(); toast(`${z.cislo} vydáno`, 'ok'); obnovEet(); poZmene();
        tisk(htmlVyrizeni(r.zakazka), true);
        if (r.prodej) setTimeout(() => hotovo(r.prodej), 300);
      } catch (e) { chyba(e); }
    };
  });
}

function emailZakazky(z, poZmene) {
  if (window.POKLADNA_DEMO) return toast('V demu se e-maily neodesílají – ve skutečné pokladně dostane zákazník zprávu.');
  const druh = z.stav === 'HOTOVO' ? 'pripraveno' : 'prijato';
  const o = okno({
    titul: `E-mail zákazníkovi – ${z.cislo}`,
    obsah: `<label class="pole">Komu<input type="email" id="ze-komu" value="${esc(z.email || '')}"></label>
      <label class="pole" style="margin-top:10px">Zpráva<select id="ze-druh"><option value="pripraveno" ${druh === 'pripraveno' ? 'selected' : ''}>Připraveno k vyzvednutí</option><option value="prijato" ${druh === 'prijato' ? 'selected' : ''}>Potvrzení přijetí</option><option value="vlastni">Vlastní text</option></select></label>
      <label class="pole" style="margin-top:10px">Vlastní text (prázdné = předvyplněná zpráva)<textarea id="ze-text" style="min-height:100px"></textarea></label>`,
    pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Odeslat</button>',
  });
  $('[data-zpet]', o.el).onclick = () => o.zavri();
  $('[data-ok]', o.el).onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await api('POST', `/api/servis/${z.id}/email`, { druh: $('#ze-druh', o.el).value, zprava: $('#ze-text', o.el).value.trim() || null, komu: $('#ze-komu', o.el).value.trim() || null });
      o.zavri(); toast(`Odesláno na ${r.komu.join(', ')}`, 'ok'); poZmene(); } catch (er) { chyba(er); e.target.disabled = false; }
  };
}

/* ------------------------------------------------------------------------ protokoly */

function hlavickaDokladu(nadpis, cislo) {
  const f = S.firma;
  return `<div class="radek mezera" style="align-items:flex-start"><div><img src="static/img/logo.png" alt="" style="height:34px"><div style="margin-top:4px"><strong>${esc(f.firma_nazev || '')}</strong><br>${esc(f.provozovna || f.firma_adresa || '')}${f.telefon ? ` · tel. ${esc(f.telefon)}` : ''}${f.firma_ico ? `<br>IČO ${esc(f.firma_ico)}` : ''}</div></div>
    <div style="text-align:right"><strong style="font-size:17px">${nadpis}</strong><br><span style="font-size:15px">č. ${esc(cislo)}</span><div style="margin-top:4px">${code128Svg(cislo, 34)}</div></div></div>`;
}

function htmlPrevzeti(z) {
  const rekl = z.typ === 'REKLAMACE';
  return `<div class="papir-doklad">${hlavickaDokladu(rekl ? 'POTVRZENÍ O UPLATNĚNÍ REKLAMACE' : 'PŘEVZETÍ ZAŘÍZENÍ DO SERVISU', z.cislo)}
    <table class="tab" style="margin-top:12px"><tbody>
      <tr><td style="width:30%">${rekl ? 'Reklamace uplatněna' : 'Převzato'}</td><td><strong>${datumCas(z.prijato)}</strong></td></tr>
      <tr><td>Zákazník</td><td><strong>${esc(z.zakaznik)}</strong> ${esc([z.telefon, z.email].filter(Boolean).join(' · '))}</td></tr>
      <tr><td>Zařízení</td><td><strong>${esc(z.zarizeni)}</strong>${z.sn ? ` · IMEI / SN <span class="mono">${esc(z.sn)}</span>` : ''}</td></tr>
      ${rekl ? `<tr><td>Doklad o koupi</td><td>${esc(z.prodejka_koupe || z.doklad_koupe || '')}${z.datum_koupe || z.cas_koupe ? ` ze dne ${datumCz(z.datum_koupe || z.cas_koupe)}` : ''}</td></tr>` : ''}
      <tr><td>Příslušenství</td><td>${esc(z.prislusenstvi || 'bez příslušenství')}</td></tr>
      <tr><td>Stav při převzetí</td><td>${esc(z.vzhled || '—')}</td></tr>
      <tr><td>${rekl ? 'Popis vady' : 'Závada / požadavek'}</td><td style="white-space:pre-wrap">${esc(z.zavada)}</td></tr>
      ${rekl ? `<tr><td>Požadované vyřízení</td><td>${esc(z.pozadavek || '')}</td></tr><tr><td>Vyřídíme nejpozději do</td><td><strong>${datumCz(z.lhuta)}</strong></td></tr>`
    : `${z.odhad != null ? `<tr><td>Předběžná cena</td><td>${kc(z.odhad)}</td></tr>` : ''}${z.max_cena != null ? `<tr><td>Souhlas s opravou do</td><td>${kc(z.max_cena)}</td></tr>` : ''}
      ${z.termin ? `<tr><td>Předpokládaný termín</td><td>${datumCz(z.termin)}</td></tr>` : ''}${z.zaloha ? `<tr><td>Zaplacená záloha</td><td>${kc(z.zaloha)}</td></tr>` : ''}`}</tbody></table>
    <div class="podminky">${rekl ? 'Reklamaci vyřídíme bez zbytečného odkladu, nejpozději do 30 dnů ode dne uplatnění, pokud se nedohodneme na delší lhůtě. O vyřízení vás budeme informovat a vydáme potvrzení o datu a způsobu vyřízení.'
    : esc(S.firma.servis_podminky || '')}</div>
    <div class="podpisy"><div>Převzal za prodejnu: ${esc(z.prijal || '')}<br><br>……………………………</div><div>Zákazník:<br><br>……………………………</div></div>
    <p class="mut2" style="margin-top:20px">Při vyzvednutí předložte tento doklad. Stav zakázky ověříte na telefonu prodejny${S.firma.telefon ? ' ' + esc(S.firma.telefon) : ''}.</p></div>`;
}

function htmlVyrizeni(z) {
  const rekl = z.typ === 'REKLAMACE';
  return `<div class="papir-doklad">${hlavickaDokladu(rekl ? 'POTVRZENÍ O VYŘÍZENÍ REKLAMACE' : 'PROTOKOL O PROVEDENÍ OPRAVY', z.cislo)}
    <table class="tab" style="margin-top:12px"><tbody>
      <tr><td style="width:30%">${rekl ? 'Reklamace uplatněna' : 'Převzato do servisu'}</td><td>${datumCas(z.prijato)}</td></tr>
      <tr><td>${rekl ? 'Reklamace vyřízena' : 'Oprava dokončena'}</td><td><strong>${datumCas(z.vyrizeno || z.vydano || new Date().toISOString())}</strong>${rekl && z.doba_vyrizeni_dni != null ? ` (za ${tvar(z.doba_vyrizeni_dni, 'den', 'dny', 'dní')})` : ''}</td></tr>
      ${z.vydano ? `<tr><td>Vydáno zákazníkovi</td><td>${datumCas(z.vydano)}${z.vydal ? ' (' + esc(z.vydal) + ')' : ''}</td></tr>` : ''}
      <tr><td>Zákazník</td><td><strong>${esc(z.zakaznik)}</strong></td></tr>
      <tr><td>Zařízení</td><td><strong>${esc(z.zarizeni)}</strong>${z.sn ? ` · IMEI / SN <span class="mono">${esc(z.sn)}</span>` : ''}</td></tr>
      <tr><td>${rekl ? 'Popis vady' : 'Závada'}</td><td style="white-space:pre-wrap">${esc(z.zavada)}</td></tr>
      <tr><td>${rekl ? 'Způsob vyřízení' : 'Výsledek'}</td><td><strong>${esc(z.vyrizeni_text || '')}</strong></td></tr>
      ${z.vyjadreni ? `<tr><td>${z.vyrizeni === 'ZAMITNUTO' ? 'Odůvodnění zamítnutí' : 'Provedené práce'}</td><td style="white-space:pre-wrap">${esc(z.vyjadreni)}</td></tr>` : ''}
      ${z.dodavatel ? `<tr><td>Servis dodavatele</td><td>${esc(z.dodavatel)}${z.dodavatel_rma ? ', RMA ' + esc(z.dodavatel_rma) : ''}</td></tr>` : ''}</tbody></table>
    ${z.polozky.length ? `<h3>Práce a díly</h3><table class="tab"><thead><tr><th>Položka</th><th class="num">Množství</th><th class="num">Cena</th><th class="num">Celkem</th></tr></thead><tbody>
      ${z.polozky.map((p) => `<tr><td>${esc(p.nazev)}</td><td class="num">${mn(p.mnozstvi)}</td><td class="num">${kc(p.cena)}</td><td class="num">${kc(p.celkem)}</td></tr>`).join('')}
      <tr><td colspan="3">Celkem</td><td class="num"><strong>${kc(z.celkem)}</strong></td></tr>${z.zaloha ? `<tr><td colspan="3">Záloha</td><td class="num">${kc(-z.zaloha)}</td></tr><tr><td colspan="3"><strong>Doplaceno</strong></td><td class="num"><strong>${kc(z.doplatit)}</strong></td></tr>` : ''}</tbody></table>
      ${z.prodejka_vydani ? `<p class="mut2">Zaplaceno prodejkou ${esc(z.prodejka_vydani)}.</p>` : z.faktura ? `<p class="mut2">Vyúčtováno fakturou ${esc(z.faktura)}.</p>` : ''}` : ''}
    ${rekl && z.vyrizeni !== 'ZAMITNUTO' ? '<p class="podminky">Záruční doba se prodlužuje o dobu od uplatnění reklamace do jejího vyřízení.</p>' : ''}
    <div class="podpisy"><div>Za prodejnu:<br><br>……………………………</div><div>Zařízení převzal zákazník:<br><br>……………………………</div></div></div>`;
}

/* ------------------------------------------------------------------------ sériová čísla a záruční list */

// Dialog pro načtení SN / IMEI každého kusu (čtečkou, Enter = další). Vrací pole čísel nebo null.
function nactiSerie(z, pocet) {
  return new Promise((hotovo_) => {
    let vysledek = null;
    const o = okno({
      titul: `Sériová čísla – ${z.nazev}`,
      obsah: `<p class="mut" style="margin-top:0">Načtěte čtečkou IMEI nebo sériové číslo ${pocet > 1 ? `každého z ${pocet} kusů` : 'prodávaného kusu'}. Najdete ho na krabici nebo štítku.</p>
        ${Array.from({ length: pocet }, (_, i) => `<label class="pole" style="margin-bottom:8px">${pocet > 1 ? `${i + 1}. kus` : 'IMEI / SN'}<input type="text" data-sn="${i}" autocomplete="off" spellcheck="false" ${i === 0 ? 'autofocus' : ''}></label>`).join('')}`,
      pata: '<button class="btn" data-zpet>Zpět</button><button class="btn hl" data-ok>Přidat do košíku</button>',
      poZavreni: () => hotovo_(vysledek),
    });
    const pole = $$('[data-sn]', o.el);
    const ok = () => {
      const sn = pole.map((p) => opravKlavesnici(p.value.trim()).replace(/\s/g, ''));
      if (sn.some((x) => x.length < 4)) return toast('Načtěte všechna sériová čísla', 'chyba');
      if (new Set(sn).size !== sn.length) return toast('Stejné číslo je tam dvakrát', 'chyba');
      vysledek = sn; o.zavri();
    };
    pole.forEach((p, i) => { p.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (pole[i + 1]) pole[i + 1].focus(); else ok(); } }; });
    $('[data-zpet]', o.el).onclick = () => o.zavri();
    $('[data-ok]', o.el).onclick = ok;
  });
}

function htmlZarucnihoListu(p) {
  const f = S.firma;
  const polozky = p.polozky.filter((i) => i.zbozi_id && i.mnozstvi > 0 && (i.zaruka_mesice || p.serie.some((s) => s.zbozi_id === i.zbozi_id)));
  const plusMesice = (iso, m) => { const d = new Date(iso.slice(0, 10) + 'T12:00:00'); const den = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + m); d.setDate(Math.min(den, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return d.toISOString().slice(0, 10); };
  return `<div class="papir-doklad">${hlavickaDokladu('ZÁRUČNÍ LIST', p.cislo)}
    <table class="tab" style="margin-top:12px"><tbody><tr><td style="width:30%">Datum prodeje</td><td><strong>${datumCas(p.cas)}</strong></td></tr>
      <tr><td>Doklad o koupi</td><td>prodejka ${esc(p.cislo)}${p.faktura ? `, faktura ${esc(p.faktura.cislo)}` : ''}</td></tr><tr><td>Prodal</td><td>${esc(p.prodavac || '')}</td></tr></tbody></table>
    <h3>Zboží</h3><table class="tab"><thead><tr><th>Zboží</th><th>IMEI / sériové číslo</th><th class="num">Záruka</th><th>Záruka do</th></tr></thead><tbody>
      ${polozky.map((i) => { const sn = p.serie.filter((s) => s.zbozi_id === i.zbozi_id); const m = i.zaruka_mesice || 0;
    return `<tr><td>${esc(i.nazev)}${i.mnozstvi > 1 ? ` (${mn(i.mnozstvi)} ks)` : ''}</td><td class="mono">${sn.map((s) => esc(s.sn)).join('<br>') || '—'}</td><td class="num">${m ? m + ' měs.' : '—'}</td><td>${m ? datumCz((sn[0] && sn[0].zaruka_do) || plusMesice(p.cas, m)) : ''}</td></tr>`; }).join('')
      || '<tr><td colspan="4" class="mut">Na prodejce není zboží se zárukou.</td></tr>'}</tbody></table>
    <div class="podminky">${esc(f.zarucni_podminky || '')}
Spotřebitel má právo uplatnit vadu, která se vyskytne u spotřebního zboží v době 24 měsíců od převzetí (§ 2165 občanského zákoníku).</div>
    <div class="podpisy"><div>Razítko a podpis prodejce:<br><br>……………………………</div></div></div>`;
}
