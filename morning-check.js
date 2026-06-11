// morning-check.js – Täglicher Schul-Check via Telegram
const https   = require('https');
const { JWT } = require('google-auth-library');

const NOTION_TOKEN         = process.env.NOTION_TOKEN;
const NOTION_STUNDENPLAN   = process.env.NOTION_DATABASE_ID;
const NOTION_TODO_DB       = process.env.NOTION_TODO_DATABASE_ID;
const TELEGRAM_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID     = process.env.TELEGRAM_CHAT_ID;

const IGNORIEREN = ['AG Bienen', 'Vertiefung'];

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

function get(hostname, path, extraHeaders = {}) {
  return request({ hostname, path, method: 'GET', headers: { ...extraHeaders } });
}

function today() {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Berlin' });
}

function berlinHour() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getHours();
}

function formatDate() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const wochentage = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const monate = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return `${wochentage[d.getDay()]}, ${d.getDate()}. ${monate[d.getMonth()]}`;
}

function checkUhrzeit() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return;
  if (berlinHour() !== 6) process.exit(0);
}

async function checkFerien() {
  const jahr = new Date().getFullYear();
  const todayStr = today();
  let ferien = [];
  try {
    const [a, b] = await Promise.all([
      get('ferien-api.de', `/api/v1/holidays/NW/${jahr}`),
      get('ferien-api.de', `/api/v1/holidays/NW/${jahr + 1}`)
    ]);
    ferien = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  } catch { return { inFerien: false, letzterTag: false, name: null }; }
  for (const f of ferien) {
    const start = f.start.split('T')[0];
    const endExkl = f.end.split('T')[0];
    if (todayStr >= start && todayStr < endExkl) {
      const letzterTagDate = new Date(endExkl);
      letzterTagDate.setDate(letzterTagDate.getDate() - 1);
      const letzterTag = letzterTagDate.toISOString().split('T')[0];
      if (todayStr === letzterTag) return { inFerien: true, letzterTag: true, name: f.name };
      return { inFerien: true, letzterTag: false, name: f.name };
    }
  }
  return { inFerien: false, letzterTag: false, name: null };
}

// Lädt ALLE Seiten (Pagination) – sonst fehlen ab 100 Zeilen still Einträge
async function notionQuery(dbId, filter) {
  const results = [];
  let cursor = null;
  do {
    const payload = { page_size: 100 };
    if (filter) payload.filter = filter;
    if (cursor) payload.start_cursor = cursor;
    const res = await post('api.notion.com', `/v1/databases/${dbId}/query`, payload, {
      'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28'
    });
    if (res.object === 'error') throw new Error(res.message);
    if (typeof res !== 'object' || !Array.isArray(res.results)) throw new Error('Unerwartete Notion-Antwort: ' + String(res).slice(0, 120));
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return results;
}

// HTML-Sonderzeichen escapen – Titel aus Notion/Kalender können <, >, & enthalten,
// womit Telegram (parse_mode HTML) sonst die ganze Nachricht mit 400 ablehnt.
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getStundenplan() {
  const rows = await notionQuery(NOTION_STUNDENPLAN, { property: 'Datum', date: { equals: today() } });
  return rows
    .map(page => {
      const p = page.properties;
      return { fach: p.Fach?.title?.[0]?.plain_text || '?', start: p.Startzeit?.rich_text?.[0]?.plain_text || '', ende: p.Endzeit?.rich_text?.[0]?.plain_text || '', raum: p.Raum?.rich_text?.[0]?.plain_text || '', status: p.Status?.select?.name || 'Normal' };
    })
    .filter(s => !IGNORIEREN.includes(s.fach))
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function getTodos() {
  if (!NOTION_TODO_DB) return [];
  const rows = await notionQuery(NOTION_TODO_DB, { property: 'Status', select: { does_not_equal: 'Erledigt' } });
  const prioritaetOrder = { 'Hoch': 0, 'Mittel': 1, 'Niedrig': 2, '': 3 };
  return rows
    .map(page => {
      const p = page.properties;
      return { title: p['Aufgabe']?.title?.[0]?.plain_text || '', prioritaet: p['Priorität']?.select?.name || '', faellig: (p['Fällig']?.date?.start || '').split('T')[0] };
    })
    .filter(t => t.title.length > 0)
    .sort((a, b) => {
      if (a.faellig && b.faellig) return a.faellig.localeCompare(b.faellig);
      if (a.faellig) return -1;
      if (b.faellig) return 1;
      return (prioritaetOrder[a.prioritaet] ?? 3) - (prioritaetOrder[b.prioritaet] ?? 3);
    });
}

async function getPersonalTodos() {
  const dbId = process.env.NOTION_PERSONAL_DB_ID;
  if (!dbId) return [];
  const rows = await notionQuery(dbId, { property: 'Erledigt', checkbox: { equals: false } });
  return rows.map(page => page.properties['Aufgabe']?.title?.[0]?.plain_text || '').filter(t => t.length > 0);
}

async function getAccessToken() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const jwt = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly']
  });
  const token = await jwt.authorize();
  return token.access_token;
}

// Korrekten UTC-Offset für Berlin am jeweiligen Datum ermitteln (Sommer +02, Winter +01).
// Ein hartes +02:00 verschiebt das Abfragefenster im Winter um eine Stunde.
function getBerlinOffset(datum) {
  const d = new Date(datum + 'T12:00:00Z');
  const berlinTime = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const utcTime = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = Math.round((berlinTime - utcTime) / 3600000);
  return offset === 2 ? '+02:00' : '+01:00';
}

async function getKalenderTermine(datum, accessToken) {
  const offset = getBerlinOffset(datum);
  const calId = encodeURIComponent('sabesis@web.de');
  const start = encodeURIComponent(`${datum}T00:00:00${offset}`);
  const end   = encodeURIComponent(`${datum}T23:59:59${offset}`);
  const path  = `/calendar/v3/calendars/${calId}/events?timeMin=${start}&timeMax=${end}&singleEvents=true&orderBy=startTime`;
  const res = await get('www.googleapis.com', path, { 'Authorization': `Bearer ${accessToken}` });
  if (res.error) { console.error('Kalender Fehler:', JSON.stringify(res.error)); return []; }
  return (res.items || []).map(e => ({
    titel:   e.summary || '(kein Titel)',
    start:   e.start?.dateTime ? e.start.dateTime.substring(11, 16) : '',
    ende:    e.end?.dateTime   ? e.end.dateTime.substring(11, 16)   : '',
    ganztag: !!e.start?.date && !e.start?.dateTime
  }));
}

async function getWetter() {
  const res = await get('api.open-meteo.com', '/v1/forecast?latitude=51.5136&longitude=7.4653&current=temperature_2m,weathercode,windspeed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe%2FBerlin&forecast_days=1');
  const codes = { 0:'☀️ Klar', 1:'🌤️ Überwiegend klar', 2:'⛅ Teilweise bewölkt', 3:'☁️ Bedeckt', 45:'🌫️ Nebel', 51:'🌦️ Nieselregen', 61:'🌧️ Regen', 71:'❄️ Schnee', 80:'🌦️ Schauer', 95:'⛈️ Gewitter' };
  return {
    desc: codes[res.current?.weathercode] ?? '🌡️',
    temp: Math.round(res.current?.temperature_2m ?? 0),
    wind: Math.round(res.current?.windspeed_10m ?? 0),
    max:  Math.round(res.daily?.temperature_2m_max?.[0] ?? 0),
    min:  Math.round(res.daily?.temperature_2m_min?.[0] ?? 0),
    rain: (res.daily?.precipitation_sum?.[0] ?? 0).toFixed(1)
  };
}

async function sendTelegram(text) {
  const res = await post('api.telegram.org', `/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
  return res;
}

async function main() {
  checkUhrzeit();

  const ferien = await checkFerien().catch(() => ({ inFerien: false, letzterTag: false, name: null }));
  if (ferien.inFerien && !ferien.letzterTag) process.exit(0);

  let accessToken = null;
  try { accessToken = await getAccessToken(); } catch(e) { console.error('Token Fehler:', e.message); }

  const [stunden, todos, personal, w, termine] = await Promise.all([
    getStundenplan().catch(() => []),
    getTodos().catch(() => []),
    getPersonalTodos().catch(() => []),
    getWetter().catch(() => null),
    accessToken ? getKalenderTermine(today(), accessToken).catch(() => []) : Promise.resolve([])
  ]);

  let msg = `🎒 <b>Schul-Check – ${formatDate()}</b>\n`;
  if (ferien.letzterTag) msg += `🏖️ <i>Letzter Ferientag (${escapeHtml(ferien.name)}) – morgen geht's wieder los!</i>\n`;
  msg += '\n';

  if (w) {
    msg += `🌤️ <b>Wetter Dortmund</b>\n${w.desc} · <b>${w.temp}°C</b>\n↑ ${w.max}° ↓ ${w.min}°  ·  💧 ${w.rain} mm  ·  💨 ${w.wind} km/h\n\n`;
  }

  msg += `📚 <b>Stundenplan heute</b>\n`;
  if (stunden.length === 0) {
    msg += `✨ Kein Unterricht – freier Tag!\n`;
  } else {
    for (const s of stunden) {
      const emoji = s.status.includes('Ausfall') ? '❌' : s.status.includes('Vertretung') ? '🔄' : '✅';
      msg += `${emoji} <b>${s.start}–${s.ende}</b> ${escapeHtml(s.fach)}`;
      if (s.raum) msg += ` · ${escapeHtml(s.raum)}`;
      if (s.status.includes('Ausfall')) msg += ` <i>(Ausfall)</i>`;
      else if (s.status.includes('Vertretung')) msg += ` <i>(Vertretung)</i>`;
      msg += '\n';
    }
  }

  msg += `\n📅 <b>Termine heute</b>\n`;
  if (termine.length === 0) {
    msg += `✨ Keine Termine heute\n`;
  } else {
    for (const t of termine) {
      if (t.ganztag) msg += `🗓 ${escapeHtml(t.titel)} <i>(ganztägig)</i>\n`;
      else msg += `🗓 <b>${t.start}–${t.ende}</b> ${escapeHtml(t.titel)}\n`;
    }
  }

  msg += `\n✅ <b>Offene Aufgaben</b>\n`;
  if (todos.length === 0) {
    msg += `🎉 Alles erledigt!\n`;
  } else {
    const pEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
    for (const t of todos.slice(0, 20)) {
      msg += `${pEmoji[t.prioritaet] || '•'} ${escapeHtml(t.title)}`;
      if (t.faellig) { const d = new Date(t.faellig + 'T12:00:00'); msg += ` <i>(fällig ${d.getDate()}.${d.getMonth()+1}.)</i>`; }
      msg += '\n';
    }
    if (todos.length > 20) msg += `… und ${todos.length - 20} weitere\n`;
  }

  msg += `\n🏠 <b>Persönliche Aufgaben</b>\n`;
  if (personal.length === 0) msg += `🎉 Nichts zu erledigen!\n`;
  else for (const t of personal) msg += `☐ ${escapeHtml(t)}\n`;

  msg += `\n🚀 <i>Guten Schultag!</i>`;

  const result = await sendTelegram(msg);
  if (result.ok) console.log('✅ Schul-Check gesendet!');
  else { console.error('❌ Telegram-Fehler:', JSON.stringify(result)); process.exit(1); }
}

main().catch(err => { console.error('Fehler:', err); process.exit(1); });
