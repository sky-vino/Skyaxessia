/**
 * axeScan.ts
 * WCAG scanning using axe-core via Playwright.
 * Covers: WCAG 2.0/2.1/2.2 A, AA, AAA + best-practice rules.
 */

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";
import type { ScanIssue, Severity } from "./types";
import { logger } from "../utils/logger";

const IMPACT_PRIORITY: Record<string, number> = {
  critical: 1, serious: 2, moderate: 3, minor: 4
};

export async function runAxe(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  try {
    const results = await new AxeBuilder({ page: page as any })
      .withTags([
        "wcag2a", "wcag2aa", "wcag2aaa",
        "wcag21a", "wcag21aa", "wcag21aaa",
        "wcag22a", "wcag22aa", "wcag22aaa",
        "best-practice"
      ])
      .analyze();

    return results.violations.flatMap(v =>
      v.nodes.map(n => {
        const sel = typeof n.target?.[0] === "string" ? n.target[0] : "";
        const impact = (v.impact ?? "moderate") as Severity;
        return {
          ruleId:       `axe:${v.id}`,
          severity:     impact,
          priority:     IMPACT_PRIORITY[impact] ?? 3,
          category:     deriveCategory(v.tags || []),
          message:      v.help ?? v.description ?? v.id,
          url,
          selector:     sel,
          selectors:    sel ? [sel] : [],
          depths:       sel ? [0] : [],
          wcag:         v.tags?.filter((t: string) => t.startsWith("wcag")) ?? [],
          act:          (v as any).actIds,
          tags:         v.tags,
          helpUrl:      v.helpUrl,
          htmlSnippet:  n.html,
          fixSuggestion: n.failureSummary ?? undefined,
          state,
          phase,
        } as ScanIssue;
      })
    );
  } catch (err) {
    logger.warn(`axe scan failed on ${url}:`, err);
    return [];
  }
}

function deriveCategory(tags: string[]): string {
  if (tags.some(t => t.includes("color") || t.includes("contrast"))) return "contrast";
  if (tags.some(t => t.includes("keyboard") || t.includes("focus")))  return "keyboard";
  if (tags.some(t => t.includes("aria")))                              return "aria";
  if (tags.some(t => t.includes("form") || t.includes("label")))      return "forms";
  if (tags.some(t => t.includes("image") || t.includes("text-alt")))  return "images";
  if (tags.some(t => t.includes("structure") || t.includes("landmark"))) return "structure";
  if (tags.some(t => t.includes("timing")))                            return "timing";
  return "wcag";
}
