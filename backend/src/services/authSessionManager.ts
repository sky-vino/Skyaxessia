/**
 * authSessionManager.ts
 * -----------------------------------------------------------------------------
 * Production Authenticated Scan session manager.
 *
 * FIX APPLIED (Prod Journey Config): the previous version dropped `auth_config`
 * when writing the queued scan to the DB after successful OTP submission —
 * inserting `null` instead of the collected authConfig from the session. As a
 * result the scanner had no journey/targets information for the authenticated
 * scan and only landed on the launch page (Offerte / Gestisci) without walking
 * the configured target journeys. Staging worked because its scan flow writes
 * auth_config directly from POST /api/scans; production went through this
 * session flow and lost the config at handoff.
 *
 * The fix is a single change in submitOtp(): pass through
 * `JSON.stringify(session.pendingScan.authConfig || {})` on the INSERT instead
 * of `null`. Everything else in this file is unchanged from the last shipped
 * version (Azure-hardened build with xvfb + real mouse events for OTP channel
 * selection).
 *
 * Additionally: extractScanUrls() now includes journey launch pages from the
 * auth config so the scanner receives every URL it needs to walk, not just
 * the OTP-flow target.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { db } from "../utils/db";
import { scanQueue } from "./scanQueue";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type AuthSessionPhase =
  | "launching"
  | "filling_credentials"
  | "requesting_otp"
  | "awaiting_otp"
  | "submitting_otp"
  | "authenticated"
  | "failed"
  | "expired";

export type OtpChannel = "email" | "sms";

export interface AuthSessionSnapshot {
  id: string;
  phase: AuthSessionPhase;
  createdAt: string;
  expiresAt: string;
  otpChannel: OtpChannel;
  targetUrl: string;
  scanName?: string;
  otpMaskedRecipient?: string;
  scanId?: string;
  errorMessage?: string;
}

export interface StartSessionInput {
  targetUrl: string;
  username: string;
  password: string;
  otpChannel?: OtpChannel;
  scanName?: string;
  scanOptions?: any;
  authConfig?: any;         // ← journey config lives in here (targets, launch pages, click rules)
  projectId?: string;
  createdBy: string;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const MAX_CONCURRENT = Number(process.env.AUTH_SESSION_MAX_CONCURRENT || 3);
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 5 * 60 * 1000);
const REAP_INTERVAL_MS = 30 * 1000;

const AZURE_MODE = process.env.WEBSITE_INSTANCE_ID !== undefined
  || process.env.WEBSITE_SITE_NAME !== undefined
  || process.env.AZURE_HARDEN === "1";
const SECURITY_PAGE_TIMEOUT_MS = AZURE_MODE ? 45000 : 30000;
const HYDRATION_WAIT_MS = AZURE_MODE ? 5000 : 1500;
const CHANNEL_SWITCH_ATTEMPTS = 3;

logger.info(`[auth-session] Module init: AZURE_MODE=${AZURE_MODE}, `
  + `security_page_timeout=${SECURITY_PAGE_TIMEOUT_MS}ms, `
  + `hydration_wait=${HYDRATION_WAIT_MS}ms, `
  + `max_concurrent=${MAX_CONCURRENT}, `
  + `session_ttl=${SESSION_TTL_MS}ms`);

// -----------------------------------------------------------------------------
// Internal registry
// -----------------------------------------------------------------------------

interface LiveSession {
  id: string;
  phase: AuthSessionPhase;
  createdAt: number;
  expiresAt: number;
  otpChannel: OtpChannel;
  targetUrl: string;
  scanName?: string;
  otpMaskedRecipient?: string;
  scanId?: string;
  errorMessage?: string;

  browser?: Browser;
  context?: BrowserContext;
  page?: Page;

  pendingScan?: {
    scanName?: string;
    scanOptions: any;
    authConfig: any;
    projectId?: string;
    createdBy: string;
    urls: string[];
    stateLabel: string;
  };
}

const sessions = new Map<string, LiveSession>();

// -----------------------------------------------------------------------------
// Helpers — journey URL extraction
// -----------------------------------------------------------------------------

/**
 * Build the full list of URLs the scanner should walk after auth completes.
 * Starts with the OTP-flow target URL, then adds every launch page referenced
 * by the journey config (auth_config.targets[]) so the scanner has parity
 * with the staging flow.
 */
function extractScanUrls(input: StartSessionInput): string[] {
  const collected: string[] = [];

  // Ship 2g — multi-URL support: the frontend now sends the user's URL list
  // via scan_options.production_target_urls. When present, these are the
  // URLs the scanner should walk (login URL is separate and not scanned).
  const prodUrls =
    input.scanOptions?.production_target_urls ||
    input.scanOptions?.productionTargetUrls ||
    [];
  if (Array.isArray(prodUrls)) {
    for (const u of prodUrls) {
      if (typeof u === "string" && u.trim().length > 0) {
        collected.push(u.trim());
      }
    }
  }

  // Legacy: also honour any journey launch pages if configured.
  // Frontend field name is `target_interactions` — old field aliases kept
  // for compatibility with anything still writing the old shape.
  const targets =
    input.scanOptions?.target_interactions ||
    input.authConfig?.targets ||
    input.authConfig?.journeys ||
    input.scanOptions?.journey_config?.targets ||
    input.scanOptions?.targets ||
    [];
  if (Array.isArray(targets)) {
    for (const t of targets) {
      const launch =
        t?.launch_page_url ||
        t?.launchPageUrl ||
        t?.launch_page ||
        t?.launchPage ||
        t?.url;
      if (typeof launch === "string" && launch.length > 0) {
        collected.push(launch);
      }
    }
  }

  // Fallback: if nothing else was collected, use the login/target URL so
  // we never end up with an empty scan.
  if (collected.length === 0 && input.targetUrl) {
    collected.push(input.targetUrl);
  }

  return Array.from(new Set(collected));
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export async function startSession(input: StartSessionInput): Promise<AuthSessionSnapshot> {
  if (sessions.size >= MAX_CONCURRENT) {
    throw new Error(
      `This server is currently holding ${sessions.size} concurrent auth session(s), which is the configured cap of ${MAX_CONCURRENT}. Please wait ~30 seconds and try again, or cancel an existing pending session.`
    );
  }

  const now = Date.now();
  const id = randomUUID();
  const otpChannel: OtpChannel = input.otpChannel || "email";

  const session: LiveSession = {
    id,
    phase: "launching",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    otpChannel,
    targetUrl: input.targetUrl,
    scanName: input.scanName,
  };
  sessions.set(id, session);

  logger.info(`[auth-session ${id}] START — targetUrl=${input.targetUrl}, channel=${otpChannel}, user=${input.username?.slice(0, 3)}***`);

  // Log the journey config summary so we can see it flowing through.
  // Frontend sends journey targets under scanOptions.target_interactions
  // (this is the shape the scanner reads). Old aliases kept for compat.
  const journeyTargets =
    input.scanOptions?.target_interactions ||
    input.authConfig?.targets ||
    input.scanOptions?.journey_config?.targets ||
    input.scanOptions?.targets ||
    [];
  logger.info(`[auth-session ${id}] Journey config: ${Array.isArray(journeyTargets) ? journeyTargets.length : 0} target(s) attached to session`);

  void driveToOtpScreen(session, input).catch(err => {
    logger.error(`[auth-session ${id}] driveToOtpScreen failed:`, err);
    session.phase = "failed";
    session.errorMessage = err?.message || "Auth flow failed.";
    void cleanupBrowser(session);
  });

  return toSnapshot(session);
}

export function getSession(id: string): AuthSessionSnapshot | null {
  const session = sessions.get(id);
  return session ? toSnapshot(session) : null;
}

export async function submitOtp(id: string, otp: string): Promise<AuthSessionSnapshot> {
  const session = sessions.get(id);
  if (!session) throw new Error("Session not found or already expired.");
  if (session.phase !== "awaiting_otp") {
    throw new Error(`Cannot submit OTP while session is in phase "${session.phase}".`);
  }
  if (!session.page || !session.context || !session.browser) {
    throw new Error("Session has no live browser handle. Please restart the auth flow.");
  }
  if (!/^\d{4,8}$/.test(otp)) {
    throw new Error("OTP must be 4-8 digits.");
  }

  session.phase = "submitting_otp";
  logger.info(`[auth-session ${id}] Submitting OTP (${otp.length} digits)`);

  try {
    await fillOtpBoxes(session.page, otp);
    await clickConferma(session.page);
    await waitForAuthenticatedLanding(session.page, session.targetUrl);

    const cookies = await session.context.cookies();
    logger.info(`[auth-session ${id}] Auth succeeded, ${cookies.length} cookies extracted`);

    if (!session.pendingScan) {
      throw new Error("Session has no pending scan config to hand off to the scanner.");
    }

    const scanOptions = {
      ...(session.pendingScan.scanOptions || {}),
      extension_session_cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    };

    // ─── FIX ─────────────────────────────────────────────────────────────
    // Previously the auth_config column was hard-coded to `null` here, which
    // dropped the journey targets and left the scanner with a single-URL
    // scan. Now we pass the collected authConfig through so the scanner sees
    // the same DB row structure as a staging scan and runs the journey
    // engine after auth.
    const authConfigJson = JSON.stringify(session.pendingScan.authConfig || {});
    logger.info(`[auth-session ${id}] Persisting auth_config with ${JSON.stringify(session.pendingScan.authConfig || {}).length} chars for scanner handoff`);
    // ─────────────────────────────────────────────────────────────────────

    const scanInsert = await db.query(
      `INSERT INTO scans (name, urls, project_id, created_by, state_label, auth_config, scan_options, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`,
      [
        session.pendingScan.scanName || `Prod scan ${new Date().toLocaleString()}`,
        session.pendingScan.urls,
        session.pendingScan.projectId || null,
        session.pendingScan.createdBy,
        session.pendingScan.stateLabel,
        authConfigJson,                                 // ← was `null` — now passes the journey config through
        JSON.stringify(scanOptions),
      ]
    );
    const scan = scanInsert.rows[0];
    session.scanId = scan.id;
    session.phase = "authenticated";

    await scanQueue.add(scan.id);
    logger.info(`[auth-session ${id}] Scan ${scan.id} queued with urls=${JSON.stringify(session.pendingScan.urls)}, journey_targets=${(session.pendingScan.scanOptions?.target_interactions || session.pendingScan.authConfig?.targets || []).length}`);

    await cleanupBrowser(session);
    setTimeout(() => sessions.delete(id), 60 * 1000);

    return toSnapshot(session);
  } catch (err: any) {
    logger.warn(`[auth-session ${id}] OTP submit failed: ${err?.message || err}`);
    session.phase = "failed";
    session.errorMessage = err?.message || "OTP submit failed.";
    await cleanupBrowser(session);
    throw err;
  }
}

export async function cancelSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  session.phase = "expired";
  await cleanupBrowser(session);
  sessions.delete(id);
  logger.info(`[auth-session ${id}] Cancelled by user`);
}

export function listActiveSessions(): AuthSessionSnapshot[] {
  return Array.from(sessions.values()).map(toSnapshot);
}

// -----------------------------------------------------------------------------
// Internal flow
// -----------------------------------------------------------------------------

async function driveToOtpScreen(session: LiveSession, input: StartSessionInput): Promise<void> {
  const sid = session.id;
  const t0 = Date.now();
  const step = (name: string) => logger.info(`[auth-session ${sid}] STEP ${name} (t+${Date.now() - t0}ms)`);

  step("launching Chromium");
  session.phase = "launching";
  const browser = await launchStealthChromium();
  session.browser = browser;
  step("Chromium launched");

  const context = await createStealthContext(browser);
  session.context = context;
  const page = await context.newPage();
  session.page = page;
  step("context + page ready");

  page.on("console", msg => {
    if (msg.type() === "error" || msg.type() === "warning") {
      logger.info(`[auth-session ${sid}] browser console [${msg.type()}]: ${msg.text().slice(0, 200)}`);
    }
  });
  page.on("pageerror", err => {
    logger.warn(`[auth-session ${sid}] browser pageerror: ${err?.message?.slice(0, 200)}`);
  });
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) {
      logger.info(`[auth-session ${sid}] main frame navigated → ${frame.url()}`);
    }
  });

  session.phase = "filling_credentials";
  step(`navigating to ${input.targetUrl}`);
  try {
    await page.goto(input.targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (err: any) {
    await saveDiagnosticSnapshot(page, sid, "nav-failed").catch(() => undefined);
    throw new Error(`Navigation to ${input.targetUrl} failed: ${err?.message || err}`);
  }
  step(`nav complete, current URL=${page.url()}`);

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(HYDRATION_WAIT_MS);
  step("post-nav settle done");

  step("dismissing cookie consent");
  await dismissCookieConsent(page);
  await page.waitForTimeout(1000);
  step(`cookie phase done, URL=${page.url()}`);

  step("auto-detecting login form");
  const form = await findLoginForm(page).catch(() => null);
  if (!form || !form.usernameFound || !form.passwordFound) {
    const snap = await saveDiagnosticSnapshot(page, sid, "no-login-form").catch(() => undefined);
    throw new Error(
      `Could not find a login form on ${page.url()}. ` +
      `Detected: username=${form?.usernameFound ? "yes" : "no"}, password=${form?.passwordFound ? "yes" : "no"}, submit=${form?.submitFound ? "yes" : "no"}. ` +
      `Page title: "${await page.title().catch(() => "")}"` +
      (snap ? `. Screenshot saved: ${snap}` : "")
    );
  }
  step(`form detected: ${form.description}`);

  step("filling username");
  const filledUser = await fillDetectedField(page, "username", input.username);
  if (!filledUser) {
    await saveDiagnosticSnapshot(page, sid, "user-fill-failed").catch(() => undefined);
    throw new Error(`Found a username field but could not fill it. See screenshot on disk.`);
  }

  step("filling password");
  const filledPass = await fillDetectedField(page, "password", input.password);
  if (!filledPass) {
    await saveDiagnosticSnapshot(page, sid, "pass-fill-failed").catch(() => undefined);
    throw new Error(`Found a password field but could not fill it. See screenshot on disk.`);
  }

  session.phase = "requesting_otp";
  step("clicking submit");
  const submitted = await clickDetectedSubmit(page);
  if (!submitted) {
    logger.info(`[auth-session ${sid}] no submit button found; pressing Enter as fallback`);
    await page.keyboard.press("Enter").catch(() => undefined);
  }

  step(`waiting for security/OTP page (timeout=${SECURITY_PAGE_TIMEOUT_MS}ms)`);
  try {
    await waitForSecurityPage(page, SECURITY_PAGE_TIMEOUT_MS, sid);
  } catch (err: any) {
    const snap = await saveDiagnosticSnapshot(page, sid, "no-otp-page").catch(() => undefined);
    throw new Error(`${err?.message || err}${snap ? ` Screenshot saved: ${snap}` : ""}`);
  }
  step(`security page reached, URL=${page.url()}`);

  step(`switching delivery channel → ${session.otpChannel}`);
  try {
    await clickDeliveryChannel(page, session.otpChannel, sid);
    step(`channel switch to ${session.otpChannel} succeeded`);
  } catch (err: any) {
    await saveDiagnosticSnapshot(page, sid, `channel-switch-failed-${session.otpChannel}`).catch(() => undefined);
    throw err;
  }

  session.otpMaskedRecipient = await extractMaskedRecipient(page).catch(() => undefined);
  logger.info(`[auth-session ${sid}] OTP sent to: ${session.otpMaskedRecipient || "<unknown recipient>"}`);

  // Build the full URL list from journey config so the scanner walks all targets,
  // not just the OTP-flow target URL.
  const scanUrls = extractScanUrls(input);
  logger.info(`[auth-session ${sid}] Scan URL list built: ${JSON.stringify(scanUrls)}`);

  session.pendingScan = {
    scanName: input.scanName,
    scanOptions: input.scanOptions || {},
    authConfig: input.authConfig || {},
    projectId: input.projectId,
    createdBy: input.createdBy,
    urls: scanUrls,
    stateLabel: "prod-auth-manual-otp",
  };
  session.phase = "awaiting_otp";
  logger.info(`[auth-session ${sid}] READY (t+${Date.now() - t0}ms) — waiting for user to enter OTP`);
}

// -----------------------------------------------------------------------------
// Login form finder + filler
// -----------------------------------------------------------------------------

interface DetectedForm {
  usernameFound: boolean;
  passwordFound: boolean;
  submitFound: boolean;
  description: string;
}

async function findLoginForm(page: Page): Promise<DetectedForm> {
  const timeoutMs = 10000;
  const startedAt = Date.now();
  let last: DetectedForm | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await page.evaluate(() => {
      function walkAll(root: Document | ShadowRoot, out: Element[]) {
        const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
        let n: Node | null = walker.currentNode;
        while (n) {
          if (n.nodeType === 1) {
            const el = n as Element;
            out.push(el);
            if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out);
          }
          n = walker.nextNode();
        }
      }
      const all: Element[] = [];
      walkAll(document, all);

      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect?.();
        const s = window.getComputedStyle(el as HTMLElement);
        return !!rect && rect.width > 0 && rect.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };

      const inputs = all.filter(el => el.tagName === "INPUT" && isVisible(el)) as HTMLInputElement[];
      const password = inputs.find(el => el.type === "password") || null;
      const passwordIndex = password ? inputs.indexOf(password) : -1;
      const before = passwordIndex >= 0 ? inputs.slice(0, passwordIndex) : inputs;
      const scoreUsername = (el: HTMLInputElement) => {
        let score = 0;
        const type = (el.type || "").toLowerCase();
        const name = (el.name || "").toLowerCase();
        const id = (el.id || "").toLowerCase();
        const auto = (el.autocomplete || "").toLowerCase();
        const combined = `${name} ${id} ${auto}`;
        if (type === "email") score += 5;
        if (type === "tel") score += 2;
        if (type === "text" || type === "") score += 3;
        if (/user|email|mail|login|account/.test(combined)) score += 4;
        if (/pass/.test(combined)) score -= 10;
        return score;
      };
      const username = before.slice().sort((a, b) => scoreUsername(b) - scoreUsername(a))[0] || null;

      const buttons = all.filter(el =>
        (el.tagName === "BUTTON" || (el.tagName === "INPUT" && ["submit", "button"].includes((el as HTMLInputElement).type))) &&
        isVisible(el)
      ) as HTMLElement[];
      const submit =
        buttons.find(b => (b as HTMLButtonElement | HTMLInputElement).type === "submit") ||
        buttons.find(b => /accedi|sign\s?in|log\s?in|entra|conferma/i.test((b.innerText || (b as HTMLInputElement).value || "").trim())) ||
        buttons[0] || null;

      if (username) (username as any).dataset.axessiaRole = "username";
      if (password) (password as any).dataset.axessiaRole = "password";
      if (submit) (submit as any).dataset.axessiaRole = "submit";

      const desc = [
        username ? `username=<${username.tagName.toLowerCase()} type=${username.type} name="${username.name}" id="${username.id}">` : "username=NONE",
        password ? `password=<input type=password name="${password.name}" id="${password.id}">` : "password=NONE",
        submit   ? `submit=<${submit.tagName.toLowerCase()} text="${(submit.innerText || (submit as HTMLInputElement).value || "").trim().slice(0, 40)}">` : "submit=NONE",
      ].join(", ");

      return {
        usernameFound: !!username,
        passwordFound: !!password,
        submitFound: !!submit,
        description: desc,
      };
    }).catch(() => ({ usernameFound: false, passwordFound: false, submitFound: false, description: "eval failed" }));

    if (last.usernameFound && last.passwordFound) return last;
    await page.waitForTimeout(500);
  }
  return last || { usernameFound: false, passwordFound: false, submitFound: false, description: "timeout" };
}

async function fillDetectedField(page: Page, role: "username" | "password", value: string): Promise<boolean> {
  return await page.evaluate(({ role, value }) => {
    function walkAll(root: Document | ShadowRoot, out: Element[]) {
      const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let n: Node | null = walker.currentNode;
      while (n) {
        if (n.nodeType === 1) {
          const el = n as Element;
          out.push(el);
          if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out);
        }
        n = walker.nextNode();
      }
    }
    const all: Element[] = [];
    walkAll(document, all);
    const el = all.find(e => (e as any).dataset?.axessiaRole === role) as HTMLInputElement | undefined;
    if (!el) return false;
    try {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return el.value === value;
    } catch {
      return false;
    }
  }, { role, value });
}

async function clickDetectedSubmit(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    function walkAll(root: Document | ShadowRoot, out: Element[]) {
      const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let n: Node | null = walker.currentNode;
      while (n) {
        if (n.nodeType === 1) {
          const el = n as Element;
          out.push(el);
          if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out);
        }
        n = walker.nextNode();
      }
    }
    const all: Element[] = [];
    walkAll(document, all);
    const btn = all.find(e => (e as any).dataset?.axessiaRole === "submit") as HTMLElement | undefined;
    if (!btn) return false;
    try {
      btn.click();
      return true;
    } catch {
      return false;
    }
  });
}

async function saveDiagnosticSnapshot(page: Page, sessionId: string, label: string): Promise<string | undefined> {
  try {
    const dir = process.env.TRACE_DIR || "/tmp";
    await fs.promises.mkdir(dir, { recursive: true });
    const p = path.join(dir, `auth-session-${sessionId}-${label}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    const url = page.url();
    const title = await page.title().catch(() => "");
    logger.info(`[auth-session ${sessionId}] Diagnostic snapshot: ${p}`);
    logger.info(`[auth-session ${sessionId}]   URL:   ${url}`);
    logger.info(`[auth-session ${sessionId}]   Title: ${title}`);
    return p;
  } catch {
    return undefined;
  }
}

async function launchStealthChromium(): Promise<Browser> {
  return chromium.launch({
    headless: false,
    executablePath: resolveFullChromiumPath(),
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-default-browser-check", "--no-first-run",
      "--password-store=basic", "--use-mock-keychain",
      "--window-size=1366,768",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
}

async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": "\"Linux\"",
    },
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {}
    try { Object.defineProperty(navigator, "languages", { get: () => ["it-IT", "it", "en-US", "en"] }); } catch {}
    try { Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] }); } catch {}
    try { if (!(window as any).chrome) (window as any).chrome = { runtime: {} }; } catch {}
  });
  return context;
}

function resolveFullChromiumPath(): string | undefined {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath) return undefined;
  try {
    if (!fs.existsSync(browsersPath)) return undefined;
    const dir = fs.readdirSync(browsersPath).find(n => /^chromium-\d+$/.test(n));
    if (!dir) return undefined;
    const p = path.join(browsersPath, dir, "chrome-linux64", "chrome");
    if (fs.existsSync(p)) return p;
  } catch { /* ignore */ }
  return undefined;
}

async function dismissCookieConsent(page: Page): Promise<void> {
  const acceptSelectors = [
    "#notice button.accbtn[aria-label='Accetta tutto']",
    "#notice button.accbtn",
    "button.accbtn[aria-label='Accetta tutto']",
    "button.accbtn",
    "[aria-label='Accetta tutto']",
    "[aria-label='Accetta tutti']",
    "button:has-text('Accetta tutto')",
    "button:has-text('Accetta tutti')",
    "button:has-text('Accetta e chiudi')",
    "button:has-text('Accetto')",
    "button:has-text('OK, accetto')",
    "button:has-text('Ho capito')",
    "button:has-text('Accept All')",
    "button:has-text('Accept all')",
    "button:has-text('I accept')",
    "button:has-text('Allow all')",
    "button:has-text('Agree and close')",
    "button#onetrust-accept-btn-handler",
    "button#didomi-notice-agree-button",
    "button.qc-cmp2-accept-all",
  ];

  const frames = page.frames();
  for (const frame of frames) {
    for (const sel of acceptSelectors) {
      try {
        const btn = frame.locator(sel).first();
        const count = await btn.count().catch(() => 0);
        if (count === 0) continue;
        const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
        if (!visible) continue;
        await btn.click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(700);
        return;
      } catch { /* try next */ }
    }
  }
}

async function waitForSecurityPage(page: Page, timeoutMs: number, sid: string): Promise<void> {
  const start = Date.now();
  let lastLoggedUrl = "";
  let iter = 0;
  while (Date.now() - start < timeoutMs) {
    iter++;
    try {
      const url = page.url();
      if (url !== lastLoggedUrl) {
        logger.info(`[auth-session ${sid}] waitForSecurityPage iter=${iter} URL=${url}`);
        lastLoggedUrl = url;
      }
      const title = await page.title().catch(() => "");
      const inputCount = await page.locator("input[maxlength='1']").count().catch(() => 0);
      const looksLikeSecurity = /security|otp|verify|mfa|2fa/i.test(url) ||
        /security code|codice di sicurezza|Digita il codice/i.test(title) ||
        inputCount >= 4;
      if (looksLikeSecurity) return;
    } catch { /* keep waiting */ }
    await page.waitForTimeout(500);
  }
  throw new Error(`Security/OTP page did not appear within ${timeoutMs / 1000}s after clicking Accedi.`);
}

async function clickDeliveryChannel(page: Page, channel: "email" | "sms", sid: string): Promise<void> {
  const emailTexts = ["Invia tramite email", "Invia tramite e-mail", "Send by email", "Send via email"];
  const smsTexts = ["Invia di nuovo via SMS", "Send via SMS", "Resend via SMS", "Invia via SMS"];
  const targetTexts = channel === "email" ? emailTexts : smsTexts;
  const alreadyOnTarget = channel === "email"
    ? /(Abbiamo|Ti\s+abbiamo)\s+inviato\s+(un|una)\s+e-?mail/i
    : /(Abbiamo|Ti\s+abbiamo)\s+inviato\s+un\s+SMS/i;

  const verifyOnTarget = async (): Promise<{ ok: boolean; reason: string; sample: string }> => {
    const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (alreadyOnTarget.test(body)) return { ok: true, reason: "confirmation-text", sample: body.slice(0, 120) };
    if (channel === "email" && /EMAIL\s*:\s*[^\s]+@[^\s]+/i.test(body)) return { ok: true, reason: "email-recipient-visible", sample: body.slice(0, 120) };
    if (channel === "sms" && (/PHONE\s*:\s*[\+\d]/i.test(body) || /TELEFONO\s*:\s*[\+\d]/i.test(body))) return { ok: true, reason: "phone-recipient-visible", sample: body.slice(0, 120) };
    return { ok: false, reason: "no-target-marker", sample: body.slice(0, 200) };
  };

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(HYDRATION_WAIT_MS);

  const initial = await verifyOnTarget();
  if (initial.ok) return;

  for (let attempt = 1; attempt <= CHANNEL_SWITCH_ATTEMPTS; attempt++) {
    const coords = await page.evaluate((texts: string[]) => {
      function walkAll(root: Document | ShadowRoot, out: Element[]) {
        const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
        let n: Node | null = walker.currentNode;
        while (n) {
          if (n.nodeType === 1) {
            const el = n as Element;
            out.push(el);
            if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out);
          }
          n = walker.nextNode();
        }
      }
      const all: Element[] = [];
      walkAll(document, all);

      const isVisible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect?.();
        const s = window.getComputedStyle(el as HTMLElement);
        return !!r && r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };

      for (const el of all) {
        if (!isVisible(el)) continue;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        if (!(tag === "button" || tag === "a" || role === "button")) continue;
        const text = ((el as HTMLElement).innerText || "").trim();
        if (text.length > 80) continue;
        if (!texts.some(t => text.toLowerCase().includes(t.toLowerCase()))) continue;
        (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as any });
        const r = (el as HTMLElement).getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: text.slice(0, 60) };
      }
      return null;
    }, targetTexts).catch(() => null);

    if (!coords) {
      await page.waitForTimeout(2000);
      continue;
    }

    try {
      await page.mouse.move(coords.x, coords.y, { steps: 5 });
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.waitForTimeout(80);
      await page.mouse.up();
    } catch { /* ignore mouse errors */ }

    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(3000);

    const verify = await verifyOnTarget();
    if (verify.ok) return;
    await page.waitForTimeout(1500);
  }

  throw new Error(`Failed to switch OTP delivery to "${channel}" after ${CHANNEL_SWITCH_ATTEMPTS} attempts.`);
}

async function extractMaskedRecipient(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const phoneMatch = body.match(/PHONE\s*:\s*([\+\d\s\-]+)/i) || body.match(/TELEFONO\s*:\s*([\+\d\s\-]+)/i);
    const emailMatch = body.match(/EMAIL\s*:\s*([^\s]+@[^\s]+)/i);
    return phoneMatch?.[1]?.trim() || emailMatch?.[1]?.trim();
  }).catch(() => undefined);
}

async function fillOtpBoxes(page: Page, otp: string): Promise<void> {
  await page.waitForTimeout(500);

  const found = await page.evaluate(() => {
    function walkAll(root: Document | ShadowRoot, out: Element[]) {
      const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let n: Node | null = walker.currentNode;
      while (n) {
        if (n.nodeType === 1) {
          const el = n as Element;
          out.push(el);
          if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out);
        }
        n = walker.nextNode();
      }
    }
    const all: Element[] = [];
    walkAll(document, all);

    const isVisible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect?.();
      const s = window.getComputedStyle(el as HTMLElement);
      return !!r && r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };

    const inputs = all.filter(el =>
      el.tagName === "INPUT" &&
      isVisible(el) &&
      ((el as HTMLInputElement).maxLength === 1 ||
        /otp|code|codice|sicurezza/i.test(el.className || "") ||
        /otp|code/i.test(el.id || ""))
    ) as HTMLInputElement[];

    inputs.forEach((el, i) => { (el as any).dataset.axessiaOtpIndex = String(i); });
    return { count: inputs.length };
  }).catch(() => ({ count: 0 }));

  if (found.count < otp.length) {
    throw new Error(`Only found ${found.count} OTP boxes, expected ${otp.length}.`);
  }

  for (let i = 0; i < otp.length; i++) {
    const digit = otp[i];
    await page.evaluate(({ index, value }) => {
      function walkAll(root: Document | ShadowRoot, out: Element[]) {
        const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
        let n: Node | null = walker.currentNode;
        while (n) {
          if (n.nodeType === 1) {
            const el = n as Element;
            out.push(el);
            if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out);
          }
          n = walker.nextNode();
        }
      }
      const all: Element[] = [];
      walkAll(document, all);
      const el = all.find(e => (e as any).dataset?.axessiaOtpIndex === String(index)) as HTMLInputElement | undefined;
      if (!el) return false;
      try {
        el.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        nativeSetter?.call(el, value);
        el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return el.value === value;
      } catch {
        return false;
      }
    }, { index: i, value: digit });
    await page.waitForTimeout(60);
  }
}

async function clickConferma(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    function walkAll(root: Document | ShadowRoot, out: Element[]) {
      const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let n: Node | null = walker.currentNode;
      while (n) {
        if (n.nodeType === 1) {
          const el = n as Element;
          out.push(el);
          if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out);
        }
        n = walker.nextNode();
      }
    }
    const all: Element[] = [];
    walkAll(document, all);

    const isVisible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect?.();
      const s = window.getComputedStyle(el as HTMLElement);
      return !!r && r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };

    const buttons = all.filter(el =>
      (el.tagName === "BUTTON" || (el.tagName === "INPUT" && ["submit", "button"].includes((el as HTMLInputElement).type))) &&
      isVisible(el)
    ) as HTMLElement[];

    const conferma = buttons.find(b =>
      /conferma|confirm|verify|verifica/i.test((b.innerText || (b as HTMLInputElement).value || "").trim())
    );
    const target = conferma || buttons.find(b => (b as HTMLButtonElement | HTMLInputElement).type === "submit");
    if (!target) return false;
    try { target.click(); return true; } catch { return false; }
  }).catch(() => false);

  if (!clicked) {
    await page.keyboard.press("Enter").catch(() => undefined);
  }
}

async function waitForAuthenticatedLanding(page: Page, targetUrl: string): Promise<void> {
  const start = Date.now();
  const timeoutMs = 40000;
  let targetHost: string | null = null;
  try { targetHost = new URL(targetUrl).hostname; } catch { /* ignore */ }
  let lastUrl = "";
  let unchangedSince = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      logger.info(`[auth-session] Post-OTP navigation → ${currentUrl}`);
      lastUrl = currentUrl;
      unchangedSince = Date.now();
    }

    const onAuthPage = /\/(login|security|signin|sign-in|auth|verify|mfa|otp)\b/i.test(currentUrl);
    let hostMatch = false;
    try { hostMatch = new URL(currentUrl).hostname === targetHost; } catch { /* ignore */ }

    if (!onAuthPage && (hostMatch || !currentUrl.includes("sky.it/security"))) {
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
      return;
    }

    if (onAuthPage) {
      const errorText = await page.evaluate(() => {
        const body = document.body?.innerText || "";
        const matches = body.match(/codice.*non.*(valido|corretto)|invalid.*code|wrong.*code|codice.*errato/i);
        return matches ? body.slice(matches.index || 0, (matches.index || 0) + 200) : null;
      }).catch(() => null);
      if (errorText) throw new Error(`Sky reported an OTP error: ${errorText.slice(0, 200)}`);
    }

    if (onAuthPage && Date.now() - unchangedSince > 20000) {
      throw new Error(`URL has not progressed past auth page for 20s. Current URL: ${currentUrl}`);
    }

    await page.waitForTimeout(500);
  }
  throw new Error(`Did not reach authenticated landing within ${timeoutMs / 1000}s. Last URL: ${lastUrl}`);
}

async function cleanupBrowser(session: LiveSession): Promise<void> {
  try { await session.page?.close(); } catch { /* ignore */ }
  try { await session.context?.close(); } catch { /* ignore */ }
  try { await session.browser?.close(); } catch { /* ignore */ }
  session.page = undefined;
  session.context = undefined;
  session.browser = undefined;
}

function toSnapshot(session: LiveSession): AuthSessionSnapshot {
  return {
    id: session.id,
    phase: session.phase,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    otpChannel: session.otpChannel,
    targetUrl: session.targetUrl,
    scanName: session.scanName,
    otpMaskedRecipient: session.otpMaskedRecipient,
    scanId: session.scanId,
    errorMessage: session.errorMessage,
  };
}

// -----------------------------------------------------------------------------
// Background reaper
// -----------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now && session.phase !== "authenticated") {
      logger.info(`[auth-session ${id}] Expired (TTL), cleaning up`);
      session.phase = "expired";
      void cleanupBrowser(session);
      sessions.delete(id);
    }
  }
}, REAP_INTERVAL_MS).unref?.();
