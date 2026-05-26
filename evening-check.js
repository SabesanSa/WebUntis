// evening-check.js – Abendlicher Schul-Check für den nächsten Tag
const https   = require('https');
const { JWT } = require('google-auth-library');

const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_STUNDENPLAN = process.env.NOTION_DATABASE_ID;
const NOTION_TODO_DB     = process.env.NOTION_TODO_DATABASE_ID;
const TELEGRAM_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

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

function naechsterWochentag(vonDatum, schritte = 1) {
  const d = new Date(vonDatum + 'T12:00:00');
  d.setDate(d.getDate() + schritte);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('fr-CA');
}

function vortag(datum) {
  const d = new Date(datum + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('fr-CA');
}

function formatDatum(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const wochentage = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const monate = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return `${wochentage[d.getDay()]}, ${d.getDate()}. ${monate[d.getMonth()]}`;
}

function berlinHour() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getHours();
}

function heute() {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Berlin' });
}

function checkUhrzeit() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return;
  if (berlinHour() !== 16) process.exit(0);
}

async function ladeFerien() {
  const jahr = new Date().getFullYear();
  try {
    const [a, b] = await Promise.all([
      get('ferien-api.de', `/api/v1/holidays/NW/${jahr}`),
      get('ferien-api.de', `/api/v1/holidays/NW/${jahr + 1}`)
    ]);
    return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  } catch { return []; }
}

function inFerien(datum, ferienListe) {
  for (const f of ferienListe) {
    const start = f.start.split('T')[0];
    const endExkl = f.end.split('T')[0];
    if (datum >= start && datum < endExkl) {
      return { name: f.name, start, endExkl, letzterTag: vortag(endExkl), ersterSchultag: endExkl };
    }
  }
  return null;
}

function analysiereNaechsterTag(ferien) {
  const morgen = naechsterWochentag(heute());
  const morgenFerien = inFerien(morgen, ferien);
  let ersterSchultag = morgen;
  let aktFerien = morgenFerien;
  let maxLoops = 60;
  while (aktFerien && maxLoops-- > 0) {
    ersterSchultag = naechsterWochentag(ersterSchultag);
    aktFerien = inFerien(ersterSchultag, ferien);
  }
  const gesternInFerien = inFerien(vortag(morgen), ferien);
  const heuteFerien = inFerien(heute(), ferien);
  return {
    morgenDatum: morgen, morgenFrei: morgenFerien !== null, morgenFerienInfo: morgenFerien,
    ersterSchultag, nachFerien: !morgenFerien && gesternInFerien !== null,
    ferienStarten: !heuteFerien && morgenFerien !== null
  };
}

async function notionQuery(dbId, filter) {
  const payload = filter ? { filter } : {};
  const res = await post('api.notion.com', `/v1/databases/${dbId}/query`, payload, {
    'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28'
  });
  if (res.object === 'error') throw new Error(res.message);
  return res.results || [];
}

async function getStundenplan(datum) {
  const rows = await notionQuery(NOTION_STUNDENPLAN, { property: 'Datum', date: { equals: datum } });
  return rows
    .map(page => {
      const p = page.properties;
      return { fach: p.Fach?.title?.[0]?.plain_text || '?', start: p.Startzeit?.rich_text?.[0]?.plain_text || '', ende: p.Endzeit?.rich_text?.[0]?.plain_text || '', raum: p.Raum?.rich_text?.[0]?.plain_text || '', status: p.Status?.select?.name || 'Normal' };
    })
    .filter(s => !IGNORIEREN.includes(s.fach))
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function getTodos(morgenDatum) {
  if (!NOTION_TODO_DB) return [];
  const rows = await notionQuery(NOTION_TODO_DB, { property: 'Status', select: { does_not_equal: 'Erledigt' } });
  const prioritaetOrder = { 'Hoch': 0, 'Mittel': 1, 'Niedrig': 2, '': 3 };
  return rows
    .map(page => {
      const p = page.properties;
      return { title: p['Aufgabe']?.title?.[0]?.plain_text || '', prioritaet: p['Priorität']?.select?.name || '', faellig: p['Fällig']?.date?.start || '' };
    })
    .filter(t => t.title.length > 0)
    .sort((a, b) => {
      if (a.faellig === morgenDatum) return -1;
      if (b.faellig === morgenDatum) return 1;
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

async function getKalenderTermine(datum, accessToken) {
  const calId = encodeURIComponent('sabesis@web.de');
  const start = encodeURIComponent(datum + 'T00:00:00+02:00');
  const end   = encodeURIComponent(datum + 'T23:59:59+02:00');
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

async function getWetterMorgen() {
  const res = await get('api.open-meteo.com', '/v1/forecast?latitude=51.5136&longitude=7.4653&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=Europe%2FBerlin&forecast_days=2');
  const codes = { 0:'☀️ Klar', 1:'🌤️ Überwiegend klar', 2:'⛅ Teilweise bewölkt', 3:'☁️ Bedeckt', 45:'🌫️ Nebel', 51:'🌦️ Nieselregen', 61:'🌧️ Regen', 71:'❄️ Schnee', 80:'🌦️ Schauer', 95:'⛈️ Gewitter' };
  const daily = res.daily;
  return { desc: codes[daily?.weathercode?.[1]] ?? '🌡️', max: Math.round(daily?.temperature_2m_max?.[1] ?? 0), min: Math.round(daily?.temperature_2m_min?.[1] ?? 0), rain: (daily?.precipitation_sum?.[1] ?? 0).toFixed(1) };
}

async function sendTelegram(text) {
  return post('api.telegram.org', `/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
}

async function main() {
  checkUhrzeit();

  const ferienListe  = await ladeFerien();
  const naechsterTag = analysiereNaechsterTag(ferienListe);
  const zielDatum    = naechsterTag.ersterSchultag;

  let accessToken = null;
  try { accessToken = await getAccessToken(); } catch(e) { console.error('Token Fehler:', e.message); }

  const [stunden, todos, personal, w, termine] = await Promise.all([
    getStundenplan(zielDatum).catch(() => []),
    getTodos(naechsterTag.morgenDatum).catch(() => []),
    getPersonalTodos().catch(() => []),
    getWetterMorgen().catch(() => null),
    accessToken ? getKalenderTermine(zielDatum, accessToken).catch(() => []) : Promise.resolve([])
  ]);

  let msg = `🌙 <b>Abend-Check – Ausblick auf morgen</b>\n\n`;

  if (naechsterTag.ferienStarten) {
    const fi = naechsterTag.morgenFerienInfo;
    const d = fi ? new Date(fi.letzterTag + 'T12:00:00') : null;
    msg += `🏖️ <b>Morgen beginnen die ${fi?.name ?? 'Ferien'}!</b>${d ? ` bis ${d.getDate()}.${d.getMonth()+1}.` : ''}\nErster Schultag danach: <b>${formatDatum(zielDatum)}</b>\n\n`;
  } else if (naechsterTag.morgenFrei) {
    const fi = naechsterTag.morgenFerienInfo;
    const d = fi ? new Date(fi.letzterTag + 'T12:00:00') : null;
    msg += `🏖️ <b>Morgen schulfrei!</b> ${fi?.name ?? 'Ferien'}${d ? ` bis ${d.getDate()}.${d.getMonth()+1}.` : ''}\n`;
    if (zielDatum !== naechsterTag.morgenDatum) msg += `📅 Nächster Schultag: <b>${formatDatum(zielDatum)}</b>\n`;
    msg += '\n';
  } else if (naechsterTag.nachFerien) {
    msg += `⚠️ <b>Morgen geht's wieder los nach den Ferien!</b>\n📅 <b>${formatDatum(zielDatum)}</b>\n\n`;
  } else {
    msg += `📅 <b>${formatDatum(zielDatum)}</b>\n\n`;
  }

  if (w) {
    msg += `🌤️ <b>Wetter Dortmund morgen</b>\n${w.desc}\n↑ ${w.max}° ↓ ${w.min}°  ·  💧 ${w.rain} mm\n\n`;
  }

  msg += `📚 <b>Stundenplan ${formatDatum(zielDatum)}</b>\n`;
  if (stunden.length === 0) {
    msg += `✨ Kein Unterricht eingetragen\n`;
  } else {
    for (const s of stunden) {
      const emoji = s.status.includes('Ausfall') ? '❌' : s.status.includes('Vertretung') ? '🔄' : '✅';
      msg += `${emoji} <b>${s.start}–${s.ende}</b> ${s.fach}`;
      if (s.raum) msg += ` · ${s.raum}`;
      if (s.status.includes('Ausfall')) msg += ` <i>(Ausfall)</i>`;
      else if (s.status.includes('Vertretung')) msg += ` <i>(Vertretung)</i>`;
      msg += '\n';
    }
  }

  msg += `\n📅 <b>Termine morgen</b>\n`;
  if (termine.length === 0) {
    msg += `✨ Keine Termine morgen\n`;
  } else {
    for (const t of termine) {
      if (t.ganztag) msg += `🗓 ${t.titel} <i>(ganztägig)</i>\n`;
      else msg += `🗓 <b>${t.start}–${t.ende}</b> ${t.titel}\n`;
    }
  }

  msg += `\n✅ <b>Offene Aufgaben</b>\n`;
  if (todos.length === 0) {
    msg += `🎉 Alles erledigt!\n`;
  } else {
    const pEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
    for (const t of todos.slice(0, 20)) {
      msg += `${pEmoji[t.prioritaet] || '•'} ${t.title}`;
      if (t.faellig === naechsterTag.morgenDatum) msg += ` <b>⚠️ morgen fällig!</b>`;
      else if (t.faellig) { const d = new Date(t.faellig + 'T12:00:00'); msg += ` <i>(fällig ${d.getDate()}.${d.getMonth()+1}.)</i>`; }
      msg += '\n';
    }
    if (todos.length > 20) msg += `… und ${todos.length - 20} weitere\n`;
  }

  msg += `\n🏠 <b>Persönliche Aufgaben</b>\n`;
  if (personal.length === 0) msg += `🎉 Nichts zu erledigen!\n`;
  else for (const t of personal) msg += `☐ ${t}\n`;

  msg += `\n🌙 <i>Schönen Abend!</i>`;

  const result = await sendTelegram(msg);
  if (result.ok) console.log('✅ Abend-Check gesendet!');
  else { console.error('❌ Telegram-Fehler:', JSON.stringify(result)); process.exit(1); }
}

main().catch(err => { console.error('Fehler:', err); process.exit(1); });
