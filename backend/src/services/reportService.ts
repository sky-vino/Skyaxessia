/**
 * Generates a compact interactive HTML accessibility report.
 * The same HTML can be printed to PDF, but filters/expansion are intended for the HTML report.
 */

import { db } from "../utils/db";
import { format } from "date-fns";

function escapeHtml(value: any): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value: any): string {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function asArray(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [value];
}

function affectedCount(issue: any): number {
  const selectors = asArray(issue.selectors);
  return Number(issue.affected_count || selectors.length || (issue.selector ? 1 : 0));
}

function affectedElementLabels(issue: any): string[] {
  const labels = asArray(issue.affected_elements || issue.affectedElements)
    .map(value => String(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 40);
}

function cleanEvidenceText(value: string): string {
  return String(value || "")
    .replace(/Use this evidence together with the selector, HTML snippet, issue message, and recommended fix\./gi,
      "Use this evidence together with the affected component, issue message, and recommended fix.")
    .trim();
}

function friendlyElementName(selector: string): string {
  if (!selector) return "Page element";
  const id = selector.match(/#([a-zA-Z0-9_-]+)/)?.[1];
  const aria = selector.match(/\[aria-label=["']?([^"'\]]+)/i)?.[1];
  const tag = (selector.match(/^([a-z0-9]+)/i)?.[1] || "element").toLowerCase();
  const labels: Record<string, string> = {
    a: "Link",
    button: "Button",
    input: "Input",
    img: "Image",
    select: "Select field",
    textarea: "Text field",
    meta: "Page metadata",
    nav: "Navigation",
    header: "Header",
    footer: "Footer",
    main: "Main content",
    html: "Page root"
  };
  const label = labels[tag] || `${tag.charAt(0).toUpperCase()}${tag.slice(1)} element`;
  const name = id || aria;
  return name ? `${label}: ${String(name).replace(/[-_]+/g, " ")}` : label;
}

function issueTitle(issue: any): string {
  const rule = String(issue.rule_id || "");
  const message = String(issue.message || "").replace(/\s*\([^)]*affected elements grouped\)\s*$/i, "").trim();
  if (/text.*clip|truncat/i.test(message)) return "Text content may be clipped or truncated";
  if (/meta-viewport/i.test(rule)) return "Mobile zoom is restricted";
  if (/label|input-no-label/i.test(rule)) return "Form control is missing a clear label";
  if (/color:focus-indicator-low-contrast/i.test(rule)) return "Focus indicator contrast is too low";
  if (/color:contrast-insufficient/i.test(rule)) return "Text contrast is too low";
  if (/color|contrast/i.test(rule)) return "Text or control contrast is too low";
  if (/focus:invisible/i.test(rule)) return "Keyboard focus indicator is not visible";
  if (/focus:trap|trap-missing/i.test(rule)) return "Keyboard focus can become trapped or unusable";
  if (/aria-required-children/i.test(rule)) return "ARIA role is missing required child elements";
  if (/landmark.*unique|landmark-unique/i.test(rule)) return "Landmark needs a unique accessible name";
  if (/nested-interactive/i.test(rule)) return "Interactive controls are nested";
  if (/target-size/i.test(rule)) return "Interactive target is too small";
  if (/heading-order/i.test(rule)) return "Heading order is not logical";
  return message || rule || "Accessibility issue";
}

function conciseImpact(issue: any): string {
  const rule = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/clip|truncat|overflow/i.test(rule)) return "Important text may be hidden, especially at zoom or smaller viewport sizes.";
  if (/focus/i.test(rule)) return "Keyboard users may lose their place or be unable to operate the page predictably.";
  if (/meta-viewport/i.test(rule)) return "Mobile users may be blocked from zooming content.";
  if (/aria|role|landmark/i.test(rule)) return "Screen reader users may receive confusing structure, labels, or roles.";
  if (/label/i.test(rule)) return "Users may not understand what a form control is asking for.";
  if (/color|contrast/i.test(rule)) return "Low-vision users may not be able to read the affected content.";
  if (/target-size|pointer/i.test(rule)) return "Users may have difficulty selecting or tapping the control.";
  return "This can make the page harder to understand, navigate, or operate.";
}

function verifyStep(issue: any): string {
  const rule = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/clip|truncat|overflow/i.test(rule)) return "Zoom to 200%, resize the viewport, and confirm the full text remains visible or discoverable.";
  if (/focus/i.test(rule)) return "Use Tab and Shift+Tab and confirm visible focus on the affected control.";
  if (/meta-viewport/i.test(rule)) return "Use mobile emulation and confirm browser/pinch zoom is allowed.";
  if (/aria|role|landmark/i.test(rule)) return "Inspect with a screen reader or accessibility tree and confirm the correct name, role, and structure.";
  if (/label/i.test(rule)) return "Focus the control and confirm a clear visible label or accessible name is announced.";
  if (/color|contrast/i.test(rule)) return "Check the foreground/background colors against WCAG contrast thresholds.";
  return "Open the listed page, reproduce the issue, apply the fix, and re-run the scan.";
}

function recommendedFix(issue: any): string {
  const suggestion = String(issue.fix_suggestion || "").trim();
  if (suggestion && !/^fix any of the following/i.test(suggestion)) return suggestion;
  const rule = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/clip|truncat|overflow/i.test(rule)) return "Allow content to wrap, increase container height, or provide an accessible expansion/full-text pattern.";
  if (/focus/i.test(rule)) return "Add a visible focus style that is not hidden by overlays, clipping, or color-only changes.";
  if (/meta-viewport/i.test(rule)) return "Remove maximum-scale and user-scalable restrictions from the viewport meta tag.";
  if (/label/i.test(rule)) return "Associate each control with a visible label, aria-label, or aria-labelledby value.";
  if (/aria-required-children/i.test(rule)) return "Use the required child roles or replace the custom ARIA pattern with semantic HTML.";
  if (/landmark/i.test(rule)) return "Give repeated landmarks unique names, for example with aria-label or aria-labelledby.";
  if (/nested-interactive/i.test(rule)) return "Do not place a link, button, or input inside another interactive control.";
  if (/color|contrast/i.test(rule)) return "Adjust the text/icon and background colors to meet the applicable WCAG contrast ratio.";
  return "Fix the affected component, re-test the page, and close the issue only after verification.";
}

function severityColor(severity: string): string {
  return { critical: "#be123c", serious: "#b45309", moderate: "#a16207", minor: "#0369a1" }[severity] || "#475569";
}

function severityRank(severity: string): number {
  return { critical: 1, serious: 2, moderate: 3, minor: 4 }[severity] || 5;
}

function wcagLevel(issue: any): "A" | "AA" | "AAA" | "Advisory" | "Needs review" {
  // Ship 1 / Item 2 fix — the previous implementation regex-matched axe-core
  // level tags (wcag2a / wcag22aa / wcag22aaa) on the joined string. Since the
  // scanner + governance now emit criterion codes (2.4.11 / wcag2.4.11 / the
  // compact "2411" form), every issue fell through to "Needs review" in the
  // PDF while the dashboard bucketed them correctly. Fix: normalize each tag
  // to a dotted criterion, look up its level in wcagCriterionLevels, and take
  // the strictest present. Falls back to legacy axe level tags, then to a
  // "best-practice" tag / "advisory" category check — mirroring the frontend
  // logic in frontend/src/utils/wcag.ts so PDF and dashboard agree.
  const rawTags = asArray(issue.wcag_criteria).concat(asArray(issue.tags)).map(String);
  const found = new Set<"A" | "AA" | "AAA">();
  for (const raw of rawTags) {
    const criterion = wcagCriterionFromTag(raw);
    if (criterion && wcagCriterionLevels[criterion]) {
      found.add(wcagCriterionLevels[criterion]);
      continue;
    }
    const lower = raw.toLowerCase().trim();
    if (/^wcag\d*aaa$/.test(lower)) found.add("AAA");
    else if (/^wcag\d*aa$/.test(lower)) found.add("AA");
    else if (/^wcag\d*a$/.test(lower)) found.add("A");
  }
  if (found.has("A")) return "A";
  if (found.has("AA")) return "AA";
  if (found.has("AAA")) return "AAA";
  if (rawTags.some(tag => tag.toLowerCase() === "best-practice")) return "Advisory";
  if (String(issue.category || "").toLowerCase() === "advisory") return "Advisory";
  return "Needs review";
}

const wcagCriterionLevels: Record<string, "A" | "AA" | "AAA"> = {
  "1.1.1": "A", "1.2.1": "A", "1.2.2": "A", "1.2.3": "A", "1.3.1": "A", "1.3.2": "A", "1.3.3": "A", "1.4.1": "A", "1.4.2": "A",
  "2.1.1": "A", "2.1.2": "A", "2.2.1": "A", "2.2.2": "A", "2.3.1": "A", "2.4.1": "A", "2.4.2": "A", "2.4.3": "A", "2.4.4": "A",
  "3.1.1": "A", "3.2.1": "A", "3.2.2": "A", "3.3.1": "A", "3.3.2": "A", "4.1.1": "A", "4.1.2": "A",
  "1.2.4": "AA", "1.2.5": "AA", "1.3.4": "AA", "1.3.5": "AA", "1.4.3": "AA", "1.4.4": "AA", "1.4.5": "AA", "1.4.10": "AA", "1.4.11": "AA", "1.4.12": "AA", "1.4.13": "AA",
  "2.4.5": "AA", "2.4.6": "AA", "2.4.7": "AA", "2.4.11": "AA", "2.5.7": "AA", "2.5.8": "AA",
  // Tier 3 fix — WCAG 2.4.12 "Focus Not Obscured (Enhanced)" is AAA per the
  // WCAG 2.2 spec. Previously this file had it as AA, which contradicted both
  // the frontend (frontend/src/utils/wcag.ts) and the governance service
  // (backend/src/services/wcagGovernanceService.ts). PDF and dashboard would
  // disagree on the level of this criterion.
  "2.4.12": "AAA",
  "3.1.2": "AA", "3.2.3": "AA", "3.2.4": "AA", "3.3.3": "AA", "3.3.4": "AA", "3.3.7": "AA", "3.3.8": "AA", "4.1.3": "AA",
  "1.2.6": "AAA", "1.2.7": "AAA", "1.2.8": "AAA", "1.2.9": "AAA", "1.3.6": "AAA", "1.4.6": "AAA", "1.4.7": "AAA", "1.4.8": "AAA", "1.4.9": "AAA",
  "2.1.3": "AAA", "2.2.3": "AAA", "2.2.4": "AAA", "2.2.5": "AAA", "2.2.6": "AAA", "2.3.2": "AAA", "2.3.3": "AAA", "2.4.8": "AAA", "2.4.9": "AAA", "2.4.10": "AAA", "2.4.13": "AAA", "2.5.5": "AAA", "2.5.6": "AAA",
  "3.1.3": "AAA", "3.1.4": "AAA", "3.1.5": "AAA", "3.1.6": "AAA", "3.2.5": "AAA", "3.3.5": "AAA", "3.3.6": "AAA", "3.3.9": "AAA",
};

function wcagCriterionFromTag(item: string): string | null {
  const value = String(item || "").toLowerCase().replace(/^wcag\s*/i, "").trim();
  if (!value || /^[\d.]*a+$/.test(value)) return null;
  const dotted = value.match(/^(\d)\.(\d)\.(\d+)$/);
  if (dotted) return `${dotted[1]}.${dotted[2]}.${dotted[3]}`;
  const compact = value.match(/^(\d)(\d)(\d+)$/);
  if (compact) return `${compact[1]}.${compact[2]}.${compact[3]}`;
  return null;
}

function wcagTextWithLevel(item: string): string | null {
  const criterion = wcagCriterionFromTag(item);
  if (!criterion) return null;
  const level = wcagCriterionLevels[criterion];
  return `WCAG ${criterion}${level ? ` (${level})` : ""}`;
}

function wcagText(issue: any): string {
  const wcag = Array.from(new Set(asArray(issue.wcag_criteria).concat(asArray(issue.tags)).map((item) => wcagTextWithLevel(String(item))).filter(Boolean) as string[])).slice(0, 3);
  return wcag.length ? wcag.join(", ") : wcagLevel(issue);
}

function compactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname}${path}`;
  } catch {
    return url || "Page URL unavailable";
  }
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function removeUrls(value: string): string {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+on\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function prettyRuleName(ruleId?: string): string {
  const rule = String(ruleId || "");
  const map: Record<string, string> = {
    "axe:autocomplete-valid": "Autocomplete Attribute Validation",
    "axe:aria-required-children": "ARIA Required Children",
    "axe:landmark-unique": "Landmark Naming",
    "axe:meta-viewport": "Mobile Zoom Support",
    "focus:escape-key-missing": "Escape Key Modal Dismissal",
    "focus:invisible": "Visible Keyboard Focus",
    "keyboard:arrow-key-no-response": "Composite Widget Arrow-Key Navigation",
    "pointer:target-size-minimum": "Touch Target Size",
    "heuristic:landmark-main-missing": "Main Landmark Availability",
    "heuristic:reflow": "Responsive Reflow",
    "heuristic:status-message": "Status Message Announcement",
    "color:focus-indicator-low-contrast": "Focus Indicator Contrast",
  };
  if (map[rule]) return map[rule];
  return rule
    .replace(/^(axe|heuristic|keyboard|focus|pointer|zoom|color):/i, "")
    .replace(/[-_:]+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase()) || "Accessibility Requirement";
}

function testCaseDisplayName(tc: any, linkedIssue?: any): string {
  const raw = String(tc.name || "").trim();
  if (linkedIssue) return `${prettyRuleName(linkedIssue.rule_id)} Check`;
  const ruleMatch = `${tc.name || ""} ${tc.description || ""}`.match(/\b((?:axe|heuristic|keyboard|focus|pointer|zoom|color):[a-z0-9-]+)\b/i);
  if (ruleMatch) return `${prettyRuleName(ruleMatch[1])} Check`;
  return raw
    .replace(/^\[(MANUAL|HYBRID|CRITICAL|SERIOUS|MODERATE|MINOR)\]\s*/i, "")
    .replace(/^Automated check\s*:?\s*/i, "")
    .trim() || "Accessibility Verification";
}

function testCaseSummary(tc: any, linkedIssue?: any): string {
  if (linkedIssue) return `Verify that ${issueTitle(linkedIssue).toLowerCase()} is resolved for the affected page.`;
  const cleaned = removeUrls(String(tc.description || ""));
  if (/screen reader/i.test(`${tc.name} ${tc.description}`)) return "Validate reading order, announcements, names, roles, and state changes with assistive technology.";
  if (/keyboard-only|keyboard validation/i.test(`${tc.name} ${tc.description}`)) return "Validate the main task flow using keyboard-only navigation.";
  if (/dynamic|menus|modals|accordions|tabs/i.test(`${tc.name} ${tc.description}`)) return "Validate task-critical interactive states such as dialogs, menus, accordions, tabs, and validation states.";
  if (/responsive|zoom|touch/i.test(`${tc.name} ${tc.description}`)) return "Validate zoom, reflow, mobile viewport behavior, touch targets, and orientation support.";
  if (/form completion|error recovery|form validation/i.test(`${tc.name} ${tc.description}`)) return "Validate form submission, error identification, recovery guidance, autocomplete, and success messaging.";
  return cleaned || "Review the listed steps and mark the case after verification.";
}

function isProcedureStep(step: any): boolean {
  return step && typeof step === "object" && "stepText" in step && "coverageType" in step;
}

function coverageColor(type: string): string {
  return type === "automated" ? "#047857" : type === "hybrid" ? "#7c3aed" : "#64748b";
}

function procedureCoverageHtml(steps: any[]): string {
  const mapped = steps.filter(isProcedureStep);
  if (!mapped.length) return "";
  const counts = mapped.reduce((acc: Record<string, number>, step: any) => {
    acc[step.coverageType] = (acc[step.coverageType] || 0) + 1;
    acc[step.status] = (acc[step.status] || 0) + 1;
    return acc;
  }, {});
  const badges = `
    <div class="coverage-summary">
      <span>Automated ${counts.automated || 0}</span>
      <span>Hybrid ${counts.hybrid || 0}</span>
      <span>Manual ${counts.manual || 0}</span>
      <span>Pass ${counts.pass || 0}</span>
      <span>Fail ${counts.fail || 0}</span>
      <span>Review ${counts.pending || 0}</span>
    </div>`;
  return `${badges}<div class="procedure-steps">${mapped.map((step: any, index: number) => `
    <div class="procedure-step">
      <div class="procedure-head">
        <b>Step ${escapeHtml(step.stepNumber || index + 1)}</b>
        <span style="--coverage:${coverageColor(step.coverageType)}">${escapeHtml(step.coverageType || "manual")}</span>
        <em>${escapeHtml(step.status || "pending")}</em>
      </div>
      <p>${escapeHtml(step.stepText || "")}</p>
      <small><b>Covered by:</b> ${escapeHtml(step.scannerModule || "Manual review")}<br><b>Evidence:</b> ${escapeHtml(step.evidence || "Review required")}</small>
    </div>`).join("")}</div>`;
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

const REPORT_SECTIONS = ["executive", "navigation", "interactions", "testcases", "states", "issues"] as const;
type ReportSection = typeof REPORT_SECTIONS[number];

function normalizeReportSections(sections?: string[]): Set<ReportSection> {
  const requested = new Set((sections || []).map(section => section.toLowerCase().trim()));
  const selected = REPORT_SECTIONS.filter(section => requested.size === 0 || requested.has(section));
  return new Set(selected.length ? selected : REPORT_SECTIONS);
}

function hasReportSection(sections: Set<ReportSection>, section: ReportSection): boolean {
  return sections.has(section);
}

export async function generateScanReport(scanId: string, requestedSections?: string[]): Promise<string> {
  const selectedSections = normalizeReportSections(requestedSections);
  const [scanResult, issuesResult, testCasesResult, snapshotResult] = await Promise.all([
    db.query("SELECT s.*, u.full_name as created_by_name FROM scans s JOIN users u ON u.id = s.created_by WHERE s.id = $1", [scanId]),
    db.query(`SELECT * FROM issues WHERE scan_id = $1 AND COALESCE(false_positive, false) = false
      AND COALESCE(category, '') <> 'advisory'
      ORDER BY CASE WHEN is_resolved THEN 1 ELSE 0 END, priority ASC,
      CASE severity WHEN 'critical' THEN 1 WHEN 'serious' THEN 2 WHEN 'moderate' THEN 3 ELSE 4 END, created_at`, [scanId]),
    db.query("SELECT * FROM test_cases WHERE scan_id = $1 ORDER BY status, created_at", [scanId]),
    db.query("SELECT url, phase, a11y_tree, created_at FROM dom_snapshots WHERE scan_id = $1 ORDER BY created_at, id", [scanId]),
  ]);

  const scan = scanResult.rows[0];
  if (!scan) throw new Error("Scan not found");

  const issues = issuesResult.rows;
  const unresolvedIssues = issues.filter((issue: any) => !issue.is_resolved);
  const resolvedIssues = issues.filter((issue: any) => issue.is_resolved);
  const testCases = testCasesResult.rows;
  const snapshots = snapshotResult.rows;
  const urls = asArray(scan.urls).map(String);
  const persistedNavigationUrls = asArray(scan.navigated_urls).map(String).map(url => url.trim()).filter(Boolean);
  const navigatedUrls = [...new Set((persistedNavigationUrls.length ? persistedNavigationUrls : [...urls, ...snapshots.map((snapshot: any) => snapshot.url), ...issues.map((issue: any) => issue.url)]).map(String).map(url => url.trim()).filter(Boolean))];
  const score = Math.round(Number(scan.score || 0));
  const startedAt = scan.started_at ? new Date(scan.started_at) : null;
  const completedAt = scan.completed_at ? new Date(scan.completed_at) : null;

  // Ship 2 / Item 5 — cross-URL landmark grouping. Same logic as
  // /api/issues route, applied here so the PDF matches the dashboard.
  // Non-landmark issues (landmark_group_key NULL) pass through unchanged.
  const landmarkGroups = new Map<string, any[]>();
  const singletons: any[] = [];
  for (const issue of unresolvedIssues) {
    const key = issue.landmark_group_key;
    if (!key) { singletons.push(issue); continue; }
    if (!landmarkGroups.has(key)) landmarkGroups.set(key, []);
    landmarkGroups.get(key)!.push(issue);
  }
  const groupedIssues: any[] = [];
  for (const items of landmarkGroups.values()) {
    items.sort((a: any, b: any) => (a.priority || 5) - (b.priority || 5));
    const primary = items[0];
    const pageUrls = Array.from(new Set(items.map((it: any) => it.url).filter(Boolean)));
    groupedIssues.push({ ...primary, page_occurrences: pageUrls.length, page_urls: pageUrls });
  }
  const enrichedIssues = [
    ...singletons.map((it: any) => ({ ...it, page_occurrences: 1, page_urls: [it.url].filter(Boolean) })),
    ...groupedIssues,
  ];

  const sortedIssues = [...enrichedIssues].sort((a: any, b: any) =>
    (a.priority || 5) - (b.priority || 5) || severityRank(a.severity) - severityRank(b.severity)
  );

  const sevCounts: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const levelCounts: Record<string, number> = { A: 0, AA: 0, AAA: 0, Advisory: 0, "Needs review": 0 };
  for (const issue of unresolvedIssues) {
    sevCounts[issue.severity] = (sevCounts[issue.severity] || 0) + 1;
    const level = wcagLevel(issue);
    levelCounts[level] = (levelCounts[level] || 0) + 1;
  }

  const passCount = testCases.filter((tc: any) => tc.status === "pass").length;
  const failCount = testCases.filter((tc: any) => tc.status === "fail").length;
  const inProgressCount = testCases.filter((tc: any) => tc.status === "pending").length;
  const testTotal = testCases.length || 0;
  const pieGradient = (items: Array<{ count: number; color: string }>): string => {
    const total = items.reduce((sum, item) => sum + item.count, 0);
    if (!total) return "#e2e8f0 0 100%";
    let start = 0;
    return items.map((item) => {
      const end = start + (item.count / total) * 100;
      const segment = `${item.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
      start = end;
      return segment;
    }).join(", ");
  };
  const pieLegend = (items: Array<{ label: string; count: number; color: string }>, total: number): string => items
    .map((item) => `<div class="pie-legend-row"><span><i style="background:${item.color}"></i>${escapeHtml(item.label)}</span><b>${item.count}</b><em>${percent(item.count, total)}%</em></div>`)
    .join("");
  const testStatusItems = [
    { label: "Passed", count: passCount, color: "#16a34a" },
    { label: "Failed", count: failCount, color: "#e11d48" },
    { label: "In progress", count: inProgressCount, color: "#64748b" },
  ];
  const testStatusPie = `<div class="pie-layout"><div class="pie" style="background:conic-gradient(${pieGradient(testStatusItems)})"><span><strong>${testTotal}</strong><small>Test<br>cases</small></span></div><div class="pie-legend">${pieLegend(testStatusItems, testTotal)}</div></div>`;
  const severityChartRows = ["critical", "serious", "moderate", "minor"].map(sev => {
    const width = percent(sevCounts[sev] || 0, unresolvedIssues.length || 0);
    return `<div class="chart-row"><span>${sev}</span><div><i style="width:${width}%;background:${severityColor(sev)}"></i></div><b>${sevCounts[sev] || 0}</b></div>`;
  }).join("");
  const categoryCounts = unresolvedIssues.reduce((acc: Record<string, number>, issue: any) => {
    const category = String(issue.category || "wcag").toLowerCase();
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  // TypeScript widens Object.entries to [string, unknown][] regardless of
  // input type; cast so the `count` argument keeps its number typing.
  const categoryChartRows = (Object.entries(categoryCounts) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count], index) => {
      const colors = ["#0f766e", "#7c3aed", "#ff4d6d", "#ff9f43", "#ffd60a", "#0891b2"];
      return `<div class="chart-row"><span>${escapeHtml(label)}</span><div><i style="width:${percent(count, unresolvedIssues.length || 0)}%;background:${colors[index % colors.length]}"></i></div><b>${count}</b></div>`;
    }).join("");
  const principleForIssue = (issue: any): string => {
    // Ship 1 / Item 2 fix — the old regex .test on the joined tag string had
    // false positives: /1\./ matches "1." anywhere, so a 2.x criterion like
    // "2.4.11" (contains "1.1") was miscounted as Perceivable instead of
    // Operable. Fix: canonicalise each tag to a criterion and read the leading
    // digit. Falls back to the category / rule_id heuristic only when no WCAG
    // criterion is present at all.
    const rawTags = asArray(issue.wcag_criteria).concat(asArray(issue.tags)).map(String);
    const principles = new Set<string>();
    for (const raw of rawTags) {
      const criterion = wcagCriterionFromTag(raw);
      if (!criterion) continue;
      const first = criterion[0];
      if (first === "1") principles.add("Perceivable");
      else if (first === "2") principles.add("Operable");
      else if (first === "3") principles.add("Understandable");
      else if (first === "4") principles.add("Robust");
    }
    if (principles.has("Perceivable")) return "Perceivable";
    if (principles.has("Operable")) return "Operable";
    if (principles.has("Understandable")) return "Understandable";
    if (principles.has("Robust")) return "Robust";
    const catRule = `${issue.category || ""} ${issue.rule_id || ""}`.toLowerCase();
    if (/keyboard|focus|pointer|target|zoom|reflow/.test(catRule)) return "Operable";
    if (/label|error|input|form/.test(catRule)) return "Understandable";
    if (/aria|role|name/.test(catRule)) return "Robust";
    return "Needs review";
  };
  const principleCounts = unresolvedIssues.reduce((acc: Record<string, number>, issue: any) => {
    const principle = principleForIssue(issue);
    acc[principle] = (acc[principle] || 0) + 1;
    return acc;
  }, {});
  const principleItems = ["Perceivable", "Operable", "Understandable", "Robust", "Needs review"].map((label, index) => {
    const colors = ["#ff4d6d", "#ff9f43", "#a78bfa", "#0f766e", "#94a3b8"];
    return { label, count: principleCounts[label] || 0, color: colors[index] };
  });
  const principlePie = `<div class="pie-layout"><div class="pie" style="background:conic-gradient(${pieGradient(principleItems)})"><span><strong>${unresolvedIssues.length}</strong><small>Issues</small></span></div><div class="pie-legend">${pieLegend(principleItems, unresolvedIssues.length)}</div></div>`;
  const wcagLevelItems = ["A", "AA", "AAA", "Advisory", "Needs review"].map((label, index) => {
    const colors = ["#0f766e", "#a78bfa", "#ffd60a", "#0891b2", "#94a3b8"];
    return { label: label === "Advisory" ? "Advisory" : `Level ${label}`, count: levelCounts[label] || 0, color: colors[index] };
  });
  const wcagLevelPie = `<div class="pie-layout"><div class="pie" style="background:conic-gradient(${pieGradient(wcagLevelItems)})"><span><strong>${unresolvedIssues.length}</strong><small>WCAG<br>issues</small></span></div><div class="pie-legend">${pieLegend(wcagLevelItems, unresolvedIssues.length)}</div></div>`;

  const severityOptions = ["critical", "serious", "moderate", "minor"]
    .filter((severity) => sevCounts[severity] > 0)
    .map((severity) => `<label><input type="checkbox" data-filter="severity" value="${severity}"> ${severity[0].toUpperCase()}${severity.slice(1)} (${sevCounts[severity]})</label>`)
    .join("");

  const priorityOptions = [...new Set(sortedIssues.map((issue: any) => Number(issue.priority || 5)))]
    .sort((a, b) => a - b)
    .map((priority) => `<label><input type="checkbox" data-filter="priority" value="${priority}"> P${priority}</label>`)
    .join("");

  const levelOptions = ["A", "AA", "AAA", "Advisory", "Needs review"]
    .filter((level) => levelCounts[level] > 0)
    .map((level) => `<label><input type="checkbox" data-filter="level" value="${escapeAttr(level)}"> ${escapeHtml(level)} (${levelCounts[level]})</label>`)
    .join("");

  const issueRows = sortedIssues.map((issue: any, index: number) => {
    const selectors = asArray(issue.selectors || issue.selector).filter(Boolean).map(String);
    const affectedLabels = affectedElementLabels(issue);
    const issueId = String(issue.id || "").slice(0, 8).toUpperCase();
    const title = issueTitle(issue);
    const level = wcagLevel(issue);
    const pageUrl = String(issue.url || urls[0] || "");
    const selectorName = affectedLabels[0] || friendlyElementName(issue.selector || selectors[0] || "");
    const evidence = cleanEvidenceText(String(issue.evidence_explanation || ""));
    const hasEvidence = Boolean(evidence || issue.evidence_screenshot);
    const hasDetails = Boolean(hasEvidence || affectedLabels.length);
    const affectedList = affectedLabels.length
      ? `<div class="affected-components"><h4>Affected elements</h4><ol>${affectedLabels.map((label, labelIndex) => `<li><span>${labelIndex + 1}</span><b>${escapeHtml(label)}</b></li>`).join("")}</ol></div>`
      : "";
    const dataSearch = `${title} ${issue.rule_id || ""} ${issue.message || ""} ${pageUrl} ${affectedLabels.join(" ")}`.toLowerCase();
    return `
      <tbody class="issue-group" data-severity="${escapeAttr(issue.severity)}" data-priority="${escapeAttr(issue.priority || 5)}" data-level="${escapeAttr(level)}" data-search="${escapeAttr(dataSearch)}">
        <tr class="issue-row">
          <td class="narrow">${index + 1}</td>
          <td>
            ${hasDetails ? `<button class="expand" type="button" aria-expanded="false" aria-controls="details-${index}">+</button>` : ""}
            <div class="issue-main">
              <strong>${escapeHtml(title)}</strong>
              <span class="muted">${escapeHtml(selectorName)}${affectedCount(issue) > 1 ? ` - ${affectedCount(issue)} grouped elements` : ""}</span>
              ${issue.page_occurrences && issue.page_occurrences > 1
                ? `<span class="muted" style="color:#a78bfa;font-weight:600">Appears on ${issue.page_occurrences} pages: ${escapeHtml((issue.page_urls || []).slice(0, 3).map(compactUrl).join(", "))}${(issue.page_urls || []).length > 3 ? " …" : ""}</span>`
                : ""}
              <span class="print-only print-meta">${escapeHtml(compactUrl(pageUrl))} | ${escapeHtml(issueId)}</span>
            </div>
          </td>
          <td><span class="pill" style="--pill:${severityColor(issue.severity)}">${escapeHtml(issue.severity || "issue")}</span></td>
          <td>P${escapeHtml(issue.priority || 5)}</td>
          <td>${escapeHtml(wcagText(issue))}</td>
          <td>${affectedCount(issue)}</td>
          <td title="${escapeAttr(pageUrl)}">${escapeHtml(truncate(compactUrl(pageUrl), 42))}</td>
          <td class="issue-id">${escapeHtml(issueId)}</td>
        </tr>
        ${hasDetails ? `<tr id="details-${index}" class="details-row" hidden>
          <td></td>
          <td colspan="7">
            ${affectedList}
            ${hasEvidence ? `<div class="evidence-pack">
              <h4>Evidence and Screenshot Sample</h4>
              ${evidence ? `<p>${escapeHtml(evidence)}</p>` : ""}
              ${issue.evidence_screenshot ? `<img src="${issue.evidence_screenshot}" alt="Screenshot evidence for ${escapeAttr(title)}">` : ""}
            </div>` : ""}
          </td>
        </tr>` : ""}
      </tbody>`;
  }).join("");

  const caseRows = testCases.map((tc: any, index: number) => {
    const typeText = `${tc.category || ""} ${tc.status || ""}`.toLowerCase();
    const type = typeText.includes("hybrid") ? "hybrid" : typeText.includes("manual") ? "manual" : "automated";
    const status = tc.status === "pass" ? "pass" : tc.status === "fail" ? "fail" : "pending";
    const linkedIssue = issues.find((issue: any) => issue.id === tc.issue_id);
    const pageUrl = linkedIssue?.url || urls[0] || "";
    const name = testCaseDisplayName(tc, linkedIssue);
    const summary = testCaseSummary(tc, linkedIssue);
    const searchText = `${name} ${summary} ${status} ${type} ${tc.wcag_ref || ""} ${linkedIssue?.message || ""}`.toLowerCase();
    return `
      <tbody class="case-group" data-case-status="${escapeAttr(status)}" data-case-type="${escapeAttr(type)}" data-search="${escapeAttr(searchText)}">
        <tr class="case-row">
          <td class="narrow">${index + 1}</td>
          <td><div class="issue-main"><strong>${escapeHtml(name || "Accessibility test case")}</strong><span class="case-summary">${escapeHtml(summary)}</span></div></td>
          <td><span class="status ${status}">${status === "pass" ? "Pass" : status === "fail" ? "Fail" : "In progress"}</span></td>
          <td>${escapeHtml(type)}</td>
          <td title="${escapeAttr(pageUrl)}"><span class="url-chip">${escapeHtml(truncate(compactUrl(pageUrl), 34))}</span></td>
        </tr>
      </tbody>`;
  }).join("");

  const caseStatusOptions = ["pass", "fail", "pending"].filter(status => testCases.some((tc: any) => (tc.status === status || (status === "pending" && tc.status !== "pass" && tc.status !== "fail")))).map(status => `<label><input type="checkbox" data-case-filter="status" value="${status}"> ${status === "pass" ? "Pass" : status === "fail" ? "Fail" : "In progress"}</label>`).join("");
  const caseTypeOptions = ["automated", "manual", "hybrid"].filter(type => testCases.some((tc: any) => { const text = `${tc.category || ""} ${tc.status || ""}`.toLowerCase(); const actual = text.includes("hybrid") ? "hybrid" : text.includes("manual") ? "manual" : "automated"; return actual === type; })).map(type => `<label><input type="checkbox" data-case-filter="type" value="${type}"> ${type[0].toUpperCase()}${type.slice(1)}</label>`).join("");
  const configuredStates = ["default", "initial", "keyboard", "focus", "hover", "expanded", "error", "zoom", "pointer", "interaction"];
  const stateBreakdown = issues.reduce((acc: Record<string, any>, issue: any) => {
    const state = issue.state_label || issue.phase || "default";
    acc[state] ||= { total: 0, critical: 0, serious: 0, moderate: 0, minor: 0, screenshots: 0 };
    acc[state].total += 1;
    acc[state][issue.severity || "minor"] = (acc[state][issue.severity || "minor"] || 0) + 1;
    if (issue.evidence_screenshot) acc[state].screenshots += 1;
    return acc;
  }, {});
  configuredStates.forEach(state => { stateBreakdown[state] ||= { total: 0, critical: 0, serious: 0, moderate: 0, minor: 0, screenshots: 0 }; });
  const stateEntries = Object.entries(stateBreakdown).sort((a: any, b: any) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
  const stateColors = ["#7c3aed", "#e11d48", "#ff9f43", "#0f766e", "#0891b2", "#a78bfa", "#64748b", "#ffd60a", "#f97316", "#14b8a6"];
  const stateItems = stateEntries.map(([state, row]: [string, any], index) => ({ label: state, count: Number(row.total || 0), color: stateColors[index % stateColors.length] }));
  const statePie = `<div class="chart-card state-chart"><h3>UI State Composition</h3><div class="pie-layout"><div class="pie" style="background:conic-gradient(${pieGradient(stateItems)})"><span><strong>${issues.length}</strong><small>Total<br>issues</small></span></div><div class="pie-legend">${pieLegend(stateItems, issues.length)}</div></div></div>`;
  const maxStateIssues = Math.max(1, ...Object.values(stateBreakdown).map((row: any) => Number(row.total || 0)));
  const stateRows = stateEntries.map(([state, row]: [string, any], index) => {
    const color = row.total ? "#7c3aed" : "#94a3b8";
    return `<tr><td>${index + 1}</td><td>${escapeHtml(state)}</td><td><div class="mini-bar"><i style="width:${percent(row.total, maxStateIssues)}%;background:${color}"></i></div></td><td>${row.total}</td><td>${row.critical || 0}</td><td>${row.serious || 0}</td><td>${row.moderate || 0}</td><td>${row.minor || 0}</td><td>${row.screenshots || 0}</td></tr>`;
  }).join("");
  const formatDuration = (ms: number): string => {
    if (!Number.isFinite(ms) || ms < 0) return "-";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
  };
  const snapshotTimeline = persistedNavigationUrls.length ? persistedNavigationUrls.map((url: string, index: number) => ({
    url,
    phase: index === 0 ? "navigation: first URL" : "navigation: passed through",
    created_at: scan.started_at || scan.created_at || new Date().toISOString(),
    a11y_tree: { type: "navigation-event", offsetMs: 0 }
  })) : snapshots.length ? snapshots : urls.map((url: string) => ({
    url,
    phase: "configured target",
    created_at: scan.started_at || scan.created_at || new Date().toISOString()
  }));
  const navigationRows = snapshotTimeline.map((item: any, index: number) => {
    const meta = item.a11y_tree && typeof item.a11y_tree === "object" ? item.a11y_tree : {};
    const current = item.created_at ? new Date(item.created_at) : null;
    const nextItem = snapshotTimeline[index + 1];
    const next = nextItem?.created_at ? new Date(nextItem.created_at) : completedAt;
    const offsetMs = Number.isFinite(Number(meta.offsetMs))
      ? Number(meta.offsetMs)
      : startedAt && current ? current.getTime() - startedAt.getTime() : 0;
    const stepMs = Number.isFinite(Number(meta.durationMs))
      ? Number(meta.durationMs)
      : current && next ? next.getTime() - current.getTime() : 0;
    const phase = item.phase || "page scan";
    return `<tr><td>${index + 1}</td><td title="${escapeAttr(item.url || "")}"><span class="url-chip">${escapeHtml(truncate(compactUrl(item.url || ""), 78))}</span></td><td>${escapeHtml(phase)}</td><td>${formatDuration(offsetMs)}</td><td>${formatDuration(stepMs)}</td></tr>`;
  }).join("");
  const navigationSummary = `${snapshotTimeline.length} captured navigation/state step${snapshotTimeline.length === 1 ? "" : "s"} across ${navigatedUrls.length} unique URL${navigatedUrls.length === 1 ? "" : "s"}`;
  const urlList = navigatedUrls.map((url, index) => `<li title="${escapeAttr(url)}"><span class="url-index">${index + 1}</span> ${escapeHtml(url)}</li>`).join("");
  const interactionReports = snapshots
    .map((snapshot: any) => ({ snapshot, tree: snapshot.a11y_tree && typeof snapshot.a11y_tree === "object" ? snapshot.a11y_tree : {} }))
    .filter((entry: any) => entry.tree?.type === "controlled-interaction-report");
  const interactionRows = interactionReports.flatMap((entry: any) => {
    const mode = entry.tree.mode || "safe-auto";
    return asArray(entry.tree.items).map((item: any) => `
      <tr>
        <td>${escapeHtml(item.status || "")}</td>
        <td>${escapeHtml(item.kind || "")}</td>
        <td>${escapeHtml(truncate(item.label || item.selector || "", 90))}</td>
        <td title="${escapeAttr(item.href || "")}">${escapeHtml(truncate(item.href || item.scannedUrl || entry.snapshot.url || "", 70))}</td>
        <td>${escapeHtml(mode)}</td>
        <td>${escapeHtml(item.outcome || item.reason || "")}</td>
      </tr>`);
  }).join("");
  const interactionSummary = interactionReports.reduce((acc: Record<string, number>, entry: any) => {
    const summary = entry.tree.summary || {};
    for (const [key, value] of Object.entries(summary)) acc[key] = (acc[key] || 0) + Number(value || 0);
    return acc;
  }, {});
  const interactionSummaryText = Object.keys(interactionSummary).length
    ? Object.entries(interactionSummary).map(([key, value]) => `${value} ${key}`).join(", ")
    : "No controlled interaction scan data captured.";
  const contentOptions = [
    ["executive", "Executive"],
    ["navigation", "Navigation timeline"],
    ["interactions", "Controlled interactions"],
    ["testcases", "Test cases"],
    ["states", "UI states"],
    ["issues", "Issues"],
  ].map(([value, label]) => `<label><input type="checkbox" data-section-filter value="${value}" ${selectedSections.has(value as ReportSection) ? "checked" : ""}> ${label}</label>`).join("");
  const initialFocusSection = selectedSections.size === 1 ? Array.from(selectedSections)[0] : "";

  const css = `
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f7fb; color: #172033; font-family: Arial, "Segoe UI", sans-serif; font-size: 13px; line-height: 1.45; }
    a { color: #0f766e; }
    .page { max-width: 1180px; margin: 0 auto; padding: 22px; }
    .report { background: #fff; border: 1px solid #d7deea; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 24px rgba(15,23,42,.08); }
    header { padding: 22px 26px; background: linear-gradient(135deg,#f4f1ff,#ecfeff); border-bottom: 1px solid #d7deea; }
    .topline { display:flex; align-items:flex-start; justify-content:space-between; gap: 18px; }
    .brand { color:#0f766e; font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin: 6px 0 5px; font-size: 28px; line-height: 1.15; color:#111827; }
    .subtitle { color:#5b6476; margin:0; max-width:760px; }
    .meta { color:#667085; font-size:12px; text-align:right; min-width:210px; }
    .score-hero { display:flex; align-items:center; gap:18px; margin-top:18px; padding:16px 18px; border:1px solid #d9deea; border-radius:16px; background:rgba(255,255,255,.78); }
    .score-ring { width:108px; height:108px; border-radius:50%; display:grid; place-items:center; background:conic-gradient(#e40046 calc(var(--score) * 1%), #ddd6fe 0); box-shadow:inset 0 0 0 1px #d7deea; }
    .score-ring div { width:76px; height:76px; border-radius:50%; display:grid; place-items:center; align-content:center; background:#fff; color:#111827; }
    .score-ring strong { font-size:30px; line-height:1; }
    .score-ring span { color:#667085; font-size:12px; }
    .score-copy h2 { margin:0 0 4px; font-size:18px; }
    .score-copy p { margin:0; color:#5b6476; }
    .section { padding: 18px 26px; border-bottom:1px solid #e7eaf2; }
    .section:last-child { border-bottom:0; }
    h2 { margin:0 0 12px; font-size:18px; color:#172033; }

    .counts { display:grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap:10px; }
    .count-card { border:1px solid #d9deea; border-radius:10px; padding:11px; background:#fbfcff; }
    .count-card strong { display:block; font-size:20px; }
    .count-card span { color:#667085; font-size:12px; text-transform:capitalize; }
    .url-box { border:1px solid #d9deea; border-radius:10px; background:#fbfcff; padding:11px; }
    .url-box ul { margin:0; padding-left:18px; max-height:92px; overflow:auto; }
    .url-box li { margin-bottom:4px; color:#475569; word-break:break-all; }
    .url-index { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; margin-right:6px; border-radius:999px; background:#eef2f7; color:#475569; font-size:11px; font-weight:700; }
    .toolbar { display:grid; grid-template-columns: minmax(220px,1fr) auto; gap:10px; align-items:center; background:#fff; padding: 0 0 12px; z-index:2; position:relative; }
    .contents-toolbar { grid-template-columns: 1fr; }
    .section-picker { display:grid; grid-template-columns:1fr auto; gap:10px 14px; align-items:center; border:1px solid #d9deea; border-radius:12px; padding:12px; background:#fbfcff; }
    .picker-title { color:#172033; font-weight:800; }
    .picker-options { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .picker-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
    .section-picker label { display:inline-flex; align-items:center; gap:7px; border:1px solid #cbd5e1; border-radius:999px; padding:7px 10px; background:#fff; color:#334155; cursor:pointer; }
    .section-picker label:has(input:checked) { border-color:#0f766e; background:#ecfdf5; color:#0f766e; }
    .section-picker input { width:auto; }
    .download-btn { border:0; color:#fff; background:linear-gradient(90deg,#e40046,#6d28d9); border-radius:9px; padding:9px 12px; cursor:pointer; white-space:nowrap; font-weight:800; }
    .download-btn:disabled { cursor:not-allowed; filter:grayscale(.6); opacity:.45; }
    .dashboard-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .chart-card { border:1px solid #d9deea; border-radius:12px; background:#fbfcff; padding:12px; }
    .chart-card h3 { margin:0 0 10px; font-size:13px; color:#172033; }
    .chart-row { display:grid; grid-template-columns:82px 1fr 38px; gap:8px; align-items:center; margin:8px 0; color:#475569; font-size:12px; text-transform:capitalize; }
    .chart-row div { height:9px; border-radius:999px; background:#e2e8f0; overflow:hidden; }
    .chart-row i { display:block; height:100%; border-radius:999px; }
    .chart-row b { text-align:right; color:#172033; }
    .pie-layout { display:grid; grid-template-columns:132px 1fr; gap:14px; align-items:center; min-height:140px; }
    .pie { width:126px; height:126px; border-radius:50%; display:grid; place-items:center; box-shadow:inset 0 0 0 1px #d7deea; }
    .pie span { width:74px; height:74px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#fff; box-shadow:0 2px 8px rgba(15,23,42,.08); text-align:center; overflow:hidden; }
    .pie strong { font-size:24px; color:#172033; line-height:1; margin-bottom:3px; }
    .pie small { color:#667085; font-size:10px; line-height:1.05; text-transform:uppercase; letter-spacing:.03em; }
    .pie-legend { display:grid; gap:8px; }
    .pie-legend-row { display:grid; grid-template-columns:minmax(0,1fr) 34px 42px; gap:8px; align-items:center; color:#475569; font-size:12px; }
    .pie-legend-row span { display:flex; gap:7px; align-items:center; min-width:0; }
    .pie-legend-row i { width:10px; height:10px; border-radius:999px; flex:0 0 auto; }
    .pie-legend-row b { text-align:right; color:#172033; }
    .pie-legend-row em { text-align:right; color:#667085; font-style:normal; }
    .pie-layout { display:grid; grid-template-columns:132px 1fr; gap:14px; align-items:center; min-height:140px; }
    .pie { width:126px; height:126px; border-radius:50%; display:grid; place-items:center; box-shadow:inset 0 0 0 1px #d7deea; }
    .pie span { width:74px; height:74px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#fff; box-shadow:0 2px 8px rgba(15,23,42,.08); text-align:center; overflow:hidden; }
    .pie strong { font-size:24px; color:#172033; line-height:1; margin-bottom:3px; }
    .pie small { color:#667085; font-size:10px; line-height:1.05; text-transform:uppercase; letter-spacing:.03em; }
    .pie-legend { display:grid; gap:8px; }
    .pie-legend-row { display:grid; grid-template-columns:minmax(0,1fr) 34px 42px; gap:8px; align-items:center; color:#475569; font-size:12px; }
    .pie-legend-row span { display:flex; gap:7px; align-items:center; min-width:0; }
    .pie-legend-row i { width:10px; height:10px; border-radius:999px; flex:0 0 auto; }
    .pie-legend-row b { text-align:right; color:#172033; }
    .pie-legend-row em { text-align:right; color:#667085; font-style:normal; }
    .wcag-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
    .wcag-card { border:1px solid color-mix(in srgb, var(--wcag), white 72%); background:color-mix(in srgb, var(--wcag), white 92%); border-radius:10px; padding:12px; }
    .wcag-card span { display:block; color:var(--wcag); font-size:12px; font-weight:800; }
    .wcag-card strong { display:block; color:#172033; font-size:24px; margin:6px 0 2px; }
    .wcag-card small { color:#667085; }
    .mini-bar { width:100%; height:8px; border-radius:999px; background:#e2e8f0; overflow:hidden; }
    .mini-bar i { display:block; height:100%; border-radius:999px; }
    input, select, button { font: inherit; }
    input[type="search"] { width:100%; border:1px solid #cbd5e1; border-radius:9px; padding:9px 10px; background:#fff; color:#172033; }
    .small-btn { border:1px solid #0f766e; color:#0f766e; background:#ecfdf5; border-radius:9px; padding:9px 11px; cursor:pointer; white-space:nowrap; }
    .filter-wrap { position:relative; }
    .filter-panel { position:fixed; right:max(18px, calc((100vw - 1180px) / 2 + 18px)); top:142px; width:340px; max-width:calc(100vw - 36px); max-height:calc(100vh - 170px); overflow:auto; background:#fff; border:1px solid #cbd5e1; border-radius:12px; box-shadow:0 16px 34px rgba(15,23,42,.16); padding:14px; z-index:20; }
    .filter-panel[hidden] { display:none; }
    .filter-head { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; }
    .filter-group { border-top:1px solid #eef2f7; padding-top:10px; margin-top:10px; }
    .filter-group strong { display:block; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:7px; }
    .filter-group label { display:flex; align-items:center; gap:8px; color:#334155; font-size:12px; padding:4px 0; }
    .filter-group input { width:auto; }
    #filter-count:not([hidden]), #content-count:not([hidden]) { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; margin-left:4px; border-radius:999px; background:#0f766e; color:#fff; font-size:11px; }
    .table-wrap { border:1px solid #d9deea; border-radius:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:860px; table-layout:fixed; }
    .case-table col:nth-child(1), .issue-table col:nth-child(1) { width:48px; }
    .case-table col:nth-child(2) { width:auto; }
    .case-table col:nth-child(3) { width:112px; }
    .case-table col:nth-child(4) { width:92px; }
    .case-table col:nth-child(5) { width:190px; }
    .issue-table col:nth-child(2) { width:auto; }
    .issue-table col:nth-child(3) { width:104px; }
    .issue-table col:nth-child(4) { width:78px; }
    .issue-table col:nth-child(5) { width:130px; }
    .issue-table col:nth-child(6) { width:86px; }
    .issue-table col:nth-child(7) { width:180px; }
    .issue-table col:nth-child(8) { width:86px; }
    th { background:#f8fafc; color:#64748b; font-size:11px; letter-spacing:.05em; text-transform:uppercase; text-align:left; padding:10px; border-bottom:1px solid #e2e8f0; position:static; }
    .case-table thead th { background:linear-gradient(90deg,#e40046,#6d28d9); color:#fff; border-bottom:0; }
    td { padding:10px; border-bottom:1px solid #eef2f7; vertical-align:top; }
    tbody:last-child td { border-bottom:0; }
    .narrow { width:46px; color:#667085; text-align:center; }
    .issue-row:hover td, .case-row:hover td { background:#fbfcff; }
    .expand { width:26px; height:26px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#0f766e; font-weight:800; cursor:pointer; float:left; margin-right:8px; }
    .issue-main { display:grid; gap:4px; min-width:0; }
    .issue-main strong { color:#172033; font-size:13px; line-height:1.35; overflow-wrap:anywhere; }
    .case-summary { color:#667085; font-size:12px; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .muted { color:#667085; font-size:12px; }
    .url-chip { display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:1px solid #d9deea; border-radius:999px; background:#f8fafc; color:#475569; padding:3px 8px; font-size:11px; }
    .pill { display:inline-flex; border-radius:999px; border:1px solid color-mix(in srgb, var(--pill), white 62%); background:color-mix(in srgb, var(--pill), white 92%); color:var(--pill); padding:3px 8px; font-size:11px; font-weight:800; text-transform:capitalize; }
    .issue-id { color:#475569; font-family:Consolas,monospace; font-size:12px; }
    .status { display:inline-flex; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:800; }
    .status.pass { color:#047857; background:#ecfdf5; } .status.fail { color:#be123c; background:#fff1f2; } .status.pending { color:#475569; background:#f1f5f9; }
    .note { border:1px solid #d9deea; border-radius:10px; background:#fbfcff; padding:12px; color:#475569; }
    .details-row td { background:#fbfcff; }
    .details-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .details-grid section, .evidence, .selectors, .screenshot, .evidence-pack, .affected-components { border:1px solid #d9deea; border-radius:10px; padding:11px; background:#fff; margin-bottom:10px; }
    .affected-components ol { list-style:none; display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:8px 12px; margin:8px 0 0; padding:0; }
    .affected-components li { display:grid; grid-template-columns:28px 1fr; align-items:start; gap:8px; color:#334155; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:7px 9px; margin:0; overflow-wrap:anywhere; }
    .affected-components li span { display:inline-flex; align-items:center; justify-content:center; min-width:24px; height:24px; border-radius:999px; background:#eef2ff; color:#4f46e5; font-size:11px; font-weight:800; line-height:1; }
    .affected-components li b { display:block; min-width:0; color:#334155; font-weight:600; line-height:1.35; }
    h4 { margin:0 0 6px; color:#172033; font-size:13px; }
    p { margin:0 0 6px; color:#475569; }
    details summary { cursor:pointer; color:#0f766e; font-weight:700; }
    code { background:#eef2f7; border-radius:5px; padding:2px 5px; color:#334155; word-break:break-all; }
    ol { margin:8px 0 0 18px; padding:0; }
    li { margin-bottom:4px; }
    .screenshot img, .evidence-pack img { display:block; max-width:100%; max-height:320px; object-fit:contain; border:1px solid #d9deea; border-radius:8px; margin-top:10px; }
    .selector-samples { border-top:1px solid #eef2f7; margin-top:10px; padding-top:10px; }
    .coverage-summary { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
    .coverage-summary span { border:1px solid #d9deea; border-radius:999px; padding:4px 8px; background:#fbfcff; color:#475569; font-size:11px; font-weight:700; }
    .procedure-steps { display:grid; gap:8px; }
    .procedure-step { border:1px solid #d9deea; border-radius:10px; background:#fff; padding:10px; break-inside:avoid; }
    .procedure-head { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:6px; }
    .procedure-head b { color:#172033; }
    .procedure-head span { border-radius:999px; padding:3px 8px; color:var(--coverage); background:color-mix(in srgb, var(--coverage), white 90%); border:1px solid color-mix(in srgb, var(--coverage), white 68%); font-size:11px; font-weight:800; text-transform:capitalize; }
    .procedure-head em { border-radius:999px; padding:3px 8px; color:#475569; background:#f1f5f9; font-size:11px; font-style:normal; text-transform:capitalize; }
    .procedure-step small { color:#667085; line-height:1.45; }
    .empty { padding:18px; color:#667085; text-align:center; }
    .print-note { color:#667085; font-size:12px; margin-top:10px; }
    .print-only { display:none; }
    .footer { display:flex; justify-content:space-between; gap:12px; padding:16px 26px 22px; color:#667085; font-size:11px; }
    @media print {
      body { background:#fff; }
      .page { padding:0; max-width:none; }
      .report { border:0; border-radius:0; box-shadow:none; }
      .toolbar, .expand, .small-btn, .filter-panel { display:none !important; }
      .print-only { display:block; }
      .print-meta { color:#667085; font-size:10.5px; margin-top:3px; }
      .details-row[hidden] { display:table-row !important; }
      .details-row { break-inside:avoid; }
      th { position:static; }
      table { min-width:0; }
      .table-wrap { overflow:visible; border:0; }
      header, .section, .footer { padding-left:0; padding-right:0; }
      .section[hidden] { display:none !important; }
      .issue-table,
      .issue-table .issue-group,
      .issue-table .issue-row,
      .issue-table .details-row,
      .issue-table .details-row > td[colspan] { display:block; width:100%; }
      .issue-table colgroup,
      .issue-table thead,
      .issue-table .details-row > td:first-child,
      .issue-table .issue-row > td:nth-child(6),
      .issue-table .issue-row > td:nth-child(7),
      .issue-table .issue-row > td:nth-child(8) { display:none; }
      .issue-table .issue-group {
        border:1px solid #d9deea;
        border-radius:10px;
        margin:0 0 10px;
        overflow:hidden;
        break-inside:avoid;
        page-break-inside:avoid;
        background:#fff;
      }
      .issue-table .issue-row {
        display:grid;
        grid-template-columns:42px minmax(0,1fr) 92px 58px 120px;
        align-items:start;
        gap:0;
        background:#fbfcff;
        border-bottom:1px solid #e7eaf2;
      }
      .issue-table .issue-row > td {
        border:0;
        padding:9px 10px;
      }
      .issue-table .issue-main strong {
        display:block;
        font-size:13px;
        line-height:1.35;
        overflow-wrap:normal;
        word-break:normal;
        hyphens:none;
      }
      .issue-table .details-row > td[colspan] {
        border:0;
        padding:10px;
        background:#fff;
      }
      .issue-table .details-grid {
        grid-template-columns:1fr 1fr;
        gap:8px;
      }
      .issue-table .details-grid section,
      .issue-table .evidence-pack {
        break-inside:avoid;
        margin-bottom:8px;
      }
      .issue-table .evidence-pack img {
        max-height:210px;
      }
      .issue-table .selector-samples ol {
        max-height:120px;
        overflow:hidden;
      }
      .case-table { font-size:11px; }
      .case-table col:nth-child(1) { width:34px; }
      .case-table col:nth-child(3) { width:88px; }
      .case-table col:nth-child(4) { width:72px; }
      .case-table col:nth-child(5) { width:132px; }
    }
    @media (max-width: 860px) {
      .topline, .details-grid { grid-template-columns:1fr; display:grid; }
      .meta { text-align:left; }
      .score-hero, .counts, .toolbar, .section-picker { grid-template-columns:1fr; }
      .score-hero { align-items:flex-start; }
      .pie-layout { grid-template-columns:1fr; }
      .picker-actions { justify-content:flex-start; }
      .page { padding:12px; }
      header, .section { padding:18px; }
    }
  `;

  const script = `
    const groups = Array.from(document.querySelectorAll('.issue-group'));
    const caseGroups = Array.from(document.querySelectorAll('.case-group'));
    const search = document.getElementById('search');
    const caseSearch = document.getElementById('case-search');
    const shown = document.getElementById('shown-count');
    const caseShown = document.getElementById('case-shown-count');
    const filterButton = document.getElementById('filter-button');
    const filterPanel = document.getElementById('filter-panel');
    const filterCount = document.getElementById('filter-count');
    const caseFilterButton = document.getElementById('case-filter-button');
    const caseFilterPanel = document.getElementById('case-filter-panel');
    const contentButton = document.getElementById('content-button');
    const contentPanel = document.getElementById('content-panel');
    const contentCount = document.getElementById('content-count');
    const checks = Array.from(document.querySelectorAll('[data-filter]'));
    const caseChecks = Array.from(document.querySelectorAll('[data-case-filter]'));
    const sectionChecks = Array.from(document.querySelectorAll('[data-section-filter]'));
    const sections = Array.from(document.querySelectorAll('[data-report-section]'));
    const downloadPdfButton = document.getElementById('download-pdf');
    const confirmReportSelection = document.getElementById('confirm-report-selection');
    const initialFocusSection = ${JSON.stringify(initialFocusSection)};
    const scanId = ${JSON.stringify(scanId)};
    let reportSelectionConfirmed = false;

    function selectedValues(name) { return checks.filter(input => input.dataset.filter === name && input.checked).map(input => input.value); }
    function selectedCaseValues(name) { return caseChecks.filter(input => input.dataset.caseFilter === name && input.checked).map(input => input.value); }
    function includesSelected(selected, value) { return selected.length === 0 || selected.includes(value); }
    function closeFilterPanels(except) {
      [filterPanel, caseFilterPanel, contentPanel].filter(Boolean).forEach(panel => {
        if (panel !== except) panel.hidden = true;
      });
      if (filterPanel !== except) filterButton?.setAttribute('aria-expanded', 'false');
      if (caseFilterPanel !== except) caseFilterButton?.setAttribute('aria-expanded', 'false');
      if (contentPanel !== except) contentButton?.setAttribute('aria-expanded', 'false');
    }
    function togglePanel(button, panel) {
      if (!button || !panel) return;
      const open = panel.hidden;
      closeFilterPanels(open ? panel : null);
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    }
    function openRelevantFilters(sectionName) {
      if (sectionName === 'testcases' && caseFilterPanel) {
        closeFilterPanels(caseFilterPanel);
        caseFilterPanel.hidden = false;
        caseFilterButton?.setAttribute('aria-expanded', 'true');
      } else if (sectionName === 'issues' && filterPanel) {
        closeFilterPanels(filterPanel);
        filterPanel.hidden = false;
        filterButton?.setAttribute('aria-expanded', 'true');
      } else {
        closeFilterPanels(null);
      }
    }

    function applySectionFilters(focusSection) {
      const selected = sectionChecks.filter(input => input.checked).map(input => input.value);
      sections.forEach(section => { section.hidden = selected.length > 0 && !selected.includes(section.dataset.reportSection); });
      if (contentCount) {
        contentCount.textContent = selected.length ? String(selected.length) : '';
        contentCount.hidden = selected.length === 0;
      }
      if (downloadPdfButton) {
        downloadPdfButton.disabled = !reportSelectionConfirmed;
        downloadPdfButton.title = reportSelectionConfirmed ? 'Download PDF with current sections' : 'Confirm or change report selection first';
      }
      if (focusSection) {
        const target = sections.find(section => section.dataset.reportSection === focusSection && !section.hidden);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        openRelevantFilters(focusSection);
      }
    }

    function applyFilters() {
      const q = (search?.value || '').trim().toLowerCase();
      const selectedSeverity = selectedValues('severity');
      const selectedPriority = selectedValues('priority');
      const selectedLevel = selectedValues('level');
      const activeCount = selectedSeverity.length + selectedPriority.length + selectedLevel.length;
      if (filterCount) {
        filterCount.textContent = activeCount ? String(activeCount) : '';
        filterCount.hidden = activeCount === 0;
      }
      let visible = 0;
      groups.forEach(group => {
        const ok = (!q || group.dataset.search.includes(q)) && includesSelected(selectedSeverity, group.dataset.severity) && includesSelected(selectedPriority, group.dataset.priority) && includesSelected(selectedLevel, group.dataset.level);
        group.hidden = !ok;
        if (ok) visible += 1;
      });
      if (shown) shown.textContent = String(visible);
    }

    function applyCaseFilters() {
      const q = (caseSearch?.value || '').trim().toLowerCase();
      const selectedStatus = selectedCaseValues('status');
      const selectedType = selectedCaseValues('type');
      let visible = 0;
      caseGroups.forEach(group => {
        const ok = (!q || group.dataset.search.includes(q)) && includesSelected(selectedStatus, group.dataset.caseStatus) && includesSelected(selectedType, group.dataset.caseType);
        group.hidden = !ok;
        if (ok) visible += 1;
      });
      if (caseShown) caseShown.textContent = String(visible);
    }

    if (search) search.addEventListener('input', applyFilters);
    if (caseSearch) caseSearch.addEventListener('input', applyCaseFilters);
    checks.forEach(input => input.addEventListener('change', applyFilters));
    caseChecks.forEach(input => input.addEventListener('change', applyCaseFilters));
    function confirmSelection() { reportSelectionConfirmed = true; applySectionFilters(); }
    sectionChecks.forEach(input => input.addEventListener('change', () => { confirmSelection(); applySectionFilters(input.checked ? input.value : null); }));
    if (filterButton) filterButton.addEventListener('click', () => togglePanel(filterButton, filterPanel));
    if (caseFilterButton) caseFilterButton.addEventListener('click', () => togglePanel(caseFilterButton, caseFilterPanel));
    if (contentButton) contentButton.addEventListener('click', () => togglePanel(contentButton, contentPanel));
    document.getElementById('select-all-sections')?.addEventListener('click', () => { sectionChecks.forEach(input => input.checked = true); confirmSelection(); applySectionFilters('testcases'); });
    document.getElementById('executive-only')?.addEventListener('click', () => { sectionChecks.forEach(input => input.checked = input.value === 'executive'); confirmSelection(); applySectionFilters('executive'); });
    confirmReportSelection?.addEventListener('click', confirmSelection);
    downloadPdfButton?.addEventListener('click', () => {
      if (!reportSelectionConfirmed) return;
      const selected = sectionChecks.filter(input => input.checked).map(input => input.value);
      window.opener?.postMessage({ type: 'download-report-pdf', scanId, sections: selected }, '*');
    });
    document.addEventListener('click', event => { if (!event.target.closest('.filter-wrap') && !event.target.closest('.section-picker')) closeFilterPanels(null); });
    document.getElementById('clear-filters')?.addEventListener('click', () => { checks.forEach(input => { input.checked = false; }); applyFilters(); });
    document.getElementById('clear-case-filters')?.addEventListener('click', () => { caseChecks.forEach(input => { input.checked = false; }); applyCaseFilters(); });
    document.querySelectorAll('.expand').forEach(button => button.addEventListener('click', () => { const row = document.getElementById(button.getAttribute('aria-controls')); if (!row) return; const expanded = button.getAttribute('aria-expanded') === 'true'; button.setAttribute('aria-expanded', String(!expanded)); button.textContent = expanded ? '+' : '-'; row.hidden = expanded; }));
    document.getElementById('expand-all')?.addEventListener('click', () => { const expand = document.getElementById('expand-all').dataset.expanded !== 'true'; document.querySelectorAll('.expand').forEach(button => { const row = document.getElementById(button.getAttribute('aria-controls')); button.setAttribute('aria-expanded', String(expand)); button.textContent = expand ? '-' : '+'; if (row) row.hidden = !expand; }); document.getElementById('expand-all').dataset.expanded = String(expand); document.getElementById('expand-all').textContent = expand ? 'Collapse all' : 'Expand all'; });
    applySectionFilters(); applyFilters(); applyCaseFilters();
    if (initialFocusSection) window.setTimeout(() => applySectionFilters(initialFocusSection), 120);
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Interactive Accessibility Report - ${escapeHtml(scan.name || "Scan")}</title>
  <style>${css}</style>
</head>
<body>
  <main class="page">
    <div class="report">
      <header>
        <div class="topline">
          <div>
            <div class="brand">Interactive Accessibility Report</div>
            <h1>${escapeHtml(scan.name || "Accessibility Audit")}</h1>
            <p class="subtitle">Choose the report contents you need. Test cases are listed first because they describe what a tester must verify; issues remain available as developer evidence.</p>
          </div>
          <div class="meta">
            <div>Generated ${escapeHtml(format(new Date(), "MMM d, yyyy HH:mm"))}</div>
            ${completedAt ? `<div>Completed ${escapeHtml(format(completedAt, "MMM d, yyyy HH:mm"))}</div>` : ""}
            <div>Scan ID ${escapeHtml(scanId)}</div>
          </div>
        </div>
        <div class="score-hero">
          <div class="score-ring" style="--score:${score}"><div><strong>${score}</strong><span>/100</span></div></div>
          <div class="score-copy"><h2>Accessibility Score</h2><p>Overall result for this scan.</p></div>
        </div>
      </header>

      <section class="section">
        <div class="toolbar contents-toolbar">
          <div class="section-picker" aria-label="Report contents">
            <div>
              <div class="picker-title">Report contents</div>
              <div class="picker-options">${contentOptions}</div>
            </div>
            <div class="picker-actions">
              <button id="select-all-sections" class="small-btn" type="button">All</button>
              <button id="executive-only" class="small-btn" type="button">Executive</button>
              <button id="confirm-report-selection" class="small-btn" type="button">Confirm selection</button>
              <button id="download-pdf" class="download-btn" type="button" disabled>Download PDF</button>
            </div>
          </div>
        </div>
      </section>
      ${hasReportSection(selectedSections, "executive") ? `<section class="section" data-report-section="executive"><h2>Executive Report</h2><div class="dashboard-grid"><div class="chart-card"><h3>Test Case Status</h3>${testStatusPie}</div><div class="chart-card"><h3>WCAG Levels</h3>${wcagLevelPie}</div><div class="chart-card"><h3>WCAG Principles</h3>${principlePie}</div><div class="chart-card"><h3>Issue Severity</h3>${severityChartRows}</div><div class="chart-card"><h3>Issue Categories</h3>${categoryChartRows || "<p class='empty'>No category issues.</p>"}</div></div></section>` : ""}

      ${hasReportSection(selectedSections, "navigation") ? `<section class="section" data-report-section="navigation"><h2>Navigation timeline</h2><p class="muted">${escapeHtml(navigationSummary)}</p><div class="url-box"><strong>URLs passed through</strong><ul>${urlList || "<li>No navigated URLs were recorded.</li>"}</ul></div><div class="table-wrap"><table><thead><tr><th>#</th><th>URL</th><th>Phase</th><th>Offset</th><th>Step time</th></tr></thead><tbody>${navigationRows || `<tr><td colspan="5" class="empty">No navigation events available.</td></tr>`}</tbody></table></div></section>` : ""}
      ${hasReportSection(selectedSections, "interactions") ? `<section class="section" data-report-section="interactions"><h2>Controlled Interaction Scan</h2><p class="muted">${escapeHtml(interactionSummaryText)}</p><div class="table-wrap"><table><thead><tr><th>Status</th><th>Kind</th><th>Interaction</th><th>URL / State</th><th>Mode</th><th>Outcome</th></tr></thead><tbody>${interactionRows || `<tr><td colspan="6" class="empty">No controlled interaction scan data captured.</td></tr>`}</tbody></table></div></section>` : ""}


      ${hasReportSection(selectedSections, "testcases") ? `<section class="section" data-report-section="testcases"><h2>Test Cases <span class="muted">(<span id="case-shown-count">${testCases.length}</span> shown of ${testCases.length})</span></h2><div class="toolbar" aria-label="Test case filters"><input id="case-search" type="search" placeholder="Search test cases..." /><div class="filter-wrap"><button id="case-filter-button" class="small-btn" type="button" aria-expanded="false" aria-controls="case-filter-panel">Filters</button><div id="case-filter-panel" class="filter-panel" hidden><div class="filter-head"><strong>Filter test cases</strong><button id="clear-case-filters" class="small-btn" type="button">Clear</button></div><div class="filter-group"><strong>Status</strong>${caseStatusOptions || "<span class='muted'>No status filters</span>"}</div><div class="filter-group"><strong>Type</strong>${caseTypeOptions || "<span class='muted'>No type filters</span>"}</div></div></div></div><div class="table-wrap"><table class="case-table"><colgroup><col><col><col><col><col></colgroup><thead><tr><th>#</th><th>Test case</th><th>Status</th><th>Type</th><th>Page</th></tr></thead>${caseRows || `<tbody><tr><td colspan="5" class="empty">No test cases available.</td></tr></tbody>`}</table></div></section>` : ""}
      ${hasReportSection(selectedSections, "states") ? `<section class="section" data-report-section="states"><h2>UI State Composition</h2>${statePie}<div class="table-wrap"><table><thead><tr><th>#</th><th>State</th><th>Composition</th><th>Total</th><th>Critical</th><th>Serious</th><th>Moderate</th><th>Minor</th><th>Screenshots</th></tr></thead><tbody>${stateRows || `<tr><td colspan="9" class="empty">No UI state data captured.</td></tr>`}</tbody></table></div></section>` : ""}

      ${hasReportSection(selectedSections, "issues") ? `<section class="section" data-report-section="issues">
        <h2>Issues / Developer Evidence <span class="muted">(<span id="shown-count">${sortedIssues.length}</span> shown of ${sortedIssues.length})</span></h2>
        <div class="toolbar" aria-label="Issue filters">
          <input id="search" type="search" placeholder="Search issue, rule, URL, selector..." />
          <div class="filter-wrap">
            <button id="filter-button" class="small-btn" type="button" aria-expanded="false" aria-controls="filter-panel">Filters <span id="filter-count" hidden></span></button>
            <div id="filter-panel" class="filter-panel" hidden>
              <div class="filter-head"><strong>Filter issues</strong><button id="clear-filters" class="small-btn" type="button">Clear</button></div>
              <div class="filter-group"><strong>Severity</strong>${severityOptions || "<span class='muted'>No severity filters</span>"}</div>
              <div class="filter-group"><strong>Priority</strong>${priorityOptions || "<span class='muted'>No priority filters</span>"}</div>
              <div class="filter-group"><strong>WCAG level</strong>${levelOptions || "<span class='muted'>No WCAG filters</span>"}</div>
            </div>
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:10px;">
          <button id="expand-all" class="small-btn" type="button">Expand all</button>
          <div class="print-note">Tip: expand rows before printing if you want details visible in the PDF.</div>
        </div>
        <div class="table-wrap">
          <table class="issue-table">
            <colgroup><col><col><col><col><col><col><col><col></colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Issue</th>
                <th>Severity</th>
                <th>Priority</th>
                <th>WCAG</th>
                <th>Affected</th>
                <th>Page</th>
                <th>ID</th>
              </tr>
            </thead>
            ${issueRows || `<tbody><tr><td colspan="8" class="empty">No unresolved issues found.</td></tr></tbody>`}
          </table>
        </div>
      </section>` : ""}

      <footer class="footer">
        <span>Accessibility report generated by Accessibility</span>
        <span>Interactive HTML report. Choose sections before printing when a PDF copy is needed.</span>
      </footer>
    </div>
  </main>
  <script>${script}</script>
</body>
</html>`;
}








