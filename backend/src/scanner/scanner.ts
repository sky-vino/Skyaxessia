/**
 * scanner.ts
 * ============================================================
 * Main orchestrator for Accessibility scanner.
 * Wires all modules:
 *
 *  navigation.ts      — safe retry-based page navigation
 *  axeScan.ts         — axe-core WCAG 2.0/2.1/2.2 engine
 *  heuristics.ts      — heading structure, landmarks, forms, reflow, motion, lang
 *  focusHeuristics.ts — focus visible/obscured/trap/lock/escape
 *  keyboardNav.ts     — real Tab/Arrow/Escape keyboard simulation
 *  colorContrast.ts   — actual contrast ratio measurement
 *  zoomPointer.ts     — zoom lock, reflow, touch targets, gestures
 *  stateScanner.ts    — hover/focus/expanded/error/tab states + dynamic interactions
 *  ownership.ts       — component/owner attribution
 */

import { chromium } from "playwright";
import type { ScanOptions, ProgressCallback, ScanIssue, DomSnapshot, TestCase, StateConfig, TargetInteractionConfig, TargetJourneyStep, ControlledInteractionReportItem } from "./types";
import { navigateSafely } from "./navigation";
import { runAxe } from "./axeScan";
import { runHeuristics } from "./heuristics";
import { runFocusHeuristics } from "./focusHeuristics";
import { runKeyboardNav } from "./keyboardNav";
import { runColorChecks } from "./colorContrast";
import { runZoomChecks, runPointerChecks } from "./zoomPointer";
import { runStateScanning } from "./stateScanner";
import { enrichOwnership } from "./ownership";
import { logger } from "../utils/logger";
import { canonicalUrlKey, discoverOutboundLinks, normalizeHttpUrl, passesCrawlFilters, planCrawlUrls } from "./crawlDiscovery";

export interface ScanResult {
  issues: ScanIssue[];
  testCases: TestCase[];
  domSnapshots: DomSnapshot[];
  navigatedUrls: string[];
  score: number;
}

export class AccessibilityScanner {
  private scan: any;
  private onProgress: ProgressCallback;
  private allIssues: ScanIssue[] = [];
  private testCases: TestCase[] = [];
  private domSnapshots: DomSnapshot[] = [];
  private navigationStartTime = Date.now();
  private navigatedUrls: string[] = [];
  private navigatedUrlKeys = new Set<string>();
  private scannedPageKeys = new Set<string>();
  private transitionNodes = new Map<string, { id: string; url: string; phase: string; state?: string; screenshot?: string; issueCount: number }>();
  private transitionEdges: { from?: string; to: string; trigger: string; atMs: number }[] = [];
  private lastTransitionNodeId?: string;

  constructor(scan: any, onProgress: ProgressCallback) {
    this.scan = scan;
    this.onProgress = onProgress;
  }

  async run(): Promise<ScanResult> {
    this.navigationStartTime = Date.now();
    const opts: ScanOptions = { ...this.scan.scan_options };
    const urls: string[] = this.scan.urls || [];
    const authConfig = this.scan.auth_config;
    const extraStates = opts.extra_states || [];
    const scannedEntrypoints = new Set<string>();
    const hasDestinationOnlyTargetInteractions = (Array.isArray(opts.target_interactions) ? opts.target_interactions : [])
      .some(target => target && target.scan_destination_only !== false);
    const journeyOnlyMode = opts.scan_entry_mode === "journey" || hasDestinationOnlyTargetInteractions;

    const stepsPerUrl = 12;
    const maxPerSeed = opts.crawl_mode
      ? Math.min(Math.max(1, opts.crawl_max_pages ?? 30), 200)
      : 1;
    const totalSteps = Math.max(1, urls.length * maxPerSeed) * stepsPerUrl;
    let stepsDone = 0;

    const progress = (msg: string) => {
      stepsDone++;
      this.onProgress(Math.min(Math.round((stepsDone / totalSteps) * 94) + 1, 94), msg);
    };

    const browser = await chromium.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    try {
      for (const url of urls) {
        logger.info(`Scanning URL: ${url}`);

        try {
          if (authConfig?.login_url) {
            const loginKey = canonicalUrlKey(authConfig.login_url) || authConfig.login_url;
            if (opts.scan_login_page !== false && !scannedEntrypoints.has(loginKey)) {
              const loginContext = await this.createBrowserContext(browser, opts);
              const loginPage = await loginContext.newPage();
              this.trackPageNavigations(loginPage, "login page");
              try {
                progress(`Scanning login page before authentication: ${authConfig.login_url}`);
                const ok = await this.navigateAndRecord(loginPage, authConfig.login_url, "login page");
                if (ok) {
                  await loginPage.waitForTimeout(1200);
                  if (authConfig.auto_accept_cookies !== false) {
                    await this.clearCookieConsentWithProgress(loginPage, this.authSelector(authConfig, "cookie_accept_selector"), progress, "login page");
                  }
                  await this.runFullPageScan(loginPage, authConfig.login_url, opts, extraStates, progress);
                  scannedEntrypoints.add(loginKey);
                }
              } catch (err) {
                logger.warn(`Login page scan failed for ${authConfig.login_url}; continuing with authenticated scan:`, err);
              } finally {
                await loginContext.close();
              }
            }
            //Creates browser context and waits till login authentication is completed
            const context = await this.createBrowserContext(browser, opts);
            const page = await context.newPage();
            this.trackPageNavigations(page, "authenticated session");
            try {
              progress(`Authenticating with OTP flow for ${url}`);
              const landedUrl = await this.handleLogin(page, authConfig, url);
              progress(`SUCCESS: Login and OTP completed; landed on ${landedUrl}`);
              const landedKey = canonicalUrlKey(landedUrl) || landedUrl;
              const landedAuthKey = `auth:${landedKey}`;

              const landedIsTarget = landedUrl ? this.sameUrlWithoutHash(landedUrl, url) : false;
              if (!journeyOnlyMode && opts.scan_post_login_landing !== false && landedIsTarget && landedUrl && !scannedEntrypoints.has(landedAuthKey)) {
                progress(`Scanning post-login landing page: ${landedUrl}`);
                await this.ensureAuthenticatedPage(page, authConfig, landedUrl);
                await this.runFullPageScan(page, landedUrl, opts, extraStates, progress);
                progress(`SUCCESS: Completed authenticated landing scan`);
                scannedEntrypoints.add(landedAuthKey);
                if (opts.crawl_mode && opts.post_login_tab_scan !== false) {
                  const tabLimit = Math.min(Math.max(1, opts.post_login_tab_limit ?? 12), 30);
                  await this.scanLinkedPageStates(page, landedUrl, opts, extraStates, progress, tabLimit);
                }
              } else if (!journeyOnlyMode && opts.scan_post_login_landing !== false && landedUrl && !landedIsTarget) {
                progress(`Skipping post-login landing scan because it is not the requested target URL: ${landedUrl}`);
              }

              const profileUrl = String(authConfig.profile_url || "").trim();
              const profileKey = canonicalUrlKey(profileUrl) || profileUrl;
              const profileAuthKey = `auth:${profileKey}`;
              if (!journeyOnlyMode && opts.scan_gestisci_page !== false && profileUrl && !scannedEntrypoints.has(profileAuthKey)) {
                progress(`Opening authenticated profile page: ${profileUrl}`);
                const ok = await this.navigateAndRecord(page, profileUrl, "Gestisci/profile");
                if (!ok) throw new Error(`Authenticated profile page is unreachable: ${profileUrl}`);
                await page.waitForTimeout(1500);
                await this.ensureAuthenticatedPage(page, authConfig, profileUrl);
                await this.runFullPageScan(page, profileUrl, opts, extraStates, progress);
                progress(`SUCCESS: Completed authenticated profile/Gestisci scan`);
                scannedEntrypoints.add(profileAuthKey);
                if (opts.crawl_mode && opts.post_login_tab_scan !== false) {
                  const tabLimit = Math.min(Math.max(1, opts.post_login_tab_limit ?? 12), 30);
                  await this.scanLinkedPageStates(page, profileUrl, opts, extraStates, progress, tabLimit);
                }
              }

              const targetKey = canonicalUrlKey(url) || url;
              const targetAuthKey = `auth:${targetKey}`;
              if (journeyOnlyMode) {
                progress(`Journey-only mode enabled; using ${url} only for authentication/start context`);
              } else if (opts.crawl_mode) {
                await this.runCrawlBfsForSeed(page, url, opts, extraStates, progress);
              } else if (!scannedEntrypoints.has(targetAuthKey)) {
                progress(`Navigating to authenticated target ${url}`);
                const actualTargetUrl = await this.openAuthenticatedTarget(page, authConfig, url, progress);
                if (!actualTargetUrl) {
                  continue;
                }
                await this.runFullPageScan(page, actualTargetUrl || url, opts, extraStates, progress, url);
                scannedEntrypoints.add(targetAuthKey);
                if (opts.crawl_mode) {
                  await this.scanLinkedPageStates(page, url, opts, extraStates, progress);
                }
              }

              if (!journeyOnlyMode) {
                await this.scanConfiguredPostLoginPages(page, profileUrl || landedUrl || url, opts, extraStates, progress, scannedEntrypoints, authConfig);
              }
              await this.scanTargetedInteractions(page, profileUrl || landedUrl || url, opts, extraStates, progress, scannedEntrypoints, authConfig);
            } finally {
              await context.close();
            }

            continue;
          }

          const context = await this.createBrowserContext(browser, opts);
          const page = await context.newPage();
          this.trackPageNavigations(page, "scan page");
          try {
            if (opts.crawl_mode) {
              await this.runCrawlBfsForSeed(page, url, opts, extraStates, progress);
            } else {
              progress(`Navigating to ${url}`);
              const ok = await this.navigateAndRecord(page, url, "target");
              if (!ok) {
                logger.warn(`Skipping unreachable URL: ${url}`);
                continue;
              }
              await page.waitForTimeout(1200);
              await this.runFullPageScan(page, url, opts, extraStates, progress);
              if (opts.crawl_mode) {
                await this.scanLinkedPageStates(page, url, opts, extraStates, progress);
              }
            }
          } finally {
            await context.close();
          }

        } catch (err) {
          logger.error(`Error scanning ${url}:`, err);
          this.addScanRunFailureIssue(url, err);
        }
      }
    } finally {
      await browser.close();
    }

    this.addStateGraphSummarySnapshot();
    this.allIssues = this.prioritizeIssues(this.calibrateIssues(this.deduplicateIssues(this.allIssues)));
    this.generateTestCases();
    this.generateManualHybridReviewCases();
    const score = this.computeScore(this.allIssues);
    logger.info(`Scan navigation trail (${this.navigatedUrls.length} URL${this.navigatedUrls.length === 1 ? "" : "s"}): ${this.navigatedUrls.join(" -> ") || "none recorded"}`);
    logger.info(`Scan complete: ${this.allIssues.length} issues, score ${score}`);
    return { issues: this.allIssues, testCases: this.testCases, domSnapshots: this.domSnapshots, navigatedUrls: this.navigatedUrls, score };
  }

  private async createBrowserContext(browser: any, opts: ScanOptions): Promise<any> {
    const context = await browser.newContext({
      viewport: { width: opts.viewport_width || 1366, height: opts.viewport_height || 768 },
      ignoreHTTPSErrors: true,
      locale: "en-US",
    });

    const extensionCookies = Array.isArray(opts.extension_session_cookies) ? opts.extension_session_cookies : [];
    if (extensionCookies.length) {
      const cookies = extensionCookies
        .filter(cookie => cookie?.name && cookie.domain)
        .map(cookie => ({
          name: cookie.name,
          value: String(cookie.value ?? ""),
          domain: cookie.domain,
          path: cookie.path || "/",
          expires: typeof cookie.expires === "number" && cookie.expires > 0 ? cookie.expires : -1,
          httpOnly: Boolean(cookie.httpOnly),
          secure: Boolean(cookie.secure),
          sameSite: cookie.sameSite || "Lax"
        }));
      if (cookies.length) {
        await context.addCookies(cookies);
        logger.info(`Loaded ${cookies.length} browser-extension session cookie${cookies.length === 1 ? "" : "s"} into scanner context`);
      }
    }

    return context;
  }

  private async handleLogin(page: any, auth: any, targetUrl?: string): Promise<string> {
    try {
      const usernameSelector = this.authSelector(auth, "username_selector");
      const passwordSelector = this.authSelector(auth, "password_selector");
      const submitSelector = this.authSelector(auth, "submit_selector");
      if (!usernameSelector) throw new Error("Username field selector is required for authenticated scans.");
      if (!passwordSelector) throw new Error("Password field selector is required for authenticated scans.");
      if (!submitSelector) throw new Error("Login submit selector is required for authenticated scans.");

      const loginStartUrl = this.loginStartUrlForTarget(auth, targetUrl);
      if (targetUrl && loginStartUrl !== auth.login_url) {
        logger.info(`Starting authentication from target-aware URL so post-login returns to requested target: ${loginStartUrl}`);
      }
      await this.navigateAndRecord(page, loginStartUrl, "login");
      await this.waitForSkyLoginReady(page);
      if (auth.auto_accept_cookies !== false) await this.waitAndClearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"), 12000);

      if (!await this.hasVisibleAuthControl(page, usernameSelector)) {
        const currentUrl = (() => {
          try { return page.url(); } catch { return loginStartUrl; }
        })();
        if (await this.pageLooksAuthenticatedWithoutLoginForm(page, targetUrl || currentUrl)) {
          logger.info(`No login form was found, but the browser appears to already be authenticated on ${currentUrl}; continuing scan.`);
          return currentUrl;
        }
        const explicitLoginUrl = this.explicitLoginUrlForTarget(auth, targetUrl);
        if (explicitLoginUrl && explicitLoginUrl !== currentUrl && explicitLoginUrl !== loginStartUrl) {
          logger.info(`Login form was not found at ${currentUrl}; opening configured login URL directly: ${explicitLoginUrl}`);
          await this.navigateAndRecord(page, explicitLoginUrl, "login fallback");
          await this.waitForSkyLoginReady(page);
          if (auth.auto_accept_cookies !== false) await this.waitAndClearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"), 12000);
        }
      }
      const loginUrl = page.url();

      logger.info(`Using configured login selectors: username='${usernameSelector}', password='${passwordSelector}', submit='${submitSelector}'`);

      const usernameFilled = await this.tryFillFirst(page, usernameSelector, auth.username || "", 30000);
      const usernameVerified = usernameFilled && await this.verifyFieldValue(page, usernameSelector, auth.username || "");
      if (!usernameVerified) {
        throw new Error(`Login username field was not found, was not filled, or did not retain the value with selector: ${usernameSelector}`);
      }
      this.onProgress(12, "SUCCESS: Username entered");

      let passwordFilled = await this.tryFillFirst(page, passwordSelector, auth.password || "", 30000);
      let passwordVerified = passwordFilled && await this.verifyFieldValue(page, passwordSelector, auth.password || "");

      if (!passwordVerified) {
        throw new Error(`Login password field was not found, was not filled, or did not retain the value with selector: ${passwordSelector}`);
      }
      this.onProgress(16, "SUCCESS: Password entered");

      if (auth.auto_accept_cookies !== false) await this.waitAndClearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"), 8000);
      const readyToSubmit = await this.verifyFieldValue(page, usernameSelector, auth.username || "") && await this.verifyFieldValue(page, passwordSelector, auth.password || "");
      if (!readyToSubmit) {
        throw new Error("Refusing to click Accedi because username/password are not both verified immediately before submit.");
      }
      const submittedPassword = await this.tryClickFirst(page, submitSelector);
      if (!submittedPassword) await page.keyboard.press("Enter").catch(() => undefined);
      await this.waitForLoginTransition(page, auth, loginUrl, 20000);
      if (auth.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"));

      const otpSelector = this.authSelector(auth, "otp_selector");
      const otpSubmitSelector = this.authSelector(auth, "otp_submit_selector");
      await this.waitForOtpPage(page, auth, 30000);
      const otpValue = await this.resolveOtpValue(page, auth, 30000);
      const otpControlVisible = await this.hasVisibleAuthControl(page, otpSelector);
      if (otpSelector && otpControlVisible && !otpValue) {
        throw new Error("OTP input is visible, but no OTP value could be resolved from the configured page selector or manual OTP code.");
      }
      if (otpSelector && otpValue) {
        try {
          await this.fillOtpInputs(page, otpSelector, otpValue, Math.min(auth.post_login_wait_ms || 8000, 15000));
          const otpVerified = await this.verifyOtpInputs(page, otpSelector, otpValue);
          if (!otpVerified) throw new Error("OTP fields did not retain all expected digits.");
          this.onProgress(18, "SUCCESS: OTP entered");
          if (auth.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"));
          if (otpSubmitSelector) await this.clickFirst(page, otpSubmitSelector);
          else {
            const submittedOtp = await this.tryClickFirst(page, submitSelector);
            if (!submittedOtp) await page.keyboard.press("Enter").catch(() => undefined);
          }
          this.onProgress(20, "SUCCESS: Conferma clicked");
          await this.waitForLoginTransition(page, auth, loginUrl, 20000);
        } catch (otpErr) {
          throw new Error(`OTP field was configured but could not be completed: ${(otpErr as Error)?.message || otpErr}`);
        }
      }

      await this.waitForPostLoginReady(page, auth, loginUrl);
      if (auth.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"));
      await this.waitForAuthControlsToDisappear(page, auth, 60000);
      if (await this.hasVisibleAuthControl(page, passwordSelector) || await this.hasVisibleAuthControl(page, otpSelector)) {
        throw new Error("Login did not complete; password or OTP controls are still visible.");
      }
      await this.ensureAuthenticatedPage(page, auth, page.url());
      return page.url();
    } catch (err) {
      logger.warn("Login failed; scan will not continue with the login page:", err);
      throw err;
    }
  }

  private async ensureAuthenticatedPage(page: any, auth: any, expectedUrl: string): Promise<void> {
    const currentUrl = page.url();
    const loginUrl = String(auth.login_url || "");
    const successPattern = String(auth.success_url_pattern || "").trim();

    if (/\/login|signin|sign-in|auth/i.test(currentUrl) && !successPattern) {
      logger.warn(`Authenticated URL still looks like an auth URL; validating by visible controls instead: ${currentUrl}`);
    }
    if (successPattern && !currentUrl.includes(successPattern)) {
      logger.warn(`Authenticated URL does not contain configured success pattern '${successPattern}': ${currentUrl}`);
    }
    if (await this.hasVisibleAuthControl(page, this.authSelector(auth, "password_selector")) || await this.hasVisibleAuthControl(page, this.authSelector(auth, "otp_selector"))) {
      throw new Error(`Authentication failed; login controls are still visible on ${currentUrl}.`);
    }
  }

  private sameUrlWithoutHash(a: string, b: string): boolean {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      ua.hash = "";
      ub.hash = "";
      return ua.href === ub.href;
    } catch {
      return a.split("#")[0] === b.split("#")[0];
    }
  }

  private async waitForLoginTransition(page: any, auth: any, loginUrl: string, timeout = 20000): Promise<void> {
    await Promise.race([
      page.waitForURL((url: URL) => url.href !== loginUrl, { timeout }).catch(() => undefined),
      page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined),
      page.waitForTimeout(timeout)
    ]);
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
  }

  private async waitForPostLoginReady(page: any, auth: any, loginUrl: string): Promise<void> {
    const requestedWait = Number(auth.post_login_wait_ms || 0);
    const timeout = Math.max(30000, Math.min(requestedWait || 30000, 90000));
    const successPattern = String(auth.success_url_pattern || "").trim();

    if (successPattern) {
      const reached = await page.waitForFunction(
        (pattern: string) => window.location.href.includes(pattern),
        successPattern,
        { timeout }
      ).then(() => true).catch(() => false);
      if (!reached) {
        throw new Error(`Login success URL pattern was not reached within ${timeout}ms: ${successPattern}`);
      }
    } else {
      await Promise.race([
        page.waitForURL((url: URL) => url.href !== loginUrl && !url.href.includes("/login"), { timeout }).catch(() => undefined),
        page.waitForFunction(
          (selectors: { passwordSelector?: string; otpSelector?: string }) => {
            const { passwordSelector, otpSelector } = selectors;
            const visible = (selector?: string) => {
              if (!selector) return false;
              try {
                return Array.from(document.querySelectorAll(selector)).some((el: any) => {
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
                });
              } catch {
                return false;
              }
            };
            return document.readyState === "complete" && !visible(passwordSelector) && !visible(otpSelector);
          },
          { passwordSelector: this.authSelector(auth, "password_selector"), otpSelector: this.authSelector(auth, "otp_selector") },
          { timeout }
        ).catch(() => undefined),
        page.waitForTimeout(timeout)
      ]);
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await page.waitForLoadState("load", { timeout: 20000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(Math.max(1500, Math.min(requestedWait || 2000, 5000)));
  }

  private async waitForAuthControlsToDisappear(page: any, auth: any, timeout = 60000): Promise<void> {
    const passwordSelector = this.authSelector(auth, "password_selector");
    const otpSelector = this.authSelector(auth, "otp_selector");
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const passwordVisible = await this.hasVisibleAuthControl(page, passwordSelector).catch(() => false);
      const otpVisible = await this.hasVisibleAuthControl(page, otpSelector).catch(() => false);
      const currentUrl = (() => {
        try { return page.url(); } catch { return ""; }
      })();
      if (!passwordVisible && !otpVisible && !/\/login|\/security|signin|sign-in|auth/i.test(currentUrl)) return;
      await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => undefined);
      await page.waitForTimeout(1000).catch(() => undefined);
    }
  }

  private addScanRunFailureIssue(url: string, err: unknown): void {
    const message = (err as Error)?.message || String(err || "scan failed");
    const isAuthFailure = /login|authentication|password|otp|username|auth/i.test(message);
    this.allIssues.push({
      ruleId: isAuthFailure ? "authenticated-scan-not-completed" : "scan-run-not-completed",
      severity: "serious",
      category: isAuthFailure ? "authentication-coverage" : "scan-coverage",
      message: isAuthFailure
        ? `The authenticated scan could not continue because login did not complete: ${message}`
        : `The scan could not complete for the configured URL: ${message}`,
      url,
      selector: "document",
      tags: ["scan-coverage", "advisory"],
      fixSuggestion: isAuthFailure
        ? "Verify the supplied credentials, OTP source/manual OTP value, login selectors, MFA timing, and whether the security page is waiting for user action."
        : "Check whether the page is reachable, whether the scanner can load it, and whether any configured journey selector blocked execution.",
      evidenceExplanation: `Scan stopped before the requested page could be tested. Error: ${message}`
    });
    this.testCases.push({
      name: isAuthFailure ? "Authenticated scan login gate" : "Scan execution gate",
      description: isAuthFailure
        ? "The scanner must complete login/MFA before testing authenticated pages."
        : "The scanner must reach the requested page before running accessibility checks.",
      category: "hybrid-review",
      wcagRef: "Scan coverage",
      status: "fail",
      issueUrl: url,
      steps: [`Start scan for ${url}.`, "Complete all required navigation/authentication gates.", "Run accessibility modules on the requested page."],
      result: `Failed - ${message}`
    });
  }

  private async waitForSkyLoginReady(page: any): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForFunction(() => {
      const find = (selector: string): Element | null => {
        const direct = document.querySelector(selector);
        if (direct) return direct;
        for (const el of Array.from(document.querySelectorAll("*"))) {
          const shadow = (el as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = shadow.querySelector(selector);
          if (found) return found;
          for (const nested of Array.from(shadow.querySelectorAll("*"))) {
            const nestedShadow = (nested as HTMLElement).shadowRoot;
            const nestedFound = nestedShadow?.querySelector(selector);
            if (nestedFound) return nestedFound;
          }
        }
        return null;
      };
      return Boolean(find("#sky-login-email") || document.querySelector("sky-login-component#sky-login"));
    }, { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }

  private explicitLoginUrlForTarget(auth: any, targetUrl?: string): string {
    const configuredLoginUrl = String(auth?.login_url || "").trim();
    if (!configuredLoginUrl) return "";
    if (!targetUrl) return configuredLoginUrl;
    return this.rewriteLoginForwardTarget(configuredLoginUrl, targetUrl);
  }

  private async pageLooksAuthenticatedWithoutLoginForm(page: any, targetUrl: string): Promise<boolean> {
    try {
      const currentUrl = page.url();
      if (/\/login|\/security|signin|sign-in|auth/i.test(currentUrl)) return false;
      if (targetUrl) {
        try {
          const current = new URL(currentUrl);
          const target = new URL(targetUrl);
          if (current.hostname !== target.hostname) return false;
        } catch {
          // Continue with DOM signal checks.
        }
      }
      return await page.evaluate(() => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const interactiveCount = document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[tabindex]").length;
        const hasLoginText = /accedi|login|sign in|username|password|otp|codice/i.test(text);
        return text.length > 80 && interactiveCount > 0 && !hasLoginText;
      }).catch(() => false);
    } catch {
      return false;
    }
  }

  private async waitForOtpPage(page: any, auth: any, timeout = 30000): Promise<void> {
    const otpSelector = this.authSelector(auth, "otp_selector");
    const otpSourceSelector = this.authSelector(auth, "otp_source_selector");
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hasOtpText = Boolean(await this.resolveOtpValue(page, auth, 1000).catch(() => ""));
      const hasOtpInput = await this.hasVisibleAuthControl(page, otpSelector).catch(() => false);
      const hasSource = await this.hasVisibleAuthControl(page, otpSourceSelector).catch(() => false);
      if (hasOtpText || hasOtpInput || hasSource) {
        this.onProgress(17, "SUCCESS: OTP page detected");
        return;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(700);
    }
    throw new Error("OTP page did not appear after clicking Accedi.");
  }

  private selectorCandidates(selectorList?: string): string[] {
    return String(selectorList || "")
      .split(/\n|\|/)
      .flatMap(part => part.includes(",") ? [part] : [part])
      .map(s => s.trim())
      .filter(Boolean);
  }

  private authSelector(auth: any, key: string): string {
    const defaults: Record<string, string> = {
      cookie_accept_selector: "js=document.querySelector('#notice button.accbtn[aria-label=\"Accetta tutto\"]')\n//button[@title='Accetta tutto']\n//*[@id='notice']//button[@aria-label='Accetta tutto' or normalize-space()='Accetta tutto']",
      username_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-email')\n//input[@id='sky-login-email']\n#sky-login-email",
      password_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('div.sky-login-label-password login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-password')\n//input[@id='sky-login-password']\n#sky-login-password",
      submit_selector: "js=document.querySelector('sky-login-component#sky-login button.sky-login-submit[type=\"submit\"]')\n//button[@class='sky-login-submit']\n//button[contains(@class,'sky-login-submit')]\nbutton.sky-login-submit[type='submit']",
      otp_source_selector: "div.otp-verify-sms-content > p",
      otp_selector: "input.otp-input_otp-input__QvpEl\ninput[aria-label^='Please enter OTP character'], input[name*='otp' i], div[role='textbox'], [contenteditable='true']",
      otp_submit_selector: "js=document.querySelector(\"button.sky-button-primary[aria-label='Conferma']\")\n//button[normalize-space()='Conferma']\n//button[@aria-label='Conferma' and contains(@class,'sky-button-primary')]\nbutton.sky-button-primary[aria-label='Conferma']",
    };
    return String(auth?.[key] || defaults[key] || "").trim();
  }

  private locatorRoots(page: any): any[] {
    const frames = typeof page.frames === "function" ? page.frames() : [];
    return [page, ...frames.filter((frame: any) => frame !== page.mainFrame?.())];
  }

  private async fillFirst(page: any, selectorList: string | undefined, value: string, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        const locator = root.locator(selector).first();
        if (await locator.isVisible({ timeout: Math.min(1000, timeout) }).catch(() => false)) {
          await locator.fill(value, { timeout }).catch(async () => {
            await locator.click({ timeout: 1000 });
            await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
            await page.keyboard.type(value, { delay: 20 });
          });
          if (await this.verifyFieldValue(page, selector, value)) return;
        }
      }
    }
    while (Date.now() < deadline) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of this.selectorCandidates(selectorList)) {
          const typed = await this.deepFocusAndTypeInRoot(page, root, selector, value).catch(() => false);
          if (typed && await this.verifyFieldValue(page, selector, value)) return;
          const filled = await this.deepFillInRoot(root, selector, value).catch(() => false);
          if (filled) return;
        }
      }
      await page.waitForTimeout(300);
    }
    throw new Error(`No visible input found for selectors: ${selectorList}`);
  }

  private async clickFirst(page: any, selectorList?: string): Promise<void> {
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        const locator = root.locator(selector).first();
        if (await locator.isVisible({ timeout: 3000 }).catch(() => false)) {
          await locator.click({ timeout: 3000 });
          return;
        }
      }
    }
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        const clicked = await this.deepClickInRoot(root, selector).catch(() => false);
        if (clicked) {
          await page.waitForTimeout(300).catch(() => undefined);
          return;
        }
      }
    }
    for (const root of this.locatorRoots(page)) {
      const fallback = root.getByRole?.("button", { name: /^(accedi|continua|continue|sign in|log in|login)$/i }).first();
      if (fallback && await fallback.isVisible({ timeout: 1500 }).catch(() => false)) {
        await fallback.click({ timeout: 3000 });
        return;
      }
    }
    throw new Error(`No visible button found for selectors: ${selectorList}`);
  }

  private async clickByVisibleText(page: any, label: string): Promise<boolean> {
    const escaped = this.escapeRegExp(label);
    const pattern = new RegExp(`^\\s*${escaped}\\s*$`, "i");
    const relaxedPattern = new RegExp(
      this.escapeRegExp(label).replace(/\\s+/g, "\\s+").replace(/[’']/g, "[’']"),
      "i"
    );
    for (const root of this.locatorRoots(page)) {
      const bestInteractiveClick = await this.clickBestInteractiveByTextInRoot(root, label).catch(() => false);
      if (bestInteractiveClick) return true;
      const locators = [
        root.getByRole?.("link", { name: pattern }).first(),
        root.getByRole?.("button", { name: pattern }).first(),
        root.getByText?.(pattern).first(),
        root.getByText?.(relaxedPattern).first(),
      ].filter(Boolean);
      for (const locator of locators) {
        try {
          if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
            await locator.click({ timeout: 2500, force: true });
            return true;
          }
        } catch { /* try next text locator */ }
      }
      const clicked = await this.deepActivateByTextInRoot(root, label).catch(() => false);
      if (clicked) return true;
    }
    return false;
  }

  private loginStartUrlForTarget(auth: any, targetUrl?: string): string {
    const configuredLoginUrl = String(auth?.login_url || "").trim();
    const requestedTargetUrl = String(targetUrl || "").trim();
    if (!configuredLoginUrl || !requestedTargetUrl) return configuredLoginUrl;

    try {
      const login = new URL(configuredLoginUrl);
      const target = new URL(requestedTargetUrl);
      const loginPath = login.pathname.toLowerCase();
      const looksLikeLoginEntry = /\/login|\/security|signin|sign-in|auth/.test(loginPath) || login.hostname !== target.hostname;

      if (!looksLikeLoginEntry) {
        return requestedTargetUrl;
      }

      return this.rewriteLoginForwardTarget(configuredLoginUrl, requestedTargetUrl);
    } catch {
      return configuredLoginUrl;
    }
  }

  private rewriteLoginForwardTarget(loginUrl: string, targetUrl: string): string {
    try {
      const parsed = new URL(loginUrl);
      if (parsed.searchParams.has("forward")) {
        parsed.searchParams.set("forward", targetUrl);
        return parsed.toString();
      }
      if (/\/login|\/security|signin|sign-in|auth/i.test(parsed.pathname)) {
        parsed.searchParams.set("forward", targetUrl);
        return parsed.toString();
      }
      return loginUrl;
    } catch {
      return loginUrl;
    }
  }

  private async openAuthenticatedTarget(
    page: any,
    auth: any,
    targetUrl: string,
    progress: (msg: string) => void
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const suffix = attempt > 1 ? ` (retry ${attempt})` : "";
      progress(`Navigating to authenticated target ${targetUrl}${suffix}`);
      const ok = await this.navigateAndRecord(page, targetUrl, `authenticated target${suffix}`);
      if (!ok) {
        logger.warn(`Skipping unreachable URL: ${targetUrl}`);
        return null;
      }

      if (auth?.auto_accept_cookies !== false) {
        await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector")).catch(() => undefined);
      }
      const settledUrl = await this.waitForTargetUrlToSettle(page, targetUrl);
      await this.ensureAuthenticatedPage(page, auth, targetUrl);
      if (this.sameUrlWithoutHash(settledUrl, targetUrl)) {
        return settledUrl;
      }

      this.recordNavigatedUrl(settledUrl, "authenticated target final URL after redirect");
      logger.warn(`Authenticated target redirected from ${targetUrl} to ${settledUrl} on attempt ${attempt}.`);
      const recoveredUrl = await this.recoverAuthenticatedTargetViaAppNavigation(page, auth, targetUrl, settledUrl, progress);
      if (recoveredUrl) {
        return recoveredUrl;
      }
      if (attempt < 2) {
        progress(`WARN: Target moved from ${targetUrl} to ${settledUrl}; retrying requested target once`);
        await page.waitForTimeout(1000).catch(() => undefined);
      } else {
        this.addTargetRedirectEvidence(targetUrl, settledUrl);
        progress(`WARN: Authenticated target redirected from ${targetUrl} to ${settledUrl}; target was not scanned`);
      }
    }
    return null;
  }

  private async recoverAuthenticatedTargetViaAppNavigation(
    page: any,
    auth: any,
    targetUrl: string,
    redirectedUrl: string,
    progress: (msg: string) => void
  ): Promise<string | null> {
    const labels = this.inferNavigationLabelsForTarget(targetUrl);
    if (!labels.length) return null;

    progress(`Target redirected to ${redirectedUrl}; trying authenticated app navigation: ${labels.join(", ")}`);
    for (const label of labels) {
      const clicked = await this.clickByVisibleText(page, label).catch(() => false);
      if (!clicked) continue;

      await this.waitAfterTargetStep(page, auth, progress, `navigation recovery: ${label}`).catch(() => undefined);
      this.recordNavigatedUrl(page.url(), `navigation recovery ${label}`);

      const directAfterSection = await this.tryTargetAfterAppSection(page, auth, targetUrl, progress);
      if (directAfterSection) return directAfterSection;

      const clickedTarget = await this.clickBestTargetLinkForUrl(page, targetUrl).catch(() => false);
      if (clickedTarget) {
        await this.waitAfterTargetStep(page, auth, progress, `target recovery click: ${label}`).catch(() => undefined);
        const settledUrl = await this.waitForTargetUrlToSettle(page, targetUrl, 12000);
        this.recordNavigatedUrl(settledUrl, `target recovery final URL: ${label}`);
        if (this.sameUrlWithoutHash(settledUrl, targetUrl)) return settledUrl;
      }
    }
    return null;
  }

  private inferNavigationLabelsForTarget(targetUrl: string): string[] {
    try {
      const parsed = new URL(targetUrl);
      const path = parsed.pathname.toLowerCase();
      if (path.includes("/offers") || path.includes("/offerte")) {
        return ["Offerte", "Offers"];
      }
      if (path.includes("/fatture") || path.includes("/billing") || path.includes("/bills")) {
        return ["Fatture", "Bills"];
      }
      if (path.includes("/profile") || path.includes("/profilo")) {
        return ["Profilo", "Profile"];
      }
      if (path.includes("/home") || path.includes("/gestisci")) {
        return ["Gestisci", "Home"];
      }
    } catch { /* fall through */ }
    return [];
  }

  private async tryTargetAfterAppSection(
    page: any,
    auth: any,
    targetUrl: string,
    progress: (msg: string) => void
  ): Promise<string | null> {
    progress(`Retrying target after app section opened: ${targetUrl}`);
    const ok = await this.navigateAndRecord(page, targetUrl, "authenticated target after app navigation");
    if (!ok) return null;
    if (auth?.auto_accept_cookies !== false) {
      await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector")).catch(() => undefined);
    }
    const settledUrl = await this.waitForTargetUrlToSettle(page, targetUrl, 14000);
    if (this.sameUrlWithoutHash(settledUrl, targetUrl)) {
      return settledUrl;
    }
    logger.warn(`Target still redirected after in-app navigation. Requested ${targetUrl}, browser is on ${settledUrl}.`);
    return null;
  }

  private async clickBestTargetLinkForUrl(page: any, targetUrl: string): Promise<boolean> {
    const hints = this.inferTargetContentHints(targetUrl);
    return page.evaluate((payload: { targetUrl: string; hints: string[] }) => {
      const normalize = (value: string | null | undefined) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.05;
      };
      const activate = (el: Element) => {
        const clickable = (el.closest("a[href],button,[role='button'],[role='link'],[tabindex]") || el) as HTMLElement;
        clickable.scrollIntoView({ block: "center", inline: "center" });
        clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
        clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        clickable.click();
      };
      const target = new URL(payload.targetUrl);
      const targetPath = normalize(target.pathname);
      const targetTail = normalize(target.pathname.split("/").filter(Boolean).slice(-2).join(" "));
      const hints = payload.hints.map(normalize).filter(Boolean);
      const candidates = Array.from(document.querySelectorAll("a[href],button,[role='button'],[role='link'],[tabindex],article,section,[class*='card' i]"))
        .filter(visible);

      const exactHref = candidates.find((el: any) => {
        const href = normalize(el.href || el.getAttribute?.("href"));
        return href && (href.includes(targetPath) || href.includes(payload.targetUrl.toLowerCase()));
      });
      if (exactHref) {
        activate(exactHref);
        return true;
      }

      const textMatch = candidates.find(el => {
        const text = normalize([
          el.textContent,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.closest?.("article,section,li,div")?.textContent
        ].filter(Boolean).join(" "));
        return hints.some(hint => text.includes(hint)) || (targetTail && text.includes(targetTail));
      });
      if (!textMatch) return false;
      activate(textMatch);
      return true;
    }, { targetUrl, hints }).catch(() => false);
  }

  private inferTargetContentHints(targetUrl: string): string[] {
    try {
      const path = new URL(targetUrl).pathname.toLowerCase();
      if (path.includes("/bb")) return ["Sky Wifi", "Wifi", "Internet", "Fibra", "Abbonamento Wifi", "Broadband"];
      if (path.includes("/tv")) return ["Abbonamento TV", "Sky TV", "TV"];
      if (path.includes("/voucher")) return ["Voucher", "Codice", "Buono"];
      if (path.includes("/mobile")) return ["Mobile", "Sky Mobile"];
      return path.split("/").filter(Boolean);
    } catch {
      return [];
    }
  }

  private async waitForTargetUrlToSettle(page: any, expectedUrl: string, timeoutMs = 18000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastUrl = "";
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      await page.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
      await page.waitForTimeout(500).catch(() => undefined);

      const currentUrl = (() => {
        try { return page.url(); } catch { return expectedUrl; }
      })();
      this.recordNavigatedUrl(currentUrl, "authenticated target observed URL");

      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        stableSince = Date.now();
        continue;
      }

      const stableFor = Date.now() - stableSince;
      if (this.sameUrlWithoutHash(currentUrl, expectedUrl) && stableFor >= 3000) {
        return currentUrl;
      }
      if (!this.sameUrlWithoutHash(currentUrl, expectedUrl) && stableFor >= 4000 && !/\/login|\/security|signin|sign-in|auth/i.test(currentUrl)) {
        return currentUrl;
      }
    }

    try { return page.url(); } catch { return expectedUrl; }
  }

  private addTargetRedirectEvidence(requestedUrl: string, actualUrl: string): void {
    this.recordNavigation(actualUrl, `redirected away from requested target: ${requestedUrl}`);
    this.allIssues.push({
      ruleId: "target-url-not-reached",
      severity: "serious",
      category: "navigation-coverage",
      message: `The configured target URL was not scanned because the authenticated browser redirected to ${actualUrl}.`,
      url: requestedUrl,
      selector: "document",
      tags: ["navigation-coverage", "advisory"],
      fixSuggestion: "Verify the account entitlement, route guard, post-login forward URL, and any environment redirect rules for the requested target.",
      evidenceExplanation: `Requested target: ${requestedUrl}. Final browser URL: ${actualUrl}.`
    });
    this.testCases.push({
      name: "Authenticated target URL redirected",
      description: "The scanner attempted to open the configured authenticated target URL, but the application redirected to a different page before the accessibility modules could run.",
      category: "hybrid-review",
      wcagRef: "Navigation coverage",
      status: "fail",
      issueUrl: requestedUrl,
      steps: [
        `Open authenticated target URL: ${requestedUrl}.`,
        `Actual browser URL after navigation settled: ${actualUrl}.`,
        "Confirm whether the target URL is valid for the logged-in test account and environment."
      ],
      result: "Failed - target URL redirected before the requested page became scan-ready."
    });
  }

  private async clickBestInteractiveByTextInRoot(root: any, label: string): Promise<boolean> {
    return root.evaluate((label: string) => {
      const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = normalize(label);
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const textFor = (el: Element) => normalize([
        (el as HTMLElement).innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
      ].filter(Boolean).join(" "));
      const collect = (container: Document | ShadowRoot | Element): Element[] => {
        const direct = Array.from(container.querySelectorAll("a[href],button,[role='button'],[role='link'],[role='menuitem'],[role='tab'],[tabindex]"));
        const nested = Array.from(container.querySelectorAll("*"))
          .flatMap(child => (child as HTMLElement).shadowRoot ? collect((child as HTMLElement).shadowRoot!) : []);
        return [...direct, ...nested];
      };
      const matches = collect(document)
        .filter(el => visible(el) && (textFor(el) === wanted || textFor(el).includes(wanted)))
        .sort((a, b) => {
          const ar = (a as HTMLElement).getBoundingClientRect();
          const br = (b as HTMLElement).getBoundingClientRect();
          const exactA = textFor(a) === wanted ? 0 : 1;
          const exactB = textFor(b) === wanted ? 0 : 1;
          return exactA - exactB || (ar.width * ar.height) - (br.width * br.height);
        });
      const target = matches[0] as HTMLElement | undefined;
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.click();
      return true;
    }, label);
  }

  private async tryFillFirst(page: any, selectorList: string | undefined, value: string, timeout = 5000): Promise<boolean> {
    if (!selectorList || !String(value ?? "").length) return false;
    try {
      await this.fillFirst(page, selectorList, value, timeout);
      return true;
    } catch {
      return false;
    }
  }

  private async tryClickFirst(page: any, selectorList?: string): Promise<boolean> {
    if (!selectorList) return false;
    try {
      await this.clickFirst(page, selectorList);
      return true;
    } catch {
      return false;
    }
  }

  private async hasVisibleAuthControl(page: any, selectorList?: string): Promise<boolean> {
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        try {
          if (await root.locator(selector).first().isVisible({ timeout: 300 }).catch(() => false)) return true;
        } catch { /* try next selector/root */ }
        try {
          if (await this.deepIsVisibleInRoot(root, selector)) return true;
        } catch { /* try next selector/root */ }
      }
    }
    return false;
  }

  private async verifyFieldValue(page: any, selectorList: string | undefined, expected: string): Promise<boolean> {
    if (!selectorList || !String(expected ?? "").length) return false;
    const expectedValue = String(expected);
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        try {
          const value = await root.locator(selector).first().inputValue({ timeout: 500 }).catch(() => "");
          if (value === expectedValue) return true;
        } catch { /* try deep read */ }
        try {
          const value = await this.deepReadValueInRoot(root, selector);
          if (value === expectedValue) return true;
        } catch { /* try next selector/root */ }
      }
    }
    return false;
  }

  private async deepFillInRoot(root: any, selector: string, value: string): Promise<boolean> {
    return root.evaluate((payload: { selector: string; value: string }) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        try {
          const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
          if (direct) return direct;
        } catch {
          if (isXPath) {
            // XPath was already evaluated above.
          } else {
            return null;
          }
        }
        if (!isXPath) {
          const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
          for (const child of children) {
            const shadow = (child as HTMLElement).shadowRoot;
            if (!shadow) continue;
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          return null;
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, payload.selector) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el || !isVisible(el)) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, "");
      else el.value = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      if (setter) setter.call(el, payload.value);
      else el.value = payload.value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload.value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return el.value === payload.value;
    }, { selector, value });
  }

  private async deepFocusAndTypeInRoot(page: any, root: any, selector: string, value: string): Promise<boolean> {
    const focused = await root.evaluate((selector: string) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        if (!isXPath) {
          try {
            const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
            if (direct) return direct;
          } catch {
            return null;
          }
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector) as HTMLElement | null;
      if (!el || !isVisible(el)) return false;
      el.focus();
      return document.activeElement === el || (el.getRootNode() as ShadowRoot).activeElement === el;
    }, selector).catch(() => false);
    if (!focused) return false;
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await page.keyboard.type(value, { delay: 20 });
    return true;
  }

  private async deepReadValueInRoot(root: any, selector: string): Promise<string> {
    return root.evaluate((selector: string) => {
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        if (!isXPath) {
          try {
            const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
            if (direct) return direct;
          } catch {
            return null;
          }
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
      if (!el) return "";
      return "value" in el ? String((el as HTMLInputElement | HTMLTextAreaElement).value || "") : String(el.textContent || "");
    }, selector);
  }

  private async deepClickInRoot(root: any, selector: string): Promise<boolean> {
    return root.evaluate((selector: string) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        try {
          const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
          if (direct) return direct;
        } catch {
          if (isXPath) {
            // XPath was already evaluated above.
          } else {
            return null;
          }
        }
        if (!isXPath) {
          const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
          for (const child of children) {
            const shadow = (child as HTMLElement).shadowRoot;
            if (!shadow) continue;
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          return null;
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector) as HTMLElement | null;
      if (!el || !isVisible(el)) return false;
      const target = (el.closest("button,[role='button'],input[type='button'],input[type='submit'],a") || el) as HTMLElement;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.click();
      return true;
    }, selector);
  }

  private async deepActivateByTextInRoot(root: any, label: string): Promise<boolean> {
    return root.evaluate((label: string) => {
      const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = normalize(label);
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const collect = (container: Document | ShadowRoot | Element): Element[] => {
        const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("a[href],button,[role='button'],[role='link'],div,span,li"));
        const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
          .flatMap(child => (child as HTMLElement).shadowRoot ? collect((child as HTMLElement).shadowRoot!) : []);
        return [...direct, ...nested];
      };
      const match = collect(document).find((el: any) => {
        const text = normalize([el.innerText, el.textContent, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
          .filter(Boolean).join(" "));
        return isVisible(el) && (text === wanted || text.includes(wanted));
      }) as HTMLElement | undefined;
      if (!match) return false;
      const target = (match.closest("a[href],button,[role='button'],[role='link']") || match) as HTMLElement;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.click();
      return true;
    }, label);
  }

  private async deepIsVisibleInRoot(root: any, selector: string): Promise<boolean> {
    return root.evaluate((selector: string) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        try {
          const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
          if (direct) return direct;
        } catch {
          if (isXPath) {
            // XPath was already evaluated above.
          } else {
            return null;
          }
        }
        if (!isXPath) {
          const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
          for (const child of children) {
            const shadow = (child as HTMLElement).shadowRoot;
            if (!shadow) continue;
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          return null;
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector);
      return Boolean(el && isVisible(el));
    }, selector);
  }

  private async fillOtpInputs(page: any, selectorList: string | undefined, value: string, timeout = 5000): Promise<void> {
    const digits = String(value || "").replace(/\D/g, "").split("");
    if (!digits.length) throw new Error("OTP value did not contain digits.");

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of this.selectorCandidates(selectorList)) {
          try {
            const locator = root.locator(selector);
            const count = await locator.count().catch(() => 0);
            const visibleIndexes: number[] = [];
            for (let i = 0; i < count; i++) {
              if (await locator.nth(i).isVisible({ timeout: 250 }).catch(() => false)) {
                visibleIndexes.push(i);
              }
            }
            if (visibleIndexes.length > 1) {
              for (let i = 0; i < Math.min(visibleIndexes.length, digits.length); i++) {
                const input = locator.nth(visibleIndexes[i]);
                await input.click({ timeout: 1000 }).catch(() => undefined);
                await input.fill(digits[i], { timeout: 1000 }).catch(async () => {
                  await input.type(digits[i], { timeout: 1000, delay: 25 }).catch(async () => {
                    await page.keyboard.type(digits[i], { delay: 25 });
                  });
                });
              }
              return;
            }
            if (visibleIndexes.length === 1) {
              const input = locator.nth(visibleIndexes[0]);
              await input.click({ timeout: 1000 }).catch(() => undefined);
              await input.fill(digits.join(""), { timeout: 1500 }).catch(async () => {
                await input.type(digits.join(""), { timeout: 1500, delay: 25 }).catch(async () => {
                  await page.keyboard.type(digits.join(""), { delay: 25 });
                });
              });
              return;
            }
          } catch { /* try next OTP selector/root */ }
          try {
            const filled = await this.deepFillOtpInRoot(root, selector, digits);
            if (filled) return;
          } catch { /* try next OTP selector/root through shadow DOM */ }
        }
      }
      await page.waitForTimeout(500);
    }

    await this.fillFirst(page, selectorList, digits.join(""), timeout);
  }

  private async deepFillOtpInRoot(root: any, selector: string, digits: string[]): Promise<boolean> {
    return root.evaluate((payload: { selector: string; digits: string[] }) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryAllDeep = (container: Document | ShadowRoot | Element, selector: string): Element[] => {
        let direct: Element[] = [];
        try {
          direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll(selector));
        } catch {
          direct = [];
        }
        const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
          .flatMap(child => (child as HTMLElement).shadowRoot ? queryAllDeep((child as HTMLElement).shadowRoot!, selector) : []);
        return [...direct, ...nested];
      };
      const setElementValue = (el: Element, value: string) => {
        const target = el as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
        target.focus();
        if ("value" in target) {
          const input = target as HTMLInputElement | HTMLTextAreaElement;
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(input, value);
          else input.value = value;
        } else {
          target.textContent = value;
        }
        target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true }));
      };
      const elements = queryAllDeep(document, payload.selector).filter(isVisible);
      if (!elements.length) return false;
      if (elements.length > 1) {
        elements.slice(0, payload.digits.length).forEach((el, index) => setElementValue(el, payload.digits[index]));
      } else {
        setElementValue(elements[0], payload.digits.join(""));
      }
      return true;
    }, { selector, digits });
  }

  private async verifyOtpInputs(page: any, selectorList: string | undefined, value: string): Promise<boolean> {
    const digits = String(value || "").replace(/\D/g, "").split("");
    if (!digits.length) return false;
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        try {
          const locator = root.locator(selector);
          const count = await locator.count().catch(() => 0);
          const values: string[] = [];
          for (let i = 0; i < count; i++) {
            if (await locator.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
              values.push(await locator.nth(i).inputValue({ timeout: 300 }).catch(() => ""));
            }
          }
          if (values.length > 1 && values.slice(0, digits.length).join("") === digits.join("")) return true;
          if (values.length === 1 && values[0] === digits.join("")) return true;
        } catch { /* try deep read */ }
        try {
          const joined = await root.evaluate((selector: string) => {
            const elements = Array.from(document.querySelectorAll(selector)) as Element[];
            return elements.map(el => "value" in el ? String((el as HTMLInputElement).value || "") : String(el.textContent || "")).join("");
          }, selector).catch(() => "");
          if (String(joined || "").replace(/\D/g, "") === digits.join("")) return true;
        } catch { /* try next */ }
      }
    }
    return false;
  }

  private async resolveOtpValue(page: any, auth: any, timeout = 15000): Promise<string> {
    if (auth.otp_code) return String(auth.otp_code).trim();
    const otpSourceSelector = this.authSelector(auth, "otp_source_selector");
    if (!auth.otp_from_page || !otpSourceSelector) return "";
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of this.selectorCandidates(otpSourceSelector)) {
          try {
            const source = root.locator(selector).first();
            if (!await source.isVisible({ timeout: 500 }).catch(() => false)) continue;
            const text = await source.innerText({ timeout: 1000 });
            const match = String(text || "").match(/\b(\d{4,8})\b/);
            if (match) return match[1];
          } catch { /* try next selector */ }
        }
      }
      await page.waitForTimeout(500);
    }
    return "";
  }

  private async clearCookieConsent(page: any, explicitSelector?: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const clicked = await this.acceptCookieConsent(page, explicitSelector);
      await page.waitForTimeout(clicked ? 900 : 400);
      const stillVisible = await this.hasCookieConsentPrompt(page);
      if (!stillVisible) return clicked;
    }
    logger.warn("Cookie consent prompt still appears visible after accept attempts.");
    return false;
  }

  private async waitAndClearCookieConsent(page: any, explicitSelector?: string, timeout = 12000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    let clicked = false;
    while (Date.now() < deadline) {
      clicked = await this.clearCookieConsent(page, explicitSelector) || clicked;
      if (clicked) return true;
      await page.waitForTimeout(700);
    }
    return clicked;
  }

  private async clearCookieConsentWithProgress(
    page: any,
    explicitSelector: string | undefined,
    progress: (msg: string) => void,
    context: string
  ): Promise<boolean> {
    const clicked = await this.clearCookieConsent(page, explicitSelector);
    if (clicked) progress(`SUCCESS: Cookies accepted on ${context}`);
    else if (await this.hasCookieConsentPrompt(page)) progress(`WARN: Cookie banner still visible on ${context}`);
    else progress(`SUCCESS: No cookie banner blocking ${context}`);
    return clicked;
  }

  private async hasCookieConsentPrompt(page: any): Promise<boolean> {
    const pattern = /apprezziamo la tua privacy|accetta tutto|accetta tutti|accept all|accept cookies/i;
    for (const root of this.locatorRoots(page)) {
      try {
        const visible = await root.evaluate((patternSource: string) => {
          const pattern = new RegExp(patternSource, "i");
          const collectText = (container: Document | ShadowRoot | Element): string => {
            const ownText = container instanceof Document
              ? (container.body?.innerText || container.body?.textContent || "")
              : ((container as HTMLElement).innerText || (container as Element).textContent || "");
            const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll?.("*") || []);
            const shadowText = children
              .map(child => (child as HTMLElement).shadowRoot ? collectText((child as HTMLElement).shadowRoot!) : "")
              .join(" ");
            return `${ownText} ${shadowText}`;
          };
          const text = collectText(document);
          if (!pattern.test(text)) return false;
          const collectCandidates = (container: Document | ShadowRoot | Element): Element[] => {
            const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("button,[role='button'],a,input[type='button'],input[type='submit']"));
            const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
              .flatMap(child => (child as HTMLElement).shadowRoot ? collectCandidates((child as HTMLElement).shadowRoot!) : []);
            return [...direct, ...nested];
          };
          return collectCandidates(document)
            .some((el: any) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              const label = [el.innerText, el.textContent, el.value, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
                .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && pattern.test(label);
            });
        }, pattern.source).catch(() => false);
        if (visible) return true;
      } catch { /* inspect next frame */ }
    }
    return false;
  }

  private async acceptCookieConsent(page: any, explicitSelector?: string): Promise<boolean> {
    const selectors = [
      explicitSelector,
      "#onetrust-accept-btn-handler",
      "#onetrust-accept-btn-handler button",
      "[data-testid*='accept' i]",
      "[id*='accept' i]",
      "button#acceptCookie",
      "input[type='button'][value*='Accetta' i]",
      "input[type='submit'][value*='Accetta' i]",
      "input[type='button'][value*='Accept' i]",
      "input[type='submit'][value*='Accept' i]",
      "button[aria-label*='Accept' i]",
      "button[aria-label*='Accetta' i]",
      "button:has-text('Accept all')",
      "button:has-text('Accept All')",
      "button:has-text('Accept cookies')",
      "button:has-text('Accetta tutto')",
      "button:has-text('Accetta tutti')",
      "button:has-text('Accetto')",
      "button:has-text('Accetta')",
      "[role='button']:has-text('Accetta tutto')",
      "[role='button']:has-text('Accetta tutti')",
      "[role='button']:has-text('Accetto')",
      "[role='button']:has-text('Accetta')",
      "a:has-text('Accetta tutto')",
      "a:has-text('Accetta tutti')",
      "a:has-text('Accept all')",
      "button:has-text('I accept')",
      "button:has-text('Agree')",
      "button:has-text('Allow all')",
      "[role='button']:has-text('Accept')",
    ].filter(Boolean) as string[];
    const consentText = /accept all|accept cookies|i accept|agree|allow all|accetta tutto|accetta tutti|accetto|accetta/i;

    for (let attempt = 0; attempt < 3; attempt++) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of selectors) {
          try {
            const locator = root.locator(selector).first();
            if (await locator.isVisible({ timeout: 900 }).catch(() => false)) {
              await locator.click({ timeout: 1500, force: true }).catch(async () => {
                await locator.evaluate((el: HTMLElement) => el.click()).catch(() => undefined);
              });
              await page.waitForTimeout(700);
              return true;
            }
          } catch { /* try next known consent selector */ }
          try {
            const clicked = await this.deepClickInRoot(root, selector);
            if (clicked) {
              await page.waitForTimeout(700);
              return true;
            }
          } catch { /* try next known consent selector through shadow DOM */ }
        }

        try {
          const roleButton = root.getByRole?.("button", { name: consentText }).first();
          if (roleButton && await roleButton.isVisible({ timeout: 900 }).catch(() => false)) {
            await roleButton.click({ timeout: 1500, force: true });
            await page.waitForTimeout(700);
            return true;
          }
        } catch { /* no role-based consent button found */ }

        try {
          const textButton = root.getByText?.(consentText).first();
          if (textButton && await textButton.isVisible({ timeout: 900 }).catch(() => false)) {
            await textButton.click({ timeout: 1500, force: true });
            await page.waitForTimeout(700);
            return true;
          }
        } catch { /* no generic consent text found */ }

        try {
          const clicked = await root.evaluate((patternSource: string) => {
            const pattern = new RegExp(patternSource, "i");
            const collectCandidates = (container: Document | ShadowRoot | Element): Element[] => {
              const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("button,[role='button'],input[type='button'],input[type='submit'],a,div,span"));
              const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
                .flatMap(child => (child as HTMLElement).shadowRoot ? collectCandidates((child as HTMLElement).shadowRoot!) : []);
              return [...direct, ...nested];
            };
            const candidates = collectCandidates(document);
            const isVisible = (el: Element) => {
              const rect = (el as HTMLElement).getBoundingClientRect();
              const style = window.getComputedStyle(el as HTMLElement);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            };
            const match = candidates.find((el: any) => {
              const label = [
                el.innerText,
                el.textContent,
                el.value,
                el.getAttribute?.("aria-label"),
                el.getAttribute?.("title")
              ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
              return isVisible(el) && pattern.test(label);
            }) as HTMLElement | undefined;
            if (!match) return false;
            const clickable = match.closest("button,[role='button'],input[type='button'],input[type='submit'],a") as HTMLElement | null;
            const target = clickable || match;
            target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            target.click();
            return true;
          }, consentText.source).catch(() => false);
          if (clicked) {
            await page.waitForTimeout(700);
            return true;
          }
        } catch { /* DOM click fallback failed */ }
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  /** Full accessibility pass for a single loaded page at `targetUrl`. */
  private async runFullPageScan(
    page: any,
    targetUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    strictExpectedUrl?: string
  ): Promise<void> {
    this.recordNavigation(page.url(), `scan start: ${targetUrl}`);
    if (this.scan.auth_config?.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
    if (await this.hasCookieConsentPrompt(page)) {
      throw new Error(`Cookie consent prompt is still blocking ${targetUrl}; scan aborted for this page to avoid reporting the login/privacy overlay.`);
    }
    await this.waitForMeaningfulPageContent(page, targetUrl);
    const actualUrl = (() => {
      try { return page.url(); } catch { return targetUrl; }
    })();
    if (strictExpectedUrl && !this.sameUrlWithoutHash(actualUrl, strictExpectedUrl)) {
      this.recordNavigatedUrl(actualUrl, "strict target final URL");
      this.recordNavigation(actualUrl, `redirected away from requested target: ${strictExpectedUrl}`);
      progress(`WARN: Refusing to scan redirected target. Requested ${strictExpectedUrl}, browser is on ${actualUrl}`);
      logger.warn(`Refusing to scan redirected target. Requested ${strictExpectedUrl}, browser is on ${actualUrl}.`);
      this.addTargetRedirectEvidence(strictExpectedUrl, actualUrl);
      return;
    }
    const pageKey = this.scanPageKey(targetUrl);
    if (this.scannedPageKeys.has(pageKey)) {
      progress(`Skipping duplicate page scan: ${targetUrl}`);
      return;
    }
    this.scannedPageKeys.add(pageKey);
    await this.prepareFullPageForScan(page, targetUrl, progress);

    if (opts.run_axe !== false) {
      progress(`Running axe-core WCAG scan on ${targetUrl}`);
      this.allIssues.push(...await runAxe(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_heuristics !== false) {
      progress(`Running heuristic checks on ${targetUrl}`);
      this.allIssues.push(...await runHeuristics(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_focus !== false) {
      progress(`Running focus checks on ${targetUrl}`);
      this.allIssues.push(...await runFocusHeuristics(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_color !== false) {
      progress(`Measuring color contrast on ${targetUrl}`);
      this.allIssues.push(...await runColorChecks(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_zoom !== false) {
      progress(`Running zoom and reflow checks on ${targetUrl}`);
      this.allIssues.push(...await runZoomChecks(page, targetUrl, this.scan.state_label, "zoom"));
    }

    if (opts.run_pointer !== false) {
      progress(`Running pointer and gesture checks on ${targetUrl}`);
      this.allIssues.push(...await runPointerChecks(page, targetUrl, this.scan.state_label, "pointer"));
    }

    if (opts.run_keyboard_nav !== false) {
      progress(`Simulating keyboard navigation on ${targetUrl}`);
      this.allIssues.push(...await runKeyboardNav(page, targetUrl, this.scan.state_label));
    }

    if (opts.run_states !== false) {
      progress(`Testing UI states (hover/focus/expanded/error) on ${targetUrl}`);
      const stateDepthMode = this.isDestinationOnlyTargetRun(opts) ? "shallow" : opts.scan_depth_mode || "standard";
      const stateResults = await runStateScanning(page, targetUrl, extraStates, stateDepthMode, async () => {
        if (this.scan.auth_config?.auto_accept_cookies !== false) {
          await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
          if (await this.hasCookieConsentPrompt(page)) {
            throw new Error(`Cookie banner is still visible before capturing a state screenshot for ${targetUrl}`);
          }
        }
      });
      for (const sr of stateResults) {
        this.allIssues.push(...this.deduplicateIssues(sr.issues));
        if (sr.screenshot || sr.a11yTree) {
          this.domSnapshots.push({
            url: targetUrl,
            phase: sr.stateName,
            state: sr.stateName,
            a11yTree: this.withStateMatrixMetadata(sr.a11yTree || null, targetUrl, sr.stateName, opts),
            screenshot: sr.screenshot,
          });
          this.recordTransitionNode(targetUrl, sr.stateName, sr.stateName, sr.screenshot);
        }
      }
    }

    if (opts.run_live_dom !== false) {
      progress(`Capturing accessibility tree for ${targetUrl}`);
      const snapshot = await this.captureSnapshot(page, targetUrl, "initial", opts.capture_screenshots !== false);
      snapshot.a11yTree = this.withStateMatrixMetadata(snapshot.a11yTree, targetUrl, "initial", opts);
      this.domSnapshots.push(snapshot);
      this.recordTransitionNode(targetUrl, "initial", "initial", snapshot.screenshot);
    }

    if (opts.controlled_interaction_scan) {
      await this.runControlledInteractionScan(page, targetUrl, opts, progress);
    }

    const urlIssues = this.allIssues.filter(i => i.url === targetUrl);
    await enrichOwnership(page, urlIssues, { dsPrefix: "", fallbackRules: opts.owner_fallback_rules || [] });
    if (opts.capture_screenshots !== false) {
      await this.attachIssueEvidence(page, urlIssues);
    }
  }

  private isDestinationOnlyTargetRun(opts: ScanOptions): boolean {
    return (Array.isArray(opts.target_interactions) ? opts.target_interactions : [])
      .some(target => target && target.scan_destination_only !== false);
  }

  private async runControlledInteractionScan(
    page: any,
    targetUrl: string,
    opts: ScanOptions,
    progress: (msg: string) => void
  ): Promise<void> {
    const mode = opts.controlled_interaction_mode || "safe-auto";
    const limit = Math.max(1, Math.min(60, Number(opts.controlled_interaction_limit) || 12));
    const allowlist = (opts.controlled_interaction_allowlist || []).map(item => item.toLowerCase().trim()).filter(Boolean);
    progress(`Controlled interaction scan (${mode}) on ${targetUrl}`);
    const discovered = await this.discoverControlledInteractions(page);
    const report: ControlledInteractionReportItem[] = [];
    const attempted = new Set<string>();
    const baseUrl = (() => { try { return page.url(); } catch { return targetUrl; } })();

    for (const item of discovered) {
      if (report.filter(row => ["clicked", "scanned", "failed"].includes(row.status)).length >= limit) break;
      const labelKey = `${item.selector}|${item.label}|${item.href || ""}`;
      if (attempted.has(labelKey)) continue;
      attempted.add(labelKey);
      const decision = this.controlledInteractionDecision(item, mode, allowlist, baseUrl);
      if (!decision.click) {
        report.push({ ...item, status: decision.status, reason: decision.reason });
        continue;
      }
      const before = await this.controlledPageSignature(page);
      try {
        const clicked = await page.locator(item.selector).first().click({ timeout: 5000, trial: false }).then(() => true).catch(() => false);
        if (!clicked) {
          report.push({ ...item, status: "failed", reason: "Element was discovered but Playwright could not click it." });
          continue;
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(800);
        const after = await this.controlledPageSignature(page);
        const currentUrl = after.url || targetUrl;
        const changedUrl = before.url && after.url && before.url !== after.url;
        const changedDom = before.signature !== after.signature;
        if (changedUrl && !this.sameHostname(before.url, currentUrl)) {
          report.push({ ...item, status: "blocked", outcome: "external navigation", reason: `Navigation left the starting host: ${currentUrl}` });
          await this.navigateAndRecord(page, baseUrl, "controlled interaction restore");
          continue;
        }
        if (changedUrl || changedDom) {
          const stateName = this.controlledStateName(item.label || item.kind);
          const scanUrl = changedUrl ? currentUrl : `${targetUrl}#${encodeURIComponent(stateName)}`;
          await this.scanControlledInteractionState(page, scanUrl, opts, progress, stateName);
          report.push({ ...item, status: "scanned", outcome: changedUrl ? "navigated and scanned" : "in-page state changed and scanned", scannedUrl: scanUrl });
          if (changedUrl) {
            await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => undefined);
            if (!this.sameUrlWithoutHash(page.url(), baseUrl)) {
              await this.navigateAndRecord(page, baseUrl, "controlled interaction restore");
            }
          } else {
            await page.keyboard.press("Escape").catch(() => undefined);
          }
        } else {
          report.push({ ...item, status: "clicked", outcome: "clicked; no visible URL or DOM state change detected" });
        }
      } catch (err: any) {
        report.push({ ...item, status: "failed", reason: err?.message || "Click failed." });
        await this.navigateAndRecord(page, baseUrl, "controlled interaction error restore").catch(() => undefined);
      }
    }

    this.domSnapshots.push({
      url: targetUrl,
      phase: "controlled interaction report",
      state: "controlled-interactions",
      a11yTree: {
        type: "controlled-interaction-report",
        mode,
        limit,
        summary: report.reduce((acc: Record<string, number>, item) => {
          acc[item.status] = (acc[item.status] || 0) + 1;
          return acc;
        }, {}),
        items: report,
      },
    });
  }

  private async scanControlledInteractionState(
    page: any,
    scanUrl: string,
    opts: ScanOptions,
    progress: (msg: string) => void,
    stateName: string
  ): Promise<void> {
    progress(`Scanning controlled interaction state: ${stateName}`);
    if (opts.run_axe !== false) this.allIssues.push(...await runAxe(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_heuristics !== false) this.allIssues.push(...await runHeuristics(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_focus !== false) this.allIssues.push(...await runFocusHeuristics(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_color !== false) this.allIssues.push(...await runColorChecks(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_pointer !== false) this.allIssues.push(...await runPointerChecks(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_live_dom !== false) {
      const snapshot = await this.captureSnapshot(page, scanUrl, `controlled: ${stateName}`, opts.capture_screenshots !== false);
      snapshot.a11yTree = this.withStateMatrixMetadata(snapshot.a11yTree, scanUrl, stateName, opts);
      this.domSnapshots.push(snapshot);
      this.recordTransitionNode(scanUrl, `controlled: ${stateName}`, stateName, snapshot.screenshot, "controlled interaction");
    }
  }

  private async discoverControlledInteractions(page: any): Promise<Array<{ label: string; selector: string; kind: string; href?: string; status: ControlledInteractionReportItem["status"] }>> {
    return page.evaluate(() => {
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
      };
      const cssEscape = (value: string) => {
        const esc = (window as any).CSS?.escape;
        return esc ? esc(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };
      const selectorFor = (el: Element): string => {
        const id = el.getAttribute("id");
        if (id) return `#${cssEscape(id)}`;
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === 1 && parts.length < 5) {
          const tag = node.tagName.toLowerCase();
          const attr = node.getAttribute("data-testid") || node.getAttribute("aria-label") || node.getAttribute("name");
          if (attr) {
            parts.unshift(`${tag}[${node.getAttribute("data-testid") ? "data-testid" : node.getAttribute("aria-label") ? "aria-label" : "name"}="${attr.replace(/"/g, '\\"')}"]`);
            break;
          }
          const parent: Element | null = node.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName);
          const index = siblings.indexOf(node) + 1;
          parts.unshift(`${tag}:nth-of-type(${Math.max(1, index)})`);
          node = parent;
        }
        return parts.join(" > ");
      };
      const textFor = (el: Element) => [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        (el as HTMLElement).innerText,
        el.textContent,
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 140);
      const selector = "a[href],button,[role='button'],[role='link'],summary,input[type='button'],input[type='submit'],[tabindex]:not([tabindex='-1'])";
      const seen = new Set<string>();
      return Array.from(document.querySelectorAll(selector))
        .filter(el => visible(el))
        .map(el => {
          const selector = selectorFor(el);
          const href = (el as HTMLAnchorElement).href || el.getAttribute("href") || "";
          const kind = el.tagName.toLowerCase() === "a" || el.getAttribute("role") === "link" ? "link" : "button";
          const label = textFor(el) || href || selector;
          return { label, selector, kind, href, status: "skipped" as const };
        })
        .filter(item => {
          const key = `${item.selector}|${item.label}|${item.href}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 120);
    }).catch(() => []);
  }

  private controlledInteractionDecision(
    item: { label: string; selector: string; href?: string; kind: string },
    mode: string,
    allowlist: string[],
    baseUrl: string
  ): { click: boolean; status: ControlledInteractionReportItem["status"]; reason?: string } {
    const haystack = `${item.label} ${item.selector} ${item.href || ""}`.toLowerCase();
    const risky = /(logout|log out|sign out|elimina|delete|rimuovi|remove|disdici|annulla|cancel|acquista|buy|checkout|paga|payment|conferma|confirm|salva|save|submit|invia|send|prosegui|procedi)/i;
    if (risky.test(haystack)) return { click: false, status: "blocked", reason: "Blocked by non-destructive safety rules." };
    if (item.href && !this.sameHostname(baseUrl, item.href)) return { click: false, status: "blocked", reason: "External link is outside the scan host." };
    if (mode === "tester-selected") {
      const allowed = allowlist.some(token => token && haystack.includes(token));
      return allowed ? { click: true, status: "clicked" } : { click: false, status: "skipped", reason: "Not selected by tester allowlist." };
    }
    if (mode === "safe-auto") {
      const safe = /(scopri|dettagli|detail|modifica|edit|espandi|expand|apri|open|chiudi|close|note|info|indietro|back|tab|menu|assistenza|support|fissa|appuntamento)/i.test(haystack);
      return safe ? { click: true, status: "clicked" } : { click: false, status: "skipped", reason: "Skipped in safe-auto mode because it was not clearly non-destructive." };
    }
    return { click: true, status: "clicked" };
  }

  private async controlledPageSignature(page: any): Promise<{ url: string; signature: string }> {
    return page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const dialogs = document.querySelectorAll("[role='dialog'],dialog,[aria-modal='true'],[class*='modal' i],[class*='drawer' i],[class*='sidebar' i]").length;
      const expanded = Array.from(document.querySelectorAll("[aria-expanded='true']")).length;
      return { url: location.href, signature: `${text.length}:${dialogs}:${expanded}:${document.body?.scrollHeight || 0}` };
    }).catch(() => ({ url: "", signature: "" }));
  }

  private sameHostname(a: string, b: string): boolean {
    try { return new URL(a).hostname === new URL(b, a).hostname; } catch { return false; }
  }

  private controlledStateName(label: string): string {
    return `controlled-${String(label || "interaction").replace(/\s+/g, " ").trim().slice(0, 48)}`;
  }

  private trackPageNavigations(page: any, context: string): void {
    page.on("request", (request: any) => {
      try {
        if (request.isNavigationRequest?.() && request.resourceType?.() === "document" && request.frame?.() === page.mainFrame()) {
          this.recordNavigatedUrl(request.url(), `${context} document request`);
        }
      } catch { /* ignore navigation observer errors */ }
    });
    page.on("framenavigated", (frame: any) => {
      try {
        if (frame === page.mainFrame()) {
          this.recordNavigatedUrl(frame.url(), context);
        }
      } catch { /* ignore navigation observer errors */ }
    });
  }

  private recordNavigatedUrl(rawUrl: string, context: string): void {
    const url = String(rawUrl || "").trim();
    if (!url || url === "about:blank") return;
    if (this.navigatedUrlKeys.has(url)) return;
    this.navigatedUrlKeys.add(url);
    this.navigatedUrls.push(url);
    logger.info(`Scan navigated through URL (${context}): ${url}`);
  }

  private recordNavigation(url: string, phase: string): void {
    const href = String(url || "").trim();
    if (!href) return;
    const previous = this.domSnapshots[this.domSnapshots.length - 1];
    if (previous?.url === href && previous?.phase === phase) return;
    const nodeId = this.recordTransitionNode(href, `navigation: ${phase}`, this.scan.state_label);
    this.domSnapshots.push({
      url: href,
      phase: `navigation: ${phase}`,
      state: this.scan.state_label,
      a11yTree: {
        type: "navigation-event",
        graphNodeId: nodeId,
        offsetMs: Date.now() - this.navigationStartTime,
      },
    });
  }

  private async navigateAndRecord(page: any, url: string, phase: string): Promise<boolean> {
    this.recordNavigatedUrl(url, `${phase} requested`);
    const started = Date.now();
    const ok = await navigateSafely(page, url);
    const currentUrl = (() => {
      try { return page.url(); } catch { return url; }
    })();
    this.recordNavigatedUrl(currentUrl || url, `${phase} reached`);
    const nodeId = this.recordTransitionNode(currentUrl || url, `navigation: ${phase}`, this.scan.state_label, undefined, phase);
    this.domSnapshots.push({
      url: currentUrl || url,
      phase: `navigation: ${phase}`,
      state: this.scan.state_label,
      a11yTree: {
        type: "navigation-event",
        graphNodeId: nodeId,
        requestedUrl: url,
        success: ok,
        offsetMs: started - this.navigationStartTime,
        durationMs: Date.now() - started,
      },
    });
    return ok;
  }

  private recordTransitionNode(url: string, phase: string, state?: string, screenshot?: string, trigger?: string): string {
    const id = `n${this.transitionNodes.size + 1}`;
    const existing = Array.from(this.transitionNodes.values()).find(node => node.url === url && node.phase === phase && node.state === state);
    if (existing) {
      if (screenshot && !existing.screenshot) existing.screenshot = screenshot;
      this.lastTransitionNodeId = existing.id;
      return existing.id;
    }
    const node = { id, url, phase, state, screenshot, issueCount: 0 };
    this.transitionNodes.set(id, node);
    this.transitionEdges.push({ from: this.lastTransitionNodeId, to: id, trigger: trigger || phase, atMs: Date.now() - this.navigationStartTime });
    this.lastTransitionNodeId = id;
    return id;
  }

  private withStateMatrixMetadata(a11yTree: any, url: string, state: string, opts: ScanOptions): any {
    const viewport = `${opts.viewport_width || 1366}x${opts.viewport_height || 768}`;
    return {
      ...(a11yTree && typeof a11yTree === "object" ? a11yTree : { tree: a11yTree }),
      stateMatrixCell: {
        page: this.scanPageKey(url),
        url,
        state,
        viewport,
        depth: opts.scan_depth_mode || "standard",
        auth: this.scan.auth_config ? "authenticated" : "anonymous",
      }
    };
  }

  private addStateGraphSummarySnapshot(): void {
    if (!this.transitionNodes.size) return;
    const issueCounts = new Map<string, number>();
    for (const issue of this.allIssues) {
      for (const node of this.transitionNodes.values()) {
        if (issue.url === node.url || this.sameUrlWithoutHash(issue.url, node.url)) {
          issueCounts.set(node.id, (issueCounts.get(node.id) || 0) + 1);
        }
      }
    }
    const nodes = Array.from(this.transitionNodes.values()).map(node => ({ ...node, issueCount: issueCounts.get(node.id) || node.issueCount || 0 }));
    this.domSnapshots.push({
      url: this.scan.urls?.[0] || "state-graph",
      phase: "state-graph-summary",
      state: "state-graph",
      a11yTree: {
        type: "state-transition-graph",
        nodes,
        edges: this.transitionEdges,
        matrix: nodes.map(node => ({
          nodeId: node.id,
          page: this.scanPageKey(node.url),
          url: node.url,
          state: node.state || node.phase,
          phase: node.phase,
          issueCount: issueCounts.get(node.id) || 0,
        })),
      },
    });
  }

  private scanPageKey(targetUrl: string): string {
    try {
      const parsed = new URL(targetUrl);
      const hash = parsed.hash ? `#${decodeURIComponent(parsed.hash.slice(1)).trim().toLowerCase()}` : "";
      parsed.hash = "";
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${host}${path}${parsed.search}${hash}`;
    } catch {
      return targetUrl;
    }
  }

  private scanPageKeyWithoutState(targetUrl: string): string {
    try {
      const parsed = new URL(targetUrl);
      parsed.hash = "";
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${host}${path}${parsed.search}`;
    } catch {
      return String(targetUrl || "").split("#")[0];
    }
  }

  private async prepareFullPageForScan(page: any, targetUrl: string, progress: (msg: string) => void): Promise<void> {
    try {
      const heightInfo = await page.evaluate(() => ({
        viewportHeight: window.innerHeight || document.documentElement.clientHeight || 800,
        scrollHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
      })).catch(() => ({ viewportHeight: 800, scrollHeight: 0 }));

      if (!heightInfo.scrollHeight || heightInfo.scrollHeight <= heightInfo.viewportHeight * 1.25) return;

      progress(`Expanding lazy content by scrolling through full page: ${targetUrl}`);
      const step = Math.max(320, Math.floor(heightInfo.viewportHeight * 0.75));
      for (let y = 0; y < heightInfo.scrollHeight; y += step) {
        await page.evaluate((scrollY: number) => window.scrollTo({ top: scrollY, left: 0, behavior: "instant" as ScrollBehavior }), y).catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
        if (this.scan.auth_config?.auto_accept_cookies !== false) {
          await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector")).catch(() => undefined);
        }
      }
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior })).catch(() => undefined);
      await page.waitForTimeout(350).catch(() => undefined);
    } catch (err) {
      logger.debug(`Full-page scroll preparation failed for ${targetUrl}:`, err);
    }
  }

  private async waitForMeaningfulPageContent(page: any, targetUrl: string): Promise<void> {
    const deadline = Date.now() + 30000;
    let lastState: any = null;
    while (Date.now() < deadline) {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
      lastState = await page.evaluate(() => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const visible = (el: Element) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = window.getComputedStyle(el as HTMLElement);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        const spinnerCount = Array.from(document.querySelectorAll(
          "[role='progressbar'],[aria-busy='true'],.spinner,.loader,.loading,[class*='spinner' i],[class*='loader' i],[class*='loading' i]"
        )).filter(visible).length;
        const interactiveCount = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[tabindex]"))
          .filter(visible).length;
        const mainLike = Boolean(document.querySelector("main,[role='main'],h1,h2,nav"));
        return { textLength: text.length, spinnerCount, interactiveCount, mainLike, readyState: document.readyState };
      }).catch(() => null);

      if (lastState && lastState.textLength >= 80 && lastState.interactiveCount >= 1 && (lastState.mainLike || lastState.spinnerCount === 0)) {
        return;
      }
      await page.waitForTimeout(1000);
    }

    throw new Error(`Page did not become scan-ready for ${targetUrl}; last state: ${JSON.stringify(lastState)}`);
  }

  /**
   * Breadth-first crawl from seed URL (same browser session; login should already have run).
   * Stops after `crawl_max_pages` distinct pages per seed.
   */
  private async runCrawlBfsForSeed(
    page: any,
    seedUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void
  ): Promise<void> {
    const { maxPages, maxLinkHops } = planCrawlUrls(opts);
    const scannedKeys = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: seedUrl, depth: 0 }];

    while (queue.length > 0 && scannedKeys.size < maxPages) {
      const { url, depth } = queue.shift()!;
      const ck = canonicalUrlKey(url);
      if (!ck || scannedKeys.has(ck)) continue;
      if (!passesCrawlFilters(url, seedUrl, opts)) continue;

      progress(`Crawl (${scannedKeys.size + 1}/${maxPages}, depth ${depth}): ${url}`);
      const ok = await this.navigateAndRecord(page, url, "crawl");
      if (!ok) {
        logger.warn(`Crawl: skipping unreachable URL: ${url}`);
        continue;
      }
      scannedKeys.add(ck);
      await page.waitForTimeout(1200);
      await this.runFullPageScan(page, url, opts, extraStates, progress);
      await this.scanLinkedPageStates(page, url, opts, extraStates, progress);

      if (depth >= maxLinkHops) continue;

      let baseForLinks = url;
      try {
        baseForLinks = page.url();
      } catch { /* keep url */ }

      const links = await discoverOutboundLinks(page, baseForLinks);
      for (const link of links) {
        const lk = canonicalUrlKey(link);
        if (!lk || scannedKeys.has(lk)) continue;
        if (!passesCrawlFilters(link, seedUrl, opts)) continue;
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  private async scanConfiguredPostLoginPages(
    page: any,
    baseUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    scannedKeys: Set<string>,
    authConfig: any
  ): Promise<void> {
    const labels = (Array.isArray(opts.post_login_pages) ? opts.post_login_pages : [])
      .map(label => String(label).trim())
      .filter(Boolean);
    const destinationOnlyLaunchPages = new Set(
      (Array.isArray(opts.target_interactions) ? opts.target_interactions : [])
        .filter(target => target.scan_destination_only !== false)
        .map(target => String(target.base_page || "").trim().toLowerCase())
        .filter(Boolean)
    );
    let scannedCount = 0;

    if (!labels.length) {
      progress("No authenticated post-login pages selected for scanning");
      return;
    }

    if (opts.post_login_tab_scan !== false) {
      await this.checkConfiguredPostLoginTabKeyboard(page, labels, baseUrl, progress);
    }

    for (const label of labels) {
      if (destinationOnlyLaunchPages.has(label.toLowerCase())) {
        progress(`Using ${label} only as a targeted interaction launch page; skipping full page scan`);
        continue;
      }
      const previousUrl = page.url();
      try {
        progress(`Opening authenticated section: ${label}`);
        const clicked = await this.clickByVisibleText(page, label);
        if (!clicked) {
          progress(`WARN: Authenticated section not found: ${label}`);
          logger.warn(`Authenticated section not found by visible text: ${label}`);
          continue;
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        this.recordNavigation(page.url(), `authenticated section: ${label}`);
        if (authConfig?.auto_accept_cookies !== false) {
          await this.clearCookieConsentWithProgress(page, this.authSelector(authConfig, "cookie_accept_selector"), progress, label);
        }
        await this.ensureAuthenticatedPage(page, authConfig, label);
        const currentUrl = page.url();
        const pageBaseUrl = currentUrl && currentUrl !== previousUrl
          ? currentUrl
          : `${baseUrl}#${encodeURIComponent(label)}`;
        const scanUrl = pageBaseUrl.includes("#")
          ? pageBaseUrl
          : `${pageBaseUrl}#${encodeURIComponent(label)}`;
        const key = this.scanPageKey(scanUrl);
        if (scannedKeys.has(key)) continue;
        await this.runFullPageScan(page, scanUrl, opts, extraStates, progress);
        progress(`SUCCESS: Completed authenticated section scan: ${label}`);
        scannedKeys.add(key);
        scannedCount++;
      } catch (err) {
        progress(`ERROR: Authenticated section scan failed for ${label}: ${(err as Error)?.message || err}`);
        logger.warn(`Authenticated section scan failed for ${label}:`, err);
      }
    }
    if (labels.length && scannedCount === 0) {
      const currentUrl = page.url();
      progress(`WARN: None of the configured authenticated sections were found: ${labels.join(", ")}. Scanning current authenticated page instead.`);
      logger.warn(`None of the configured authenticated sections were scanned; falling back to current page: ${currentUrl}`);
      const fallbackUrl = currentUrl && currentUrl !== "about:blank" ? currentUrl : baseUrl;
      const fallbackScanUrl = fallbackUrl.includes("#")
        ? fallbackUrl
        : `${fallbackUrl}#${encodeURIComponent("authenticated fallback")}`;
      const key = this.scanPageKey(fallbackScanUrl);
      if (!scannedKeys.has(key)) {
        await this.ensureAuthenticatedPage(page, authConfig, fallbackScanUrl).catch((err: any) => {
          logger.warn(`Authenticated fallback verification warning for ${fallbackScanUrl}:`, err);
        });
        await this.runFullPageScan(page, fallbackScanUrl, opts, extraStates, progress);
        scannedKeys.add(key);
      }
    }
  }

  private async scanTargetedInteractions(
    page: any,
    baseUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    scannedKeys: Set<string>,
    authConfig: any
  ): Promise<void> {
    const targets = (Array.isArray(opts.target_interactions) ? opts.target_interactions : [])
      .map(target => ({
        ...target,
        mode: (target.mode === "journey" ? "journey" : "single-interaction") as TargetInteractionConfig["mode"],
        base_page: String(target.base_page || "").trim(),
        name: String(target.name || target.text || target.href_contains || target.selector || "Target interaction").trim(),
        selector: String(target.selector || "").trim(),
        text: String(target.text || "").trim(),
        cta_text: String(target.cta_text || "").trim(),
        href_contains: String(target.href_contains || "").trim(),
        click_type: target.click_type || "any",
        scan_destination_only: target.scan_destination_only !== false,
        scan_launch_page: target.scan_launch_page === true,
        steps: Array.isArray(target.steps) ? target.steps : [],
      }))
      .filter(target => target.base_page && (
        target.mode === "journey"
          ? target.steps.some((step: any) => step?.action === "navigate-page" ? String(step.page || "").trim() : Boolean(step.selector || step.text || step.cta_text || step.href_contains))
          : Boolean(target.selector || target.text || target.cta_text || target.href_contains)
      ));

    if (!targets.length) return;

    for (const target of targets) {
      if (target.mode === "journey") {
        await this.scanTargetJourney(page, baseUrl, target, opts, extraStates, progress, scannedKeys, authConfig);
        continue;
      }
      await this.scanSingleTargetInteraction(page, baseUrl, target, opts, extraStates, progress, scannedKeys, authConfig);
    }
  }

  private async scanSingleTargetInteraction(
    page: any,
    baseUrl: string,
    target: TargetInteractionConfig,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    scannedKeys: Set<string>,
    authConfig: any
  ): Promise<void> {
    const displayName = target.name || "Target interaction";
    try {
      progress(`Preparing targeted interaction "${displayName}" from ${target.base_page}`);

      await this.openAuthenticatedLaunchPage(page, target.base_page, baseUrl, authConfig, progress);
      const launchUrl = page.url();

      if (authConfig?.auto_accept_cookies !== false) {
        await this.clearCookieConsentWithProgress(page, this.authSelector(authConfig, "cookie_accept_selector"), progress, target.base_page);
      }
      await this.ensureAuthenticatedPage(page, authConfig, target.base_page);

      if (target.scan_launch_page === true || target.scan_destination_only === false) {
        await this.scanTargetDestinationOnce(page, `${launchUrl}#${encodeURIComponent(`${displayName}-launch`)}`, opts, extraStates, progress, scannedKeys, `target-launch:${displayName}`);
      }

      await this.prepareTargetLaunchPage(page, displayName, progress);

      const clicked = await this.clickTargetInteraction(page, target);
      if (!clicked) {
        progress(`WARN: Targeted interaction not found: ${displayName}`);
        this.addTargetInteractionFailureIssue(displayName, target, launchUrl, "The configured target was not found on the launch page.");
        this.testCases.push({
          name: `Targeted destination scan: ${displayName}`,
          description: `Navigate to ${target.base_page}, find the configured target, click it, and scan only the destination page.`,
          category: "hybrid-review",
          wcagRef: "WCAG 2.1.1 / 2.4.3 / 4.1.2",
          status: "fail",
          issueUrl: launchUrl,
          steps: [
            `Open authenticated page: ${target.base_page}.`,
            `Find target using ${this.targetCriteriaText(target)}.`,
            "Click the target and scan the destination page.",
          ],
          result: "Blocked - the configured target was not found during this run."
        });
        return;
      }

      await this.waitAfterTargetStep(page, authConfig, progress, displayName);
      const destinationUrl = this.currentTargetUrl(page, launchUrl, displayName);
      const scanned = await this.scanTargetDestinationOnce(page, destinationUrl, opts, extraStates, progress, scannedKeys, `target:${displayName}`);
      const sidebarScanCount = await this.scanDiscoveredSidebarDestinations(page, destinationUrl, opts, extraStates, progress, scannedKeys, displayName, authConfig);
      if (!scanned && sidebarScanCount === 0) {
        progress(`Skipping duplicate targeted destination scan: ${displayName}`);
        return;
      }
      this.testCases.push({
        name: `Targeted destination scan: ${displayName}`,
        description: `The scanner used ${target.base_page} as a launch page, clicked the configured target, and scanned the resulting destination page.`,
        category: "hybrid-review",
        wcagRef: "WCAG 2.1.1 / 2.4.3 / 4.1.2",
        status: "pass",
        issueUrl: destinationUrl,
        steps: [
          `Open authenticated page: ${target.base_page}.`,
          `Find target using ${this.targetCriteriaText(target)}.`,
          "Activate the target.",
          "Run the configured accessibility modules on the destination page.",
        ],
        result: sidebarScanCount > 0 ? `Destination scanned: ${destinationUrl}; sidebar destinations scanned: ${sidebarScanCount}.` : `Destination scanned: ${destinationUrl}`
      });
      progress(`SUCCESS: Completed targeted destination scan: ${displayName}`);
    } catch (err) {
      progress(`ERROR: Targeted interaction failed for ${displayName}: ${(err as Error)?.message || err}`);
      const currentUrl = (() => {
        try { return page.url(); } catch { return baseUrl; }
      })();
      this.addTargetInteractionFailureIssue(displayName, target, currentUrl, (err as Error)?.message || "targeted interaction failed");
      this.testCases.push({
        name: `Targeted destination scan: ${displayName}`,
        description: `Navigate to ${target.base_page}, click the configured target, and scan the destination page.`,
        category: "hybrid-review",
        wcagRef: "WCAG 2.1.1 / 2.4.3 / 4.1.2",
        status: "fail",
        issueUrl: currentUrl,
        steps: [`Open ${target.base_page}.`, `Find and click: ${this.targetCriteriaText(target)}.`],
        result: `Blocked - ${(err as Error)?.message || "targeted interaction failed"}.`
      });
      logger.warn(`Targeted interaction failed for ${displayName}:`, err);
    }
  }

  private async scanTargetJourney(
    page: any,
    baseUrl: string,
    target: TargetInteractionConfig,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    scannedKeys: Set<string>,
    authConfig: any
  ): Promise<void> {
    const displayName = target.name || "Target journey";
    const executedSteps: string[] = [];
    try {
      progress(`Preparing target journey "${displayName}" from ${target.base_page}`);
      await this.openAuthenticatedLaunchPage(page, target.base_page, baseUrl, authConfig, progress);
      const launchUrl = page.url();
      await this.ensureAuthenticatedPage(page, authConfig, target.base_page);

      if (target.scan_launch_page === true || target.scan_destination_only === false) {
        await this.scanTargetDestinationOnce(page, `${launchUrl}#${encodeURIComponent(`${displayName}-launch`)}`, opts, extraStates, progress, scannedKeys, `journey-launch:${displayName}`);
      }

      let scanCount = 0;
      const steps = (target.steps || []).map(step => this.normalizeTargetStep(step)).filter(Boolean) as TargetJourneyStep[];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const label = step.name || step.page || step.text || step.cta_text || step.href_contains || step.selector || `Step ${i + 1}`;
        if (step.action === "navigate-page") {
          if (!step.page) throw new Error(`Journey step ${i + 1} is missing page`);
          progress(`Journey "${displayName}" step ${i + 1}: navigate to ${step.page}`);
          await this.openAuthenticatedLaunchPage(page, step.page, baseUrl, authConfig, progress);
          executedSteps.push(`Navigate to ${step.page}.`);
        } else {
          progress(`Journey "${displayName}" step ${i + 1}: click ${label}`);
          await this.prepareTargetLaunchPage(page, `${displayName} / ${label}`, progress);
          const clicked = await this.clickTargetInteraction(page, { ...target, ...step, name: step.name || label, base_page: target.base_page });
          if (!clicked) throw new Error(`Journey step ${i + 1} target not found: ${label}`);
          await this.waitAfterTargetStep(page, authConfig, progress, label);
          executedSteps.push(`Click ${this.targetCriteriaText({ ...target, ...step, name: step.name || label, base_page: target.base_page })}.`);
        }

        if (step.scan_after_step === true) {
          progress(`Journey "${displayName}" step ${i + 1} reached ${page.url()}; intermediate step scan suppressed so only the final journey destination is scanned`);
        }
      }

      const finalUrl = this.currentTargetUrl(page, launchUrl, displayName);
      const scanned = await this.scanTargetDestinationOnce(page, finalUrl, opts, extraStates, progress, scannedKeys, `journey:${displayName}:final`);
      if (scanned) scanCount++;
      scanCount += await this.scanDiscoveredSidebarDestinations(page, finalUrl, opts, extraStates, progress, scannedKeys, displayName, authConfig);

      this.testCases.push({
        name: `Target journey scan: ${displayName}`,
        description: `The scanner executed the configured page/link journey and scanned the requested target destination.`,
        category: "hybrid-review",
        wcagRef: "WCAG 2.1.1 / 2.4.3 / 4.1.2",
        status: scanCount > 0 ? "pass" : "pending",
        issueUrl: page.url(),
        steps: [`Open launch page: ${target.base_page}.`, ...executedSteps, "Run accessibility modules on configured destination page."],
        result: scanCount > 0 ? `Journey completed; ${scanCount} target page(s) scanned.` : "Journey completed, but destination was already scanned or unavailable."
      });
      progress(`SUCCESS: Completed target journey scan: ${displayName}`);
    } catch (err) {
      progress(`ERROR: Target journey failed for ${displayName}: ${(err as Error)?.message || err}`);
      const currentUrl = (() => {
        try { return page.url(); } catch { return baseUrl; }
      })();
      this.addTargetInteractionFailureIssue(displayName, target, currentUrl, (err as Error)?.message || "target journey failed");
      this.testCases.push({
        name: `Target journey scan: ${displayName}`,
        description: `Execute configured navigation/click steps and scan the target destination.`,
        category: "hybrid-review",
        wcagRef: "WCAG 2.1.1 / 2.4.3 / 4.1.2",
        status: "fail",
        issueUrl: currentUrl,
        steps: [`Open ${target.base_page}.`, ...executedSteps],
        result: `Blocked - ${(err as Error)?.message || "target journey failed"}.`
      });
      logger.warn(`Target journey failed for ${displayName}:`, err);
    }
  }


  private async scanDiscoveredSidebarDestinations(
    page: any,
    baseUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    scannedKeys: Set<string>,
    contextLabel: string,
    authConfig: any
  ): Promise<number> {
    if ((opts as any).scan_sidebar_links === false) return 0;
    const initialTargets = await this.waitForSidebarActionTargets(page, contextLabel, progress);
    if (!initialTargets.length) return 0;

    let scannedCount = 0;
    progress(`Scanning open sidebar for "${contextLabel}" with ${initialTargets.length} option${initialTargets.length === 1 ? "" : "s"}`);
    const sidebarUrl = this.currentTargetUrl(page, baseUrl, `${contextLabel}-sidebar`);
    if (await this.scanTargetDestinationOnce(page, sidebarUrl, opts, extraStates, progress, scannedKeys, `sidebar:${contextLabel}:open`)) {
      scannedCount++;
    }

    for (let index = 0; index < initialTargets.length; index++) {
      const target = initialTargets[index];
      try {
        if (index > 0) {
          await this.returnToSidebarOptionList(page).catch(() => undefined);
          await page.waitForTimeout(500).catch(() => undefined);
        }
        progress(`Opening sidebar option "${target.label}"`);
        const clicked = await this.clickSidebarActionTarget(page, target.label);
        if (!clicked) {
          progress(`WARN: Sidebar option was not found after returning to list: ${target.label}`);
          continue;
        }
        await this.waitAfterTargetStep(page, authConfig, progress, target.label);
        const optionUrl = this.currentTargetUrl(page, baseUrl, `${contextLabel}-sidebar-${target.label}`);
        if (await this.scanTargetDestinationOnce(page, optionUrl, opts, extraStates, progress, scannedKeys, `sidebar:${contextLabel}:option:${index + 1}`)) {
          scannedCount++;
        }
      } catch (err) {
        logger.debug(`Sidebar option scan failed for ${target.label}:`, err);
      }
    }

    if (scannedCount > 0) {
      this.testCases.push({
        name: `Sidebar destination scan: ${contextLabel}`,
        description: `The scanner opened the sidebar, scanned it, clicked the visible sidebar options, and scanned the rendered sidebar destination content.`,
        category: "hybrid-review",
        wcagRef: "WCAG 2.1.1 / 2.4.3 / 4.1.2",
        status: "pass",
        issueUrl: page.url(),
        steps: [
          "Open the configured sidebar trigger.",
          ...initialTargets.map(target => `Activate sidebar option: ${target.label}.`),
          "Run accessibility modules on each rendered sidebar destination."
        ],
        result: `Sidebar scan completed; ${scannedCount} sidebar state/page${scannedCount === 1 ? "" : "s"} scanned.`
      });
    }
    return scannedCount;
  }

  private async discoverSidebarActionTargets(page: any): Promise<{ label: string }[]> {
    const raw = await page.evaluate(() => {
      const normalize = (value: string | null | undefined) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.05;
      };
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const containers = Array.from(document.querySelectorAll("aside,[role='dialog'],[aria-modal='true'],[class*='sidebar' i],[class*='drawer' i],[class*='side-panel' i],[class*='sheet' i]"))
        .filter(el => {
          if (!visible(el)) return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(el as HTMLElement);
          const fixedOrLarge = style.position === "fixed" || style.position === "sticky" || rect.height >= viewportHeight * 0.45;
          const rightDocked = rect.right >= viewportWidth - 24 && rect.width >= Math.min(260, viewportWidth * 0.35);
          const dialogLike = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true";
          return dialogLike || (fixedOrLarge && rightDocked);
        })
        .sort((a, b) => {
          const ar = (a as HTMLElement).getBoundingClientRect();
          const br = (b as HTMLElement).getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        });
      const sidebar = containers[0];
      if (!sidebar) return [];
      const excluded = /^(x|×|close|chiudi|indietro|back|conferma|submit)$/i;
      return Array.from(sidebar.querySelectorAll("a[href],button,[role='button'],[role='link'],[tabindex]"))
        .filter(el => visible(el))
        .map(el => {
          const label = [
            el.textContent,
            el.getAttribute("aria-label"),
            el.getAttribute("title")
          ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
          return { label, normalized: normalize(label) };
        })
        .filter(item => item.label.length > 2 && !excluded.test(item.normalized) && !/privacy|informativa|cookie|termini|legal/i.test(item.normalized))
        .slice(0, 8);
    }).catch(() => []);

    const seen = new Set<string>();
    const targets: { label: string }[] = [];
    for (const item of raw) {
      const label = String(item.label || "").replace(/\s+/g, " ").trim().slice(0, 100);
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      targets.push({ label });
    }
    return targets;
  }

  private async waitForSidebarActionTargets(page: any, contextLabel: string, progress: (msg: string) => void): Promise<{ label: string }[]> {
    const deadline = Date.now() + 30000;
    let announced = false;
    while (Date.now() < deadline) {
      const targets = await this.discoverSidebarActionTargets(page);
      if (targets.length) return targets;
      if (!announced) {
        progress(`Waiting for sidebar options to render for "${contextLabel}"`);
        announced = true;
      }
      await page.waitForTimeout(1000).catch(() => undefined);
    }
    return [];
  }

  private async clickSidebarActionTarget(page: any, label: string): Promise<boolean> {
    return page.evaluate((expectedLabel: string) => {
      const normalize = (value: string | null | undefined) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const expected = normalize(expectedLabel);
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.05;
      };
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const containers = Array.from(document.querySelectorAll("aside,[role='dialog'],[aria-modal='true'],[class*='sidebar' i],[class*='drawer' i],[class*='side-panel' i],[class*='sheet' i]"))
        .filter(el => {
          if (!visible(el)) return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(el as HTMLElement);
          const hasExplicitSidebarSignal = el.tagName.toLowerCase() === "aside" || el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || /sidebar|drawer|side-panel|sheet/i.test(String(el.className || ""));
          return hasExplicitSidebarSignal && (el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || ((style.position === "fixed" || rect.height >= viewportHeight * 0.45) && rect.right >= viewportWidth - 24 && rect.width >= Math.min(260, viewportWidth * 0.35)));
        });
      const sidebar = containers[0] || document.body;
      const candidates = Array.from(sidebar.querySelectorAll("a[href],button,[role='button'],[role='link'],[tabindex]"));
      const match = candidates.find(el => visible(el) && normalize([el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ")).includes(expected)) as HTMLElement | undefined;
      if (!match) return false;
      const clickable = (match.closest("a[href],button,[role='button'],[role='link']") || match) as HTMLElement;
      clickable.scrollIntoView({ block: "center", inline: "center" });
      clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      clickable.click();
      return true;
    }, label).catch(() => false);
  }

  private async returnToSidebarOptionList(page: any): Promise<boolean> {
    const clicked = await page.evaluate(() => {
      const normalize = (value: string | null | undefined) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const candidates = Array.from(document.querySelectorAll("a[href],button,[role='button'],[tabindex]"));
      const back = candidates.find(el => visible(el) && /indietro|back/.test(normalize([el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ")))) as HTMLElement | undefined;
      if (!back) return false;
      back.click();
      return true;
    }).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(700).catch(() => undefined);
    }
    return clicked;
  }


  private async scanTargetDestinationOnce(
    page: any,
    destinationUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    scannedKeys: Set<string>,
    sourceKey: string
  ): Promise<boolean> {
    const key = this.scanPageKey(destinationUrl);
    if (scannedKeys.has(key)) return false;
    progress(`Scanning targeted page: ${destinationUrl}`);
    await this.runFullPageScan(page, destinationUrl, opts, extraStates, progress);
    scannedKeys.add(key);
    return true;
  }

  private currentTargetUrl(page: any, launchUrl: string, fallbackLabel: string): string {
    const currentUrl = page.url();
    return currentUrl && currentUrl !== launchUrl
      ? currentUrl
      : `${launchUrl}#${encodeURIComponent(fallbackLabel)}`;
  }

  private normalizeTargetStep(step: TargetJourneyStep): TargetJourneyStep | null {
    if (!step || !step.action) return null;
    return {
      action: step.action,
      page: String(step.page || "").trim() || undefined,
      name: String(step.name || "").trim() || undefined,
      selector: String(step.selector || "").trim() || undefined,
      text: String(step.text || "").trim() || undefined,
      cta_text: String(step.cta_text || "").trim() || undefined,
      href_contains: String(step.href_contains || "").trim() || undefined,
      click_type: step.click_type || "any",
      scan_after_step: step.scan_after_step === true,
    };
  }

  private async waitAfterTargetStep(page: any, authConfig: any, progress: (msg: string) => void, label: string): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    await this.waitForSlowPageContent(page, progress, label, 30000);
    if (authConfig?.auto_accept_cookies !== false) {
      await this.clearCookieConsentWithProgress(page, this.authSelector(authConfig, "cookie_accept_selector"), progress, label);
    }
  }

  private async openAuthenticatedLaunchPage(
    page: any,
    basePage: string,
    fallbackUrl: string,
    authConfig: any,
    progress: (msg: string) => void
  ): Promise<void> {
    if (/^https?:\/\//i.test(basePage)) {
      const ok = await this.navigateAndRecord(page, basePage, "target interaction base page");
      if (!ok) throw new Error(`Launch page is unreachable: ${basePage}`);
      await this.waitForSlowPageContent(page, progress, basePage, 45000);
      return;
    }

    const clicked = await this.clickVisibleTextWithRetry(page, basePage, 25000);
    if (!clicked) {
      progress(`Launch page "${basePage}" not visible from current page; returning to ${fallbackUrl}`);
      const ok = await this.navigateAndRecord(page, fallbackUrl, "target interaction fallback page");
      if (!ok) throw new Error(`Could not return to authenticated launch root: ${fallbackUrl}`);
      await this.waitForSlowPageContent(page, progress, fallbackUrl, 45000);
      const retry = await this.clickVisibleTextWithRetry(page, basePage, 25000);
      if (!retry) {
        const directLaunchUrl = this.authenticatedLaunchUrlForLabel(basePage, fallbackUrl, page.url());
        if (!directLaunchUrl) throw new Error(`Launch page navigation item was not found: ${basePage}`);
        progress(`Launch page "${basePage}" not found in visible navigation; opening known route ${directLaunchUrl}`);
        const directOk = await this.navigateAndRecord(page, directLaunchUrl, `target interaction direct launch: ${basePage}`);
        if (!directOk) throw new Error(`Launch page navigation item was not found and direct route failed: ${basePage}`);
        await this.waitForSlowPageContent(page, progress, basePage, 45000);
      }
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    await this.waitForSlowPageContent(page, progress, basePage, 30000);
    if (authConfig?.auto_accept_cookies !== false) {
      await this.clearCookieConsent(page, this.authSelector(authConfig, "cookie_accept_selector")).catch(() => undefined);
    }
  }

  private async clickVisibleTextWithRetry(page: any, label: string, timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.clickByVisibleText(page, label).catch(() => false)) return true;
      await page.waitForTimeout(1000).catch(() => undefined);
    }
    return false;
  }

  private async waitForSlowPageContent(page: any, progress: (msg: string) => void, label: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSignature = "";
    let stableCount = 0;
    let announced = false;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const interactiveCount = document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[tabindex]").length;
        const loadingText = /loading|caricamento|attendere|please wait/i.test(text);
        return {
          ready: document.readyState,
          textLength: text.length,
          interactiveCount,
          loadingText,
          height: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
        };
      }).catch(() => ({ ready: "loading", textLength: 0, interactiveCount: 0, loadingText: true, height: 0 }));
      const signature = `${state.ready}:${state.textLength}:${state.interactiveCount}:${state.height}`;
      stableCount = signature === lastSignature ? stableCount + 1 : 0;
      lastSignature = signature;
      if (state.ready === "complete" && state.textLength > 40 && state.interactiveCount > 0 && !state.loadingText && stableCount >= 1) return;
      if (!announced) {
        progress(`Waiting for slow page content to finish rendering for "${label}"`);
        announced = true;
      }
      await page.waitForTimeout(1000).catch(() => undefined);
    }
  }

  private authenticatedLaunchUrlForLabel(basePage: string, fallbackUrl: string, currentUrl?: string): string | null {
    const key = String(basePage || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const routes: Record<string, string> = {
      offerte: "/offers",
      offers: "/offers",
      gestisci: "/home",
      home: "/home",
      profilo: "/profile",
      profile: "/profile",
      impostazioni: "/settings",
      settings: "/settings",
      fatture: "/bills",
      bills: "/bills",
    };
    const route = routes[key];
    if (!route) return null;
    for (const candidate of [currentUrl, fallbackUrl, this.scan.urls?.[0]]) {
      try {
        const origin = new URL(String(candidate)).origin;
        return `${origin}${route}`;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  private addTargetInteractionFailureIssue(displayName: string, target: TargetInteractionConfig, currentUrl: string, reason: string): void {
    this.allIssues.push({
      ruleId: "targeted-interaction-not-reached",
      severity: "serious",
      category: "navigation-coverage",
      message: `The configured targeted interaction "${displayName}" was not scanned: ${reason}`,
      url: currentUrl,
      selector: target.selector || target.cta_text || target.text || target.base_page || "document",
      wcag: ["wcag2.1.1", "wcag2.4.3", "wcag4.1.2"],
      tags: ["navigation-coverage"],
      fixSuggestion: "Verify the launch page label or route, CTA text, selector fallback, account entitlement, and whether the target is rendered only after delayed authenticated content loads.",
      evidenceExplanation: `Launch page: ${target.base_page}. Criteria: ${this.targetCriteriaText(target)}. Current browser URL: ${currentUrl}.`
    });
  }

  private async clickTargetInteraction(page: any, target: TargetInteractionConfig): Promise<boolean> {
    const label = target.name || target.text || target.cta_text || target.selector || "target interaction";
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await this.clickTargetInteractionOnce(page, target)) return true;
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1500).catch(() => undefined);
    }
    logger.warn(`Timed out waiting for targeted interaction to render: ${label}`);
    return false;
  }

  private async clickTargetInteractionOnce(page: any, target: TargetInteractionConfig): Promise<boolean> {
    if (target.selector && await this.tryClickFirst(page, target.selector)) return true;

    const cardText = String(target.text || target.name || "").trim();
    const ctaText = String(target.cta_text || "").trim() || (String(target.name || "").trim() && String(target.text || "").trim()
      ? String(target.text || "").trim()
      : "");
    const payload = {
      text: cardText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim(),
      ctaText: ctaText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim(),
      hrefContains: String(target.href_contains || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(),
      clickType: target.click_type || "any",
    };

    const clicked = await page.evaluate((criteria: { text: string; ctaText: string; hrefContains: string; clickType: string }) => {
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const normalize = (value: string | null | undefined) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const elementText = (el: Element) => normalize([
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.closest("[aria-label]")?.getAttribute("aria-label"),
      ].filter(Boolean).join(" "));
      const isKind = (el: Element) => {
        if (criteria.clickType === "any") return true;
        const role = normalize(el.getAttribute("role"));
        const tag = el.tagName.toLowerCase();
        if (criteria.clickType === "button") return tag === "button" || role === "button";
        if (criteria.clickType === "link") return tag === "a" || role === "link";
        if (criteria.clickType === "heading-link") {
          const link = el.closest("a[href],[role='link']");
          return Boolean(link && (link.closest("h1,h2,h3,h4,h5,h6") || /title|heading|headline/i.test((link as HTMLElement).className || "")));
        }
        return true;
      };
      const activate = (el: Element) => {
        const clickable = (el.closest("a[href],button,[role='button'],[role='link']") || el) as HTMLElement;
        clickable.scrollIntoView({ block: "center", inline: "center" });
        clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
        clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        clickable.click();
      };
      const interactiveSelector = "a[href],button,[role='button'],[role='link'],[tabindex]";

      if (criteria.text && criteria.ctaText) {
        const containers = Array.from(document.querySelectorAll("article,section,li,[class*='card' i],[class*='promo' i],div"))
          .filter(el => visible(el) && normalize(el.textContent).includes(criteria.text))
          .sort((a, b) => {
            const ar = (a as HTMLElement).getBoundingClientRect();
            const br = (b as HTMLElement).getBoundingClientRect();
            return (ar.width * ar.height) - (br.width * br.height);
          });
        for (const container of containers) {
          const ctas = Array.from(container.querySelectorAll(interactiveSelector)).filter(el => visible(el) && isKind(el));
          const match = ctas.find(el => {
            const href = normalize((el as HTMLAnchorElement).href || el.getAttribute("href"));
            const text = elementText(el);
            const ctaOk = text.includes(criteria.ctaText);
            const hrefOk = !criteria.hrefContains || !href || href.includes(criteria.hrefContains);
            return ctaOk && hrefOk;
          });
          if (match) {
            activate(match);
            return true;
          }
        }
      }

      const candidates = Array.from(document.querySelectorAll(interactiveSelector));
      const match = candidates.find(el => {
        if (!visible(el) || !isKind(el)) return false;
        const href = normalize((el as HTMLAnchorElement).href || el.getAttribute("href"));
        const nearby = normalize(el.closest("article,section,li,div")?.textContent);
        const text = normalize([elementText(el), nearby].filter(Boolean).join(" "));
        const textOk = !criteria.text || text.includes(criteria.text);
        const ctaOk = !criteria.ctaText || text.includes(criteria.ctaText);
        const hrefOk = !criteria.hrefContains || href.includes(criteria.hrefContains);
        return textOk && ctaOk && hrefOk;
      }) as HTMLElement | undefined;
      if (!match) return false;
      activate(match);
      return true;
    }, payload).catch(() => false);

    if (clicked) return true;
    if (!cardText && ctaText && await this.clickByVisibleText(page, ctaText)) return true;
    if (!ctaText && cardText && await this.clickByVisibleText(page, cardText)) return true;
    return false;
  }

  private async prepareTargetLaunchPage(page: any, label: string, progress: (msg: string) => void): Promise<void> {
    try {
      progress(`Preparing targeted launch page for "${label}" by loading visible cards`);
      await page.evaluate(async () => {
        const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const maxScroll = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const step = Math.max(320, Math.floor(window.innerHeight * 0.75));
        for (let y = 0; y <= maxScroll; y += step) {
          window.scrollTo(0, y);
          await delay(180);
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(500);
    } catch (err) {
      logger.debug(`Target launch page preparation failed for ${label}:`, err);
    }
  }

  private targetCriteriaText(target: TargetInteractionConfig): string {
    return [
      target.selector ? `selector "${target.selector}"` : "",
      target.text ? `text "${target.text}"` : "",
      target.cta_text ? `CTA "${target.cta_text}"` : "",
      target.href_contains ? `href contains "${target.href_contains}"` : "",
      target.click_type && target.click_type !== "any" ? `click type "${target.click_type}"` : "",
    ].filter(Boolean).join(", ") || "configured target";
  }

  private async checkConfiguredPostLoginTabKeyboard(
    page: any,
    labels: string[],
    baseUrl: string,
    progress: (msg: string) => void
  ): Promise<void> {
    if (!labels.length) return;
    try {
      progress(`Checking keyboard access for selected authenticated sections: ${labels.join(", ")}`);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => undefined);
      const reachedSet = new Set<string>();
      for (let i = 0; i < 90; i += 1) {
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(40).catch(() => undefined);
        const reachedNow = await page.evaluate((expectedLabels: string[]) => {
        const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
        const expected = expectedLabels.map(label => ({ label, key: normalize(label) }));
        const found = new Set<string>();
        const textFor = (el: Element | null) => {
          if (!el) return "";
          const target = el as HTMLElement;
          const nearest = target.closest("a,button,[role='tab'],[role='menuitem'],[role='link'],[tabindex]");
          return [
            target.innerText,
            target.textContent,
            target.getAttribute("aria-label"),
            target.getAttribute("title"),
            nearest?.textContent,
            nearest?.getAttribute("aria-label"),
            nearest?.getAttribute("title"),
          ].filter(Boolean).join(" ");
        };

        const focusText = normalize(textFor(document.activeElement));
        for (const item of expected) {
          if (focusText.includes(item.key)) found.add(item.label);
        }
        return Array.from(found);
      }, labels).catch(() => []);
        reachedNow.forEach((label: string) => reachedSet.add(label));
      }
      const reached = Array.from(reachedSet);

      const missing = labels.filter(label => !reached.includes(label));
      if (!missing.length) {
        progress(`SUCCESS: Selected authenticated sections are reachable by keyboard tab navigation`);
        return;
      }
      progress(`WARN: Selected authenticated sections not reached by keyboard tabbing: ${missing.join(", ")}`);
      this.allIssues.push({
        ruleId: "keyboard:configured-nav-tab-reachable",
        severity: "serious",
        priority: 2,
        category: "keyboard",
        message: `Selected authenticated navigation items were not reached with keyboard Tab navigation: ${missing.join(", ")}`,
        url: `${baseUrl}#${encodeURIComponent("Gestisci navigation")}`,
        selector: "nav, aside, [role='navigation']",
        selectors: ["nav, aside, [role='navigation']"],
        wcag: ["wcag2.1.1", "wcag2.4.3", "wcag2.4.7"],
        phase: "keyboard",
        state: "configured-nav",
        affectedCount: missing.length,
        fixSuggestion: "Ensure every selected authenticated navigation item can receive keyboard focus in a logical order and exposes a clear visible focus indicator.",
      });
    } catch (err) {
      progress(`WARN: Could not verify keyboard access for authenticated navigation: ${(err as Error)?.message || err}`);
    }
  }

  private async scanLinkedPageStates(
    page: any,
    seedUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    limit = 8
  ): Promise<void> {
    if (opts.run_states === false) return;

    const candidates = await this.discoverPageStateTargets(page, seedUrl);
    const scanned = new Set<string>([canonicalUrlKey(seedUrl) || seedUrl]);
    for (const target of candidates.slice(0, limit)) {
      try {
        progress(`Scanning linked offerte state: ${target.label}`);
        if (target.href) {
          const key = canonicalUrlKey(target.href) || target.href;
          if (scanned.has(key)) continue;
          const ok = await this.navigateAndRecord(page, target.href, `linked page state ${target.label}`);
          if (!ok) continue;
          scanned.add(key);
          await page.waitForTimeout(1200);
          if (this.scan.auth_config?.auto_accept_cookies !== false) {
            await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
          }
          await this.runFullPageScan(page, target.href, opts, extraStates, progress);
          continue;
        }

        const locator = page.locator(target.selector).first();
        if (!await locator.isVisible({ timeout: 1000 }).catch(() => false)) continue;
        await locator.click({ timeout: 2500, force: true });
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
        if (this.scan.auth_config?.auto_accept_cookies !== false) {
          await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
        }
        const currentUrl = page.url();
        const labelUrl = currentUrl === seedUrl ? `${seedUrl}#${encodeURIComponent(target.label)}` : currentUrl;
        await this.runFullPageScan(page, labelUrl, opts, extraStates, progress);
      } catch (err) {
        logger.debug(`Linked page state scan failed for ${target.label}:`, err);
      } finally {
        if (page.url() !== seedUrl) {
          await this.navigateAndRecord(page, seedUrl, "return to seed page").catch(() => undefined);
          await page.waitForTimeout(800).catch(() => undefined);
        }
      }
    }
  }

  private async discoverPageStateTargets(page: any, seedUrl: string): Promise<{ label: string; selector: string; href?: string }[]> {
    const rawTargets = await page.evaluate(() => {
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const selectorFor = (el: Element, index: number) => {
        const id = el.getAttribute("id");
        if (id) return `#${CSS.escape(id)}`;
        const role = el.getAttribute("role");
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const tag = el.tagName.toLowerCase();
        if (role === "tab") return `[role='tab']:nth-of-type(${index + 1})`;
        if (tag === "button") return `button:nth-of-type(${index + 1})`;
        if (tag === "a") return `a:nth-of-type(${index + 1})`;
        return text ? `${tag}:nth-of-type(${index + 1})` : tag;
      };
      const tabLikeText = /offerte|mobile|internet|tv|calcio|sport|cinema|intrattenimento|fibra|wifi|sky|now|business|casa|extra/i;
      return Array.from(document.querySelectorAll("a[href],[role='tab'],nav a,button[role='tab']"))
        .map((el, index) => {
          const text = (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          const role = el.getAttribute("role") || "";
          const href = el.getAttribute("href") || "";
          return { label: text || href || `state ${index + 1}`, role, href, selector: selectorFor(el, index), visible: visible(el), text };
        })
        .filter(item => item.visible && item.label.length > 1 && (item.role === "tab" || tabLikeText.test(item.text) || /offerte|offer|promo|promo/i.test(item.href)))
        .slice(0, 20);
    }).catch(() => []);

    const seen = new Set<string>();
    const targets: { label: string; selector: string; href?: string }[] = [];
    for (const target of rawTargets) {
      const href = target.href ? normalizeHttpUrl(target.href, seedUrl) : null;
      const key = href || target.selector || target.label;
      if (seen.has(key)) continue;
      seen.add(key);
      if (href && !passesCrawlFilters(href, seedUrl, { crawl_same_domain: true, crawl_include_patterns: [], crawl_exclude_patterns: [] })) continue;
      targets.push({ label: target.label.slice(0, 80), selector: target.selector, href: href || undefined });
    }
    return targets;
  }

  private async captureSnapshot(page: any, url: string, phase: string, screenshot = true): Promise<DomSnapshot> {
    let a11yTree: any = null;
    let screenshotData: string | undefined;
    try { a11yTree = await page.accessibility.snapshot({ interestingOnly: false }); } catch {}
    if (screenshot) {
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
        screenshotData = `data:image/jpeg;base64,${buf.toString("base64")}`;
      } catch {}
    }
    return { url, phase, state: this.scan.state_label, a11yTree, screenshot: screenshotData };
  }

  private async attachIssueEvidence(page: any, issues: ScanIssue[]): Promise<void> {
    const candidates = issues
      .filter(issue => !issue.evidenceScreenshot && (issue.selector || issue.selectors?.[0]))
      .slice(0, 80);

    for (const issue of candidates) {
      const selectors = Array.from(new Set([issue.selector, ...(issue.selectors || [])].filter(Boolean))) as string[];
      if (!selectors.length) continue;

      try {
        const captured = await page.evaluate(async (payload: { selectors: string[]; ruleId: string }) => {
          const { selectors, ruleId } = payload;
          type Candidate = { el: HTMLElement; selector: string; label: string; score: number; visible: boolean };
          const visible = (el: HTMLElement) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
              el.getAttribute("aria-hidden") !== "true" && !el.closest("[hidden],[inert],[aria-hidden='true']");
          };
          const labelFor = (el: HTMLElement) => {
            const role = el.getAttribute("role");
            const tag = el.tagName.toLowerCase();
            const type = role || ({ a: "link", button: "button", input: "input", select: "dropdown", textarea: "text area", img: "image", nav: "navigation", main: "main region", header: "header", footer: "footer" } as Record<string, string>)[tag] || "element";
            const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || "";
            const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
            const card = el.closest("[aria-label],article,section,li,[class*='card'],[class*='promo'],[class*='tile']") as HTMLElement | null;
            const cardText = card && card !== el ? (card.getAttribute("aria-label") || card.innerText || card.textContent || "").replace(/\s+/g, " ").trim() : "";
            const name = (aria || text || cardText || el.id || String(el.className || "")).slice(0, 120).trim();
            return name ? `${type}: ${name}` : type;
          };
          const matchesRule = (el: HTMLElement) => {
            if (/target-size/i.test(ruleId || "")) {
              const rect = el.getBoundingClientRect();
              return /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/i.test(el.tagName) || el.hasAttribute("tabindex") || /button|link|checkbox|radio/.test(el.getAttribute("role") || "")
                ? (rect.width < 24 || rect.height < 24)
                : false;
            }
            return true;
          };
          const scoreFor = (el: HTMLElement, label: string, selector: string) => {
            const rect = el.getBoundingClientRect();
            let score = 0;
            if (visible(el)) score += 100;
            if (matchesRule(el)) score += 80;
            if (selector.includes("#") || selector.includes(":nth-")) score += 20;
            if (/button|link|input|dropdown|menuitem/i.test(label)) score += 12;
            if (/sky\b|logo|brand/i.test(label)) score -= 50;
            if (rect.width > 1 && rect.height > 1) score += Math.min(rect.width * rect.height / 1000, 20);
            return score;
          };
          const candidates: Candidate[] = [];
          for (const selector of selectors) {
            try {
              const matches = Array.from(document.querySelectorAll(selector)).slice(0, 25) as HTMLElement[];
              for (const el of matches) {
                const label = labelFor(el);
                candidates.push({ el, selector, label, visible: visible(el), score: scoreFor(el, label, selector) });
              }
            } catch { /* try the next selector */ }
          }
          const uniqueLabels = Array.from(new Set(candidates.filter(c => c.visible && matchesRule(c.el)).map(c => c.label))).slice(0, 40);
          candidates.sort((a, b) => b.score - a.score);
          const chosen = candidates.find(c => c.visible && matchesRule(c.el)) || candidates.find(c => c.visible) || candidates[0];
          if (!chosen) return { found: false, visible: false, affectedElements: uniqueLabels };
          const element = chosen.el;
          const selectedSelector = chosen.selector;

          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const isVisible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          if (isVisible) {
            element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
            if (/focus/i.test(ruleId || "") && typeof element.focus === "function") {
              element.focus({ preventScroll: true });
            }
            const previousOutline = element.style.outline;
            const previousBoxShadow = element.style.boxShadow;
            const previousScrollMargin = element.style.scrollMargin;
            element.setAttribute("data-accessibility-evidence", "true");
            element.style.outline = "4px solid #ff4d6d";
            element.style.boxShadow = "0 0 0 6px rgba(255, 77, 109, 0.28)";
            element.style.scrollMargin = "80px";
            (window as any).__accessibilityEvidenceCleanup = () => {
              element!.style.outline = previousOutline;
              element!.style.boxShadow = previousBoxShadow;
              element!.style.scrollMargin = previousScrollMargin;
              element!.removeAttribute("data-accessibility-evidence");
            };
          }
          return { found: true, visible: isVisible, selector: selectedSelector, affectedElements: uniqueLabels };
        }, { selectors, ruleId: issue.ruleId });

        if (!captured?.found) continue;
        if (captured.selector) issue.selector = captured.selector;
        if (captured.affectedElements?.length) {
          issue.affectedElements = this.unique([...(issue.affectedElements || []), ...captured.affectedElements]).slice(0, 40);
        }
        await page.waitForTimeout(150);
        const buf = await page.screenshot({ type: "jpeg", quality: 68, fullPage: false });
        issue.evidenceScreenshot = `data:image/jpeg;base64,${buf.toString("base64")}`;
        issue.evidenceExplanation = this.buildEvidenceExplanation(issue, captured.visible);
      } catch (err) {
        logger.debug(`Issue evidence capture failed for ${issue.ruleId}:`, err);
      } finally {
        try {
          await page.evaluate(() => {
            const cleanup = (window as any).__accessibilityEvidenceCleanup;
            if (typeof cleanup === "function") cleanup();
            delete (window as any).__accessibilityEvidenceCleanup;
          });
        } catch {}
      }
    }
  }

  private buildEvidenceExplanation(issue: ScanIssue, highlighted: boolean): string {
    const prefix = highlighted
      ? "The screenshot highlights the first affected element found for this issue. "
      : "This issue points to a non-visible DOM or metadata element, so the screenshot shows the page context without a visible highlight. ";

    if (/focus:invisible/i.test(issue.ruleId)) {
      return `${prefix}The control receives keyboard focus, but the visual focus indicator is missing or too weak. Keyboard users may not know where they are on the page.`;
    }
    if (/focus:obscured/i.test(issue.ruleId)) {
      return `${prefix}The focused control is covered by another layer such as a sticky header, modal overlay, or fixed container. Users may tab to content they cannot see.`;
    }
    if (/text-truncation/i.test(issue.ruleId)) {
      return `${prefix}The text is clipped, ellipsized, or line-clamped. Important visible content may be hidden unless a full accessible name, title, or expansion path is provided.`;
    }
    if (/reflow/i.test(issue.ruleId)) {
      return `${prefix}The region contributes to horizontal overflow or layout breakage in the narrow viewport reflow check. Users at high zoom may need two-dimensional scrolling.`;
    }
    if (/target-size/i.test(issue.ruleId)) {
      return `${prefix}The interactive target is smaller than the minimum recommended touch/click area, which can make activation difficult for users with motor impairments.`;
    }
    if (/contrast|complex-background/i.test(issue.ruleId)) {
      return `${prefix}The area has a visual contrast risk. Verify that text and meaningful graphics remain readable against the actual rendered background.`;
    }
    if (/meta-viewport/i.test(issue.ruleId)) {
      return `${prefix}The viewport rule is controlled by a <meta name="viewport"> tag in the document head. It may not appear visually, but it can block mobile zooming or responsive scaling.`;
    }
    if (/aria|landmark|role/i.test(issue.ruleId)) {
      return `${prefix}This is a semantic accessibility issue. The visual appearance may look correct, but assistive technologies need the affected element to expose the correct role, label, landmark name, or state.`;
    }
    return `${prefix}Use this evidence together with the selector, HTML snippet, issue message, and recommended fix.`;
  }


  private calibrateIssues(issues: ScanIssue[]): ScanIssue[] {
    return issues
      .filter(issue => !this.isLikelyFalsePositive(issue))
      .map(issue => {
        const advisoryRules = /target-size-enhanced|fixed-font-size|text-truncation|complex-background|motion|gesture-no-alternative/i;
        if (advisoryRules.test(issue.ruleId)) {
          return { ...issue, category: "advisory", tags: this.unique([...(issue.tags || []), issue.wcag?.length ? "wcag-mapped" : "best-practice"]) };
        }
        return issue;
      });
  }

  private isLikelyFalsePositive(issue: ScanIssue): boolean {
    const selectorText = [issue.selector, ...(issue.selectors || [])].join(" ").toLowerCase();
    const snippet = String(issue.htmlSnippet || "").toLowerCase();
    if (/skip-link|skiplink/.test(selectorText) && /display:\s*none|hidden/.test(snippet)) return true;
    if (/target-size/i.test(issue.ruleId) && /meta\[|script|style|link\[rel/.test(selectorText)) return true;
    if (/focus:invisible/i.test(issue.ruleId) && /tabindex=['"]?-1/.test(selectorText)) return true;
    if ((issue.affectedCount || 1) <= 0) return true;
    return false;
  }

  private deduplicateIssues(issues: ScanIssue[]): ScanIssue[] {
    const map = new Map<string, ScanIssue>();
    for (const issue of issues) {
      const selectors = [issue.selector, ...(issue.selectors || [])].filter(Boolean) as string[];
      const normalizedSelector = this.normalizeSelector(selectors[0] || "");
      const groupingSelector = this.groupingKeyForIssue(issue, normalizedSelector);
      const key = [
        issue.ruleId,
        this.scanPageKeyWithoutState(issue.url),
        groupingSelector,
        this.normalizeMessage(issue.message),
      ].join("|");

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          ...issue,
          selector: selectors[0] || issue.selector,
          selectors: selectors.length ? selectors : issue.selectors,
          depths: issue.depths,
          affectedCount: Math.max(issue.affectedCount || 0, selectors.length || 1),
          affectedElements: issue.affectedElements,
          evidenceExplanation: this.mergeStateOccurrenceText(issue.evidenceExplanation, issue),
        });
        continue;
      }

      const mergedSelectors = this.unique([
        ...(existing.selectors || (existing.selector ? [existing.selector] : [])),
        ...selectors,
      ]).slice(0, 100);
      existing.selectors = mergedSelectors;
      existing.selector = existing.selector || mergedSelectors[0];
      existing.depths = this.uniqueNumbers([...(existing.depths || []), ...(issue.depths || [])]).slice(0, 100);
      existing.wcag = this.unique([...(existing.wcag || []), ...(issue.wcag || [])]);
      existing.act = this.unique([...(existing.act || []), ...(issue.act || [])]);
      existing.tags = this.unique([...(existing.tags || []), ...(issue.tags || [])]);
      existing.affectedCount = Math.max(existing.affectedCount || 1, mergedSelectors.length, issue.affectedCount || 1);
      existing.affectedElements = this.unique([...(existing.affectedElements || []), ...(issue.affectedElements || [])]).slice(0, 40);
      existing.evidenceScreenshot = existing.evidenceScreenshot || issue.evidenceScreenshot;
      existing.evidenceExplanation = this.mergeStateOccurrenceText(existing.evidenceExplanation || issue.evidenceExplanation, issue);
    }
    return [...map.values()].map(issue => {
      if ((issue.affectedCount || 1) > 1 && !/affected elements/i.test(issue.message)) {
        return { ...issue, message: `${issue.message} (${issue.affectedCount} affected elements grouped)` };
      }
      return issue;
    });
  }

  private prioritizeIssues(issues: ScanIssue[]): ScanIssue[] {
    return issues
      .map(issue => ({ ...issue, priority: this.computeFixPriority(issue) }))
      .sort((a, b) =>
        (a.priority || 5) - (b.priority || 5) ||
        this.severityRank(a.severity) - this.severityRank(b.severity) ||
        (b.affectedCount || 1) - (a.affectedCount || 1)
      );
  }

  private generateTestCases(): void {
    const seen = new Set<string>();
    for (const issue of this.allIssues) {
      const key = `${issue.ruleId}|${this.scanPageKeyWithoutState(issue.url)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.testCases.push({
        name: `[${issue.severity?.toUpperCase()}] ${issue.ruleId}: ${issue.message.slice(0, 70)}`,
        description: `Verify ${issue.ruleId} is resolved on ${issue.url}`,
        category: issue.category || "wcag",
        wcagRef: (issue.wcag || [])[0] || "",
        status: "fail",
        issueRuleId: issue.ruleId,
        issueUrl: issue.url,
        steps: [],
        result: `FAIL — ${issue.message}`,
      });
    }
  }

  private generateManualHybridReviewCases(): void {
    const seedUrls: string[] = this.scan.urls || [];
    const urls = [...new Set([...seedUrls, ...this.allIssues.map(i => i.url).filter(Boolean)])];
    if (!urls.length) return;

    const reviews: TestCase[] = [];
    const issuesByUrl = new Map<string, ScanIssue[]>();
    for (const issue of this.allIssues) {
      const issueUrl = issue.url || "current page";
      if (!issuesByUrl.has(issueUrl)) issuesByUrl.set(issueUrl, []);
      issuesByUrl.get(issueUrl)!.push(issue);
    }

    const snapshotPhasesByUrl = new Map<string, Set<string>>();
    for (const snapshot of this.domSnapshots) {
      const snapshotUrl = snapshot.url || "current page";
      if (!snapshotPhasesByUrl.has(snapshotUrl)) snapshotPhasesByUrl.set(snapshotUrl, new Set());
      if (snapshot.phase) snapshotPhasesByUrl.get(snapshotUrl)!.add(snapshot.phase);
    }

    const hasSignal = (text: string, pattern: RegExp) => pattern.test(text);
    const pageTitle = (url: string) => url.includes("#") ? decodeURIComponent(url.split("#").pop() || url) : url;
    const addPageReview = (review: TestCase) => {
      const key = `${review.name}|${review.issueUrl || review.description}`;
      if (reviews.some(existing => `${existing.name}|${existing.issueUrl || existing.description}` === key)) return;
      reviews.push(review);
    };

    for (const url of urls) {
      const pageIssues = issuesByUrl.get(url) || [];
      const issueText = pageIssues.map(i => `${i.ruleId} ${i.category || ""} ${i.message} ${i.selector || ""} ${i.state || ""} ${i.phase || ""}`).join(" ");
      const phaseText = Array.from(snapshotPhasesByUrl.get(url) || []).join(" ");
      const combinedText = `${issueText} ${phaseText}`;
      const label = pageTitle(url);
      const titleSuffix = label && !/^https?:\/\//i.test(label) ? `: ${label}` : "";

      const issueHas = (pattern: RegExp) => pageIssues.some(issue => pattern.test(`${issue.ruleId} ${issue.category || ""} ${issue.message} ${issue.selector || ""} ${issue.state || ""} ${issue.phase || ""}`));
      const phaseHas = (pattern: RegExp) => pattern.test(phaseText);

      const hasScreenReaderRisk = issueHas(/aria|role|name|label|landmark|heading|status-message|document-title|html-has-lang|image-alt|button-name|link-name|input|focus/i);
      const hasContentMeaningRisk = issueHas(/image-alt|link-name|button-name|label|heading|document-title|instructions?|empty|ambiguous|text-alternative|alt/i);
      const hasKeyboardRisk = issueHas(/keyboard|focus|tab-order|shift|escape|arrow|trap|mouse-only|target-size/i) || phaseHas(/keyboard|focus/i);
      const hasDynamicRisk = issueHas(/expanded|modal|dialog|menu|accordion|popover|drawer|sidebar|overlay|aria-expanded|tabpanel|state:/i) || phaseHas(/expanded|error|tab-|interaction|side-panel|modal|dialog|drawer|sidebar/i);
      const hasResponsiveRisk = issueHas(/reflow|zoom|viewport|mobile|target-size|pointer|touch|truncation|overlap|orientation|fixed-font-size/i) || phaseHas(/zoom|pointer/i);
      const hasFormRisk = issueHas(/form|forms|input|field|label|error|invalid|required|autocomplete|status-message|aria-errormessage/i) || phaseHas(/error/i);
      const hasMediaRisk = issueHas(/video|audio|caption|transcript|media|player|autoplay/i);

      if (hasScreenReaderRisk) {
        addPageReview({
          name: `Screen reader review${titleSuffix}`,
          description: `Manual screen reader review is applicable because this page/screen has programmatic structure, focus, ARIA, label, or announcement signals from the scan: ${url}`,
          category: "manual-review",
          wcagRef: "WCAG 1.3.2 / 4.1.2",
          status: "pending",
          issueUrl: url,
          steps: [
            "Open this specific scanned page or state with NVDA, JAWS, or VoiceOver.",
            "Navigate by headings, landmarks, links, buttons, and form controls that exist on this screen.",
            "Confirm announced names, roles, states, and reading order match the visible interface."
          ],
          result: "Manual review required for this page because automated findings indicate screen-reader-relevant structure or state."
        });
      }

      if (hasContentMeaningRisk) {
        addPageReview({
          name: `Content meaning and labels${titleSuffix}`,
          description: `Human judgment is applicable because this page/screen has labels, links, buttons, headings, images, or instruction-related signals: ${url}`,
          category: "manual-review",
          wcagRef: "WCAG 1.1.1 / 2.4.4 / 3.3.2",
          status: "pending",
          issueUrl: url,
          steps: [
            "Review only the visible text, controls, links, image alternatives, and instructions on this page/state.",
            "Confirm names are meaningful for the actual task, not merely present.",
            "Check that page-specific content such as product details, prices, help text, errors, or legal content is understandable."
          ],
          result: "Manual review required for this page because automation cannot judge whether the available text is meaningful in context."
        });
      }

      if (hasKeyboardRisk) {
        addPageReview({
          name: `Keyboard-only flow${titleSuffix}`,
          description: `Hybrid keyboard validation is applicable because keyboard, focus, tab order, or target interaction signals were found on this page/screen: ${url}`,
          category: "hybrid-review",
          wcagRef: "WCAG 2.1.1 / 2.4.3 / 2.1.2",
          status: "pending",
          issueUrl: url,
          steps: [
            "Use only keyboard on this page/state for the controls present here.",
            "Verify Tab, Shift+Tab, Enter, Space, Escape, and arrow-key behavior where applicable.",
            "Confirm focus order is logical, visible, and does not skip or trap important controls."
          ],
          result: "Hybrid review required for this page because automated keyboard/focus sampling found applicable interaction signals."
        });
      }

      if (hasDynamicRisk) {
        addPageReview({
          name: `Dynamic state coverage${titleSuffix}`,
          description: `Hybrid dynamic-state review is applicable because this page/screen includes scanned state, overlay, sidebar, menu, tab, modal, or interaction signals: ${url}`,
          category: "hybrid-review",
          wcagRef: "WCAG 4.1.2 / 2.4.3 / 3.3.1",
          status: "pending",
          issueUrl: url,
          steps: [
            "Review the specific dynamic state represented by this scanned URL/state.",
            "Confirm focus moves correctly into and out of the visible overlay, drawer, menu, tab, or changed content.",
            "Verify expanded, selected, disabled, error, or updated states are exposed correctly where present."
          ],
          result: "Hybrid review required for this page/state because dynamic interaction evidence exists in the scan."
        });
      }

      if (hasResponsiveRisk) {
        addPageReview({
          name: `Responsive zoom and touch${titleSuffix}`,
          description: `Manual responsive/touch review is applicable because reflow, zoom, viewport, touch target, or truncation signals were found on this page/screen: ${url}`,
          category: "manual-review",
          wcagRef: "WCAG 1.4.10 / 1.4.4 / 2.5.8",
          status: "pending",
          issueUrl: url,
          steps: [
            "Test this page/state at 200% and 400% browser zoom and common mobile viewport sizes.",
            "Check that content in this screen is not hidden, overlapping, clipped, or requiring unexpected two-dimensional scrolling.",
            "Use touch or device emulation for the controls present on this screen."
          ],
          result: "Manual review required for this page because automated responsive/touch checks found applicable layout or target signals."
        });
      }

      if (hasFormRisk) {
        addPageReview({
          name: `Form completion and error recovery${titleSuffix}`,
          description: `Hybrid form validation review is applicable because form, field, label, error, required, or status-message signals were found on this page/screen: ${url}`,
          category: "hybrid-review",
          wcagRef: "WCAG 3.3.1 / 3.3.2 / 3.3.3",
          status: "pending",
          issueUrl: url,
          steps: [
            "Submit only the forms present on this page/state with empty, invalid, and corrected values.",
            "Confirm errors are visible, announced, associated with the relevant fields, and easy to recover from.",
            "Verify required fields, formatting rules, autocomplete, and success messages for this screen."
          ],
          result: "Hybrid review required for this page because form/error evidence exists in the scan."
        });
      }

      if (hasMediaRisk) {
        addPageReview({
          name: `Media alternatives and player accessibility${titleSuffix}`,
          description: `Manual media review is applicable because media/player/caption/transcript signals were found on this page/screen: ${url}`,
          category: "manual-review",
          wcagRef: "WCAG 1.2.x",
          status: "pending",
          issueUrl: url,
          steps: [
            "Verify captions, transcripts, and audio descriptions for media on this page/state.",
            "Confirm media controls on this screen are keyboard accessible and screen-reader announced.",
            "Check autoplay, pause, stop, volume, and motion behavior where present."
          ],
          result: "Manual review required for this page because media-related evidence exists in the scan."
        });
      }
    }

      this.testCases.push(...reviews);
  }

  private mergeStateOccurrenceText(existing: string | undefined, issue: ScanIssue): string {
    const occurrence = `${issue.state || "default"} / ${issue.phase || "initial"}`;
    const prefix = existing || "";
    if (prefix.includes(occurrence)) return prefix;
    const marker = "State occurrences:";
    if (prefix.includes(marker)) return `${prefix}; ${occurrence}`;
    return `${prefix ? `${prefix} ` : ""}${marker} ${occurrence}`;
  }

  private computeScore(issues: ScanIssue[]): number {
    if (!issues.length) return 100;
    const weights: Record<string, number> = { critical: 14, serious: 8, moderate: 3.5, minor: 1 };
    const urls = new Set(issues.map(i => i.url)).size || 1;
    const impact = issues.reduce((acc, issue) => {
      const affected = Math.max(issue.affectedCount || issue.selectors?.length || 1, 1);
      const scale = 1 + Math.min(Math.log2(affected), 6) * 0.18;
      return acc + (weights[issue.severity] || 1) * scale;
    }, 0);

    const capacity = 95 * Math.sqrt(urls);
    const score = 100 / (1 + impact / capacity);
    const rounded = Math.round(score);
    return Math.max(1, Math.min(100, rounded));
  }

  private computeFixPriority(issue: ScanIssue): number {
    let priority = ({ critical: 1, serious: 2, moderate: 3, minor: 4 } as Record<string, number>)[issue.severity] || 4;
    const highImpactCategories = new Set(["keyboard", "focus", "forms", "aria", "structure"]);
    if (highImpactCategories.has(issue.category || "")) priority -= 1;
    if ((issue.affectedCount || issue.selectors?.length || 1) >= 10) priority -= 1;
    if (issue.severity === "minor" && (issue.affectedCount || 1) <= 1) priority += 1;
    return Math.max(1, Math.min(5, priority));
  }

  private severityRank(severity: string): number {
    return ({ critical: 1, serious: 2, moderate: 3, minor: 4 } as Record<string, number>)[severity] || 5;
  }



  private groupingKeyForIssue(issue: ScanIssue, normalizedSelector: string): string {
    if (/target-size|contrast|focus:invisible|label|aria|landmark|heading|reflow|keyboard/i.test(issue.ruleId)) {
      return issue.componentId || issue.sourceHint || this.selectorFamily(normalizedSelector) || "page";
    }
    return issue.componentId || issue.sourceHint || this.selectorFamily(normalizedSelector);
  }

  private normalizeSelector(selector: string): string {
    return selector
      .toLowerCase()
      .replace(/:nth-(?:of-type|child)\(\d+\)/g, ":nth")
      .replace(/#[a-z0-9_-]*\d+[a-z0-9_-]*/g, "#id")
      .replace(/\[[^\]]*(?:id|data-[^\]=]+)=["'][^"']+["'][^\]]*\]/g, "[attr]")
      .replace(/\s+/g, " ")
      .trim();
  }

  private selectorFamily(selector: string): string {
    if (!selector) return "page";
    return selector
      .split(/\s*>\s*|\s+/)
      .slice(0, 3)
      .join(" ");
  }

  private normalizeMessage(message: string): string {
    return message
      .toLowerCase()
      .replace(/\d+/g, "#")
      .replace(/\([^)]*affected elements grouped\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
  }

  private uniqueNumbers(values: number[]): number[] {
    return [...new Set(values.filter(v => Number.isFinite(v)))];
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}



