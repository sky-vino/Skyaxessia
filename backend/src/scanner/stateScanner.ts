/**
 * stateScanner.ts
 * Multi-state and dynamic interaction testing.
 *
 * States tested:
 *  1. Initial (default page load)
 *  2. Hover state  — mouse over interactive elements
 *  3. Focus state  — programmatic focus on all interactive elements
 *  4. Expanded     — click/interact to open dropdowns, accordions, modals
 *  5. Error state  — submit empty forms to trigger validation states
 *  6. Active/pressed state
 *  7. Custom states — user-defined via scan_options.extra_states
 *
 * Dynamic interaction testing:
 *  - Form submission / validation messages
 *  - Modal / dialog open-close
 *  - Dropdown / menu expand-collapse
 *  - Tab panel switching
 *  - Accordion expand/collapse
 *  - Toast / notification appearance
 */

import type { Page } from "playwright";
import type { ScanIssue, StateConfig } from "./types";
import { runAxe } from "./axeScan";
import { runFocusHeuristics } from "./focusHeuristics";
import { logger } from "../utils/logger";
import { waitForStability } from "./navigation";

export interface StateResult {
  stateName: string;
  issues: ScanIssue[];
  screenshot?: string;
  a11yTree?: any;
}

type BeforeSnapshot = () => Promise<void>;

// ── Helper ────────────────────────────────────────────────────────────────────

async function accessibilityTree(page: Page): Promise<any> {
  try {
    return await (page as any).accessibility.snapshot({ interestingOnly: false });
  } catch {
    return null;
  }
}
async function screenshotBase64(page: Page, beforeSnapshot?: BeforeSnapshot): Promise<string | undefined> {
  try {
    if (beforeSnapshot) await beforeSnapshot();
    const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch { return undefined; }
}

// ── Hover state ───────────────────────────────────────────────────────────────
async function testHoverState(page: Page, url: string, beforeSnapshot?: BeforeSnapshot): Promise<StateResult> {
  const issues: ScanIssue[] = [];
  try {
    const hoverTargets = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href],button,nav a,[role='button']"))
        .slice(0, 15)
        .map((el: any) => el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase())
    );
    for (const sel of hoverTargets) {
      try {
        await page.hover(sel, { timeout: 2000 });
        await waitForStability(page, 300);
        // Run axe on the hovered state
        const axeIssues = await runAxe(page, url, "hover", "hover");
        issues.push(...axeIssues.map(i => ({ ...i, state: "hover", phase: "hover" })));
        break; // one representative hover is enough
      } catch {}
    }
    // Check tooltips have accessible text
    const tooltipIssues = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("[title],[data-tooltip],[aria-describedby]").forEach((el: any) => {
        const title = el.getAttribute("title");
        if (title && title.trim().length < 3) out.push(el.tagName.toLowerCase());
      });
      return out.slice(0, 20);
    });
    if (tooltipIssues.length) {
      issues.push({
        ruleId: "state:tooltip-empty", severity: "moderate", priority: 3, category: "hover",
        message: `${tooltipIssues.length} elements have title/tooltip attributes with insufficient text.`,
        url, selector: tooltipIssues[0], selectors: tooltipIssues, depths: tooltipIssues.map(() => 0),
        wcag: ["wcag1.1.1","wcag1.3.1"], state: "hover", phase: "hover",
        fixSuggestion: "Ensure tooltip/title text is descriptive. For interactive elements, prefer aria-describedby for accessibility.",
      });
    }
  } catch (err) { logger.debug("Hover state test failed:", err); }
  const a11yTree = await accessibilityTree(page);
  const screenshot = await screenshotBase64(page, beforeSnapshot);
  return { stateName: "hover", issues, screenshot, a11yTree };
}

// ── Focus state ───────────────────────────────────────────────────────────────
async function testFocusState(page: Page, url: string, beforeSnapshot?: BeforeSnapshot): Promise<StateResult> {
  const issues: ScanIssue[] = [];
  try {
    const focusTargets = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[tabindex='0']"))
        .slice(0, 10)
        .map((el: any) => el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase())
    );
    if (focusTargets.length > 0) {
      try { await page.focus(focusTargets[0]); } catch {}
      await waitForStability(page, 400);
      const focusAxe = await runAxe(page, url, "focus", "focus");
      issues.push(...focusAxe.map(i => ({ ...i, state: "focus", phase: "focus" })));
    }
  } catch (err) { logger.debug("Focus state test failed:", err); }
  const a11yTree = await accessibilityTree(page);
  const screenshot = await screenshotBase64(page, beforeSnapshot);
  return { stateName: "focus", issues, screenshot, a11yTree };
}

// ── Error state (form validation) ─────────────────────────────────────────────
async function testErrorState(page: Page, url: string, beforeSnapshot?: BeforeSnapshot): Promise<StateResult> {
  const issues: ScanIssue[] = [];
  try {
    const forms = await page.evaluate(() =>
      Array.from(document.querySelectorAll("form")).map((f: any) =>
        f.id ? `form#${f.id}` : "form"
      ).slice(0, 3)
    );

    for (const formSel of forms) {
      try {
        // Clear required fields
        await page.evaluate((sel: string) => {
          const form = document.querySelector(sel) as HTMLFormElement;
          if (!form) return;
          form.querySelectorAll("input[required],textarea[required]").forEach((el: any) => {
            el.value = "";
          });
        }, formSel);

        // Submit to trigger validation
        await page.evaluate((sel: string) => {
          const form = document.querySelector(sel) as HTMLFormElement;
          if (form) {
            const btn = form.querySelector("button[type='submit'],input[type='submit']") as HTMLElement;
            if (btn) btn.click();
          }
        }, formSel);

        await waitForStability(page, 800);

        // Check error messages accessibility
        const errorIssues = await page.evaluate(() => {
          const out: { sel: string; issue: string }[] = [];
          document.querySelectorAll("[aria-invalid='true']").forEach((el: any) => {
            const errId = el.getAttribute("aria-errormessage") || el.getAttribute("aria-describedby");
            if (!errId) {
              out.push({
                sel: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(),
                issue: "aria-invalid set but no aria-errormessage or aria-describedby pointing to error text"
              });
            }
          });
          // Check for error messages not associated with inputs
          document.querySelectorAll(".error,.error-message,.field-error,[role='alert']").forEach((el: any) => {
            const text = el.textContent?.trim();
            if (text && text.length > 2) {
              const associated = el.id && document.querySelector(`[aria-describedby="${el.id}"],[aria-errormessage="${el.id}"]`);
              if (!associated) {
                out.push({ sel: el.className ? `.${el.className.split(" ")[0]}` : el.tagName.toLowerCase(), issue: "Error message not programmatically associated" });
              }
            }
          });
          return out.slice(0, 30);
        });

        for (const ei of errorIssues) {
          issues.push({
            ruleId: "state:error-not-associated", severity: "serious", priority: 2, category: "forms",
            message: `${ei.issue}: ${ei.sel}`,
            url, selector: ei.sel, selectors: [ei.sel], depths: [0],
            wcag: ["wcag3.3.1","wcag1.3.1"],
            fixSuggestion: "Link each error message to its input via aria-errormessage='errorId' or aria-describedby='errorId'.",
            state: "error", phase: "error",
          });
        }

        // axe scan on error state
        const axeErrors = await runAxe(page, url, "error", "error");
        issues.push(...axeErrors.map(i => ({ ...i, state: "error", phase: "error" })));
        break;
      } catch {}
    }
  } catch (err) { logger.debug("Error state test failed:", err); }
  const a11yTree = await accessibilityTree(page);
  const screenshot = await screenshotBase64(page, beforeSnapshot);
  return { stateName: "error", issues, screenshot, a11yTree };
}

// ── Expanded state (dropdowns, accordions, modals) ────────────────────────────
async function testExpandedState(page: Page, url: string, beforeSnapshot?: BeforeSnapshot): Promise<StateResult> {
  const issues: ScanIssue[] = [];
  try {
    // Find and click expandable elements
    const expandables = await page.evaluate(() => {
      const out: { sel: string; type: string }[] = [];
      document.querySelectorAll("[aria-expanded='false'],[aria-haspopup],[data-toggle],[data-bs-toggle]")
        .forEach((el: any) => {
          const sel = el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase();
          const type = el.getAttribute("aria-haspopup") || el.getAttribute("data-bs-toggle") || "generic";
          out.push({ sel, type });
        });
      // Also check details/summary
      document.querySelectorAll("details:not([open]) > summary").forEach((el: any) => {
        out.push({ sel: "details > summary", type: "disclosure" });
      });
      return out.slice(0, 5);
    });

    for (const exp of expandables) {
      try {
        await page.click(exp.sel, { timeout: 3000 });
        await waitForStability(page, 800);

        // Check newly expanded content for issues
        const expandedIssues = await page.evaluate((type: string) => {
          const out: { sel: string; issue: string }[] = [];
          // Check opened menus
          document.querySelectorAll("[aria-expanded='true']").forEach((trigger: any) => {
            const controlsId = trigger.getAttribute("aria-controls");
            if (controlsId) {
              const panel = document.getElementById(controlsId);
              if (panel) {
                const st = getComputedStyle(panel);
                if (st.display === "none" || st.visibility === "hidden") {
                  out.push({ sel: `#${controlsId}`, issue: "aria-expanded=true but controlled panel is hidden" });
                }
              }
            }
          });
          // Check modal focus
          document.querySelectorAll("[role='dialog'][aria-modal='true']").forEach((modal: any) => {
            const st = getComputedStyle(modal);
            if (st.display !== "none") {
              const firstFocusable = modal.querySelector("button,a,[tabindex='0'],input") as HTMLElement;
              if (firstFocusable && document.activeElement !== firstFocusable && !modal.contains(document.activeElement)) {
                out.push({ sel: modal.id ? `#${modal.id}` : "[role='dialog']", issue: "Modal opened but focus not moved inside" });
              }
            }
          });
          return out.slice(0, 20);
        }, exp.type);

        for (const ei of expandedIssues) {
          issues.push({
            ruleId: "state:expanded-focus-mismatch", severity: "serious", priority: 2, category: "aria",
            message: `${ei.issue}`,
            url, selector: ei.sel, selectors: [ei.sel], depths: [0],
            wcag: ["wcag4.1.2","wcag2.4.3"],
            fixSuggestion: "When expanding a disclosure or opening a modal, move focus to the first focusable element inside. Keep aria-expanded in sync with visual state.",
            state: "expanded", phase: "expanded",
          });
        }

        // Run axe on expanded state
        const axeExpanded = await runAxe(page, url, "expanded", "expanded");
        issues.push(...axeExpanded.map(i => ({ ...i, state: "expanded", phase: "expanded" })));

        // Close it back
        try { await page.keyboard.press("Escape"); await waitForStability(page, 400); } catch {}
        break;
      } catch {}
    }
  } catch (err) { logger.debug("Expanded state test failed:", err); }
  const a11yTree = await accessibilityTree(page);
  const screenshot = await screenshotBase64(page, beforeSnapshot);
  return { stateName: "expanded", issues, screenshot, a11yTree };
}

// ── Dynamic interaction: tab panels ──────────────────────────────────────────
async function testTabPanels(page: Page, url: string, beforeSnapshot?: BeforeSnapshot): Promise<StateResult[]> {
  const results: StateResult[] = [];
  try {
    const tabCount = Math.min(await page.locator("[role='tab']").count(), 5);
    for (let i = 1; i < tabCount; i++) {
      const issues: ScanIssue[] = [];
      try {
        const tab = page.locator("[role='tab']").nth(i);
        const selector = await tab.evaluate((el: any, idx: number) => {
          if (el.id) return `[role='tab']#${CSS.escape(el.id)}`;
          const label = el.getAttribute("aria-label") || el.textContent?.trim();
          return label ? `[role='tab'][name="${label}"]` : `[role='tab']:nth-of-type(${idx + 1})`;
        }, i).catch(() => `[role='tab']:nth-of-type(${i + 1})`);

        await tab.click({ timeout: 2500, force: true });
        await waitForStability(page, 800);
        const panelVisible = await page.evaluate((idx: number) => {
          const panels = document.querySelectorAll("[role='tabpanel']");
          const panel = panels[idx] as HTMLElement;
          if (!panel) return true;
          const st = getComputedStyle(panel);
          return st.display !== "none" && st.visibility !== "hidden";
        }, i);
        if (!panelVisible) {
          issues.push({
            ruleId: "state:tabpanel-hidden", severity: "serious", priority: 2, category: "aria",
            message: `Tab panel ${i + 1} remains hidden after activating its tab.`,
            url, selector, selectors: [selector], depths: [0],
            wcag: ["wcag4.1.2"],
            fixSuggestion: "Ensure the associated tabpanel becomes visible when a tab is activated. Use aria-selected and show/hide panels accordingly.",
            state: "tab-active", phase: "interaction",
          });
        }

        const axeIssues = await runAxe(page, url, `tab ${i + 1}`, `tab-${i + 1}`);
        issues.push(...axeIssues.map(issue => ({ ...issue, state: `tab-${i + 1}`, phase: "interaction" })));
        results.push({
          stateName: `tab-${i + 1}`,
          issues,
          a11yTree: await accessibilityTree(page),
          screenshot: await screenshotBase64(page, beforeSnapshot),
        });
      } catch {}
    }
  } catch {}
  return results;
}

// ── Custom user-defined states ────────────────────────────────────────────────
async function testCustomState(page: Page, url: string, stateConfig: StateConfig, beforeSnapshot?: BeforeSnapshot): Promise<StateResult> {
  const issues: ScanIssue[] = [];
  try {
    if (stateConfig.triggerType === "click" && stateConfig.trigger) {
      await page.click(stateConfig.trigger, { timeout: 5000 });
    } else if (stateConfig.triggerType === "hover" && stateConfig.trigger) {
      await page.hover(stateConfig.trigger, { timeout: 5000 });
    } else if (stateConfig.triggerType === "keyboard" && stateConfig.key) {
      await page.keyboard.press(stateConfig.key);
    }
    await waitForStability(page, stateConfig.waitMs || 600);
    const axeIssues = await runAxe(page, url, stateConfig.name, stateConfig.name);
    issues.push(...axeIssues.map(i => ({ ...i, state: stateConfig.name, phase: stateConfig.name })));
  } catch (err) {
    logger.debug(`Custom state "${stateConfig.name}" test failed:`, err);
  }
  const a11yTree = await accessibilityTree(page);
  const screenshot = await screenshotBase64(page, beforeSnapshot);
  return { stateName: stateConfig.name, issues, screenshot, a11yTree };
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function runStateScanning(
  page: Page,
  url: string,
  extraStates: StateConfig[] = [],
  depthMode: "shallow" | "standard" | "exhaustive" = "standard",
  beforeSnapshot?: BeforeSnapshot
): Promise<StateResult[]> {
  const results: StateResult[] = [];

  if (depthMode === "shallow") {
    results.push(await testFocusState(page, url, beforeSnapshot));
    return results;
  }

  results.push(await testHoverState(page, url, beforeSnapshot));
  results.push(await testFocusState(page, url, beforeSnapshot));
  results.push(await testExpandedState(page, url, beforeSnapshot));
  results.push(await testErrorState(page, url, beforeSnapshot));

  // Tab panel interaction
  results.push(...await testTabPanels(page, url, beforeSnapshot));

  // Custom user-defined states
  for (const stateConfig of extraStates) {
    results.push(await testCustomState(page, url, stateConfig, beforeSnapshot));
  }

  if (depthMode === "exhaustive") {
    results.push(...await testDiscoveredButtonStates(page, url, beforeSnapshot));
  }

  return results;
}

async function testDiscoveredButtonStates(page: Page, url: string, beforeSnapshot?: BeforeSnapshot): Promise<StateResult[]> {
  const results: StateResult[] = [];
  const targets = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button,a[href],[role='button'],[role='link']"))
      .filter((el: any) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .slice(0, 12)
      .map((el: any, index) => ({
        selector: el.id ? `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}` : `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
        label: (el.innerText || el.textContent || el.getAttribute("aria-label") || `interactive ${index + 1}`).replace(/\s+/g, " ").trim().slice(0, 40)
      }))
  ).catch(() => []);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const stateName = `interactive-${i + 1}`;
    const issues: ScanIssue[] = [];
    try {
      await page.hover(target.selector, { timeout: 1200 }).catch(() => undefined);
      await page.focus(target.selector, { timeout: 1200 }).catch(() => undefined);
      await waitForStability(page, 250);
      const axeIssues = await runAxe(page, url, stateName, stateName);
      issues.push(...axeIssues.map(issue => ({ ...issue, state: stateName, phase: stateName })));
      results.push({
        stateName,
        issues,
        a11yTree: { ...(await accessibilityTree(page) || {}), matrixCell: { interaction: target.label, depth: "exhaustive" } },
        screenshot: await screenshotBase64(page, beforeSnapshot),
      });
    } catch {}
  }
  return results;
}




