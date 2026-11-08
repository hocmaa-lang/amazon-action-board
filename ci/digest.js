// Daily open-task status mail for the Amazon Action Board.
//
//   node ci/digest.js            -> builds + sends (only at 07:00 Israel unless FORCE=1)
//   DRY=1 node ci/digest.js      -> builds, writes ci/out.html, sends nothing
//
// Env: DATAKEY (base64 AES key = _secrets/datakey.b64), MAIL_URL, MAIL_KEY,
//      GH_TOKEN (read access to this repo), SCHED (the cron line that fired), FORCE, DRY.
// Reads: index.html on main (sealed app -> PRODUCTS) and state.json on the "data" branch.
// Never writes to the board.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'hocmaa-lang/amazon-action-board';
const BOARD = 'https://hocmaa-lang.github.io/amazon-action-board/';
const TO = (process.env.TO || 'erika,milet,ariel,dvir').split(',');
const NAMES = { erika: 'Erika', milet: 'Milet', ariel: 'Ariel', dvir: 'Dvir' };
const TZ = 'Asia/Jerusalem';

function israelParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour };
}
function israelOffsetHours(d) {
  const p = israelParts(d);
  let off = p.hour - d.getUTCHours();
  if (off < -12) off += 24; if (off > 12) off -= 24;
  return off;
}

function gcmOpen(key, iv, ct) {
  const buf = Buffer.from(ct, 'base64');
  const tag = buf.subarray(buf.length - 16), body = buf.subarray(0, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

async function gh(p) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${p}`, {
    headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${p}: ${r.status}`);
  return r.json();
}

function sliceArray(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('marker not found: ' + marker);
  let d = 0, j = i + marker.length - 1;
  for (; j < src.length; j++) { if (src[j] === '[') d++; if (src[j] === ']') { d--; if (!d) break; } }
  return JSON.parse(src.slice(i + marker.length - 1, j + 1));
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const letter = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const days = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);
const fmt = iso => { const [y, m, d] = iso.split('-'); return `${+d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]}`; };

(async () => {
  const now = new Date();
  const il = israelParts(now);
  if (!process.env.FORCE && !process.env.DRY) {
    // Two crons fire (04:00 and 05:00 UTC); only the one that is 07:00 in Israel sends.
    // Uses the scheduled hour, not the clock, so a late-starting run still counts.
    const schedHour = +(String(process.env.SCHED || '').split(' ')[1]);
    const want = (7 - israelOffsetHours(now) + 24) % 24;
    if (schedHour !== want) { console.log(`skip: cron hour ${schedHour} UTC, 07:00 Israel is ${want} UTC today`); return; }
  }

  const key = Buffer.from(process.env.DATAKEY.trim(), 'base64');
  const index = Buffer.from((await gh('contents/index.html?ref=main')).content, 'base64').toString('utf8');
  const m = index.match(/const APP=(\{[^\n]*?\});/);
  if (!m) throw new Error('APP blob not found in index.html');
  const APP = JSON.parse(m[1]);
  const products = sliceArray(gcmOpen(key, APP.iv, APP.ct), 'const PRODUCTS = [');

  const so = JSON.parse(Buffer.from((await gh('contents/state.json?ref=data&t=' + Date.now())).content, 'base64').toString('utf8'));
  const state = JSON.parse(gcmOpen(key, so.iv, so.ct)).tasks || {};

  const today = il.date;
  const open = [], doneRecent = [];
  products.forEach((p, pi) => p.phases.forEach((ph, phi) => ph.tasks.forEach((t, ti) => {
    const s = state[t.id] || {};
    const row = { prod: `${letter(pi)} · ${p.name}`, pid: p.id, num: `${phi + 1}.${ti + 1}`, title: t.title, due: t.due || '' };
    if (s.done) { if (s.at && now - Date.parse(s.at) < 864e5) doneRecent.push(row); return; }
    const who = new Set();
    const a = state['asg:' + t.id];
    if (a && a.names) for (const [k, v] of Object.entries(a.names)) if (v && v.on && NAMES[k]) who.add(k);
    if (/\(Ariel\)/i.test(t.title)) who.add('ariel');
    if (t.owner) who.add('dvir');
    row.who = [...who];
    row.owner = !!t.owner;
    row.d = row.due ? days(row.due, today) : null;
    open.push(row);
  })));

  const status = r => r.d == null ? ['No date', '#666', '#fff']
    : r.d < 0 ? [`Late ${-r.d} day${r.d === -1 ? '' : 's'}`, '#fff', '#c0392b']
    : r.d === 0 ? ['Due today', '#000', '#f4c542']
    : [`In ${r.d} day${r.d === 1 ? '' : 's'}`, '#1a1a1a', '#e8f0ec'];
  const byDue = (a, b) => (a.d ?? 9999) - (b.d ?? 9999) || a.prod.localeCompare(b.prod) || a.num.localeCompare(b.num, undefined, { numeric: true });

  const TD = 'padding:6px 8px;border:1px solid #ddd;vertical-align:top';
  const TH = TD + ';background:#f0f2f1;text-align:left';
  const people = TO.map(k => {
    const rows = open.filter(r => r.who.includes(k)).sort(byDue);
    return { k, rows, late: rows.filter(r => r.d != null && r.d < 0).length, todayN: rows.filter(r => r.d === 0).length,
             week: rows.filter(r => r.d != null && r.d > 0 && r.d <= 7).length };
  });
  const unassigned = open.filter(r => !r.who.length);
  const lateAll = open.filter(r => r.who.length && r.d != null && r.d < 0).length;

  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a;max-width:900px">`;
  html += `<p>Good morning,</p><p>This is today's status of the open tasks on the Amazon Action Board (${esc(fmt(today))} ${today.slice(0, 4)}, 07:00 Israel time).</p>`;
  html += `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 18px"><tr>
    <th style="${TH}">Person</th><th style="${TH}">Open</th><th style="${TH}">Late</th><th style="${TH}">Due today</th><th style="${TH}">Next 7 days</th></tr>`;
  for (const p of people) html += `<tr><td style="${TD}"><b>${NAMES[p.k]}</b></td><td style="${TD}">${p.rows.length}</td>
    <td style="${TD};${p.late ? 'color:#c0392b;font-weight:bold' : ''}">${p.late}</td><td style="${TD}">${p.todayN}</td><td style="${TD}">${p.week}</td></tr>`;
  html += `<tr><td style="${TD}">Not assigned</td><td style="${TD}">${unassigned.length}</td><td style="${TD}">${unassigned.filter(r => r.d != null && r.d < 0).length}</td><td style="${TD}">${unassigned.filter(r => r.d === 0).length}</td><td style="${TD}">${unassigned.filter(r => r.d > 0 && r.d <= 7).length}</td></tr></table>`;
  html += `<p style="margin:0 0 18px">Ticked done in the last 24 hours: <b>${doneRecent.length}</b>${doneRecent.length ? ' — ' + doneRecent.map(r => esc(`${r.prod.split(' · ')[0]} ${r.num}`)).join(', ') : ''}.</p>`;

  for (const p of people) {
    html += `<h3 style="margin:22px 0 6px;font-size:16px">${NAMES[p.k]} — ${p.rows.length} open${p.late ? `, <span style="color:#c0392b">${p.late} late</span>` : ''}</h3>`;
    if (!p.rows.length) { html += `<p style="color:#666;margin:0">No open tasks.</p>`; continue; }
    html += `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%"><tr><th style="${TH}">Status</th><th style="${TH}">Due</th><th style="${TH}">Product</th><th style="${TH}">#</th><th style="${TH}">Task</th></tr>`;
    for (const r of p.rows) {
      const [txt, fg, bg] = status(r);
      html += `<tr><td style="${TD};white-space:nowrap;background:${bg};color:${fg};font-weight:bold">${txt}</td><td style="${TD};white-space:nowrap">${r.due ? esc(fmt(r.due)) : '—'}</td>
        <td style="${TD}"><a href="${BOARD}#${encodeURIComponent(r.pid)}" style="color:#1a5fb4">${esc(r.prod)}</a></td><td style="${TD};white-space:nowrap">${r.num}</td>
        <td style="${TD}">${esc(r.title)}${p.k === 'dvir' && r.owner ? ' <span style="color:#7b3fa0">(owner OK)</span>' : ''}</td></tr>`;
    }
    html += `</table>`;
  }

  if (unassigned.length) {
    const byProd = {};
    for (const r of unassigned) { const b = byProd[r.prod] ||= { pid: r.pid, n: 0, late: 0, next: null }; b.n++; if (r.d != null && r.d < 0) b.late++; if (r.due && (!b.next || r.due < b.next)) b.next = r.due; }
    html += `<h3 style="margin:22px 0 6px;font-size:16px">Not assigned to anyone — ${unassigned.length} open</h3>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><th style="${TH}">Product</th><th style="${TH}">Open</th><th style="${TH}">Late</th><th style="${TH}">Earliest due</th></tr>`;
    for (const [name, b] of Object.entries(byProd)) html += `<tr><td style="${TD}"><a href="${BOARD}#${encodeURIComponent(b.pid)}" style="color:#1a5fb4">${esc(name)}</a></td><td style="${TD}">${b.n}</td><td style="${TD}">${b.late}</td><td style="${TD}">${b.next ? esc(fmt(b.next)) : '—'}</td></tr>`;
    html += `</table>`;
  }
  html += `<p style="margin-top:22px"><a href="${BOARD}" style="background:#1a73e8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open the board</a></p>
    <p style="color:#888;font-size:12px">When a task is done, tick it on the board and write the result in its comment. Sent automatically every morning at 07:00 Israel time.</p></div>`;

  const subject = `Action Board status ${fmt(today)}: ${lateAll} late, ${people.reduce((s, p) => s + p.todayN, 0)} due today`;
  const text = `Action Board status ${today}\n\n` + people.map(p => `${NAMES[p.k]}: ${p.rows.length} open, ${p.late} late, ${p.todayN} due today\n` +
    p.rows.map(r => `  - [${status(r)[0]}] ${r.prod} ${r.num}: ${r.title}`).join('\n')).join('\n\n') +
    `\n\nNot assigned: ${unassigned.length} open\n\nOpen the board: ${BOARD}`;

  if (process.env.DRY) {
    fs.writeFileSync(path.join(__dirname, 'out.html'), html);
    console.log(subject); console.log(people.map(p => `${p.k}:${p.rows.length}/${p.late}`).join(' '), 'unassigned', unassigned.length);
    return;
  }
  const r = await fetch(process.env.MAIL_URL, { method: 'POST', body: JSON.stringify({ key: process.env.MAIL_KEY, type: 'digest', to: TO, subject, html, text }) });
  const j = await r.json().catch(() => ({ ok: false, error: 'non-JSON reply ' + r.status }));
  console.log('mail', JSON.stringify(j));
  if (!j.ok) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
