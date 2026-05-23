const { chromium } = require("playwright");
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ISERV_USER = process.env.ISERV_USER;
const ISERV_PASS = process.env.ISERV_PASS;
const ISERV_URL = "https://westfalenkolleg-dortmund-edu.de/iserv";
const STUDENT_ID = 13837;

function parseTime(t) {
  const h = Math.floor(t / 100);
  const m = t % 100;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseDateInt(d) {
  const s = String(d);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
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

function toISODate(d) {
  return d.toISOString().split("T")[0];
}

async function fetchTimetable() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    // 1. IServ Login
    console.log("🔐 IServ Login...");
    const page = await context.newPage();
    await page.goto(ISERV_URL + "/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.fill('input[name="_username"]', ISERV_USER);
    await page.fill('input[name="_password"]', ISERV_PASS);
    await Promise.all([
      page.waitForURL("**/iserv/**", { timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);
    console.log("✅ IServ eingeloggt");

    // 2. WebUntis-Link in IServ finden – öffnet neuen Tab
    console.log("🔍 Suche WebUntis-Link...");
    const wuLink = await page.$('a[href*="webuntis"]');
    
    let wuPage;
    if (wuLink) {
      // Neuen Tab abfangen
      const [newPage] = await Promise.all([
        context.waitForEvent("page", { timeout: 15000 }),
        wuLink.click(),
      ]);
      wuPage = newPage;
      await wuPage.waitForLoadState("domcontentloaded", { timeout: 20000 });
      console.log("✅ WebUntis via SSO geöffnet:", wuPage.url());
    } else {
      // Direkt zu WebUntis navigieren
      console.log("ℹ️ Kein SSO-Link gefunden, navigiere direkt...");
      wuPage = await context.newPage();
      await wuPage.goto("https://wkdo.webuntis.com/WebUntis?school=wkdo", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
    }

    // 3. Kurz warten bis Session steht
    await wuPage.waitForTimeout(2000);

    // 4. API mit korrekter Student-ID aufrufen
    const allLessons = [];

    for (const offset of [0, 1]) {
      const monday = getMondayOfWeek(offset);
      const dateStr = toISODate(monday);

      // Primärer Endpunkt (eingeloggt)
      const apiUrl = `https://wkdo.webuntis.com/WebUntis/api/rest/view/v1/timetable/student?id=${STUDENT_ID}&date=${dateStr}`;
      
      console.log(`📡 Lade Woche ab ${dateStr}...`);

      const result = await wuPage.evaluate(async (url) => {
        try {
          const res = await fetch(url, { credentials: "include" });
          return { ok: res.ok, status: res.status, body: await res.text() };
        } catch (e) {
          return { ok: false, status: 0, body: e.message };
        }
      }, apiUrl);

      console.log(`   Status: ${result.status}`);

      if (!result.ok) {
        // Fallback: älterer API-Endpunkt
        const fallbackUrl = `https://wkdo.webuntis.com/WebUntis/api/public/timetable/weekly/student?elementId=${STUDENT_ID}&date=${dateStr}&formatId=1`;
        const fallback = await wuPage.evaluate(async (url) => {
          try {
            const res = await fetch(url, { credentials: "include" });
            return { ok: res.ok, status: res.status, body: await res.text() };
          } catch (e) {
            return { ok: false, status: 0, body: e.message };
          }
        }, fallbackUrl);

        console.log(`   Fallback Status: ${fallback.status}`);
        if (!fallback.ok) {
          console.warn(`⚠️ Beide Endpunkte fehlgeschlagen für ${dateStr}`);
          continue;
        }
        result.body = fallback.body;
        result.ok = true;
      }

      let json;
      try {
        json = JSON.parse(result.body);
      } catch {
        console.warn(`⚠️ JSON-Parsing fehlgeschlagen`);
        continue;
      }

      // Verschiedene Antwortformate unterstützen
      const data = json?.data ?? json;
      const days =
        data?.days ??
        data?.weeks?.[0]?.days ??
        data?.result?.days ??
        (Array.isArray(data) ? data : []);

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

      console.log(`✅ Woche ab ${dateStr}: ${allLessons.length} Stunden gesamt`);
    }

    return allLessons;
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
