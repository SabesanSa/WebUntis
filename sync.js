/**
 * WebUntis → Notion Sync
 * Login via IServ → WebUntis
 * Schule: Westfalen Kolleg Dortmund
 */

const { chromium } = require("playwright");
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ISERV_URL = "https://westfalenkolleg-dortmund-edu.de/iserv";
const ISERV_USER = process.env.ISERV_USER;
const ISERV_PASS = process.env.ISERV_PASS;
const WEBUNTIS_URL = "https://wkdo.webuntis.com/WebUntis?school=wkdo#/basic/timetablePublic/my-student";

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

function parseTime(timeInt) {
  const h = Math.floor(timeInt / 100);
  const m = timeInt % 100;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseDateInt(dateInt) {
  const s = String(dateInt);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function getStatus(period) {
  if (period.cellState === "CANCEL" || period.type === 2) return "Ausfall";
  if (period.cellState === "SUBSTITUTION" || period.type === 3) return "Vertretung";
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

function toISODate(date) {
  return date.toISOString().split("T")[0];
}

// ─── WebUntis via Browser ────────────────────────────────────────────────────

async function fetchTimetable() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. IServ Login
    console.log("🔐 IServ Login...");
    await page.goto(ISERV_URL + "/login", { waitUntil: "networkidle" });
    await page.fill('input[name="_username"]', ISERV_USER);
    await page.fill('input[name="_password"]', ISERV_PASS);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle" });
    console.log("✅ Eingeloggt");

    // 2. WebUntis aufrufen – API direkt abfragen mit Session-Cookies
    console.log("📡 Rufe WebUntis API ab...");

    const monday0 = getMondayOfWeek(0);
    const monday1 = getMondayOfWeek(1);

    const allLessons = [];

    for (const monday of [monday0, monday1]) {
      const dateStr = toISODate(monday);
      const apiUrl = `https://wkdo.webuntis.com/WebUntis/api/public/timetable/weekly/student?elementId=5697&date=${dateStr}&formatId=1`;

      const response = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: "include" });
        return { ok: res.ok, status: res.status, body: await res.text() };
      }, apiUrl);

      if (!response.ok) {
        console.warn(`⚠️ API ${dateStr}: ${response.status}`);
        continue;
      }

      const json = JSON.parse(response.body);
      const data = json?.data ?? json;
      const days = data?.days ?? data?.weeks?.[0]?.days ?? [];

      for (const day of days) {
        const dateISO = parseDateInt(day.date);
        for (const period of day.periods ?? []) {
          allLessons.push({
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

      console.log(`✅ Woche ab ${dateStr}: ${allLessons.length} Stunden`);
    }

    return allLessons;
  } finally {
    await browser.close();
  }
}

// ─── Notion ──────────────────────────────────────────────────────────────────

async function deleteEntriesForDate(dateStr) {
  const res = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: "Datum", date: { equals: dateStr } },
  });
  for (const page of res.results) {
    await notion.pages.update({ page_id: page.id, archived: true });
  }
  return res.results.length;
}

async function createEntry(lesson) {
  await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties: {
      Fach: { title: [{ text: { content: lesson.subject } }] },
      Datum: { date: { start: lesson.date } },
      Startzeit: { rich_text: [{ text: { content: lesson.startTime } }] },
      Endzeit: { rich_text: [{ text: { content: lesson.endTime } }] },
      Raum: { rich_text: [{ text: { content: lesson.room } }] },
      Lehrer: { rich_text: [{ text: { content: lesson.teacher } }] },
      Status: { select: { name: lesson.status } },
    },
  });
}

// ─── Hauptprogramm ───────────────────────────────────────────────────────────

async function sync() {
  console.log("🚀 Starte WebUntis → Notion Sync...\n");

  const allLessons = await fetchTimetable();

  if (allLessons.length === 0) {
    console.warn("⚠️ Keine Stunden gefunden.");
    process.exit(1);
  }

  const dates = [...new Set(allLessons.map((l) => l.date))].sort();
  console.log(`\n📅 Verarbeite ${dates.length} Tage...\n`);

  for (const date of dates) {
    const lessonsOnDay = allLessons.filter((l) => l.date === date);
    const deleted = await deleteEntriesForDate(date);
    for (const lesson of lessonsOnDay) await createEntry(lesson);
    console.log(`  📆 ${date}: ${deleted > 0 ? `${deleted} alte gelöscht, ` : ""}${lessonsOnDay.length} neue angelegt`);
  }

  console.log("\n✨ Sync abgeschlossen!");
}

sync().catch((err) => {
  console.error("❌ Fehler:", err.message);
  process.exit(1);
});
