const { chromium } = require("playwright");
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ISERV_USER = process.env.ISERV_USER;
const ISERV_PASS = process.env.ISERV_PASS;

function parseTime(t) {
  // Supports both integer (830) and string ("08:30") formats
  if (typeof t === "string" && t.includes(":")) return t.slice(0, 5);
  const h = Math.floor(t / 100), m = t % 100;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function parseDateInt(d) {
  const s = String(d);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
function parseISODate(s) {
  // Handle "2026-05-27T08:10:00" or "2026-05-27"
  return s.slice(0, 10);
}
function getStatus(p) {
  if (p.cellState === "CANCEL" || p.type === 2 || p.isCancelled) return "Ausfall";
  if (p.cellState === "SUBSTITUTION" || p.type === 3 || p.isSubstitution) return "Vertretung";
  return "Normal";
}
function getMondayOfWeek(offset = 0) {
  const today = new Date();
  const day = today.getDay();
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today);
  monday.setDate(diff + offset * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function toISODate(d) { return d.toISOString().split("T")[0]; }

function extractLessons(json, sourcePath) {
  const lessons = [];
  
  // Format 1: classic days/periods
  const data = json?.data ?? json;
  const days = data?.days ?? data?.weeks?.[0]?.days ?? [];
  for (const day of days) {
    if (!day?.date) continue;
    const dateISO = parseDateInt(day.date);
    for (const period of day.periods ?? []) {
      if (!period?.startTime) continue;
      lessons.push({
        date: dateISO,
        subject: period.subjects?.[0]?.longName ?? period.subjects?.[0]?.name ?? "Unbekannt",
        startTime: parseTime(period.startTime),
        endTime: parseTime(period.endTime),
        room: period.rooms?.[0]?.name ?? "",
        teacher: period.teachers?.[0]?.longName ?? period.teachers?.[0]?.name ?? "",
        status: getStatus(period),
      });
    }
  }
  if (lessons.length > 0) return lessons;

  // Format 2: entries array (new WebUntis format)
  const entries = data?.entries ?? data?.timetableEntries ?? data?.periods ?? 
                  (Array.isArray(data) ? data : null);
  if (entries) {
    for (const e of entries) {
      const start = e.start ?? e.startTime ?? e.startDateTime ?? e.from;
      const end = e.end ?? e.endTime ?? e.endDateTime ?? e.to;
      const date = e.date ?? e.day;
      if (!start) continue;

      const dateISO = date ? (String(date).length === 8 ? parseDateInt(date) : parseISODate(String(date)))
                           : parseISODate(String(start));
      const startTime = typeof start === "number" ? parseTime(start) : parseISODate(String(start)) !== dateISO ? start.slice(11,16) : parseTime(start);
      const endTime = typeof end === "number" ? parseTime(end) : end?.slice(11,16) ?? "";

      const subject = e.subject?.longName ?? e.subject?.name ?? e.subjectName ?? 
                      e.subjects?.[0]?.longName ?? e.subjects?.[0]?.name ?? "Unbekannt";
      const room = e.room?.name ?? e.roomName ?? e.rooms?.[0]?.name ?? "";
      const teacher = e.teacher?.name ?? e.teacherName ?? e.teachers?.[0]?.name ?? "";

      lessons.push({ date: dateISO, subject, startTime, endTime, room, teacher, status: getStatus(e) });
    }
  }

  return lessons;
}

async function waitForUrl(page, pattern, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.url().includes(pattern)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function fetchTimetable() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const capturedLessons = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("webuntis.com")) return;
    const ct = response.headers()["content-type"] ?? "";
    if (!ct.includes("json")) return;
    const path = url.replace(/https?:\/\/[^/]+/, "").split("?")[0];
    try {
      const body = await response.text();
      // Log entries endpoint vollständig
      if (path.includes("timetable/entries")) {
        console.log(`📥 ${response.status()} ${path}`);
        console.log(`   FULL BODY: ${body.slice(0, 2000)}`);
      }
      const json = JSON.parse(body);
      const lessons = extractLessons(json, path);
      if (lessons.length > 0) {
        console.log(`🎯 ${lessons.length} Stunden aus ${path}!`);
        capturedLessons.push(...lessons);
      }
    } catch {}
  });

  try {
    console.log("🌐 Öffne WebUntis Login...");
    await page.goto("https://wkdo.webuntis.com/WebUntis/?school=wkdo", {
      waitUntil: "domcontentloaded", timeout: 20000
    });
    await page.waitForTimeout(3000);

    console.log("🔘 Klicke IServ-Button...");
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("button, a")) {
        if (el.textContent.includes("IServ")) { el.click(); return; }
      }
    });
    await waitForUrl(page, "iserv", 10000);

    if (page.url().includes("login")) {
      console.log("🔐 IServ Login...");
      await page.waitForSelector('input[name="_username"]', { timeout: 10000 });
      await page.fill('input[name="_username"]', ISERV_USER);
      await page.fill('input[name="_password"]', ISERV_PASS);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(4000);
    }

    const zulassen = await page.$('button:has-text("Zulassen")');
    if (zulassen) {
      console.log("✅ Klicke Zulassen...");
      await zulassen.click();
      await page.waitForTimeout(4000);
    }

    console.log("✅ Eingeloggt:", page.url());

    for (const offset of [0, 1]) {
      const dateStr = toISODate(getMondayOfWeek(offset));
      const url = `https://wkdo.webuntis.com/timetable/my-student?date=${dateStr}`;
      console.log(`\n📅 Lade ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(8000);
      console.log(`   ${capturedLessons.length} Stunden bisher`);
    }

    return capturedLessons;
  } finally {
    await browser.close();
  }
}

async function deleteEntriesForDate(dateStr) {
  const res = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: "Datum", date: { equals: dateStr } },
  });
  for (const p of res.results) {
    await notion.pages.update({ page_id: p.id, archived: true });
  }
  return res.results.length;
}

async function createEntry(lesson) {
  await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties: {
      Fach:      { title:     [{ text: { content: lesson.subject   } }] },
      Datum:     { date:      { start: lesson.date                    } },
      Startzeit: { rich_text: [{ text: { content: lesson.startTime } }] },
      Endzeit:   { rich_text: [{ text: { content: lesson.endTime   } }] },
      Raum:      { rich_text: [{ text: { content: lesson.room      } }] },
      Lehrer:    { rich_text: [{ text: { content: lesson.teacher   } }] },
      Status:    { select:    { name: lesson.status                    } },
    },
  });
}

async function sync() {
  console.log("🚀 Starte WebUntis → Notion Sync...\n");
  const allLessons = await fetchTimetable();
  if (allLessons.length === 0) {
    console.warn("⚠️ Keine Stunden gefunden.");
    process.exit(1);
  }
  const unique = new Map();
  for (const l of allLessons) unique.set(`${l.date}-${l.startTime}-${l.subject}`, l);
  const lessons = [...unique.values()];
  const dates = [...new Set(lessons.map(l => l.date))].sort();
  console.log(`\n📅 ${lessons.length} Stunden an ${dates.length} Tagen\n`);
  for (const date of dates) {
    const lessonsOnDay = lessons.filter(l => l.date === date);
    const deleted = await deleteEntriesForDate(date);
    for (const lesson of lessonsOnDay) await createEntry(lesson);
    console.log(`  📆 ${date}: ${deleted > 0 ? `${deleted} alt, ` : ""}${lessonsOnDay.length} neu`);
  }
  console.log("\n✨ Fertig!");
}

sync().catch(err => {
  console.error("❌ Fehler:", err.message);
  process.exit(1);
});
