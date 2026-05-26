// homework-reminder.js – Hausaufgaben-Reminder mit Fächer-Abgleich
//
// Schickt abends NUR die Hausaufgaben, die für den nächsten Schultag relevant sind.
//
// Relevanzkriterien (ODER-Verknüpfung):
//   1. todo.Fällig <= nächster Schultag   (fällig/überfällig)
//   2. todo.Fach (Relation) → Fachname ∈ morgens Fächer (Fach-Abgleich)
//
// Das Fach-Feld in der Aufgaben-DB ist eine Relation zur Fächer-DB.
// Der Code löst die Relation automatisch auf – kein manueller Aufwand.

const https = require('https');

const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_STUNDENPLAN = process.env.NOTION_DATABASE_ID;
const NOTION_TODO_DB     = process.env.NOTION_TODO_DATABASE_ID;
const TELEGRAM_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Fächer-DB (Relation-Ziel der Aufgaben-DB)
const NOTION_FAECHER_DB = '17a2956b-ecfd-4ce6-8563-7726d6d8db05';

const IGNORIEREN = ['AG Bienen', 'Vertiefung', 'Freier Tag', 'Ferien'];

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
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
}

function naechsterSchultag() {
  const d = berlinHeute();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('fr-CA');
}

function berlinHour() {
  return berlinHeute().getHours();
}

function formatDatum(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const wochentage = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const monate = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return `${wochentage[d.getDay()]}, ${d.getDate()}. ${monate[d.getMonth()]}`;
}

// ── Uhrzeit-Guard (nur abends, außer manuell ausgelöst) ───────────────────────

function checkUhrzeit() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return;
  const h = berlinHour();
  if (h < 19 || h > 22) process.exit(0);
}

// ── Notion ────────────────────────────────────────────────────────────────────

async function notionQuery(dbId, filter) {
  const payload = filter ? { filter, page_size: 100 } : { page_size: 100 };
  const res = await post('api.notion.com', `/v1/databases/${dbId}/query`, payload, {
    'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28'
  });
  if (res.object === 'error') throw new Error(res.message);
  return res.results || [];
}

// ── Fächer-Mapping laden: { pageId → fachName } ───────────────────────────────
// Die Aufgaben-DB hat Fach als Relation → wir brauchen eine ID-zu-Name-Tabelle.

async function ladeFaecherMapping() {
  const rows = await notionQuery(NOTION_FAECHER_DB, null);
  const mapping = {};
  for (const page of rows) {
    const id   = page.id.replace(/-/g, ''); // Notion IDs ohne Bindestriche
    const name = page.properties['Fach']?.title?.[0]?.plain_text || '';
    if (name) {
      mapping[id] = name;
      mapping[page.id] = name; // auch mit Bindestrichen speichern
    }
  }
  return mapping;
}

// ── Fächer des nächsten Schultags aus dem Stundenplan ─────────────────────────

async function getFaecherMorgen(morgenDatum) {
  const rows = await notionQuery(NOTION_STUNDENPLAN, {
    property: 'Datum', date: { equals: morgenDatum }
  });
  const faecher = new Set();
  for (const page of rows) {
    const fach = page.properties.Fach?.title?.[0]?.plain_text || '';
    if (fach && !IGNORIEREN.includes(fach)) faecher.add(fach);
  }
  return faecher;
}

// ── Todos laden und nach Relevanz trennen ─────────────────────────────────────

async function getTodosGefiltert(morgenDatum, faecherMorgen, faecherMapping) {
  if (!NOTION_TODO_DB) return { relevant: [], anzahlAndere: 0 };

  const rows = await notionQuery(NOTION_TODO_DB, {
    property: 'Status', select: { does_not_equal: 'Erledigt' }
  });

  const prioritaetOrder = { 'Hoch': 0, 'Mittel': 1, 'Niedrig': 2, '': 3 };
  const relevant = [];
  let anzahlAndere = 0;

  for (const page of rows) {
    const p = page.properties;
    const title    = p['Aufgabe']?.title?.[0]?.plain_text || '';
    if (!title) continue;

    const faellig    = p['Fällig']?.date?.start || '';
    const prioritaet = p['Priorität']?.select?.name || '';

    // Fach ist eine Relation → Array von { id } Objekten
    const fachRelationen = p['Fach']?.relation || [];
    const fachNamen = fachRelationen
      .map(r => faecherMapping[r.id] || faecherMapping[r.id?.replace(/-/g, '')] || '')
      .filter(Boolean);
    const fach = fachNamen[0] || ''; // erstes Fach nehmen (meist nur eines)

    const istFaelligHeute  = faellig && faellig < morgenDatum;  // überfällig
    const istFaelligMorgen = faellig === morgenDatum;
    const istFachRelevant  = fachNamen.some(name => faecherMorgen.has(name));

    if (istFaelligHeute || istFaelligMorgen || istFachRelevant) {
      relevant.push({ title, faellig, prioritaet, fach, istFaelligMorgen, istFaelligHeute, istFachRelevant });
    } else {
      anzahlAndere++;
    }
  }

  // Sortierung: überfällig > morgen fällig > Fach-Match, dann nach Datum
  relevant.sort((a, b) => {
    const scoreA = a.istFaelligHeute ? 0 : a.istFaelligMorgen ? 1 : 2;
    const scoreB = b.istFaelligHeute ? 0 : b.istFaelligMorgen ? 1 : 2;
    if (scoreA !== scoreB) return scoreA - scoreB;
    if (a.faellig && b.faellig) return a.faellig.localeCompare(b.faellig);
    if (a.faellig) return -1;
    if (b.faellig) return 1;
    return (prioritaetOrder[a.prioritaet] ?? 3) - (prioritaetOrder[b.prioritaet] ?? 3);
  });

  return { relevant, anzahlAndere };
}

// ── Stundenplan für morgen (für Übersicht in der Nachricht) ───────────────────

async function getStundenplanMorgen(morgenDatum) {
  const rows = await notionQuery(NOTION_STUNDENPLAN, {
    property: 'Datum', date: { equals: morgenDatum }
  });
  return rows
    .map(page => {
      const p = page.properties;
      return {
        fach:   p.Fach?.title?.[0]?.plain_text || '?',
        start:  p.Startzeit?.rich_text?.[0]?.plain_text || '',
        status: p.Status?.select?.name || 'Normal'
      };
    })
    .filter(s => !IGNORIEREN.includes(s.fach) && s.start)
    .sort((a, b) => a.start.localeCompare(b.start));
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let cut = remaining.lastIndexOf('\n', 4000);
    if (cut === -1) cut = 4000;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  chunks.push(remaining);
  for (const chunk of chunks) {
    const res = await post('api.telegram.org', `/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: 'HTML'
    });
    if (!res.ok) throw new Error('Telegram: ' + JSON.stringify(res));
  }
}

// ── Hauptprogramm ─────────────────────────────────────────────────────────────

async function main() {
  checkUhrzeit();

  const morgenDatum = naechsterSchultag();
  console.log(`📅 Nächster Schultag: ${morgenDatum}`);

  // Fächer-Mapping, Stundenplan und Todos parallel laden
  const [faecherMorgen, stunden, faecherMapping] = await Promise.all([
    getFaecherMorgen(morgenDatum),
    getStundenplanMorgen(morgenDatum),
    ladeFaecherMapping()
  ]);

  console.log(`📚 Fächer morgen: ${[...faecherMorgen].join(', ') || '(keine)'}`);
  console.log(`🗂️  Fächer-Mapping: ${Object.keys(faecherMapping).length / 2} Einträge`);

  const { relevant, anzahlAndere } = await getTodosGefiltert(morgenDatum, faecherMorgen, faecherMapping);

  const pEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };

  let msg = `📖 <b>Hausaufgaben-Reminder – ${formatDatum(morgenDatum)}</b>\n`;

  // Morgen auf dem Stundenplan
  if (stunden.length > 0) {
    const faecherListe = stunden
      .map(s => {
        const statusEmoji = s.status === 'Ausfall' ? ' ❌' : s.status === 'Vertretung' ? ' 🔄' : '';
        return `${s.fach}${statusEmoji}`;
      })
      .join(' · ');
    msg += `<i>${faecherListe}</i>\n`;
  } else {
    msg += `<i>Kein Unterricht morgen</i>\n`;
  }
  msg += '\n';

  if (relevant.length === 0) {
    msg += `🎉 Keine offenen Aufgaben für morgen!\n`;
  } else {
    msg += `✅ <b>Für morgen relevant (${relevant.length})</b>\n`;
    for (const t of relevant) {
      const prioritaetIcon = pEmoji[t.prioritaet] || '•';

      let grund = '';
      if (t.istFaelligHeute) {
        grund = ` <b>⚠️ ÜBERFÄLLIG!</b>`;
      } else if (t.istFaelligMorgen) {
        grund = ` <b>⚠️ morgen fällig!</b>`;
      } else if (t.istFachRelevant && t.fach) {
        grund = ` <i>(${t.fach})</i>`;
      }

      msg += `${prioritaetIcon} ${t.title}${grund}\n`;
    }
  }

  if (anzahlAndere > 0) {
    msg += `\n<i>+ ${anzahlAndere} weitere offene Aufgabe${anzahlAndere !== 1 ? 'n' : ''} (andere Fächer/Termine)</i>\n`;
  }

  msg += `\n💤 <i>Gute Nacht!</i>`;

  await sendTelegram(msg);
  console.log(`✅ Hausaufgaben-Reminder gesendet (${relevant.length} relevant, ${anzahlAndere} andere)`);
}

main().catch(err => { console.error('Fehler:', err); process.exit(1); });
