// morning-check.js – Täglicher Schul-Check via Telegram
const https = require('https');

const NOTION_TOKEN         = process.env.NOTION_TOKEN;
const NOTION_STUNDENPLAN   = process.env.NOTION_DATABASE_ID;
const NOTION_TODO_DB       = process.env.NOTION_TODO_DATABASE_ID;
const TELEGRAM_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID     = process.env.TELEGRAM_CHAT_ID;

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Gibt "YYYY-MM-DD" in der Berliner Zeitzone zurück
function today() {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Berlin' });
}

function formatDate() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const wochentage = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const monate = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return `${wochentage[d.getDay()]}, ${d.getDate()}. ${monate[d.getMonth()]}`;
}

// ── Notion ─────────────────────────────────────────────────────────────────────

async function notionQuery(dbId, filter) {
  const payload = filter ? { filter } : {};
  const body = JSON.stringify(payload);
  const res = await request({
    hostname: 'api.notion.com',
    path: `/v1/databases/${dbId}/query`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  if (res.object === 'error') throw new Error(res.message);
  return res.results || [];
}

async function getStundenplan() {
  const rows = await notionQuery(NOTION_STUNDENPLAN, {
    property: 'Datum',
    date: { equals: today() }
  });
  return rows.map(page => {
    const p = page.properties;
    return {
      fach:   p.Fach?.title?.[0]?.plain_text || '?',
      start:  p.Startzeit?.rich_text?.[0]?.plain_text || '',
      ende:   p.Endzeit?.rich_text?.[0]?.plain_text || '',
      raum:   p.Raum?.rich_text?.[0]?.plain_text || '',
      status: p.Status?.select?.name || 'Normal 🟢'
    };
  }).sort((a, b) => a.start.localeCompare(b.start));
}

async function getTodos() {
  if (!NOTION_TODO_DB) return [];

  // Nur nicht-erledigte Aufgaben abrufen (Status != "Erledigt")
  const rows = await notionQuery(NOTION_TODO_DB, {
    property: 'Status',
    select: { does_not_equal: 'Erledigt' }
  });

  const prioritaetOrder = { 'Hoch': 0, 'Mittel': 1, 'Niedrig': 2, '': 3 };

  return rows
    .map(page => {
      const p = page.properties;
      return {
        title:      p['Aufgabe']?.title?.[0]?.plain_text || '',
        status:     p.Status?.select?.name || '',
        prioritaet: p['Priorität']?.select?.name || '',
        faellig:    p['Fällig']?.date?.start || ''
      };
    })
    .filter(t => t.title.length > 0)
    .sort((a, b) => {
      // Sortierung: zuerst nach Fälligkeit, dann nach Priorität
      if (a.faellig && b.faellig) return a.faellig.localeCompare(b.faellig);
      if (a.faellig) return -1;
      if (b.faellig) return 1;
      return (prioritaetOrder[a.prioritaet] ?? 3) - (prioritaetOrder[b.prioritaet] ?? 3);
    });
}

// ── Wetter (Open-Meteo, kostenlos, kein API-Key) ───────────────────────────────

async function getWetter() {
  // Dortmund: 51.5136° N, 7.4653° O
  const res = await request({
    hostname: 'api.open-meteo.com',
    path: [
      '/v1/forecast',
      '?latitude=51.5136&longitude=7.4653',
      '&current=temperature_2m,weathercode,windspeed_10m',
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum',
      '&timezone=Europe%2FBerlin&forecast_days=1'
    ].join(''),
    method: 'GET'
  });

  const codes = {
    0:'☀️ Klar', 1:'🌤️ Überwiegend klar', 2:'⛅ Teilweise bewölkt', 3:'☁️ Bedeckt',
    45:'🌫️ Nebel', 48:'🌫️ Raureif-Nebel',
    51:'🌦️ Nieselregen', 53:'🌦️ Nieselregen', 55:'🌧️ Starker Nieselregen',
    61:'🌧️ Leichter Regen', 63:'🌧️ Regen', 65:'🌧️ Starker Regen',
    71:'❄️ Leichter Schnee', 73:'❄️ Schnee', 75:'❄️ Starker Schnee',
    80:'🌦️ Schauer', 81:'🌧️ Schauer', 82:'⛈️ Starke Schauer',
    95:'⛈️ Gewitter', 96:'⛈️ Gewitter mit Hagel', 99:'⛈️ Schweres Gewitter'
  };

  return {
    desc: codes[res.current?.weathercode] ?? '🌡️',
    temp: Math.round(res.current?.temperature_2m ?? 0),
    wind: Math.round(res.current?.windspeed_10m ?? 0),
    max:  Math.round(res.daily?.temperature_2m_max?.[0] ?? 0),
    min:  Math.round(res.daily?.temperature_2m_min?.[0] ?? 0),
    rain: (res.daily?.precipitation_sum?.[0] ?? 0).toFixed(1)
  };
}

// ── Telegram ───────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML'
  });
  return request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
}

// ── Hauptprogramm ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🌅 Schul-Check startet...');

  const [stunden, todos, w] = await Promise.all([
    getStundenplan().catch(e => { console.error('Stundenplan-Fehler:', e.message); return []; }),
    getTodos().catch(e => { console.error('Todo-Fehler:', e.message); return []; }),
    getWetter().catch(e => { console.error('Wetter-Fehler:', e.message); return null; })
  ]);

  // ── Nachricht zusammenbauen ─────────────────────────────────────────────────
  let msg = `🎒 <b>Schul-Check – ${formatDate()}</b>\n\n`;

  // Wetter
  if (w) {
    msg += `🌤️ <b>Wetter Dortmund</b>\n`;
    msg += `${w.desc} · <b>${w.temp}°C</b>\n`;
    msg += `↑ ${w.max}° ↓ ${w.min}°  ·  💧 ${w.rain} mm  ·  💨 ${w.wind} km/h\n\n`;
  }

  // Stundenplan
  msg += `📚 <b>Stundenplan heute</b>\n`;
  if (stunden.length === 0) {
    msg += `✨ Kein Unterricht – freier Tag!\n`;
  } else {
    for (const s of stunden) {
      const emoji = s.status.includes('Ausfall')     ? '❌'
                  : s.status.includes('Vertretung')  ? '🔄'
                  : '✅';
      msg += `${emoji} <b>${s.start}–${s.ende}</b> ${s.fach}`;
      if (s.raum) msg += ` · ${s.raum}`;
      if (s.status.includes('Ausfall'))    msg += ` <i>(Ausfall)</i>`;
      else if (s.status.includes('Vertretung')) msg += ` <i>(Vertretung)</i>`;
      msg += '\n';
    }
  }

  // To-Dos
  msg += `\n✅ <b>Offene Aufgaben</b>\n`;
  if (todos.length === 0) {
    msg += `🎉 Alles erledigt!\n`;
  } else {
    const prioritaetEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
    for (const t of todos.slice(0, 8)) {
      const prio = prioritaetEmoji[t.prioritaet] || '•';
      msg += `${prio} ${t.title}`;
      if (t.faellig) {
        const d = new Date(t.faellig);
        msg += ` <i>(fällig ${d.getDate()}.${d.getMonth()+1}.)</i>`;
      }
      msg += '\n';
    }
    if (todos.length > 8) msg += `… und ${todos.length - 8} weitere\n`;
  }

  msg += `\n🚀 <i>Guten Schultag!</i>`;

  // Senden
  const result = await sendTelegram(msg);
  if (result.ok) {
    console.log('✅ Schul-Check erfolgreich gesendet!');
  } else {
    console.error('❌ Telegram-Fehler:', JSON.stringify(result));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unbekannter Fehler:', err);
  process.exit(1);
});
