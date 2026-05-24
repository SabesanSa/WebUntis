const { chromium } = require("playwright");
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ISERV_USER = process.env.ISERV_USER;
const ISERV_PASS = process.env.ISERV_PASS;

const WOCHENTAGE = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];

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

  for (const day of json?.days ?? []) {
    const date = day.date;
    const dayOfWeek = new Date(date + "T00:00:00").getDay();
    if (dayOfWeek === 6) continue; // Samstag überspringen
    const wochentag = WOCHENTAGE[dayOfWeek];

    // Reguläre Stunden aus gridEntries
    for (const entry of day.gridEntries ?? []) {
      if (entry.type === "HOLIDAY" || entry.type === "BREAK") continue;
      const start = entry.duration?.start?.slice(11, 16) ?? "";
      const end   = entry.duration?.end?.slice(11, 16) ?? "";
      const subject = entry.position2?.[0]?.current?.longName ?? entry.position2?.[0]?.current?.shortName ?? "Unbekannt";
      const teacher = entry.position1?.[0]?.current?.shortName ?? "";
      const room    = entry.position3?.[0]?.current?.shortName ?? "";
      let status = "Normal";
      if (entry.type === "EXAM") status = "Prüfung";
      else if (entry.status === "CANCELLED" || entry.type === "CANCELLED_PERIOD") status = "Ausfall";
      else if (entry.status === "CHANGED" || entry.position1?.[0]?.removed) status = "Vertretung";
      if (!start) continue;
      lessons.push({ date, wochentag, subject, startTime: start, endTime: end, room, teacher, status });
    }

    // Freie Tage und Ferien aus backEntries
    for (const entry of day.backEntries ?? []) {
      if (!entry.isFullDay) continue;
      const name = entry.longName ?? entry.shortName ?? "Freier Tag";
      const status = entry.type === "HOLIDAY" ? "Ferien" : "Freier Tag";
      lessons.push({ date, wochentag, subject: name, startTime: "", endTime: "", room: "", teacher: "", status });
    }

    // Freier Tag aus dayEntries (schulfreier Tag ohne backEntry)
    for (const entry of day.dayEntries ?? []) {
      const name = entry.longName ?? entry.shortName ?? "Freier Tag";
      const status = entry.type === "HOLIDAY" ? "Ferien" : "Freier Tag";
      lessons.push({ date, wochentag, subject: name, startTime: "", endTime: "", room: "", teacher: "", status });
    }

    // Tag ohne jegliche Einträge → als "Freier Tag" markieren
    if ((day.gridEntries ?? []).length === 0 && (day.backEntries ?? []).length === 0 && (day.dayEntries ?? []).length === 0) {
      lessons.push({ date, wochentag, subject: "Freier Tag", startTime: "", endTime: "", room: "", teacher: "", status: "Freier Tag" });
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
    if (!url.includes("timetable/entries") || url.includes("settings")) return;
    try {
      const json = await response.json();
      const lessons = extractLessons(json);
      if (lessons.length > 0) {
        console.log("Eintraege: " + lessons.length);
        capturedLessons.push(...lessons);
      }
    } catch {}
  });

  try {
    console.log("Oeffne WebUntis...");
    await page.goto("https://wkdo.webuntis.com/WebUntis/?school=wkdo", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => { for (const el of document.querySelectorAll("button, a")) { if (el.textContent.includes("IServ")) { el.click(); return; } } });
    await waitForUrl(page, "iserv", 10000);
    if (page.url().includes("login")) {
      console.log("Login...");
      await page.waitForSelector('input[name="_username"]', { timeout: 10000 });
      await page.fill('input[name="_username"]', ISERV_USER);
      await page.fill('input[name="_password"]', ISERV_PASS);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(4000);
    }
    const zulassen = await page.$('button:has-text("Zulassen")');
    if (zulassen) { await zulassen.click(); await page.waitForTimeout(4000); }
    console.log("Eingeloggt: " + page.url());

    for (const offset of [0, 1, 2]) {
      const dateStr = toISODate(getMondayOfWeek(offset));
      console.log("Woche: " + dateStr);
      const responsePromise = page.waitForResponse(
        r => r.url().includes("timetable/entries") && !r.url().includes("settings"),
        { timeout: 15000 }
      ).catch(() => null);
      await page.goto("https://wkdo.webuntis.com/timetable/my-student?date=" + dateStr, { waitUntil: "domcontentloaded", timeout: 20000 });
      await responsePromise;
      await page.waitForTimeout(1000);
      console.log("Bisher: " + capturedLessons.length);
    }
    return capturedLessons;
  } finally {
    await browser.close();
  }
}

async function deleteEntriesForDate(dateStr) {
  const res = await notion.databases.query({ database_id: DATABASE_ID, filter: { property: "Datum", date: { equals: dateStr } } });
  for (const p of res.results) await notion.pages.update({ page_id: p.id, archived: true });
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
      Wochentag: { select:    { name: lesson.wochentag                 } },
    },
  });
}

async function sync() {
  console.log("START");
  const allLessons = await fetchTimetable();
  if (allLessons.length === 0) { console.log("Keine Eintraege"); process.exit(1); }
  const unique = new Map();
  for (const l of allLessons) unique.set(l.date + l.startTime + l.subject, l);
  const lessons = [...unique.values()];
  const dates = [...new Set(lessons.map(l => l.date))].sort();
  for (const date of dates) {
    const d = lessons.filter(l => l.date === date);
    await deleteEntriesForDate(date);
    for (const l of d) await createEntry(l);
    console.log(date + ": " + d.length);
  }
  console.log("FERTIG");
}

sync().catch(err => { console.error("FEHLER: " + err.message); process.exit(1); });
