import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHOOL = "School of Pre-U and Continues Studies";

const UNIT_DEFINITIONS = {
  CMFP0021: { label: "CMFP0021 Effective Communication Skills", subject: "ECS" },
  CMFP0042: { label: "CMFP0042 Mathematics 2", subject: "Math 2" },
  CMFP0050: { label: "CMFP0050 Physics 1", subject: "Physics" },
  CMFP0060: { label: "CMFP0060 Information & Communication Technology", subject: "ICT" },
};

const TIMETABLES = {
  "1E1": [
    { unit: "CMFP0050", group: "1E1" },
    { unit: "CMFP0060", group: "1E1" },
  ],
  "1E8": [
    { unit: "CMFP0050", group: "1E8" },
    { unit: "CMFP0060", group: "1E8" },
  ],
  test: [
    { unit: "CMFP0021", group: "Group A" },
    { unit: "CMFP0042", group: "2E1" },
  ],
};

const UNITS = [...new Set(
  Object.values(TIMETABLES).flat().map(({ unit }) => UNIT_DEFINITIONS[unit].label)
)];

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
const subjectFor = (description, type) => {
  const unit = Object.keys(UNIT_DEFINITIONS).find((code) => description.includes(code));
  if (!unit) throw new Error(`Unknown unit: ${description}`);
  return `${UNIT_DEFINITIONS[unit].subject} (${type === "Laboratory" ? "lab" : type.toLowerCase()})`;
};
const groupMatches = (value, group) => {
  if (new RegExp(`(^|[^A-Z0-9])${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*\\(Reserve\\))?(?=$|[^A-Z0-9])`, "i").test(value)) {
    return true;
  }
  const cohort = group.match(/^(\dE)[1-8]$/i);
  return cohort ? new RegExp(`(^|[^A-Z0-9])${cohort[1]}1-8(?=$|[^A-Z0-9])`, "i").test(value) : false;
};
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
  await page.waitForTimeout(1_000);
  await page.waitForLoadState("domcontentloaded");
  const unitSelect = page.locator("select[name=dlObject]");
  const options = await unitSelect.locator("option").evaluateAll((elements) => elements.map((option) => ({
    label: (option.textContent || "").replace(/\s+/g, " ").trim(),
    value: option.value,
  })));
  const selectedValues = UNITS.map((label) => {
    const unitCode = label.split(" ")[0];
    const match = options.find((option) => option.label.includes(unitCode));
    if (!match) throw new Error(`Curtin unit ${unitCode} was not found in the Units list.`);
    return match.value;
  });
  await unitSelect.selectOption(selectedValues);
  await page.locator("select[name=lbWeeks]").selectOption("29-43");
  await page.locator("select[name=lbDays]").selectOption("1-5");
  await page.locator("select[name=dlType]").selectOption({ label: "List" });
  await page.getByRole("button", { name: "View Timetable", exact: true }).click();
  await page.waitForTimeout(1_000);
}

async function collect(page, name, selections) {
  const rows = await page.locator("tr").evaluateAll((elements) => elements.map((row) =>
    [...row.cells].map((cell) => (cell.textContent || "").replace(/\s+/g, " ").trim())
  ).filter((cells) => cells.length === 11));

  const events = rows
    .filter((cells) => selections.some(({ unit, group }) =>
      cells[2].includes(unit) && groupMatches(cells[1], group)
    ))
    .map((cells) => ({
      day: dayFor(cells[4]),
      start: minutes(cells[5]),
      end: minutes(cells[6]),
      subject: subjectFor(cells[2], cells[3]),
      location: cells[9],
    }));

  if (events.length === 0) {
    const unitCodes = selections.map(({ unit }) => unit);
    const candidates = rows.filter((cells) => unitCodes.some((unit) => cells[2].includes(unit)));
    console.log(`Candidate rows for ${name}: ${JSON.stringify(candidates)}`);
    throw new Error(`List report format was not recognised for ${name}; refusing to update data.`);
  }
  return events;
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await openListReport(page);

  let changed = false;

  for (const [name, selections] of Object.entries(TIMETABLES)) {
    const timetable = Object.fromEntries([...Array(7).keys()].map((day) => [String(day), []]));
    for (const event of await collect(page, name, selections)) {
      timetable[String(event.day)].push({
        start: event.start, end: event.end, subject: event.subject, location: event.location,
      });
    }
    for (const events of Object.values(timetable)) {
      events.sort((a, b) => a.start - b.start || a.subject.localeCompare(b.subject));
    }

    console.log(`Calculated ${name}: ${JSON.stringify(timetable)}`);
    const filename = path.join("关注塔菲喵", `${name}.json`);
    const current = JSON.parse(await readFile(filename, "utf8"));
    if (canonical(current) !== canonical(timetable)) {
      await writeFile(filename, `${JSON.stringify(timetable, null, 2)}\n`);
      changed = true;
      console.log(`Updated ${filename}`);
    } else {
      console.log(`No schedule change in ${filename}`);
    }
  }

  await writeFile(
    path.join("关注塔菲喵", "last-updated.json"),
    `${JSON.stringify({ updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
  console.log(changed ? "Updated timetable and check timestamp" : "Updated check timestamp; timetable unchanged");
} finally {
  await browser.close();
}
