"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanQueue = void 0;
const db_1 = require("../utils/db");
const logger_1 = require("../utils/logger");
const wsManager_1 = require("../utils/wsManager");
const scanner_1 = require("../scanner/scanner");
const wcagRuleRegistryService_1 = require("./wcagRuleRegistryService");
class ScanQueue {
    constructor() {
        this.queue = [];
        this.running = false;
        this.maxConcurrent = 2;
        this.activeScans = 0;
    }
    init() {
        setInterval(() => this.processQueue(), 2000);
        logger_1.logger.info("Scan queue processor started");
    }
    async add(scanId) {
        this.queue.push({ scanId, addedAt: Date.now() });
        logger_1.logger.info(`Scan ${scanId} added to queue`);
        this.processQueue();
    }
    async processQueue() {
        while (this.activeScans < this.maxConcurrent && this.queue.length > 0) {
            const item = this.queue.shift();
            this.activeScans++;
            this.runScan(item.scanId).finally(() => {
                this.activeScans--;
                this.processQueue();
            });
        }
    }
    async runScan(scanId) {
        logger_1.logger.info(`Starting scan ${scanId}`);
        try {
            await db_1.db.query("UPDATE scans SET status = 'running', started_at = NOW(), progress = 0, navigated_urls = NULL WHERE id = $1", [scanId]);
            wsManager_1.wsManager.broadcast(scanId, { type: "scan:started", scanId });
            const scanResult = await db_1.db.query("SELECT * FROM scans WHERE id = $1", [scanId]);
            const scan = scanResult.rows[0];
            if (!scan)
                throw new Error("Scan not found");
            const scanner = new scanner_1.AccessibilityScanner(scan, (progress, message) => {
                db_1.db.query("UPDATE scans SET progress = $1 WHERE id = $2", [progress, scanId]);
                wsManager_1.wsManager.broadcast(scanId, { type: "scan:progress", scanId, progress, message });
            });
            const { issues, testCases, domSnapshots, navigatedUrls, score } = await scanner.run();
            const issueIdsByRuleUrl = new Map();
            const issueLinkKey = (ruleId, url) => `${ruleId}|${url}`;
            // Persist issues
            for (const issue of issues) {
                const governedMapping = await (0, wcagRuleRegistryService_1.resolveGovernedWcagMapping)(issue);
                const governedTags = Array.from(new Set([
                    ...(issue.tags || []),
                    `wcag-mapping:${governedMapping.mappingStatus}`
                ]));
                const insertedIssue = await db_1.db.query(`INSERT INTO issues (scan_id, rule_id, severity, priority, category, message, url,
            selector, selectors, affected_elements, depths, wcag_criteria, act_rules, tags, help_url, html_snippet,
            fix_suggestion, evidence_screenshot, evidence_explanation, component_id, component_owner, source_hint, state_label, phase, landmark_group_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`, [
                    scanId, issue.ruleId, issue.severity, issue.priority || 3,
                    issue.category || "wcag", issue.message, issue.url,
                    issue.selector || null,
                    issue.selectors?.length ? issue.selectors : null,
                    issue.affectedElements?.length ? issue.affectedElements : null,
                    issue.depths?.length ? issue.depths : null,
                    governedMapping.wcag.length ? governedMapping.wcag : null,
                    issue.act?.length ? issue.act : null,
                    governedTags.length ? governedTags : null,
                    issue.helpUrl || null,
                    issue.htmlSnippet || null,
                    issue.fixSuggestion || null,
                    issue.evidenceScreenshot || null,
                    issue.evidenceExplanation || null,
                    issue.componentId || null,
                    issue.componentOwner || null,
                    issue.sourceHint || null,
                    issue.state || "default",
                    issue.phase || "initial",
                    issue.landmark_group_key || null
                ]);
                const linkKey = issueLinkKey(issue.ruleId, issue.url);
                if (!issueIdsByRuleUrl.has(linkKey) && insertedIssue.rows[0]?.id) {
                    issueIdsByRuleUrl.set(linkKey, insertedIssue.rows[0].id);
                }
            }
            // Persist test cases
            for (const tc of testCases) {
                const linkedIssueId = tc.issueId || (tc.issueRuleId && tc.issueUrl ? issueIdsByRuleUrl.get(issueLinkKey(tc.issueRuleId, tc.issueUrl)) : null);
                await db_1.db.query(`INSERT INTO test_cases (scan_id, issue_id, name, description, category, wcag_ref, status, steps, result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [scanId, linkedIssueId || null, tc.name, tc.description, tc.category, tc.wcagRef, tc.status, JSON.stringify(tc.steps || []), tc.result]);
            }
            // Persist DOM snapshots
            for (const snap of domSnapshots) {
                await db_1.db.query("INSERT INTO dom_snapshots (scan_id, url, phase, a11y_tree, screenshot) VALUES ($1,$2,$3,$4,$5)", [scanId, snap.url, snap.phase, JSON.stringify(snap.a11yTree), snap.screenshot]);
            }
            // Counts
            const counts = issues.reduce((acc, i) => {
                acc[i.severity] = (acc[i.severity] || 0) + 1;
                return acc;
            }, {});
            await db_1.db.query(`UPDATE scans SET status = 'completed', completed_at = NOW(), progress = 100,
          total_issues = $2, critical_count = $3, serious_count = $4,
          moderate_count = $5, minor_count = $6, score = $7, navigated_urls = $8
         WHERE id = $1`, [scanId, issues.length,
                counts.critical || 0, counts.serious || 0,
                counts.moderate || 0, counts.minor || 0,
                score,
                navigatedUrls
            ]);
            wsManager_1.wsManager.broadcast(scanId, { type: "scan:completed", scanId, totalIssues: issues.length, score, navigatedUrls, message: `SUCCESS: Scan completed with ${issues.length} issues and score ${score}` });
            logger_1.logger.info(`Scan ${scanId} completed with ${issues.length} issues; navigated through ${navigatedUrls.length} URL${navigatedUrls.length === 1 ? "" : "s"}`);
        }
        catch (err) {
            logger_1.logger.error(`Scan ${scanId} failed:`, err);
            await db_1.db.query("UPDATE scans SET status = 'failed', completed_at = NOW(), error_message = $2 WHERE id = $1", [scanId, err.message]);
            wsManager_1.wsManager.broadcast(scanId, { type: "scan:failed", scanId, error: err.message });
        }
    }
}
exports.scanQueue = new ScanQueue();
