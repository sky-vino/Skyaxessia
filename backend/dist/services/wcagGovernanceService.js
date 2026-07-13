"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureWcagGovernanceReady = ensureWcagGovernanceReady;
exports.getWcagGovernanceStatus = getWcagGovernanceStatus;
exports.listWcagMappingReviews = listWcagMappingReviews;
exports.updateWcagMappingReview = updateWcagMappingReview;
const db_1 = require("../utils/db");
const logger_1 = require("../utils/logger");
const wcagRuleRegistryService_1 = require("./wcagRuleRegistryService");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const W3C_QUICKREF_URL = "https://www.w3.org/WAI/WCAG22/quickref/";
let governanceRun = null;
const PRINCIPLES = {
    "1": "Perceivable",
    "2": "Operable",
    "3": "Understandable",
    "4": "Robust"
};
const FALLBACK_WCAG = [
    { criterion: "1.1.1", title: "Non-text Content", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html" },
    { criterion: "1.2.1", title: "Audio-only and Video-only (Prerecorded)", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/audio-only-and-video-only-prerecorded.html" },
    { criterion: "1.2.2", title: "Captions (Prerecorded)", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html" },
    { criterion: "1.2.3", title: "Audio Description or Media Alternative (Prerecorded)", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html" },
    { criterion: "1.2.4", title: "Captions (Live)", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/captions-live.html" },
    { criterion: "1.2.5", title: "Audio Description (Prerecorded)", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/audio-description-prerecorded.html" },
    { criterion: "1.3.1", title: "Info and Relationships", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html" },
    { criterion: "1.3.2", title: "Meaningful Sequence", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence.html" },
    { criterion: "1.3.3", title: "Sensory Characteristics", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics.html" },
    { criterion: "1.3.4", title: "Orientation", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/orientation.html" },
    { criterion: "1.3.5", title: "Identify Input Purpose", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/identify-input-purpose.html" },
    { criterion: "1.4.1", title: "Use of Color", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html" },
    { criterion: "1.4.2", title: "Audio Control", level: "A", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html" },
    { criterion: "1.4.3", title: "Contrast (Minimum)", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" },
    { criterion: "1.4.4", title: "Resize Text", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html" },
    { criterion: "1.4.5", title: "Images of Text", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/images-of-text.html" },
    { criterion: "1.4.10", title: "Reflow", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html" },
    { criterion: "1.4.11", title: "Non-text Contrast", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html" },
    { criterion: "1.4.12", title: "Text Spacing", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html" },
    { criterion: "1.4.13", title: "Content on Hover or Focus", level: "AA", principle: "Perceivable", url: "https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html" },
    { criterion: "2.1.1", title: "Keyboard", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html" },
    { criterion: "2.1.2", title: "No Keyboard Trap", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html" },
    { criterion: "2.1.4", title: "Character Key Shortcuts", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html" },
    { criterion: "2.2.1", title: "Timing Adjustable", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html" },
    { criterion: "2.2.2", title: "Pause, Stop, Hide", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html" },
    { criterion: "2.3.1", title: "Three Flashes or Below Threshold", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html" },
    { criterion: "2.4.1", title: "Bypass Blocks", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/bypass-blocks.html" },
    { criterion: "2.4.2", title: "Page Titled", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/page-titled.html" },
    { criterion: "2.4.3", title: "Focus Order", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html" },
    { criterion: "2.4.4", title: "Link Purpose (In Context)", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html" },
    { criterion: "2.4.5", title: "Multiple Ways", level: "AA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/multiple-ways.html" },
    { criterion: "2.4.6", title: "Headings and Labels", level: "AA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html" },
    { criterion: "2.4.7", title: "Focus Visible", level: "AA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html" },
    { criterion: "2.4.11", title: "Focus Not Obscured (Minimum)", level: "AA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html" },
    { criterion: "2.4.12", title: "Focus Not Obscured (Enhanced)", level: "AAA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-enhanced.html" },
    { criterion: "2.4.13", title: "Focus Appearance", level: "AAA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html" },
    { criterion: "2.5.1", title: "Pointer Gestures", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html" },
    { criterion: "2.5.2", title: "Pointer Cancellation", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html" },
    { criterion: "2.5.3", title: "Label in Name", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html" },
    { criterion: "2.5.4", title: "Motion Actuation", level: "A", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/motion-actuation.html" },
    { criterion: "2.5.7", title: "Dragging Movements", level: "AA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html" },
    { criterion: "2.5.8", title: "Target Size (Minimum)", level: "AA", principle: "Operable", url: "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html" },
    { criterion: "3.1.1", title: "Language of Page", level: "A", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html" },
    { criterion: "3.1.2", title: "Language of Parts", level: "AA", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/language-of-parts.html" },
    { criterion: "3.2.1", title: "On Focus", level: "A", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/on-focus.html" },
    { criterion: "3.2.2", title: "On Input", level: "A", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/on-input.html" },
    { criterion: "3.2.3", title: "Consistent Navigation", level: "AA", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/consistent-navigation.html" },
    { criterion: "3.2.4", title: "Consistent Identification", level: "AA", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html" },
    { criterion: "3.2.6", title: "Consistent Help", level: "A", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/consistent-help.html" },
    { criterion: "3.3.1", title: "Error Identification", level: "A", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html" },
    { criterion: "3.3.2", title: "Labels or Instructions", level: "A", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html" },
    { criterion: "3.3.3", title: "Error Suggestion", level: "AA", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html" },
    { criterion: "3.3.4", title: "Error Prevention (Legal, Financial, Data)", level: "AA", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html" },
    { criterion: "3.3.7", title: "Redundant Entry", level: "A", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html" },
    { criterion: "3.3.8", title: "Accessible Authentication (Minimum)", level: "AA", principle: "Understandable", url: "https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html" },
    { criterion: "4.1.2", title: "Name, Role, Value", level: "A", principle: "Robust", url: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html" },
    { criterion: "4.1.3", title: "Status Messages", level: "AA", principle: "Robust", url: "https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html" }
];
const LOCAL_RULES = [
    { ruleId: "color:contrast-insufficient", title: "Text contrast is too low", currentWcag: ["wcag1.4.3"], suggestedWcag: ["wcag1.4.3"] },
    { ruleId: "color:focus-indicator-low-contrast", title: "Focus indicator contrast is too low", currentWcag: ["wcag1.4.11", "wcag2.4.7"], suggestedWcag: ["wcag1.4.11", "wcag2.4.7"] },
    { ruleId: "focus:invisible", title: "Keyboard focus indicator is not visible", currentWcag: ["wcag2.4.7"], suggestedWcag: ["wcag2.4.7"] },
    { ruleId: "focus:obscured", title: "Focused element is obscured", currentWcag: ["wcag2.4.11", "wcag2.4.12"], suggestedWcag: ["wcag2.4.11", "wcag2.4.12"] },
    { ruleId: "heuristic:reflow", title: "Reflow or small-screen layout risk", currentWcag: ["wcag1.4.10"], suggestedWcag: ["wcag1.4.10"] },
    { ruleId: "pointer:target-size", title: "Interactive target is too small", currentWcag: ["wcag2.5.8"], suggestedWcag: ["wcag2.5.8"] },
    { ruleId: "keyboard:tab-order-positive-tabindex", title: "Positive tabindex changes keyboard order", currentWcag: ["wcag2.4.3"], suggestedWcag: ["wcag2.4.3"] },
    { ruleId: "keyboard:skip-link-missing", title: "Page does not expose a skip link", currentWcag: ["wcag2.4.1"], suggestedWcag: ["wcag2.4.1"] }
];
function normalizeCriterion(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw)
        return null;
    const withoutPrefix = raw.replace(/^wcag/, "");
    if (/^(2|20|21|22)(a|aa|aaa)$/.test(withoutPrefix))
        return null;
    const dotted = withoutPrefix.match(/\b([1-4]\.\d+\.\d+)\b/)?.[1];
    if (dotted)
        return dotted;
    const digits = withoutPrefix.replace(/[^0-9]/g, "");
    if (!/^[1-4]\d{2,3}$/.test(digits))
        return null;
    const principle = digits[0];
    const guideline = digits[1];
    const successCriterion = digits.slice(2);
    return `${principle}.${guideline}.${Number(successCriterion)}`;
}
function normalizeCriteria(values) {
    return Array.from(new Set(values.map((value) => normalizeCriterion(value)).filter((value) => Boolean(value)))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function parseMaybeJsonArray(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value.map(String);
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed))
                return parsed.map(String);
        }
        catch { }
        return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [String(value)];
}
function decodeHtml(value) {
    return String(value || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function inferLevel(text) {
    const level = text.match(/level\s+(AAA|AA|A)\b/i)?.[1]?.toUpperCase();
    return level === "AAA" || level === "AA" ? level : "A";
}
function titleFromSlug(slug) {
    return slug
        .split("-")
        .filter(Boolean)
        .map((word) => {
        if (word.toLowerCase() === "and")
            return "and";
        if (word.toLowerCase() === "or")
            return "or";
        return word.charAt(0).toUpperCase() + word.slice(1);
    })
        .join(" ");
}
function preferredCriterionTitle(criterion, parsedTitle, slug) {
    const fallback = FALLBACK_WCAG.find((item) => item.criterion === criterion)?.title;
    if (fallback)
        return fallback;
    if (!parsedTitle || /^understanding$/i.test(parsedTitle))
        return titleFromSlug(slug);
    return parsedTitle;
}
function parseWcagQuickref(html) {
    const found = new Map();
    const linkPattern = /href="([^"]*Understanding\/([^"#]+)\.html[^"]*)"[^>]*>([\s\S]{0,250}?)<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(html))) {
        const nearby = decodeHtml(match[3]);
        const criterion = nearby.match(/\b([1-4]\.\d+\.\d+)\b/)?.[1];
        if (!criterion)
            continue;
        const title = nearby
            .replace(/\b[1-4]\.\d+\.\d+\b/g, "")
            .replace(/\(?level\s+(AAA|AA|A)\)?/gi, "")
            .replace(/^success criterion/i, "")
            .trim();
        const principle = PRINCIPLES[criterion[0]] || "Unknown";
        const url = new URL(match[1], W3C_QUICKREF_URL).toString();
        found.set(criterion, {
            criterion,
            title: preferredCriterionTitle(criterion, title, match[2]),
            level: inferLevel(nearby),
            principle,
            url,
            source: W3C_QUICKREF_URL
        });
    }
    return Array.from(found.values()).sort((a, b) => a.criterion.localeCompare(b.criterion, undefined, { numeric: true }));
}
async function seedMetadata(rows, source) {
    for (const item of rows) {
        const title = preferredCriterionTitle(item.criterion, item.title, item.url.split("/").pop()?.replace(/\.html.*/i, "") || "");
        await db_1.db.query(`INSERT INTO wcag_metadata (criterion, title, level, principle, url, source, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, datetime('now'))
       ON CONFLICT(criterion) DO UPDATE SET
         title = excluded.title,
         level = excluded.level,
         principle = excluded.principle,
         url = excluded.url,
         source = excluded.source,
         fetched_at = excluded.fetched_at`, [item.criterion, title, item.level, item.principle, item.url, source]);
    }
}
async function fetchLiveWcagMetadata() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(W3C_QUICKREF_URL, { signal: controller.signal });
        if (!response.ok)
            throw new Error(`W3C quickref returned ${response.status}`);
        const html = await response.text();
        if (!/WCAG\s*2\.2|Success Criteria|Quick Reference/i.test(html)) {
            throw new Error("W3C quickref response did not look like WCAG metadata");
        }
        const parsed = parseWcagQuickref(html);
        if (parsed.length >= 20)
            return parsed;
        logger_1.logger.warn(`WCAG quickref parse returned ${parsed.length} rows; using bundled metadata with live source verification.`);
        return FALLBACK_WCAG.map((item) => ({ ...item, source: W3C_QUICKREF_URL }));
    }
    finally {
        clearTimeout(timeout);
    }
}
async function refreshIfNeeded(force = false) {
    const latest = await db_1.db.query("SELECT MAX(fetched_at) AS fetched_at FROM wcag_metadata");
    const fetchedAt = latest.rows[0]?.fetched_at ? new Date(`${latest.rows[0].fetched_at}Z`) : null;
    const stale = !fetchedAt || Number.isNaN(fetchedAt.getTime()) || Date.now() - fetchedAt.getTime() > WEEK_MS;
    if (!force && !stale)
        return { refreshed: false, source: "current-cache" };
    try {
        const liveRows = await fetchLiveWcagMetadata();
        await seedMetadata(liveRows, W3C_QUICKREF_URL);
        return { refreshed: true, source: W3C_QUICKREF_URL };
    }
    catch (error) {
        logger_1.logger.warn("WCAG live metadata refresh failed; using bundled fallback metadata.", error);
        await seedMetadata(FALLBACK_WCAG, "bundled-fallback");
        return { refreshed: true, source: "bundled-fallback" };
    }
}
function suspiciousReason(ruleId, title, wcag, criterionTitle) {
    const haystack = `${ruleId} ${title}`.toLowerCase();
    const criterion = normalizeCriterion(wcag);
    if (!criterion)
        return null;
    const wcagTitle = String(criterionTitle || "").toLowerCase();
    if (!criterionTitle) {
        return `Mapped WCAG criterion ${criterion} from ${wcag} is not present in the current WCAG metadata cache.`;
    }
    if (/contrast/.test(haystack) && criterion === "2.4.11") {
        return `Contrast-related rule is mapped to "${criterionTitle}"; contrast findings normally map to WCAG 1.4.3, 1.4.11, 2.4.7, or 2.4.13 depending on the object being tested.`;
    }
    if (/focus.*indicator|focus:invisible/.test(haystack) && criterion === "2.4.11") {
        return `Visible focus indicator rule is mapped to "${criterionTitle}"; that criterion is for focus being hidden behind content, not missing or low-contrast indicators.`;
    }
    if (/obscur/.test(haystack) && !["2.4.11", "2.4.12"].includes(criterion)) {
        return `Focus-obscured rule should normally map to WCAG 2.4.11 or 2.4.12, not ${wcag}.`;
    }
    if (/contrast/.test(haystack) && wcagTitle.includes("obscured")) {
        return `Rule wording says contrast, but mapped criterion title is "${criterionTitle}".`;
    }
    return null;
}
async function upsertReview(ruleId, currentWcag, suggestedWcag, reason) {
    const currentJson = JSON.stringify(normalizeCriteria(currentWcag));
    const suggestedJson = JSON.stringify(normalizeCriteria(suggestedWcag));
    try {
        await db_1.db.query(`INSERT INTO wcag_mapping_reviews (rule_id, current_wcag, suggested_wcag, reason, status, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'pending', datetime('now'), datetime('now'))
       ON CONFLICT(rule_id, current_wcag, reason) DO UPDATE SET
         suggested_wcag = excluded.suggested_wcag,
         last_seen_at = datetime('now'),
         status = CASE WHEN wcag_mapping_reviews.status = 'resolved' THEN 'pending' ELSE wcag_mapping_reviews.status END`, [ruleId, currentJson, suggestedJson, reason]);
    }
    catch (error) {
        if (error?.code !== "SQLITE_CONSTRAINT")
            throw error;
        await db_1.db.query(`UPDATE wcag_mapping_reviews
       SET suggested_wcag = $3,
           last_seen_at = datetime('now'),
           status = CASE WHEN status = 'resolved' THEN 'pending' ELSE status END
       WHERE rule_id = $1 AND current_wcag = $2 AND reason = $4`, [ruleId, currentJson, suggestedJson, reason]);
    }
    await db_1.db.query(`UPDATE wcag_mapping_reviews
     SET status = 'resolved',
         resolved_at = COALESCE(resolved_at, datetime('now')),
         last_seen_at = datetime('now')
     WHERE rule_id = $1
       AND current_wcag = $2
       AND reason <> $3
       AND status = 'pending'`, [ruleId, currentJson, reason]);
}
async function criterionTitle(wcag) {
    const criterion = normalizeCriterion(wcag);
    if (!criterion)
        return undefined;
    const rows = await db_1.db.query("SELECT title FROM wcag_metadata WHERE criterion = $1", [criterion]);
    return rows.rows[0]?.title;
}
async function validateLocalRules() {
    for (const rule of LOCAL_RULES) {
        const currentCriteria = normalizeCriteria(rule.currentWcag);
        const suggestedCriteria = normalizeCriteria(rule.suggestedWcag || []);
        for (const current of currentCriteria) {
            const title = await criterionTitle(current);
            const reason = suspiciousReason(rule.ruleId, rule.title, current, title);
            if (reason)
                await upsertReview(rule.ruleId, currentCriteria, suggestedCriteria, reason);
        }
    }
}
async function validateHistoricalIssues() {
    const rows = await db_1.db.query(`SELECT rule_id, wcag_criteria, message
     FROM issues
     WHERE wcag_criteria IS NOT NULL AND wcag_criteria <> ''
     GROUP BY rule_id, wcag_criteria, message
     ORDER BY MAX(created_at) DESC
     LIMIT 500`);
    for (const row of rows.rows) {
        const criteria = normalizeCriteria(parseMaybeJsonArray(row.wcag_criteria));
        if (!criteria.length)
            continue;
        for (const current of criteria) {
            const title = await criterionTitle(current);
            const reason = suspiciousReason(row.rule_id, row.message, current, title);
            if (!reason)
                continue;
            const registry = LOCAL_RULES.find((item) => item.ruleId === row.rule_id);
            await upsertReview(row.rule_id, criteria, normalizeCriteria(registry?.suggestedWcag || []), reason);
        }
    }
}
async function resolveStaleNormalizedReviewRows() {
    const rows = await db_1.db.query(`SELECT id, current_wcag
     FROM wcag_mapping_reviews
     WHERE status = 'pending'
       AND reason LIKE 'Mapped WCAG criterion % is not present in the current WCAG metadata cache.%'`);
    for (const row of rows.rows) {
        const criteria = normalizeCriteria(parseMaybeJsonArray(row.current_wcag));
        let missing = false;
        for (const criterion of criteria) {
            const title = await criterionTitle(criterion);
            if (!title) {
                missing = true;
                break;
            }
        }
        if (criteria.length && missing)
            continue;
        await db_1.db.query(`UPDATE wcag_mapping_reviews
       SET status = 'resolved',
           resolved_at = COALESCE(resolved_at, datetime('now')),
           last_seen_at = datetime('now')
       WHERE id = $1`, [row.id]);
    }
}
async function collapseDuplicatePendingReviews() {
    const rows = await db_1.db.query(`SELECT id, rule_id, current_wcag, suggested_wcag, reason, last_seen_at
     FROM wcag_mapping_reviews
     WHERE status = 'pending'
     ORDER BY last_seen_at DESC`);
    const seen = new Map();
    for (const row of rows.rows) {
        const currentJson = JSON.stringify(normalizeCriteria(parseMaybeJsonArray(row.current_wcag)));
        const suggestedJson = JSON.stringify(normalizeCriteria(parseMaybeJsonArray(row.suggested_wcag)));
        const key = `${row.rule_id}|${currentJson}`;
        const keepId = seen.get(key);
        if (!keepId) {
            seen.set(key, row.id);
            if (currentJson !== JSON.stringify(parseMaybeJsonArray(row.current_wcag)) || suggestedJson !== JSON.stringify(parseMaybeJsonArray(row.suggested_wcag))) {
                const collision = await db_1.db.query(`SELECT id
           FROM wcag_mapping_reviews
           WHERE rule_id = $1 AND current_wcag = $2 AND reason = $3 AND id <> $4
           LIMIT 1`, [row.rule_id, currentJson, row.reason, row.id]);
                if (collision.rows[0]?.id) {
                    await db_1.db.query(`UPDATE wcag_mapping_reviews
             SET status = 'resolved',
                 resolved_at = COALESCE(resolved_at, datetime('now')),
                 last_seen_at = datetime('now')
             WHERE id = $1`, [row.id]);
                    seen.set(key, collision.rows[0].id);
                    continue;
                }
                await db_1.db.query(`UPDATE wcag_mapping_reviews
           SET current_wcag = $2,
               suggested_wcag = $3,
               last_seen_at = datetime('now')
           WHERE id = $1`, [row.id, currentJson, suggestedJson]);
            }
            continue;
        }
        await db_1.db.query(`UPDATE wcag_mapping_reviews
       SET status = 'resolved',
           resolved_at = COALESCE(resolved_at, datetime('now')),
           last_seen_at = datetime('now')
       WHERE id = $1`, [row.id]);
    }
}
async function runWcagGovernance(forceRefresh) {
    const result = await refreshIfNeeded(forceRefresh);
    if (result.refreshed)
        logger_1.logger.info(`WCAG metadata refreshed from ${result.source}`);
    await (0, wcagRuleRegistryService_1.seedApprovedRuleMappings)();
    await validateLocalRules();
    await validateHistoricalIssues();
    await resolveStaleNormalizedReviewRows();
    await collapseDuplicatePendingReviews();
}
async function ensureWcagGovernanceReady(forceRefresh = false) {
    if (governanceRun) {
        await governanceRun;
        if (!forceRefresh)
            return;
    }
    const currentRun = runWcagGovernance(forceRefresh);
    governanceRun = currentRun;
    try {
        await currentRun;
    }
    finally {
        if (governanceRun === currentRun)
            governanceRun = null;
    }
}
async function getWcagGovernanceStatus() {
    await ensureWcagGovernanceReady();
    const meta = await db_1.db.query("SELECT fetched_at, source FROM wcag_metadata ORDER BY fetched_at DESC LIMIT 1");
    const criteria = await db_1.db.query("SELECT COUNT(*) AS count FROM wcag_metadata");
    const pending = await db_1.db.query("SELECT COUNT(*) AS count FROM wcag_mapping_reviews WHERE status = 'pending'");
    const reviews = await db_1.db.query("SELECT * FROM wcag_mapping_reviews WHERE status = 'pending' ORDER BY last_seen_at DESC LIMIT 5");
    const fetchedAt = meta.rows[0]?.fetched_at ? new Date(`${meta.rows[0].fetched_at}Z`) : null;
    const nextRefresh = fetchedAt && !Number.isNaN(fetchedAt.getTime())
        ? new Date(fetchedAt.getTime() + WEEK_MS).toISOString()
        : null;
    return {
        metadata_last_fetched_at: meta.rows[0]?.fetched_at || null,
        metadata_source: meta.rows[0]?.source || null,
        next_refresh_due_at: nextRefresh,
        refresh_interval_days: 7,
        criteria_count: (0, wcagRuleRegistryService_1.activeWcag22CriteriaCount)(),
        metadata_entries_count: Number(criteria.rows[0]?.count || 0),
        pending_review_count: Number(pending.rows[0]?.count || 0),
        reviews: reviews.rows.map((row) => ({
            ...row,
            current_wcag: parseMaybeJsonArray(row.current_wcag),
            suggested_wcag: parseMaybeJsonArray(row.suggested_wcag)
        }))
    };
}
async function listWcagMappingReviews(status = "pending") {
    await ensureWcagGovernanceReady();
    const rows = await db_1.db.query("SELECT * FROM wcag_mapping_reviews WHERE status = $1 ORDER BY last_seen_at DESC", [status]);
    return rows.rows.map((row) => ({
        ...row,
        current_wcag: parseMaybeJsonArray(row.current_wcag),
        suggested_wcag: parseMaybeJsonArray(row.suggested_wcag)
    }));
}
async function updateWcagMappingReview(id, status, actorId) {
    if (!["pending", "accepted", "dismissed", "resolved"].includes(status)) {
        throw new Error("Invalid WCAG review status");
    }
    const before = await db_1.db.query("SELECT * FROM wcag_mapping_reviews WHERE id = $1", [id]);
    const review = before.rows[0];
    if (!review)
        return null;
    const current = parseMaybeJsonArray(review.current_wcag);
    const suggested = parseMaybeJsonArray(review.suggested_wcag);
    const reason = String(review.reason || "");
    if (status === "accepted") {
        await (0, wcagRuleRegistryService_1.approveRuleMappingFromReview)(review.rule_id, suggested.length ? suggested : current, reason, actorId);
    }
    else if (status === "dismissed") {
        await (0, wcagRuleRegistryService_1.dismissRuleMappingReview)(review.rule_id, suggested.length ? suggested : current, reason, actorId);
    }
    else if (status === "resolved") {
        await (0, wcagRuleRegistryService_1.resolveRuleMappingReview)(review.rule_id, current, reason, actorId);
    }
    await db_1.db.query(`UPDATE wcag_mapping_reviews
     SET status = $2,
         resolved_at = CASE WHEN $2 IN ('accepted','dismissed','resolved') THEN datetime('now') ELSE NULL END,
         last_seen_at = datetime('now')
     WHERE id = $1`, [id, status]);
    const rows = await db_1.db.query("SELECT * FROM wcag_mapping_reviews WHERE id = $1", [id]);
    return rows.rows[0] || null;
}
