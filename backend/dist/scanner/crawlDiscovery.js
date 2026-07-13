"use strict";
/**
 * Post-login URL discovery for crawl mode.
 * BFS over same-origin links with optional glob-style include/exclude patterns.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalUrlKey = canonicalUrlKey;
exports.normalizeHttpUrl = normalizeHttpUrl;
exports.passesCrawlFilters = passesCrawlFilters;
exports.discoverOutboundLinks = discoverOutboundLinks;
exports.planCrawlUrls = planCrawlUrls;
/** Canonical key for de-duplication (no hash, normalized host/path). */
function canonicalUrlKey(raw) {
    try {
        const u = new URL(raw);
        u.hash = "";
        const host = u.hostname.toLowerCase();
        const path = u.pathname.replace(/\/+$/, "") || "/";
        return `${host}${path}${u.search}`;
    }
    catch {
        return null;
    }
}
function normalizeHttpUrl(href, base) {
    try {
        const u = new URL(href, base);
        if (u.protocol !== "http:" && u.protocol !== "https:")
            return null;
        u.hash = "";
        return u.href;
    }
    catch {
        return null;
    }
}
function globToRegExp(pattern) {
    const trimmed = pattern.trim();
    if (!trimmed)
        return /^$/;
    const escaped = trimmed
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "{{GLOBSTAR}}")
        .replace(/\*/g, "[^#?]*")
        .replace(/\{\{GLOBSTAR\}\}/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
}
function matchesAnyPattern(url, patterns) {
    if (!patterns?.length)
        return false;
    for (const p of patterns) {
        const t = p.trim();
        if (!t)
            continue;
        if (t.includes("*")) {
            if (globToRegExp(t).test(url))
                return true;
        }
        else if (url.toLowerCase().includes(t.toLowerCase())) {
            return true;
        }
    }
    return false;
}
function passesCrawlFilters(url, seedUrl, opts) {
    if (matchesAnyPattern(url, opts.crawl_exclude_patterns))
        return false;
    const include = opts.crawl_include_patterns?.filter(p => p.trim());
    if (include?.length && !matchesAnyPattern(url, include))
        return false;
    if (opts.crawl_same_domain !== false) {
        try {
            const u = new URL(url);
            const s = new URL(seedUrl);
            if (u.hostname.toLowerCase() !== s.hostname.toLowerCase())
                return false;
        }
        catch {
            return false;
        }
    }
    return true;
}
async function discoverOutboundLinks(page, baseUrl) {
    const hrefs = await page.evaluate(() => {
        const out = [];
        const sel = "a[href], area[href], link[href]";
        document.querySelectorAll(sel).forEach((el) => {
            const href = el.getAttribute("href");
            if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:"))
                return;
            if (href.trim().startsWith("#"))
                return;
            out.push(href);
        });
        return out;
    });
    const seen = new Set();
    const resolved = [];
    for (const h of hrefs) {
        const abs = normalizeHttpUrl(h, baseUrl);
        if (!abs)
            continue;
        const key = canonicalUrlKey(abs);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        resolved.push(abs);
    }
    return resolved;
}
/**
 * Breadth-first plan of URLs to scan. Seed is depth 0.
 * Expands links from a page only when depth < crawl_depth (max link hops from seed).
 */
function planCrawlUrls(opts) {
    const maxPages = Math.min(Math.max(1, opts.crawl_max_pages ?? 30), 200);
    const maxLinkHops = Math.max(0, Math.min(opts.crawl_depth ?? 2, 10));
    return { maxPages, maxLinkHops };
}
