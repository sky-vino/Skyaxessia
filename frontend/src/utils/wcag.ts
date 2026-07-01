export type WcagLevel = "A" | "AA" | "AAA" | "Advisory Checks" | "Needs Review";

const LEVEL_TAGS: Record<string, WcagLevel> = {
  wcag2a: "A",
  wcag2aa: "AA",
  wcag2aaa: "AAA",
  wcag21a: "A",
  wcag21aa: "AA",
  wcag21aaa: "AAA",
  wcag22a: "A",
  wcag22aa: "AA",
  wcag22aaa: "AAA",
};

const LEVEL_BY_CRITERION: Record<string, WcagLevel> = {
  "1.1.1": "A", "1.2.1": "A", "1.2.2": "A", "1.2.3": "A", "1.2.4": "AA", "1.2.5": "AA",
  "1.3.1": "A", "1.3.2": "A", "1.3.3": "A", "1.3.4": "AA", "1.3.5": "AA", "1.3.6": "AAA",
  "1.4.1": "A", "1.4.2": "A", "1.4.3": "AA", "1.4.4": "AA", "1.4.5": "AA", "1.4.6": "AAA", "1.4.7": "AAA", "1.4.8": "AAA", "1.4.9": "AAA", "1.4.10": "AA", "1.4.11": "AA", "1.4.12": "AA", "1.4.13": "AA",
  "2.1.1": "A", "2.1.2": "A", "2.1.3": "AAA", "2.1.4": "A",
  "2.2.1": "A", "2.2.2": "A", "2.2.3": "AAA", "2.2.4": "AAA", "2.2.5": "AAA", "2.2.6": "AAA",
  "2.3.1": "A", "2.3.2": "AAA", "2.3.3": "AAA",
  "2.4.1": "A", "2.4.2": "A", "2.4.3": "A", "2.4.4": "A", "2.4.5": "AA", "2.4.6": "AA", "2.4.7": "AA", "2.4.8": "AAA", "2.4.9": "AAA", "2.4.10": "AAA", "2.4.11": "AA", "2.4.12": "AAA", "2.4.13": "AAA",
  "2.5.1": "A", "2.5.2": "A", "2.5.3": "A", "2.5.4": "A", "2.5.5": "AAA", "2.5.6": "AAA", "2.5.7": "AA", "2.5.8": "AA",
  "3.1.1": "A", "3.1.2": "AA", "3.1.3": "AAA", "3.1.4": "AAA", "3.1.5": "AAA", "3.1.6": "AAA",
  "3.2.1": "A", "3.2.2": "A", "3.2.3": "AA", "3.2.4": "AA", "3.2.5": "AAA", "3.2.6": "A",
  "3.3.1": "A", "3.3.2": "A", "3.3.3": "AA", "3.3.4": "AA", "3.3.5": "AAA", "3.3.6": "AAA", "3.3.7": "A", "3.3.8": "AA", "3.3.9": "AAA",
  "4.1.1": "A", "4.1.2": "A", "4.1.3": "AA",
};

const LEVEL_COLORS: Record<WcagLevel, string> = {
  A: "#0f766e",
  AA: "#a78bfa",
  AAA: "#ffd60a",
  "Advisory Checks": "#0b84a5",
  "Needs Review": "#94a3b8",
};

export function normalizeCriterion(tag: string): string | null {
  const raw = String(tag || "")
    .toLowerCase()
    .trim()
    .replace(/^wcag\s*/, "")
    .replace(/^sc\s*/, "")
    .replace(/^(?:level\s*)?[aaa]+\s+/, "");

  const dotted = raw.match(/^(\d)\.(\d)\.(\d{1,2})$/);
  if (dotted) return `${dotted[1]}.${dotted[2]}.${dotted[3]}`;

  const compact = raw.replace(/[^0-9]/g, "");
  if (!/^\d{3,4}$/.test(compact)) return null;
  return `${compact[0]}.${compact[1]}.${compact.slice(2)}`;
}

export function getWcagLevel(tag: string): WcagLevel {
  const raw = String(tag || "").toLowerCase();
  if (LEVEL_TAGS[raw]) return LEVEL_TAGS[raw];
  if (raw === "best-practice") return "Advisory Checks";
  const criterion = normalizeCriterion(raw);
  return criterion ? (LEVEL_BY_CRITERION[criterion] || "Needs Review") : "Needs Review";
}

export function formatWcagTag(tag: string): string {
  const raw = String(tag || "").toLowerCase();
  const criterion = normalizeCriterion(raw);
  if (criterion) return `WCAG ${criterion}`;
  if (LEVEL_TAGS[raw]) return `Level ${LEVEL_TAGS[raw]}`;
  if (raw === "best-practice") return "Advisory Checks";
  return String(tag || "").replace(/^wcag/i, "WCAG ");
}

export function getIssueCriteria(issue: any): string[] {
  return Array.from(new Set((issue.wcag_criteria || []).map((tag: string) => normalizeCriterion(tag)).filter(Boolean))) as string[];
}

export function getIssueComplianceLevels(issue: any): WcagLevel[] {
  const levels = new Set<WcagLevel>();
  for (const tag of issue.wcag_criteria || []) {
    const level = getWcagLevel(tag);
    if (level !== "Needs Review") levels.add(level);
  }
  if (!levels.size && issue.tags?.includes?.("best-practice")) levels.add("Advisory Checks");
  return Array.from(levels);
}

export function levelColor(level: WcagLevel): string {
  return LEVEL_COLORS[level] || LEVEL_COLORS["Needs Review"];
}

function primaryComplianceLevel(issue: any): WcagLevel {
  const levels = getIssueComplianceLevels(issue);
  if (levels.includes("A")) return "A";
  if (levels.includes("AA")) return "AA";
  if (levels.includes("AAA")) return "AAA";
  if (levels.includes("Advisory Checks")) return "Advisory Checks";
  return "Needs Review";
}

export function summarizeCompliance(issues: any[]) {
  const summary: Record<WcagLevel, { failed: number; criteria: Set<string> }> = {
    A: { failed: 0, criteria: new Set() },
    AA: { failed: 0, criteria: new Set() },
    AAA: { failed: 0, criteria: new Set() },
    "Advisory Checks": { failed: 0, criteria: new Set() },
    "Needs Review": { failed: 0, criteria: new Set() },
  };

  for (const issue of issues) {
    const level = primaryComplianceLevel(issue);
    const criteria = getIssueCriteria(issue);
    summary[level].failed += 1;
    criteria.forEach(c => summary[level].criteria.add(formatWcagTag(c)));
  }

  return ["A", "AA", "AAA", "Advisory Checks", "Needs Review"].map(level => ({
    level: level as WcagLevel,
    failed: summary[level as WcagLevel].failed,
    criteria: summary[level as WcagLevel].criteria.size,
    color: levelColor(level as WcagLevel),
  }));
}


