// week-check.js – Wochenausblick via Telegram
const https   = require('https');
const { JWT } = require('google-auth-library');

const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_STUNDENPLAN = process.env.NOTION_DATABASE_ID;
const NOTION_TODO_DB     = process.env.NOTION_TODO_DATABASE_ID;
const TELEGRAM_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const WOCHE_INPUT        = process.env.WOCHE_INPUT || 'diese';

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

function wochenbereich(offset = 0) {
  const heute = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const tag = heute.getDay();
  const diffZuMontag = tag === 0 ? -6 : 1 - tag;
  const montag = new Date(heute);
  montag.setDate(heute.getDate() + diffZuMontag + offset * 7);
  montag.setHours(0, 0, 0, 0);
  const freitag = new Date(montag);
  freitag.setDate(montag.getDate() + 4);
  const fmt = d => d.toLocaleDateString('fr-CA');
  return { montag: fmt(montag), freitag: fmt(freitag) };
}

function formatKurzdatum(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}

function addTage(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('fr-CA');
}

async function notionQuery(dbId, filter) {
  const payload = filter ? { filter, page_size: 100 } : { page_size: 100 };
  const res = await post('api.notion.com', `/v1/databases/${dbId}/query`, payload, {
    'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28'
  });
  if (res.object === 'error') throw new Error(res.message);
  return res.results || [];
}

async function getWochenplan(montag, freitag) {
  const rows = await notionQuery(NOTION_STUNDENPLAN, {
    and: [
      { property: 'Datum', date: { on_or_after: montag } },
      { property: 'Datum', date: { on_or_before: freitag } }
    ]
  });
  const tage = {};
  for (const page of rows) {
    const p = page.properties;
    const datum = p.Datum?.date?.start?.split('T')[0];
    if (!datum) continue;
    const fach = p.Fach?.title?.[0]?.plain_text || '?';
    if (IGNORIEREN.includes(fach)) continue;
    if (!tage[datum]) tage[datum] = [];
    tage[datum].push({
      fach, start: p.Startzeit?.rich_text?.[0]?.plain_text || '',
      ende: p.Endzeit?.rich_text?.[0]?.plain_text || '',
      raum: p.Raum?.rich_text?.[0]?.plain_text || '',
      status: p.Status?.select?.name || 'Normal'
    });
  }
  for (const datum of Object.keys(tage)) tage[datum].sort((a, b) => a.start.localeCompare(b.start));
  return tage;
}

async function getTodos() {
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
  console.log('✅ Service Account Token erhalten');
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

async function getWetterWoche() {
  const res = await get('api.open-meteo.com', [
    '/v1/forecast?latitude=51.5136&longitude=7.4653',
    '&daily=temperature_2m_max,temperature_2m_min,weathercode',
    '&timezone=Europe%2FBerlin&forecast_days=8'
  ].join(''));
  const codes = { 0:'☀️', 1:'🌤️', 2:'⛅', 3:'☁️', 45:'🌫️', 51:'🌦️', 61:'🌧️', 71:'❄️', 80:'🌦️', 95:'⛈️' };
  const tage = {};
  const daily = res.daily;
  for (let i = 0; i < (daily?.time?.length ?? 0); i++) {
    tage[daily.time[i]] = { emoji: codes[daily.weathercode[i]] ?? '🌡️', max: Math.round(daily.temperature_2m_max[i]), min: Math.round(daily.temperature_2m_min[i]) };
  }
  return tage;
}

async function sendTelegram(text) {
  const chunks = [];
  while (text.length > 4000) {
    let cut = text.lastIndexOf('\n', 4000);
    if (cut === -1) cut = 4000;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  chunks.push(text);
  for (const chunk of chunks) {
    const res = await post('api.telegram.org', `/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: 'HTML' });
    if (!res.ok) throw new Error('Telegram: ' + JSON.stringify(res));
  }
}

async function main() {
  const istNaechsteWoche = WOCHE_INPUT === 'naechste';
  const { montag, freitag } = wochenbereich(istNaechsteWoche ? 1 : 0);

  let accessToken = null;
  try {
    accessToken = await getAccessToken();
  } catch(e) {
    console.error('❌ Token Fehler:', e.message);
  }

  const [stundenplan, todos, personal, wetterMap] = await Promise.all([
    getWochenplan(montag, freitag).catch(e => { console.error('Stundenplan-Fehler:', e.message); return {}; }),
    getTodos().catch(e => { console.error('Todo-Fehler:', e.message); return []; }),
    getPersonalTodos().catch(e => { console.error('Personal-Fehler:', e.message); return []; }),
    getWetterWoche().catch(e => { console.error('Wetter-Fehler:', e.message); return {}; })
  ]);

  const termineProTag = {};
  if (accessToken) {
    for (let i = 0; i < 5; i++) {
      const datum = addTage(montag, i);
      termineProTag[datum] = await getKalenderTermine(datum, accessToken).catch(e => {
        console.error(`Kalender-Fehler ${datum}:`, e.message);
        return [];
      });
      console.log(`📅 ${datum}: ${termineProTag[datum].length} Termine`);
    }
  }

  const wochenLabel = istNaechsteWoche ? 'nächste Woche' : 'diese Woche';
  let msg = `📅 <b>Wochenausblick – ${wochenLabel}</b>\n<b>${formatKurzdatum(montag)} – ${formatKurzdatum(freitag)}</b>\n\n`;

  const wochentage = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag'];
  for (let i = 0; i < 5; i++) {
    const datum   = addTage(montag, i);
    const stunden = stundenplan[datum] || [];
    const wetter  = wetterMap[datum];
    const termine = termineProTag[datum] || [];
    const wetterStr = wetter ? ` ${wetter.emoji} ↑${wetter.max}° ↓${wetter.min}°` : '';

    msg += `━━ <b>${wochentage[i]} ${formatKurzdatum(datum)}</b>${wetterStr} ━━\n`;

    if (stunden.length === 0) {
      msg += `✨ Kein Unterricht\n`;
    } else {
      for (const s of stunden) {
        const emoji = s.status === 'Ausfall' ? '❌' : s.status === 'Vertretung' ? '🔄' : s.status === 'Prüfung' ? '📝' : '✅';
        msg += `${emoji} ${s.start}–${s.ende} <b>${s.fach}</b>`;
        if (s.raum) msg += ` · ${s.raum}`;
        if (s.status === 'Ausfall') msg += ` <i>(Ausfall)</i>`;
        else if (s.status === 'Vertretung') msg += ` <i>(Vertretung)</i>`;
        else if (s.status === 'Prüfung') msg += ` <i>(Prüfung!)</i>`;
        msg += '\n';
      }
    }

    if (termine.length === 0) {
      msg += `📅 Keine Termine\n`;
    } else {
      for (const t of termine) {
        if (t.ganztag) msg += `🗓 ${t.titel} <i>(ganztägig)</i>\n`;
        else msg += `🗓 <b>${t.start}–${t.ende}</b> ${t.titel}\n`;
      }
    }
    msg += '\n';
  }

  msg += `✅ <b>Offene Aufgaben</b>\n`;
  if (todos.length === 0) {
    msg += `🎉 Alles erledigt!\n`;
  } else {
    const pEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
    for (const t of todos.slice(0, 15)) {
      msg += `${pEmoji[t.prioritaet] || '•'} ${t.title}`;
      if (t.faellig) { const d = new Date(t.faellig + 'T12:00:00'); msg += ` <i>(${d.getDate()}.${d.getMonth()+1}.)</i>`; }
      msg += '\n';
    }
    if (todos.length > 15) msg += `… und ${todos.length - 15} weitere\n`;
  }

  msg += `\n🏠 <b>Persönliche Aufgaben</b>\n`;
  if (personal.length === 0) msg += `🎉 Nichts zu erledigen!\n`;
  else for (const t of personal) msg += `☐ ${t}\n`;

  msg += `\n🚀 <i>Viel Erfolg ${wochenLabel}!</i>`;

  await sendTelegram(msg);
  console.log('✅ Wochenausblick gesendet!');
}

main().catch(err => { console.error('Fehler:', err); process.exit(1); });
