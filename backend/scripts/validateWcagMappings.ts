import fs from "fs";
import path from "path";

const scannerDir = path.resolve(__dirname, "..", "src", "scanner");

const activeWcag22 = new Set([
  "1.1.1",
  "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.2.6", "1.2.7", "1.2.8", "1.2.9",
  "1.3.1", "1.3.2", "1.3.3", "1.3.4", "1.3.5", "1.3.6",
  "1.4.1", "1.4.2", "1.4.3", "1.4.4", "1.4.5", "1.4.6", "1.4.7", "1.4.8", "1.4.9", "1.4.10", "1.4.11", "1.4.12", "1.4.13",
  "2.1.1", "2.1.2", "2.1.3", "2.1.4",
  "2.2.1", "2.2.2", "2.2.3", "2.2.4", "2.2.5", "2.2.6",
  "2.3.1", "2.3.2", "2.3.3",
  "2.4.1", "2.4.2", "2.4.3", "2.4.4", "2.4.5", "2.4.6", "2.4.7", "2.4.8", "2.4.9", "2.4.10", "2.4.11", "2.4.12", "2.4.13",
  "2.5.1", "2.5.2", "2.5.3", "2.5.4", "2.5.5", "2.5.6", "2.5.7", "2.5.8",
  "3.1.1", "3.1.2", "3.1.3", "3.1.4", "3.1.5", "3.1.6",
  "3.2.1", "3.2.2", "3.2.3", "3.2.4", "3.2.5", "3.2.6",
  "3.3.1", "3.3.2", "3.3.3", "3.3.4", "3.3.5", "3.3.6", "3.3.7", "3.3.8", "3.3.9",
  "4.1.2", "4.1.3"
]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

function normalizeCriterion(tag: string): string | null {
  const value = tag.trim().toLowerCase().replace(/^wcag/, "");
  if (/^(2|20|21|22)(a|aa|aaa)$/.test(value)) return null;
  const dotted = value.match(/\b([1-4]\.\d+\.\d+)\b/)?.[1];
  if (dotted) return dotted;
  const digits = value.replace(/[^0-9]/g, "");
  if (!/^[1-4]\d{2,3}$/.test(digits)) return null;
  return `${digits[0]}.${digits[1]}.${Number(digits.slice(2))}`;
}

const failures: string[] = [];
for (const file of walk(scannerDir)) {
  const source = fs.readFileSync(file, "utf8");
  const wcagArrayPattern = /wcag\s*:\s*\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = wcagArrayPattern.exec(source))) {
    const tags = Array.from(match[1].matchAll(/["'`]([^"'`]+)["'`]/g)).map((item) => item[1]);
    for (const tag of tags) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      if (/^wcag(2|20|21|22)(a|aa|aaa)$/i.test(tag)) {
        failures.push(`${path.relative(process.cwd(), file)}:${line} uses generic level tag ${tag} in wcag criteria`);
        continue;
      }
      const criterion = normalizeCriterion(tag);
      if (!criterion || !activeWcag22.has(criterion)) {
        failures.push(`${path.relative(process.cwd(), file)}:${line} uses invalid, obsolete, or inactive WCAG 2.2 criterion ${tag}`);
      }
    }
  }
}

if (failures.length) {
  console.error("WCAG mapping validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`WCAG mapping validation passed for ${activeWcag22.size} active WCAG 2.2 criteria.`);
