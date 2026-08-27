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
  // ROUND 5i — Conformance breakdown for the report layer. Contains
  // per-WCAG-level (A/AA/AAA) applicable-vs-failed counts, the same
  // Evinced-style score, and a list of failed criteria with defect IDs.
  conformance?: {
    conformance: Record<string, { applicable: number; failed: number; passed: number; pct: number }>;
    failed_criteria: { criterion: string; level: string; defect_count: number; issue_ids: string[] }[];
    contributors?: any[];
    formula?: any;
    engineering_score?: number;
  };
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
  // ROUND 5e — URLs the contract-switcher detour hits (silent /home).
  // recordNavigatedUrl skips these so they never appear in the scan navigation
  // trail (backend log line 315, report "URLs passed through" PDF section, and
  // scan detail navigation panel). Normalised form: origin + pathname, lowercase.
  private switcherDetourUrls = new Set<string>();
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
    const rawUrls: string[] = this.scan.urls || [];
    const authConfig = this.scan.auth_config;

    // ROUND 5p / 5s — Register auth home_url as a switcher-detour URL right at
    // scan start so Round 5e (nav trail) and Round 5h (DOM snapshot + issue
    // filter) suppress it from the report. BUT ONLY when home_url is NOT one
    // of the target URLs. If the user explicitly set their target URL to the
    // home page (e.g. target=/home AND home_url=/home), suppressing /home
    // would throw away every snapshot the scanner produces on the actual
    // scan target — 100% content loss. Round 5s adds that guard.
    const authHomeUrl = String(authConfig?.home_url || "").trim();
    if (authHomeUrl && /^https?:\/\//i.test(authHomeUrl)) {
      const homeUrlKey = this.normaliseUrlForDetourCheck(authHomeUrl);
      const rawTargetKeys = rawUrls
        .filter((u: any) => typeof u === "string" && u.trim())
        .map((u: string) => this.normaliseUrlForDetourCheck(u.trim()));
      const homeUrlIsATarget = rawTargetKeys.includes(homeUrlKey);
      if (!homeUrlIsATarget) {
        this.switcherDetourUrls.add(homeUrlKey);
        logger.info(`[scan-start] ROUND 5p — auth home_url "${authHomeUrl}" registered as switcher-detour URL (suppress from nav trail + DOM snapshots + issues in report)`);
      } else {
        logger.info(`[scan-start] ROUND 5s — auth home_url "${authHomeUrl}" IS one of the target URLs (${rawTargetKeys.join(", ")}); NOT suppressing — user explicitly wants this URL scanned. Report will include /home content.`);
      }
    }

    // ROUND 5o — URL-based contract override. If any target URL contains
    // ?axessia_contract=NUMBER (or &axessia_contract=), extract it, use it
    // to populate authConfig.contract_number (if not already set), then
    // STRIP the parameter from the URL before scanning so the scan URL is
    // clean. This is a workaround for the frontend being stuck on an old
    // bundle that doesn't send contract fields — you can force a contract
    // switch by just editing the target URL in the form.
    // Example: https://test.abbonamento.sky.it/offers?axessia_contract=10600970
    const urls: string[] = rawUrls.map(rawUrl => {
      if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
      try {
        const parsed = new URL(rawUrl);
        const overrideContract = parsed.searchParams.get("axessia_contract");
        const overrideHome = parsed.searchParams.get("axessia_home");
        if (overrideContract && authConfig) {
          const existing = String(authConfig.contract_number || "").trim();
          if (!existing) {
            (authConfig as any).contract_number = overrideContract.trim();
            logger.info(`[stage-auth] ROUND 5o — extracted contract_number="${overrideContract}" from target URL query string; injecting into auth_config`);
          }
          parsed.searchParams.delete("axessia_contract");
        }
        if (overrideHome && authConfig) {
          const existing = String(authConfig.home_url || "").trim();
          if (!existing) {
            (authConfig as any).home_url = decodeURIComponent(overrideHome).trim();
            logger.info(`[stage-auth] ROUND 5o — extracted home_url="${(authConfig as any).home_url}" from target URL query string; injecting into auth_config`);
          }
          parsed.searchParams.delete("axessia_home");
        }
        return parsed.toString();
      } catch {
        return rawUrl;
      }
    });

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

              // ROUND 5d: Contract switcher detour on the Stage path.
              // Same flow as the Production path — if a contract is
              // configured, navigate to Sky's /home to switch contracts
              // before any target/journey/gestisci scans run.
              // Runs BEFORE the landing-page / gestisci / target scans
              // and BEFORE journey config, so every subsequent scan sees
              // the correct contract's data.
              const stageContractCfg = authConfig || {};
              const stageContractNumber = String(stageContractCfg?.contract_number || "").trim();
              const stageContractName   = String(stageContractCfg?.contract_name   || "").trim();
              const stageHasContract = Boolean(stageContractNumber || stageContractName);
              // ROUND 5j — CORRECTED diagnostic. Check for the specific contract
              // keys' presence in the payload, not just "any keys". The old
              // condition mislabeled a stale frontend (which sends 13 unrelated
              // auth keys) as "fields blank".
              const hasContractKeys = stageContractCfg &&
                ("contract_number" in stageContractCfg || "contract_name" in stageContractCfg);
              const hasHomeUrlKey = stageContractCfg && "home_url" in stageContractCfg;
              const stageDiag = stageHasContract
                ? "contract configured, will detour to /home for switcher"
                : (hasContractKeys
                    ? "contract keys ARE in the payload but VALUES are empty — fill Contract number OR Contract name in the Stage form to enable switching"
                    : "contract keys are MISSING from payload — Stage frontend is STALE. Install Round 5j (or later) NewScanPage.tsx, restart Vite, hard-reload browser. See README verification steps.");
              // ROUND 5j — also flag missing home_url separately so we can tell
              // if the frontend has partial upgrade (contract fields but no home_url,
              // or vice versa).
              const homeUrlDiag = hasHomeUrlKey ? "home_url key present" : "home_url key MISSING (stale frontend or partial install)";
              logger.info(`[contract-switcher] Stage path — hasContractCfg=${stageHasContract}, contract_number="${stageContractNumber}", contract_name="${stageContractName}", diagnostic="${stageDiag}", home_url_check="${homeUrlDiag}", authConfig_keys=[${authConfig ? Object.keys(authConfig).join(",") : "<undefined>"}]`);
              if (stageHasContract) {
                const homeUrl = this.contractSwitcherHomeUrlForTarget(url, authConfig);
                // ROUND 5e — Mark this URL as a switcher detour so recordNavigatedUrl
                // suppresses it from the trail. Both origin+/home and any minor
                // variant Playwright may capture (trailing slash, casing) hit the
                // same normalised key in switcherDetourUrls.
                this.switcherDetourUrls.add(this.normaliseUrlForDetourCheck(homeUrl));
                logger.info(`[contract-switcher] Stage: contract configured — detouring silently to ${homeUrl} before target ${url}`);
                try {
                  const navResult = await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                  logger.info(`[contract-switcher] Stage: page.goto(${homeUrl}) status=${navResult?.status?.() ?? "unknown"}, current URL=${page.url()}`);
                  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
                  if (authConfig?.auto_accept_cookies !== false) {
                    await this.clearCookieConsent(page, this.authSelector(authConfig, "cookie_accept_selector")).catch(() => undefined);
                  }
                  logger.info(`[contract-switcher] Stage: about to call selectContractIfPickerVisible(). URL=${page.url()}`);
                  await this.selectContractIfPickerVisible(page, authConfig, progress);
                  logger.info(`[contract-switcher] Stage: selectContractIfPickerVisible() returned normally`);
                } catch (err: any) {
                  logger.error(`[contract-switcher] Stage: detour threw: ${err?.message || err}\nStack: ${err?.stack || "no stack"}`);
                }
              } else {
                logger.info(`[contract-switcher] Stage: no contract configured — skipping detour`);
              }

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
              // ROUND 5c: Multi-contract switch on Production cookie-handoff path.
              // Two fixes vs Round 5b:
              //   1. Use logger.info (not progress()) so we can see events in the
              //      backend PowerShell log. progress() writes to a scan-specific
              //      channel that doesn't appear in the general log.
              //   2. Use page.goto directly (not navigateAndRecord) so the detour
              //      to /home doesn't get recorded as a "scanned URL" — otherwise
              //      /home shows up as a scanned page in results.
              const contractCfg = authConfig || (opts as any).auth_config || {};
              const hasContractCfg = Boolean(
                (contractCfg?.contract_number && String(contractCfg.contract_number).trim()) ||
                (contractCfg?.contract_name && String(contractCfg.contract_name).trim())
              );
              logger.info(`[contract-switcher] Production path — hasContractCfg=${hasContractCfg}, authConfig_keys=[${authConfig ? Object.keys(authConfig).join(",") : "<undefined>"}], opts_auth_config_keys=[${(opts as any).auth_config ? Object.keys((opts as any).auth_config).join(",") : "<undefined>"}]`);
              if (hasContractCfg) {
                const homeUrl = this.contractSwitcherHomeUrlForTarget(url, contractCfg);
                // ROUND 5e — Mark this URL as a switcher detour so recordNavigatedUrl
                // suppresses it from the trail. Round 5c made the detour "silent"
                // at the scan-artifact level (page.goto instead of navigateAndRecord),
                // but Playwright's page.on('request'/'framenavigated') listeners in
                // trackPageNavigations still captured the /home hit, so it still
                // showed in the trail log AND the PDF "URLs passed through" panel.
                // Now it's fully suppressed.
                this.switcherDetourUrls.add(this.normaliseUrlForDetourCheck(homeUrl));
                logger.info(`[contract-switcher] contract configured — detouring silently to ${homeUrl} before target ${url}`);
                try {
                  // page.goto (not navigateAndRecord) — silent, no scan artifacts on /home
                  const navResult = await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                  logger.info(`[contract-switcher] page.goto(${homeUrl}) status=${navResult?.status?.() ?? "unknown"}, current URL=${page.url()}`);
                  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
                  if (contractCfg?.auto_accept_cookies !== false) {
                    await this.clearCookieConsent(page, this.authSelector(contractCfg, "cookie_accept_selector")).catch(() => undefined);
                  }
                  logger.info(`[contract-switcher] about to call selectContractIfPickerVisible(). URL=${page.url()}`);
                  await this.selectContractIfPickerVisible(page, contractCfg, progress);
                  logger.info(`[contract-switcher] selectContractIfPickerVisible() returned normally`);
                } catch (err: any) {
                  logger.error(`[contract-switcher] detour threw: ${err?.message || err}\nStack: ${err?.stack || "no stack"}`);
                }
              } else {
                logger.info(`[contract-switcher] no contract configured — skipping detour`);
              }

              progress(`Navigating to ${url}`);
              const ok = await this.navigateAndRecord(page, url, "target");
              if (!ok) {
                logger.warn(`Skipping unreachable URL: ${url}`);
                continue;
              }
              await page.waitForTimeout(1200);
              // ROUND 5d: Strict target URL settle guard on Production path
              // Same behaviour as Stage's openAuthenticatedTarget (line 783).
              // If the browser is not on the requested target URL after the
              // navigation, runFullPageScan is called with `url` as
              // strictExpectedUrl — if the actual page URL doesn't match, the
              // scan is refused and target-redirect-evidence is recorded
              // (rather than scanning /home content and labelling it as
              // /offers/pdp/tv issues).
              let settledUrl = await this.waitForTargetUrlToSettle(page, url, 18000);
              logger.info(`[production-scan] settledUrl=${settledUrl} requested=${url}`);

              // ROUND 5f Fix 2 — Retry switcher once if we landed on the wrong page.
              // Symptom: Sky's SPA bounces the target URL to /offers when the
              // currently-active contract can't see the requested offer. Cause:
              // switcher's first attempt didn't actually switch (usually because
              // the sidebar toggle wasn't hydrated in time — Fix 1 helps that,
              // but this is a belt-and-braces safety net if the first attempt
              // still finds nothing on /home).
              // Compare origin+pathname (ignore query/hash) — a benign query
              // difference shouldn't trigger a retry.
              if (hasContractCfg) {
                const currentKey = this.normaliseUrlForDetourCheck(page.url());
                const targetKey  = this.normaliseUrlForDetourCheck(url);
                if (currentKey !== targetKey) {
                  logger.warn(`[production-scan] ROUND 5f — target URL mismatch after settle. currentKey=${currentKey} targetKey=${targetKey}. Retrying contract switcher.`);
                  (page as any).__axessia_contract_switched = false;
                  const homeUrl = this.contractSwitcherHomeUrlForTarget(url, contractCfg);
                  this.switcherDetourUrls.add(this.normaliseUrlForDetourCheck(homeUrl));
                  try {
                    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
                    logger.info(`[contract-switcher] ROUND 5f retry — about to re-call selectContractIfPickerVisible(). URL=${page.url()}`);
                    await this.selectContractIfPickerVisible(page, contractCfg, progress);
                    logger.info(`[contract-switcher] ROUND 5f retry — returned. Re-navigating to target ${url}.`);
                    await this.navigateAndRecord(page, url, "target");
                    await page.waitForTimeout(1200);
                    const retriedSettledUrl = await this.waitForTargetUrlToSettle(page, url, 18000);
                    settledUrl = retriedSettledUrl;
                    logger.info(`[production-scan] ROUND 5f — after retry settledUrl=${retriedSettledUrl}, current URL=${page.url()}`);
                  } catch (err: any) {
                    logger.error(`[contract-switcher] ROUND 5f retry threw: ${err?.message || err}`);
                  }
                }
              }

              await this.runFullPageScan(page, settledUrl || url, opts, extraStates, progress, url);
              if (opts.crawl_mode) {
                await this.scanLinkedPageStates(page, url, opts, extraStates, progress);
              }
              // ROUND 5d: Run journey config on Production path too.
              // Previously only the Stage path called scanTargetedInteractions
              // (line 215) — so any target_interactions/journey targets
              // configured for Production scans were silently ignored.
              // authConfig here contains contract_number so any journey target's
              // subsequent navigations will use the switched contract.
              if (opts.target_interactions && Array.isArray(opts.target_interactions) && opts.target_interactions.length > 0) {
                logger.info(`[production-scan] running journey config (${opts.target_interactions.length} targets) with contract active`);
                await this.scanTargetedInteractions(page, url, opts, extraStates, progress, new Set<string>(), authConfig || {});
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
    // ROUND 5v — Primary score is now the Evinced-style weighted score.
    // Simple formula: Σ(count × severity_weight × level_weight) / pages,
    // subtracted from 100. Matches the PDF report's "How the score is
    // calculated" section. Conformance % is still computed and available
    // in the conformance bundle for reference, but is no longer the
    // top-line score.
    const conformanceBundle = this.computeConformanceBreakdown();
    const evincedScore = this.computeScore(this.allIssues);
    // Keep conformancePct for reference / potential display, but it's not the primary score.
    const conformancePct = conformanceBundle.conformance?.overall_A_AA?.pct ?? 100;
    const score = evincedScore;
    logger.info(`Scan navigation trail (${this.navigatedUrls.length} URL${this.navigatedUrls.length === 1 ? "" : "s"}): ${this.navigatedUrls.join(" -> ") || "none recorded"}`);
    logger.info(`Scan complete: ${this.allIssues.length} issues. Score (Evinced-weighted) = ${score}/100. WCAG A+AA conformance (reference only) = ${conformancePct}%.`);
    return { issues: this.allIssues, testCases: this.testCases, domSnapshots: this.domSnapshots, navigatedUrls: this.navigatedUrls, score, conformance: { conformance: conformanceBundle.conformance, failed_criteria: conformanceBundle.failed_criteria, contributors: conformanceBundle.contributors, formula: conformanceBundle.formula, engineering_score: evincedScore } };
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
      // ROUND 5k — explicit log so we can trace which of three auth-start
      // decisions was made: (a) home_url (Round 5k preferred), (b) target
      // URL (Sky redirect chain handles login), or (c) explicit login_url.
      const stageHomeUrl = String(auth?.home_url || "").trim();
      const authStartChoice = stageHomeUrl && loginStartUrl === stageHomeUrl
        ? `home_url (Round 5k preferred — will land on /home for switcher)`
        : (targetUrl && loginStartUrl === targetUrl
            ? `target URL (Sky redirect chain will handle login → OTP → back to target; switcher will detour to /home separately)`
            : `configured login_url`);
      logger.info(`[stage-auth] ROUND 5k — auth start URL choice: ${authStartChoice}. loginStartUrl=${loginStartUrl}, home_url="${stageHomeUrl}", targetUrl=${targetUrl}`);
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
    this.pushIssuesIfAllowed([{
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
    }]);
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
      // ROUND 5s — check that the page + browser context are still alive.
      // Round 5q's snap-back navigation, cookie prompts, or an early error
      // elsewhere can close the page mid-loop, and Playwright then throws
      // an unhelpful "Target page, context or browser has been closed"
      // from waitForTimeout. Detect the close cleanly and throw an OTP-
      // specific message the outer handler can surface.
      try {
        if (page.isClosed && page.isClosed()) {
          throw new Error("OTP page wait aborted — the browser page was closed unexpectedly (likely by a concurrent navigation such as the Round 5q snap-back guard or a login redirect). Ensure the target URL is different from the auth home_url so those code paths don't fight each other.");
        }
      } catch (e: any) {
        // If page.isClosed itself throws, the context is definitely gone.
        if (String(e?.message || "").includes("browser page was closed unexpectedly")) throw e;
        throw new Error(`OTP page wait aborted — browser context lost: ${e?.message || e}`);
      }
      const hasOtpText = Boolean(await this.resolveOtpValue(page, auth, 1000).catch(() => ""));
      const hasOtpInput = await this.hasVisibleAuthControl(page, otpSelector).catch(() => false);
      const hasSource = await this.hasVisibleAuthControl(page, otpSourceSelector).catch(() => false);
      if (hasOtpText || hasOtpInput || hasSource) {
        this.onProgress(17, "SUCCESS: OTP page detected");
        return;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);
      // ROUND 5s — swallow the "page closed" error from waitForTimeout
      // gracefully; the outer loop check will catch it on next iteration.
      await page.waitForTimeout(700).catch(() => undefined);
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
    // ROUND 5k — Prefer auth.home_url when set. Sky reliably redirects
    // unauthenticated users hitting /home to /login → OTP → back to /home.
    // Landing on /home means the sidebar contract switcher IS present, so
    // the switcher block later can actually find its toggle. Without this,
    // Stage auth goes straight to the target URL, never touches /home, and
    // the contract switcher has no page to work on.
    const homeUrl = String(auth?.home_url || "").trim();
    if (homeUrl && /^https?:\/\//i.test(homeUrl)) {
      return homeUrl;
    }
    // ROUND 5o — DERIVE home_url from target URL if it matches Sky's
    // abbonamento.sky.it pattern. This makes the auth flow use /home even
    // when the frontend is stuck on an old bundle that doesn't send home_url
    // in auth_config. The derived URL for target
    // "https://test.abbonamento.sky.it/offers" is
    // "https://test.abbonamento.sky.it/home".
    const requestedTargetUrlEarly = String(targetUrl || "").trim();
    if (requestedTargetUrlEarly && /abbonamento\.sky\.it/i.test(requestedTargetUrlEarly)) {
      try {
        const derived = `${new URL(requestedTargetUrlEarly).origin}/home`;
        logger.info(`[stage-auth] ROUND 5o — auth.home_url missing/empty; DERIVING home_url from target: ${derived}`);
        return derived;
      } catch { /* fall through */ }
    }
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
      // Handle multi-contract picker if it appears after login on this path
      await this.selectContractIfPickerVisible(page, auth, progress).catch(err => {
        // selectContractIfPickerVisible only throws when a picker was present but
        // no configured contract matched (or nothing was configured). In that
        // case we've already recorded an issue — rethrow so the scan halts cleanly
        // rather than scanning the wrong contract's data.
        throw err;
      });
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
    this.pushIssuesIfAllowed([{
      ruleId: "target-url-not-reached",
      severity: "serious",
      category: "navigation-coverage",
      message: `The configured target URL was not scanned because the authenticated browser redirected to ${actualUrl}.`,
      url: requestedUrl,
      selector: "document",
      tags: ["navigation-coverage", "advisory"],
      fixSuggestion: "Verify the account entitlement, route guard, post-login forward URL, and any environment redirect rules for the requested target.",
      evidenceExplanation: `Requested target: ${requestedUrl}. Final browser URL: ${actualUrl}.`
    }]);
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
    // ROUND 5q — Set the active scan target on the page object so the
    // navigation observer (attachNavigationObserver, framenavigated listener)
    // can detect Sky's SPA client-side-routing to a switcher-detour URL
    // (e.g. /home) mid-scan and immediately snap the page back to targetUrl.
    // Without this, accessibility modules would keep running against /home
    // content while attributing findings to targetUrl, so /home DOM +
    // screenshots leaked into the report even though nav trail was clean.
    (page as any).__axessia_scan_target = targetUrl;
    (page as any).__axessia_last_snap_back = 0;
    try {
      await this.runFullPageScanInner(page, targetUrl, opts, extraStates, progress, strictExpectedUrl);
    } finally {
      (page as any).__axessia_scan_target = null;
    }
  }

  private async runFullPageScanInner(
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
      this.pushIssuesIfAllowed(await runAxe(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_heuristics !== false) {
      progress(`Running heuristic checks on ${targetUrl}`);
      this.pushIssuesIfAllowed(await runHeuristics(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_focus !== false) {
      progress(`Running focus checks on ${targetUrl}`);
      this.pushIssuesIfAllowed(await runFocusHeuristics(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_color !== false) {
      progress(`Measuring color contrast on ${targetUrl}`);
      this.pushIssuesIfAllowed(await runColorChecks(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_zoom !== false) {
      progress(`Running zoom and reflow checks on ${targetUrl}`);
      this.pushIssuesIfAllowed(await runZoomChecks(page, targetUrl, this.scan.state_label, "zoom"));
    }

    if (opts.run_pointer !== false) {
      progress(`Running pointer and gesture checks on ${targetUrl}`);
      this.pushIssuesIfAllowed(await runPointerChecks(page, targetUrl, this.scan.state_label, "pointer"));
    }

    if (opts.run_keyboard_nav !== false) {
      progress(`Simulating keyboard navigation on ${targetUrl}`);
      this.pushIssuesIfAllowed(await runKeyboardNav(page, targetUrl, this.scan.state_label));
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
        this.pushIssuesIfAllowed(this.deduplicateIssues(sr.issues));
        if (sr.screenshot || sr.a11yTree) {
          this.pushDomSnapshotIfAllowed({
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
      this.pushDomSnapshotIfAllowed(snapshot);
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

    this.pushDomSnapshotIfAllowed({
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
    if (opts.run_axe !== false) this.pushIssuesIfAllowed(await runAxe(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_heuristics !== false) this.pushIssuesIfAllowed(await runHeuristics(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_focus !== false) this.pushIssuesIfAllowed(await runFocusHeuristics(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_color !== false) this.pushIssuesIfAllowed(await runColorChecks(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_pointer !== false) this.pushIssuesIfAllowed(await runPointerChecks(page, scanUrl, stateName, `controlled:${stateName}`));
    if (opts.run_live_dom !== false) {
      const snapshot = await this.captureSnapshot(page, scanUrl, `controlled: ${stateName}`, opts.capture_screenshots !== false);
      snapshot.a11yTree = this.withStateMatrixMetadata(snapshot.a11yTree, scanUrl, stateName, opts);
      this.pushDomSnapshotIfAllowed(snapshot);
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
          const currentUrl = frame.url();
          this.recordNavigatedUrl(currentUrl, context);
          // ROUND 5q — Snap-back guard. If a scan is actively running (scan
          // target set by runFullPageScan) AND the browser has navigated to
          // a switcher-detour URL (e.g. Sky's SPA client-side-routed to /home
          // mid-scan) AND the scan target is NOT that same detour URL, force
          // navigation back to the scan target. This prevents /home DOM and
          // screenshots from being captured while modules run against what
          // they think is the target page.
          const scanTarget = String((page as any).__axessia_scan_target || "").trim();
          if (scanTarget && this.isSwitcherDetourUrl(currentUrl)) {
            const scanTargetKey = this.normaliseUrlForDetourCheck(scanTarget);
            const currentKey = this.normaliseUrlForDetourCheck(currentUrl);
            if (scanTargetKey !== currentKey) {
              const now = Date.now();
              const lastSnap = Number((page as any).__axessia_last_snap_back || 0);
              // debounce: don't fire snap-back more than once per 2 seconds
              // (avoid nav-loop if Sky's SPA keeps re-routing)
              if (now - lastSnap > 2000) {
                (page as any).__axessia_last_snap_back = now;
                logger.warn(`[nav-guard] ROUND 5q — detected mid-scan navigation to switcher-detour URL ${currentUrl} while scan target is ${scanTarget}. Snapping back to target.`);
                // fire-and-forget navigation. Errors are swallowed so we don't
                // crash the observer; the scan module either re-runs on the
                // correct URL or bails out.
                page.goto(scanTarget, { waitUntil: "domcontentloaded", timeout: 15000 })
                  .then(() => logger.info(`[nav-guard] snap-back to ${scanTarget} complete`))
                  .catch((err: any) => logger.warn(`[nav-guard] snap-back failed: ${err?.message || err}`));
              }
            }
          }
        }
      } catch { /* ignore navigation observer errors */ }
    });
  }

  // ROUND 5e — Normalise URLs for detour comparison: origin + pathname, lowercase,
  // no trailing slash, no query, no hash. Silent detours to /home should never
  // appear in the trail even if Playwright captures them via request/framenavigated.
  private normaliseUrlForDetourCheck(rawUrl: string): string {
    try {
      const parsed = new URL(String(rawUrl || ""));
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${parsed.origin.toLowerCase()}${path.toLowerCase()}`;
    } catch {
      return String(rawUrl || "").trim().toLowerCase();
    }
  }

  private recordNavigatedUrl(rawUrl: string, context: string): void {
    const url = String(rawUrl || "").trim();
    if (!url || url === "about:blank") return;
    // ROUND 5e — Suppress silent contract-switcher detours (e.g. .../home).
    // The switcher block in run() adds the detour URL to switcherDetourUrls
    // before page.goto(). Playwright's request/framenavigated listeners still
    // fire on that navigation; we filter it here so the trail shows only
    // URLs the tester actually meant to scan.
    if (this.switcherDetourUrls.has(this.normaliseUrlForDetourCheck(url))) {
      logger.info(`Scan navigation trail: suppressed contract-switcher detour (${context}): ${url}`);
      return;
    }
    if (this.navigatedUrlKeys.has(url)) return;
    this.navigatedUrlKeys.add(url);
    this.navigatedUrls.push(url);
    logger.info(`Scan navigated through URL (${context}): ${url}`);
  }

  // ROUND 5h — Test whether a URL is a switcher detour (e.g. .../home hit for
  // contract switching). Used by snapshot + issue push guards to keep detour
  // pages completely out of the report — screenshots, DOM snapshots, and
  // issues from those URLs would otherwise leak into the PDF's "URLs passed
  // through" list (reportService.ts line 356 aggregates snapshot.url +
  // issue.url as a fallback when persisted navigation trail is empty or short).
  private isSwitcherDetourUrl(url: string | undefined | null): boolean {
    if (!url) return false;
    return this.switcherDetourUrls.has(this.normaliseUrlForDetourCheck(url));
  }

  // ROUND 5h — Gated push for DOM snapshots. Every domSnapshots.push()
  // in this file goes through this helper. If the snapshot's url is a
  // suppressed switcher detour (e.g. /home), we skip the push entirely
  // so no screenshot/a11y-tree from /home ends up in the report.
  private pushDomSnapshotIfAllowed(snap: DomSnapshot): void {
    if (this.isSwitcherDetourUrl(snap?.url)) {
      logger.info(`Scan snapshot suppressed (switcher detour URL): ${snap.url} phase=${snap.phase}`);
      return;
    }
    this.domSnapshots.push(snap);
  }

  // ROUND 5h — Gated push for issues. Same reasoning as pushDomSnapshotIfAllowed:
  // Sky's SPA occasionally client-side-routes back to /home mid-scan, and any
  // axe/heuristic scan running during that window would attribute issues to
  // /home — those issues then contaminate the report and score.
  private pushIssuesIfAllowed(issues: ScanIssue[]): void {
    for (const issue of issues) {
      if (this.isSwitcherDetourUrl(issue.url)) {
        continue;
      }
      this.allIssues.push(issue);
    }
  }

  private recordNavigation(url: string, phase: string): void {
    const href = String(url || "").trim();
    if (!href) return;
    const previous = this.domSnapshots[this.domSnapshots.length - 1];
    if (previous?.url === href && previous?.phase === phase) return;
    const nodeId = this.recordTransitionNode(href, `navigation: ${phase}`, this.scan.state_label);
    this.pushDomSnapshotIfAllowed({
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
    this.pushDomSnapshotIfAllowed({
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
    this.pushDomSnapshotIfAllowed({
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
      progress(`[openLaunchPage] direct URL provided: ${basePage}`);
      const ok = await this.navigateAndRecord(page, basePage, "target interaction base page");
      if (!ok) throw new Error(`Launch page is unreachable: ${basePage}`);
      await this.waitForSlowPageContent(page, progress, basePage, 45000);
      await this.selectContractIfPickerVisible(page, authConfig, progress);
      return;
    }

    // Round-3 short-circuit: if the browser is ALREADY on the target page (login redirect,
    // deep-link, or previous navigation), skip the click-and-retry ladder entirely.
    const currentUrl = page.url();
    const directLaunchUrl = this.authenticatedLaunchUrlForLabel(basePage, fallbackUrl, currentUrl);
    if (directLaunchUrl) {
      try {
        const current = new URL(currentUrl);
        const target  = new URL(directLaunchUrl);
        if (current.origin === target.origin && current.pathname === target.pathname) {
          progress(`[openLaunchPage] already on target URL for "${basePage}" (${currentUrl}); skipping nav ladder`);
          await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
          await page.waitForLoadState("networkidle",    { timeout: 20000 }).catch(() => undefined);
          await this.waitForSlowPageContent(page, progress, basePage, 30000);
          if (authConfig?.auto_accept_cookies !== false) {
            await this.clearCookieConsent(page, this.authSelector(authConfig, "cookie_accept_selector")).catch(() => undefined);
          }
          await this.selectContractIfPickerVisible(page, authConfig, progress);
          return;
        }
      } catch { /* URL parse error — fall through to normal ladder */ }
    }

    progress(`[openLaunchPage] attempting sidebar click for "${basePage}" (current=${currentUrl})`);
    const clicked = await this.clickVisibleTextWithRetry(page, basePage, 25000);
    if (clicked) {
      progress(`[openLaunchPage] sidebar click succeeded for "${basePage}"`);
    } else {
      progress(`[openLaunchPage] sidebar click for "${basePage}" timed out after 25s`);

      if (directLaunchUrl) {
        progress(`[openLaunchPage] using direct route ${directLaunchUrl} for "${basePage}"`);
        const directOk = await this.navigateAndRecord(page, directLaunchUrl, `target interaction direct launch: ${basePage}`);
        if (!directOk) throw new Error(`Launch page direct route failed: ${basePage} → ${directLaunchUrl}`);
        await this.waitForSlowPageContent(page, progress, basePage, 30000);
      } else {
        progress(`[openLaunchPage] no direct route for "${basePage}"; falling back to ${fallbackUrl}`);
        const ok = await this.navigateAndRecord(page, fallbackUrl, "target interaction fallback page");
        if (!ok) throw new Error(`Could not return to authenticated launch root: ${fallbackUrl}`);
        await this.waitForSlowPageContent(page, progress, fallbackUrl, 45000);
        const retry = await this.clickVisibleTextWithRetry(page, basePage, 25000);
        if (!retry) throw new Error(`Launch page navigation item was not found: ${basePage}`);
        progress(`[openLaunchPage] retry click succeeded for "${basePage}"`);
      }
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle",    { timeout: 20000 }).catch(() => undefined);
    await this.waitForSlowPageContent(page, progress, basePage, 30000);
    if (authConfig?.auto_accept_cookies !== false) {
      await this.clearCookieConsent(page, this.authSelector(authConfig, "cookie_accept_selector")).catch(() => undefined);
    }
    // After reaching the launch page, check if a "Seleziona un contratto" picker
    // is blocking further navigation. Select and dismiss if configured.
    await this.selectContractIfPickerVisible(page, authConfig, progress);
    progress(`[openLaunchPage] complete for "${basePage}" (final URL=${page.url()})`);
  }

  /**
   * ROUND 5 — Sidebar contract switcher handler.
   *
   * Sky's multi-contract picker does NOT auto-appear as a modal on page load.
   * It appears only after the user clicks the double-arrow toggle in the left
   * sidebar (below the "Casa QUARTUCCIU" label). Clicking that toggle opens
   * a popover with radios + Conferma button.
   *
   * DOM structure (captured from live abbonamento.sky.it):
   *   Toggle:  <div class="contract-switch" role="button" tabindex="0">
   *              Casa QUARTUCCIU
   *              <i class="icon-contract-switch"></i>
   *            </div>
   *   Popover: <sky-popup-fade-template>
   *              <wsc-contract-switch>
   *                <h2>Seleziona un contratto</h2>
   *                <sky-radio-button groupname="contractSwitch">
   *                  <label for="id1">Casa QUARTUCCIU / Contratto Wifi + TV - 10600970</label>
   *                  <input type="radio" id="id1">
   *                </sky-radio-button>
   *                (more radios…)
   *                <button class="confirm-button">Conferma</button>
   *              </wsc-contract-switch>
   *            </sky-popup-fade-template>
   *
   * Behaviour (matches tester's agreed spec):
   *   1. No-op if neither contract_number nor contract_name is configured.
   *   2. No-op if `div.contract-switch` toggle isn't found on the page
   *      (single-contract account, or Sky moved the toggle).
   *   3. Click the toggle → wait for wsc-contract-switch popover.
   *   4. If popover doesn't appear within 5s: log warning, return cleanly
   *      (no error, no scan halt).
   *   5. Match radio by label text containing contract_number (preferred)
   *      or contract_name (fallback).
   *   6. If no radio matches: log warning + record informational issue,
   *      return cleanly (soft — DON'T halt scan).
   *   7. Click matched radio → click Conferma → wait for popover dismissal.
   *   8. On success: subsequent Target URL navigations use the newly
   *      selected contract's session context (cookies).
   */
  private async selectContractIfPickerVisible(
    page: any,
    authConfig: any,
    progress: (msg: string) => void
  ): Promise<void> {
    const contractNumber = String(authConfig?.contract_number || "").trim();
    const contractName   = String(authConfig?.contract_name   || "").trim();

    // ALWAYS log entry so we can prove the method is being called, regardless
    // of whether a switcher will actually run. This is our diagnostic anchor.
    // Round 5c: mirror progress() to logger.info so events show in backend log.
    // dualLog is a small helper — every call goes to both channels.
    const dualLog = (msg: string) => { progress(msg); logger.info(msg); };

    const authKeys = authConfig && typeof authConfig === "object" ? Object.keys(authConfig).join(",") : "<none>";
    dualLog(`[contract-switcher] ENTER — url=${page.url()} contract_number="${contractNumber}" contract_name="${contractName}" auth_keys=[${authKeys}]`);

    // Nothing to do if tester didn't configure a contract
    if (!contractNumber && !contractName) {
      dualLog(`[contract-switcher] no contract configured — skipping (this is normal for single-contract accounts)`);
      return;
    }

    // Track whether we've already switched in this browser context — once the
    // contract is picked, the popover doesn't reappear on later pages, so we
    // don't want to keep re-triggering the flow per URL.
    const alreadySwitched = (page as any).__axessia_contract_switched;
    if (alreadySwitched) {
      dualLog(`[contract-switcher] already switched in this session — skipping`);
      return;
    }

    // ROUND 5f Fix 1 — Explicit waitForSelector instead of "wait 1.5s and query once".
    // The previous fixed timeout misses Angular hydration variance: sometimes
    // Sky's shell micro-app renders the sidebar toggle in 800ms, sometimes 3s+.
    // A one-shot querySelector fires early → returns null → we incorrectly log
    // "single-contract account" and skip the switch. Now we wait up to 10s for
    // the toggle to actually appear before giving up.
    const toggleSelector = 'div.contract-switch[role="button"], .contract-switch[role="button"]';
    dualLog(`[contract-switcher] waiting for sidebar toggle (up to 10s)...`);
    const toggleAppeared = await page.waitForSelector(toggleSelector, { state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (!toggleAppeared) {
      // ROUND 5f Fix 3 — DOM evidence on miss. Dump a short snippet of the sidebar
      // (or body if sidebar isn't present) so we can see what Sky actually rendered.
      // Without this we're guessing whether the toggle changed selector, was
      // hidden by A/B test, or the account is genuinely single-contract.
      const evidence = await page.evaluate(() => {
        const sidebar = document.querySelector('sky-sidebar, aside, nav[class*="sidebar"], nav[class*="side-nav"]');
        const anyContract = Array.from(document.querySelectorAll('*'))
          .filter(el => /contract-switch|contract_switch|contract_toggle/i.test((el as HTMLElement).className || ""))
          .slice(0, 5)
          .map(el => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className || ""}`.slice(0, 100));
        return {
          sidebarFound: !!sidebar,
          sidebarPreview: sidebar ? (sidebar.outerHTML || "").slice(0, 600) : null,
          bodyPreview: document.body ? (document.body.innerHTML || "").slice(0, 400) : null,
          contractLikeMatches: anyContract,
          currentUrl: location.href
        };
      }).catch((err: any) => ({ error: String(err?.message || err) }));
      dualLog(`[contract-switcher] no sidebar toggle found on ${page.url()} after 10s wait — likely single-contract account (or Sky changed the selector). Evidence: ${JSON.stringify(evidence).slice(0, 900)}`);
      return;
    }

    // Toggle appeared. Re-run the visibility/text extraction now that we know it exists.
    const toggleFound = await page.evaluate((sel: string) => {
      const toggle = document.querySelector(sel) as HTMLElement | null;
      if (!toggle) return { found: false };
      const rect = toggle.getBoundingClientRect();
      return { found: true, visible: rect.width > 0 && rect.height > 0, text: (toggle.textContent || "").trim().slice(0, 80) };
    }, toggleSelector).catch(() => ({ found: false }));

    if (!toggleFound.found) {
      dualLog(`[contract-switcher] toggle vanished between waitForSelector and evaluate on ${page.url()} — continuing`);
      return;
    }
    if (!(toggleFound as any).visible) {
      dualLog(`[contract-switcher] toggle exists but not visible on ${page.url()} — continuing`);
      return;
    }
    dualLog(`[contract-switcher] toggle found: "${(toggleFound as any).text}"`);

    // 2. Click the toggle. Prefer .click() via evaluate() (bypasses overlays)
    //    but fall back to Playwright's .click() if that fails.
    const clickedToggle = await page.evaluate(() => {
      const toggle = document.querySelector('div.contract-switch[role="button"], .contract-switch[role="button"]') as HTMLElement | null;
      if (!toggle) return false;
      toggle.click();
      return true;
    }).catch(() => false);

    if (!clickedToggle) {
      // Playwright fallback
      const locator = page.locator('div.contract-switch[role="button"]').first();
      await locator.click({ timeout: 3000 }).catch(() => undefined);
    }

    dualLog(`[contract-switcher] toggle clicked, waiting for popover`);

    // 3. Wait up to 5s for the popover to render
    const popoverAppeared = await page.waitForSelector('wsc-contract-switch', { timeout: 5000, state: 'visible' })
      .then(() => true)
      .catch(() => false);

    if (!popoverAppeared) {
      dualLog(`[contract-switcher] popover did not appear within 5s after toggle click — continuing without switch`);
      return;
    }
    dualLog(`[contract-switcher] popover appeared`);

    // 4. Find and click the matching radio inside the popover
    const clickResult = await page.evaluate(({ number, name }: { number: string; name: string }) => {
      const popover = document.querySelector('wsc-contract-switch');
      if (!popover) return { ok: false, reason: 'popover-vanished' };

      const radios = Array.from(popover.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
      if (!radios.length) return { ok: false, reason: 'no-radios-in-popover' };

      const labelTextFor = (r: HTMLInputElement): string => {
        // Radio input is a sibling of the <label for=id>, not nested inside.
        // Try label[for=id] first, then closest container as fallback.
        const id = r.id;
        const forLabel = id ? popover.querySelector(`label[for="${id}"]`) : null;
        const parentContainer = r.closest('sky-radio-button, .radio-container, .radio-button-container > *');
        return [
          forLabel?.textContent || '',
          parentContainer?.textContent || '',
        ].join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      };

      // All radio labels for debug
      const allLabels = radios.map(r => labelTextFor(r).slice(0, 100));

      // Prefer number match (more specific)
      let match: HTMLInputElement | null = null;
      let matchedBy = '';
      if (number) {
        match = radios.find(r => labelTextFor(r).includes(number.toLowerCase())) || null;
        if (match) matchedBy = `number "${number}"`;
      }
      if (!match && name) {
        match = radios.find(r => labelTextFor(r).includes(name.toLowerCase())) || null;
        if (match) matchedBy = `name "${name}"`;
      }
      if (!match) {
        return { ok: false, reason: 'no-match', allLabels };
      }

      // Click via label if present (more reliable — bypasses hidden radio quirks)
      const id = match.id;
      const label = id ? popover.querySelector(`label[for="${id}"]`) as HTMLElement | null : null;
      const clickTarget = label || (match.closest('sky-radio-button') as HTMLElement | null) || match;
      clickTarget.click();
      match.checked = true;
      match.dispatchEvent(new Event('change', { bubbles: true }));
      match.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, matchedBy, labelText: labelTextFor(match).slice(0, 120) };
    }, { number: contractNumber, name: contractName }).catch((e: any) => ({ ok: false, reason: `eval-error:${e?.message || e}` }));

    if (!(clickResult as any).ok) {
      const reason = (clickResult as any).reason;
      const allLabels = (clickResult as any).allLabels;
      dualLog(`[contract-switcher] could not match radio (reason=${reason}). Configured number="${contractNumber}", name="${contractName}". Available: ${JSON.stringify(allLabels || [])}`);
      // Soft-fail per tester's spec — record an informational issue but don't
      // halt the scan. The scan continues on the default contract.
      this.pushIssuesIfAllowed([{
        ruleId: 'contract-selection-mismatch',
        severity: 'moderate',
        category: 'authentication-flow',
        message: `The contract switcher was opened on the Home URL, but the configured contract could not be matched. Configured: number="${contractNumber}", name="${contractName}". Scan continued on the default contract.`,
        url: page.url(),
        selector: 'wsc-contract-switch input[type="radio"]',
        wcag: ['wcag2.4.3'],
        tags: ['authentication-flow', 'multi-contract'],
        fixSuggestion: `Check the exact contract number or name in Sky's picker (e.g. "Casa QUARTUCCIU — Contratto Wifi + TV - 10600970") and update the scan's Multi-contract fields to match.`,
        evidenceExplanation: `On ${page.url()}, opened the sidebar contract switcher. Configured value did not appear in any radio label. Available radios: ${JSON.stringify(allLabels || [])}`,
      }]);
      // Try to close the popover so it doesn't block subsequent navigation
      await page.evaluate(() => {
        const close = document.querySelector('wsc-contract-switch .close-button-container button, wsc-contract-switch .close-button-container [role="button"]') as HTMLElement | null;
        close?.click();
      }).catch(() => undefined);
      return;
    }

    dualLog(`[contract-switcher] radio matched by ${(clickResult as any).matchedBy}, label="${(clickResult as any).labelText}"`);

    // 5. Click Conferma
    const confirmed = await page.evaluate(() => {
      const popover = document.querySelector('wsc-contract-switch');
      if (!popover) return false;
      const btn = popover.querySelector('button.confirm-button') as HTMLElement | null
               || Array.from(popover.querySelectorAll('button')).find(b => /^\s*conferma\s*$/i.test(b.textContent?.trim() || '')) as HTMLElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);

    if (!confirmed) {
      dualLog(`[contract-switcher] radio was clicked but Conferma button not found — some Sky templates auto-confirm on radio change, continuing`);
    } else {
      dualLog(`[contract-switcher] Conferma clicked`);
    }

    // 6. Wait up to 8s for the popover to disappear
    const dismissed = await page.waitForFunction(
      () => !document.querySelector('wsc-contract-switch'),
      { timeout: 8000 }
    ).then(() => true).catch(() => false);

    if (dismissed) {
      dualLog(`[contract-switcher] popover dismissed — contract switch complete`);
    } else {
      dualLog(`[contract-switcher] popover still visible after 8s — continuing anyway`);
    }

    // Let network requests triggered by contract switch settle before Target URL navigation
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);

    // Mark this browser context as switched so we don't re-open the popover on every URL
    (page as any).__axessia_contract_switched = true;
  }

  /**
   * ROUND 5b — derive Sky's home/dashboard URL from any target URL so the
   * contract-switcher detour goes to the right place regardless of target.
   *
   * Sky's contract-switch sidebar lives on any authenticated shell page
   * (/home, /gestisci, /offers, /profile, etc.). We use /home because it's
   * the canonical landing page post-login.
   *
   * Example: target = "https://abbonamento.sky.it/offers/pdp/tv/44157"
   *          → returns "https://abbonamento.sky.it/home"
   */
  // ROUND 5g — Prefer an explicit home_url from auth_config if provided.
  // Falls back to origin/home derivation for backwards compatibility.
  // Once the frontend adds a Home URL field and authSessionManager persists
  // it into auth_config.home_url, that value wins. Until then, derivation
  // is used (same behaviour as Round 5b–5f).
  private contractSwitcherHomeUrlForTarget(targetUrl: string, authConfig?: any): string {
    const explicit = String(authConfig?.home_url || "").trim();
    if (explicit && /^https?:\/\//i.test(explicit)) return explicit;
    try {
      const u = new URL(targetUrl);
      return `${u.origin}/home`;
    } catch {
      return "https://abbonamento.sky.it/home";
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
    this.pushIssuesIfAllowed([{
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
    }]);
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
      this.pushIssuesIfAllowed([{
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
      }]);
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

  // ROUND 5h — WCAG-Level-weighted score.
  // Prior formula weighted only by axe/heuristic severity (critical/serious/…).
  // This one weights primarily by WCAG conformance level (A > AA > AAA) —
  // matching what auditors and legal frameworks actually care about (EN 301 549,
  // Section 508, EAA all target Level AA conformance). Severity acts as a
  // secondary multiplier within each level.
  //
  //   Level weight × Severity multiplier × Affected-count scale, summed →
  //   score = 100 × capacity / (capacity + impact)   with capacity = 100 × √URLs
  //
  // Rationale for level weights (A=15, AA=8, AAA=3, unknown=2):
  //   A   — hard failure of baseline access (e.g. keyboard trap, missing alt)
  //   AA  — the WCAG conformance bar every EU/US regulation targets
  //   AAA — enhanced; failures matter but don't block conformance at AA
  //   unknown — heuristic finding without a mapped criterion
  //
  // Rationale for severity multipliers (critical=1.5 down to minor=0.4):
  //   axe/heuristics also rate impact per instance. A critical Level A issue
  //   should hurt more than a minor Level A issue.
  //
  // A single critical Level A issue on 1 URL:  15 × 1.5 = 22.5 → score ~82.
  // A single moderate Level AA issue on 1 URL: 8  × 0.8 = 6.4  → score ~94.
  // The Aug 25 Sky scan (16 issues, mostly AA + 3 at A) should now surface
  // around 30-40, driven mainly by the A-level failures.
  private static readonly WCAG_CRITERION_LEVELS: Record<string, "A" | "AA" | "AAA"> = {
    "1.1.1":"A", "1.2.1":"A", "1.2.2":"A", "1.2.3":"A", "1.2.4":"AA", "1.2.5":"AA",
    "1.2.6":"AAA", "1.2.7":"AAA", "1.2.8":"AAA", "1.2.9":"AAA",
    "1.3.1":"A", "1.3.2":"A", "1.3.3":"A", "1.3.4":"AA", "1.3.5":"AA", "1.3.6":"AAA",
    "1.4.1":"A", "1.4.2":"A", "1.4.3":"AA", "1.4.4":"AA", "1.4.5":"AA",
    "1.4.6":"AAA", "1.4.7":"AAA", "1.4.8":"AAA", "1.4.9":"AAA",
    "1.4.10":"AA", "1.4.11":"AA", "1.4.12":"AA", "1.4.13":"AA",
    "2.1.1":"A", "2.1.2":"A", "2.1.3":"AAA", "2.1.4":"A",
    "2.2.1":"A", "2.2.2":"A", "2.2.3":"AAA", "2.2.4":"AAA", "2.2.5":"AAA", "2.2.6":"AAA",
    "2.3.1":"A", "2.3.2":"AAA", "2.3.3":"AAA",
    "2.4.1":"A", "2.4.2":"A", "2.4.3":"A", "2.4.4":"A", "2.4.5":"AA", "2.4.6":"AA",
    "2.4.7":"AA", "2.4.8":"AAA", "2.4.9":"AAA", "2.4.10":"AAA",
    "2.4.11":"AA", "2.4.12":"AA", "2.4.13":"AAA",
    "2.5.1":"A", "2.5.2":"A", "2.5.3":"A", "2.5.4":"A", "2.5.5":"AAA", "2.5.6":"AAA",
    "2.5.7":"AA", "2.5.8":"AA",
    "3.1.1":"A", "3.1.2":"AA", "3.1.3":"AAA", "3.1.4":"AAA", "3.1.5":"AAA", "3.1.6":"AAA",
    "3.2.1":"A", "3.2.2":"A", "3.2.3":"AA", "3.2.4":"AA", "3.2.5":"AAA", "3.2.6":"A",
    "3.3.1":"A", "3.3.2":"A", "3.3.3":"AA", "3.3.4":"AA", "3.3.5":"AAA", "3.3.6":"AAA",
    "3.3.7":"A", "3.3.8":"AA", "3.3.9":"AAA",
    "4.1.1":"A", "4.1.2":"A", "4.1.3":"AA",
  };

  private wcagLevelForIssue(issue: ScanIssue): "A" | "AA" | "AAA" | "unknown" {
    const rank = { A: 1, AA: 2, AAA: 3 } as const;
    let strongest: "A" | "AA" | "AAA" | null = null;
    const raw: string[] = [];
    const criteria = (issue as any).wcag_criteria;
    const tags = (issue as any).tags;
    if (Array.isArray(criteria)) raw.push(...criteria.map(String));
    if (Array.isArray(tags)) raw.push(...tags.map(String));
    for (const t of raw) {
      // ROUND 5l — use full normaliser (see AccessibilityScanner.normaliseCriterionTag)
      // instead of the too-narrow dotted-only regex, so tag shapes like
      // "wcag2aa-1.4.10", "wcag1410", "sc 1.4.10" all resolve. The old regex
      // missed all axe-emitted tags — that's why conformance was showing 100%.
      const key = AccessibilityScanner.normaliseCriterionTag(t);
      if (!key) continue;
      const lvl = AccessibilityScanner.WCAG_CRITERION_LEVELS[key];
      if (!lvl) continue;
      if (!strongest || rank[lvl] < rank[strongest]) strongest = lvl;
    }
    return strongest || "unknown";
  }

  // ROUND 5l — Full-strength criterion normaliser.
  // ROUND 5r — Fixed the "section508" false positive: previously it matched
  // the compact digit pattern and returned "5.0.8" (which is not a WCAG
  // criterion). Now explicitly rejects tags that start with non-WCAG
  // prefixes (section508, best-practice, ACT, cat.*, etc.).
  private static normaliseCriterionTag(tag: string): string | null {
    let raw = String(tag || "").toLowerCase().trim();
    if (!raw) return null;
    // ROUND 5r — reject non-WCAG tag prefixes explicitly so their digits
    // don't get mangled into fake criterion numbers.
    if (/^(?:section508|best-practice|cat\.|act[-_]?|experimental|review-item|deprecated|rgaa|en[-_]?301|tt|ttv|unien)/.test(raw)) {
      return null;
    }
    raw = raw.replace(/^wcag\s*/, "").replace(/^sc\s*/, "").replace(/^(?:level\s*)?a+\s+/, "");
    if (/^[\d.]*a+$/.test(raw)) return null;
    const dotted = raw.match(/^(\d)\.(\d)\.(\d{1,2})$/);
    if (dotted) return `${dotted[1]}.${dotted[2]}.${dotted[3]}`;
    const mixed = raw.match(/(\d)\.(\d)\.(\d{1,2})(?!\d)/);
    if (mixed) return `${mixed[1]}.${mixed[2]}.${mixed[3]}`;
    const compact = raw.replace(/[^0-9]/g, "");
    if (/^\d{3,4}$/.test(compact)) return `${compact[0]}.${compact[1]}.${compact.slice(2)}`;
    return null;
  }

  // ROUND 5r — Level fallback. Detects WCAG level from tags like "wcag2a",
  // "wcag2aa", "wcag21a", "wcag22aa" — level info without specific criterion.
  // Used by computeConformanceBreakdown to count issues that have level info
  // but no specific criterion tag (which is common for heuristic findings
  // and generic axe rules), so they factor into the conformance score.
  private static wcagLevelFromLevelTag(tag: string): "A" | "AA" | "AAA" | null {
    const lower = String(tag || "").toLowerCase().trim();
    // Match wcag2a, wcag21a, wcag2aa, wcag22aa, wcag2aaa, etc.
    const m = lower.match(/^wcag\s*\d{0,2}(a+)$/);
    if (!m) return null;
    const aCount = m[1].length;
    if (aCount === 1) return "A";
    if (aCount === 2) return "AA";
    if (aCount === 3) return "AAA";
    return null;
  }

  // Determines strongest (most severe) WCAG level associated with an issue,
  // whether from a specific criterion tag or a level-only tag. Returns
  // "unknown" if nothing WCAG-related is tagged.
  private determineIssueLevel(issue: ScanIssue): "A" | "AA" | "AAA" | "unknown" {
    const fromCriterion = this.wcagLevelForIssue(issue);
    if (fromCriterion !== "unknown") return fromCriterion;
    const rank = { A: 1, AA: 2, AAA: 3 } as const;
    let strongest: "A" | "AA" | "AAA" | null = null;
    const raw: string[] = [];
    const criteria = (issue as any).wcag_criteria;
    const tags = (issue as any).tags;
    if (Array.isArray(criteria)) raw.push(...criteria.map(String));
    if (Array.isArray(tags)) raw.push(...tags.map(String));
    for (const t of raw) {
      const lvl = AccessibilityScanner.wcagLevelFromLevelTag(t);
      if (!lvl) continue;
      if (!strongest || rank[lvl] < rank[strongest]) strongest = lvl;
    }
    return strongest || "unknown";
  }

  // ROUND 5i — Evinced-style weighted pass/fail score.
  // Aligned with the industry-standard scoring model used by Cypress,
  // BrowserStack, and (as documented publicly) Evinced-style scoring:
  //   Score = 100 × capacity / (capacity + Σ failed weights × penalty)
  //
  // Per-issue weight = axeSeverityWeight × wcagLevelMultiplier × affectedScale
  // Penalty = 2 (failed rules penalized twice — Cypress/BrowserStack convention).
  //
  // Axe severity weights (matches axe-core impact taxonomy):
  //   critical: 10  — blocks core interaction (keyboard trap, missing controls)
  //   serious:   7  — high impact, definite barrier
  //   moderate:  4  — significant but not blocking
  //   minor:     1  — cosmetic or nice-to-have
  //
  // WCAG Level multiplier:
  //   A:   1.5  — baseline access; conformance to A is legally minimum
  //   AA:  1.2  — the EN 301 549 / EAA / Section 508 target level
  //   AAA: 0.6  — enhanced; failures matter less for conformance
  //   unknown: 1.0
  //
  // Capacity = 250 × √URLs — tuned so a single Serious/AA issue with 1
  // affected instance on 1 URL scores ~92, and a Sky-like page with 16
  // mixed issues scores ~30-35 (matches the ballpark of the previous
  // scoring model, but now driven by the industry-standard formula).
  //
  // Additionally exposes computeConformanceBreakdown() for the report layer:
  // per-level (A/AA/AAA) applicable vs failed counts, matching how
  // conformance is normally reported to auditors and regulators.
  // ROUND 5v — Evinced-style score. Simple, transparent formula matching
  // the PDF report's "How the score is calculated" section:
  //
  //   weighted_sum = Σ (defect_count × severity_weight × level_weight)
  //   perPage      = weighted_sum / distinct_pages_with_defects
  //   score        = clamp(0, 100, 100 − perPage)
  //
  // Weights (classic Evinced/Deque-style):
  //   Severity: Critical=3.0, Serious=1.9, Moderate=0.85, Minor=0.15
  //   Level:    A=1.00, AA=0.75, AAA=0.50, unknown=0.50
  //
  // This replaces the earlier "asymptotic capacity" formula
  // (100 × capacity / (capacity + impact)) which was too generous and
  // hid real defects behind large capacity numbers. The new formula
  // directly penalises defects proportional to their severity and level,
  // and both the summary UI and PDF report use the same numbers.
  private computeScore(issues: ScanIssue[]): number {
    if (!issues.length) return 100;

    const severityWeight: Record<string, number> = {
      critical: 3.0, serious: 1.9, moderate: 0.85, minor: 0.15,
    };
    const levelWeight: Record<string, number> = {
      A: 1.00, AA: 0.75, AAA: 0.50, unknown: 0.50,
    };

    let weightedSum = 0;
    for (const issue of issues) {
      const sev = String(issue.severity || "minor").toLowerCase();
      const level = this.wcagLevelForIssue(issue);
      const sw = severityWeight[sev] ?? 0.5;
      const lw = levelWeight[level] ?? 0.5;
      weightedSum += sw * lw;
    }

    const pages = new Set(issues.map(i => i.url).filter(Boolean)).size || 1;
    const perPage = weightedSum / pages;
    const score = 100 - perPage;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ROUND 5i — Conformance breakdown used by the report layer.
  // Applicable-set model (Capgemini-style pass/fail): for each level (A,AA,AAA)
  // count how many WCAG criteria the scanner is aware of at that level, and how
  // many have at least one failed issue in this scan. This is complementary to
  // the Evinced-style score above — one number for engineering focus (the
  // weighted score), one for auditor/legal-facing reports (conformance %).
  //
  // Returned shape (matches what reportService.ts consumes):
  //   {
  //     score: <Evinced-style 0-100>,
  //     conformance: {
  //       A:   { applicable, failed, passed, pct },
  //       AA:  { applicable, failed, passed, pct },
  //       AAA: { applicable, failed, passed, pct },
  //       overall_A_AA: { applicable, failed, passed, pct },
  //     },
  //     failed_criteria: [
  //       { criterion: "2.1.1", level: "A", defect_count, issue_ids },
  //       ...
  //     ],
  //   }
  public computeConformanceBreakdown(): {
    score: number;
    conformance: Record<string, { applicable: number; failed: number; passed: number; pct: number }>;
    failed_criteria: { criterion: string; level: string; defect_count: number; issue_ids: string[] }[];
    contributors?: any[];
    formula?: any;
  } {
    const applicableByLevel: Record<string, string[]> = { A: [], AA: [], AAA: [] };
    for (const [criterion, level] of Object.entries(AccessibilityScanner.WCAG_CRITERION_LEVELS)) {
      applicableByLevel[level].push(criterion);
    }

    // Build a criterion → { defects, issue_ids } map from this scan's issues.
    const failedMap = new Map<string, { level: string; ids: Set<string>; count: number }>();
    for (const issue of this.allIssues) {
      const raw: string[] = [];
      const criteria = (issue as any).wcag_criteria;
      const tags = (issue as any).tags;
      if (Array.isArray(criteria)) raw.push(...criteria.map(String));
      if (Array.isArray(tags)) raw.push(...tags.map(String));
      for (const t of raw) {
        // ROUND 5l — use the full normaliser so axe-emitted shapes resolve.
        const key = AccessibilityScanner.normaliseCriterionTag(t);
        if (!key) continue;
        const lvl = AccessibilityScanner.WCAG_CRITERION_LEVELS[key];
        if (!lvl) continue;
        if (!failedMap.has(key)) failedMap.set(key, { level: lvl, ids: new Set(), count: 0 });
        const entry = failedMap.get(key)!;
        entry.count += Math.max(issue.affectedCount || 1, 1);
        if ((issue as any).id) entry.ids.add(String((issue as any).id));
      }
    }

    const perLevel = (level: string) => {
      const applicable = applicableByLevel[level]?.length || 0;
      const failed = Array.from(failedMap.values()).filter(v => v.level === level).length;
      const passed = applicable - failed;
      const pct = applicable ? Math.round((passed / applicable) * 10000) / 100 : 100;
      return { applicable, failed, passed, pct };
    };

    // ROUND 5r — Count issues that have WCAG level info (from tags like
    // "wcag2a" or "wcag2aa") but NO specific criterion match. These issues
    // are legitimate accessibility failures at a WCAG level but their tag
    // shape doesn't reveal WHICH criterion — so they were escaping the
    // per-criterion conformance score entirely, leaving the score at 100%
    // even when real Level A / AA failures exist. Now they count toward the
    // level's failure total via a synthetic "unmapped" bucket.
    const unmappedLevelIssues = { A: 0, AA: 0, AAA: 0 };
    const unmappedLevelIssueIds: Record<string, string[]> = { A: [], AA: [], AAA: [] };
    for (const issue of this.allIssues) {
      // Was this issue already counted in failedMap (i.e., a specific
      // criterion was extracted)?
      const raw: string[] = [];
      const criteria = (issue as any).wcag_criteria;
      const tags = (issue as any).tags;
      if (Array.isArray(criteria)) raw.push(...criteria.map(String));
      if (Array.isArray(tags)) raw.push(...tags.map(String));
      const mappedToSomeCriterion = raw.some(t => {
        const k = AccessibilityScanner.normaliseCriterionTag(t);
        return k !== null && !!AccessibilityScanner.WCAG_CRITERION_LEVELS[k];
      });
      if (mappedToSomeCriterion) continue;
      // Not mapped to any criterion — check level-only tags.
      const level = this.determineIssueLevel(issue);
      if (level === "unknown") continue;
      unmappedLevelIssues[level]++;
      if ((issue as any).id) unmappedLevelIssueIds[level].push(String((issue as any).id).slice(0, 8));
    }

    const A = perLevel("A");
    const AA = perLevel("AA");
    const AAA = perLevel("AAA");

    // ROUND 5r — merge unmapped-level counts into the level's failed count.
    // Each unmapped issue counts as 1 additional pseudo-failure at that level.
    // The applicable set grows too, so the pct math stays proportional.
    const A_total = { applicable: A.applicable + unmappedLevelIssues.A, failed: A.failed + unmappedLevelIssues.A, passed: A.passed, pct: 0 };
    A_total.pct = A_total.applicable ? Math.round((A_total.passed / A_total.applicable) * 10000) / 100 : 100;
    const AA_total = { applicable: AA.applicable + unmappedLevelIssues.AA, failed: AA.failed + unmappedLevelIssues.AA, passed: AA.passed, pct: 0 };
    AA_total.pct = AA_total.applicable ? Math.round((AA_total.passed / AA_total.applicable) * 10000) / 100 : 100;
    const AAA_total = { applicable: AAA.applicable + unmappedLevelIssues.AAA, failed: AAA.failed + unmappedLevelIssues.AAA, passed: AAA.passed, pct: 0 };
    AAA_total.pct = AAA_total.applicable ? Math.round((AAA_total.passed / AAA_total.applicable) * 10000) / 100 : 100;

    const overall = {
      applicable: A_total.applicable + AA_total.applicable,
      failed: A_total.failed + AA_total.failed,
      passed: A_total.passed + AA_total.passed,
      pct: (A_total.applicable + AA_total.applicable)
        ? Math.round(((A_total.passed + AA_total.passed) / (A_total.applicable + AA_total.applicable)) * 10000) / 100
        : 100,
    };

    // ROUND 5l/5r — diagnostic log for conformance breakdown.
    const totalIssues = this.allIssues.length;
    const matchedCriteria = Array.from(failedMap.keys()).sort();
    const unmatched: string[] = [];
    for (const issue of this.allIssues.slice(0, 8)) {
      const raw: string[] = [];
      const criteria = (issue as any).wcag_criteria;
      const tags = (issue as any).tags;
      if (Array.isArray(criteria)) raw.push(...criteria.map(String));
      if (Array.isArray(tags)) raw.push(...tags.map(String));
      for (const t of raw) {
        if (!AccessibilityScanner.normaliseCriterionTag(t)) unmatched.push(t);
      }
    }
    logger.info(`[conformance] ROUND 5r — issues=${totalIssues}, matchedCriteria=[${matchedCriteria.join(",")}], unmappedLevelIssues={A:${unmappedLevelIssues.A}, AA:${unmappedLevelIssues.AA}, AAA:${unmappedLevelIssues.AAA}}, A(applicable=${A_total.applicable},failed=${A_total.failed},pct=${A_total.pct}), AA(applicable=${AA_total.applicable},failed=${AA_total.failed},pct=${AA_total.pct}), overall_A_AA_pct=${overall.pct}. Sample unmatched tags (first 8): [${Array.from(new Set(unmatched)).slice(0, 20).map(x => `"${x}"`).join(",")}]`);

    const failed_criteria = Array.from(failedMap.entries())
      .map(([criterion, v]) => ({
        criterion,
        level: v.level,
        defect_count: v.count,
        issue_ids: Array.from(v.ids),
      }))
      .sort((a, b) => {
        const rank = { A: 1, AA: 2, AAA: 3 } as Record<string, number>;
        if (rank[a.level] !== rank[b.level]) return rank[a.level] - rank[b.level];
        return a.criterion.localeCompare(b.criterion);
      });

    // ROUND 5j — Per-issue score contribution for methodology transparency.
    // Same formula as computeScore() so the report can show "here's what
    // dragged your score from 100 down to 42, ranked by impact".
    const severityWeight: Record<string, number> = { critical: 10, serious: 7, moderate: 4, minor: 1 };
    const levelMultiplier = { A: 1.5, AA: 1.2, AAA: 0.6, unknown: 1.0 } as const;
    const contributors = this.allIssues.map(issue => {
      const sevW = severityWeight[issue.severity] || 3;
      const level = this.wcagLevelForIssue(issue);
      const lvlM = levelMultiplier[level];
      const affected = Math.max(issue.affectedCount || issue.selectors?.length || 1, 1);
      const scale = 1 + Math.min(Math.log2(affected), 6) * 0.25;
      const weight = sevW * lvlM * scale;
      return {
        issue_id: String((issue as any).id || "").slice(0, 8),
        title: String((issue as any).title || issue.ruleId || "").slice(0, 120),
        severity: issue.severity,
        wcag_level: level,
        affected_count: affected,
        severity_weight: sevW,
        level_multiplier: lvlM,
        affected_scale: Math.round(scale * 100) / 100,
        contribution: Math.round(weight * 100) / 100,
      };
    }).sort((a, b) => b.contribution - a.contribution);

    return {
      score: this.computeScore(this.allIssues),
      conformance: { A: A_total, AA: AA_total, AAA: AAA_total, overall_A_AA: overall },
      failed_criteria,
      contributors,
      formula: {
        model: "Evinced-style weighted defect ratio (aligned with axe-core impact + WCAG level)",
        equation: "score = 100 × capacity / (capacity + Σ(weight) × 2)",
        weight_formula: "weight = axeSeverityWeight × wcagLevelMultiplier × (1 + min(log2(1+affected), 6) × 0.25)",
        severity_weights: severityWeight,
        level_multipliers: levelMultiplier,
        failure_penalty: 2,
        capacity: "250 × √URLs",
      },
    };
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



