// evening-check.js – Abendlicher Schul-Check für den nächsten Tag
const https = require('https');

const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_STUNDENPLAN = process.env.NOTION_DATABASE_ID;
const NOTION_TODO_DB     = process.env.NOTION_TODO_DATABASE_ID;
const TELEGRAM_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function request(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
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
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(raw),
      ...extraHeaders
    },
    _body: raw
  });
}

function get(hostname, path) {
  return request({ hostname, path, method: 'GET' });
}

// Gibt ein Datum als YYYY-MM-DD zurück, +tage Tage ab heute (Berliner Zeit)
function datumPlus(tage) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  d.setDate(d.getDate() + tage);
  return d.toLocaleDateString('fr-CA');
}

// Nächsten Wochentag (Mo–Fr) ab einem gegebenen YYYY-MM-DD berechnen
function naechsterWochentag(vonDatum, schritte = 1) {
  const d = new Date(vonDatum + 'T12:00:00');
  d.setDate(d.getDate() + schritte);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toLocaleDateString('fr-CA');
}

// Vortag eines Datums
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

// Aktuelle Stunde in Berliner Zeit
function berlinHour() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getHours();
}

function heute() {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Berlin' });
}

// ── Zeitzonencheck: nur um 20 Uhr Berliner Zeit ───────────────────────────────

function checkUhrzeit() {
  const stunde = berlinHour();
  if (stunde !== 16) {
    console.log(`⏰ Berliner Zeit: ${stunde} Uhr – kein 16-Uhr-Slot, wird übersprungen.`);
    process.exit(0);
  }
  console.log('⏰ 16 Uhr Berlin – Abend-Check startet.');
}

// ── Ferien laden (NRW) ────────────────────────────────────────────────────────

async function ladeFerien() {
  const jahr = new Date().getFullYear();
  try {
    const [aktJahr, naechstesJahr] = await Promise.all([
      get('ferien-api.de', `/api/v1/holidays/NW/${jahr}`),
      get('ferien-api.de', `/api/v1/holidays/NW/${jahr + 1}`)
    ]);
    return [
      ...(Array.isArray(aktJahr) ? aktJahr : []),
      ...(Array.isArray(naechstesJahr) ? naechstesJahr : [])
    ];
  } catch (e) {
    console.warn('⚠️ Ferien-API nicht erreichbar.');
    return [];
  }
}

// Gibt Ferieninfo zurück wenn das Datum in Ferien liegt, sonst null
function inFerien(datum, ferienListe) {
  for (const f of ferienListe) {
    const start   = f.start.split('T')[0];
    const endExkl = f.end.split('T')[0]; // erster Schultag
    if (datum >= start && datum < endExkl) {
      const letzterTag = vortag(endExkl);
      return {
        name:       f.name,
        start,
        endExkl,
        letzterTag,
        ersterSchultag: endExkl
      };
    }
  }
  return null;
}

// Analysiert was morgen / nächsten Werktag passiert
function analysiereNaechsterTag(ferien) {
  const morgenWochentag = naechsterWochentag(heute());  // nächster Mo-Fr

  const morgenFerien = inFerien(morgenWochentag, ferien);

  // Finde ersten echten Schultag (nicht in Ferien)
  let ersterSchultag = morgenWochentag;
  let aktFerien = morgenFerien;
  let maxLoops = 60; // Sicherheitsnetz gegen Endlosschleife
  while (aktFerien && maxLoops-- > 0) {
    ersterSchultag = naechsterWochentag(ersterSchultag);
    aktFerien = inFerien(ersterSchultag, ferien);
  }

  // Ist morgen der erste Tag nach den Ferien?
  const gestrigWochentag = vortag(morgenWochentag);
  const gesternInFerien  = inFerien(gestrigWochentag, ferien);

  // Beginnen morgen Ferien? (heute letzter Schultag)
  const heuteFerien = inFerien(heute(), ferien);
  const morgenStartetFerien = !heuteFerien && morgenFerien !== null;

  return {
    morgenDatum:      morgenWochentag,
    morgenFrei:       morgenFerien !== null,
    morgenFerienInfo: morgenFerien,
    ersterSchultag,
    nachFerien:       !morgenFerien && gesternInFerien !== null,
    ferienStarten:    morgenStartetFerien
  };
}

// ── Notion ────────────────────────────────────────────────────────────────────

async function notionQuery(dbId, filter) {
  const payload = filter ? { filter } : {};
  const res = await post('api.notion.com', `/v1/databases/${dbId}/query`, payload, {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28'
  });
  if (res.object === 'error') throw new Error(res.message);
  return res.results || [];
}

async function getStundenplan(datum) {
  const rows = await notionQuery(NOTION_STUNDENPLAN, {
    property: 'Datum',
    date: { equals: datum }
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

async function getTodos(morgenDatum) {
  if (!NOTION_TODO_DB) return [];
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
      // Morgen-Fällige zuerst
      const aIstMorgen = a.faellig === morgenDatum;
      const bIstMorgen = b.faellig === morgenDatum;
      if (aIstMorgen && !bIstMorgen) return -1;
      if (!aIstMorgen && bIstMorgen) return 1;
      if (a.faellig && b.faellig) return a.faellig.localeCompare(b.faellig);
      if (a.faellig) return -1;
      if (b.faellig) return 1;
      return (prioritaetOrder[a.prioritaet] ?? 3) - (prioritaetOrder[b.prioritaet] ?? 3);
    });
}

// ── Wetter morgen (Open-Meteo, Index 1 = morgen) ─────────────────────────────

async function getWetterMorgen() {
  const res = await get('api.open-meteo.com', [
    '/v1/forecast',
    '?latitude=51.5136&longitude=7.4653',
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode',
    '&timezone=Europe%2FBerlin&forecast_days=2'
  ].join(''));

  const codes = {
    0:'☀️ Klar', 1:'🌤️ Überwiegend klar', 2:'⛅ Teilweise bewölkt', 3:'☁️ Bedeckt',
    45:'🌫️ Nebel', 48:'🌫️ Raureif-Nebel',
    51:'🌦️ Nieselregen', 53:'🌦️ Nieselregen', 55:'🌧️ Starker Nieselregen',
    61:'🌧️ Leichter Regen', 63:'🌧️ Regen', 65:'🌧️ Starker Regen',
    71:'❄️ Leichter Schnee', 73:'❄️ Schnee', 75:'❄️ Starker Schnee',
    80:'🌦️ Schauer', 81:'🌧️ Schauer', 82:'⛈️ Starke Schauer',
    95:'⛈️ Gewitter', 96:'⛈️ Gewitter mit Hagel', 99:'⛈️ Schweres Gewitter'
  };

  // Index 1 = morgen
  const daily = res.daily;
  return {
    desc: codes[daily?.weathercode?.[1]] ?? '🌡️',
    max:  Math.round(daily?.temperature_2m_max?.[1] ?? 0),
    min:  Math.round(daily?.temperature_2m_min?.[1] ?? 0),
    rain: (daily?.precipitation_sum?.[1] ?? 0).toFixed(1)
  };
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  return post('api.telegram.org', `/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML'
  });
}

// ── Hauptprogramm ─────────────────────────────────────────────────────────────

async function main() {
  // 1. Nur um 20 Uhr Berliner Zeit
  checkUhrzeit();

  // 2. Ferien laden & analysieren
  const ferienListe  = await ladeFerien();
  const naechsterTag = analysiereNaechsterTag(ferienListe);

  console.log('📅 Nächster Tag:', naechsterTag.morgenDatum,
    naechsterTag.morgenFrei ? '(Ferien)' : '(Schultag)');

  // 3. Daten für den relevanten Schultag abrufen
  const zielDatum = naechsterTag.ersterSchultag;

  const [stunden, todos, w] = await Promise.all([
    getStundenplan(zielDatum).catch(e => { console.error('Stundenplan-Fehler:', e.message); return []; }),
    getTodos(naechsterTag.morgenDatum).catch(e => { console.error('Todo-Fehler:', e.message); return []; }),
    getWetterMorgen().catch(e => { console.error('Wetter-Fehler:', e.message); return null; })
  ]);

  // 4. Nachricht aufbauen
  let msg = `🌙 <b>Abend-Check – Ausblick auf morgen</b>\n\n`;

  // ── Ferienhinweis ──
  if (naechsterTag.ferienStarten) {
    // Heute letzter Schultag, morgen beginnen Ferien
    const fi = naechsterTag.morgenFerienInfo;
    const letzterFerientag = fi ? fi.letzterTag : '';
    const d = letzterFerientag ? new Date(letzterFerientag + 'T12:00:00') : null;
    const bisStr = d ? `bis ${d.getDate()}.${d.getMonth() + 1}.` : '';
    msg += `🏖️ <b>Morgen beginnen die ${fi?.name ?? 'Ferien'}!</b> ${bisStr}\n`;
    msg += `Erster Schultag danach: <b>${formatDatum(zielDatum)}</b>\n\n`;

  } else if (naechsterTag.morgenFrei) {
    // Morgen ist Ferientag
    const fi = naechsterTag.morgenFerienInfo;
    const d  = fi ? new Date(fi.letzterTag + 'T12:00:00') : null;
    const bisStr = d ? `bis ${d.getDate()}.${d.getMonth() + 1}.` : '';
    msg += `🏖️ <b>Morgen schulfrei!</b> ${fi?.name ?? 'Ferien'} ${bisStr}\n`;
    if (zielDatum !== naechsterTag.morgenDatum) {
      msg += `📅 Nächster Schultag: <b>${formatDatum(zielDatum)}</b>\n`;
    }
    msg += '\n';

  } else if (naechsterTag.nachFerien) {
    // Morgen ist erster Schultag nach Ferien
    msg += `⚠️ <b>Morgen geht's wieder los nach den Ferien!</b>\n`;
    msg += `📅 <b>${formatDatum(zielDatum)}</b>\n\n`;

  } else {
    // Normaler nächster Schultag
    msg += `📅 <b>${formatDatum(zielDatum)}</b>\n\n`;
  }

  // ── Wetter morgen ──
  if (w) {
    msg += `🌤️ <b>Wetter Dortmund morgen</b>\n`;
    msg += `${w.desc}\n`;
    msg += `↑ ${w.max}° ↓ ${w.min}°  ·  💧 ${w.rain} mm\n\n`;
  }

  // ── Stundenplan ──
  msg += `📚 <b>Stundenplan ${formatDatum(zielDatum)}</b>\n`;
  if (stunden.length === 0) {
    msg += `✨ Kein Unterricht eingetragen\n`;
  } else {
    for (const s of stunden) {
      const emoji = s.status.includes('Ausfall')    ? '❌'
                  : s.status.includes('Vertretung') ? '🔄'
                  : '✅';
      msg += `${emoji} <b>${s.start}–${s.ende}</b> ${s.fach}`;
      if (s.raum) msg += ` · ${s.raum}`;
      if (s.status.includes('Ausfall'))         msg += ` <i>(Ausfall)</i>`;
      else if (s.status.includes('Vertretung')) msg += ` <i>(Vertretung)</i>`;
      msg += '\n';
    }
  }

  // ── To-Dos ──
  msg += `\n✅ <b>Offene Aufgaben</b>\n`;
  if (todos.length === 0) {
    msg += `🎉 Alles erledigt!\n`;
  } else {
    const prioritaetEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
    for (const t of todos.slice(0, 20)) {
      const prio = prioritaetEmoji[t.prioritaet] || '•';
      msg += `${prio} ${t.title}`;
      if (t.faellig === naechsterTag.morgenDatum) {
        msg += ` <b>⚠️ morgen fällig!</b>`;
      } else if (t.faellig) {
        const d = new Date(t.faellig + 'T12:00:00');
        msg += ` <i>(fällig ${d.getDate()}.${d.getMonth() + 1}.)</i>`;
      }
      msg += '\n';
    }
    if (todos.length > 20) msg += `… und ${todos.length - 20} weitere\n`;
  }

  msg += `\n🌙 <i>Schönen Nachmittag!</i>`;

  // 5. Senden
  const result = await sendTelegram(msg);
  if (result.ok) {
    console.log('✅ Abend-Check erfolgreich gesendet!');
  } else {
    console.error('❌ Telegram-Fehler:', JSON.stringify(result));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unbekannter Fehler:', err);
  process.exit(1);
});
