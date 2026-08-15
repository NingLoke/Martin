from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')
old = '''            dayCourses.forEach(course => {
                courses.push({ ...course, className: classInfo.name });
            });
        });

        courses.sort((a, b) =>
            a.start - b.start ||
            a.end - b.end ||
            a.className.localeCompare(b.className)
        );'''
new = '''            dayCourses.forEach(course => {
                const existing = courses.find(item =>
                    item.start === course.start &&
                    item.end === course.end &&
                    item.subject === course.subject &&
                    item.location === course.location
                );

                if (existing) {
                    existing.classNames.push(classInfo.name);
                }
                else {
                    courses.push({ ...course, classNames: [classInfo.name] });
                }
            });
        });

        courses.sort((a, b) =>
            a.start - b.start ||
            a.end - b.end ||
            a.classNames.join(', ').localeCompare(b.classNames.join(', '))
        );'''
if old not in s:
    raise SystemExit('target block not found')
s = s.replace(old, new, 1)
old2 = '''        const classLabel = selectedViewMode === "all"
            ? `　👥 ${escapeHTML(course.className)}`
            : "";'''
new2 = '''        const classLabel = selectedViewMode === "all"
            ? `　👥 ${escapeHTML(course.classNames.join(", "))}`
            : "";'''
if old2 not in s:
    raise SystemExit('label block not found')
s = s.replace(old2, new2, 1)
p.write_text(s, encoding='utf-8')
