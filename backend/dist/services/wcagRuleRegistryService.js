"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeWcagCriterion = normalizeWcagCriterion;
exports.normalizeWcagCriteria = normalizeWcagCriteria;
exports.seedApprovedRuleMappings = seedApprovedRuleMappings;
exports.registerRuleMappingProposal = registerRuleMappingProposal;
exports.resolveGovernedWcagMapping = resolveGovernedWcagMapping;
exports.approveRuleMappingFromReview = approveRuleMappingFromReview;
exports.dismissRuleMappingReview = dismissRuleMappingReview;
exports.resolveRuleMappingReview = resolveRuleMappingReview;
exports.activeWcag22CriteriaCount = activeWcag22CriteriaCount;
const db_1 = require("../utils/db");
const ACTIVE_WCAG_22 = new Set([
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
const APPROVED_RULE_MAPPINGS = [
    { ruleId: "color:contrast-insufficient", ruleName: "Text contrast is too low", category: "contrast", wcag: ["1.4.3"], sourceModule: "colorContrast", rationale: "Text foreground/background contrast is tested against WCAG contrast minimum." },
    { ruleId: "color:focus-indicator-low-contrast", ruleName: "Focus indicator contrast is too low", category: "contrast", wcag: ["1.4.11", "2.4.7"], sourceModule: "colorContrast", rationale: "Focus indicator visibility and non-text contrast are both relevant to this rule." },
    { ruleId: "focus:invisible", ruleName: "Keyboard focus indicator is not visible", category: "focus", wcag: ["2.4.7"], sourceModule: "focusHeuristics", rationale: "The rule checks whether keyboard focus is visibly indicated." },
    { ruleId: "focus:obscured", ruleName: "Focused element is obscured", category: "focus", wcag: ["2.4.11", "2.4.12"], sourceModule: "focusHeuristics", rationale: "The rule checks whether focused content is hidden behind other content." },
    { ruleId: "focus:trap-missing", ruleName: "Keyboard focus can escape modal context", category: "focus", wcag: ["2.1.2"], sourceModule: "focusHeuristics", rationale: "Focus traps can create or indicate keyboard trap behavior." },
    { ruleId: "focus:escape-key-missing", ruleName: "Escape key does not dismiss modal content", category: "focus", wcag: ["2.1.2"], sourceModule: "focusHeuristics", rationale: "Users must be able to leave modal keyboard contexts." },
    { ruleId: "keyboard:tabindex-positive", ruleName: "Positive tabindex changes keyboard order", category: "keyboard", wcag: ["2.4.3"], sourceModule: "keyboardNav", rationale: "Positive tabindex can make focus order differ from meaningful order." },
    { ruleId: "keyboard:skip-link-missing", ruleName: "Page does not expose a skip link", category: "keyboard", wcag: ["2.4.1"], sourceModule: "keyboardNav", rationale: "Skip links are a common mechanism to bypass repeated blocks." },
    { ruleId: "keyboard:focus-loop", ruleName: "Keyboard focus loop detected", category: "keyboard", wcag: ["2.1.2"], sourceModule: "keyboardNav", rationale: "A user must be able to move focus away using keyboard." },
    { ruleId: "keyboard:arrow-key-no-response", ruleName: "Composite widget does not respond to arrow keys", category: "keyboard", wcag: ["2.1.1"], sourceModule: "keyboardNav", rationale: "Keyboard operation is required for custom composite controls." },
    { ruleId: "keyboard:custom-role-activation", ruleName: "Custom role does not activate from keyboard", category: "keyboard", wcag: ["2.1.1"], sourceModule: "keyboardNav", rationale: "Interactive controls must be operable by keyboard." },
    { ruleId: "keyboard:mouse-only-interaction", ruleName: "Mouse-only interaction detected", category: "keyboard", wcag: ["2.1.1"], sourceModule: "keyboardNav", rationale: "Functionality must be available from keyboard." },
    { ruleId: "heuristic:reflow", ruleName: "Reflow or small-screen layout risk", category: "responsive", wcag: ["1.4.10"], sourceModule: "heuristics", rationale: "The rule checks layout behavior at narrow viewport width." },
    { ruleId: "pointer:target-size", ruleName: "Interactive target is too small", category: "pointer", wcag: ["2.5.8"], sourceModule: "heuristics", rationale: "WCAG 2.2 AA defines minimum target size requirements." },
    { ruleId: "pointer:target-size-minimum", ruleName: "Interactive target is too small", category: "pointer", wcag: ["2.5.8"], sourceModule: "zoomPointer", rationale: "WCAG 2.2 AA target size minimum applies to small interactive targets." },
    { ruleId: "pointer:target-size-enhanced", ruleName: "Interactive target misses enhanced target size", category: "pointer", wcag: ["2.5.5"], sourceModule: "zoomPointer", rationale: "WCAG AAA target size applies only when AAA checks are enabled." },
    { ruleId: "zoom:viewport-locked", ruleName: "Viewport prevents user zoom", category: "zoom", wcag: ["1.4.4"], sourceModule: "zoomPointer", rationale: "Blocking zoom prevents resizing text." },
    { ruleId: "zoom:fixed-font-size", ruleName: "Fixed font size may block text resizing", category: "zoom", wcag: ["1.4.4"], sourceModule: "zoomPointer", rationale: "Text resizing depends on scalable text units." },
    { ruleId: "zoom:reflow-failure", ruleName: "Content does not reflow at narrow viewport", category: "zoom", wcag: ["1.4.10"], sourceModule: "zoomPointer", rationale: "Horizontal two-dimensional scrolling at 320 CSS px is a reflow failure." },
    { ruleId: "zoom:intermediate-breakpoint-failure", ruleName: "Content fails at an intermediate zoom breakpoint", category: "zoom", wcag: ["1.4.4", "1.4.10"], sourceModule: "zoomPointer", rationale: "Content must remain available throughout 200%-400% zoom, not only at the final narrow breakpoint." },
    { ruleId: "zoom:viewport-restoration-failure", ruleName: "Page state does not recover after zoom", category: "zoom", wcag: ["1.4.10", "1.4.13", "3.2.2"], sourceModule: "zoomPointer", rationale: "Restoring the viewport must not leave expanded content, scroll locks, transforms, or overflow that obscures or unexpectedly changes the page." },
    { ruleId: "zoom:text-clipped", ruleName: "Text is clipped at zoom", category: "zoom", wcag: ["1.4.4", "1.4.10"], sourceModule: "zoomPointer", rationale: "Clipped text can fail resizing text and reflow requirements." },
    { ruleId: "zoom:fixed-sticky-obstruction", ruleName: "Sticky content obstructs content at zoom", category: "zoom", wcag: ["1.4.10", "2.4.11"], sourceModule: "zoomPointer", rationale: "Sticky overlays can break reflow and obscure focused content." },
    { ruleId: "zoom:dialog-does-not-fit", ruleName: "Dialog does not fit at zoom", category: "zoom", wcag: ["1.4.10", "2.1.2"], sourceModule: "zoomPointer", rationale: "Dialogs must remain usable at narrow/zoomed layouts without trapping keyboard users." },
    { ruleId: "zoom:table-grid-unusable", ruleName: "Table or grid is unusable at zoom", category: "zoom", wcag: ["1.4.10", "1.3.1"], sourceModule: "zoomPointer", rationale: "Data relationships and reflow must remain usable." },
    { ruleId: "zoom:focus-unusable", ruleName: "Focus is unusable at zoom", category: "zoom", wcag: ["1.4.10", "2.4.7", "2.4.11"], sourceModule: "zoomPointer", rationale: "Focused controls must remain visible and usable in reflowed layouts." },
    { ruleId: "zoom:interactive-targets-overlap", ruleName: "Interactive targets overlap at zoom", category: "zoom", wcag: ["1.4.10", "2.5.8"], sourceModule: "zoomPointer", rationale: "Overlapping targets can break reflow and target size." },
    { ruleId: "zoom:function-labels-lost", ruleName: "Control labels are lost at zoom", category: "zoom", wcag: ["2.4.6", "4.1.2"], sourceModule: "zoomPointer", rationale: "Labels and accessible names must remain available." },
    { ruleId: "zoom:nested-scroll-trap-risk", ruleName: "Nested scroll area risks keyboard trap at zoom", category: "zoom", wcag: ["1.4.10", "2.1.1"], sourceModule: "zoomPointer", rationale: "Nested scroll regions can make zoomed content difficult or impossible to operate by keyboard." },
    { ruleId: "zoom:expanded-state-position-failure", ruleName: "Expanded content appears away from trigger at zoom", category: "zoom", wcag: ["1.4.10", "1.4.13", "2.4.11"], sourceModule: "zoomPointer", rationale: "Expanded hover/focus content must remain visible, dismissible, and spatially usable." },
    { ruleId: "zoom:text-spacing-failure", ruleName: "Text spacing causes loss of content", category: "zoom", wcag: ["1.4.12", "1.4.10"], sourceModule: "zoomPointer", rationale: "Text spacing changes must not cause content loss." }
];
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
function normalizeWcagCriterion(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw)
        return null;
    const withoutPrefix = raw.replace(/^wcag\s*/i, "").replace(/^wcag/, "");
    if (/^(2|20|21|22)(a|aa|aaa)$/.test(withoutPrefix))
        return null;
    const dotted = withoutPrefix.match(/\b([1-4]\.\d+\.\d+)\b/)?.[1];
    if (dotted)
        return dotted === "4.1.1" ? null : dotted;
    const digits = withoutPrefix.replace(/[^0-9]/g, "");
    if (!/^[1-4]\d{2,3}$/.test(digits))
        return null;
    const criterion = `${digits[0]}.${digits[1]}.${Number(digits.slice(2))}`;
    return criterion === "4.1.1" ? null : criterion;
}
function normalizeWcagCriteria(values) {
    return Array.from(new Set(values.map(normalizeWcagCriterion).filter((value) => Boolean(value))))
        .filter((criterion) => ACTIVE_WCAG_22.has(criterion))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function sourceModuleFor(issue) {
    if (issue.sourceHint)
        return issue.sourceHint;
    if (issue.ruleId.startsWith("axe:"))
        return "axeScan";
    return issue.ruleId.split(":")[0] || "scanner";
}
async function insertDecision(ruleId, previousWcag, decidedWcag, decision, reason, actorId) {
    await db_1.db.query(`INSERT INTO wcag_mapping_decisions (rule_id, previous_wcag, decided_wcag, decision, reason, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6)`, [ruleId, JSON.stringify(previousWcag), JSON.stringify(decidedWcag), decision, reason || null, actorId || null]);
}
async function seedApprovedRuleMappings() {
    for (const item of APPROVED_RULE_MAPPINGS) {
        const approved = normalizeWcagCriteria(item.wcag);
        await db_1.db.query(`INSERT INTO wcag_rule_registry
        (rule_id, rule_name, category, default_wcag, approved_wcag, mapping_status, review_status, source_module, rationale, last_reviewed_at)
       VALUES ($1, $2, $3, $4, $4, 'approved', 'approved', $5, $6, datetime('now'))
       ON CONFLICT(rule_id) DO UPDATE SET
         rule_name = excluded.rule_name,
         category = excluded.category,
         default_wcag = CASE WHEN wcag_rule_registry.default_wcag = '[]' THEN excluded.default_wcag ELSE wcag_rule_registry.default_wcag END,
         approved_wcag = CASE WHEN wcag_rule_registry.mapping_status = 'review_required' AND wcag_rule_registry.approved_wcag = '[]' THEN excluded.approved_wcag ELSE wcag_rule_registry.approved_wcag END,
         mapping_status = CASE WHEN wcag_rule_registry.mapping_status = 'review_required' AND wcag_rule_registry.approved_wcag = '[]' THEN 'approved' ELSE wcag_rule_registry.mapping_status END,
         review_status = CASE WHEN wcag_rule_registry.review_status = 'pending' AND wcag_rule_registry.approved_wcag = '[]' THEN 'approved' ELSE wcag_rule_registry.review_status END,
         source_module = excluded.source_module,
         rationale = COALESCE(wcag_rule_registry.rationale, excluded.rationale),
         updated_at = datetime('now')`, [item.ruleId, item.ruleName, item.category, JSON.stringify(approved), item.sourceModule, item.rationale]);
    }
}
async function registerRuleMappingProposal(issue) {
    const proposed = normalizeWcagCriteria(issue.wcag || []);
    await db_1.db.query(`INSERT INTO wcag_rule_registry
      (rule_id, rule_name, category, default_wcag, approved_wcag, mapping_status, review_status, source_module, rationale)
     VALUES ($1, $2, $3, $4, '[]', $5, 'pending', $6, $7)
     ON CONFLICT(rule_id) DO UPDATE SET
       rule_name = CASE WHEN wcag_rule_registry.rule_name = '' THEN excluded.rule_name ELSE wcag_rule_registry.rule_name END,
       category = COALESCE(wcag_rule_registry.category, excluded.category),
       default_wcag = CASE WHEN wcag_rule_registry.default_wcag = '[]' THEN excluded.default_wcag ELSE wcag_rule_registry.default_wcag END,
       source_module = COALESCE(wcag_rule_registry.source_module, excluded.source_module),
       updated_at = datetime('now')`, [
        issue.ruleId,
        issue.message || issue.ruleId,
        issue.category || null,
        JSON.stringify(proposed),
        proposed.length ? "review_required" : "advisory",
        sourceModuleFor(issue),
        proposed.length ? "Auto-registered from scanner proposal; requires governance review before it becomes authoritative." : "No active WCAG 2.2 criterion was proposed."
    ]);
    const rows = await db_1.db.query("SELECT * FROM wcag_rule_registry WHERE rule_id = $1", [issue.ruleId]);
    return rows.rows[0];
}
async function resolveGovernedWcagMapping(issue) {
    await seedApprovedRuleMappings();
    const registry = await registerRuleMappingProposal(issue);
    const approved = normalizeWcagCriteria(parseMaybeJsonArray(registry.approved_wcag));
    if (registry.mapping_status === "approved" && approved.length) {
        return { wcag: approved.map((criterion) => `wcag${criterion}`), mappingStatus: "approved", registry };
    }
    return { wcag: [], mappingStatus: registry.mapping_status || "review_required", registry };
}
async function approveRuleMappingFromReview(ruleId, criteria, reason, actorId) {
    const approved = normalizeWcagCriteria(criteria);
    if (!approved.length)
        throw new Error("Cannot approve a WCAG mapping without active WCAG 2.2 criteria.");
    const existing = await db_1.db.query("SELECT * FROM wcag_rule_registry WHERE rule_id = $1", [ruleId]);
    const previous = normalizeWcagCriteria(parseMaybeJsonArray(existing.rows[0]?.approved_wcag));
    await db_1.db.query(`INSERT INTO wcag_rule_registry
      (rule_id, rule_name, default_wcag, approved_wcag, mapping_status, review_status, rationale, last_reviewed_by, last_reviewed_at)
     VALUES ($1, $1, $2, $2, 'approved', 'approved', $3, $4, datetime('now'))
     ON CONFLICT(rule_id) DO UPDATE SET
       approved_wcag = excluded.approved_wcag,
       mapping_status = 'approved',
       review_status = 'approved',
       rationale = excluded.rationale,
       last_reviewed_by = excluded.last_reviewed_by,
       last_reviewed_at = datetime('now'),
       updated_at = datetime('now')`, [ruleId, JSON.stringify(approved), reason, actorId || null]);
    await insertDecision(ruleId, previous, approved, "accepted", reason, actorId);
}
async function dismissRuleMappingReview(ruleId, criteria, reason, actorId) {
    const rejected = normalizeWcagCriteria(criteria);
    const existing = await db_1.db.query("SELECT * FROM wcag_rule_registry WHERE rule_id = $1", [ruleId]);
    const previous = normalizeWcagCriteria(parseMaybeJsonArray(existing.rows[0]?.approved_wcag));
    await db_1.db.query(`UPDATE wcag_rule_registry
     SET review_status = CASE WHEN approved_wcag = '[]' THEN 'rejected' ELSE 'resolved' END,
         mapping_status = CASE WHEN approved_wcag = '[]' THEN 'rejected' ELSE mapping_status END,
         rationale = $2,
         last_reviewed_by = $3,
         last_reviewed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE rule_id = $1`, [ruleId, reason, actorId || null]);
    await insertDecision(ruleId, previous, rejected, "dismissed", reason, actorId);
}
async function resolveRuleMappingReview(ruleId, criteria, reason, actorId) {
    const rows = await db_1.db.query("SELECT * FROM wcag_rule_registry WHERE rule_id = $1", [ruleId]);
    const registry = rows.rows[0];
    if (!registry)
        throw new Error(`Rule ${ruleId} is not registered in WCAG governance.`);
    const current = normalizeWcagCriteria(criteria);
    const approved = normalizeWcagCriteria(parseMaybeJsonArray(registry.approved_wcag));
    if (JSON.stringify(current) !== JSON.stringify(approved)) {
        throw new Error("Cannot mark resolved until the review criteria match the approved registry mapping.");
    }
    await db_1.db.query(`UPDATE wcag_rule_registry
     SET review_status = 'resolved',
         last_reviewed_by = $2,
         last_reviewed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE rule_id = $1`, [ruleId, actorId || null]);
    await insertDecision(ruleId, approved, approved, "resolved", reason, actorId);
}
function activeWcag22CriteriaCount() {
    return ACTIVE_WCAG_22.size;
}
