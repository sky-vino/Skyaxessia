/**
 * types.ts
 * Shared types used across all scanner modules.
 */

export type Severity = "critical" | "serious" | "moderate" | "minor";

export interface ScanIssue {
  ruleId: string;
  severity: Severity;
  priority?: number;
  category?: string;
  message: string;
  url: string;
  selector?: string;
  selectors?: string[];
  affectedElements?: string[];
  depths?: number[];
  wcag?: string[];
  act?: string[];
  tags?: string[];
  helpUrl?: string;
  htmlSnippet?: string;
  fixSuggestion?: string;
  evidenceScreenshot?: string;
  evidenceExplanation?: string;
  componentId?: string;
  componentOwner?: string;
  sourceHint?: string;
  state?: string;
  phase?: string;
  affectedCount?: number;
  /**
   * Ship 2 / Item 5 — URL-independent grouping key for landmark-scoped issues
   * (banner / contentinfo / navigation / main / complementary / region /
   * search / form). Populated by scanner post-processing. The scan detail
   * endpoint aggregates issues sharing this key across URLs so cross-page
   * duplicates (e.g. a footer rule firing on all 30 crawled pages) show as
   * one entry with a "Appears on N pages" badge.
   */
  landmark_group_key?: string;
}

export interface ElemPath {
  selector: string;
  depth: number;
}

export interface DomSnapshot {
  url: string;
  phase: string;
  state?: string;
  a11yTree: any;
  screenshot?: string;
}

export interface OwnerFallbackRule {
  pattern: string;
  owner: string;
  component?: string;
  source?: string;
  match?: "url" | "selector" | "message" | "any";
}

export interface TestCase {
  name: string;
  description: string;
  category: string;
  wcagRef: string;
  status: "pass" | "fail" | "pending";
  issueId?: string;
  issueRuleId?: string;
  issueUrl?: string;
  steps?: string[];
  result?: string;
}

export interface StateConfig {
  name: string;
  trigger?: string;         // CSS selector to click/hover to enter state
  triggerType?: "click" | "hover" | "focus" | "keyboard";
  key?: string;             // keyboard key if triggerType=keyboard
  waitMs?: number;
  description?: string;
}

export type TargetInteractionMode = "single-interaction" | "journey";
export type TargetClickType = "button" | "link" | "heading-link" | "any";
export type TargetStepAction = "navigate-page" | "click";

export interface TargetJourneyStep {
  action: TargetStepAction;
  page?: string;
  name?: string;
  selector?: string;
  text?: string;
  cta_text?: string;
  href_contains?: string;
  click_type?: TargetClickType;
  scan_after_step?: boolean;
}

export interface TargetInteractionConfig {
  /** Authenticated navigation/page label used as a launch point, for example Offerte or Fatture. */
  base_page: string;
  /** single-interaction scans one clicked destination; journey executes ordered navigate/click steps. */
  mode?: TargetInteractionMode;
  /** Human readable name shown in scan progress and generated test cases. */
  name?: string;
  /** CSS/XPath/JS selector for the exact link/button/card CTA. */
  selector?: string;
  /** Visible text or accessible name to match, usually the promo/card heading. */
  text?: string;
  /** CTA text inside the matched card/container, for example "Scopri di piu". */
  cta_text?: string;
  /** URL fragment/pattern expected in the target href. */
  href_contains?: string;
  /** Restricts which interactive element kind should be clicked. */
  click_type?: TargetClickType;
  /** If true, the base page is only used for navigation; only the destination is scanned. */
  scan_destination_only?: boolean;
  /** If true, scan the launch page before clicking. Defaults to false for targeted test cases. */
  scan_launch_page?: boolean;
  /** Ordered deterministic steps for multi-page target journeys. */
  steps?: TargetJourneyStep[];
}

export type ControlledInteractionMode = "safe-auto" | "tester-selected" | "exhaustive";

export interface ControlledInteractionReportItem {
  label: string;
  selector: string;
  kind: string;
  href?: string;
  status: "clicked" | "skipped" | "blocked" | "failed" | "scanned";
  outcome?: string;
  reason?: string;
  scannedUrl?: string;
}

export interface ExtensionSessionCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export interface ScanOptions {
  run_axe?: boolean;
  run_heuristics?: boolean;
  run_focus?: boolean;
  run_keyboard_nav?: boolean;
  run_zoom?: boolean;
  run_color?: boolean;
  run_pointer?: boolean;
  run_live_dom?: boolean;
  run_dynamic?: boolean;
  run_states?: boolean;
  run_motion?: boolean;
  run_reflow?: boolean;
  capture_screenshots?: boolean;
  /**
   * Ship 1 / Item 4 — WCAG zoom target.
   * 400 (WCAG 1.4.10 default) tests both 200%/300% intermediate breakpoints AND the 320px reflow (400% equivalent).
   * 200 skips the 320px reflow test and only reports 200% intermediate-breakpoint failures.
   * Defaults to 200 to match this team's audit scenario.
   */
  zoom_target_percent?: 200 | 400;
  /**
   * Ship 1 / Item 7 — When true, advisory / best-practice rules
   * (target-size-enhanced, fixed-font-size, text-truncation,
   *  complex-background, motion, gesture-no-alternative) are dropped
   * from scan output entirely instead of being downgraded to the
   * "advisory" category. Defaults to false (preserves prior behaviour).
   */
  suppress_advisory_rules?: boolean;
  /** shallow = fast target-only checks; standard = sampled states; exhaustive = deeper state discovery. */
  scan_depth_mode?: "shallow" | "standard" | "exhaustive";
  viewport_width?: number;
  viewport_height?: number;
  headful?: boolean;
  extra_states?: StateConfig[];
  /** url = scan supplied target URLs; journey = use target URLs only as auth/start context and scan configured journeys. */
  scan_entry_mode?: "url" | "journey";
  /** When true, after login the scanner BFS-discovers links from each seed URL and scans up to crawl_max_pages per seed. */
  crawl_mode?: boolean;
  /** Max link hops from the seed URL (0 = seed only, 1 = seed + direct links, …). Capped at 10. */
  crawl_depth?: number;
  /** If true (default), only enqueue URLs on the same hostname as the seed. */
  crawl_same_domain?: boolean;
  /** If non-empty, a URL must match at least one pattern (substring, or glob with *). */
  crawl_include_patterns?: string[];
  /** URLs matching any of these patterns are skipped. */
  crawl_exclude_patterns?: string[];
  /** Hard cap on distinct pages scanned per seed URL when crawl_mode is on (1–200). */
  crawl_max_pages?: number;
  /** When auth is configured, scan the public login URL before starting the authenticated session. */
  scan_login_page?: boolean;
  /** After OTP/auth completes, scan the page where the browser actually lands. */
  scan_post_login_landing?: boolean;
  /** Scan the authenticated Gestisci/profile page. When false it can still be used only as a navigation root. */
  scan_gestisci_page?: boolean;
  /** After landing post-login, scan visible tab/navigation states on that page. */
  post_login_tab_scan?: boolean;
  /** Max tab/navigation states to scan after login. */
  post_login_tab_limit?: number;
  /** Ordered authenticated navigation labels/pages to scan after landing. */
  post_login_pages?: string[];
  /** Targeted one-off interactions. The scanner navigates to base_page, clicks only the matching target, then scans the destination. */
  target_interactions?: TargetInteractionConfig[];
  /** Discover and test links/buttons on scanned pages using safety rules and mode limits. */
  controlled_interaction_scan?: boolean;
  /** safe-auto = safe controls only; tester-selected = allowlist only; exhaustive = broader non-destructive exploration. */
  controlled_interaction_mode?: ControlledInteractionMode;
  /** Labels, URL fragments, or CSS selectors that are allowed in tester-selected mode. */
  controlled_interaction_allowlist?: string[];
  /** Maximum discovered interactions to attempt per page. */
  controlled_interaction_limit?: number;
  /** Browser-extension supplied cookies from the active tab so Playwright can scan that authenticated page. */
  extension_session_cookies?: ExtensionSessionCookie[];
  /** Fallback issue ownership routing when DOM data-owner/data-component is missing. */
  owner_fallback_rules?: OwnerFallbackRule[];
}

export type ProgressCallback = (progress: number, message: string) => void;
