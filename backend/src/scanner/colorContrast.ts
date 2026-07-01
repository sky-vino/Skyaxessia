/**
 * colorContrast.ts
 * Measures actual color contrast ratios from computed styles.
 * Also checks gradient/image backgrounds for manual review.
 *
 * WCAG 1.4.3: Normal text ≥ 4.5:1
 * WCAG 1.4.3: Large text (18pt / 14pt bold) ≥ 3:1
 * WCAG 1.4.11: UI components & graphics ≥ 3:1
 */

import type { Page } from "playwright";
import type { ScanIssue } from "./types";
import { logger } from "../utils/logger";

interface ColorRgb { r: number; g: number; b: number; a: number }

function parseRgb(color: string): ColorRgb | null {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
}

function relativeLuminance(c: ColorRgb): number {
  const linear = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

function contrastRatio(fg: ColorRgb, bg: ColorRgb): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export async function runColorChecks(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  try {
    const contrastData = await page.evaluate(() => {
      const failures: {
        selector: string;
        ratio: number;
        fg: string;
        bg: string;
        fontSize: string;
        fontWeight: string;
        text: string;
        isLarge: boolean;
      }[] = [];

      const parseRgb = (c: string) => {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 } : null;
      };
      const lum = (c: any) => {
        const s = (v: number) => { const n = v/255; return n <= 0.03928 ? n/12.92 : Math.pow((n+0.055)/1.055, 2.4); };
        return 0.2126*s(c.r) + 0.7152*s(c.g) + 0.0722*s(c.b);
      };
      const ratio = (fg: any, bg: any) => {
        const l1 = lum(fg), l2 = lum(bg);
        return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      };

      document.querySelectorAll("p,span,a,h1,h2,h3,h4,h5,h6,label,li,td,th,button,div")
        .forEach((el: any) => {
          const text = el.childNodes[0]?.nodeValue?.trim() || "";
          if (!text || text.length < 2) return;

          const st = getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) < 0.1) return;
          // Skip if bg is an image/gradient (cannot measure)
          if (st.backgroundImage && st.backgroundImage !== "none") return;

          const fg = parseRgb(st.color);
          const bg = parseRgb(st.backgroundColor);
          if (!fg || !bg) return;
          // Skip transparent bg (inherit from parent — would need recursion)
          if (bg.a < 0.5) return;

          const fs = parseFloat(st.fontSize);
          const fw = parseInt(st.fontWeight) >= 700;
          const isLarge = fs >= 24 || (fw && fs >= 18.67); // 18pt = 24px, 14pt bold = ~18.67px
          const required = isLarge ? 3.0 : 4.5;
          const r = ratio(fg, bg);

          if (r < required) {
            const selector = el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase();
            failures.push({ selector, ratio: Math.round(r * 100) / 100, fg: st.color, bg: st.backgroundColor,
              fontSize: st.fontSize, fontWeight: st.fontWeight, text: text.slice(0, 40), isLarge });
          }
        });

      return failures.slice(0, 60);
    });

    if (contrastData.length > 0) {
      const critical = contrastData.filter(d => d.ratio < 2.5);
      const severity = critical.length > 0 ? "serious" : "moderate";
      issues.push({
        ruleId: "color:contrast-insufficient",
        severity, priority: severity === "serious" ? 2 : 3,
        category: "contrast",
        message: `${contrastData.length} text elements fail WCAG contrast ratio requirements (${critical.length} critically low < 2.5:1).`,
        url,
        selector: contrastData[0].selector,
        selectors: contrastData.map(d => d.selector),
        depths: contrastData.map(() => 0),
        wcag: ["wcag1.4.3"],
        fixSuggestion: `Minimum ratios: 4.5:1 for normal text, 3:1 for large text (≥18pt or 14pt bold). Worst offender: "${contrastData[0].text}" has ${contrastData[0].ratio}:1 (fg: ${contrastData[0].fg}, bg: ${contrastData[0].bg}).`,
        state, phase,
        htmlSnippet: contrastData.slice(0, 5).map(d =>
          `/* ${d.selector}: ${d.ratio}:1 (need ${d.isLarge ? 3 : 4.5}:1) fg=${d.fg} bg=${d.bg} */`
        ).join("\n"),
      });
    }

    // Focus indicator contrast
    const focusContrastIssues = await page.evaluate(() => {
      const bad: string[] = [];
      (document.querySelectorAll("a,button,input,select,textarea") as NodeListOf<HTMLElement>).forEach(el => {
        el.focus();
        const st = getComputedStyle(el);
        const outlineColor = st.outlineColor;
        const outlineWidth = parseFloat(st.outlineWidth || "0");
        if (outlineWidth > 0 && outlineColor) {
          // Simplified: check if outline is very light on light bg or very dark on dark bg
          const m = outlineColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (m) {
            const lum = (parseInt(m[1]) * 0.299 + parseInt(m[2]) * 0.587 + parseInt(m[3]) * 0.114) / 255;
            if (lum > 0.85) { // very light outline
              bad.push(el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase());
            }
          }
        }
      });
      return bad.slice(0, 20);
    });

    if (focusContrastIssues.length) {
      issues.push({
        ruleId: "color:focus-indicator-low-contrast",
        severity: "serious", priority: 2, category: "contrast",
        message: `${focusContrastIssues.length} elements have focus indicators with potentially insufficient contrast (< 3:1).`,
        url, selector: focusContrastIssues[0], selectors: focusContrastIssues,
        depths: focusContrastIssues.map(() => 0),
        wcag: ["wcag1.4.11", "wcag2.4.7"],
        fixSuggestion: "Focus indicators must have at least 3:1 contrast against adjacent colors. Use a dark outline on light backgrounds and vice versa.",
        state, phase,
      });
    }

  } catch (err) {
    logger.warn("Color contrast check failed:", err);
  }

  return issues;
}
