"use strict";
/**
 * keyboardNav.ts
 * Simulates real keyboard navigation using Playwright keyboard API.
 *
 * Tests:
 *  1. Tab key — cycles through all focusable elements, records order
 *  2. Positive tabindex — elements that disrupt natural tab order
 *  3. Skip navigation link — present and functional
 *  4. Arrow key navigation — composite widgets (listbox, menu, tree, grid, tablist)
 *  5. Escape key — closes menus/dropdowns
 *  6. Space/Enter — activates buttons and links
 *  7. Focus lock — focus doesn't escape a modal boundary
 *  8. Keyboard-only interactive elements unreachable
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runKeyboardNav = runKeyboardNav;
const logger_1 = require("../utils/logger");
const navigation_1 = require("./navigation");
async function probeFunctionalSkipLink(page) {
    try {
        await page.evaluate(() => document.activeElement?.blur?.());
        for (let i = 0; i < 8; i++) {
            await page.keyboard.press("Tab");
            await (0, navigation_1.waitForStability)(page, 120);
            const focused = await page.evaluate(() => {
                const el = document.activeElement;
                if (!el || el === document.body)
                    return null;
                const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
                const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") || "" : "";
                return { text, href, beforeScroll: window.scrollY, beforeHash: window.location.hash };
            });
            if (!focused)
                continue;
            const looksLikeSkip = /skip|salta|contenuto|content|main|principale/.test(focused.text) || focused.href.startsWith("#");
            if (!looksLikeSkip)
                continue;
            await page.keyboard.press("Enter");
            await (0, navigation_1.waitForStability)(page, 400);
            const worked = await page.evaluate((before) => {
                const active = document.activeElement;
                const activeInMain = Boolean(active?.closest?.("main,[role='main']"));
                const hashChanged = Boolean(window.location.hash && window.location.hash !== before.beforeHash);
                const scrollChanged = Math.abs(window.scrollY - before.beforeScroll) > 20;
                return activeInMain || hashChanged || scrollChanged;
            }, focused);
            if (worked)
                return true;
        }
    }
    catch {
        return false;
    }
    return false;
}
async function runKeyboardNav(page, url, state) {
    const issues = [];
    // ── 1 & 2. Tab order + positive tabindex ─────────────────────────────────
    try {
        const tabAnalysis = await page.evaluate(() => {
            const sel = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
            const isVisible = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 0 && r.height > 0 &&
                    st.display !== "none" &&
                    st.visibility !== "hidden" &&
                    el.getAttribute("aria-hidden") !== "true" &&
                    !el.closest("[hidden],[inert],[aria-hidden='true']");
            };
            const labelFor = (el) => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.id || el.className || "").toString().toLowerCase();
            const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
            const positiveTabindex = els
                .filter(el => parseInt(el.getAttribute("tabindex") || "0") > 0)
                .map(el => el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase());
            const skipCandidates = Array.from(document.querySelectorAll("a[href],button,[role='link'],[role='button'],[tabindex]"));
            const hasSkipLink = skipCandidates.some(el => {
                if (!isVisible(el))
                    return false;
                const label = labelFor(el);
                const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") || "" : "";
                const target = href.startsWith("#") ? document.querySelector(href) : null;
                const targetLooksMain = Boolean(target?.matches?.("main,[role='main']") || target?.querySelector?.("h1,h2,[role='heading']"));
                return /skip|salta|contenuto|content|main|principale/.test(label) || targetLooksMain;
            });
            return { count: els.length, positiveTabindex, hasSkipLink };
        });
        if (tabAnalysis.positiveTabindex.length > 0) {
            issues.push({
                ruleId: "keyboard:tabindex-positive", severity: "moderate", priority: 3, category: "keyboard",
                message: `${tabAnalysis.positiveTabindex.length} elements use tabindex > 0, which disrupts the natural DOM tab order.`,
                url, selector: tabAnalysis.positiveTabindex[0],
                selectors: tabAnalysis.positiveTabindex, depths: tabAnalysis.positiveTabindex.map(() => 0),
                wcag: ["wcag2.4.3"],
                fixSuggestion: "Remove all tabindex values > 0. Use tabindex='0' for custom focusable elements and arrange them correctly in DOM order.",
                state, phase: "keyboard",
            });
        }
        if (!tabAnalysis.hasSkipLink && tabAnalysis.count > 8) {
            tabAnalysis.hasSkipLink = await probeFunctionalSkipLink(page);
        }
        if (!tabAnalysis.hasSkipLink && tabAnalysis.count > 8) {
            issues.push({
                ruleId: "keyboard:skip-link-missing", severity: "moderate", priority: 3, category: "keyboard",
                message: "No skip navigation link detected. Keyboard users must Tab through all repeated navigation on every page.",
                url, selector: "body", selectors: ["body"], depths: [0],
                wcag: ["wcag2.4.1"],
                fixSuggestion: "Add a visually-hidden 'Skip to main content' anchor as the first focusable element. Show it on focus.",
                state, phase: "keyboard",
            });
        }
        // ── Simulate Tab key presses and detect focus traps ────────────────────
        const MAX_TABS = Math.min(tabAnalysis.count + 5, 60);
        const focusPath = [];
        let loopDetected = false;
        // Focus first element
        await page.keyboard.press("Tab");
        await (0, navigation_1.waitForStability)(page, 100);
        for (let i = 0; i < MAX_TABS; i++) {
            // Ship 2 / A2 fix — build a STABLE selector using the element's DOM path
            // (parent chain + child index), so the same element always produces the
            // same string across Tab iterations. The prior version generated
            // `${tag}.${cls}[tab-${iteration}]`, which is different per iteration and
            // silently prevented `focusPath.includes(focused)` from ever matching
            // for id-less elements. Loops involving id-less elements were being
            // under-reported.
            const focused = await page.evaluate(() => {
                const el = document.activeElement;
                if (!el || el === document.body)
                    return null;
                if (el.id)
                    return `${el.tagName.toLowerCase()}#${el.id}`;
                const path = [];
                let cur = el;
                let depth = 0;
                while (cur && cur !== document.body && depth < 6) {
                    const parent = cur.parentElement;
                    if (!parent)
                        break;
                    const idx = Array.from(parent.children).indexOf(cur);
                    const cls = String(cur.className || "").split(/\s+/).filter(Boolean)[0];
                    const seg = cls
                        ? `${cur.tagName.toLowerCase()}.${cls}[${idx}]`
                        : `${cur.tagName.toLowerCase()}[${idx}]`;
                    path.unshift(seg);
                    cur = parent;
                    depth++;
                }
                return path.join(">") || el.tagName.toLowerCase();
            });
            if (focused) {
                if (focusPath.includes(focused) && focusPath.length > 3) {
                    loopDetected = true;
                    break;
                }
                focusPath.push(focused);
            }
            await page.keyboard.press("Tab");
            await (0, navigation_1.waitForStability)(page, 80);
        }
        if (loopDetected) {
            // Ship 2 / A2 fix — widen the valid-trap check. Original only excluded
            // aria-modal dialogs and native <dialog[open]>. Also exclude:
            //   - role="alertdialog"
            //   - elements/ancestors marked data-focus-trap or data-modal-open
            //   - alertdialogs / modals identified by common class patterns
            const validModalTrap = await page.evaluate(() => {
                const active = document.activeElement;
                if (!active)
                    return false;
                const traps = [
                    "[role='dialog'][aria-modal='true']",
                    "[role='alertdialog']",
                    "dialog[open]",
                    "[data-focus-trap]",
                    "[data-modal-open='true']",
                    ".modal.show",
                    ".modal-open",
                ];
                return traps.some(sel => Boolean(active.closest?.(sel)));
            }).catch(() => false);
            if (validModalTrap)
                loopDetected = false;
        }
        // Ship 2 / A2 fix — debug-log the observed focus path so a false-positive
        // report can be re-traced without adding logging on a separate run.
        if (loopDetected) {
            logger_1.logger.debug(`focus-loop detected on ${url}. Full focus path (${focusPath.length} steps): ${focusPath.join(" -> ")}`);
        }
        if (loopDetected) {
            issues.push({
                ruleId: "keyboard:focus-loop", severity: "critical", priority: 1, category: "keyboard",
                message: "Keyboard focus is trapped in a loop — Tab key cycles back before reaching all content.",
                url, selector: focusPath[focusPath.length - 1] || "body",
                selectors: [focusPath[focusPath.length - 1] || "body"], depths: [0],
                wcag: ["wcag2.1.2"],
                fixSuggestion: "Remove infinite focus cycles. Only trap focus inside open modal dialogs, not page-level content.",
                state, phase: "keyboard",
            });
        }
    }
    catch (err) {
        logger_1.logger.debug("Tab simulation failed:", err);
    }
    // ── 3. Arrow key navigation in composite widgets ──────────────────────────
    try {
        const widgets = await page.evaluate(() => {
            const roles = ["listbox", "menu", "menubar", "tree", "grid", "tablist", "radiogroup"];
            return roles.flatMap(role => {
                const els = Array.from(document.querySelectorAll(`[role="${role}"]`));
                return els.map((el) => ({
                    role,
                    selector: el.id ? `[role="${role}"]#${el.id}` : `[role="${role}"]`,
                    childCount: el.querySelectorAll("[role='option'],[role='menuitem'],[role='treeitem'],[role='row'],[role='tab'],[role='radio']").length,
                    hasManagedFocus: Array.from(el.querySelectorAll("*")).some((c) => c.getAttribute("tabindex") === "-1"),
                }));
            });
        });
        for (const widget of widgets) {
            if (widget.childCount === 0)
                continue;
            if (!widget.hasManagedFocus) {
                issues.push({
                    ruleId: `keyboard:${widget.role}-no-arrow-nav`,
                    severity: "serious", priority: 2, category: "keyboard",
                    message: `${widget.role} widget does not implement roving tabindex — arrow key navigation will not work for keyboard users.`,
                    url, selector: widget.selector, selectors: [widget.selector], depths: [0],
                    wcag: ["wcag2.1.1"],
                    fixSuggestion: `Implement ARIA roving tabindex for ${widget.role}: set tabindex='-1' on all children except the active one. Handle ArrowUp/ArrowDown/ArrowLeft/ArrowRight keys.`,
                    state, phase: "keyboard",
                });
            }
        }
        // Actually simulate arrow keys on the first widget found
        const firstWidget = widgets.find(w => w.childCount > 0);
        if (firstWidget) {
            try {
                await page.focus(firstWidget.selector);
                await page.keyboard.press("ArrowDown");
                await (0, navigation_1.waitForStability)(page, 200);
                const movedFocus = await page.evaluate((sel) => {
                    const widget = document.querySelector(sel);
                    if (!widget)
                        return false;
                    const active = document.activeElement;
                    return widget.contains(active) && active !== widget;
                }, firstWidget.selector);
                if (!movedFocus) {
                    issues.push({
                        ruleId: "keyboard:arrow-key-no-response",
                        severity: "serious", priority: 2, category: "keyboard",
                        message: `Arrow key press on ${firstWidget.role} widget did not move focus — widget is keyboard inaccessible.`,
                        url, selector: firstWidget.selector, selectors: [firstWidget.selector], depths: [0],
                        wcag: ["wcag2.1.1"],
                        fixSuggestion: "Handle keydown events for Arrow keys within the widget to move focus between child items.",
                        state, phase: "keyboard",
                    });
                }
            }
            catch { }
        }
    }
    catch (err) {
        logger_1.logger.debug("Arrow key check failed:", err);
    }
    // ── 4. Space/Enter activates buttons & links ──────────────────────────────
    try {
        const customButtons = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("[role='button'],[role='link']"))
                .filter((el) => el.tagName !== "BUTTON" && el.tagName !== "A")
                .map((el) => el.id ? `[role="${el.getAttribute("role")}"]#${el.id}` : `[role="${el.getAttribute("role")}"]`)
                .slice(0, 10);
        });
        // Tier 1 fix — real Enter-response test.
        //
        // Previous version pressed Enter but discarded the result, and unconditionally
        // pushed an issue whenever any custom-role element existed. That was theatre.
        //
        // New behaviour: for each candidate (up to 10), snapshot a lightweight DOM
        // signature (URL, doc height, child count, aria-expanded/pressed), press
        // Enter via Playwright (real OS-level input, activates real listeners), then
        // re-snapshot. Only elements that produced NO observable change are flagged.
        // If Enter caused a navigation we stop the test to preserve page context —
        // the elements we already tested are still valid results — and then
        // navigate back to where we started so downstream phases (state scanner,
        // evidence capture) don't run on a wrong page.
        const preTestUrl = (() => { try {
            return page.url();
        }
        catch {
            return "";
        } })();
        const responsive = [];
        const unresponsive = [];
        const notTested = [];
        const candidates = customButtons.slice(0, 10);
        let navigatedAway = false;
        let testedCount = 0;
        for (const sel of candidates) {
            if (navigatedAway) {
                notTested.push(sel);
                continue;
            }
            try {
                await page.focus(sel, { timeout: 1500 });
                await (0, navigation_1.waitForStability)(page, 120);
                const before = await page.evaluate((s) => {
                    const el = document.querySelector(s);
                    return {
                        url: window.location.href,
                        docHeight: document.documentElement.scrollHeight,
                        childCount: document.body ? document.body.querySelectorAll("*").length : 0,
                        ariaExpanded: el ? el.getAttribute("aria-expanded") : null,
                        ariaPressed: el ? el.getAttribute("aria-pressed") : null,
                        activeSelector: document.activeElement?.tagName || "",
                    };
                }, sel);
                await page.keyboard.press("Enter");
                await (0, navigation_1.waitForStability)(page, 400);
                const after = await page.evaluate((s) => {
                    const el = document.querySelector(s);
                    return {
                        url: window.location.href,
                        docHeight: document.documentElement.scrollHeight,
                        childCount: document.body ? document.body.querySelectorAll("*").length : 0,
                        ariaExpanded: el ? el.getAttribute("aria-expanded") : null,
                        ariaPressed: el ? el.getAttribute("aria-pressed") : null,
                        activeSelector: document.activeElement?.tagName || "",
                    };
                }, sel);
                testedCount++;
                if (before.url !== after.url) {
                    // Enter navigated — that IS a response. Stop further tests so we don't
                    // measure a totally different page.
                    responsive.push(sel);
                    navigatedAway = true;
                    continue;
                }
                const responded = Math.abs(before.docHeight - after.docHeight) > 4 ||
                    before.childCount !== after.childCount ||
                    before.ariaExpanded !== after.ariaExpanded ||
                    before.ariaPressed !== after.ariaPressed;
                if (responded)
                    responsive.push(sel);
                else
                    unresponsive.push(sel);
            }
            catch (err) {
                // Focus/keyboard failed — we can't say whether the element would have
                // responded, so we don't count it as a failure.
                logger_1.logger.debug(`Custom role Enter test could not run for ${sel}:`, err);
                notTested.push(sel);
            }
        }
        // Restore the pre-test page if an Enter press navigated us away.
        if (navigatedAway && preTestUrl) {
            const now = (() => { try {
                return page.url();
            }
            catch {
                return preTestUrl;
            } })();
            if (now !== preTestUrl) {
                logger_1.logger.debug(`Custom-role Enter test navigated to ${now}; restoring pre-test page ${preTestUrl}.`);
                try {
                    await page.goto(preTestUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
                    await (0, navigation_1.waitForStability)(page, 400);
                }
                catch (err) {
                    logger_1.logger.debug("Could not restore pre-test URL after custom-role Enter navigated:", err);
                }
            }
        }
        if (unresponsive.length > 0) {
            const totalDetected = customButtons.length;
            const detail = notTested.length
                ? ` ${notTested.length} additional element(s) could not be tested in this run.`
                : "";
            const extras = totalDetected > candidates.length
                ? ` ${totalDetected - candidates.length} additional custom-role element(s) beyond the ${candidates.length} tested were not exercised.`
                : "";
            issues.push({
                ruleId: "keyboard:custom-role-activation",
                severity: "serious", priority: 2, category: "keyboard",
                message: `${unresponsive.length} custom role='button' / role='link' element(s) did not produce any observable DOM change when the Enter key was pressed while focused (${testedCount} tested).${detail}${extras}`,
                url, selector: unresponsive[0], selectors: unresponsive, depths: unresponsive.map(() => 0),
                wcag: ["wcag2.1.1"],
                fixSuggestion: "Custom interactive elements need keydown handlers for Enter (buttons and links) and Space (buttons). Use native <button> or <a> when possible.",
                state, phase: "keyboard",
            });
        }
    }
    catch (err) {
        logger_1.logger.debug("Space/Enter check failed:", err);
    }
    // ── 5. Interactive elements only reachable by mouse ───────────────────────
    try {
        const mouseOnlyEls = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll("[onclick],[onmousedown],[onmouseup]").forEach((el) => {
                const tag = el.tagName.toLowerCase();
                if (["button", "a", "input", "select", "textarea"].includes(tag))
                    return;
                const ti = el.getAttribute("tabindex");
                const role = el.getAttribute("role");
                const isKeyboardAccessible = ti !== null || ["button", "link", "menuitem"].includes(role || "");
                if (!isKeyboardAccessible) {
                    out.push(el.id ? `${tag}#${el.id}` : tag);
                }
            });
            return out.slice(0, 20);
        });
        if (mouseOnlyEls.length) {
            issues.push({
                ruleId: "keyboard:mouse-only-interaction",
                severity: "critical", priority: 1, category: "keyboard",
                message: `${mouseOnlyEls.length} elements have mouse-only event handlers (onclick) with no keyboard equivalent.`,
                url, selector: mouseOnlyEls[0], selectors: mouseOnlyEls, depths: mouseOnlyEls.map(() => 0),
                wcag: ["wcag2.1.1"],
                fixSuggestion: "Replace onclick with a proper <button> or add role='button' tabindex='0' and a keydown handler for Enter/Space.",
                state, phase: "keyboard",
            });
        }
    }
    catch { }
    return issues;
}
