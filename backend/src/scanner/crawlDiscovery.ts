/**
 * Post-login URL discovery for crawl mode.
 * BFS over same-origin links with optional glob-style include/exclude patterns.
 */

import type { ScanOptions } from "./types";

/** Canonical key for de-duplication (no hash, normalized host/path). */
export function canonicalUrlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function normalizeHttpUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) return /^$/;
  const escaped = trimmed
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^#?]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAnyPattern(url: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  for (const p of patterns) {
    const t = p.trim();
    if (!t) continue;
    if (t.includes("*")) {
      if (globToRegExp(t).test(url)) return true;
    } else if (url.toLowerCase().includes(t.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function passesCrawlFilters(
  url: string,
  seedUrl: string,
  opts: Pick<ScanOptions, "crawl_same_domain" | "crawl_include_patterns" | "crawl_exclude_patterns">
): boolean {
  if (matchesAnyPattern(url, opts.crawl_exclude_patterns)) return false;

  const include = opts.crawl_include_patterns?.filter(p => p.trim());
  if (include?.length && !matchesAnyPattern(url, include)) return false;

  if (opts.crawl_same_domain !== false) {
    try {
      const u = new URL(url);
      const s = new URL(seedUrl);
      if (u.hostname.toLowerCase() !== s.hostname.toLowerCase()) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export async function discoverOutboundLinks(page: any, baseUrl: string): Promise<string[]> {
  const hrefs: string[] = await page.evaluate(() => {
    const out: string[] = [];
    const sel = "a[href], area[href], link[href]";
    document.querySelectorAll(sel).forEach((el: Element) => {
      const href = el.getAttribute("href");
      if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      if (href.trim().startsWith("#")) return;
      out.push(href);
    });
    return out;
  });

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const h of hrefs) {
    const abs = normalizeHttpUrl(h, baseUrl);
    if (!abs) continue;
    const key = canonicalUrlKey(abs);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    resolved.push(abs);
  }
  return resolved;
}

/**
 * Breadth-first plan of URLs to scan. Seed is depth 0.
 * Expands links from a page only when depth < crawl_depth (max link hops from seed).
 */
export function planCrawlUrls(opts: ScanOptions): { maxPages: number; maxLinkHops: number } {
  const maxPages = Math.min(Math.max(1, opts.crawl_max_pages ?? 30), 200);
  const maxLinkHops = Math.max(0, Math.min(opts.crawl_depth ?? 2, 10));
  return { maxPages, maxLinkHops };
}
