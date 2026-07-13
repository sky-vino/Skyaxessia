/**
 * authSessionManager.ts
 * -----------------------------------------------------------------------------
 * Manages "paused" Playwright browser sessions for production authenticated
 * scans, where the OTP goes to a real phone or real email inbox and cannot be
 * read automatically. Between "Generate OTP" and "Login and Scan", the browser
 * stays alive in memory holding the security-page state.
 *
 * Architectural contract:
 *   - startSession(url, username, password, options) → sessionId
 *       Launches Playwright, fills creds, clicks Accedi, waits for security
 *       page, clicks "Send by email" (or SMS depending on options), returns
 *       control to the caller with the browser paused on the OTP screen.
 *
 *   - getSession(sessionId) → status snapshot for polling
 *       Includes phase (awaiting_otp | submitting_otp | authenticated | failed
 *       | expired), any error message, and the destination URL.
 *
 *   - submitOtp(sessionId, otp) → { scanId }
 *       Types OTP, clicks Conferma, waits for authenticated landing,
 *       extracts cookies + storageState, closes the interactive browser,
 *       spawns a normal scan pre-loaded with the authenticated cookies.
 *
 *   - cancelSession(sessionId)
 *       User cancelled; force-close browser and mark expired.
 *
 * Session lifetime:
 *   Default TTL is 5 minutes. A background cleanup interval kills any session
 *   past its expiresAt. Handles the "user closed the browser tab and walked
 *   away" case without leaking Playwright processes.
 *
 * Concurrency:
 *   Each session holds ~200MB RAM (a Chromium process). Cap at MAX_CONCURRENT
 *   sessions per Node process. Additional startSession calls throw with a
 *   clear "capacity exceeded, try again in a moment" message.
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
  | "launching"          // Playwright starting up
  | "filling_credentials"// Filling username/password
  | "requesting_otp"     // Clicked Accedi, waiting for security page
  | "awaiting_otp"       // OTP screen visible, waiting for user to enter code
  | "submitting_otp"     // OTP received, submitting to Sky
  | "authenticated"      // Login complete, scan queued/started
  | "failed"             // Something broke - see errorMessage
  | "expired";           // TTL exceeded

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
  authConfig?: any;
  projectId?: string;
  createdBy: string;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const MAX_CONCURRENT = Number(process.env.AUTH_SESSION_MAX_CONCURRENT || 3);
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 5 * 60 * 1000);
const REAP_INTERVAL_MS = 30 * 1000;

// Default selectors matching Sky iD's flow. Override via authConfig.
// These are FALLBACKS - the primary path is auto-detection via findLoginForm.
const DEFAULT_SELECTORS = {
  otp_input_selector: "input.sky-otp-input, input[maxlength='1'][type='tel'], input[maxlength='1'][type='text']",
  otp_submit_selector: "button.sky-otp-confirm, button:has-text('He confirms'), button:has-text('Conferma')",
  email_delivery_selector: "a:has-text('Send by email'), a:has-text('Invia tramite email'), button:has-text('Send by email')",
  sms_delivery_selector: "a:has-text('Send via SMS'), a:has-text('Invia di nuovo via SMS'), button:has-text('Send via SMS')",
};

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

  // Live handles - never serialised, never returned to the client.
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;

  // Pending scan config to hand off after successful OTP.
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

  logger.info(`[auth-session ${id}] Launching for ${input.targetUrl}, channel=${otpChannel}`);

  // Do the launch + credential fill + delivery-channel click in the background.
  // Return immediately with { phase: "launching" } so the UI can start polling.
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

    // Extract cookies from the authenticated context.
    const cookies = await session.context.cookies();
    logger.info(`[auth-session ${id}] Auth succeeded, ${cookies.length} cookies extracted`);

    if (!session.pendingScan) {
      throw new Error("Session has no pending scan config to hand off to the scanner.");
    }

    // Create a scan record with the cookies pre-injected into scan_options.
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

    const scanInsert = await db.query(
      `INSERT INTO scans (name, urls, project_id, created_by, state_label, auth_config, scan_options, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`,
      [
        session.pendingScan.scanName || `Prod scan ${new Date().toLocaleString()}`,
        session.pendingScan.urls,
        session.pendingScan.projectId || null,
        session.pendingScan.createdBy,
        session.pendingScan.stateLabel,
        null,  // authConfig intentionally NULL — cookies already inject in createBrowserContext
        JSON.stringify(scanOptions),
      ]
    );
    const scan = scanInsert.rows[0];
    session.scanId = scan.id;
    session.phase = "authenticated";

    await scanQueue.add(scan.id);
    logger.info(`[auth-session ${id}] Scan ${scan.id} queued`);

    // Close the interactive browser - the scan launches its own.
    await cleanupBrowser(session);

    // Keep the session in the registry for a few minutes so the UI's final
    // poll still resolves to phase="authenticated" with the scan_id.
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
  session.phase = "launching";
  const browser = await launchStealthChromium();
  session.browser = browser;
  const context = await createStealthContext(browser);
  session.context = context;
  const page = await context.newPage();
  session.page = page;

  session.phase = "filling_credentials";
  logger.info(`[auth-session ${session.id}] Navigating to ${input.targetUrl}`);
  try {
    await page.goto(input.targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (err: any) {
    await saveDiagnosticSnapshot(page, session.id, "nav-failed").catch(() => undefined);
    throw new Error(`Navigation to ${input.targetUrl} failed: ${err?.message || err}`);
  }

  // Wait for the network to quiet down. SPAs and OAuth redirects need this.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  logger.info(`[auth-session ${session.id}] Attempting to dismiss cookie consent...`);
  await dismissCookieConsent(page);
  // Give the page 1s to settle after the modal is gone, so the login form
  // can finish rendering / becoming interactive.
  await page.waitForTimeout(1000);
  logger.info(`[auth-session ${session.id}] Cookie consent phase done. Current URL: ${page.url()}`);

  // Auto-detect the login form. Works with either shadow-DOM custom elements
  // (Sky test env) or plain HTML inputs (Sky production, and every other
  // login form on the internet). No hardcoded selectors.
  logger.info(`[auth-session ${session.id}] Auto-detecting login form...`);
  const form = await findLoginForm(page).catch(() => null);
  if (!form || !form.usernameFound || !form.passwordFound) {
    const snap = await saveDiagnosticSnapshot(page, session.id, "no-login-form").catch(() => undefined);
    throw new Error(
      `Could not find a login form on ${page.url()}. ` +
      `Detected: username=${form?.usernameFound ? "yes" : "no"}, password=${form?.passwordFound ? "yes" : "no"}, submit=${form?.submitFound ? "yes" : "no"}. ` +
      `Page title: "${await page.title().catch(() => "")}"` +
      (snap ? `. Screenshot saved: ${snap}` : "")
    );
  }
  logger.info(`[auth-session ${session.id}] Form detected: ${form.description}`);

  logger.info(`[auth-session ${session.id}] Filling username`);
  const filledUser = await fillDetectedField(page, "username", input.username);
  if (!filledUser) {
    await saveDiagnosticSnapshot(page, session.id, "user-fill-failed").catch(() => undefined);
    throw new Error(`Found a username field but could not fill it. See screenshot on disk.`);
  }

  logger.info(`[auth-session ${session.id}] Filling password`);
  const filledPass = await fillDetectedField(page, "password", input.password);
  if (!filledPass) {
    await saveDiagnosticSnapshot(page, session.id, "pass-fill-failed").catch(() => undefined);
    throw new Error(`Found a password field but could not fill it. See screenshot on disk.`);
  }

  session.phase = "requesting_otp";
  logger.info(`[auth-session ${session.id}] Clicking submit button`);
  const submitted = await clickDetectedSubmit(page);
  if (!submitted) {
    logger.info(`[auth-session ${session.id}] No submit button found; pressing Enter as fallback`);
    await page.keyboard.press("Enter").catch(() => undefined);
  }

  // Wait for the security/OTP page to appear.
  try {
    await waitForSecurityPage(page, 30000);
  } catch (err: any) {
    const snap = await saveDiagnosticSnapshot(page, session.id, "no-otp-page").catch(() => undefined);
    throw new Error(`${err?.message || err}${snap ? ` Screenshot saved: ${snap}` : ""}`);
  }

  // Click "Send by email" (or SMS) if channel is set.
  if (session.otpChannel === "email") {
    logger.info(`[auth-session ${session.id}] Clicking "Send by email"`);
    await clickDeliveryChannel(page, "email");
  } else if (session.otpChannel === "sms") {
    logger.info(`[auth-session ${session.id}] Clicking "Send via SMS"`);
    await clickDeliveryChannel(page, "sms");
  }

  // Extract the masked recipient shown on the page for UI display.
  session.otpMaskedRecipient = await extractMaskedRecipient(page).catch(() => undefined);
  logger.info(`[auth-session ${session.id}] OTP sent to: ${session.otpMaskedRecipient || "<unknown recipient>"}`);

  session.pendingScan = {
    scanName: input.scanName,
    scanOptions: input.scanOptions || {},
    authConfig: input.authConfig || {},
    projectId: input.projectId,
    createdBy: input.createdBy,
    urls: [input.targetUrl],
    stateLabel: "prod-auth-manual-otp",
  };
  session.phase = "awaiting_otp";
  logger.info(`[auth-session ${session.id}] Ready — waiting for user to enter OTP`);
}

// -----------------------------------------------------------------------------
// Auto-detecting login form finder + filler
// -----------------------------------------------------------------------------
//
// Modern login pages fall into two families:
//   Family A: plain HTML — <input type="email"> + <input type="password">
//             + <button type="submit"> in a <form>.
//   Family B: shadow-DOM custom elements — <sky-login-component>#shadow →
//             <login-input>#shadow → <input>. Requires recursive descent.
//
// This finder handles both. It's called once at the start; the result gets
// cached on `page` via a data-attribute so the subsequent fill/click calls
// use the same discovered nodes.

interface DetectedForm {
  usernameFound: boolean;
  passwordFound: boolean;
  submitFound: boolean;
  description: string;
}

async function findLoginForm(page: Page): Promise<DetectedForm> {
  // Give the page up to 10s for the login form to become visible. Shadow-DOM
  // components can mount asynchronously.
  const timeoutMs = 10000;
  const startedAt = Date.now();
  let last: DetectedForm | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await page.evaluate(() => {
      // Recursively walk the DOM including shadow roots.
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

      // Password: <input type="password">
      const password = inputs.find(el => el.type === "password") || null;

      // Username: prefer type=email, then autocomplete hints, then text/tel/nothing,
      // BUT positioned before the password field.
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

      // Submit: <button type="submit">, then any button whose text looks like login.
      const buttons = all.filter(el =>
        (el.tagName === "BUTTON" || (el.tagName === "INPUT" && ["submit", "button"].includes((el as HTMLInputElement).type))) &&
        isVisible(el)
      ) as HTMLElement[];
      const submit =
        buttons.find(b => (b as HTMLButtonElement | HTMLInputElement).type === "submit") ||
        buttons.find(b => /accedi|sign\s?in|log\s?in|entra|conferma/i.test((b.innerText || (b as HTMLInputElement).value || "").trim())) ||
        buttons[0] || null;

      // Mark for later retrieval - we can't return DOM refs from page.evaluate.
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
  // Uses the data-axessia-role attribute set by findLoginForm.
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
    // Also log a summary of visible inputs so we can see what selectors would work
    const inputs = await page.evaluate(() => {
      const out: any[] = [];
      document.querySelectorAll("input").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          out.push({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder });
        }
      });
      return out;
    }).catch(() => []);
    logger.info(`[auth-session ${sessionId}]   Visible inputs on page: ${JSON.stringify(inputs).slice(0, 400)}`);
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
  // European cookie consent modals are loaded either inline OR inside an
  // iframe (OneTrust, Didomi, TrustArc, IAB TCF). We search every frame,
  // try every common variant of the accept button, then verify the modal
  // is actually gone before returning.
  //
  // Ship 2g fix — Sky's own consent modal uses `#notice button.accbtn` with
  // aria-label="Accetta tutto". Previous selector list missed the class-
  // scoped selector, and the "still-present" verification looked for
  // container names that DIDN'T include "notice" or "accbtn" so a successful
  // click was sometimes reported as failed. Both fixed.
  const acceptSelectors = [
    // Sky-specific — the exact button on sky.it uses class .accbtn inside #notice
    "#notice button.accbtn[aria-label='Accetta tutto']",
    "#notice button.accbtn",
    "button.accbtn[aria-label='Accetta tutto']",
    "button.accbtn",
    "[aria-label='Accetta tutto']",
    "[aria-label='Accetta tutti']",
    // Sky-specific and common Italian variants
    "button:has-text('Accetta tutto')",
    "button:has-text('Accetta tutti')",
    "button:has-text('Accetta e chiudi')",
    "button:has-text('Accetto')",
    "button:has-text('OK, accetto')",
    "button:has-text('Ho capito')",
    // English variants
    "button:has-text('Accept All')",
    "button:has-text('Accept all')",
    "button:has-text('I accept')",
    "button:has-text('Allow all')",
    "button:has-text('Agree and close')",
    // Common CMP identifiers
    "button#onetrust-accept-btn-handler",
    "button#didomi-notice-agree-button",
    "button.qc-cmp2-accept-all",
    "[aria-label*='Accetta tutto' i]",
    "[aria-label*='Accept all' i]",
    // Fallbacks - anything ROLE=button with accept-y text
    "[role='button']:has-text('Accetta tutto')",
    "[role='button']:has-text('Accept all')",
    // Anchor-styled buttons (some CMPs use <a>)
    "a:has-text('Accetta tutto')",
    "a:has-text('Accept all')",
  ];

  const frames = page.frames();
  for (const frame of frames) {
    for (const sel of acceptSelectors) {
      try {
        const btn = frame.locator(sel).first();
        const count = await btn.count().catch(() => 0);
        if (count === 0) continue;
        // Ship 2g fix — increased from 200ms to 1000ms. Cookie modals often
        // animate in from off-screen and aren't hit-testable for the first
        // ~600ms even though they're technically in the DOM.
        const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
        if (!visible) continue;
        logger.info(`[auth-session] Cookie banner: found "${sel}", clicking`);
        await btn.click({ timeout: 2000, force: false }).catch(async () => {
          // If a normal click intercepts, try force-click.
          await btn.click({ timeout: 2000, force: true }).catch(() => undefined);
        });
        await page.waitForTimeout(700);
        // Best-effort verification: the modal should now be gone. If it's not,
        // try the next selector. Look for common consent-modal container hints.
        const stillPresent = await page.evaluate(() => {
          const overlays = Array.from(document.querySelectorAll(
            // Ship 2g fix — Sky's modal uses `#notice`, not a *consent*/*cookie* class.
            // Added those + a few other real-world CMP wrappers.
            "#notice, [id='notice'], .accbtn," +
            "[id*='consent'], [class*='consent'], [id*='cookie'], [class*='cookie']," +
            "[id*='onetrust'], [id*='didomi'], [class*='cmp']," +
            "[class*='cookie-banner'], [class*='cookieBanner']"
          ));
          for (const o of overlays) {
            const s = window.getComputedStyle(o as HTMLElement);
            const r = (o as HTMLElement).getBoundingClientRect?.();
            if (s.display !== "none" && s.visibility !== "hidden" && r && r.height > 200) {
              return true;
            }
          }
          return false;
        }).catch(() => false);
        if (!stillPresent) {
          logger.info(`[auth-session] Cookie banner dismissed via "${sel}"`);
          return;  // Success
        }
      } catch { /* try next */ }
    }
  }

  // Ship 2g fix — final fallback: walk the ENTIRE DOM (including shadow roots)
  // looking for any clickable element whose visible text is /accetta.*tutto/i
  // or /accept.*all/i. This catches consent buttons wrapped in custom
  // elements or nested in unusual structures that Playwright selectors miss.
  logger.info("[auth-session] Cookie banner: no selector matched, trying DOM walker fallback");
  const walkerClicked = await page.evaluate(() => {
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
    const wantedRe = /(accetta.*tutto|accetta.*tutti|accept.*all|accept\s+all|allow.*all)/i;

    // Any clickable-looking element: button, a, [role="button"], .accbtn, input[type=button|submit]
    const candidates = all.filter(el => {
      if (!isVisible(el)) return false;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      if (tag === "button" || tag === "a" || role === "button") return true;
      if (tag === "input" && ["button", "submit"].includes((el as HTMLInputElement).type)) return true;
      if ((el as HTMLElement).classList?.contains("accbtn")) return true;
      return false;
    }) as HTMLElement[];

    // Match by innerText OR aria-label
    const target = candidates.find(c => {
      const text = (c.innerText || (c as HTMLInputElement).value || "").trim();
      const aria = c.getAttribute("aria-label") || "";
      return wantedRe.test(text) || wantedRe.test(aria);
    });
    if (!target) return false;
    try {
      target.click();
      return true;
    } catch { return false; }
  }).catch(() => false);

  if (walkerClicked) {
    await page.waitForTimeout(700);
    logger.info("[auth-session] Cookie banner dismissed via DOM walker fallback");
    return;
  }

  logger.warn("[auth-session] Could not dismiss cookie banner via any strategy. Login form may be blocked; will still try to find it.");
}

async function robustFill(page: Page, selectorSpec: string, value: string): Promise<void> {
  // selectorSpec can be "js=<expr>" for shadow DOM, XPath, or a CSS chain.
  const selectors = selectorSpec.split(" ").filter(Boolean);
  for (const sel of selectors) {
    try {
      if (sel.startsWith("js=")) {
        const jsExpr = sel.slice(3);
        const filled = await page.evaluate(({ expr, v }) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const el = new Function(`return (${expr});`)() as HTMLInputElement | null;
            if (!el) return false;
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            nativeSetter?.call(el, v);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            return true;
          } catch { return false; }
        }, { expr: jsExpr, v: value });
        if (filled) return;
        continue;
      }
      const locator = sel.startsWith("//") ? page.locator(`xpath=${sel}`) : page.locator(sel);
      if (await locator.count() > 0) {
        await locator.first().fill(value, { timeout: 5000 });
        return;
      }
    } catch { /* try next */ }
  }
  throw new Error(`Could not fill field for selector spec: ${selectorSpec.slice(0, 80)}...`);
}

async function robustClick(page: Page, selectorSpec: string): Promise<boolean> {
  const selectors = selectorSpec.split(" ").filter(Boolean);
  for (const sel of selectors) {
    try {
      if (sel.startsWith("js=")) {
        const jsExpr = sel.slice(3);
        const clicked = await page.evaluate(({ expr }) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const el = new Function(`return (${expr});`)() as HTMLElement | null;
            if (!el) return false;
            el.click();
            return true;
          } catch { return false; }
        }, { expr: jsExpr });
        if (clicked) return true;
        continue;
      }
      const locator = sel.startsWith("//") ? page.locator(`xpath=${sel}`) : page.locator(sel);
      if (await locator.count() > 0) {
        await locator.first().click({ timeout: 5000 });
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function waitForSecurityPage(page: Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const url = page.url();
      const title = await page.title().catch(() => "");
      const looksLikeSecurity = /security|otp|verify|mfa|2fa/i.test(url) ||
        /security code|codice di sicurezza|Digita il codice/i.test(title) ||
        (await page.locator("input[maxlength='1']").count()) >= 4;
      if (looksLikeSecurity) return;

      // Bot-block check
      const errorText = await page.evaluate(() => {
        const body = document.body?.innerText || "";
        return /Ops! Qualcosa non va|cannot access|access denied|blocked/i.test(body) ? body.slice(0, 300) : null;
      });
      if (errorText) throw new Error(`Sky returned a block/error page after Accedi: ${errorText.slice(0, 200)}`);
    } catch (err: any) {
      if (err?.message?.startsWith("Sky returned")) throw err;
      // otherwise ignore and retry
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Security/OTP page did not appear within 25s after clicking Accedi.");
}

async function clickDeliveryChannel(page: Page, channel: "email" | "sms"): Promise<void> {
  // Sky iD's channel-switch links may be <a>, <button>, or <span> with a
  // click handler. Instead of matching by tag+text, use getByText which
  // matches ANY element containing the text - then click that element or
  // its nearest interactive ancestor.
  //
  // Ship 2g fix — broadened the "already on target" regex to accept more of
  // Sky's language variants ("Ti abbiamo inviato una email", "una e-mail")
  // and added a DOM-walker fallback that mirrors dismissCookieConsent's,
  // so channel-switch buttons wrapped in custom elements are reachable.
  // Also logs a diagnostic body-text sample when we can't verify, which
  // makes debugging future Sky copy changes much easier.

  // Before we click, wait for the OTP page to be fully interactive.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const emailTexts = [
    "Invia tramite email",
    "Invia tramite e-mail",
    "Send by email",
    "Send via email",
  ];
  const smsTexts = [
    "Invia di nuovo via SMS",
    "Send via SMS",
    "Resend via SMS",
    "Invia via SMS",
  ];
  const targetTexts = channel === "email" ? emailTexts : smsTexts;
  // Ship 2g fix — Sky says variants like:
  //   "Abbiamo inviato una email"
  //   "Ti abbiamo inviato una e-mail"
  //   "Abbiamo inviato un SMS con un codice OTP di sicurezza"
  // The old regex missed "Ti abbiamo inviato" and the un-hyphenated "email".
  const alreadyOnTarget = channel === "email"
    ? /(Abbiamo|Ti\s+abbiamo)\s+inviato\s+(un|una)\s+e-?mail/i
    : /(Abbiamo|Ti\s+abbiamo)\s+inviato\s+un\s+SMS/i;

  // If we're already on the target channel, no click needed.
  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (alreadyOnTarget.test(bodyText)) {
    logger.info(`[auth-session] Page already on ${channel} channel; no switch needed.`);
    return;
  }

  const frames = page.frames();
  for (const frame of frames) {
    for (const text of targetTexts) {
      try {
        // getByText matches ANY element containing this text (span/div/a/button).
        const el = frame.getByText(text, { exact: false }).first();
        const count = await el.count().catch(() => 0);
        if (count === 0) continue;

        // Wait up to 2 seconds for the element to be visible/attached, not 300ms.
        try {
          await el.waitFor({ state: "visible", timeout: 2000 });
        } catch { continue; }

        logger.info(`[auth-session] Found delivery-channel text "${text}"; clicking`);

        // Try normal click first; if intercepted, force-click.
        try {
          await el.click({ timeout: 3000 });
        } catch (clickErr: any) {
          logger.info(`[auth-session] Normal click failed (${clickErr?.message?.slice(0, 60)}), trying force-click`);
          await el.click({ timeout: 3000, force: true }).catch(() => undefined);
        }

        // Wait for the page to re-render.
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(2000);

        // Verify the switch actually took effect.
        const newBodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        if (alreadyOnTarget.test(newBodyText)) {
          logger.info(`[auth-session] Verified: page now shows ${channel} channel.`);
          return;
        }
        // Also accept if the visible recipient looks like an email (channel=email)
        // or a phone (channel=sms).
        const recipientLooksRight = channel === "email"
          ? /EMAIL\s*:\s*[^\s]+@[^\s]+/i.test(newBodyText)
          : /PHONE\s*:\s*[\+\d]/i.test(newBodyText) || /TELEFONO\s*:\s*[\+\d]/i.test(newBodyText);
        if (recipientLooksRight) {
          logger.info(`[auth-session] Verified: recipient info now shows ${channel} format.`);
          return;
        }

        logger.warn(`[auth-session] Clicked "${text}" but page still does not appear to be on ${channel} channel. Body text sample: "${newBodyText.slice(0, 200)}"`);
        // Don't return - try the next variant / frame in case we misidentified.
      } catch (err: any) {
        logger.info(`[auth-session] Attempt with text "${text}" errored: ${err?.message?.slice(0, 80)}`);
      }
    }
  }

  // Ship 2g fix — DOM walker fallback. If Playwright's getByText missed the
  // element (e.g. it's inside a shadow root or the visible text has extra
  // whitespace/HTML entities), walk the entire DOM ourselves.
  logger.info(`[auth-session] Playwright locators exhausted for ${channel}; trying DOM walker fallback`);
  const wantedRe = channel === "email"
    ? /invia\s+tramite\s+e-?mail|send\s+by\s+e-?mail|send\s+via\s+e-?mail/i
    : /invia\s+(di\s+nuovo\s+)?via\s+sms|resend\s+via\s+sms|send\s+via\s+sms/i;
  const walkerClicked = await page.evaluate((pattern: string) => {
    const re = new RegExp(pattern, "i");
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

    // Prefer elements that ARE clickable (button/a/role=button); if none match,
    // fall back to the smallest matching text node's ancestor button/a/[role].
    const asClickable = (el: Element): HTMLElement | null => {
      let cur: Element | null = el;
      while (cur) {
        const tag = cur.tagName.toLowerCase();
        const role = cur.getAttribute("role");
        if (tag === "button" || tag === "a" || role === "button") return cur as HTMLElement;
        cur = cur.parentElement;
      }
      return null;
    };

    // Direct match first: an <a>/<button>/[role=button] whose own innerText matches.
    const direct = all.find(el => {
      if (!isVisible(el)) return false;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      if (!(tag === "button" || tag === "a" || role === "button")) return false;
      const text = ((el as HTMLElement).innerText || "").trim();
      return re.test(text);
    }) as HTMLElement | undefined;
    if (direct) {
      try { direct.click(); return { hit: true, via: "direct", text: (direct.innerText || "").slice(0, 80) }; }
      catch { return { hit: false, via: "direct-click-threw", text: "" }; }
    }

    // Fallback: any visible element whose OWN text matches, then bubble up to a clickable ancestor.
    const anyMatch = all.find(el => {
      if (!isVisible(el)) return false;
      const text = ((el as HTMLElement).innerText || "").trim();
      // Ignore massive containers (avoid clicking body/main)
      if (text.length > 60) return false;
      return re.test(text);
    });
    if (anyMatch) {
      const clickable = asClickable(anyMatch);
      if (clickable) {
        try { clickable.click(); return { hit: true, via: "ancestor", text: (clickable.innerText || "").slice(0, 80) }; }
        catch { return { hit: false, via: "ancestor-click-threw", text: "" }; }
      }
      // Last resort: click the matching element itself.
      try { (anyMatch as HTMLElement).click(); return { hit: true, via: "self", text: (anyMatch as HTMLElement).innerText.slice(0, 80) }; }
      catch { /* fall through */ }
    }
    return { hit: false, via: "no-match", text: "" };
  }, wantedRe.source).catch(() => ({ hit: false, via: "eval-failed", text: "" }));

  if (walkerClicked.hit) {
    logger.info(`[auth-session] DOM walker clicked ${channel} channel via ${walkerClicked.via}: "${walkerClicked.text}"`);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    const newBodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (alreadyOnTarget.test(newBodyText)) {
      logger.info(`[auth-session] Verified after walker click: page now on ${channel}`);
      return;
    }
    const recipientLooksRight = channel === "email"
      ? /EMAIL\s*:\s*[^\s]+@[^\s]+/i.test(newBodyText)
      : /PHONE\s*:\s*[\+\d]/i.test(newBodyText) || /TELEFONO\s*:\s*[\+\d]/i.test(newBodyText);
    if (recipientLooksRight) {
      logger.info(`[auth-session] Verified after walker click: recipient now shows ${channel}`);
      return;
    }
    logger.warn(`[auth-session] Walker clicked ${channel} target but verification failed. Body: "${newBodyText.slice(0, 300)}"`);
    // Give Sky the benefit of the doubt — click succeeded, verification is soft.
    return;
  }

  // Log a diagnostic body-text sample so future Sky copy changes are debuggable.
  const finalBody = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  logger.warn(`[auth-session] Could not switch delivery to "${channel}" on any frame. Walker result: ${walkerClicked.via}. Sky will use its default. Body sample: "${finalBody.slice(0, 500)}"`);
}

async function extractMaskedRecipient(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => {
    const body = document.body?.innerText || "";
    // Match "PHONE : +3934...980" or "EMAIL : mobil...com"
    const phoneMatch = body.match(/PHONE\s*:\s*([\+\d\s\-]+)/i) || body.match(/TELEFONO\s*:\s*([\+\d\s\-]+)/i);
    const emailMatch = body.match(/EMAIL\s*:\s*([^\s]+@[^\s]+)/i);
    return phoneMatch?.[1]?.trim() || emailMatch?.[1]?.trim();
  }).catch(() => undefined);
}

async function fillOtpBoxes(page: Page, otp: string): Promise<void> {
  // Sky splits the OTP across six single-character inputs. These are often
  // inside a shadow DOM (custom element like <sky-otp-component>). Use the
  // same recursive walker we use for the login form. Also search all frames.
  //
  // Success criteria: the input's .value equals the digit after typing.

  // Wait a moment in case the page is still finishing an animation.
  await page.waitForTimeout(500);

  // Cross-frame + shadow-DOM discovery of OTP-input candidates.
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

    // Match single-char input candidates:
    //   <input maxlength="1"> (most common)
    //   <input maxlength="1" type="tel">
    //   <input maxlength="1" type="text">
    //   <input maxlength="1" type="number">
    //   <input> inside class *otp* / *code* with any maxlength
    const inputs = all.filter(el =>
      el.tagName === "INPUT" &&
      isVisible(el) &&
      ((el as HTMLInputElement).maxLength === 1 ||
        /otp|code|codice|sicurezza/i.test(el.className || "") ||
        /otp|code/i.test(el.id || ""))
    ) as HTMLInputElement[];

    // Tag them for retrieval by index.
    inputs.forEach((el, i) => { (el as any).dataset.axessiaOtpIndex = String(i); });

    return {
      count: inputs.length,
      sampleAttrs: inputs.slice(0, 8).map(el => ({
        type: el.type,
        maxLength: el.maxLength,
        className: (el.className || "").slice(0, 60),
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
      })),
    };
  }).catch(() => ({ count: 0, sampleAttrs: [] as any[] }));

  logger.info(`[auth-session] fillOtpBoxes: found ${found.count} OTP input candidates`);
  if (found.count === 0) {
    logger.info(`[auth-session] fillOtpBoxes: sample DOM state: ${JSON.stringify(found.sampleAttrs).slice(0, 300)}`);
    // Log a broader input inventory so we can see what IS on the page.
    const allInputs = await page.evaluate(() => {
      const out: any[] = [];
      function walkAll(root: Document | ShadowRoot, out2: Element[]) {
        const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
        let n: Node | null = walker.currentNode;
        while (n) {
          if (n.nodeType === 1) {
            const el = n as Element;
            out2.push(el);
            if ((el as any).shadowRoot) walkAll((el as any).shadowRoot, out2);
          }
          n = walker.nextNode();
        }
      }
      const els: Element[] = [];
      walkAll(document, els);
      els.forEach(el => {
        if (el.tagName === "INPUT") {
          const r = (el as HTMLElement).getBoundingClientRect();
          const inp = el as HTMLInputElement;
          out.push({
            type: inp.type,
            maxLength: inp.maxLength,
            id: inp.id,
            name: inp.name,
            visible: r.width > 0 && r.height > 0,
          });
        }
      });
      return out;
    }).catch(() => []);
    logger.info(`[auth-session] fillOtpBoxes: full input inventory: ${JSON.stringify(allInputs).slice(0, 500)}`);
    throw new Error(
      `Only found 0 OTP boxes, expected ${otp.length}. ` +
      `The OTP page may have changed or expired. Try starting a new session.`
    );
  }
  if (found.count < otp.length) {
    throw new Error(`Only found ${found.count} OTP boxes, expected ${otp.length}.`);
  }

  // Fill each box, verifying the value stuck. Uses the same shadow-DOM walker
  // pattern as fillDetectedField so it works through custom elements.
  for (let i = 0; i < otp.length; i++) {
    const digit = otp[i];
    const ok = await page.evaluate(({ index, value }) => {
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

    if (!ok) {
      logger.warn(`[auth-session] fillOtpBoxes: digit ${i + 1} of ${otp.length} did not stick`);
    }
    await page.waitForTimeout(60);
  }
  logger.info(`[auth-session] fillOtpBoxes: all ${otp.length} digits entered`);
}

async function clickConferma(page: Page): Promise<void> {
  // Try to find the Conferma button - may be inside shadow DOM.
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

    // Prefer buttons whose text says Conferma / He confirms / Verify.
    const conferma = buttons.find(b =>
      /conferma|he confirms|confirm|verify|verifica/i.test((b.innerText || (b as HTMLInputElement).value || "").trim())
    );
    const target = conferma || buttons.find(b => (b as HTMLButtonElement | HTMLInputElement).type === "submit");
    if (!target) return false;
    try {
      target.click();
      return true;
    } catch { return false; }
  }).catch(() => false);

  if (!clicked) {
    logger.info("[auth-session] clickConferma: no button found by walker, pressing Enter as fallback");
    await page.keyboard.press("Enter").catch(() => undefined);
  } else {
    logger.info("[auth-session] clickConferma: clicked Conferma button");
  }
}

async function waitForAuthenticatedLanding(page: Page, targetUrl: string): Promise<void> {
  // Sky iD's flow can redirect through 3-5 intermediate URLs after OTP
  // submission (OAuth-style forward= parameter, service-specific callback,
  // final landing). We wait for either:
  //   1. URL no longer contains login/security/otp/verify/mfa words, OR
  //   2. URL matches the target host, OR
  //   3. 40 seconds elapse without progress
  //
  // A visible OTP error message aborts immediately.
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
      // Give the page 1 more second to fully load its content before returning.
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
      return;
    }

    // Check for a visible OTP error on the page (only when we're actually
    // still on the OTP page - don't false-positive on other pages).
    if (onAuthPage) {
      const errorText = await page.evaluate(() => {
        const body = document.body?.innerText || "";
        const matches = body.match(/codice.*non.*(valido|corretto)|invalid.*code|wrong.*code|codice.*errato/i);
        return matches ? body.slice(matches.index || 0, (matches.index || 0) + 200) : null;
      }).catch(() => null);
      if (errorText) throw new Error(`Sky reported an OTP error: ${errorText.slice(0, 200)}`);
    }

    // If the URL hasn't changed in 20s while still on an auth page, we're stuck.
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
