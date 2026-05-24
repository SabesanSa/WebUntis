const { chromium } = require("playwright");
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ISERV_USER = process.env.ISERV_USER;
const ISERV_PASS = process.env.ISERV_PASS;

function parseTime(t) {
  const h = Math.floor(t / 100), m = t % 100;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function parseDateInt(d) {
  const s = String(d);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
function getStatus(p) {
  if (p.cellState === "CANCEL" || p.type === 2) return "Ausfall";
  if (p.cellState === "SUBSTITUTION" || p.type === 3) return "Vertretung";
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

function extractLessons(json) {
  const lessons = [];
  const data = json?.data ?? json;
  const days = data?.days ?? data?.weeks?.[0]?.days ?? (Array.isArray(data) ? data : []);
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

  // Alle JSON-Responses loggen
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("webuntis.com")) return;
    const ct = response.headers()["content-type"] ?? "";
    if (!ct.includes("json")) return;
    try {
      const body = await response.text();
      const path = url.replace(/https?:\/\/[^/]+/, "").split("?")[0];
      console.log(`📥 ${response.status()} ${path}`);
      if (body.length < 500) console.log(`   ${body}`);
      const json = JSON.parse(body);
      const lessons = extractLessons(json);
      if (lessons.length > 0) {
        console.log(`🎯 ${lessons.length} Stunden aus ${path}!`);
        capturedLessons.push(...lessons);
      }
    } catch {}
  });

  try {
    // 1. Login über alte WebUntis-URL (IServ SSO funktioniert hier)
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

    // 2. Neue Timetable-URL aufrufen (echte URL aus dem Browser)
    for (const offset of [0, 1]) {
      const dateStr = toISODate(getMondayOfWeek(offset));
      const timetableUrl = `https://wkdo.webuntis.com/timetable/my-student?date=${dateStr}`;
      
      console.log(`\n📅 Lade ${timetableUrl}`);
      await page.goto(timetableUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
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
