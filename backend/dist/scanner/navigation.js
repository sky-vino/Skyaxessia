"use strict";
/**
 * navigation.ts
 * Safe, retry-based navigation for Playwright.
 * Retries with progressively weaker waitUntil signals.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.navigateSafely = navigateSafely;
exports.waitForStability = waitForStability;
const logger_1 = require("../utils/logger");
async function navigateSafely(page, url) {
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    for (const waitUntil of ["domcontentloaded", "load", "commit"]) {
        try {
            await page.goto(url, { waitUntil, timeout: 30000 });
            await page.waitForTimeout(800);
            return true;
        }
        catch (e) {
            logger_1.logger.debug(`Navigation attempt (${waitUntil}) failed for ${url}`);
        }
    }
    logger_1.logger.warn(`All navigation attempts failed for: ${url}`);
    return false;
}
/**
 * Wait for dynamic content to stabilize after interaction.
 */
async function waitForStability(page, ms = 600) {
    await page.waitForTimeout(ms);
}
