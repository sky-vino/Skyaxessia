"use strict";
/**
 * ownership.ts
 * Reads data-component, data-owner, data-source from DOM elements
 * and bubbles up to ancestors. Attaches metadata to issues.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.enrichOwnership = enrichOwnership;
async function enrichOwnership(page, issues, options = {}) {
    const { dsPrefix = "", maxPerIssue = 3, fallbackRules = [] } = options;
    const probe = [];
    issues.forEach((iss, idx) => {
        const list = Array.isArray(iss.selectors)
            ? iss.selectors
            : iss.selector ? [iss.selector] : [];
        for (const s of list.slice(0, maxPerIssue)) {
            probe.push({ sel: s, idx });
        }
    });
    if (probe.length) {
        const results = await page.evaluate(({ probe, dsPrefix }) => {
            const out = {};
            const seen = new Set();
            for (const p of probe) {
                if (seen.has(p.idx))
                    continue;
                let el = null;
                try {
                    el = document.querySelector(p.sel);
                }
                catch {
                    el = null;
                }
                if (!el)
                    continue;
                const get = (k) => el.getAttribute?.(k) || "";
                let componentId = get("data-component");
                let componentOwner = get("data-owner");
                let sourceHint = get("data-source") || get("data-file");
                let cur = el;
                while (cur && (!componentId || !componentOwner || !sourceHint)) {
                    try {
                        componentId = componentId || cur.getAttribute?.("data-component") || "";
                        componentOwner = componentOwner || cur.getAttribute?.("data-owner") || "";
                        sourceHint = sourceHint || cur.getAttribute?.("data-source")
                            || cur.getAttribute?.("data-file") || "";
                    }
                    catch { }
                    cur = cur.parentElement;
                }
                if (!componentId && dsPrefix) {
                    try {
                        const cls = (el.getAttribute("class") || "").split(/\s+/).find(c => c.startsWith(dsPrefix));
                        if (cls)
                            componentId = cls;
                    }
                    catch { }
                }
                out[p.idx] = {
                    componentId: componentId || undefined,
                    componentOwner: componentOwner || undefined,
                    sourceHint: sourceHint || undefined,
                };
                seen.add(p.idx);
            }
            return out;
        }, { probe, dsPrefix });
        Object.entries(results).forEach(([idx, o]) => {
            const i = Number(idx);
            if (!issues[i])
                return;
            issues[i].componentId = issues[i].componentId || o.componentId;
            issues[i].componentOwner = issues[i].componentOwner || o.componentOwner;
            issues[i].sourceHint = issues[i].sourceHint || o.sourceHint;
        });
    }
    const defaultRules = [
        { pattern: "sky-login-component", owner: "Identity / Login", component: "Sky login component", match: "selector" },
        { pattern: "/login", owner: "Identity / Login", component: "Login", match: "url" },
        { pattern: "/security", owner: "Identity / Login", component: "Security / OTP", match: "url" },
        { pattern: "/home", owner: "Self Care", component: "Authenticated home / Gestisci", match: "url" },
        { pattern: "/offers", owner: "Commercial Offers", component: "Offers", match: "url" },
        { pattern: "/profile", owner: "Customer Profile", component: "Profile", match: "url" },
        { pattern: "/fatture", owner: "Billing", component: "Invoices", match: "url" },
        { pattern: "fatture", owner: "Billing", component: "Invoices", match: "any" },
        { pattern: "offerte", owner: "Commercial Offers", component: "Offers", match: "any" },
        { pattern: "profilo", owner: "Customer Profile", component: "Profile", match: "any" },
    ];
    for (const issue of issues) {
        if (issue.componentOwner)
            continue;
        const match = findOwnerRule(issue, [...fallbackRules, ...defaultRules]);
        if (!match)
            continue;
        issue.componentOwner = match.owner;
        issue.componentId = issue.componentId || match.component;
        issue.sourceHint = issue.sourceHint || match.source || `owner-rule:${match.pattern}`;
    }
}
function findOwnerRule(issue, rules) {
    const selectorText = [issue.selector, ...(issue.selectors || [])].filter(Boolean).join(" ").toLowerCase();
    const urlText = String(issue.url || "").toLowerCase();
    const messageText = `${issue.ruleId || ""} ${issue.message || ""}`.toLowerCase();
    const anyText = `${urlText} ${selectorText} ${messageText}`;
    return rules.find(rule => {
        const pattern = String(rule.pattern || "").toLowerCase();
        if (!pattern)
            return false;
        if (rule.match === "url")
            return urlText.includes(pattern);
        if (rule.match === "selector")
            return selectorText.includes(pattern);
        if (rule.match === "message")
            return messageText.includes(pattern);
        return anyText.includes(pattern);
    });
}
