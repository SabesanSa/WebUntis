// Cloudflare Worker – Telegram Bot für Schul-Abfragen
// Umgebungsvariablen (in Cloudflare Dashboard setzen):
//   NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_TODO_DATABASE_ID,
//   NOTION_PERSONAL_DB_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//   GITHUB_TOKEN, GITHUB_USERNAME

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');

    try {
      const body = await request.json();
      const message = body.message || body.edited_message;
      if (!message?.text) return new Response('OK');

      const chatId = String(message.chat.id);
      const text   = message.text.trim();

      if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
        return new Response('OK');
      }

      await handleNachricht(env, chatId, text);
    } catch (e) {
      console.error('Worker-Fehler:', e);
    }

    return new Response('OK');
  }
};

async function handleNachricht(env, chatId, text) {
  const t = text.toLowerCase().trim();

  if (t === 'todos' || t === '/todos') {
    await sendeTodos(env, chatId);
    return;
  }

  if (t === 'schulcheck' || t === '/schulcheck' || t === 'check') {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_USERNAME}/WebUntis/actions/workflows/morning-check.yml/dispatches`,
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
      await sendeTelegram(env, chatId, '⏳ Schulcheck wird gestartet – Nachricht kommt in ~30 Sekunden!');
    } else {
      await sendeTelegram(env, chatId, '❌ Schulcheck konnte nicht gestartet werden.');
    }
    return;
  }

  if (t === 'wochencheck' || t === '/wochencheck' || t === 'diese woche') {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_USERNAME}/WebUntis/actions/workflows/week-check.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'schul-bot'
        },
        body: JSON.stringify({ ref: 'main', inputs: { woche: 'diese' } })
      }
    );
    if (res.status === 204) {
      await sendeTelegram(env, chatId, '📅 Wochencheck (diese Woche) wird gestartet – Nachricht kommt in ~30 Sekunden!');
    } else {
      await sendeTelegram(env, chatId, '❌ Wochencheck konnte nicht gestartet werden.');
    }
    return;
  }

  if (t === 'nächstewoche' || t === 'naechstewoche' || t === 'nächste woche' || t === '/nächstewoche') {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_USERNAME}/WebUntis/actions/workflows/week-check.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'schul-bot'
        },
        body: JSON.stringify({ ref: 'main', inputs: { woche: 'nächste' } })
      }
    );
    if (res.status === 204) {
      await sendeTelegram(env, chatId, '📅 Wochencheck (nächste Woche) wird gestartet – Nachricht kommt in ~30 Sekunden!');
    } else {
      await sendeTelegram(env, chatId, '❌ Wochencheck konnte nicht gestartet werden.');
    }
    return;
  }

  if (t === 'hilfe' || t === '/hilfe' || t === '/start' || t === '/help') {
    await sendeTelegram(env, chatId, hilfeText());
    return;
  }

  const datum = parseDatum(t);
  if (!datum) {
    await sendeTelegram(env, chatId,
      `❓ Ich verstehe das nicht.\n\nSchreib z.B.:\n• <b>heute</b>\n• <b>morgen</b>\n• <b>Donnerstag</b>\n• <b>27.5.</b>\n• <b>todos</b>\n• <b>schulcheck</b>\n• <b>wochencheck</b>\n• <b>nächste Woche</b>\n• <b>hilfe</b>`
    );
    return;
  }

  await sendeStundenplan(env, chatId, datum);
}

function berlinHeute() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
}

function fmt(d) {
  return d.toLocaleDateString('fr-CA');
}

function formatAnzeige(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const wochentage = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const monate = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return `${wochentage[d.getDay()]}, ${d.getDate()}. ${monate[d.getMonth()]}`;
}

function parseDatum(t) {
  const heute = berlinHeute();

  if (t === 'heute')       return fmt(heute);
  if (t === 'morgen') {
    const m = new Date(heute); m.setDate(m.getDate() + 1); return fmt(m);
  }
  if (t === 'übermorgen' || t === 'uebermorgen') {
    const m = new Date(heute); m.setDate(m.getDate() + 2); return fmt(m);
  }

  const wochentage = {
    'montag': 1, 'mo': 1,
    'dienstag': 2, 'di': 2,
    'mittwoch': 3, 'mi': 3,
    'donnerstag': 4, 'do': 4,
    'freitag': 5, 'fr': 5,
    'samstag': 6, 'sa': 6,
  };

  if (wochentage[t] !== undefined) {
    const ziel = wochentage[t];
    const heuteTag = heute.getDay();
    let diff = ziel - heuteTag;
    if (diff < 0) diff += 7;
    const d = new Date(heute);
    d.setDate(heute.getDate() + diff);
    return fmt(d);
  }

  const match = t.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
  if (match) {
    const tag   = parseInt(match[1]);
    const monat = parseInt(match[2]) - 1;
    const jahr  = match[3] ? parseInt(match[3]) : heute.getFullYear();
    const d = new Date(jahr, monat, tag);
    if (!isNaN(d.getTime())) return fmt(d);
  }

  return null;
}

async function notionQuery(env, dbId, filter) {
  const payload = filter ? { filter, page_size: 100 } : { page_size: 100 };
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.object === 'error') throw new Error(data.message);
  return data.results || [];
}

async function sendeStundenplan(env, chatId, datum) {
  const rows = await notionQuery(env, env.NOTION_DATABASE_ID, {
    property: 'Datum',
    date: { equals: datum }
  });

  const stunden = rows.map(page => {
    const p = page.properties;
    return {
      fach:   p.Fach?.title?.[0]?.plain_text || '?',
      start:  p.Startzeit?.rich_text?.[0]?.plain_text || '',
      ende:   p.Endzeit?.rich_text?.[0]?.plain_text || '',
      raum:   p.Raum?.rich_text?.[0]?.plain_text || '',
      status: p.Status?.select?.name || 'Normal'
    };
  }).sort((a, b) => a.start.localeCompare(b.start));

  let msg = `📚 <b>Stundenplan – ${formatAnzeige(datum)}</b>\n\n`;

  if (stunden.length === 0) {
    msg += `✨ Kein Unterricht – freier Tag!`;
  } else {
    for (const s of stunden) {
      const emoji = s.status === 'Ausfall'    ? '❌'
                  : s.status === 'Vertretung' ? '🔄'
                  : s.status === 'Prüfung'    ? '📝'
                  : '✅';
      msg += `${emoji} <b>${s.start}–${s.ende}</b> ${s.fach}`;
      if (s.raum) msg += ` · ${s.raum}`;
      if (s.status === 'Ausfall')    msg += ` <i>(Ausfall)</i>`;
      if (s.status === 'Vertretung') msg += ` <i>(Vertretung)</i>`;
      if (s.status === 'Prüfung')    msg += ` <i>(Prüfung!)</i>`;
      msg += '\n';
    }
  }

  await sendeTelegram(env, chatId, msg);
}

async function sendeTodos(env, chatId) {
  let msg = `✅ <b>Offene Schulaufgaben</b>\n\n`;

  if (env.NOTION_TODO_DATABASE_ID) {
    const rows = await notionQuery(env, env.NOTION_TODO_DATABASE_ID, {
      property: 'Status',
      select: { does_not_equal: 'Erledigt' }
    });

    const pOrder = { 'Hoch': 0, 'Mittel': 1, 'Niedrig': 2 };
    const todos = rows
      .map(p => ({
        title:      p.properties['Aufgabe']?.title?.[0]?.plain_text || '',
        prioritaet: p.properties['Priorität']?.select?.name || '',
        faellig:    p.properties['Fällig']?.date?.start || ''
      }))
      .filter(t => t.title)
      .sort((a, b) => {
        if (a.faellig && b.faellig) return a.faellig.localeCompare(b.faellig);
        if (a.faellig) return -1;
        if (b.faellig) return 1;
        return (pOrder[a.prioritaet] ?? 3) - (pOrder[b.prioritaet] ?? 3);
      });

    if (todos.length === 0) {
      msg += `🎉 Alle Schulaufgaben erledigt!\n`;
    } else {
      const pEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
      for (const t of todos.slice(0, 20)) {
        msg += `${pEmoji[t.prioritaet] || '•'} ${t.title}`;
        if (t.faellig) {
          const d = new Date(t.faellig + 'T12:00:00');
          msg += ` <i>(${d.getDate()}.${d.getMonth()+1}.)</i>`;
        }
        msg += '\n';
      }
    }
  }

  if (env.NOTION_PERSONAL_DB_ID) {
    const rows = await notionQuery(env, env.NOTION_PERSONAL_DB_ID, {
      property: 'Erledigt',
      checkbox: { equals: false }
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

async function sendeTelegram(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

function hilfeText() {
  return `🤖 <b>Schul-Bot – Befehle</b>

📅 <b>Stundenplan:</b>
• <b>heute</b> – heutiger Plan
• <b>morgen</b> – morgiger Plan
• <b>Montag</b> / <b>Mo</b> – nächster Montag
• <b>Dienstag</b> / <b>Di</b>
• <b>Mittwoch</b> / <b>Mi</b>
• <b>Donnerstag</b> / <b>Do</b>
• <b>Freitag</b> / <b>Fr</b>
• <b>27.5.</b> – konkretes Datum

✅ <b>Aufgaben:</b>
• <b>todos</b> – alle offenen Aufgaben

🔄 <b>Checks:</b>
• <b>schulcheck</b> – Tages-Check jetzt ausführen
• <b>wochencheck</b> – Wochencheck diese Woche
• <b>nächste Woche</b> – Wochencheck nächste Woche

❓ <b>hilfe</b> – diese Übersicht`;
}
