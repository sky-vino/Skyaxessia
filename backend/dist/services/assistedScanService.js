"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAssistedScan = createAssistedScan;
exports.submitAssistedState = submitAssistedState;
exports.completeAssistedScan = completeAssistedScan;
const playwright_1 = require("playwright");
const db_1 = require("../utils/db");
const wsManager_1 = require("../utils/wsManager");
const axeScan_1 = require("../scanner/axeScan");
const heuristics_1 = require("../scanner/heuristics");
const severityWeight = {
    critical: 12,
    serious: 7,
    moderate: 3,
    minor: 1
};
async function createAssistedScan(userId, url, name) {
    const result = await db_1.db.query(`INSERT INTO scans (name, urls, created_by, state_label, scan_options, status, started_at, progress, navigated_urls)
     VALUES ($1,$2,$3,'browser-extension-assisted',$4,'running',NOW(),5,$5) RETURNING *`, [
        name || `Assisted browser scan - ${new Date().toLocaleString()}`,
        [url],
        userId,
        JSON.stringify({
            scan_entry_mode: "browser-extension-assisted",
            assisted_browser_scan: true,
            post_login_tab_scan: false,
            crawl_mode: false
        }),
        [url]
    ]);
    const scan = result.rows[0];
    wsManager_1.wsManager.broadcast(scan.id, { type: "scan:started", scanId: scan.id, message: "Assisted browser scan started" });
    return scan;
}
async function submitAssistedState(scanId, payload) {
    const scanResult = await db_1.db.query("SELECT * FROM scans WHERE id = $1", [scanId]);
    const scan = scanResult.rows[0];
    if (!scan)
        throw new Error("Scan not found");
    if (!["running", "queued"].includes(scan.status)) {
        throw new Error(`Cannot submit state to scan with status ${scan.status}`);
    }
    const stateLabel = String(payload.state_label || `state-${Date.now()}`).slice(0, 120);
    const phase = `assisted:${stateLabel}`;
    const viewport = {
        width: Math.max(320, Math.min(3840, Number(payload.viewport?.width) || 1366)),
        height: Math.max(320, Math.min(2160, Number(payload.viewport?.height) || 768))
    };
    const issues = [
        ...await analyzeSubmittedDom(payload, stateLabel, phase, viewport),
        ...interactionIssues(payload, stateLabel, phase)
    ];
    const issueIds = [];
    for (const issue of issues) {
        const inserted = await insertIssue(scanId, issue);
        if (inserted?.id)
            issueIds.push(inserted.id);
    }
    for (const issue of issues.slice(0, 40)) {
        await insertTestCase(scanId, issue);
    }
    await db_1.db.query("INSERT INTO dom_snapshots (scan_id, url, phase, html, a11y_tree, screenshot) VALUES ($1,$2,$3,$4,$5,$6)", [
        scanId,
        payload.url,
        phase,
        payload.html,
        JSON.stringify({
            type: "assisted-browser-state",
            title: payload.title || "",
            state: stateLabel,
            viewport,
            interactionSummary: summarizeInteractions(payload.interactions || []),
            interactions: payload.interactions || []
        }),
        payload.screenshot || null
    ]);
    await refreshScanTotals(scanId, payload.url);
    const updated = await db_1.db.query("SELECT total_issues, score FROM scans WHERE id = $1", [scanId]);
    const total = Number(updated.rows[0]?.total_issues || 0);
    const score = Math.round(Number(updated.rows[0]?.score || 100));
    wsManager_1.wsManager.broadcast(scanId, {
        type: "scan:progress",
        scanId,
        progress: 75,
        message: `Captured assisted state "${stateLabel}" with ${issues.length} issue${issues.length === 1 ? "" : "s"}`
    });
    return { issueCount: total, score };
}
async function completeAssistedScan(scanId) {
    await refreshScanTotals(scanId);
    await db_1.db.query("UPDATE scans SET status = 'completed', completed_at = NOW(), progress = 100 WHERE id = $1", [scanId]);
    const result = await db_1.db.query("SELECT * FROM scans WHERE id = $1", [scanId]);
    const scan = result.rows[0];
    wsManager_1.wsManager.broadcast(scanId, {
        type: "scan:completed",
        scanId,
        totalIssues: scan?.total_issues || 0,
        score: scan?.score || 100,
        navigatedUrls: scan?.navigated_urls || [],
        message: "Assisted browser scan completed"
    });
    return scan;
}
async function analyzeSubmittedDom(payload, state, phase, viewport) {
    const browser = await playwright_1.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    const context = await browser.newContext({
        viewport,
        ignoreHTTPSErrors: true,
        locale: "en-US"
    });
    const page = await context.newPage();
    try {
        await page.setContent(payload.html || "<!doctype html><html><body></body></html>", { waitUntil: "domcontentloaded", timeout: 30000 });
        return [
            ...await (0, axeScan_1.runAxe)(page, payload.url, state, phase),
            ...await (0, heuristics_1.runHeuristics)(page, payload.url, state, phase)
        ].map(issue => ({
            ...issue,
            evidenceScreenshot: issue.evidenceScreenshot || payload.screenshot,
            sourceHint: issue.sourceHint || "browser-extension-assisted"
        }));
    }
    finally {
        await context.close();
        await browser.close();
    }
}
function interactionIssues(payload, state, phase) {
    const badStatuses = new Set(["not-clickable", "failed", "blocked", "missing-name", "missing-href"]);
    return (payload.interactions || [])
        .filter(item => badStatuses.has(String(item.status || "")))
        .slice(0, 100)
        .map(item => ({
        ruleId: `assisted-interaction:${item.status || "failed"}`,
        severity: item.status === "missing-name" ? "serious" : "moderate",
        priority: item.status === "missing-name" ? 2 : 3,
        category: "interaction",
        message: `${item.role || "Control"} "${item.label || item.selector || "unnamed"}" is ${item.status || "not usable"}.`,
        url: payload.url,
        selector: item.selector,
        selectors: item.selector ? [item.selector] : [],
        wcag: item.status === "missing-name" ? ["wcag4.1.2", "wcag2.4.4"] : ["wcag2.1.1", "wcag2.5.8"],
        fixSuggestion: item.reason || "Verify the control has an accessible name, is enabled, and can be activated by mouse and keyboard.",
        evidenceScreenshot: payload.screenshot,
        sourceHint: "browser-extension-assisted",
        state,
        phase
    }));
}
function summarizeInteractions(interactions) {
    return interactions.reduce((acc, item) => {
        const key = String(item.status || "unknown");
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
}
async function insertIssue(scanId, issue) {
    const result = await db_1.db.query(`INSERT INTO issues (scan_id, rule_id, severity, priority, category, message, url,
      selector, selectors, affected_elements, depths, wcag_criteria, act_rules, tags, help_url, html_snippet,
      fix_suggestion, evidence_screenshot, evidence_explanation, component_id, component_owner, source_hint, state_label, phase)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`, [
        scanId, issue.ruleId, issue.severity, issue.priority || 3,
        issue.category || "wcag", issue.message, issue.url,
        issue.selector || null,
        issue.selectors?.length ? issue.selectors : null,
        issue.affectedElements?.length ? issue.affectedElements : null,
        issue.depths?.length ? issue.depths : null,
        issue.wcag?.length ? issue.wcag : null,
        issue.act?.length ? issue.act : null,
        issue.tags?.length ? issue.tags : null,
        issue.helpUrl || null,
        issue.htmlSnippet || null,
        issue.fixSuggestion || null,
        issue.evidenceScreenshot || null,
        issue.evidenceExplanation || null,
        issue.componentId || null,
        issue.componentOwner || null,
        issue.sourceHint || null,
        issue.state || "assisted",
        issue.phase || "assisted"
    ]);
    return result.rows[0];
}
async function insertTestCase(scanId, issue) {
    await db_1.db.query(`INSERT INTO test_cases (scan_id, issue_id, name, description, category, wcag_ref, status, steps, result)
     VALUES ($1,NULL,$2,$3,$4,$5,'fail',$6,$7)`, [
        scanId,
        `Assisted check: ${issue.message}`.slice(0, 180),
        `Issue captured during browser-assisted scan state "${issue.state || "assisted"}".`,
        issue.category || "wcag",
        (issue.wcag || []).join(", ") || "Assisted browser scan",
        JSON.stringify([
            `Open ${issue.url}`,
            `Reproduce state: ${issue.state || "assisted"}`,
            `Inspect selector: ${issue.selector || "see evidence"}`,
            "Verify the issue and apply the recommended fix."
        ]),
        issue.fixSuggestion || "Resolve the reported accessibility issue."
    ]);
}
async function refreshScanTotals(scanId, latestUrl) {
    const issues = await db_1.db.query("SELECT severity FROM issues WHERE scan_id = $1 AND false_positive = 0", [scanId]);
    const counts = issues.rows.reduce((acc, row) => {
        acc[row.severity] = (acc[row.severity] || 0) + 1;
        return acc;
    }, {});
    const impact = issues.rows.reduce((sum, row) => sum + (severityWeight[row.severity] || 1), 0);
    const score = Math.max(0, Math.min(100, Math.round(100 / (1 + impact / 40))));
    const scanResult = await db_1.db.query("SELECT navigated_urls FROM scans WHERE id = $1", [scanId]);
    const navigated = Array.isArray(scanResult.rows[0]?.navigated_urls) ? scanResult.rows[0].navigated_urls : [];
    const nextNavigated = latestUrl && !navigated.includes(latestUrl) ? [...navigated, latestUrl] : navigated;
    await db_1.db.query(`UPDATE scans SET progress = CASE WHEN status = 'running' THEN 75 ELSE progress END,
      total_issues = $2, critical_count = $3, serious_count = $4,
      moderate_count = $5, minor_count = $6, score = $7, navigated_urls = $8
     WHERE id = $1`, [
        scanId,
        issues.rows.length,
        counts.critical || 0,
        counts.serious || 0,
        counts.moderate || 0,
        counts.minor || 0,
        score,
        nextNavigated
    ]);
}
