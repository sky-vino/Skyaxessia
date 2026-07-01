/**
 * navigation.ts
 * Safe, retry-based navigation for Playwright.
 * Retries with progressively weaker waitUntil signals.
 */

import type { Page } from "playwright";
import { logger } from "../utils/logger";

export async function navigateSafely(page: Page, url: string): Promise<boolean> {
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);

  for (const waitUntil of ["domcontentloaded", "load", "commit"] as const) {
    try {
      await page.goto(url, { waitUntil, timeout: 30000 });
      await page.waitForTimeout(800);
      return true;
    } catch (e) {
      logger.debug(`Navigation attempt (${waitUntil}) failed for ${url}`);
    }
  }

  logger.warn(`All navigation attempts failed for: ${url}`);
  return false;
}

/**
 * Wait for dynamic content to stabilize after interaction.
 */
export async function waitForStability(page: Page, ms = 600): Promise<void> {
  await page.waitForTimeout(ms);
}
