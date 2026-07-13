"use strict";
/**
 * axeScan.ts
 * WCAG scanning using axe-core via Playwright.
 * Covers: WCAG 2.0/2.1/2.2 A, AA, AAA + best-practice rules.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAxe = runAxe;
const playwright_1 = __importDefault(require("@axe-core/playwright"));
const logger_1 = require("../utils/logger");
const IMPACT_PRIORITY = {
    critical: 1, serious: 2, moderate: 3, minor: 4
};
async function runAxe(page, url, state, phase) {
    try {
        const results = await new playwright_1.default({ page: page })
            .withTags([
            "wcag2a", "wcag2aa", "wcag2aaa",
            "wcag21a", "wcag21aa", "wcag21aaa",
            "wcag22a", "wcag22aa", "wcag22aaa",
            "best-practice"
        ])
            .analyze();
        return results.violations.flatMap(v => v.nodes.map(n => {
            const sel = typeof n.target?.[0] === "string" ? n.target[0] : "";
            const impact = (v.impact ?? "moderate");
            return {
                ruleId: `axe:${v.id}`,
                severity: impact,
                priority: IMPACT_PRIORITY[impact] ?? 3,
                category: deriveCategory(v.tags || []),
                message: v.help ?? v.description ?? v.id,
                url,
                selector: sel,
                selectors: sel ? [sel] : [],
                depths: sel ? [0] : [],
                wcag: v.tags?.filter((t) => t.startsWith("wcag")) ?? [],
                act: v.actIds,
                tags: v.tags,
                helpUrl: v.helpUrl,
                htmlSnippet: n.html,
                fixSuggestion: n.failureSummary ?? undefined,
                state,
                phase,
            };
        }));
    }
    catch (err) {
        logger_1.logger.warn(`axe scan failed on ${url}:`, err);
        return [];
    }
}
function deriveCategory(tags) {
    if (tags.some(t => t.includes("color") || t.includes("contrast")))
        return "contrast";
    if (tags.some(t => t.includes("keyboard") || t.includes("focus")))
        return "keyboard";
    if (tags.some(t => t.includes("aria")))
        return "aria";
    if (tags.some(t => t.includes("form") || t.includes("label")))
        return "forms";
    if (tags.some(t => t.includes("image") || t.includes("text-alt")))
        return "images";
    if (tags.some(t => t.includes("structure") || t.includes("landmark")))
        return "structure";
    if (tags.some(t => t.includes("timing")))
        return "timing";
    return "wcag";
}
