/**
 * zoomPointer.ts
 * Zoom, reflow, text spacing, fixed/sticky, popup placement, and pointer checks.
 */

import type { Page } from "playwright";
import type { ScanIssue } from "./types";
import { logger } from "../utils/logger";

type Evidence = Pick<ScanIssue, "evidenceScreenshot" | "evidenceExplanation">;

type UiSnapshot = {
  viewport: { width: number; height: number; scrollWidth: number; scrollHeight: number };
  scroll: { x: number; y: number };
  visibleTransients: string[];
  expandedTriggers: string[];
  bodyOverflow: string;
  htmlOverflow: string;
  bodyTransform: string;
  activeElement: string | null;
};

async function closeTransientUi(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.mouse.click(2, 2).catch(() => undefined);
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[aria-expanded='true']").forEach((el) => {
      if (el.matches("button,[role='button'],summary")) {
        try { el.click(); } catch {}
      }
    });
    document.querySelectorAll<HTMLElement>("[role='menu'],[role='listbox'],[role='dialog'],[aria-modal='true'],.dropdown-menu,.menu,.popover,.tooltip,[data-popper-placement]").forEach((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      if (visible && !el.matches("nav,main,header,footer")) {
        el.setAttribute("data-aft-transient-reset", "true");
        if (!el.hasAttribute("data-aft-original-style")) {
          el.setAttribute("data-aft-original-style", el.getAttribute("style") ?? "__AFT_NO_STYLE__");
        }
        el.style.setProperty("display", "none", "important");
      }
    });
    (document.activeElement as HTMLElement | null)?.blur?.();
  }).catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);
}

async function restoreInjectedUi(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("aft-text-spacing-test")?.remove();
    document.querySelectorAll<HTMLElement>("[data-aft-original-style]").forEach((el) => {
      const original = el.getAttribute("data-aft-original-style");
      if (original === "__AFT_NO_STYLE__") el.removeAttribute("style");
      else if (original !== null) el.setAttribute("style", original);
      el.removeAttribute("data-aft-original-style");
      el.removeAttribute("data-aft-transient-reset");
    });
    document.querySelectorAll<HTMLElement>("[data-aft-evidence-highlight]").forEach((el) => {
      el.style.removeProperty("outline");
      el.style.removeProperty("outline-offset");
      el.removeAttribute("data-aft-evidence-highlight");
    });
  }).catch(() => undefined);
}

async function naturallyCloseTransientUi(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.mouse.click(2, 2).catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);
}

async function captureUiSnapshot(page: Page): Promise<UiSnapshot> {
  return page.evaluate(() => {
    const selectorFor = (el: Element | null): string | null => {
      if (!el) return null;
      const html = el as HTMLElement;
      if (html.id) return `${html.tagName.toLowerCase()}#${CSS.escape(html.id)}`;
      const ariaLabel = html.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.length < 80) return `${html.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
      const controls = html.getAttribute("aria-controls");
      if (controls) return `${html.tagName.toLowerCase()}[aria-controls="${CSS.escape(controls)}"]`;
      const parent = html.parentElement;
      let selector = html.tagName.toLowerCase();
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === html.tagName);
        if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(html) + 1})`;
      }
      return selector;
    };
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        style.opacity !== "0" && !el.closest("[hidden],[inert],[aria-hidden='true']");
    };
    const transientSelector = "[role='menu'],[role='listbox'],[role='dialog'],[aria-modal='true'],.dropdown-menu,.menu,.popover,.tooltip,[data-popper-placement]";
    const visibleTransients = Array.from(document.querySelectorAll(transientSelector))
      .filter(visible).map(selectorFor).filter(Boolean) as string[];
    const expandedTriggers = Array.from(document.querySelectorAll("[aria-expanded='true']"))
      .filter(visible).map(selectorFor).filter(Boolean) as string[];
    const bodyStyle = getComputedStyle(document.body);
    const htmlStyle = getComputedStyle(document.documentElement);
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight
      },
      scroll: { x: window.scrollX, y: window.scrollY },
      visibleTransients: Array.from(new Set(visibleTransients)),
      expandedTriggers: Array.from(new Set(expandedTriggers)),
      bodyOverflow: `${bodyStyle.overflowX}/${bodyStyle.overflowY}`,
      htmlOverflow: `${htmlStyle.overflowX}/${htmlStyle.overflowY}`,
      bodyTransform: bodyStyle.transform,
      activeElement: selectorFor(document.activeElement)
    };
  });
}

async function screenshotEvidence(page: Page, explanation: string): Promise<Evidence> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 68, fullPage: false });
    return {
      evidenceScreenshot: `data:image/jpeg;base64,${buf.toString("base64")}`,
      evidenceExplanation: explanation
    };
  } catch {
    return { evidenceExplanation: explanation };
  }
}

async function screenshotEvidenceForSelector(page: Page, selector: string, explanation: string, resetUi = true): Promise<Evidence> {
  if (resetUi) await closeTransientUi(page);
  await page.evaluate((targetSelector) => {
    const findElement = () => {
      try {
        return document.querySelector<HTMLElement>(targetSelector);
      } catch {
        return null;
      }
    };
    const el = findElement() || document.body;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    const previousOutline = el.style.outline;
    const previousOutlineOffset = el.style.outlineOffset;
    el.setAttribute("data-aft-evidence-highlight", "true");
    el.style.outline = "4px solid #ff006e";
    el.style.outlineOffset = "3px";
    window.setTimeout(() => {
      el.style.outline = previousOutline;
      el.style.outlineOffset = previousOutlineOffset;
      el.removeAttribute("data-aft-evidence-highlight");
    }, 1800);
  }, selector).catch(() => undefined);
  await page.waitForTimeout(120).catch(() => undefined);
  return screenshotEvidence(page, explanation);
}

export async function runZoomChecks(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];
  const zoomViewport = { width: 320, height: 568 };
  const originalVp = page.viewportSize() || { width: 1366, height: 768 };
  let baseline: UiSnapshot | null = null;

  const zoomLocked = await page.evaluate(() => {
    const meta = document.querySelector("meta[name='viewport']") as HTMLMetaElement | null;
    const content = meta?.getAttribute("content") || "";
    return content.includes("user-scalable=no") || /maximum-scale=[01]([^0-9]|$)/.test(content);
  }).catch(() => false);

  if (zoomLocked) {
    issues.push({
      ruleId: "zoom:viewport-locked",
      severity: "serious",
      priority: 1,
      category: "zoom",
      message: "Viewport meta tag prevents users from zooming.",
      url,
      selector: "meta[name='viewport']",
      selectors: ["meta[name='viewport']"],
      depths: [0],
      wcag: ["wcag1.4.4"],
      fixSuggestion: "Use width=device-width, initial-scale=1 and do not set user-scalable=no or maximum-scale=1.",
      state,
      phase
    });
  }

  const fixedFonts = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>("p,span,a,li,td,th,h1,h2,h3,h4,h5,h6,button,input,label").forEach((el) => {
      const fs = el.style?.fontSize || "";
      if (fs.endsWith("px") && parseFloat(fs) < 16) out.push(el.id ? `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}` : el.tagName.toLowerCase());
    });
    return Array.from(new Set(out)).slice(0, 30);
  }).catch(() => [] as string[]);

  if (fixedFonts.length) {
    issues.push({
      ruleId: "zoom:fixed-font-size",
      severity: "moderate",
      priority: 3,
      category: "zoom",
      message: `${fixedFonts.length} elements use small inline px font sizes that may not scale well with user settings.`,
      url,
      selector: fixedFonts[0],
      selectors: fixedFonts,
      depths: fixedFonts.map(() => 0),
      wcag: ["wcag1.4.4"],
      fixSuggestion: "Use rem/em units and avoid small fixed inline pixel font sizes.",
      state,
      phase
    });
  }

  try {
    baseline = await captureUiSnapshot(page);
    await closeTransientUi(page);

    const intermediateFailures: Array<{
      zoomPercent: number;
      viewport: { width: number; height: number; scrollWidth: number };
      offenders: Array<{ selector: string; text: string; right: number; width: number; clipped: boolean }>;
    }> = [];
    for (const zoomPercent of [200, 300]) {
      const factor = zoomPercent / 100;
      const viewport = {
        width: Math.max(320, Math.round(originalVp.width / factor)),
        height: Math.max(320, Math.round(originalVp.height / factor))
      };
      await page.setViewportSize(viewport);
      await page.waitForTimeout(350);
      const probe = await page.evaluate(() => {
        const selectorFor = (el: HTMLElement) => {
          if (el.id) return `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}`;
          const label = el.getAttribute("aria-label");
          if (label && label.length < 60) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(label)}"]`;
          return el.tagName.toLowerCase();
        };
        const offenders: Array<{ selector: string; text: string; right: number; width: number; clipped: boolean }> = [];
        document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !el.closest("[hidden],[inert],[aria-hidden='true']");
          if (!visible || style.position === "fixed" || style.position === "sticky") return;
          const hasText = (el.textContent || "").trim().length > 1;
          const clipped = hasText && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2 || style.textOverflow === "ellipsis" || Boolean((style as any).webkitLineClamp));
          if (rect.right > window.innerWidth + 2 || clipped) {
            offenders.push({
              selector: selectorFor(el),
              text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
              right: Math.round(rect.right),
              width: Math.round(rect.width),
              clipped
            });
          }
        });
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth },
          offenders: Array.from(new Map(offenders.map((item) => [item.selector, item])).values()).slice(0, 12)
        };
      });
      if (probe.offenders.length || probe.viewport.scrollWidth > probe.viewport.width + 5) {
        intermediateFailures.push({ zoomPercent, viewport: probe.viewport, offenders: probe.offenders });
      }
    }

    if (intermediateFailures.length) {
      const first = intermediateFailures[0];
      await page.setViewportSize({ width: first.viewport.width, height: first.viewport.height });
      await page.waitForTimeout(200);
      const selector = first.offenders[0]?.selector || "body";
      const evidence = await screenshotEvidenceForSelector(
        page,
        selector,
        `Issue-specific evidence captured at the ${first.zoomPercent}% equivalent viewport (${first.viewport.width}x${first.viewport.height}). The highlighted element is the first overflow or clipping offender.`,
        false
      );
      issues.push({
        ruleId: "zoom:intermediate-breakpoint-failure",
        severity: "serious",
        priority: 2,
        category: "zoom",
        message: `Content clips or overflows at ${intermediateFailures.map((item) => `${item.zoomPercent}%`).join(" and ")} zoom-equivalent breakpoints.`,
        url,
        selector,
        selectors: Array.from(new Set(intermediateFailures.flatMap((item) => item.offenders.map((offender) => offender.selector)))),
        affectedElements: intermediateFailures.flatMap((item) => item.offenders.map((offender) => `${item.zoomPercent}%: ${offender.selector} (${offender.width}px wide, right=${offender.right}, clipped=${offender.clipped})`)),
        depths: intermediateFailures.flatMap((item) => item.offenders.map(() => 0)),
        wcag: ["wcag1.4.4", "wcag1.4.10"],
        fixSuggestion: "Test responsive breakpoints throughout 200%-400% zoom, allow wrapping, and avoid layouts that only recover at the smallest mobile breakpoint.",
        state,
        phase: `${phase}:intermediate`,
        htmlSnippet: JSON.stringify(intermediateFailures, null, 2),
        ...evidence
      });
      await closeTransientUi(page);
    }

    await page.setViewportSize(zoomViewport);
    await page.waitForTimeout(600);
    await closeTransientUi(page);

    const zoomData = await page.evaluate(() => {
      type RectItem = {
        selector: string;
        text?: string;
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };

      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight
      };

      const selectorFor = (el: Element) => {
        const html = el as HTMLElement;
        if (html.id) return `${html.tagName.toLowerCase()}#${CSS.escape(html.id)}`;
        const role = html.getAttribute("role");
        const label = html.getAttribute("aria-label");
        let part = html.tagName.toLowerCase();
        if (role) part += `[role="${CSS.escape(role)}"]`;
        if (label && label.length < 60) part += `[aria-label="${CSS.escape(label)}"]`;
        const parent = html.parentElement;
        if (!parent) return part;
        const siblings = Array.from(parent.children).filter((child) => child.tagName === html.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(html) + 1})`;
        return part;
      };

      const visible = (el: Element | null) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" &&
          st.opacity !== "0" && !el.closest("[hidden],[inert],[aria-hidden='true']");
      };

      const rectFor = (el: Element): RectItem => {
        const r = el.getBoundingClientRect();
        return {
          selector: selectorFor(el),
          text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
          left: Math.round(r.left),
          top: Math.round(r.top),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          height: Math.round(r.height)
        };
      };

      const overflow: RectItem[] = [];
      const clippedText: RectItem[] = [];
      const stickyObstructions: RectItem[] = [];
      const modalFit: RectItem[] = [];
      const tableFailures: RectItem[] = [];
      const focusFailures: RectItem[] = [];
      const crowdedTargets: RectItem[] = [];
      const missingFunctionalLabels: string[] = [];
      const scrollTraps: RectItem[] = [];

      document.querySelectorAll("*").forEach((el) => {
        if (!visible(el)) return;
        const html = el as HTMLElement;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        const hasOwnText = Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim().length > 1);

        if (st.position !== "fixed" && st.position !== "sticky" && r.right > viewport.width + 2) overflow.push(rectFor(el));
        if (hasOwnText && (html.scrollWidth > html.clientWidth + 2 || html.scrollHeight > html.clientHeight + 2 || st.textOverflow === "ellipsis" || (st as any).webkitLineClamp)) clippedText.push(rectFor(el));
        if ((st.position === "fixed" || st.position === "sticky") && r.width > viewport.width * 0.7 && r.height > Math.min(140, viewport.height * 0.25)) stickyObstructions.push(rectFor(el));
        if ((el.matches("table,[role='table'],[role='grid']") || el.querySelector("table,[role='grid']")) && html.scrollWidth > viewport.width + 2 && !el.closest("[style*='overflow'],.table-responsive,[class*='scroll']")) tableFailures.push(rectFor(el));
        if (el.matches("[role='dialog'],dialog,.modal,[aria-modal='true']") && (r.right > viewport.width || r.bottom > viewport.height || r.left < 0 || r.top < 0)) modalFit.push(rectFor(el));
        if ((st.overflowY === "auto" || st.overflowY === "scroll") && html.scrollHeight > html.clientHeight + 80 && r.height > viewport.height * 0.65) scrollTraps.push(rectFor(el));
      });

      const interactives = Array.from(document.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[role='button'],[role='link'],[tabindex]:not([tabindex='-1'])")).filter(visible);
      for (const el of interactives.slice(0, 70)) {
        const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (!name && el.matches("button,a,[role='button'],[role='link']")) missingFunctionalLabels.push(selectorFor(el));
        try {
          el.focus({ preventScroll: false });
          const r = el.getBoundingClientRect();
          const cx = Math.max(0, Math.min(viewport.width - 1, r.left + r.width / 2));
          const cy = Math.max(0, Math.min(viewport.height - 1, r.top + r.height / 2));
          const top = document.elementFromPoint(cx, cy);
          const st = getComputedStyle(el);
          const noFocusIndicator = (st.outlineStyle === "none" || parseFloat(st.outlineWidth || "0") === 0) && st.boxShadow === "none";
          if (r.left < 0 || r.top < 0 || r.right > viewport.width || r.bottom > viewport.height || (top && top !== el && !el.contains(top)) || noFocusIndicator) {
            focusFailures.push(rectFor(el));
          }
        } catch {}
      }

      for (let i = 0; i < interactives.length; i += 1) {
        const a = interactives[i];
        const ar = a.getBoundingClientRect();
        for (let j = i + 1; j < Math.min(interactives.length, i + 18); j += 1) {
          const b = interactives[j];
          if (a.contains(b) || b.contains(a)) continue;
          const br = b.getBoundingClientRect();
          const overlapX = Math.max(0, Math.min(ar.right, br.right) - Math.max(ar.left, br.left));
          const overlapY = Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top));
          const overlapArea = overlapX * overlapY;
          const minArea = Math.min(ar.width * ar.height, br.width * br.height);
          if (minArea > 0 && overlapArea / minArea > 0.35) {
            crowdedTargets.push(rectFor(a));
            break;
          }
        }
      }

      return {
        viewport,
        requiresHScroll: viewport.scrollWidth > viewport.width + 5,
        overflow: Array.from(new Map(overflow.map((item) => [item.selector, item])).values()).slice(0, 30),
        clippedText: Array.from(new Map(clippedText.map((item) => [item.selector, item])).values()).slice(0, 30),
        stickyObstructions: Array.from(new Map(stickyObstructions.map((item) => [item.selector, item])).values()).slice(0, 12),
        modalFit: Array.from(new Map(modalFit.map((item) => [item.selector, item])).values()).slice(0, 12),
        tableFailures: Array.from(new Map(tableFailures.map((item) => [item.selector, item])).values()).slice(0, 12),
        focusFailures: Array.from(new Map(focusFailures.map((item) => [item.selector, item])).values()).slice(0, 20),
        crowdedTargets: Array.from(new Map(crowdedTargets.map((item) => [item.selector, item])).values()).slice(0, 20),
        missingFunctionalLabels: Array.from(new Set(missingFunctionalLabels)).slice(0, 20),
        scrollTraps: Array.from(new Map(scrollTraps.map((item) => [item.selector, item])).values()).slice(0, 8)
      };
    });

    if (zoomData.overflow.length || zoomData.requiresHScroll) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.overflow[0]?.selector || "body",
        `Issue-specific reflow evidence captured at ${zoomViewport.width}x${zoomViewport.height} after closing transient menus/popups. Highlighted element is the first horizontal-overflow offender.`
      );
      issues.push({
        ruleId: "zoom:reflow-failure",
        severity: "serious",
        priority: 1,
        category: "zoom",
        message: `Content does not reflow at ${zoomViewport.width}px width. ${zoomData.overflow.length} elements overflow horizontally; page scroll width is ${zoomData.viewport.scrollWidth}px.`,
        url,
        selector: zoomData.overflow[0]?.selector || "body",
        selectors: zoomData.overflow.length ? zoomData.overflow.map((item: any) => item.selector) : ["body"],
        affectedElements: zoomData.overflow.map((item: any) => `${item.selector} (${item.width}x${item.height}, right=${item.right})`),
        depths: zoomData.overflow.map(() => 0),
        wcag: ["wcag1.4.10"],
        fixSuggestion: "Use responsive CSS, max-width: 100%, wrapping layout, and avoid fixed widths that exceed 320px.",
        state,
        phase,
        htmlSnippet: JSON.stringify({ viewport: zoomData.viewport, offenders: zoomData.overflow.slice(0, 8) }, null, 2),
        ...evidence
      });
    }

    if (zoomData.clippedText.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.clippedText[0].selector,
        `Issue-specific clipped-text evidence captured at ${zoomViewport.width}x${zoomViewport.height} after closing transient menus/popups. Highlighted element is the first clipped text container.`
      );
      issues.push({
        ruleId: "zoom:text-clipped",
        severity: "serious",
        priority: 2,
        category: "zoom",
        message: `${zoomData.clippedText.length} text containers clip or truncate content at zoom.`,
        url,
        selector: zoomData.clippedText[0].selector,
        selectors: zoomData.clippedText.map((item: any) => item.selector),
        affectedElements: zoomData.clippedText.map((item: any) => `${item.selector}: "${item.text || ""}"`),
        depths: zoomData.clippedText.map(() => 0),
        wcag: ["wcag1.4.4", "wcag1.4.10"],
        fixSuggestion: "Allow text to wrap, expose full labels, and avoid fixed-height containers or ellipsis-only controls at zoom.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.clippedText.slice(0, 8), null, 2),
        ...evidence
      });
    }

    if (zoomData.stickyObstructions.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.stickyObstructions[0].selector,
        `Issue-specific sticky/obstruction evidence captured at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first excessive fixed/sticky region.`
      );
      issues.push({
        ruleId: "zoom:fixed-sticky-obstruction",
        severity: "serious",
        priority: 2,
        category: "zoom",
        message: `${zoomData.stickyObstructions.length} fixed or sticky regions consume excessive viewport space at zoom.`,
        url,
        selector: zoomData.stickyObstructions[0].selector,
        selectors: zoomData.stickyObstructions.map((item: any) => item.selector),
        affectedElements: zoomData.stickyObstructions.map((item: any) => `${item.selector} (${item.width}x${item.height})`),
        depths: zoomData.stickyObstructions.map(() => 0),
        wcag: ["wcag1.4.10", "wcag2.4.11"],
        fixSuggestion: "Reduce sticky region height at zoom, allow it to collapse, or add scroll-padding/scroll-margin so content and focus are not hidden.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.stickyObstructions, null, 2),
        ...evidence
      });
    }

    if (zoomData.modalFit.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.modalFit[0].selector,
        `Issue-specific dialog-fit evidence captured at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first dialog/modal that does not fit.`
      );
      issues.push({
        ruleId: "zoom:dialog-does-not-fit",
        severity: "serious",
        priority: 2,
        category: "zoom",
        message: `${zoomData.modalFit.length} dialog or modal surfaces do not fit inside the zoom viewport.`,
        url,
        selector: zoomData.modalFit[0].selector,
        selectors: zoomData.modalFit.map((item: any) => item.selector),
        affectedElements: zoomData.modalFit.map((item: any) => `${item.selector} bounds ${item.left},${item.top},${item.right},${item.bottom}`),
        depths: zoomData.modalFit.map(() => 0),
        wcag: ["wcag1.4.10", "wcag2.1.2"],
        fixSuggestion: "Constrain dialogs to viewport width/height, keep close controls reachable, and make dialog content scrollable when needed.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.modalFit, null, 2),
        ...evidence
      });
    }

    if (zoomData.tableFailures.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.tableFailures[0].selector,
        `Issue-specific table/grid reflow evidence captured at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first table/grid offender.`
      );
      issues.push({
        ruleId: "zoom:table-grid-unusable",
        severity: "moderate",
        priority: 3,
        category: "zoom",
        message: `${zoomData.tableFailures.length} table/grid regions exceed the zoom viewport without an obvious responsive scroll pattern.`,
        url,
        selector: zoomData.tableFailures[0].selector,
        selectors: zoomData.tableFailures.map((item: any) => item.selector),
        affectedElements: zoomData.tableFailures.map((item: any) => `${item.selector} (${item.width}px wide)`),
        depths: zoomData.tableFailures.map(() => 0),
        wcag: ["wcag1.4.10", "wcag1.3.1"],
        fixSuggestion: "Use responsive table patterns, sticky headers, a card layout at narrow widths, or a clearly labeled horizontal scroll region.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.tableFailures, null, 2),
        ...evidence
      });
    }

    if (zoomData.focusFailures.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.focusFailures[0].selector,
        `Issue-specific focus-at-zoom evidence captured at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first focusable control detected as clipped, obscured, off-screen, or missing visible focus.`
      );
      issues.push({
        ruleId: "zoom:focus-unusable",
        severity: "serious",
        priority: 2,
        category: "focus",
        message: `${zoomData.focusFailures.length} focusable controls are clipped, off-screen, obscured, or lack visible focus at zoom.`,
        url,
        selector: zoomData.focusFailures[0].selector,
        selectors: zoomData.focusFailures.map((item: any) => item.selector),
        affectedElements: zoomData.focusFailures.map((item: any) => `${item.selector} bounds ${item.left},${item.top},${item.right},${item.bottom}`),
        depths: zoomData.focusFailures.map(() => 0),
        wcag: ["wcag2.4.7", "wcag2.4.11", "wcag1.4.10"],
        fixSuggestion: "Keep focused controls visible at zoom, add clear :focus-visible styling, and account for sticky overlays.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.focusFailures.slice(0, 8), null, 2),
        ...evidence
      });
    }

    if (zoomData.crowdedTargets.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.crowdedTargets[0].selector,
        `Issue-specific crowded-target evidence captured at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first overlapping/crowded interactive target.`
      );
      issues.push({
        ruleId: "zoom:interactive-targets-overlap",
        severity: "moderate",
        priority: 3,
        category: "pointer",
        message: `${zoomData.crowdedTargets.length} interactive controls overlap or become too crowded at zoom.`,
        url,
        selector: zoomData.crowdedTargets[0].selector,
        selectors: zoomData.crowdedTargets.map((item: any) => item.selector),
        affectedElements: zoomData.crowdedTargets.map((item: any) => `${item.selector} (${item.width}x${item.height})`),
        depths: zoomData.crowdedTargets.map(() => 0),
        wcag: ["wcag1.4.10", "wcag2.5.8"],
        fixSuggestion: "Increase spacing, allow controls to wrap onto separate rows, and preserve minimum target sizes at zoom.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.crowdedTargets.slice(0, 8), null, 2),
        ...evidence
      });
    }

    if (zoomData.missingFunctionalLabels.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.missingFunctionalLabels[0],
        `Issue-specific missing-label evidence captured at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first interactive control without a usable label.`
      );
      issues.push({
        ruleId: "zoom:function-labels-lost",
        severity: "serious",
        priority: 2,
        category: "zoom",
        message: `${zoomData.missingFunctionalLabels.length} interactive controls have no visible or accessible label at zoom.`,
        url,
        selector: zoomData.missingFunctionalLabels[0],
        selectors: zoomData.missingFunctionalLabels,
        depths: zoomData.missingFunctionalLabels.map(() => 0),
        wcag: ["wcag2.4.6", "wcag4.1.2"],
        fixSuggestion: "Do not hide essential labels at narrow widths unless an equivalent accessible name remains. Avoid ambiguous icon-only controls.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.missingFunctionalLabels, null, 2),
        ...evidence
      });
    }

    if (zoomData.scrollTraps.length) {
      const evidence = await screenshotEvidenceForSelector(
        page,
        zoomData.scrollTraps[0].selector,
        `Issue-specific nested-scroll evidence captured at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first large nested scroll region.`
      );
      issues.push({
        ruleId: "zoom:nested-scroll-trap-risk",
        severity: "moderate",
        priority: 3,
        category: "zoom",
        message: `${zoomData.scrollTraps.length} large nested scroll regions may trap users or hide content at zoom.`,
        url,
        selector: zoomData.scrollTraps[0].selector,
        selectors: zoomData.scrollTraps.map((item: any) => item.selector),
        affectedElements: zoomData.scrollTraps.map((item: any) => `${item.selector} (${item.width}x${item.height})`),
        depths: zoomData.scrollTraps.map(() => 0),
        wcag: ["wcag1.4.10", "wcag2.1.1"],
        fixSuggestion: "Avoid large nested scroll regions at zoom, keep page-level scrolling predictable, and ensure keyboard users can enter and exit scroll containers.",
        state,
        phase,
        htmlSnippet: JSON.stringify(zoomData.scrollTraps, null, 2),
        ...evidence
      });
    }

    const expandedData = await page.evaluate(async () => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const selectorFor = (el: Element) => {
        const html = el as HTMLElement;
        if (html.id) return `${html.tagName.toLowerCase()}#${CSS.escape(html.id)}`;
        return html.tagName.toLowerCase();
      };
      const visible = (el: Element | null) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && !el.closest("[hidden],[inert],[aria-hidden='true']");
      };
      const rectSummary = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { selector: selectorFor(el), left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
      };
      const triggers = Array.from(document.querySelectorAll<HTMLElement>("[aria-expanded='false'],[aria-haspopup],summary,button,[role='button']"))
        .filter(visible)
        .slice(0, 12);
      const failures: any[] = [];

      for (const trigger of triggers) {
        const beforeVisible = new Set(Array.from(document.querySelectorAll("*")).filter(visible));
        try {
          trigger.click();
          await delay(450);
        } catch {
          continue;
        }

        const panels = Array.from(document.querySelectorAll<HTMLElement>("[role='menu'],[role='listbox'],[role='dialog'],[aria-modal='true'],.dropdown-menu,.menu,.popover,.tooltip,[data-popper-placement]"))
          .filter((el) => visible(el) && !beforeVisible.has(el))
          .slice(0, 5);
        const controlled = trigger.getAttribute("aria-controls");
        if (controlled) {
          const panel = document.getElementById(controlled);
          if (panel && visible(panel)) panels.push(panel);
        }

        for (const panel of panels) {
          const pr = panel.getBoundingClientRect();
          const tr = trigger.getBoundingClientRect();
          const offscreen = pr.left < 0 || pr.top < 0 || pr.right > window.innerWidth || pr.bottom > window.innerHeight;
          const detached = Math.min(Math.abs(pr.left - tr.left), Math.abs(pr.right - tr.right), Math.abs(pr.top - tr.bottom), Math.abs(pr.bottom - tr.top)) > 180;
          const clipped = panel.scrollWidth > panel.clientWidth + 2 || panel.scrollHeight > panel.clientHeight + 2;
          if (offscreen || detached || clipped) failures.push({ trigger: rectSummary(trigger), panel: rectSummary(panel), offscreen, detached, clipped });
        }

        if (failures.length) break;
        try {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          trigger.click();
        } catch {}
      }
      return failures.slice(0, 8);
    });

    if (expandedData.length) {
      const expandedEvidence = await screenshotEvidenceForSelector(
        page,
        expandedData[0].panel.selector,
        `Captured after intentionally opening an expandable control at ${zoomViewport.width}x${zoomViewport.height}; highlighted element is the failing popup/menu surface.`,
        false
      );
      issues.push({
        ruleId: "zoom:expanded-state-position-failure",
        severity: "serious",
        priority: 1,
        category: "zoom",
        message: `${expandedData.length} expanded menu, popup, tooltip, or dialog surfaces are off-screen, detached from their trigger, or clipped at zoom.`,
        url,
        selector: expandedData[0].panel.selector,
        selectors: expandedData.map((item: any) => item.panel.selector),
        affectedElements: expandedData.map((item: any) => `${item.panel.selector} from trigger ${item.trigger.selector}`),
        depths: expandedData.map(() => 0),
        wcag: ["wcag1.4.10", "wcag1.4.13", "wcag2.4.11"],
        fixSuggestion: "Use viewport-aware popup positioning, allow wrapping/scrolling within the panel, and test each expanded state at 320px width and 400% zoom.",
        state,
        phase: `${phase}:expanded`,
        htmlSnippet: JSON.stringify(expandedData, null, 2),
        ...expandedEvidence
      });
      await closeTransientUi(page);
    }

    await closeTransientUi(page);
    const textSpacing = await page.evaluate(() => {
      document.getElementById("aft-text-spacing-test")?.remove();
      const style = document.createElement("style");
      style.id = "aft-text-spacing-test";
      style.textContent = "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p,li,div,section,article,main,aside,header,footer { margin-bottom: 2em !important; }";
      document.head.appendChild(style);
      const failures: any[] = [];
      const selectorFor = (el: HTMLElement) => el.id ? `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}` : el.tagName.toLowerCase();
      document.querySelectorAll<HTMLElement>("p,span,a,button,label,li,td,th,h1,h2,h3,h4,h5,h6,div").forEach((el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        const hasText = (el.textContent || "").trim().length > 2;
        if (!hasText || r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden") return;
        if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2 || r.right > window.innerWidth + 2) {
          failures.push({ selector: selectorFor(el), text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80), width: Math.round(r.width), height: Math.round(r.height) });
        }
      });
      return failures.slice(0, 20);
    });

    if (textSpacing.length) {
      const spacingEvidence = await screenshotEvidenceForSelector(
        page,
        textSpacing[0].selector,
        `Issue-specific evidence captured while WCAG text-spacing overrides are still applied at ${zoomViewport.width}x${zoomViewport.height}. Highlighted element is the first text-spacing failure.`
      );
      issues.push({
        ruleId: "zoom:text-spacing-failure",
        severity: "serious",
        priority: 2,
        category: "zoom",
        message: `${textSpacing.length} text elements clip, overflow, or become unavailable when WCAG text spacing is applied at zoom.`,
        url,
        selector: textSpacing[0].selector,
        selectors: textSpacing.map((item: any) => item.selector),
        affectedElements: textSpacing.map((item: any) => `${item.selector}: "${item.text}"`),
        depths: textSpacing.map(() => 0),
        wcag: ["wcag1.4.12", "wcag1.4.10"],
        fixSuggestion: "Avoid fixed-height text containers and allow line-height, letter spacing, word spacing, and paragraph spacing overrides without clipping.",
        state,
        phase: `${phase}:text-spacing`,
        htmlSnippet: JSON.stringify(textSpacing, null, 2),
        ...spacingEvidence
      });
    }
    await restoreInjectedUi(page);
    await page.setViewportSize(originalVp);
    if (baseline) {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), baseline.scroll).catch(() => undefined);
    }
    await page.waitForTimeout(500);

    const recovered = await captureUiSnapshot(page);
    const baselineTransients = new Set(baseline?.visibleTransients || []);
    const baselineExpanded = new Set(baseline?.expandedTriggers || []);
    const persistentTransients = recovered.visibleTransients.filter((selector) => !baselineTransients.has(selector));
    const persistentExpanded = recovered.expandedTriggers.filter((selector) => !baselineExpanded.has(selector));
    const viewportMismatch = recovered.viewport.width !== originalVp.width || recovered.viewport.height !== originalVp.height;
    const baselineHadHorizontalOverflow = baseline ? baseline.viewport.scrollWidth > baseline.viewport.width + 5 : false;
    const introducedHorizontalOverflow = !baselineHadHorizontalOverflow && recovered.viewport.scrollWidth > recovered.viewport.width + 5;
    const overflowLockChanged = Boolean(baseline) && (recovered.bodyOverflow !== baseline!.bodyOverflow || recovered.htmlOverflow !== baseline!.htmlOverflow) &&
      /hidden/.test(`${recovered.bodyOverflow}/${recovered.htmlOverflow}`);
    const transformPersisted = Boolean(baseline) && recovered.bodyTransform !== baseline!.bodyTransform && recovered.bodyTransform !== "none";

    if (persistentTransients.length || persistentExpanded.length || viewportMismatch || introducedHorizontalOverflow || overflowLockChanged || transformPersisted) {
      const selector = persistentTransients[0] || persistentExpanded[0] || "body";
      const evidence = await screenshotEvidenceForSelector(
        page,
        selector,
        `Post-zoom recovery evidence captured after restoring the original ${originalVp.width}x${originalVp.height} viewport. The highlighted element or page state remained inconsistent with the pre-zoom baseline.`,
        false
      );
      const reasons = [
        persistentTransients.length ? `${persistentTransients.length} popup/dialog surface(s) remained visible` : "",
        persistentExpanded.length ? `${persistentExpanded.length} trigger(s) remained expanded` : "",
        viewportMismatch ? `viewport restored as ${recovered.viewport.width}x${recovered.viewport.height} instead of ${originalVp.width}x${originalVp.height}` : "",
        introducedHorizontalOverflow ? "new horizontal overflow remained after restoration" : "",
        overflowLockChanged ? "a page scroll lock remained after restoration" : "",
        transformPersisted ? "a body transform remained after restoration" : ""
      ].filter(Boolean);
      const selectors = Array.from(new Set([...persistentTransients, ...persistentExpanded, ...(reasons.length ? [] : ["body"])]));
      issues.push({
        ruleId: "zoom:viewport-restoration-failure",
        severity: "serious",
        priority: 1,
        category: "zoom",
        message: `The page did not return to its pre-zoom state: ${reasons.join("; ")}.`,
        url,
        selector,
        selectors: selectors.length ? selectors : ["body"],
        affectedElements: reasons,
        depths: (selectors.length ? selectors : ["body"]).map(() => 0),
        wcag: ["wcag1.4.10", "wcag1.4.13", "wcag3.2.2"],
        fixSuggestion: "On viewport restoration, recalculate popup placement, close transient expanded content when appropriate, release scroll locks, remove zoom transforms, and restore responsive layout state.",
        state,
        phase: `${phase}:recovery`,
        htmlSnippet: JSON.stringify({ baseline, recovered, persistentTransients, persistentExpanded, reasons }, null, 2),
        ...evidence
      });
    }
  } catch (err) {
    logger.debug("Zoom checks failed:", err);
  } finally {
    await restoreInjectedUi(page);
    await page.setViewportSize(originalVp).catch(() => undefined);
    if (baseline) {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), baseline.scroll).catch(() => undefined);
    }
    await naturallyCloseTransientUi(page);
  }

  return issues;
}

export async function runPointerChecks(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  const smallTargets = await page.evaluate(() => {
    const MIN = 24;
    const out: { sel: string; w: number; h: number }[] = [];
    document.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[tabindex]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" &&
        el.getAttribute("aria-hidden") !== "true" && !el.closest("[hidden],[inert],[aria-hidden='true']");
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
      const inlineTextLink = el.tagName === "A" && style.display === "inline" && r.width >= MIN;
      if (!visible || disabled || inlineTextLink) return;
      if (r.width < MIN || r.height < MIN) {
        out.push({ sel: el.id ? `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}` : el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) });
      }
    });
    return out.slice(0, 60);
  }).catch(() => [] as { sel: string; w: number; h: number }[]);

  if (smallTargets.length) {
    issues.push({
      ruleId: "pointer:target-size-minimum",
      severity: "serious",
      priority: 2,
      category: "pointer",
      message: `${smallTargets.length} interactive elements are smaller than 24x24 CSS px. Smallest: ${smallTargets[0]?.w}x${smallTargets[0]?.h}px.`,
      url,
      selector: smallTargets[0].sel,
      selectors: smallTargets.map((t) => t.sel),
      depths: smallTargets.map(() => 0),
      wcag: ["wcag2.5.8"],
      fixSuggestion: "Increase tap target size to at least 24x24px via padding. For best practice, aim for 44x44px.",
      state,
      phase,
      htmlSnippet: smallTargets.slice(0, 5).map((t) => `/* ${t.sel}: ${t.w}x${t.h}px */`).join("\n")
    });
  }

  const enhancedTargets = await page.evaluate(() => {
    const MIN = 44;
    const MIN_EXCEPTION = 24;
    const out: { sel: string; w: number; h: number }[] = [];
    document.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[tabindex]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" &&
        el.getAttribute("aria-hidden") !== "true" && !el.closest("[hidden],[inert],[aria-hidden='true']");
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
      const inlineTextLink = el.tagName === "A" && style.display === "inline" && r.width >= MIN_EXCEPTION;
      if (!visible || disabled || inlineTextLink) return;
      if (r.width < MIN || r.height < MIN) {
        out.push({ sel: el.id ? `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}` : el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) });
      }
    });
    return out.slice(0, 80);
  }).catch(() => [] as { sel: string; w: number; h: number }[]);

  if (enhancedTargets.length) {
    issues.push({
      ruleId: "pointer:target-size-enhanced",
      severity: "moderate",
      priority: 3,
      category: "pointer",
      message: `${enhancedTargets.length} interactive elements are smaller than 44x44 CSS px (WCAG 2.5.5 AAA). Smallest: ${enhancedTargets[0]?.w}x${enhancedTargets[0]?.h}px.`,
      url,
      selector: enhancedTargets[0].sel,
      selectors: enhancedTargets.map((t) => t.sel),
      depths: enhancedTargets.map(() => 0),
      wcag: ["wcag2.5.5"],
      tags: ["wcag2aaa"],
      fixSuggestion: "Increase enhanced pointer targets to at least 44x44 CSS px, reviewing WCAG exceptions for inline links and equivalent controls.",
      state,
      phase,
      htmlSnippet: enhancedTargets.slice(0, 8).map((t) => `/* ${t.sel}: ${t.w}x${t.h}px */`).join("\n")
    });
  }

  const dragOnly = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>("[draggable='true']").forEach((el) => {
      const hasBtnAlternative = el.querySelector("button,[role='button']") || el.getAttribute("data-sortable-handle");
      if (!hasBtnAlternative) out.push(el.id ? `${el.tagName.toLowerCase()}[draggable]#${CSS.escape(el.id)}` : `${el.tagName.toLowerCase()}[draggable]`);
    });
    return out.slice(0, 20);
  }).catch(() => [] as string[]);

  if (dragOnly.length) {
    issues.push({
      ruleId: "pointer:drag-no-alternative",
      severity: "serious",
      priority: 2,
      category: "pointer",
      message: `${dragOnly.length} draggable elements lack visible keyboard or single-pointer alternatives.`,
      url,
      selector: dragOnly[0],
      selectors: dragOnly,
      depths: dragOnly.map(() => 0),
      wcag: ["wcag2.5.1", "wcag2.5.7"],
      fixSuggestion: "Provide button-based alternatives such as move up/down controls for drag-and-drop functionality.",
      state,
      phase
    });
  }

  const gestureOnly = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>("[class*='swipe'],[class*='gesture'],[data-swipe],[data-gesture],[class*='carousel'],[class*='slider']").forEach((el) => {
      const hasArrows = el.querySelector("button,[role='button'],[aria-label*='next' i],[aria-label*='prev' i]");
      if (!hasArrows) out.push(el.className ? `.${String(el.className).split(" ")[0]}` : el.tagName.toLowerCase());
    });
    return out.slice(0, 20);
  }).catch(() => [] as string[]);

  if (gestureOnly.length) {
    issues.push({
      ruleId: "pointer:gesture-no-alternative",
      severity: "serious",
      priority: 2,
      category: "pointer",
      message: `${gestureOnly.length} swipe/gesture components may lack single-pointer alternatives.`,
      url,
      selector: gestureOnly[0],
      selectors: gestureOnly,
      depths: gestureOnly.map(() => 0),
      wcag: ["wcag2.5.1"],
      fixSuggestion: "Add prev/next buttons or keyboard arrow navigation as alternatives to swiping.",
      state,
      phase
    });
  }

  const downOnlyActions = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>("[onmousedown],[ontouchstart]").forEach((el) => {
      const anyEl = el as any;
      const hasUpHandler = anyEl.onmouseup || anyEl.ontouchend || anyEl.onclick;
      if (!hasUpHandler) out.push(el.id ? `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}` : el.tagName.toLowerCase());
    });
    return out.slice(0, 20);
  }).catch(() => [] as string[]);

  if (downOnlyActions.length) {
    issues.push({
      ruleId: "pointer:down-event-only",
      severity: "moderate",
      priority: 3,
      category: "pointer",
      message: `${downOnlyActions.length} elements trigger actions on pointer-down only, preventing cancellation.`,
      url,
      selector: downOnlyActions[0],
      selectors: downOnlyActions,
      depths: downOnlyActions.map(() => 0),
      wcag: ["wcag2.5.2"],
      fixSuggestion: "Use click/pointer-up activation instead of mousedown/touchstart for action triggers.",
      state,
      phase
    });
  }

  return issues;
}
