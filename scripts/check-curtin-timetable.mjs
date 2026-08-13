import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHOOL = "School of Pre-U and Continues Studies";
const UNITS = [
  "CMFP0050 Physics 1",
  "CMFP0060 Information & Communication Technology",
];
const TARGETS = ["1E1", "1E8"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const LOCATION_MAP = new Map([
  ["PA3 103 (Computer Lab)", "PA3 103 (Computer Lab)"],
  ["PA3 106", "PA3-106"],
  ["PA3 108", "PA3-108"],
  ["PA3 206", "PA3-206"],
  ["PA3 207", "PA3-207"],
  ["SK2 101 (ME 101) Physic Lab", "SK2 101 (ME101) Physic Lab"],
  ["SK3 102 Lecture 1", "SK3 102 (Lecture1)"],
  ["LTCL 10 (HL2-110)", "LTCL10 (HL2-110)"],
]);

const normalise = (value) => value.replace(/\s+/g, " ").trim();
const locationFor = (value) => LOCATION_MAP.get(normalise(value)) ?? normalise(value);
const subjectFor = (text) => {
  const unit = text.includes("CMFP0060") ? "ICT" : "Physics";
  const type = text.includes("Laboratory") ? "lab" : text.includes("Tutorial") ? "tutorial" : "lecture";
  return `${unit} (${type})`;
};
const groupMatches = (text, group) =>
  new RegExp(`(^|[^A-Z0-9])${group}(?:\\s*\\(Reserve\\))?(?=$|[^A-Z0-9])`).test(text) ||
  text.includes("1E1-8");

async function openTimetable(page) {
  await page.goto("http://sws.curtin.edu.my/login.aspx", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "Student - Click here", exact: true }).click();
  await page.getByRole("link", { name: "Units", exact: true }).click();
  await page.locator("select[name=dlFilter]").selectOption({ label: SCHOOL });
  await page.locator("select[name=dlObject]").selectOption(UNITS.map((label) => ({ label })));
  await page.locator("select[name=lbWeeks]").selectOption("29-43");
  await page.locator("select[name=lbDays]").selectOption("1-5");
  await page.getByRole("button", { name: "View Timetable", exact: true }).click();
  await page.waitForTimeout(1_000);
}

async function collect(page, group) {
  return page.evaluate(({ group, days }) => {
    const norm = (value) => value.replace(/\s+/g, " ").trim();
    const matches = (value) =>
      new RegExp(`(^|[^A-Z0-9])${group}(?:\\s*\\(Reserve\\))?(?=$|[^A-Z0-9])`).test(value) ||
      value.includes("1E1-8");

    const rows = [...document.querySelectorAll("tr")];
    const times = rows
      .map((row) => {
        const first = norm(row.querySelector("td")?.textContent || "");
        return /^\d{1,2}:\d{2}$/.test(first) ? { row, minutes: Number(first.slice(0, first.indexOf(":"))) * 60 + Number(first.slice(first.indexOf(":") + 1)) } : null;
      })
      .filter(Boolean);

    const dayHeaders = [...document.querySelectorAll("td")]
      .map((cell) => ({ cell, text: norm(cell.textContent || ""), rect: cell.getBoundingClientRect() }))
      .filter(({ text }) => days.includes(text));

    const candidates = [...document.querySelectorAll("td")]
      .filter((cell) => cell.querySelector("table") && matches(norm(cell.textContent || "")))
      .filter((cell) => ![...cell.children].some((child) => child.tagName === "TD" && matches(norm(child.textContent || ""))));

    const events = [];
    for (const cell of candidates) {
      const text = norm(cell.textContent || "");
      if (!text.includes("CMFP0050") && !text.includes("CMFP0060")) continue;
      const rect = cell.getBoundingClientRect();
      const day = dayHeaders.find(({ rect: h }) => rect.left + rect.width / 2 >= h.left && rect.left + rect.width / 2 <= h.right)?.text;
      const row = times.find(({ row }) => row === cell.closest("tr"));
      if (!day || !row) continue;
      const duration = Math.max(30, (cell.rowSpan || 1) * 30);
      const location = norm([...cell.querySelectorAll("td")].map((item) => norm(item.textContent || "")).find((item) =>
        /^(PA3|SK2|SK3|LTCL|Harry Perkins|Auditorium)/.test(item)
      ) || "");
      events.push({ day: days.indexOf(day), start: row.minutes, end: row.minutes + duration, subject: text, location });
    }
    return events;
  }, { group, days: DAYS });
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await openTimetable(page);

  for (const group of TARGETS) {
    const rawEvents = await collect(page, group);
    const timetable = Object.fromEntries([...Array(7).keys()].map((day) => [String(day), []]));
    for (const event of rawEvents) {
      timetable[String(event.day)].push({
        start: event.start,
        end: event.end,
        subject: subjectFor(event.subject),
        location: locationFor(event.location),
      });
    }
    for (const events of Object.values(timetable)) {
      events.sort((a, b) => a.start - b.start || a.subject.localeCompare(b.subject));
    }

    const filename = path.join("关注塔菲喵", `${group}.json`);
    const current = JSON.parse(await readFile(filename, "utf8"));
    if (JSON.stringify(current) !== JSON.stringify(timetable)) {
      await writeFile(filename, `${JSON.stringify(timetable, null, 2)}\n`);
      console.log(`Updated ${filename}`);
    } else {
      console.log(`No change in ${filename}`);
    }
  }
} finally {
  await browser.close();
}