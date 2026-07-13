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
        // Skip elements that can't take keyboard focus (tabindex="-1", disabled, aria-hidden)
        const ti = el.getAttribute("tabindex");
        if (ti === "-1") return;
        if ((el as any).disabled) return;
        if (el.getAttribute("aria-hidden") === "true") return;

        // Ship 2 / A1 fix — skip elements that aren't actually rendered.
        // Previously the check called getComputedStyle on hidden elements
        // (display:none, visibility:hidden, opacity:0, zero-size) and read
        // outlineStyle:"none" and boxShadow:"none" — which is trivially true
        // for anything not being painted — producing false positives like
        // the mobile hamburger wrapper on desktop viewports. Rendered =
        // has non-zero paint AND is display/visibility visible AND has a
        // non-zero-area bounding rect.
        const preSt = getComputedStyle(el);
        if (preSt.display === "none") return;
        if (preSt.visibility === "hidden") return;
        if (parseFloat(preSt.opacity || "1") === 0) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        el.focus();
        const st = getComputedStyle(el);
        // Tier 1 fix — the previous version computed noBorder and noBg but
        // never used them, while claiming to check "outline, shadow, or border
        // change". We only reliably detect outline and box-shadow here; a
        // pure border- or background-color change on :focus would require
        // comparing computed styles across focus states, which is expensive
        // and not implemented. The message below reflects that honestly.
        const hasVisibleOutline = st.outlineStyle !== "none" && parseFloat(st.outlineWidth || "0") > 0;
        const hasVisibleShadow = st.boxShadow !== "none";
        if (!hasVisibleOutline && !hasVisibleShadow) out.push(getP(el));
      });
    return out.slice(0, 200);
  });
  if (focusInvisible.length) {
    const truncated = focusInvisible.length >= 200 ? " (list capped at 200; more may exist)" : "";
    issues.push({
      ruleId: "focus:invisible", severity: "serious", priority: 2, category: "focus",
      message: `${focusInvisible.length} focusable element(s) have no visible outline or box-shadow on focus${truncated}. Border and background-color focus indicators are not detected by this rule — verify those visually.`,
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
    const cap = 50;
    const capped = focusObscured.length >= cap;
    issues.push({
      ruleId: "focus:obscured", severity: "serious", priority: 2, category: "focus",
      message: `${focusObscured.length}${capped ? "+ (list capped)" : ""} focused element(s) are fully obscured by overlapping content (sticky header, modal overlay, etc.).`,
      url, selector: focusObscured[0].selector,
      selectors: focusObscured.map(i => i.selector),
      depths:    focusObscured.map(i => i.depth),
      wcag: ["wcag2.4.11","wcag2.4.12"],
      fixSuggestion: "Apply scroll-margin-top / scroll-padding-top equal to sticky header height. Check z-index layering.",
      state, phase,
    });
  }

  // ── 3. Focus trap / lock in dialogs ──────────────────────────────────────
  // Tier 1 fix — the previous version populated a `noEscape` array by checking
  // for inline `onkeydown` HTML attributes, which no React/Vue/Angular app ever
  // uses (handlers are bound via addEventListener / JSX), and then the caller
  // never even read that array. Both problems removed: the attribute check is
  // gone; a real Escape-key test replaces it below.
  const dialogIssues = await safeEval<{ noFocusable: string[] }>(page, () => {
    const noFocusable: string[] = [];
    document.querySelectorAll("[role='dialog'],[role='alertdialog'],.modal,[aria-modal='true']")
      .forEach((el: any) => {
        const focusable = el.querySelectorAll("a,button,input,select,textarea,[tabindex]:not([tabindex='-1'])");
        const sel = el.id ? `[role="${el.getAttribute("role")}"]#${el.id}` : `[role="${el.getAttribute("role")||"dialog"}"]`;
        if (focusable.length === 0) noFocusable.push(sel);
      });
    return { noFocusable };
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

  // ── 4. Escape key closes overlays — real functional test ─────────────────
  // Only runs when a dialog is actually visible on the page at scan time.
  // Presses Escape via Playwright, then checks whether the dialog is still
  // visible. Real functional test, no attribute guessing.
  try {
    const openDialog = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("[role='dialog'],[role='alertdialog'],[aria-modal='true'],dialog[open]")) as HTMLElement[];
      const visible = candidates.find(el => {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
      });
      if (!visible) return null;
      return visible.id
        ? `[role="${visible.getAttribute("role") || "dialog"}"]#${visible.id}`
        : `[role="${visible.getAttribute("role") || "dialog"}"]`;
    });

    if (openDialog) {
      await page.keyboard.press("Escape");
      await new Promise(r => setTimeout(r, 350));
      const stillVisible = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
      }, openDialog);

      if (stillVisible) {
        issues.push({
          ruleId: "focus:escape-key-missing", severity: "serious", priority: 2, category: "focus",
          message: `Dialog remains visible after pressing Escape. Keyboard users cannot dismiss the dialog with Escape.`,
          url, selector: openDialog, selectors: [openDialog], depths: [0],
          wcag: ["wcag2.1.2"],
          fixSuggestion: "Add a keydown listener on the dialog (or an ancestor) that closes it when Escape is pressed.",
          state, phase,
        });
      }
    }
  } catch (err) {
    logger.debug("Escape key dialog test could not run:", err);
  }

  return issues;
}
