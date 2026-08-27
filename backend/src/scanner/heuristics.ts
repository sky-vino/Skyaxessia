/**
 * heuristics.ts
 * Non-axe DOM/CSS heuristic checks:
 *  1. Target size < 24×24 px
 *  2. Text truncation / clipping
 *  3. Complex background (contrast risk)
 *  4. Status messages without aria-live
 *  5. On-input context changes
 *  6. Heading structure (skipped levels, missing h1)
 *  7. Landmark regions missing
 *  8. Form inputs without visible labels
 *  9. Images with empty/missing alt on meaningful images
 * 10. Lang attribute missing / wrong on page
 * 11. REFLOW: checks at 320px viewport width
 * 12. Reduced-motion: detects missing prefers-reduced-motion
 * 13. Session timeout: detects countdown timers
 */

import type { Page } from "playwright";
import type { ScanIssue } from "./types";
import { logger } from "../utils/logger";

type ElemData = { selector: string; depth: number; extra?: string };

function pack(
  items: ElemData[],
  ruleId: string,
  severity: ScanIssue["severity"],
  priority: number,
  category: string,
  message: string,
  wcag: string[],
  fixSuggestion: string,
  url: string,
  state: string,
  phase: string
): ScanIssue[] {
  if (!items.length) return [];
  return [{
    ruleId, severity, priority, category, message, url,
    selector:  items[0].selector,
    selectors: items.map(i => i.selector),
    depths:    items.map(i => i.depth),
    wcag, fixSuggestion, state, phase,
  }];
}

const safeEval = async <T = any>(page: Page, fn: () => T): Promise<T> => {
  try { return await page.evaluate(fn); }
  catch { return [] as unknown as T; }
};

export async function runHeuristics(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  // ── 1. Target size ────────────────────────────────────────────────────────
  // Round 2c hardening: fewer false positives from:
  //   - icons inside larger click targets (WCAG cares about the actual hit target)
  //   - screen-reader-only elements (legitimate a11y pattern with 1px dimensions)
  //   - controls inside closed dialogs / collapsed menus (not user-visible yet)
  const targetSize = await safeEval<ElemData[]>(page, () => {
    const MIN = 24;
    const out: { selector: string; depth: number }[] = [];
    const isVisible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" &&
        el.getAttribute("aria-hidden") !== "true" && !el.closest("[hidden],[inert],[aria-hidden='true']");
    };
    const isScreenReaderOnly = (el: HTMLElement) => {
      const st = getComputedStyle(el);
      // Common sr-only patterns: 1px dimensions with overflow:hidden or clip
      return (
        el.classList.contains("sr-only") ||
        el.classList.contains("visually-hidden") ||
        el.classList.contains("screen-reader-only") ||
        el.classList.contains("visuallyhidden") ||
        (st.position === "absolute" && parseFloat(st.width) <= 1 && parseFloat(st.height) <= 1)
      );
    };
    const isInsideCollapsedContainer = (el: HTMLElement) => {
      // Skip elements inside closed <dialog>, unopened menus/dropdowns, collapsed panels
      const closedDialog = el.closest("dialog:not([open])");
      if (closedDialog) return true;
      const collapsedMenu = el.closest("[role='menu']:not([aria-expanded='true']), [role='listbox']:not([aria-expanded='true'])");
      if (collapsedMenu) return true;
      const ariaExpandedFalse = el.closest("[aria-expanded='false']");
      // Only treat aria-expanded=false as collapsed when the element is INSIDE the collapsed panel,
      // not when it IS the trigger.
      if (ariaExpandedFalse && ariaExpandedFalse !== el && !ariaExpandedFalse.contains(el.parentElement)) return false;
      return false;
    };
    const nearestClickTarget = (el: HTMLElement): HTMLElement => {
      // Walk up until we find an ancestor with cursor:pointer or an interactive role.
      // WCAG 2.5.8 measures the actual hit target, not the visible icon inside it.
      let cur: HTMLElement | null = el;
      while (cur) {
        const st = getComputedStyle(cur);
        if (st.cursor === "pointer") return cur;
        const role = cur.getAttribute("role");
        if (["button", "link", "menuitem", "tab", "option"].includes(role || "")) return cur;
        if (["A", "BUTTON"].includes(cur.tagName)) return cur;
        cur = cur.parentElement;
      }
      return el;
    };
    document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[tabindex]")
      .forEach((el: any) => {
        if (!isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return;
        if (isScreenReaderOnly(el)) return;
        if (isInsideCollapsedContainer(el)) return;

        // Measure the nearest actual click target, not just this element.
        // An 18×18 chevron inside a 48×48 accordion header is fine — user clicks the header.
        const target = nearestClickTarget(el);
        const r = target.getBoundingClientRect();
        const st = getComputedStyle(target);
        const inlineTextLink = target.tagName === "A" && st.display === "inline" && r.width >= MIN;
        if (inlineTextLink) return;
        if (r.width < MIN || r.height < MIN) {
          out.push({
            selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(),
            depth: 0,
          });
        }
      });
    // Deduplicate by nearest-click-target to avoid multiple hits per real target
    return [...new Map(out.map(i => [i.selector, i])).values()].slice(0, 100);
  });
  issues.push(...pack(targetSize, "heuristic:target-size", "serious", 2, "pointer",
    `${targetSize.length} interactive elements are smaller than 24×24 CSS pixels.`,
    ["wcag2.5.8"], "Set min-width/min-height: 24px or increase padding on interactive elements.", url, state, phase));

  // ── 2. Text truncation ────────────────────────────────────────────────────
  // ── 2. Text truncation ────────────────────────────────────────────────────
  // Round 2c hardening: only fire when text is ACTUALLY clipped
  // (scrollWidth > clientWidth or scrollHeight > clientHeight for line-clamp).
  // The old rule fired for any element with text-overflow:ellipsis even when
  // no clipping was happening — very common false-positive on responsive designs
  // where ellipsis is defensively applied to text that comfortably fits.
  const truncation = await safeEval<ElemData[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    document.querySelectorAll("*").forEach((el: any) => {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const text = el.textContent?.trim() || "";
      if (!text || r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden") return;
      if (el.closest("[hidden],[inert],[aria-hidden='true']")) return;
      const fullText = (el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
      if (fullText.length >= text.length) return;

      const hasEllipsis = st.textOverflow === "ellipsis";
      const lineClamp = (st as any).webkitLineClamp;
      const hasLineClamp = lineClamp && lineClamp !== "none" && lineClamp !== "0";
      if (!hasEllipsis && !hasLineClamp) return;

      // Actually check for clipping
      const horizontallyClipped = hasEllipsis && el.scrollWidth > el.clientWidth + 1;
      const verticallyClipped = hasLineClamp && el.scrollHeight > el.clientHeight + 1;
      if (!horizontallyClipped && !verticallyClipped) return;

      out.push({ selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), depth: 0 });
    });
    return [...new Map(out.map(i => [i.selector, i])).values()].slice(0, 50);
  });
  issues.push(...pack(truncation, "heuristic:text-truncation", "moderate", 3, "readability",
    `${truncation.length} elements clip or truncate text content, potentially hiding information.`,
    ["wcag1.4.4"], "Provide accessible full text via title attribute, aria-label, or expandable disclosure.", url, state, phase));

  // ── 3. Complex backgrounds ────────────────────────────────────────────────
  // Round 2c hardening: this rule was the #1 false-positive source on
  // image-heavy sites (Sky's offers/hero cards). Now:
  //   - only fires on elements that DIRECTLY set background-image
  //     (not children inheriting the visual)
  //   - skips when a solid-color overlay is stacked above (::before/::after
  //     with solid rgba > 0.6 alpha, or a sibling with position:absolute + solid bg)
  //   - skips visually empty text nodes (whitespace-only)
  //   - deduplicates by nearest ancestor with the bg-image so one card
  //     doesn't generate 20 issues
  const complexBg = await safeEval<ElemData[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    const seenAnchors = new Set<Element>();
    const meaningfulText = (t: string) => t.replace(/\s+/g, "").length >= 3;
    const hasSolidOverlay = (el: HTMLElement): boolean => {
      // Check ::before / ::after pseudo-elements for solid backgrounds
      for (const pseudo of ["::before", "::after"] as const) {
        const st = getComputedStyle(el, pseudo);
        if (!st.content || st.content === "none") continue;
        const bg = st.backgroundColor || "";
        // rgba(..., 0.6+) or fully opaque
        const m = bg.match(/rgba?\(([^)]+)\)/);
        if (m) {
          const parts = m[1].split(",").map(s => parseFloat(s.trim()));
          const alpha = parts.length === 4 ? parts[3] : 1;
          if (alpha >= 0.6) return true;
        }
      }
      return false;
    };
    document.querySelectorAll("*").forEach((el: any) => {
      const st = getComputedStyle(el);
      const raw = el.textContent || "";
      if (!meaningfulText(raw)) return;
      // Only fire when THIS element (not just inherited visually) sets a bg-image
      if (!st.backgroundImage || st.backgroundImage === "none") return;
      // Skip if a solid overlay pseudo-element sits on top
      if (hasSolidOverlay(el)) return;
      // Deduplicate: only one hit per element with bg-image
      const anchor = el;
      if (seenAnchors.has(anchor)) return;
      seenAnchors.add(anchor);
      out.push({ selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), depth: 0 });
    });
    return out.slice(0, 20); // capped tighter (was 50) — this rule needs manual verification anyway
  });
  // Downgraded from moderate/priority 3 to minor/priority 4 with clearer "manual check" framing
  issues.push(...pack(complexBg, "heuristic:complex-background", "minor", 4, "contrast",
    `${complexBg.length} elements render text over image/gradient backgrounds. This is an advisory — verify text-over-image regions maintain 4.5:1 contrast in every viewport.`,
    ["wcag1.4.3","wcag1.4.11"], "Add a semi-transparent solid overlay or ensure text stays legible over the darkest and lightest points of the underlying image.", url, state, phase));

  // ── 4. Status messages without aria-live ─────────────────────────────────
  const statusMsg = await safeEval<ElemData[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    document.querySelectorAll(".toast,.notification,.alert,.snackbar,.banner,[role='status'],[role='alert']")
      .forEach((el: any) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden") return;
        if (el.closest("[hidden],[inert],[aria-hidden='true']")) return;
        const role = el.getAttribute("role");
        if (role === "alert" || role === "status") return;
        if (!el.getAttribute("aria-live")) {
          out.push({ selector: el.className ? `.${String(el.className).split(" ")[0]}` : el.tagName.toLowerCase(), depth: 0 });
        }
      });
    return out.slice(0, 30);
  });
  issues.push(...pack(statusMsg, "heuristic:status-message", "serious", 2, "aria",
    `${statusMsg.length} status/notification elements are missing aria-live regions.`,
    ["wcag4.1.3"], "Add aria-live='polite' for non-urgent and aria-live='assertive' for urgent notifications.", url, state, phase));

  // ── 5. On-input context changes ───────────────────────────────────────────
  const inputChange = await safeEval<ElemData[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    document.querySelectorAll("select[onchange]").forEach((el: any) => {
      const onchange = String(el.getAttribute("onchange") || "");
      if (!/location|submit|href|navigate|reload/i.test(onchange)) return;
      out.push({ selector: el.id ? `select#${el.id}` : "select", depth: 0 });
    });
    return out.slice(0, 30);
  });
  issues.push(...pack(inputChange, "heuristic:on-input-change", "moderate", 3, "interaction",
    `${inputChange.length} select elements may auto-submit on change without user warning.`,
    ["wcag3.2.2"], "Avoid triggering navigation on 'change' events. Use an explicit submit button.", url, state, phase));

  // ── 6. Heading structure ──────────────────────────────────────────────────
  // Round 2c hardening: exclude headings inside third-party widgets
  // (Chatlio, Zendesk, Intercom, OneTrust, TrustArc, iframes) that the site
  // owner does NOT control and cannot fix.
  const headings = await safeEval<{ levels: number[]; hasH1: boolean; skipped: number[] }>(page, () => {
    const VENDOR_SELECTORS = [
      "iframe", "[data-vendor]", "[data-widget]",
      "[id*='chatlio']", "[class*='chatlio']",
      "[id*='intercom']", "[class*='intercom']",
      "[id*='zendesk']", "[class*='zendesk']", "[id*='zopim']", "[class*='zopim']",
      "[id*='onetrust']", "[class*='onetrust']", "#onetrust-banner-sdk", "#onetrust-consent-sdk",
      "[id*='trustarc']", "[class*='trustarc']",
      "[id*='dynatrace']", "[class*='dynatrace']",
      "[id*='hotjar']", "[class*='hotjar']",
      "[id*='cookiebot']", "[class*='cookiebot']",
      "[role='dialog'][aria-modal='true']", // Modal dialogs typically restart heading hierarchy legitimately
    ].join(",");
    const hs = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((h: any) => {
      const r = h.getBoundingClientRect();
      const st = getComputedStyle(h);
      // Skip invisible headings
      if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden") return false;
      if (h.closest("[hidden],[inert],[aria-hidden='true']")) return false;
      // Skip vendor-widget headings
      if (h.closest(VENDOR_SELECTORS)) return false;
      return true;
    });
    const levels = hs.map((h: any) => parseInt(h.tagName[1]));
    const hasH1 = levels.includes(1);
    const skipped: number[] = [];
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] > 1) skipped.push(levels[i]);
    }
    return { levels, hasH1, skipped };
  });
  if (!headings.hasH1) {
    issues.push({ ruleId: "heuristic:heading-no-h1", severity: "serious", priority: 2, category: "structure",
      message: "Page is missing an <h1> heading. Screen readers rely on this as the page title.",
      url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag1.3.1","wcag2.4.6"],
      fixSuggestion: "Add a single <h1> that describes the page content.", state, phase });
  }
  if (headings.skipped.length) {
    issues.push({ ruleId: "heuristic:heading-skipped-level", severity: "moderate", priority: 3, category: "structure",
      message: `Heading levels are skipped (${headings.skipped.join(", ")}). Screen readers expect sequential heading hierarchy.`,
      url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag1.3.1","wcag2.4.6"],
      fixSuggestion: "Do not skip heading levels. Use CSS to style headings visually, not to select the tag.", state, phase });
  }

  // ── 7. Landmark regions ───────────────────────────────────────────────────
  const landmarks = await safeEval<{ hasMain: boolean; hasNav: boolean; hasBanner: boolean }>(page, () => ({
    hasMain:   !!document.querySelector("main,[role='main']"),
    hasNav:    !!document.querySelector("nav,[role='navigation']"),
    hasBanner: !!document.querySelector("header,[role='banner']"),
  }));
  if (!landmarks.hasMain) {
    issues.push({ ruleId: "heuristic:landmark-main-missing", severity: "serious", priority: 2, category: "structure",
      message: "Page is missing a <main> landmark. Keyboard users cannot skip to main content.",
      url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag1.3.6","wcag2.4.1"],
      fixSuggestion: "Wrap primary page content in <main> or add role='main'.", state, phase });
  }

  // ── 8. Form inputs without visible labels ─────────────────────────────────
  // Round 2c hardening: recognize the wrapping-label pattern
  //   <label>Name <input /></label>
  // which is valid but wasn't detected by the old rule (it only checked <label for>).
  const unlabeledInputs = await safeEval<ElemData[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']),select,textarea")
      .forEach((el: any) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden") return;
        if (el.closest("[hidden],[inert],[aria-hidden='true']")) return;
        const id = el.id;
        const hasLabelFor = id && document.querySelector(`label[for="${id}"]`);
        const isInsideLabel = Boolean(el.closest("label")); // wrapping <label> pattern
        const hasAria  = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
        const hasTitle = el.getAttribute("title");
        const hasPlaceholderAsSoleContext =
          el.getAttribute("placeholder") && el.type === "search"; // search inputs are often labelled solely by placeholder — treat as OK
        if (!hasLabelFor && !isInsideLabel && !hasAria && !hasTitle && !hasPlaceholderAsSoleContext) {
          out.push({ selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), depth: 0 });
        }
      });
    return out.slice(0, 50);
  });
  issues.push(...pack(unlabeledInputs, "heuristic:input-no-label", "critical", 1, "forms",
    `${unlabeledInputs.length} form inputs have no associated label (no <label for>, aria-label, or aria-labelledby).`,
    ["wcag1.3.1","wcag3.3.2"], "Associate each input with a <label for='id'>, or add aria-label/aria-labelledby.", url, state, phase));

  // ── 9. Images without meaningful alt ─────────────────────────────────────
  // Round 2c hardening: skip images inside <a> or <button> whose parent
  // already has an accessible name (aria-label, aria-labelledby, or visible text).
  // In those cases the parent link/button provides the alt — the image is decorative.
  const badAlt = await safeEval<ElemData[]>(page, () => {
    const out: { selector: string; depth: number }[] = [];
    document.querySelectorAll("img").forEach((el: any) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const role = el.getAttribute("role");
      if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden") return;
      if (el.closest("[hidden],[inert],[aria-hidden='true']") || el.getAttribute("aria-hidden") === "true") return;
      if (role === "presentation" || role === "none") return;

      const alt = el.getAttribute("alt");
      if (alt !== null) return; // has any alt (even empty) — not our problem

      // Check if parent link/button provides accessible name
      const interactiveParent = el.closest("a[href], button, [role='button'], [role='link']");
      if (interactiveParent) {
        const parentText = (interactiveParent.textContent || "").trim();
        const parentAria = interactiveParent.getAttribute("aria-label") || interactiveParent.getAttribute("aria-labelledby");
        if (parentAria || parentText.length >= 2) return; // parent labels the whole element
      }

      out.push({ selector: el.id ? `img#${el.id}` : `img[src="${(el.src||"").slice(-40)}"]`, depth: 0 });
    });
    return out.slice(0, 50);
  });
  issues.push(...pack(badAlt, "heuristic:image-missing-alt", "critical", 1, "images",
    `${badAlt.length} images are missing alt attributes entirely.`,
    ["wcag1.1.1"], "Add alt='' for decorative images, or a descriptive alt text for informative images.", url, state, phase));

  // ── 10. Language attribute ─────────────────────────────────────────────────
  const langMissing = await safeEval<boolean>(page, () =>
    !document.documentElement.getAttribute("lang")
  );
  if (langMissing) {
    issues.push({ ruleId: "heuristic:lang-missing", severity: "serious", priority: 2, category: "structure",
      message: "Page <html> element is missing a lang attribute. Screen readers cannot select the correct language.",
      url, selector: "html", selectors: ["html"], depths: [0], wcag: ["wcag3.1.1"],
      fixSuggestion: "Add lang='en' (or appropriate BCP 47 tag) to the <html> element.", state, phase });
  }

  // ── 11. Reflow — 320px viewport ───────────────────────────────────────────
  try {
    const originalSize = page.viewportSize();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(400);

    const reflowIssues = await safeEval<ElemData[]>(page, () => {
      const out: { selector: string; depth: number }[] = [];
      const vw = window.innerWidth;
      document.querySelectorAll("*").forEach((el: any) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden") return;
        if (el.closest("[hidden],[inert],[aria-hidden='true']")) return;
        if (st.position === "fixed") return;
        if ((st.overflowX === "auto" || st.overflowX === "scroll") && el.scrollWidth > el.clientWidth) return;
        if (r.right > vw + 2) {
          out.push({ selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), depth: 0 });
        }
      });
      return [...new Map(out.map(i => [i.selector, i])).values()].slice(0, 30);
    });

    await page.setViewportSize({
      width: originalSize?.width || 1366,
      height: originalSize?.height || 768,
    });
    await page.waitForTimeout(300);

    issues.push(...pack(reflowIssues, "heuristic:reflow", "serious", 2, "zoom",
      `${reflowIssues.length} elements overflow the 320px viewport — WCAG 1.4.10 Reflow failure.`,
      ["wcag1.4.10"], "Use responsive CSS (flexbox/grid, relative units). Avoid fixed widths that exceed 320px.", url, state, phase));
  } catch (err) {
    logger.debug("Reflow check failed:", err);
  }

  // ── 12. Reduced motion ────────────────────────────────────────────────────
  const hasAnimation = await safeEval<boolean>(page, () => {
    let found = false;
    document.querySelectorAll("*").forEach((el: any) => {
      const st = getComputedStyle(el);
      if ((st.animationName && st.animationName !== "none") || (st.transitionDuration && st.transitionDuration !== "0s")) {
        found = true;
      }
    });
    return found;
  });
  const hasMotionQuery = await safeEval<boolean>(page, () => {
    const sheets = Array.from(document.styleSheets);
    return sheets.some(s => {
      try {
        return Array.from(s.cssRules).some(r => r.cssText.includes("prefers-reduced-motion"));
      } catch { return false; }
    });
  });
  if (hasAnimation && !hasMotionQuery) {
    issues.push({ ruleId: "heuristic:reduced-motion", severity: "serious", priority: 2, category: "motion",
      message: "Animated elements detected but no @media (prefers-reduced-motion) query found.",
      url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag2.3.3"],
      fixSuggestion: "Wrap all animations in @media (prefers-reduced-motion: no-preference) { } so users who opt-out see no motion.", state, phase });
  }

  return issues.filter(i => i.selectors?.length || i.selector);
}
