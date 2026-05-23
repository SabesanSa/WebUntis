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
  monday.setHours(0,0,0,0);
  return monday;
}
function toISODate(d) { return d.toISOString().split("T")[0]; }

function extractLessons(json) {
  const lessons = [];
  const data = json?.data ?? json;
  const days = data?.days ?? data?.weeks?.[0]?.days ?? (Array.isArray(data) ? data : []);
  for (const day of days) {
    const dateISO = parseDateInt(day.date);
    for (const period of day.periods ?? []) {
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

async function fetchTimetable() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Alle Timetable-API-Antworten abfangen
  const capturedLessons = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("webuntis.com") && (url.includes("timetable") || url.includes("Timetable"))) {
      try {
        const json = await response.json();
        const lessons = extractLessons(json);
        if (lessons.length > 0) {
          console.log(`🎯 Abgefangen: ${lessons.length} Stunden von ${url.split("?")[0].split("/").pop()}`);
          capturedLessons.push(...lessons);
        }
      } catch {}
    }
  });

  try {
    // 1. WebUntis Login-Seite
    console.log("🌐 Öffne WebUntis...");
    await page.goto("https://wkdo.webuntis.com/WebUntis/?school=wkdo", {
      waitUntil: "domcontentloaded", timeout: 20000
    });

    // 2. "Anmeldung mit IServ" klicken
    console.log("🔘 Klicke 'Anmeldung mit IServ'...");
    // JavaScript-Click umgeht Visibility-Checks
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const els = document.querySelectorAll('button, a');
      for (const el of els) {
        if (el.textContent.includes('IServ')) { el.click(); return true; }
      }
      return false;
    });
    await page.waitForTimeout(3000);
    console.log("   URL:", page.url());

    // 3. IServ-Login falls nötig
    if (page.url().includes("login")) {
      console.log("🔐 IServ Zugangsdaten eingeben...");
      await page.fill('input[name="_username"]', ISERV_USER);
      await page.fill('input[name="_password"]', ISERV_PASS);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);
      console.log("   URL:", page.url());
    }

    // 4. "Zulassen" klicken falls OAuth-Seite erscheint
    const zulassen = await page.$('button:has-text("Zulassen"), a:has-text("Zulassen")');
    if (zulassen) {
      console.log("✅ Klicke 'Zulassen'...");
      await zulassen.click();
      await page.waitForTimeout(3000);
      console.log("   URL:", page.url());
    }

    // 5. Warten bis WebUntis geladen
    await page.waitForTimeout(2000);
    console.log("✅ Eingeloggt:", page.url());

    // 6. "Mein Stundenplan" klicken
    console.log("📅 Klicke 'Mein Stundenplan'...");
    await page.click('a:has-text("Mein Stundenplan"), [class*="timetable"], [href*="timetable"]', { timeout: 10000 });
    await page.waitForTimeout(4000);

    // 7. Nächste Woche laden (Pfeil-Button klicken)
    console.log("➡️ Lade nächste Woche...");
    const nextBtn = await page.$('[class*="next"], button[aria-label*="next"], button[aria-label*="nächste"], .icon-forward');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(4000);
    } else {
      console.log("⚠️ Kein 'Weiter'-Button gefunden");
    }

    console.log(`\n📊 ${capturedLessons.length} Stunden abgefangen`);
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

  const dates = [...new Set(allLessons.map(l => l.date))].sort();
  console.log(`\n📅 Verarbeite ${dates.length} Tage...\n`);

  for (const date of dates) {
    const lessonsOnDay = allLessons.filter(l => l.date === date);
    const deleted = await deleteEntriesForDate(date);
    for (const lesson of lessonsOnDay) await createEntry(lesson);
    console.log(`  📆 ${date}: ${deleted > 0 ? `${deleted} alte gelöscht, ` : ""}${lessonsOnDay.length} neue angelegt`);
  }
  console.log("\n✨ Sync abgeschlossen!");
}

sync().catch(err => {
  console.error("❌ Fehler:", err.message);
  process.exit(1);
});
