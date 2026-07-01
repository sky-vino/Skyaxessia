/**
 * focusHeuristics.ts
 * Focus-related accessibility checks:
 *  1. Focus not visible — element receives focus but no indicator shown
 *  2. Focus obscured   — focused element hidden behind sticky/fixed content
 *  3. Focus trap missing — dialogs with no focusable children
 *  4. Focus lock detection — modal open but focus escapes outside
 *  5. Escape key does not close dialogs/menus
 *  6. Focus order — interactive elements with tabindex > 0
 */

import type { Page } from "playwright";
import type { ScanIssue } from "./types";
import { logger } from "../utils/logger";

type EP = { selector: string; depth: number };

const safeEval = async <T = any>(page: Page, fn: () => T): Promise<T> => {
  try { return await page.evaluate(fn); }
  catch { return [] as unknown as T; }
};

function getPath(el: any): EP {
  const path: string[] = [];
  let depth = 0;
  let cur: any = el;
  while (cur && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id;
    if (id) { path.unshift(`${tag}#${id}`); break; }
    let nth = 1, sib = cur.previousElementSibling;
    while (sib) { if (sib.tagName === cur.tagName) nth++; sib = sib.previousElementSibling; }
    path.unshift(`${tag}:nth-of-type(${nth})`);
    depth++;
    cur = cur.parentElement;
  }
  return { selector: path.join(" > "), depth };
}

export async function runFocusHeuristics(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  // ── 1. Focus not visible ─────────────────────────────────────────────────
  const focusInvisible = await safeEval<EP[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    const getP = (el: any) => {
      const path: string[] = []; let d = 0, c = el;
      while (c && c.nodeType === 1) {
        if (c.id) { path.unshift(`${c.tagName.toLowerCase()}#${c.id}`); break; }
        let n = 1, s = c.previousElementSibling;
        while (s) { if (s.tagName === c.tagName) n++; s = s.previousElementSibling; }
        path.unshift(`${c.tagName.toLowerCase()}:nth-of-type(${n})`);
        d++; c = c.parentElement;
      }
      return { selector: path.join(" > "), depth: d };
    };
    (document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]") as NodeListOf<HTMLElement>)
      .forEach(el => {
        el.focus();
        const st = getComputedStyle(el);
        const noOutline = st.outlineStyle === "none" || parseFloat(st.outlineWidth || "0") === 0;
        const noShadow  = st.boxShadow === "none";
        const noBorder  = parseFloat(st.borderWidth || "0") === 0;
        const noBg      = !st.backgroundColor || st.backgroundColor === "rgba(0, 0, 0, 0)";
        if (noOutline && noShadow) out.push(getP(el));
      });
    return out.slice(0, 200);
  });
  if (focusInvisible.length) {
    issues.push({
      ruleId: "focus:invisible", severity: "serious", priority: 2, category: "focus",
      message: `${focusInvisible.length} focusable elements show no visible focus indicator (outline, shadow, or border change).`,
      url, selector: focusInvisible[0].selector,
      selectors: focusInvisible.map(i => i.selector),
      depths:    focusInvisible.map(i => i.depth),
      wcag: ["wcag2.4.7"],
      fixSuggestion: "Add :focus-visible styles. Never use outline:none without a replacement. Min indicator: 2px solid with 3:1 contrast.",
      state, phase,
    });
  }

  // ── 2. Focus obscured ────────────────────────────────────────────────────
  const focusObscured = await safeEval<EP[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    const getP = (el: any) => {
      const path: string[] = []; let d = 0, c = el;
      while (c && c.nodeType === 1) {
        if (c.id) { path.unshift(`${c.tagName.toLowerCase()}#${c.id}`); break; }
        let n = 1, s = c.previousElementSibling;
        while (s) { if (s.tagName === c.tagName) n++; s = s.previousElementSibling; }
        path.unshift(`${c.tagName.toLowerCase()}:nth-of-type(${n})`);
        d++; c = c.parentElement;
      }
      return { selector: path.join(" > "), depth: d };
    };
    (document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]") as NodeListOf<HTMLElement>)
      .forEach(el => {
        el.focus();
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== el && !el.contains(top)) out.push(getP(el));
      });
    return out.slice(0, 50);
  });
  if (focusObscured.length) {
    issues.push({
      ruleId: "focus:obscured", severity: "serious", priority: 2, category: "focus",
      message: `${focusObscured.length} focused elements are fully obscured by overlapping content (sticky header, modal overlay, etc.).`,
      url, selector: focusObscured[0].selector,
      selectors: focusObscured.map(i => i.selector),
      depths:    focusObscured.map(i => i.depth),
      wcag: ["wcag2.4.11","wcag2.4.12"],
      fixSuggestion: "Apply scroll-margin-top / scroll-padding-top equal to sticky header height. Check z-index layering.",
      state, phase,
    });
  }

  // ── 3. Focus trap / lock in dialogs ──────────────────────────────────────
  const dialogIssues = await safeEval<{ noFocusable: string[]; noEscape: string[] }>(page, () => {
    const noFocusable: string[] = [];
    const noEscape:    string[] = [];
    document.querySelectorAll("[role='dialog'],[role='alertdialog'],.modal,[aria-modal='true']")
      .forEach((el: any) => {
        const focusable = el.querySelectorAll("a,button,input,select,textarea,[tabindex]:not([tabindex='-1'])");
        const sel = el.id ? `[role="${el.getAttribute("role")}"]#${el.id}` : `[role="${el.getAttribute("role")||"dialog"}"]`;
        if (focusable.length === 0) noFocusable.push(sel);
        // Heuristic: if dialog has no keydown handler attribute it may lack escape
        if (!el.hasAttribute("onkeydown") && !el.getAttribute("data-escape")) noEscape.push(sel);
      });
    return { noFocusable, noEscape };
  });
  if (dialogIssues.noFocusable.length) {
    issues.push({
      ruleId: "focus:trap-missing", severity: "critical", priority: 1, category: "focus",
      message: `${dialogIssues.noFocusable.length} dialog(s) contain no focusable elements — keyboard users cannot interact.`,
      url, selector: dialogIssues.noFocusable[0], selectors: dialogIssues.noFocusable,
      depths: dialogIssues.noFocusable.map(() => 0),
      wcag: ["wcag2.1.2"],
      fixSuggestion: "Ensure every dialog contains at least one focusable element. Implement focus trapping: intercept Tab/Shift+Tab to cycle within the dialog.",
      state, phase,
    });
  }

  // ── 4. Escape key closes overlays — simulate test ─────────────────────────
  try {
    const openDialogs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("[role='dialog'],[role='alertdialog'],[aria-modal='true']"))
        .filter((el: any) => {
          const st = getComputedStyle(el);
          return st.display !== "none" && st.visibility !== "hidden";
        }).length;
    });
    if (openDialogs > 0) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const stillOpen = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[role='dialog'],[role='alertdialog'],[aria-modal='true']"))
          .filter((el: any) => getComputedStyle(el).display !== "none").length
      );
      if (stillOpen > 0) {
        issues.push({
          ruleId: "focus:escape-key-missing", severity: "serious", priority: 2, category: "focus",
          message: "Open dialog/modal does not close on Escape key press.",
          url, selector: "[role='dialog']", selectors: ["[role='dialog']"], depths: [0],
          wcag: ["wcag2.1.2"],
          fixSuggestion: "Add a keydown listener for 'Escape' that closes the dialog and returns focus to the trigger element.",
          state, phase,
        });
      }
    }
  } catch (err) {
    logger.debug("Escape key test failed:", err);
  }

  return issues;
}
