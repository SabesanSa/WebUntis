// Cloudflare Worker – Telegram Bot + Moodle-Proxy für Schul-Abfragen
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Moodle-Proxy-Routen (/moodle/*) ────────────────────────────────────────
    if (url.pathname.startsWith('/moodle/')) {
      return handleMoodleRequest(request, env, url);
    }

    // ── Telegram-Bot ────────────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// MOODLE-PROXY
// ══════════════════════════════════════════════════════════════════════════════

// ── SimpleCookieJar (ohne tough-cookie, für Cloudflare Workers) ───────────────

class SimpleCookieJar {
  constructor() { this._cookies = {}; /* domain -> [{name,value,path}] */ }

  addCookie(setCookieStr, requestUrl) {
    if (!setCookieStr) return;
    const domain = new URL(requestUrl).hostname;
    const parts  = setCookieStr.split(';');
    const nv     = parts[0].trim();
    const eq     = nv.indexOf('=');
    if (eq === -1) return;
    const name  = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();

    let cookieDomain = domain, path = '/';
    for (const attr of parts.slice(1)) {
      const a = attr.trim();
      if (/^domain=/i.test(a)) {
        let d = a.slice(7).trim();
        if (d.startsWith('.')) d = d.slice(1);
        cookieDomain = d;
      }
      if (/^path=/i.test(a)) path = a.slice(5).trim();
    }

    if (!this._cookies[cookieDomain]) this._cookies[cookieDomain] = [];
    this._cookies[cookieDomain] = this._cookies[cookieDomain].filter(c => c.name !== name);
    if (value !== '') this._cookies[cookieDomain].push({ name, value, path });
  }

  getCookieString(url) {
    const hostname = new URL(url).hostname;
    const result   = [];
    for (const [d, cookies] of Object.entries(this._cookies)) {
      if (hostname === d || hostname.endsWith('.' + d)) {
        for (const c of cookies) result.push(`${c.name}=${c.value}`);
      }
    }
    return result.join('; ');
  }
}

function decodeEntities(str) {
  return (str ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16))) // hex: &#x2f; → /
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));                        // dezimal: &#47; → /
}

// ── proxyFetch – fetch() mit manuellem Redirect-Follow und CookieJar ──────────

async function proxyFetch(jar, url, method = 'GET', extraHeaders = {}, body = null, maxRedirects = 15) {
  let currentUrl    = url;
  let currentMethod = method;
  let currentBody   = body;
  let redirects     = 0;

  const baseHeaders = {
    'User-Agent':              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language':         'de-DE,de;q=0.9,en;q=0.8',
    'Upgrade-Insecure-Requests': '1',
  };

  while (redirects <= maxRedirects) {
    const cookieStr = jar.getCookieString(currentUrl);
    const headers   = { ...baseHeaders, ...extraHeaders };
    if (cookieStr) headers['Cookie'] = cookieStr;

    const resp = await fetch(currentUrl, {
      method:   currentMethod,
      headers,
      body:     currentBody || undefined,
      redirect: 'manual',
    });

    // Set-Cookie sammeln (Cloudflare-spezifisch: getAll('set-cookie'))
    try {
      for (const sc of resp.headers.getAll('set-cookie')) jar.addCookie(sc, currentUrl);
    } catch {
      const sc = resp.headers.get('set-cookie');
      if (sc) jar.addCookie(sc, currentUrl);
    }

    const status = resp.status;
    if ([301, 302, 303, 307, 308].includes(status) && redirects < maxRedirects) {
      const loc = resp.headers.get('location');
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      if (status <= 303) { currentMethod = 'GET'; currentBody = null; }
      redirects++;
      continue;
    }

    return { url: currentUrl, status, body: await resp.text() };
  }
  throw new Error(`Zu viele Weiterleitungen (${redirects})`);
}

// ── Sesskey / UserId extrahieren ──────────────────────────────────────────────

function extractSesskey(html) {
  const patterns = [
    /"sesskey"\s*:\s*"([a-zA-Z0-9]+)"/,
    /<input[^>]+name=["']sesskey["'][^>]+value=["']([a-zA-Z0-9]+)["']/i,
    /sesskey["']\s*:\s*["']([a-zA-Z0-9]{10,})["']/,
  ];
  for (const p of patterns) { const m = html.match(p); if (m?.[1]) return m[1]; }
  return null;
}

function extractUserId(html) {
  const m = html.match(/"userid"\s*:\s*(\d+)/) ?? html.match(/data-userid=["'](\d+)["']/i);
  return m ? +m[1] : 0;
}

// ── Logineo SSO (vollständiger SAML-2.0-Flow) ─────────────────────────────────

async function doLogineoLogin(env) {
  const MOODLE_URL = (env.MOODLE_URL ?? '').replace(/\/$/, '');
  const jar        = new SimpleCookieJar();

  // Schritt 1: GET Moodle-Login → folgt Redirects zum Logineo-IdP
  const r1     = await proxyFetch(jar, `${MOODLE_URL}/login/index.php`);
  const idpBase = new URL(r1.url).origin;
  const html1  = r1.body;

  const csrfM = html1.match(/<input[^>]+name=["']csrf_token["'][^>]+value=["']([^"']+)["']/i)
             ?? html1.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']csrf_token["']/i);
  const csrf  = csrfM?.[1] ?? '';

  const actionM = html1.match(/<form[^>]+action=["']([^"']+)["']/i);
  let   action  = decodeEntities(actionM?.[1] ?? '');
  if (action && !action.startsWith('http')) action = idpBase + action;
  if (!action) throw new Error('[Login] Kein Login-Formular gefunden');

  await new Promise(r => setTimeout(r, 500));

  // Schritt 2: Credentials an Logineo-IdP
  const r2   = await proxyFetch(jar, action, 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer':           r1.url,
    'Origin':            idpBase,
    'Sec-Fetch-Dest':   'document',
    'Sec-Fetch-Mode':   'navigate',
    'Sec-Fetch-Site':   'same-origin',
    'Sec-Fetch-User':   '?1',
  }, new URLSearchParams({
    csrf_token: csrf, j_username: env.MOODLE_USERNAME, j_password: env.MOODLE_PASSWORD, _eventId_proceed: '',
  }).toString());

  const html2 = r2.body;
  const samlM = html2.match(/<input[^>]+name=["']SAMLResponse["'][^>]+value=["']([^"']+)["']/i)
             ?? html2.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']SAMLResponse["']/i);
  const relayM = html2.match(/<input[^>]+name=["']RelayState["'][^>]+value=["']([^"']+)["']/i)
              ?? html2.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']RelayState["']/i);
  const acsM  = html2.match(/<form[^>]+action=["']([^"']+)["']/i);

  if (!samlM?.[1]) {
    const errM = html2.match(/<[^>]*class=["'][^"']*(?:error|alert)[^"']*["'][^>]*>([\s\S]{0,300}?)<\//i);
    const errT = errM?.[1]?.replace(/<[^>]+>/g, '').trim() ?? 'SAMLResponse nicht gefunden';
    throw new Error(`[Login] Logineo fehlgeschlagen: ${errT}`);
  }

  const samlResponse = samlM[1];
  const relayState   = decodeEntities(relayM?.[1] ?? '');
  const acsRaw       = decodeEntities(acsM?.[1] ?? '');
  if (!acsRaw) throw new Error('[Login] ACS-URL nicht gefunden');
  // ACS-URL absolut machen (falls relativ, r2.url = IdP-Seite als Base verwenden)
  const acsUrl = acsRaw.startsWith('http') ? acsRaw : new URL(acsRaw, r2.url).toString();

  // Schritt 3: SAMLResponse an Moodle ACS
  const r3 = await proxyFetch(jar, acsUrl, 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': r2.url, 'Origin': idpBase,
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
  }, new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString());

  // Schritt 4: sesskey extrahieren
  let sesskey = extractSesskey(r3.body);
  let userId  = extractUserId(r3.body);

  if (!sesskey) {
    const dash = await proxyFetch(jar, `${MOODLE_URL}/my/`);
    sesskey = extractSesskey(dash.body);
    userId  = extractUserId(dash.body) || userId;
  }

  if (!sesskey) throw new Error('[Login] sesskey nach Login nicht gefunden');

  console.log(`[Moodle] ✅ Login OK | sesskey: ${sesskey.slice(0, 8)}... | userId: ${userId}`);
  return { sesskey, userId, cookie: jar.getCookieString(MOODLE_URL) };
}

// ── KV-Session-Cache ──────────────────────────────────────────────────────────

async function getOrCreateSession(env) {
  if (env.MOODLE_KV) {
    const cached = await env.MOODLE_KV.get('session', 'json');
    if (cached?.sesskey && cached?.expiry > Date.now()) return cached;
  }

  const session = await doLogineoLogin(env);
  session.expiry = Date.now() + 28 * 60 * 1000;

  if (env.MOODLE_KV) {
    await env.MOODLE_KV.put('session', JSON.stringify(session), { expirationTtl: 1800 });
  }
  return session;
}

// ── flattenParams (wie in moodleClient.ts) ────────────────────────────────────

function flattenParams(obj, form, prefix = '') {
  for (const [key, val] of Object.entries(obj)) {
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) flattenParams(item, form, `${k}[${i}]`);
        else form.append(`${k}[${i}]`, String(item));
      });
    } else if (typeof val === 'object' && val !== null) {
      flattenParams(val, form, k);
    } else if (val !== undefined && val !== null) {
      form.append(k, String(val));
    }
  }
}

// ── Base64-Encoding für große ArrayBuffer ─────────────────────────────────────

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let   binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── Moodle-Request-Handler ────────────────────────────────────────────────────

async function handleMoodleRequest(request, env, url) {
  // API-Key prüfen
  const workerKey = request.headers.get('x-worker-key') ?? '';
  if (!env.WORKER_KEY || workerKey !== env.WORKER_KEY) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const MOODLE_URL = (env.MOODLE_URL ?? '').replace(/\/$/, '');
  const path       = url.pathname;

  try {
    // ── GET /moodle/health ───────────────────────────────────────────────────
    if (path === '/moodle/health') {
      return Response.json({
        ok: true, moodle: !!MOODLE_URL,
        hasUsername: !!env.MOODLE_USERNAME, hasPassword: !!env.MOODLE_PASSWORD,
      });
    }

    // ── GET /moodle/debug – Redirect-Kette bis zum IdP-Formular ─────────────
    if (path === '/moodle/debug') {
      const info = { moodleUrl: MOODLE_URL, hasUsername: !!env.MOODLE_USERNAME, hasPassword: !!env.MOODLE_PASSWORD };
      const hdrs = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,*/*' };
      try {
        // Schritt 1
        const r1 = await fetch(`${MOODLE_URL}/login/index.php`, { redirect: 'manual', headers: hdrs });
        info.s1 = { status: r1.status, location: r1.headers.get('location') };

        // Schritt 2 – folge dem Redirect manuell
        if (r1.status >= 300 && r1.status < 400 && r1.headers.get('location')) {
          const url2 = new URL(r1.headers.get('location'), `${MOODLE_URL}/login/index.php`).toString();
          const r2 = await fetch(url2, { redirect: 'manual', headers: hdrs });
          info.s2 = { url: url2, status: r2.status, location: r2.headers.get('location') };

          // Schritt 3
          if (r2.status >= 300 && r2.status < 400 && r2.headers.get('location')) {
            const rawLoc3 = r2.headers.get('location');
            let url3;
            try { url3 = new URL(rawLoc3, url2).toString(); } catch(e) { info.s3parseError = `"${rawLoc3}" → ${e.message}`; }
            if (url3) {
              const r3 = await fetch(url3, { redirect: 'manual', headers: hdrs });
              info.s3 = { url: url3.slice(0, 200), status: r3.status, location: r3.headers.get('location')?.slice(0, 200) };
            }
          }
        }
      } catch(e) { info.error = e.message; }
      return Response.json({ ok: true, info });
    }

    // ── POST /moodle/login (erzwingt neuen Login, löscht KV-Cache) ───────────
    if (path === '/moodle/login') {
      if (env.MOODLE_KV) await env.MOODLE_KV.delete('session');
      const session = await doLogineoLogin(env);
      const s = { sesskey: session.sesskey, userId: session.userId, cookie: session.cookie, expiry: Date.now() + 28*60*1000 };
      if (env.MOODLE_KV) await env.MOODLE_KV.put('session', JSON.stringify(s), { expirationTtl: 1800 });
      return Response.json({ ok: true, sesskey: session.sesskey, userId: session.userId });
    }

    // ── POST /moodle/ajax ────────────────────────────────────────────────────
    if (path === '/moodle/ajax') {
      const session = await getOrCreateSession(env);
      const { methodname, args } = await request.json();

      const resp = await fetch(
        `${MOODLE_URL}/lib/ajax/service.php?sesskey=${session.sesskey}&info=${methodname}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Cookie': session.cookie, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' },
          body:    JSON.stringify([{ index: 0, methodname, args }]),
        }
      );
      const result = await resp.json();
      const item   = result?.[0];

      if (!item) return Response.json({ ok: false, error: 'Leere AJAX-Antwort' }, { status: 502 });
      if (item.error) {
        if (env.MOODLE_KV) await env.MOODLE_KV.delete('session'); // Session abgelaufen
        return Response.json({ ok: false, error: `AJAX: ${JSON.stringify(item.exception)}`, sessionExpired: true }, { status: 401 });
      }
      return Response.json({ ok: true, data: item.data });
    }

    // ── POST /moodle/rest ────────────────────────────────────────────────────
    if (path === '/moodle/rest') {
      const session = await getOrCreateSession(env);
      const { wsfunction, params } = await request.json();

      const form = new URLSearchParams();
      form.append('sesskey', session.sesskey);
      form.append('wsfunction', wsfunction);
      form.append('moodlewsrestformat', 'json');
      flattenParams(params ?? {}, form);

      const resp = await fetch(`${MOODLE_URL}/webservice/rest/server.php`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': session.cookie, 'User-Agent': 'Mozilla/5.0' },
        body:    form,
      });
      const data = await resp.json();
      if (data?.exception) return Response.json({ ok: false, error: data.message ?? 'REST-Fehler' }, { status: 502 });
      return Response.json({ ok: true, data });
    }

    // ── GET /moodle/download?url=... ─────────────────────────────────────────
    if (path === '/moodle/download') {
      const session   = await getOrCreateSession(env);
      const fileUrl   = url.searchParams.get('url');
      if (!fileUrl) return Response.json({ ok: false, error: 'url-Parameter fehlt' }, { status: 400 });

      const dlUrl = fileUrl.replace('/webservice/pluginfile.php/', '/pluginfile.php/').split('?')[0];

      const resp = await fetch(dlUrl, {
        headers: { 'Cookie': session.cookie, 'User-Agent': 'Mozilla/5.0' },
      });
      if (!resp.ok) return Response.json({ ok: false, error: `Download ${resp.status}` }, { status: 502 });

      const buffer      = await resp.arrayBuffer();
      const base64      = arrayBufferToBase64(buffer);
      const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
      const cd          = resp.headers.get('content-disposition') ?? '';
      const fnM         = cd.match(/filename[^;=\n]*=["\']?([^"\';\n]+)/);
      const filename    = fnM?.[1]?.trim() ?? '';

      return Response.json({ ok: true, data: base64, contentType, filename });
    }

    return Response.json({ ok: false, error: `Unbekannter Pfad: ${path}` }, { status: 404 });

  } catch (err) {
    console.error('[Moodle-Proxy] Fehler:', err);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM-BOT
// ══════════════════════════════════════════════════════════════════════════════

async function handleNachricht(env, chatId, text) {
  const t = text.toLowerCase().trim();

  if (t === 'todos' || t === '/todos') {
    await sendeSchulaufgaben(env, chatId);
    return;
  }

  if (t === 'aufgaben' || t === '/aufgaben') {
    await sendePersoenlicheAufgaben(env, chatId);
    return;
  }

  if (t === 'schulcheck' || t === '/schulcheck' || t === 'check') {
    const res = await triggerWorkflow(env, 'morning-check.yml');
    await sendeTelegram(env, chatId, res ? '⏳ Schulcheck wird gestartet – Nachricht kommt in ~30 Sekunden!' : '❌ Schulcheck konnte nicht gestartet werden.');
    return;
  }

  if (t === 'abendcheck' || t === '/abendcheck') {
    const res = await triggerWorkflow(env, 'evening-check.yml');
    await sendeTelegram(env, chatId, res ? '🌙 Abendcheck wird gestartet – Nachricht kommt in ~30 Sekunden!' : '❌ Abendcheck konnte nicht gestartet werden.');
    return;
  }

  if (t === 'wochencheck' || t === '/wochencheck' || t === 'diese woche') {
    const res = await triggerWorkflow(env, 'week-check.yml', { woche: 'diese' });
    await sendeTelegram(env, chatId, res ? '📅 Wochencheck (diese Woche) wird gestartet – Nachricht kommt in ~30 Sekunden!' : '❌ Wochencheck konnte nicht gestartet werden.');
    return;
  }

  if (t === 'nächstewoche' || t === 'naechstewoche' || t === 'nächste woche' || t === '/nächstewoche') {
    const res = await triggerWorkflow(env, 'week-check.yml', { woche: 'naechste' });
    await sendeTelegram(env, chatId, res ? '📅 Wochencheck (nächste Woche) wird gestartet – Nachricht kommt in ~30 Sekunden!' : '❌ Wochencheck konnte nicht gestartet werden.');
    return;
  }


  if (t === 'moodle' || t === '/moodle') {
    const ok = await setzeMoodleTrigger(env);
    await sendeTelegram(env, chatId, ok
      ? '📚 Moodle-Check wird gestartet – Dateien landen in ~1 Minute in Drive!'
      : '❌ Moodle-Trigger konnte nicht gesetzt werden.');
    return;
  }

  if (t === 'hilfe' || t === '/hilfe' || t === '/start' || t === '/help') {
    await sendeTelegram(env, chatId, hilfeText());
    return;
  }

  const datum = parseDatum(t);
  if (!datum) {
    await sendeTelegram(env, chatId,
      `❓ Ich verstehe das nicht.\n\nSchreib z.B.:\n• <b>heute</b>\n• <b>morgen</b>\n• <b>Donnerstag</b>\n• <b>27.5.</b>\n• <b>todos</b>\n• <b>aufgaben</b>\n• <b>schulcheck</b>\n• <b>hilfe</b>`
    );
    return;
  }

  await sendeTagesansicht(env, chatId, datum);
}

// ── GitHub Workflow triggern ──────────────────────────────────────────────────

async function triggerWorkflow(env, workflow, inputs = {}) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_USERNAME}/WebUntis/actions/workflows/${workflow}/dispatches`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'schul-bot' },
        body: JSON.stringify({ ref: 'main', ...(Object.keys(inputs).length ? { inputs } : {}) }) }
    );
    return res.status === 204;
  } catch { return false; }
}

// ── Datum parsen ──────────────────────────────────────────────────────────────

function berlinHeute() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
}

function fmt(d) { return d.toLocaleDateString('fr-CA'); }

function formatAnzeige(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const wochentage = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const monate = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  return `${wochentage[d.getDay()]}, ${d.getDate()}. ${monate[d.getMonth()]}`;
}

function parseDatum(t) {
  const heute = berlinHeute();
  if (t === 'heute') return fmt(heute);
  if (t === 'morgen') { const m = new Date(heute); m.setDate(m.getDate() + 1); return fmt(m); }
  if (t === 'übermorgen' || t === 'uebermorgen') { const m = new Date(heute); m.setDate(m.getDate() + 2); return fmt(m); }
  const wochentage = { 'montag':1,'mo':1,'dienstag':2,'di':2,'mittwoch':3,'mi':3,'donnerstag':4,'do':4,'freitag':5,'fr':5,'samstag':6,'sa':6 };
  if (wochentage[t] !== undefined) {
    const ziel = wochentage[t], heuteTag = heute.getDay();
    let diff = ziel - heuteTag;
    if (diff < 0) diff += 7;
    const d = new Date(heute); d.setDate(heute.getDate() + diff); return fmt(d);
  }
  const match = t.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
  if (match) {
    const d = new Date(match[3] ? parseInt(match[3]) : heute.getFullYear(), parseInt(match[2]) - 1, parseInt(match[1]));
    if (!isNaN(d.getTime())) return fmt(d);
  }
  return null;
}

function getBerlinOffset(datum) {
  const d = new Date(datum + 'T12:00:00Z');
  const berlinTime = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const utcTime = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = Math.round((berlinTime - utcTime) / 3600000);
  return offset === 2 ? '+02:00' : '+01:00';
}

// ── Google Calendar ───────────────────────────────────────────────────────────

async function getGoogleAccessToken(env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.readonly', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const signingInput = `${header}.${payload}`;
  const pemKey = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyData = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyData.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${signingInput}.${sigB64}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const data = await res.json();
  if (!data.access_token) throw new Error('Kein Token: ' + JSON.stringify(data));
  return data.access_token;
}

async function getKalenderTermine(datum, accessToken) {
  const offset = getBerlinOffset(datum);
  const calId = encodeURIComponent('sabesis@web.de');
  const start = encodeURIComponent(`${datum}T00:00:00${offset}`);
  const end   = encodeURIComponent(`${datum}T23:59:59${offset}`);
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${start}&timeMax=${end}&singleEvents=true&orderBy=startTime`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.error) { console.error('Kalender Fehler:', JSON.stringify(data.error)); return []; }
  return (data.items || []).map(e => ({ titel: e.summary || '(kein Titel)', start: e.start?.dateTime ? e.start.dateTime.substring(11,16) : '', ende: e.end?.dateTime ? e.end.dateTime.substring(11,16) : '', ganztag: !!e.start?.date && !e.start?.dateTime }));
}

// ── Wetter ────────────────────────────────────────────────────────────────────

async function getWetterFuerDatum(datum) {
  const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=51.5136&longitude=7.4653&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum&timezone=Europe%2FBerlin&forecast_days=14');
  const data = await res.json();
  const codes = { 0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',51:'🌦️',61:'🌧️',71:'❄️',80:'🌦️',95:'⛈️' };
  const idx = data.daily?.time?.indexOf(datum);
  if (idx == null || idx === -1) return null;
  return { emoji: codes[data.daily.weathercode[idx]] ?? '🌡️', max: Math.round(data.daily.temperature_2m_max[idx]), min: Math.round(data.daily.temperature_2m_min[idx]), rain: (data.daily.precipitation_sum[idx] ?? 0).toFixed(1) };
}

// ── Notion ────────────────────────────────────────────────────────────────────

async function notionQuery(env, dbId, filter) {
  const payload = filter ? { filter, page_size: 100 } : { page_size: 100 };
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.object === 'error') throw new Error(data.message);
  return data.results || [];
}

const IGNORIEREN = ['AG Bienen', 'Vertiefung'];

// ── Tagesansicht ──────────────────────────────────────────────────────────────

async function sendeTagesansicht(env, chatId, datum) {
  try {
    const [rows, wetter, accessToken, schulTodos, personalTodos] = await Promise.all([
      notionQuery(env, env.NOTION_DATABASE_ID, { property: 'Datum', date: { equals: datum } }),
      getWetterFuerDatum(datum).catch(() => null),
      getGoogleAccessToken(env).catch(() => null),
      getSchulTodosRaw(env).catch(() => []),
      getPersonalTodosRaw(env).catch(() => [])
    ]);

    const termine = accessToken ? await getKalenderTermine(datum, accessToken).catch(() => []) : [];

    const stunden = rows
      .map(page => {
        const p = page.properties;
        return { fach: p.Fach?.title?.[0]?.plain_text || '?', start: p.Startzeit?.rich_text?.[0]?.plain_text || '', ende: p.Endzeit?.rich_text?.[0]?.plain_text || '', raum: p.Raum?.rich_text?.[0]?.plain_text || '', status: p.Status?.select?.name || 'Normal' };
      })
      .filter(s => !IGNORIEREN.includes(s.fach))
      .sort((a, b) => a.start.localeCompare(b.start));

    let msg = `📚 <b>Stundenplan – ${formatAnzeige(datum)}</b>\n`;
    if (wetter) msg += `${wetter.emoji} ↑${wetter.max}° ↓${wetter.min}° · 💧 ${wetter.rain} mm\n`;
    msg += '\n';

    if (stunden.length === 0) {
      msg += `✨ Kein Unterricht – freier Tag!\n`;
    } else {
      for (const s of stunden) {
        const emoji = s.status === 'Ausfall' ? '❌' : s.status === 'Vertretung' ? '🔄' : s.status === 'Prüfung' ? '📝' : '✅';
        msg += `${emoji} <b>${s.start}–${s.ende}</b> ${s.fach}`;
        if (s.raum) msg += ` · ${s.raum}`;
        if (s.status === 'Ausfall') msg += ` <i>(Ausfall)</i>`;
        else if (s.status === 'Vertretung') msg += ` <i>(Vertretung)</i>`;
        else if (s.status === 'Prüfung') msg += ` <i>(Prüfung!)</i>`;
        msg += '\n';
      }
    }

    msg += `\n📅 <b>Termine</b>\n`;
    if (termine.length === 0) msg += `✨ Keine Termine\n`;
    else for (const t of termine) {
      if (t.ganztag) msg += `🗓 ${t.titel} <i>(ganztägig)</i>\n`;
      else msg += `🗓 <b>${t.start}–${t.ende}</b> ${t.titel}\n`;
    }

    msg += `\n✅ <b>Offene Schulaufgaben</b>\n`;
    if (schulTodos.length === 0) msg += `🎉 Alles erledigt!\n`;
    else {
      const pEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
      for (const t of schulTodos.slice(0, 10)) {
        msg += `${pEmoji[t.prioritaet] || '•'} ${t.title}`;
        if (t.faellig) { const d = new Date(t.faellig + 'T12:00:00'); msg += ` <i>(${d.getDate()}.${d.getMonth()+1}.)</i>`; }
        msg += '\n';
      }
      if (schulTodos.length > 10) msg += `… und ${schulTodos.length - 10} weitere\n`;
    }

    msg += `\n🏠 <b>Persönliche Aufgaben</b>\n`;
    if (personalTodos.length === 0) msg += `🎉 Nichts zu erledigen!\n`;
    else for (const t of personalTodos) msg += `☐ ${t}\n`;

    await sendeTelegramLang(env, chatId, msg);
  } catch(e) {
    console.error('Tagesansicht Fehler:', e);
    await sendeTelegram(env, chatId, '⚠️ Fehler beim Abrufen der Daten. Bitte versuche es später nochmal.');
  }
}

// ── Aufgaben ──────────────────────────────────────────────────────────────────

async function getSchulTodosRaw(env) {
  if (!env.NOTION_TODO_DATABASE_ID) return [];
  const rows = await notionQuery(env, env.NOTION_TODO_DATABASE_ID, { property: 'Status', select: { does_not_equal: 'Erledigt' } });
  const pOrder = { 'Hoch': 0, 'Mittel': 1, 'Niedrig': 2, '': 3 };
  return rows
    .map(p => ({ title: p.properties['Aufgabe']?.title?.[0]?.plain_text || '', prioritaet: p.properties['Priorität']?.select?.name || '', faellig: p.properties['Fällig']?.date?.start || '' }))
    .filter(t => t.title)
    .sort((a, b) => {
      if (a.faellig && b.faellig) return a.faellig.localeCompare(b.faellig);
      if (a.faellig) return -1; if (b.faellig) return 1;
      return (pOrder[a.prioritaet] ?? 3) - (pOrder[b.prioritaet] ?? 3);
    });
}

async function getPersonalTodosRaw(env) {
  if (!env.NOTION_PERSONAL_DB_ID) return [];
  const rows = await notionQuery(env, env.NOTION_PERSONAL_DB_ID, { property: 'Erledigt', checkbox: { equals: false } });
  return rows.map(p => p.properties['Aufgabe']?.title?.[0]?.plain_text || '').filter(t => t.length > 0);
}

async function sendeSchulaufgaben(env, chatId) {
  try {
    const todos = await getSchulTodosRaw(env);
    let msg = `✅ <b>Offene Schulaufgaben</b>\n\n`;
    if (todos.length === 0) { msg += `🎉 Alles erledigt!`; }
    else {
      const pEmoji = { 'Hoch': '🔴', 'Mittel': '🟡', 'Niedrig': '🟢' };
      for (const t of todos.slice(0, 20)) {
        msg += `${pEmoji[t.prioritaet] || '•'} ${t.title}`;
        if (t.faellig) { const d = new Date(t.faellig + 'T12:00:00'); msg += ` <i>(${d.getDate()}.${d.getMonth()+1}.)</i>`; }
        msg += '\n';
      }
      if (todos.length > 20) msg += `… und ${todos.length - 20} weitere`;
    }
    await sendeTelegram(env, chatId, msg);
  } catch(e) { await sendeTelegram(env, chatId, '⚠️ Fehler beim Abrufen der Schulaufgaben.'); }
}

async function sendePersoenlicheAufgaben(env, chatId) {
  try {
    const todos = await getPersonalTodosRaw(env);
    let msg = `🏠 <b>Persönliche Aufgaben</b>\n\n`;
    if (todos.length === 0) { msg += `🎉 Nichts zu erledigen!`; }
    else for (const t of todos) msg += `☐ ${t}\n`;
    await sendeTelegram(env, chatId, msg);
  } catch(e) { await sendeTelegram(env, chatId, '⚠️ Fehler beim Abrufen der persönlichen Aufgaben.'); }
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendeTelegram(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

async function sendeTelegramLang(env, chatId, text) {
  const chunks = [];
  while (text.length > 4000) {
    let cut = text.lastIndexOf('\n', 4000);
    if (cut === -1) cut = 4000;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  chunks.push(text);
  for (const chunk of chunks) await sendeTelegram(env, chatId, chunk);
}

function hilfeText() {
  return `🤖 <b>Schul-Bot – Befehle</b>

📅 <b>Stundenplan + Wetter + Termine + Aufgaben:</b>
• <b>heute</b> – heutiger Plan
• <b>morgen</b> – morgiger Plan
• <b>Montag</b> / <b>Mo</b> – nächster Montag
• <b>Dienstag</b> / <b>Di</b>
• <b>Mittwoch</b> / <b>Mi</b>
• <b>Donnerstag</b> / <b>Do</b>
• <b>Freitag</b> / <b>Fr</b>
• <b>27.5.</b> – konkretes Datum

✅ <b>Aufgaben:</b>
• <b>todos</b> – offene Schulaufgaben
• <b>aufgaben</b> – persönliche Aufgaben

🔄 <b>Checks:</b>
• <b>schulcheck</b> – Tages-Check jetzt ausführen
• <b>abendcheck</b> – Abend-Check jetzt ausführen
• <b>wochencheck</b> – Wochencheck diese Woche
• <b>nächste Woche</b> – Wochencheck nächste Woche
• <b>moodle</b> – Moodle auf neue Dateien prüfen

❓ <b>hilfe</b> – diese Übersicht`;
}

// ── Moodle Trigger via GitHub ─────────────────────────────────────────────────

async function setzeMoodleTrigger(env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_USERNAME}/WebUntis/contents/moodle-trigger.json`;
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'schul-bot'
  };

  // Aktuellen SHA holen
  const get = await fetch(apiUrl, { headers });
  if (!get.ok) return false;
  const data = await get.json();
  const sha  = data.sha;

  // Trigger setzen
  const inhalt  = JSON.stringify({ trigger: true });
  const encoded = btoa(inhalt);
  const put = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: 'trigger=true',
      content: encoded,
      sha
    })
  });
  return put.status === 200 || put.status === 201;
}
