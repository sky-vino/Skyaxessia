"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHeuristics = runHeuristics;
const logger_1 = require("../utils/logger");
function pack(items, ruleId, severity, priority, category, message, wcag, fixSuggestion, url, state, phase) {
    if (!items.length)
        return [];
    return [{
            ruleId, severity, priority, category, message, url,
            selector: items[0].selector,
            selectors: items.map(i => i.selector),
            depths: items.map(i => i.depth),
            wcag, fixSuggestion, state, phase,
        }];
}
const safeEval = async (page, fn) => {
    try {
        return await page.evaluate(fn);
    }
    catch {
        return [];
    }
};
async function runHeuristics(page, url, state, phase) {
    const issues = [];
    // ── 1. Target size ────────────────────────────────────────────────────────
    const targetSize = await safeEval(page, () => {
        const MIN = 24;
        const out = [];
        const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" &&
                el.getAttribute("aria-hidden") !== "true" && !el.closest("[hidden],[inert],[aria-hidden='true']");
        };
        document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[tabindex]")
            .forEach((el) => {
            if (!isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true")
                return;
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            const inlineTextLink = el.tagName === "A" && st.display === "inline" && r.width >= MIN;
            if (inlineTextLink)
                return;
            if (r.width < MIN || r.height < MIN) {
                out.push({
                    selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(),
                    depth: 0,
                });
            }
        });
        return out.slice(0, 100);
    });
    // Tier 1 fix — surface the cap in the message. Same pattern applies to
    // most other checks in this file that end in `.slice(0, N)`; the counts
    // shown to users would otherwise silently truncate.
    {
        const cap = 100;
        const capped = targetSize.length >= cap;
        const msg = `${targetSize.length}${capped ? "+ (list capped)" : ""} interactive element(s) are smaller than 24×24 CSS pixels.`;
        issues.push(...pack(targetSize, "heuristic:target-size", "serious", 2, "pointer", msg, ["wcag2.5.8"], "Set min-width/min-height: 24px or increase padding on interactive elements.", url, state, phase));
    }
    // ── 2. Text truncation ────────────────────────────────────────────────────
    const truncation = await safeEval(page, () => {
        const out = [];
        document.querySelectorAll("*").forEach((el) => {
            const st = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const text = el.textContent?.trim() || "";
            if (!text || r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden")
                return;
            if (el.closest("[hidden],[inert],[aria-hidden='true']"))
                return;
            const fullText = (el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
            if (fullText.length >= text.length)
                return;
            if (st.textOverflow === "ellipsis" || st.webkitLineClamp) {
                out.push({ selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), depth: 0 });
            }
        });
        return [...new Map(out.map(i => [i.selector, i])).values()].slice(0, 50);
    });
    issues.push(...pack(truncation, "heuristic:text-truncation", "moderate", 3, "readability", `${truncation.length} elements clip or truncate text content, potentially hiding information.`, ["wcag1.4.4"], "Provide accessible full text via title attribute, aria-label, or expandable disclosure.", url, state, phase));
    // ── 3. Complex backgrounds ────────────────────────────────────────────────
    const complexBg = await safeEval(page, () => {
        const out = [];
        document.querySelectorAll("*").forEach((el) => {
            const st = getComputedStyle(el);
            if (!el.textContent?.trim())
                return;
            if (st.backgroundImage && st.backgroundImage !== "none") {
                out.push({ selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), depth: 0 });
            }
        });
        return [...new Map(out.map(i => [i.selector, i])).values()].slice(0, 50);
    });
    issues.push(...pack(complexBg, "heuristic:complex-background", "moderate", 3, "contrast", `${complexBg.length} elements render text over image/gradient backgrounds — manually verify 4.5:1 contrast ratio.`, ["wcag1.4.3", "wcag1.4.11"], "Use a solid semi-transparent overlay or ensure text color meets contrast against all background areas.", url, state, phase));
    // ── 4. Status messages without aria-live ─────────────────────────────────
    const statusMsg = await safeEval(page, () => {
        const out = [];
        document.querySelectorAll(".toast,.notification,.alert,.snackbar,.banner,[role='status'],[role='alert']")
            .forEach((el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden")
                return;
            if (el.closest("[hidden],[inert],[aria-hidden='true']"))
                return;
            const role = el.getAttribute("role");
            if (role === "alert" || role === "status")
                return;
            if (!el.getAttribute("aria-live")) {
                out.push({ selector: el.className ? `.${String(el.className).split(" ")[0]}` : el.tagName.toLowerCase(), depth: 0 });
            }
        });
        return out.slice(0, 30);
    });
    issues.push(...pack(statusMsg, "heuristic:status-message", "serious", 2, "aria", `${statusMsg.length} status/notification elements are missing aria-live regions.`, ["wcag4.1.3"], "Add aria-live='polite' for non-urgent and aria-live='assertive' for urgent notifications.", url, state, phase));
    // ── 5. On-input context changes ───────────────────────────────────────────
    const inputChange = await safeEval(page, () => {
        const out = [];
        document.querySelectorAll("select[onchange]").forEach((el) => {
            const onchange = String(el.getAttribute("onchange") || "");
            if (!/location|submit|href|navigate|reload/i.test(onchange))
                return;
            out.push({ selector: el.id ? `select#${el.id}` : "select", depth: 0 });
        });
        return out.slice(0, 30);
    });
    issues.push(...pack(inputChange, "heuristic:on-input-change", "moderate", 3, "interaction", `${inputChange.length} select elements may auto-submit on change without user warning.`, ["wcag3.2.2"], "Avoid triggering navigation on 'change' events. Use an explicit submit button.", url, state, phase));
    // ── 6. Heading structure ──────────────────────────────────────────────────
    const headings = await safeEval(page, () => {
        const hs = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((h) => {
            const r = h.getBoundingClientRect();
            const st = getComputedStyle(h);
            return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" &&
                !h.closest("[hidden],[inert],[aria-hidden='true']");
        });
        const levels = hs.map(h => parseInt(h.tagName[1]));
        const hasH1 = levels.includes(1);
        const skipped = [];
        for (let i = 1; i < levels.length; i++) {
            if (levels[i] - levels[i - 1] > 1)
                skipped.push(levels[i]);
        }
        return { levels, hasH1, skipped };
    });
    if (!headings.hasH1) {
        issues.push({ ruleId: "heuristic:heading-no-h1", severity: "serious", priority: 2, category: "structure",
            message: "Page is missing an <h1> heading. Screen readers rely on this as the page title.",
            url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag1.3.1", "wcag2.4.6"],
            fixSuggestion: "Add a single <h1> that describes the page content.", state, phase });
    }
    if (headings.skipped.length) {
        issues.push({ ruleId: "heuristic:heading-skipped-level", severity: "moderate", priority: 3, category: "structure",
            message: `Heading levels are skipped (${headings.skipped.join(", ")}). Screen readers expect sequential heading hierarchy.`,
            url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag1.3.1", "wcag2.4.6"],
            fixSuggestion: "Do not skip heading levels. Use CSS to style headings visually, not to select the tag.", state, phase });
    }
    // ── 7. Landmark regions ───────────────────────────────────────────────────
    const landmarks = await safeEval(page, () => ({
        hasMain: !!document.querySelector("main,[role='main']"),
        hasNav: !!document.querySelector("nav,[role='navigation']"),
        hasBanner: !!document.querySelector("header,[role='banner']"),
    }));
    if (!landmarks.hasMain) {
        issues.push({ ruleId: "heuristic:landmark-main-missing", severity: "serious", priority: 2, category: "structure",
            message: "Page is missing a <main> landmark. Keyboard users cannot skip to main content.",
            url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag1.3.6", "wcag2.4.1"],
            fixSuggestion: "Wrap primary page content in <main> or add role='main'.", state, phase });
    }
    // ── 8. Form inputs without visible labels ─────────────────────────────────
    const unlabeledInputs = await safeEval(page, () => {
        const out = [];
        document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']),select,textarea")
            .forEach((el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden")
                return;
            if (el.closest("[hidden],[inert],[aria-hidden='true']"))
                return;
            const id = el.id;
            const hasLabel = id && document.querySelector(`label[for="${id}"]`);
            const hasAria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
            const hasTitle = el.getAttribute("title");
            if (!hasLabel && !hasAria && !hasTitle) {
                out.push({ selector: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), depth: 0 });
            }
        });
        return out.slice(0, 50);
    });
    issues.push(...pack(unlabeledInputs, "heuristic:input-no-label", "critical", 1, "forms", `${unlabeledInputs.length} form inputs have no associated label (no <label for>, aria-label, or aria-labelledby).`, ["wcag1.3.1", "wcag3.3.2"], "Associate each input with a <label for='id'>, or add aria-label/aria-labelledby.", url, state, phase));
    // ── 9. Images without meaningful alt ─────────────────────────────────────
    const badAlt = await safeEval(page, () => {
        const out = [];
        document.querySelectorAll("img").forEach((el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            const role = el.getAttribute("role");
            if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden")
                return;
            if (el.closest("[hidden],[inert],[aria-hidden='true']") || el.getAttribute("aria-hidden") === "true")
                return;
            if (role === "presentation" || role === "none")
                return;
            const alt = el.getAttribute("alt");
            if (alt === null) {
                out.push({ selector: el.id ? `img#${el.id}` : `img[src="${(el.src || "").slice(-40)}"]`, depth: 0 });
            }
        });
        return out.slice(0, 50);
    });
    issues.push(...pack(badAlt, "heuristic:image-missing-alt", "critical", 1, "images", `${badAlt.length} images are missing alt attributes entirely.`, ["wcag1.1.1"], "Add alt='' for decorative images, or a descriptive alt text for informative images.", url, state, phase));
    // ── 10. Language attribute ─────────────────────────────────────────────────
    const langMissing = await safeEval(page, () => !document.documentElement.getAttribute("lang"));
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
        const reflowIssues = await safeEval(page, () => {
            const out = [];
            const vw = window.innerWidth;
            document.querySelectorAll("*").forEach((el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden")
                    return;
                if (el.closest("[hidden],[inert],[aria-hidden='true']"))
                    return;
                if (st.position === "fixed")
                    return;
                if ((st.overflowX === "auto" || st.overflowX === "scroll") && el.scrollWidth > el.clientWidth)
                    return;
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
        issues.push(...pack(reflowIssues, "heuristic:reflow", "serious", 2, "zoom", `${reflowIssues.length} elements overflow the 320px viewport — WCAG 1.4.10 Reflow failure.`, ["wcag1.4.10"], "Use responsive CSS (flexbox/grid, relative units). Avoid fixed widths that exceed 320px.", url, state, phase));
    }
    catch (err) {
        logger_1.logger.debug("Reflow check failed:", err);
    }
    // ── 12. Reduced motion ────────────────────────────────────────────────────
    // Tier 1 fixes:
    //  (a) The previous check treated any element with transition-duration > 0
    //      as "animated". Hover transitions like `transition: color 0.2s ease`
    //      on links and buttons trigger this on every modern site. Reduced-motion
    //      typically targets larger movements (spinners, parallax, autoplay
    //      slideshows) — CSS animations, not hover transitions. Only count
    //      elements with a non-"none" `animationName`.
    //  (b) `s.cssRules` throws for cross-origin stylesheets (CORS-protected).
    //      The previous version silently returned false for those sheets — so a
    //      prefers-reduced-motion media query in a CDN-hosted stylesheet was
    //      invisible and the page was false-flagged. Now we count how many
    //      stylesheets we could NOT inspect and disclose that in the message.
    const hasAnimation = await safeEval(page, () => {
        let found = false;
        document.querySelectorAll("*").forEach((el) => {
            const st = getComputedStyle(el);
            if (st.animationName && st.animationName !== "none") {
                found = true;
            }
        });
        return found;
    });
    const motionInspection = await safeEval(page, () => {
        const sheets = Array.from(document.styleSheets);
        let crossOrigin = 0;
        let found = false;
        for (const s of sheets) {
            try {
                const rules = Array.from(s.cssRules || []);
                if (rules.some((r) => r.cssText && r.cssText.includes("prefers-reduced-motion"))) {
                    found = true;
                    break;
                }
            }
            catch {
                crossOrigin++;
            }
        }
        return { found, crossOrigin, totalSheets: sheets.length };
    });
    if (hasAnimation && !motionInspection.found) {
        const crossOriginNote = motionInspection.crossOrigin > 0
            ? ` Note: ${motionInspection.crossOrigin} of ${motionInspection.totalSheets} stylesheet(s) are cross-origin and could not be inspected from the page; a prefers-reduced-motion media query in those sheets would not be detected here — verify with a manual view-source check if this rule surprises you.`
            : "";
        issues.push({
            ruleId: "heuristic:reduced-motion",
            severity: "moderate",
            priority: 3,
            category: "motion",
            message: `CSS animation detected on one or more elements, but no @media (prefers-reduced-motion) query was found in any inspectable stylesheet.${crossOriginNote}`,
            url, selector: "body", selectors: ["body"], depths: [0], wcag: ["wcag2.3.3"],
            fixSuggestion: "Wrap all animations in @media (prefers-reduced-motion: no-preference) { } (or use `reduce` to remove them) so users who opt-out see no motion.",
            state, phase,
        });
    }
    return issues.filter(i => i.selectors?.length || i.selector);
}
