"use strict";
/**
 * authDiagnostics.ts
 * -----------------------------------------------------------------------------
 * Deep-diagnostic capture around the auth submit click and OTP submit click.
 *
 * Runs alongside the existing [AUTH-DIAG] logging (which captures field-fill
 * state and DOM snapshots). This module adds five additional evidence streams
 * that Sky's ops team asked for:
 *
 *   [NET-DIAG]     — every HTTP request/response during the click window,
 *                    with URL, method, status, headers, redirect chain
 *   [CONSOLE-DIAG] — browser console messages (errors, warnings, logs)
 *                    during the click window
 *   [COOKIE-DIAG]  — cookies present before vs. after the click, with
 *                    added/removed/changed diff
 *   [PAGE-DIAG]    — post-click URL, title, and DOM landmark summary
 *   [TRACE-DIAG]   — Playwright trace file (screenshots + snapshots +
 *                    network) saved to /home/data/traces and downloadable
 *                    via GET /api/scans/:id/auth-trace
 *
 * Usage in scanner.ts:
 *
 *   const diag = new AuthDiagnostics(page, this.scan.id, "accedi");
 *   await diag.startCapture();
 *   ... click Accedi and wait for transition ...
 *   await diag.stopAndLog();
 *
 * All output goes through the same logger as existing [AUTH-DIAG] lines so
 * it's grep-friendly in Azure log stream. Trace files stay under 5 MB per
 * click window on average, well within Azure App Service /home storage.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthDiagnostics = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../utils/logger");
const TRACE_DIR = process.env.TRACE_DIR || "/home/data/traces";
class AuthDiagnostics {
    constructor(page, scanId, label) {
        this.page = page;
        this.scanId = scanId;
        this.label = label;
        this.requests = [];
        this.responses = [];
        this.consoleEvents = [];
        this.framenavs = [];
        this.cookiesBefore = [];
        this.tracingActive = false;
        this.startedAt = 0;
        // Bound handlers so we can .off() them cleanly.
        this.onRequest = (req) => {
            try {
                this.requests.push({
                    url: req.url(),
                    method: req.method(),
                    resourceType: req.resourceType(),
                    isNavigationRequest: req.isNavigationRequest(),
                    postDataSize: req.postData()?.length ?? null,
                    headers: req.headers()
                });
            }
            catch { /* ignore */ }
        };
        this.onResponse = (res) => {
            try {
                this.responses.push({
                    url: res.url(),
                    status: res.status(),
                    statusText: res.statusText(),
                    fromCache: res.fromCache ? Boolean(res.fromCache()) : false,
                    timing: null,
                    headers: res.headers(),
                    serverAddr: null
                });
            }
            catch { /* ignore */ }
        };
        this.onConsole = (msg) => {
            try {
                this.consoleEvents.push({
                    type: msg.type(),
                    text: msg.text().slice(0, 500),
                    location: (() => {
                        const loc = msg.location();
                        return loc?.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : "";
                    })()
                });
            }
            catch { /* ignore */ }
        };
        this.onFrameNavigated = (frame) => {
            try {
                if (!frame.parentFrame()) {
                    this.framenavs.push({ url: frame.url(), at: Date.now() - this.startedAt });
                }
            }
            catch { /* ignore */ }
        };
        // ---------------------------------------------------------------------------
        // Helpers
        // ---------------------------------------------------------------------------
        this.hashCookie = (c) => {
            const value = String(c.value ?? "");
            return {
                name: c.name,
                domain: c.domain,
                path: c.path,
                valueLength: value.length,
                valueHash: simpleHash8(value),
                expires: c.expires ?? -1,
                httpOnly: !!c.httpOnly,
                secure: !!c.secure,
                sameSite: c.sameSite || ""
            };
        };
        this.context = page.context();
    }
    async startCapture() {
        this.startedAt = Date.now();
        logger_1.logger.info(`[NET-DIAG] Starting capture for label="${this.label}" scan=${this.scanId}`);
        // Attach listeners.
        this.page.on("request", this.onRequest);
        this.page.on("response", this.onResponse);
        this.page.on("console", this.onConsole);
        this.page.on("framenavigated", this.onFrameNavigated);
        // Start Playwright tracing (screenshots + network snapshots).
        try {
            await this.context.tracing.start({
                screenshots: true,
                snapshots: true,
                sources: false,
                title: `auth-${this.scanId}-${this.label}`
            });
            this.tracingActive = true;
            logger_1.logger.info(`[TRACE-DIAG] Playwright tracing started for label="${this.label}"`);
        }
        catch (err) {
            logger_1.logger.warn(`[TRACE-DIAG] Could not start tracing: ${err?.message || err}`);
        }
        // Snapshot cookies present at t=0.
        try {
            const cookies = await this.context.cookies();
            this.cookiesBefore = cookies.map(this.hashCookie);
            logger_1.logger.info(`[COOKIE-DIAG] Before ${this.label}: ${this.cookiesBefore.length} cookies present`);
            for (const c of this.cookiesBefore) {
                logger_1.logger.info(`[COOKIE-DIAG]   ${c.domain}${c.path} ${c.name} (${c.valueLength}B hash=${c.valueHash} httpOnly=${c.httpOnly} secure=${c.secure} sameSite=${c.sameSite})`);
            }
        }
        catch (err) {
            logger_1.logger.warn(`[COOKIE-DIAG] Could not snapshot cookies before: ${err?.message || err}`);
        }
    }
    async stopAndLog() {
        const durationMs = Date.now() - this.startedAt;
        logger_1.logger.info(`[NET-DIAG] Stopping capture for label="${this.label}" after ${durationMs}ms`);
        // Detach listeners.
        try {
            this.page.off("request", this.onRequest);
        }
        catch { /* ignore */ }
        try {
            this.page.off("response", this.onResponse);
        }
        catch { /* ignore */ }
        try {
            this.page.off("console", this.onConsole);
        }
        catch { /* ignore */ }
        try {
            this.page.off("framenavigated", this.onFrameNavigated);
        }
        catch { /* ignore */ }
        // Log frame navigations (redirect chain, in order).
        for (const nav of this.framenavs) {
            logger_1.logger.info(`[NET-DIAG] Frame navigated @+${nav.at}ms → ${nav.url}`);
        }
        // Log interesting requests/responses (mostly filter static assets).
        const interesting = this.buildRedirectChain();
        logger_1.logger.info(`[NET-DIAG] Captured ${this.requests.length} requests, ${this.responses.length} responses, ${interesting.length} interesting`);
        for (const item of interesting) {
            logger_1.logger.info(`[NET-DIAG] ────────────────────────────────────────────────────`);
            logger_1.logger.info(`[NET-DIAG] ${item.request.method} ${item.request.url}`);
            logger_1.logger.info(`[NET-DIAG]   isNavigation:  ${item.request.isNavigationRequest}`);
            logger_1.logger.info(`[NET-DIAG]   resourceType:  ${item.request.resourceType}`);
            logger_1.logger.info(`[NET-DIAG]   postBodySize:  ${item.request.postDataSize ?? "<none>"}`);
            logger_1.logger.info(`[NET-DIAG]   reqHeaders:`);
            for (const [k, v] of Object.entries(item.request.headers)) {
                if (this.isSafeHeaderToLog(k)) {
                    logger_1.logger.info(`[NET-DIAG]     ${k}: ${this.truncate(v, 300)}`);
                }
            }
            if (!item.response) {
                logger_1.logger.info(`[NET-DIAG]   → NO RESPONSE (request pending or connection failed)`);
                continue;
            }
            logger_1.logger.info(`[NET-DIAG]   → status:     ${item.response.status} ${item.response.statusText}`);
            logger_1.logger.info(`[NET-DIAG]   → fromCache:  ${item.response.fromCache}`);
            const location = item.response.headers.location || item.response.headers.Location;
            if (location) {
                logger_1.logger.info(`[NET-DIAG]   → redirect:   ${location}`);
            }
            logger_1.logger.info(`[NET-DIAG]   → respHeaders:`);
            for (const [k, v] of Object.entries(item.response.headers)) {
                if (this.isSafeHeaderToLog(k)) {
                    logger_1.logger.info(`[NET-DIAG]     ${k}: ${this.truncate(v, 300)}`);
                }
            }
            // CloudFront / bot-detection markers, called out explicitly.
            const cfMarkers = [
                "x-amz-cf-id", "x-amz-cf-pop", "cf-ray", "cf-cache-status",
                "x-akamai-transformed", "x-akam-sw-version", "server-timing",
                "x-datadome", "x-perimeterx", "x-dd-b", "x-sucuri-id",
                "server", "via"
            ];
            const markers = cfMarkers
                .map(k => [k, item.response.headers[k] || item.response.headers[k.toLowerCase()]])
                .filter(([, v]) => v);
            if (markers.length) {
                logger_1.logger.info(`[NET-DIAG]   → WAF/CDN markers:`);
                for (const [k, v] of markers) {
                    logger_1.logger.info(`[NET-DIAG]     ${k}: ${v}`);
                }
            }
        }
        // Log console events.
        logger_1.logger.info(`[CONSOLE-DIAG] ${this.consoleEvents.length} browser console events captured`);
        for (const evt of this.consoleEvents) {
            const prefix = evt.type === "error" ? "[CONSOLE-DIAG-ERR]" : "[CONSOLE-DIAG]";
            logger_1.logger.info(`${prefix}   [${evt.type}] ${evt.text}${evt.location ? ` @ ${evt.location}` : ""}`);
        }
        // Snapshot cookies at t=end and diff against t=0.
        try {
            const cookiesRaw = await this.context.cookies();
            const cookiesAfter = cookiesRaw.map(this.hashCookie);
            logger_1.logger.info(`[COOKIE-DIAG] After ${this.label}: ${cookiesAfter.length} cookies present`);
            const beforeKey = (c) => `${c.domain}|${c.path}|${c.name}`;
            const beforeMap = new Map(this.cookiesBefore.map(c => [beforeKey(c), c]));
            const afterMap = new Map(cookiesAfter.map(c => [beforeKey(c), c]));
            const added = cookiesAfter.filter(c => !beforeMap.has(beforeKey(c)));
            const removed = this.cookiesBefore.filter(c => !afterMap.has(beforeKey(c)));
            const changed = cookiesAfter.filter(c => {
                const before = beforeMap.get(beforeKey(c));
                return before && before.valueHash !== c.valueHash;
            });
            logger_1.logger.info(`[COOKIE-DIAG]   Δ added=${added.length} removed=${removed.length} changed=${changed.length}`);
            for (const c of added)
                logger_1.logger.info(`[COOKIE-DIAG]   +  ${c.domain}${c.path} ${c.name} (${c.valueLength}B hash=${c.valueHash})`);
            for (const c of removed)
                logger_1.logger.info(`[COOKIE-DIAG]   -  ${c.domain}${c.path} ${c.name}`);
            for (const c of changed)
                logger_1.logger.info(`[COOKIE-DIAG]   ~  ${c.domain}${c.path} ${c.name} (new hash=${c.valueHash}, ${c.valueLength}B)`);
        }
        catch (err) {
            logger_1.logger.warn(`[COOKIE-DIAG] Could not snapshot cookies after: ${err?.message || err}`);
        }
        // Page info after click.
        try {
            const url = this.page.url();
            let title = "<unknown>";
            try {
                title = await this.page.title();
            }
            catch { /* ignore */ }
            logger_1.logger.info(`[PAGE-DIAG] After ${this.label}: url=${url}`);
            logger_1.logger.info(`[PAGE-DIAG] After ${this.label}: title="${title}"`);
            const pageProbe = await this.page.evaluate(() => {
                const q = (sel) => Array.from(document.querySelectorAll(sel));
                const isVisible = (el) => {
                    const s = window.getComputedStyle(el);
                    const r = el.getBoundingClientRect?.();
                    return s.display !== "none" && s.visibility !== "hidden" && !!r && r.width > 0 && r.height > 0;
                };
                const visibleForms = q("form").filter(isVisible);
                const inputs = q("input").filter(isVisible);
                const buttons = q("button, input[type=submit], input[type=button]").filter(isVisible);
                const errors = q("[role=alert], .error, .sky-error, .alert-danger").filter(isVisible)
                    .map(el => (el.textContent || "").trim().slice(0, 300)).filter(Boolean);
                const bodyText = (document.body?.innerText || "").slice(0, 800).replace(/\s+/g, " ").trim();
                return { forms: visibleForms.length, inputs: inputs.length, buttons: buttons.length, errors, bodyText };
            });
            logger_1.logger.info(`[PAGE-DIAG]   visible forms: ${pageProbe.forms}`);
            logger_1.logger.info(`[PAGE-DIAG]   visible inputs: ${pageProbe.inputs}`);
            logger_1.logger.info(`[PAGE-DIAG]   visible buttons: ${pageProbe.buttons}`);
            if (pageProbe.errors.length) {
                logger_1.logger.info(`[PAGE-DIAG]   visible error messages: ${pageProbe.errors.length}`);
                for (const err of pageProbe.errors)
                    logger_1.logger.info(`[PAGE-DIAG]     error: ${err}`);
            }
            logger_1.logger.info(`[PAGE-DIAG]   body text (first 800 chars): ${pageProbe.bodyText}`);
        }
        catch (err) {
            logger_1.logger.warn(`[PAGE-DIAG] Could not probe page: ${err?.message || err}`);
        }
        // Stop tracing and save file.
        if (this.tracingActive) {
            try {
                await fs.promises.mkdir(TRACE_DIR, { recursive: true });
                this.tracePath = path.join(TRACE_DIR, `scan-${this.scanId}-${this.label}-${Date.now()}.zip`);
                await this.context.tracing.stop({ path: this.tracePath });
                const stat = await fs.promises.stat(this.tracePath).catch(() => null);
                logger_1.logger.info(`[TRACE-DIAG] Playwright trace saved: ${this.tracePath} (${stat?.size ?? "?"} bytes)`);
                logger_1.logger.info(`[TRACE-DIAG]   Local viewer:   npx playwright show-trace <downloaded-file>`);
                logger_1.logger.info(`[TRACE-DIAG]   Online viewer:  https://trace.playwright.dev`);
                logger_1.logger.info(`[TRACE-DIAG]   Download URL:   GET /api/scans/${this.scanId}/auth-trace?label=${encodeURIComponent(this.label)}`);
            }
            catch (err) {
                logger_1.logger.warn(`[TRACE-DIAG] Failed to save trace: ${err?.message || err}`);
            }
        }
        return { tracePath: this.tracePath };
    }
    /**
     * Filter to "interesting" requests — main frame navigations, POSTs to
     * login/auth endpoints, non-2xx responses, redirects. Static assets
     * (images, fonts, CSS, analytics beacons) are noise for Sky's team.
     */
    buildRedirectChain() {
        const responsesByUrl = new Map();
        for (const r of this.responses)
            responsesByUrl.set(r.url, r);
        const pairs = [];
        for (const req of this.requests) {
            const res = responsesByUrl.get(req.url);
            const boring = /\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|css|ico|mp4|webm)$/i.test(req.url);
            const isNav = req.isNavigationRequest;
            const isPost = req.method !== "GET";
            const isError = res && (res.status >= 400 || res.status === 0);
            const isRedirect = res && res.status >= 300 && res.status < 400;
            const isAuthDomain = /sky\.it|abbonamento\.sky\.it|auth|login|security|sso|token|oauth/i.test(req.url);
            if (!boring && (isNav || isPost || isError || isRedirect || isAuthDomain)) {
                pairs.push({ request: req, response: res });
            }
        }
        return pairs;
    }
    isSafeHeaderToLog(name) {
        const lower = name.toLowerCase();
        // Never log auth tokens, cookies, or the credential-bearing headers.
        if (lower === "authorization")
            return false;
        if (lower === "cookie")
            return false;
        if (lower === "set-cookie")
            return false;
        if (lower === "proxy-authorization")
            return false;
        if (lower.includes("api-key"))
            return false;
        if (lower.includes("token"))
            return false;
        return true;
    }
    truncate(s, max) {
        return s.length > max ? s.slice(0, max) + "…" : s;
    }
}
exports.AuthDiagnostics = AuthDiagnostics;
// Non-cryptographic 8-hex-char hash. Used only to *compare* cookie values
// across time without logging them; NEVER used for any security purpose.
function simpleHash8(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}
