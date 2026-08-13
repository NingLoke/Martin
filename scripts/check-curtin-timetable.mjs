import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHOOL = "School of Pre-U and Continues Studies";
const UNITS = ["CMFP0050 Physics 1", "CMFP0060 Information & Communication Technology"];
const TARGETS = ["1E1", "1E8"];
const DAY_INDEX = new Map([
  ["MONDAY", 0], ["TUESDAY", 1], ["WEDNESDAY", 2], ["THURSDAY", 3], ["FRIDAY", 4],
]);

const normalise = (value) => value.replace(/\s+/g, " ").trim();
const minutes = (time) => {
  const match = time.match(/(\d{1,2}):(\d{2})/);
  if (!match) throw new Error(`Missing time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
};
const locationFor = (value) => normalise(value)
  .replace(/^PA3\s+(\d+)$/, "PA3-$1")
  .replace(/^SK3 102 Lecture 1$/, "SK3 102 (Lecture1)")
  .replace(/^LTCL 10/, "LTCL10")
  .replace(/^SK2 101 \(ME 101\)/, "SK2 101 (ME101)");
const subjectFor = (text) => {
  const unit = text.includes("CMFP0060") ? "ICT" : "Physics";
  const type = text.includes("Laboratory") ? "lab" : text.includes("Tutorial") ? "tutorial" : "lecture";
  return `${unit} (${type})`;
};
const groupMatches = (text, group) =>
  new RegExp(`(^|[^A-Z0-9])${group}(?:\\s*\\(Reserve\\))?(?=$|[^A-Z0-9])`).test(text) ||
  text.includes("1E1-8");

async function openListReport(page) {
  await page.goto("http://sws.curtin.edu.my/login.aspx", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "Student - Click here", exact: true }).click();
  await page.getByRole("link", { name: "Units", exact: true }).click();
  await page.locator("select[name=dlFilter]").selectOption({ label: SCHOOL });
  await page.locator("select[name=dlObject]").selectOption(UNITS.map((label) => ({ label })));
  await page.locator("select[name=lbWeeks]").selectOption("29-43");
  await page.locator("select[name=lbDays]").selectOption("1-5");
  await page.locator("select[name=dlType]").selectOption({ label: "List" });
  await page.getByRole("button", { name: "View Timetable", exact: true }).click();
  await page.waitForTimeout(1_000);
}

async function collect(page, group) {
  const rows = await page.locator("tr").evaluateAll((elements) => elements.map((row) =>
    [...row.cells].map((cell) => (cell.textContent || "").replace(/\s+/g, " ").trim())
  ).filter((cells) => cells.length > 1));

  const events = [];
  for (const cells of rows) {
    const joined = normalise(cells.join(" "));
    if (!groupMatches(joined, group) || !/CMFP00(?:50|60)/.test(joined)) continue;
    const day = [...DAY_INDEX.keys()].find((name) => new RegExp(`\\b${name}\\b`, "i").test(joined));
    const times = [...joined.matchAll(/\b\d{1,2}:\d{2}\b/g)].map((match) => match[0]);
    const location = cells.find((cell) => /^(PA3|SK2|SK3|LTCL|Harry Perkins|Auditorium)/i.test(normalise(cell)));
    if (!day || times.length < 2 || !location) continue;
    events.push({
      day: DAY_INDEX.get(day),
      start: minutes(times[0]),
      end: minutes(times[1]),
      subject: subjectFor(joined),
      location: locationFor(location),
    });
  }

  if (events.length === 0) throw new Error(`List report format was not recognised for ${group}; refusing to update data.`);
  return events;
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await openListReport(page);

  for (const group of TARGETS) {
    const timetable = Object.fromEntries([...Array(7).keys()].map((day) => [String(day), []]));
    for (const event of await collect(page, group)) {
      timetable[String(event.day)].push({
        start: event.start, end: event.end, subject: event.subject, location: event.location,
      });
    }
    for (const events of Object.values(timetable)) {
      events.sort((a, b) => a.start - b.start || a.subject.localeCompare(b.subject));
    }

    console.log(`Calculated ${group}: ${JSON.stringify(timetable)}`);
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