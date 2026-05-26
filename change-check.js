// change-check.js – Erkennt Stundenplan-Änderungen und sendet Telegram-Alerts
//
// Wird täglich nach dem Stundenplan-Sync und mittags ausgeführt.
// Speichert einen Snapshot des Stundenplans als stundenplan-snapshot.json
// (via GitHub Actions Cache) und vergleicht bei jedem Lauf.
//
// Erkannte Änderungen:
//   - Ausfall (Normal → Ausfall)
//   - Vertretung (Normal → Vertretung)
//   - Raumwechsel
//   - Stunde komplett hinzugekommen oder weggefallen (nur für Heute/Morgen)

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_STUNDENPLAN = process.env.NOTION_DATABASE_ID;
const TELEGRAM_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SNAPSHOT_FILE = 'stundenplan-snapshot.json';
const IGNORIEREN    = ['AG Bienen', 'Vertiefung', 'Freier Tag', 'Ferien'];

// Nur Änderungen für die nächsten N Tage sind meldepflichtig
const ALERT_HORIZONT_TAGE = 3;

// ── HTTP-Helfer ───────────────────────────────────────────────────────────────

function request(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (options._body) req.write(options._body);
    req.end();
  });
}

function post(hostname, path, body, extraHeaders = {}) {
  const raw = JSON.stringify(body);
  return request({
    hostname, path, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...extraHeaders },
    _body: raw
  });
}

// ── Datum-Helfer ──────────────────────────────────────────────────────────────

function berlinHeute() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
    .toLocaleDateString('fr-CA');
}

function addTage(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('fr-CA');
}

function formatDatum(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const wochentage = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  return `${wochentage[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}

function horizont() {
  const heute = berlinHeute();
  const tage = [];
  for (let i = 0; i < ALERT_HORIZONT_TAGE; i++) tage.push(addTage(heute, i));
  return new Set(tage);
}

// ── Notion ────────────────────────────────────────────────────────────────────

async function notionQuery(filter) {
  const payload = filter ? { filter, page_size: 100 } : { page_size: 100 };
  const res = await post('api.notion.com', `/v1/databases/${NOTION_STUNDENPLAN}/query`, payload, {
    'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28'
  });
  if (res.object === 'error') throw new Error(res.message);
  return res.results || [];
}

// ── Aktuellen Stundenplan aus Notion laden (heute + nächste 14 Tage) ──────────

async function ladeAktuellerStundenplan() {
  const heute = berlinHeute();
  const bis   = addTage(heute, 14);

  const rows = await notionQuery({
    and: [
      { property: 'Datum', date: { on_or_after: heute } },
      { property: 'Datum', date: { on_or_before: bis   } }
    ]
  });

  // State-Format: { "2026-05-27": { "08:00|Englisch": { status, raum, start, ende } } }
  const state = {};
  for (const page of rows) {
    const p     = page.properties;
    const datum = p.Datum?.date?.start?.split('T')[0];
    const fach  = p.Fach?.title?.[0]?.plain_text || '';
    const start = p.Startzeit?.rich_text?.[0]?.plain_text || '';
    const ende  = p.Endzeit?.rich_text?.[0]?.plain_text || '';
    const raum  = p.Raum?.rich_text?.[0]?.plain_text || '';
    const status = p.Status?.select?.name || 'Normal';

    if (!datum || !fach || !start || IGNORIEREN.includes(fach)) continue;

    const key = `${start}|${fach}`;
    if (!state[datum]) state[datum] = {};
    state[datum][key] = { start, ende, raum, status, fach };
  }

  return state;
}

// ── Snapshot laden / speichern ────────────────────────────────────────────────

function ladeSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function speichereSnapshot(state) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
    gespeichert_am: new Date().toISOString(),
    tage: state
  }, null, 2));
}

// ── Änderungen ermitteln ──────────────────────────────────────────────────────

function statusEmoji(status) {
  if (status === 'Ausfall')    return '❌';
  if (status === 'Vertretung') return '🔄';
  if (status === 'Prüfung')    return '📝';
  return '✅';
}

function vergleiche(altState, neuState) {
  const relevanteTimage = horizont();
  const aenderungen = [];

  // 1. Vergleiche Einträge die alt UND neu existieren
  for (const datum of Object.keys(altState)) {
    if (!relevanteTimage.has(datum)) continue;
    const altTag = altState[datum];
    const neuTag = neuState[datum] || {};

    for (const key of Object.keys(altTag)) {
      const alt = altTag[key];
      const neu = neuTag[key];

      if (!neu) {
        // Stunde weggefallen
        aenderungen.push({
          datum, typ: 'entfernt',
          text: `${statusEmoji('Ausfall')} ${formatDatum(datum)} ${alt.start} <b>${alt.fach}</b> weggefallen`
        });
        continue;
      }

      // Status geändert?
      if (alt.status !== neu.status) {
        const altWar = alt.status === 'Normal' ? 'regulär' : alt.status;
        aenderungen.push({
          datum, typ: 'status',
          text: `${statusEmoji(neu.status)} ${formatDatum(datum)} ${alt.start} <b>${alt.fach}</b>: ${altWar} → <b>${neu.status}</b>`
        });
      }

      // Raum geändert?
      if (alt.raum !== neu.raum && (alt.raum || neu.raum)) {
        const altRaum = alt.raum || '?';
        const neuRaum = neu.raum || '?';
        aenderungen.push({
          datum, typ: 'raum',
          text: `🏫 ${formatDatum(datum)} ${alt.start} <b>${alt.fach}</b>: Raum ${altRaum} → <b>${neuRaum}</b>`
        });
      }

      // Uhrzeit geändert?
      if (alt.start !== neu.start || alt.ende !== neu.ende) {
        aenderungen.push({
          datum, typ: 'zeit',
          text: `⏰ ${formatDatum(datum)} <b>${alt.fach}</b>: ${alt.start}–${alt.ende} → <b>${neu.start}–${neu.ende}</b>`
        });
      }
    }
  }

  // 2. Neue Einträge für relevante Tage (die im alten Snapshot noch nicht da waren)
  for (const datum of Object.keys(neuState)) {
    if (!relevanteTimage.has(datum)) continue;
    const altTag = altState[datum] || {};
    const neuTag = neuState[datum];

    for (const key of Object.keys(neuTag)) {
      if (altTag[key]) continue; // schon verglichen oben
      const neu = neuTag[key];
      // Neue Stunde → nur melden wenn Datum schon im alten Snapshot vertreten war
      // (sonst jede neue Woche eine Flut von Meldungen)
      if (!altState[datum]) continue;
      aenderungen.push({
        datum, typ: 'neu',
        text: `➕ ${formatDatum(datum)} ${neu.start} <b>${neu.fach}</b> neu hinzugekommen`
      });
    }
  }

  // Sortieren nach Datum
  aenderungen.sort((a, b) => a.datum.localeCompare(b.datum));
  return aenderungen;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const res = await post('api.telegram.org', `/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML'
  });
  if (!res.ok) console.error('Telegram-Fehler:', JSON.stringify(res));
}

// ── Hauptprogramm ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Stundenplan-Check gestartet…');

  const neuState   = await ladeAktuellerStundenplan();
  const snapshotObj = ladeSnapshot();
  const altState   = snapshotObj?.tage || null;

  if (!altState) {
    console.log('ℹ️  Kein Snapshot gefunden – erster Lauf, Snapshot wird gespeichert.');
    speichereSnapshot(neuState);
    return;
  }

  console.log(`📸 Snapshot vom ${snapshotObj.gespeichert_am?.substring(0, 16) || '?'}`);

  const aenderungen = vergleiche(altState, neuState);

  if (aenderungen.length === 0) {
    console.log('✅ Keine Änderungen im Stundenplan.');
  } else {
    console.log(`⚠️  ${aenderungen.length} Änderung(en) erkannt!`);
    let msg = `📢 <b>Stundenplan-Änderung!</b>\n\n`;
    for (const a of aenderungen) msg += `${a.text}\n`;
    msg += `\n<i>Snapshot: ${snapshotObj.gespeichert_am?.substring(0, 16)}</i>`;
    await sendTelegram(msg);
  }

  // Snapshot immer aktualisieren
  speichereSnapshot(neuState);
  console.log('💾 Snapshot aktualisiert.');
}

main().catch(err => { console.error('Fehler:', err); process.exit(1); });
