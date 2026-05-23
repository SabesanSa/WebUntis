/**
 * WebUntis → Notion Timetable Sync
 * Schule: Westfalen Kolleg Dortmund (wkdo)
 */

const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const WEBUNTIS_SERVER = "wkdo";
const ENTITY_ID = 5697;

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

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

// ─── WebUntis API ────────────────────────────────────────────────────────────

async function fetchWeek(mondayDate) {
  const dateStr = toISODate(mondayDate);
  const url = `https://${WEBUNTIS_SERVER}.webuntis.com/WebUntis/api/public/timetable/weekly/student?elementId=${ENTITY_ID}&date=${dateStr}&formatId=1`;

  console.log(`📡 Fetching WebUntis: ${url}`);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`WebUntis API Error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  return json;
}

function extractPeriods(weekData) {
  // Unterstützt verschiedene WebUntis-Antwortformate
  const data = weekData?.data ?? weekData;
  const days =
    data?.days ??
    data?.weeks?.[0]?.days ??
    data?.result?.days ??
    [];

  const lessons = [];

  for (const day of days) {
    const dateStr = parseDateInt(day.date);
    const periods = day.periods ?? [];

    for (const period of periods) {
      const subject =
        period.subjects?.[0]?.longName ??
        period.subjects?.[0]?.name ??
        "Unbekannt";

      lessons.push({
        date: dateStr,
        subject,
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

  // Aktuelle Woche + nächste Woche laden
  const weeks = [getMondayOfWeek(0), getMondayOfWeek(1)];
  const allLessons = [];

  for (const monday of weeks) {
    const raw = await fetchWeek(monday);
    const lessons = extractPeriods(raw);
    console.log(`✅ Woche ab ${toISODate(monday)}: ${lessons.length} Stunden gefunden`);
    allLessons.push(...lessons);
  }

  if (allLessons.length === 0) {
    console.warn("⚠️  Keine Stunden gefunden. Bitte API-Antwort prüfen.");
    process.exit(1);
  }

  // Alle betroffenen Tage ermitteln
  const dates = [...new Set(allLessons.map((l) => l.date))].sort();

  console.log(`\n📅 Verarbeite ${dates.length} Tage...\n`);

  for (const date of dates) {
    const lessonsOnDay = allLessons.filter((l) => l.date === date);

    // Alte Einträge löschen
    const deleted = await deleteEntriesForDate(date);

    // Neue Einträge anlegen
    for (const lesson of lessonsOnDay) {
      await createEntry(lesson);
    }

    console.log(
      `  📆 ${date}: ${deleted > 0 ? `${deleted} alte gelöscht, ` : ""}${lessonsOnDay.length} neue angelegt`
    );
  }

  console.log("\n✨ Sync abgeschlossen!");
}

sync().catch((err) => {
  console.error("❌ Fehler:", err.message);
  process.exit(1);
});
