import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHOOL = "School of Pre-U and Continues Studies";
const UNITS = ["CMFP0050 Physics 1", "CMFP0060 Information & Communication Technology"];
const TARGETS = ["1E1", "1E8"];

const normalise = (value) => value.replace(/\s+/g, " ").trim();
const minutes = (time) => {
  const match = time.match(/(\d{1,2}):(\d{2})/);
  if (!match) throw new Error(`Missing time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
};
const dayFor = (date) => {
  const match = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) throw new Error(`Unrecognised Curtin date: ${date}`);
  const dayOfWeek = new Date(Date.UTC(2000 + Number(match[3]), Number(match[2]) - 1, Number(match[1]))).getUTCDay();
  return dayOfWeek === 0 ? 6 : dayOfWeek - 1;
};
const subjectFor = (description, type) =>
  `${description.includes("CMFP0060") ? "ICT" : "Physics"} (${type === "Laboratory" ? "lab" : type.toLowerCase()})`;
const groupMatches = (value, group) =>
  new RegExp(`(^|[^A-Z0-9])${group}(?:\\s*\\(Reserve\\))?(?=$|[^A-Z0-9])`, "i").test(value) ||
  value.includes("1E1-8");
const canonical = (timetable) => JSON.stringify(Object.fromEntries(Object.entries(timetable).map(([day, events]) => [
  day,
  events.map((event) => ({
    ...event,
    subject: event.subject.toLowerCase(),
    location: normalise(event.location)
      .replace(/-/g, " ")
      .replace(/\(Computer Lab\)|Physic Lab/gi, "")
      .replace(/ME\s*101/gi, "ME101")
      .replace(/Lecture\s*1/gi, "Lecture1")
      .replace(/LTCL\s*10/gi, "LTCL10")
      .toLowerCase(),
  })),
])));

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
  ).filter((cells) => cells.length === 11));

  const events = rows
    .filter((cells) => groupMatches(cells[1], group) && /CMFP00(?:50|60)/.test(cells[2]))
    .map((cells) => ({
      day: dayFor(cells[4]),
      start: minutes(cells[5]),
      end: minutes(cells[6]),
      subject: subjectFor(cells[2], cells[3]),
      location: cells[9],
    }));

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
    if (canonical(current) !== canonical(timetable)) {
      await writeFile(filename, `${JSON.stringify(timetable, null, 2)}\n`);
      console.log(`Updated ${filename}`);
    } else {
      console.log(`No schedule change in ${filename}`);
    }
  }
} finally {
  await browser.close();
}
