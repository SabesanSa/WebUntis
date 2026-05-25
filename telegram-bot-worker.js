// Cloudflare Worker – Telegram Bot für Schul-Abfragen
// Secrets: NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_TODO_DATABASE_ID,
//          NOTION_PERSONAL_DB_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//          GITHUB_TOKEN, GITHUB_USERNAME, GOOGLE_SERVICE_ACCOUNT_JSON

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');
    try {
      const body = await request.json();
      const message = body.message || body.edited_message;
      if (!message?.text) return new Response('OK');
      const chatId = String(message.chat.id);
      const text   = message.text.trim();
      if (chatId !== String(env.TELEGRAM_CHAT_ID)) return new Response('OK');
      await handleNachricht(env, chatId, text);
    } catch (e) {
      console.error('Worker-Fehler:', e);
    }
    return new Response('OK');
  }
};

async function handleNachricht(env, chatId, text) {
  const t = text.toLowerCase().trim();

  // ── Todos ──────────────────────────────────────────────────────────────────
  if (t === 'todos' || t === '/todos') {
    await sendeTodos(env, chatId);
    return;
  }

  // ── Schulcheck (morning-check.yml) ────────────────────────────────────────
  if (t === 'schulcheck' || t === '/schulcheck' || t === 'check') {
    await triggerWorkflow(env, chatId, 'morning-check.yml',
      '⏳ Schulcheck wird gestartet – Nachricht kommt in ~30 Sekunden!');
    return;
  }

  // ── Moodle-Check (moodle-check.yml) ───────────────────────────────────────
  if (t === 'moodle' || t === '/moodle') {
    await triggerWorkflow(env, chatId, 'moodle-check.yml',
      '⏳ Moodle wird geprüft – neue Dateien landen gleich in Google Drive!');
    return;
  }

  // ── Hilfe ──────────────────────────────────────────────────────────────────
  if (t === 'hilfe' || t === '/hilfe' || t === '/start' || t === '/help') {
    await sendeTelegram(env, chatId, hilfeText());
    return;
  }

  // ── Stundenplan-Abfragen ───────────────────────────────────────────────────
  const datum = parseDatum(t);
  if (!datum) {
    await sendeTelegram(env, chatId,
      `❓ Ich verstehe das nicht.\n\nSchreib z.B. <b>heute</b>, <b>morgen</b>, <b>Montag</b> oder <b>hilfe</b>.`);
    return;
  }
  await sendeStundenplan(env, chatId, datum);
}

// ── GitHub Actions Trigger ────────────────────────────────────────────────────

async function triggerWorkflow(env, chatId, workflow, erfolgText) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_USERNAME}/WebUntis/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'schul-bot'
      },
      body: JSON.stringify({ ref: 'main' })
    }
  );
  if (res.status === 204) {
    await sendeTelegram(env, chatId, erfolgText);
  } else {
    const fehler = await res.text();
    await sendeTelegram(env, chatId, `❌ Fehler beim Starten (${res.status}): ${fehler}`);
  }
}

// ── Todos ─────────────────────────────────────────────────────────────────────

async function sendeTodos(env, chatId) {
  let msg = '✅ <b>Offene Aufgaben</b>\n\n';

  // Schulaufgaben
  if (env.NOTION_TODO_DATABASE_ID) {
    const rows = await notionQuery(env, env.NOTION_TODO_DATABASE_ID, {
      property: 'Erledigt', checkbox: { equals: false }
    });
    const schule = rows.map(p => {
      const aufgabe  = p.properties['Aufgabe']?.title?.[0]?.plain_text || '';
      const fach     = p.properties['Fach']?.select?.name || '';
      const faellig  = p.properties['Fällig']?.date?.start || '';
      return { aufgabe, fach, faellig };
    }).filter(a => a.aufgabe);

    if (schule.length > 0) {
      msg += `🏫 <b>Schulaufgaben</b>\n`;
      for (const a of schule) {
        let zeile = `☐ ${a.aufgabe}`;
        if (a.fach)    zeile += ` <i>(${a.fach})</i>`;
        if (a.faellig) zeile += ` – ${formatDatum(a.faellig)}`;
        msg += zeile + '\n';
      }
    }
  }

  // Persönliche Aufgaben
  if (env.NOTION_PERSONAL_DB_ID) {
    const rows = await notionQuery(env, env.NOTION_PERSONAL_DB_ID, {
      property: 'Erledigt', checkbox: { equals: false }
    });
    const personal = rows
      .map(p => p.properties['Aufgabe']?.title?.[0]?.plain_text || '')
      .filter(t => t.length > 0);

    if (personal.length > 0) {
      msg += `\n🏠 <b>Persönliche Aufgaben</b>\n`;
      for (const t of personal) msg += `☐ ${t}\n`;
    }
  }

  await sendeTelegram(env, chatId, msg);
}

// ── Stundenplan ───────────────────────────────────────────────────────────────

async function sendeStundenplan(env, chatId, datum) {
  const rows = await notionQuery(env, env.NOTION_DATABASE_ID, {
    property: 'Datum', date: { equals: datum }
  });

  const wochentage = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const d = new Date(datum + 'T12:00:00Z');
  const tagName = wochentage[d.getUTCDay()];
  const [j, mo, t2] = datum.split('-');
  const datumAnzeige = `${t2}.${mo}.${j}`;

  if (rows.length === 0) {
    await sendeTelegram(env, chatId, `📅 <b>${tagName}, ${datumAnzeige}</b>\n\nKeine Einträge.`);
    return;
  }

  let msg = `📅 <b>${tagName}, ${datumAnzeige}</b>\n\n`;
  for (const r of rows) {
    const fach    = r.properties['Fach']?.select?.name || '–';
    const von     = r.properties['Von']?.rich_text?.[0]?.plain_text || '';
    const bis     = r.properties['Bis']?.rich_text?.[0]?.plain_text || '';
    const raum    = r.properties['Raum']?.rich_text?.[0]?.plain_text || '';
    const hinweis = r.properties['Hinweis']?.rich_text?.[0]?.plain_text || '';
    msg += `• <b>${fach}</b>`;
    if (von && bis) msg += ` ${von}–${bis}`;
    if (raum)       msg += ` | ${raum}`;
    if (hinweis)    msg += `\n  <i>${hinweis}</i>`;
    msg += '\n';
  }
  await sendeTelegram(env, chatId, msg);
}

// ── Notion Helper ─────────────────────────────────────────────────────────────

async function notionQuery(env, databaseId, filter) {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ filter: { property: filter.property, ...filter } })
  });
  const data = await res.json();
  return data.results || [];
}

// ── Datum parsen ──────────────────────────────────────────────────────────────

function parseDatum(text) {
  const heute = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const t = text.toLowerCase().trim();

  if (t === 'heute')  return formatISO(heute);
  if (t === 'morgen') return formatISO(new Date(heute.getTime() + 86400000));

  const wochentage = { mo: 1, montag: 1, di: 2, dienstag: 2, mi: 3, mittwoch: 3,
                        do: 4, donnerstag: 4, fr: 5, freitag: 5 };
  if (wochentage[t] !== undefined) {
    const ziel = wochentage[t];
    let d = new Date(heute);
    let versuche = 0;
    do { d = new Date(d.getTime() + 86400000); versuche++; }
    while (d.getDay() !== ziel && versuche < 8);
    return formatISO(d);
  }

  // TT.MM. oder TT.MM.JJJJ
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
  if (m) {
    const jahr = m[3] || String(heute.getFullYear());
    return `${jahr}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return null;
}

function formatISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDatum(iso) {
  const [j, m, t] = iso.split('-');
  return `${t}.${m}.${j}`;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendeTelegram(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── Hilfetext ─────────────────────────────────────────────────────────────────

function hilfeText() {
  return `🤖 <b>Schul-Bot – Befehle</b>

📅 <b>Stundenplan:</b>
• <b>heute</b> – heutiger Plan
• <b>morgen</b> – morgiger Plan
• <b>Montag</b> / <b>Mo</b>
• <b>Dienstag</b> / <b>Di</b>
• <b>Mittwoch</b> / <b>Mi</b>
• <b>Donnerstag</b> / <b>Do</b>
• <b>Freitag</b> / <b>Fr</b>
• <b>27.5.</b> – konkretes Datum

✅ <b>Aufgaben:</b>
• <b>todos</b> – alle offenen Aufgaben

🔄 <b>Checks:</b>
• <b>schulcheck</b> – Morgen-Check jetzt starten
• <b>moodle</b> – Moodle auf neue Dateien prüfen

❓ <b>hilfe</b> – diese Übersicht`;
}
