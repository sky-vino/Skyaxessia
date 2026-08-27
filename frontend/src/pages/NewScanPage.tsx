/**
 * NewScanPage.tsx — ROUND 5n — SIMPLIFIED, Production-parity
 * -----------------------------------------------------------------------------
 * Same sections and same subcomponents as ProductionScanPage.tsx.
 * Only Stage-specific extras kept: Login URL field + OTP auto-scrape toggle.
 * Everything else that Production doesn't have (Advanced selectors, State
 * label, Link crawl, Owner fallback, Controlled interaction advanced settings)
 * has been REMOVED from the UI. Defaults for selectors live in code and are
 * sent transparently in the payload.
 *
 * Only functional difference from Production:
 *   Stage submits via scanApi.create (single-step: OTP auto-scraped by scanner).
 *   Production submits via authSessionApi.start (two-step: user enters OTP).
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { scanApi } from "../services/api";
import { motion } from "framer-motion";
import {
  AlertTriangle, KeyRound, ChevronLeft, ChevronDown, ChevronUp,
  Plus, Trash2, Loader2,
} from "lucide-react";

// -----------------------------------------------------------------------------
const AUTHENTICATED_PAGE_OPTIONS = ["Gestisci", "Offerte", "Profilo", "Impostazioni", "Fatture", "Scopri l'app My Sky"];
const JOURNEY_START_URL = "https://test.abbonamento.sky.it/home";

// Hardcoded shadow-DOM selectors — hidden from UI but sent in payload.
// These are Sky's Stage login markup structure. Only edit here if Sky changes it.
const HIDDEN_STAGE_DEFAULTS = {
  username_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-email')\n//input[@id='sky-login-email']\n#sky-login-email",
  password_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('div.sky-login-label-password login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-password')\n//input[@id='sky-login-password']\n#sky-login-password",
  submit_selector: "js=document.querySelector('sky-login-component#sky-login button.sky-login-submit[type=\"submit\"]')\n//button[@class='sky-login-submit']\n//button[contains(@class,'sky-login-submit')]\nbutton.sky-login-submit[type='submit']",
  otp_selector: "input.otp-input_otp-input__QvpEl\ninput[aria-label^='Please enter OTP character'], input[name*='otp' i], div[role='textbox'], [contenteditable='true']",
  otp_source_selector: "div.otp-verify-sms-content > p",
  otp_submit_selector: "js=document.querySelector(\"button.sky-button-primary[aria-label='Conferma']\")\n//button[normalize-space()='Conferma']\n//button[@aria-label='Conferma' and contains(@class,'sky-button-primary')]\nbutton.sky-button-primary[aria-label='Conferma']",
  cookie_accept_selector: "js=document.querySelector('#notice button.accbtn[aria-label=\"Accetta tutto\"]')\n//button[@title='Accetta tutto']\n//*[@id='notice']//button[@aria-label='Accetta tutto' or normalize-space()='Accetta tutto']",
};

type TargetJourneyStep = {
  action: "navigate-page" | "click";
  page: string; name: string; selector: string; text: string; cta_text: string;
  href_contains: string; click_type: "button" | "link" | "heading-link" | "any";
  scan_after_step: boolean;
};
type TargetInteraction = {
  base_page: string; mode: "single-interaction" | "journey"; name: string;
  selector: string; text: string; cta_text: string; href_contains: string;
  click_type: "button" | "link" | "heading-link" | "any";
  scan_destination_only: boolean; scan_launch_page: boolean;
  steps: TargetJourneyStep[];
};

function scanCreateErrorMessage(error: any) {
  const data = error?.response?.data;
  const fieldErrors = data?.details?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === "object") {
    const lines = Object.entries(fieldErrors)
      .flatMap(([field, messages]) => (Array.isArray(messages) ? messages : [messages]).map(message => `${field}: ${message}`))
      .filter(Boolean);
    if (lines.length) return `${data?.error || "Invalid scan input"} - ${lines.join("; ")}`;
  }
  if (data?.error) return data.error;
  if (error?.message) return error.message;
  return "Failed to create scan. Check that the backend is running and the scan configuration is valid.";
}

// =============================================================================
export default function NewScanPage() {
  if (typeof window !== "undefined" && !(window as any).__AXESSIA_STAGE_LOGGED) {
    console.log("[AXESSIA] Stage NewScanPage loaded");
    (window as any).__AXESSIA_STAGE_LOGGED = true;
  }
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [urls, setUrls] = useState<string[]>([""]);
  // ROUND 5t — user-editable Journey start URL (was hardcoded to JOURNEY_START_URL).
  const [journeyStartUrl, setJourneyStartUrl] = useState(JOURNEY_START_URL);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const [loginUrl, setLoginUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [homeUrl, setHomeUrl] = useState("https://test.abbonamento.sky.it/home");
  const [contractNumber, setContractNumber] = useState("");
  const [contractName, setContractName] = useState("");
  const [otpAutoScrape, setOtpAutoScrape] = useState(true);
  const [otpCode, setOtpCode] = useState("");
  const [autoAcceptCookies, setAutoAcceptCookies] = useState(true);

  const [opts, setOpts] = useState({
    run_axe: true, run_heuristics: true, run_focus: true, run_keyboard_nav: true,
    run_zoom: true, run_color: true, run_pointer: true, run_live_dom: true,
    run_states: true, run_dynamic: true, run_motion: true, run_reflow: true,
    capture_screenshots: true,
    zoom_target_percent: 200 as 200 | 400,
    suppress_advisory_rules: false,
    scan_depth_mode: "standard" as "shallow" | "standard" | "exhaustive",
    scan_entry_mode: "url" as "url" | "journey",
    scan_login_page: false,
    scan_post_login_landing: false,
    scan_gestisci_page: false,
    run_controlled_interaction: false,
  });
  const [targetInteractions, setTargetInteractions] = useState<TargetInteraction[]>([]);
  const journeyOnlyMode = opts.scan_entry_mode === "journey";

  const mutation = useMutation({
    mutationFn: (data: any) => scanApi.create(data),
    onSuccess: (res) => navigate(`/scans/${res.data.scan.id}`)
  });

  const addUrl = () => setUrls([...urls, ""]);
  const removeUrl = (i: number) => setUrls(urls.filter((_, j) => j !== i));
  const setUrl = (i: number, v: string) => { const u = [...urls]; u[i] = v; setUrls(u); };

  const addTargetInteraction = () => setTargetInteractions(prev => [...prev,
    { base_page: "Offerte", mode: "single-interaction", name: "", selector: "", text: "", cta_text: "", href_contains: "", click_type: "any", scan_destination_only: true, scan_launch_page: false, steps: [] }]);
  const updateTargetInteraction = (index: number, patch: Partial<TargetInteraction>) => {
    setTargetInteractions(prev => prev.map((t, i) => i === index ? { ...t, ...patch } : t));
  };
  const removeTargetInteraction = (index: number) => {
    setTargetInteractions(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const journeyTargets = targetInteractions
      .map(t => ({
        base_page: t.base_page.trim(),
        mode: "single-interaction" as const,
        name: (t.name || t.text || "").trim() || undefined,
        selector: undefined,
        text: t.text.trim() || undefined,
        cta_text: t.cta_text.trim() || undefined,
        href_contains: undefined,
        click_type: "any" as const,
        scan_destination_only: true,
        scan_launch_page: false,
        steps: [],
      }))
      .filter(t => t.base_page && (t.text || t.cta_text));

    const validUrls = journeyOnlyMode ? [journeyStartUrl.trim() || JOURNEY_START_URL] : urls.map(u => u.trim()).filter(Boolean);
    if (!journeyOnlyMode && !validUrls.length) return;
    if (journeyOnlyMode && !journeyTargets.length) return;

    // ROUND 5n — Payload always sends contract_number, contract_name, home_url
    // as strings (never undefined). Empty string = user left blank; missing
    // key = stale frontend. Backend can distinguish these.
    const authPayload = {
      login_url: loginUrl.trim(),
      username: username.trim(),
      password,
      // Hidden defaults for Sky's shadow-DOM login markup
      ...HIDDEN_STAGE_DEFAULTS,
      // OTP handling
      otp_from_page: otpAutoScrape,
      otp_code: otpCode.trim() || undefined,
      // Cookies
      auto_accept_cookies: autoAcceptCookies,
      // ALWAYS send these as strings (never undefined) — Round 5n
      home_url: homeUrl.trim() || "",
      contract_number: contractNumber.trim() || "",
      contract_name: contractName.trim() || "",
    };

    mutation.mutate({
      name: name || undefined,
      urls: validUrls,
      state_label: "default",
      // ROUND 5r — auth_config sent ONLY if user filled login_url.
      // Previous condition was `loginUrl OR homeUrl`, but homeUrl has a
      // default value, so authPayload was always sent even for public
      // scans with no credentials, causing backend Zod to reject empty
      // login_url as "invalid auth". Contract fields + home_url are
      // meaningful only inside an auth flow, so gating on login_url is
      // the right check.
      auth_config: loginUrl.trim() ? authPayload : undefined,
      scan_options: {
        ...opts,
        scan_post_login_landing: journeyOnlyMode ? false : opts.scan_post_login_landing,
        scan_gestisci_page: journeyOnlyMode ? false : opts.scan_gestisci_page,
        target_interactions: journeyOnlyMode ? journeyTargets : [],
      }
    });
  };

  const canSubmit = !mutation.isPending && (
    journeyOnlyMode
      ? targetInteractions.some(t => t.base_page && (t.text.trim() || t.cta_text.trim()))
      : urls.some(u => u.trim())
  );

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5 relative">
      <div className="fixed top-0 right-0 w-[500px] h-[500px] rounded-full opacity-[0.10] blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(224,0,98,0.5), transparent 60%)" }} />
      <div className="fixed bottom-0 left-0 w-[500px] h-[500px] rounded-full opacity-[0.10] blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(22,119,255,0.5), transparent 60%)" }} />

      <button
        onClick={() => navigate("/")}
        className="text-xs flex items-center gap-1 transition-colors relative z-10"
        style={{ color: "var(--muted)" }}
        onMouseEnter={(e) => e.currentTarget.style.color = "var(--text-strong)"}
        onMouseLeave={(e) => e.currentTarget.style.color = "var(--muted)"}
      >
        <ChevronLeft size={14} /> Back to Dashboard
      </button>

      {/* Header card */}
      <GradientCard delay={0}>
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--sky-gradient)", boxShadow: "0 8px 24px -6px rgba(176,24,216,0.35)" }}>
            <KeyRound size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--text-strong)", fontFamily: "'DM Sans', sans-serif" }}>
              Stage Accessibility Scan
            </h1>
            <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
              For Stage / test environments where the OTP is displayed on the login page and can be
              auto-scraped by the scanner. Fill the form once — no need to enter the OTP by hand.
            </p>
          </div>
        </div>
      </GradientCard>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* Card 1 — Login credentials */}
        <GradientCard delay={0.04}>
          <SectionHeader label="Login credentials" />
          <div className="space-y-5">
            <PremiumInput
              label="Login URL"
              hint="Sky login endpoint for the Stage environment. Leave blank if target URL triggers login redirect."
              value={loginUrl} onChange={setLoginUrl}
              placeholder="https://test-www.sky.it/login?clientID=WebSelfCare" type="url"
              focused={focusedField === "login_url"}
              onFocus={() => setFocusedField("login_url")} onBlur={() => setFocusedField(null)}
            />
            <PremiumInput
              label="Username / Email" value={username} onChange={setUsername}
              placeholder="user@example.com" type="text"
              focused={focusedField === "username"}
              onFocus={() => setFocusedField("username")} onBlur={() => setFocusedField(null)}
            />
            <PremiumInput
              label="Password" value={password} onChange={setPassword}
              placeholder="••••••••" type="password"
              focused={focusedField === "password"}
              onFocus={() => setFocusedField("password")} onBlur={() => setFocusedField(null)}
            />
            <PremiumInput
              label="Scan name (optional)" value={name} onChange={setName}
              placeholder={`Stage scan ${new Date().toLocaleDateString()}`} type="text"
              focused={focusedField === "scanname"}
              onFocus={() => setFocusedField("scanname")} onBlur={() => setFocusedField(null)}
            />

            {/* Home URL — REQUIRED for contract switch */}
            <PremiumInput
              label="Home URL (required)"
              hint="Auth flow lands here first. Sky reliably redirects unauthenticated users on /home to /login. Contract switching happens here — the double-arrow toggle only appears on this page."
              value={homeUrl} onChange={setHomeUrl}
              placeholder="https://test.abbonamento.sky.it/home" type="url"
              focused={focusedField === "home_url"}
              onFocus={() => setFocusedField("home_url")} onBlur={() => setFocusedField(null)}
            />

            {/* Multi-contract */}
            <div className="rounded-xl p-4 space-y-3"
              style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}>
              <div className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>Multi-contract account</div>
              <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                When the account has more than one contract, the scanner clicks the double-arrow toggle
                on the sidebar and picks the radio matching the contract number (or name) below.
                Number is exact; name is a fallback. Leave blank for single-contract accounts.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <PremiumInput
                  label="Contract number (recommended)"
                  value={contractNumber} onChange={setContractNumber}
                  placeholder="e.g. 10600970" type="text"
                  focused={focusedField === "contract_number"}
                  onFocus={() => setFocusedField("contract_number")} onBlur={() => setFocusedField(null)}
                />
                <PremiumInput
                  label="Contract name (optional)"
                  value={contractName} onChange={setContractName}
                  placeholder="e.g. Wifi + TV" type="text"
                  focused={focusedField === "contract_name"}
                  onFocus={() => setFocusedField("contract_name")} onBlur={() => setFocusedField(null)}
                />
              </div>
            </div>

            {/* OTP + cookies — Stage-specific toggles */}
            <div className="rounded-xl p-4 space-y-1"
              style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}>
              <PremiumToggle checked={autoAcceptCookies} onChange={setAutoAcceptCookies} label="Auto-accept cookie prompts" />
              <PremiumToggle checked={otpAutoScrape} onChange={setOtpAutoScrape} label="OTP auto-scrape from login page (Stage default)" />
              {!otpAutoScrape && (
                <div className="pt-3">
                  <PremiumInput label="OTP code" hint="Enter OTP for this scan (only when auto-scrape is off)."
                    value={otpCode} onChange={setOtpCode} placeholder="123456" type="text"
                    focused={focusedField === "otp_code"}
                    onFocus={() => setFocusedField("otp_code")} onBlur={() => setFocusedField(null)}
                  />
                </div>
              )}
            </div>
          </div>
        </GradientCard>

        {/* Card 2 — Scan entry */}
        <GradientCard delay={0.06}>
          <SectionHeader label="Scan entry" required />
          <div className="grid grid-cols-2 gap-3 mb-5">
            <ChoiceCard active={opts.scan_entry_mode === "url"} title="Scan target URL"
              subtitle="Use each URL as a page to scan."
              onClick={() => setOpts({ ...opts, scan_entry_mode: "url" })} />
            <ChoiceCard active={opts.scan_entry_mode === "journey"} title="Use journey configuration"
              subtitle="Hide target URL input; scan only configured target journeys."
              onClick={() => setOpts({ ...opts, scan_entry_mode: "journey" })} />
          </div>

          {!journeyOnlyMode && (
            <div className="space-y-3">
              <FieldLabel>Target URLs</FieldLabel>
              <div className="text-[11px] mb-2 leading-relaxed" style={{ color: "var(--muted)" }}>
                One or more pages to scan AFTER login and contract switch complete.
              </div>
              <div className="space-y-2">
                {urls.map((url, i) => (
                  <div key={i} className="flex gap-2">
                    <input type="url" required placeholder={`https://test.abbonamento.sky.it${i > 0 ? "/other-" + (i + 1) : "/offers"}`}
                      value={url} onChange={e => setUrl(i, e.target.value)}
                      className="flex-1 rounded-lg px-3 py-2.5 text-sm outline-none transition-all"
                      style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }}
                      onFocus={e => { (e.target as any).style.borderColor = "rgba(224,0,98,0.4)"; }}
                      onBlur={e => { (e.target as any).style.borderColor = "var(--border-strong)"; }} />
                    {urls.length > 1 && (
                      <button type="button" onClick={() => removeUrl(i)}
                        className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg transition-all"
                        style={{ color: "var(--muted)" }}
                        onMouseEnter={e => { (e.currentTarget as any).style.color = "#ff4d6d"; (e.currentTarget as any).style.background = "rgba(255,77,109,0.1)"; }}
                        onMouseLeave={e => { (e.currentTarget as any).style.color = "var(--muted)"; (e.currentTarget as any).style.background = "transparent"; }}
                        title="Remove URL">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
                {urls.length < 20 && (
                  <button type="button" onClick={addUrl}
                    className="flex items-center gap-1.5 text-xs transition-colors mt-2"
                    style={{ color: "var(--muted)" }}
                    onMouseEnter={e => { (e.currentTarget as any).style.color = "#E00062"; }}
                    onMouseLeave={e => { (e.currentTarget as any).style.color = "var(--muted)"; }}>
                    <Plus size={13} /> Add URL
                  </button>
                )}
              </div>
            </div>
          )}

          {journeyOnlyMode && (
            <div className="mt-3 space-y-3">
              {/* ROUND 5t — Journey start URL was hidden in journey mode, which
                  hardcoded it to /home. Now it's editable so users can set
                  their own start page per environment. Defaults to /home. */}
              <div>
                <FieldLabel>Journey start URL</FieldLabel>
                <input type="url" value={journeyStartUrl}
                  onChange={e => setJourneyStartUrl(e.target.value)}
                  placeholder="https://test.abbonamento.sky.it/home"
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-all"
                  style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }}
                  onFocus={e => { (e.target as any).style.borderColor = "rgba(224,0,98,0.4)"; }}
                  onBlur={e => { (e.target as any).style.borderColor = "var(--border-strong)"; }}
                />
                <div className="text-[10px] mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
                  This is where the scanner opens the browser first (auth + contract switch land here). Each target's "Launch page" below is a named tab reached from this URL after login.
                </div>
              </div>

              <div className="rounded-xl p-4 space-y-3"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)" }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>Targeted destination interactions</h3>
                  <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>
                    Configure a promo/link click. Scanner navigates to the launch page, finds the card, clicks the button, then scans the resulting page.
                  </p>
                </div>
                <button type="button" onClick={addTargetInteraction}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-all font-semibold"
                  style={{ background: "var(--sky-gradient)", color: "white", boxShadow: "0 4px 12px -2px rgba(176,24,216,0.35)" }}>
                  <Plus size={13} /> Add target
                </button>
              </div>
              {targetInteractions.length === 0 && (
                <div className="text-[11px] rounded-lg p-3 text-center"
                  style={{ background: "var(--soft)", color: "var(--muted)", border: "1px dashed var(--border-strong)" }}>
                  No targets configured yet. Click "Add target" to configure at least one.
                </div>
              )}
              {targetInteractions.length > 0 && (
                <div className="space-y-3">
                  {targetInteractions.map((target, index) => (
                    <div key={index} className="rounded-lg p-3 space-y-3"
                      style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold" style={{ color: "var(--muted-strong)" }}>Target #{index + 1}</span>
                        <button type="button" onClick={() => removeTargetInteraction(index)}
                          className="w-8 h-8 inline-flex items-center justify-center rounded-lg transition-colors"
                          style={{ color: "var(--muted)" }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div className="rounded-lg p-3 space-y-3" style={{ background: "rgba(225,14,86,0.05)", border: "1px solid rgba(225,14,86,0.20)" }}>
                        <div>
                          <label className="block text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>Launch page</label>
                          <select value={target.base_page} onChange={e => updateTargetInteraction(index, { base_page: e.target.value })}
                            style={{ padding: "8px 12px", borderRadius: 8, width: "100%", fontSize: 13, border: "1px solid var(--border-strong)", outline: "none", background: "var(--input-bg)", color: "var(--text-strong)" }}>
                            {AUTHENTICATED_PAGE_OPTIONS.map(label => <option key={label} value={label}>{label}</option>)}
                          </select>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>Card / section text</label>
                            <input value={target.text} onChange={e => updateTargetInteraction(index, { text: e.target.value })}
                              placeholder="Paramount+"
                              style={{ padding: "8px 12px", borderRadius: 8, width: "100%", fontSize: 13, border: "1px solid var(--border-strong)", outline: "none", background: "var(--input-bg)", color: "var(--text-strong)" }} />
                          </div>
                          <div>
                            <label className="block text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>Button / link text</label>
                            <input value={target.cta_text} onChange={e => updateTargetInteraction(index, { cta_text: e.target.value })}
                              placeholder="Scopri di più"
                              style={{ padding: "8px 12px", borderRadius: 8, width: "100%", fontSize: 13, border: "1px solid var(--border-strong)", outline: "none", background: "var(--input-bg)", color: "var(--text-strong)" }} />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
          )}
        </GradientCard>

        {/* Card 3 — Authenticated page scan scope */}
        <GradientCard delay={0.08}>
          <SectionHeader label="Authenticated page scan scope" />
          <div className="space-y-1">
            <PremiumToggle checked={opts.scan_login_page} onChange={v => setOpts({ ...opts, scan_login_page: v })}
              label="Scan login page before entering credentials" />
            <PremiumToggle checked={opts.scan_post_login_landing} onChange={v => setOpts({ ...opts, scan_post_login_landing: v })}
              label="Scan page immediately after OTP login" />
            <PremiumToggle checked={opts.scan_gestisci_page} onChange={v => setOpts({ ...opts, scan_gestisci_page: v })}
              label="Scan Gestisci / profile page" />
          </div>
          <div className="mt-3 text-[10px] leading-relaxed" style={{ color: "var(--muted)" }}>
            When these are off, the scanner may still use login or Gestisci for authentication / navigation,
            but it will not run accessibility modules on those pages.
          </div>
        </GradientCard>

        {/* Card 4 — Scan Modules */}
        <GradientCard delay={0.10}>
          <SectionHeader label="Scan Modules" />
          <div className="grid grid-cols-3 gap-3 mb-5">
            {([
              ["shallow", "Shallow", "Fast: minimal state expansion"],
              ["standard", "Standard", "Balanced sampled state matrix"],
              ["exhaustive", "Exhaustive", "Deeper interactions and more evidence"],
            ] as const).map(([value, label, description]) => (
              <ChoiceCard key={value} active={opts.scan_depth_mode === value}
                title={label} subtitle={description}
                onClick={() => setOpts({ ...opts, scan_depth_mode: value })} />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <PremiumToggle checked={opts.run_axe} onChange={v => setOpts({ ...opts, run_axe: v })} label="axe-core WCAG (recommended)" />
            <PremiumToggle checked={opts.run_heuristics} onChange={v => setOpts({ ...opts, run_heuristics: v })} label="Heuristic Checks" />
            <PremiumToggle checked={opts.run_focus} onChange={v => setOpts({ ...opts, run_focus: v })} label="Focus Visibility & Traps" />
            <PremiumToggle checked={opts.run_keyboard_nav} onChange={v => setOpts({ ...opts, run_keyboard_nav: v })} label="Keyboard Navigation" />
            <PremiumToggle checked={opts.run_zoom} onChange={v => setOpts({ ...opts, run_zoom: v })} label="Zoom & Resize Checks" />
            <PremiumToggle checked={opts.run_color} onChange={v => setOpts({ ...opts, run_color: v })} label="Color & Contrast" />
            <PremiumToggle checked={opts.run_pointer} onChange={v => setOpts({ ...opts, run_pointer: v })} label="Pointer & Gestures" />
            <PremiumToggle checked={opts.run_live_dom} onChange={v => setOpts({ ...opts, run_live_dom: v })} label="Live DOM / A11y Tree" />
            <PremiumToggle checked={opts.run_states} onChange={v => setOpts({ ...opts, run_states: v })} label="Multi-State Testing" />
            <PremiumToggle checked={opts.run_dynamic} onChange={v => setOpts({ ...opts, run_dynamic: v })} label="Dynamic Interactions" />
            <PremiumToggle checked={opts.run_motion} onChange={v => setOpts({ ...opts, run_motion: v })} label="Motion / Animation" />
            <PremiumToggle checked={opts.run_reflow} onChange={v => setOpts({ ...opts, run_reflow: v })} label="Reflow (320px / 400% Zoom)" />
          </div>

          <Divider />
          <PremiumToggle checked={opts.capture_screenshots} onChange={v => setOpts({ ...opts, capture_screenshots: v })} label="Capture screenshots" />

          <Divider />
          <FieldLabel>Zoom / reflow audit target</FieldLabel>
          <div className="grid grid-cols-2 gap-3">
            <ChoiceCard active={opts.zoom_target_percent === 200}
              title="AA-lite (200% only)"
              subtitle="Matches this team's audit scenario. Skips 320px reflow."
              onClick={() => setOpts({ ...opts, zoom_target_percent: 200 })} />
            <ChoiceCard active={opts.zoom_target_percent === 400}
              title="WCAG AA (400%)"
              subtitle="Tests 200%/300% intermediate breakpoints AND 320px reflow (WCAG 1.4.10)."
              onClick={() => setOpts({ ...opts, zoom_target_percent: 400 })} />
          </div>

          <Divider />
          <PremiumToggle checked={opts.suppress_advisory_rules}
            onChange={v => setOpts({ ...opts, suppress_advisory_rules: v })}
            label="Suppress advisory / best-practice rules (font size, target-size-enhanced, motion, gestures)" />

          <Divider />
          <PremiumToggle checked={opts.run_controlled_interaction}
            onChange={v => setOpts({ ...opts, run_controlled_interaction: v })}
            label="Controlled interaction scan for links, buttons, popups, and in-page changes" />
        </GradientCard>

        {mutation.isError && (
          <div className="p-4 rounded-xl text-xs flex items-start gap-3"
            style={{ background: "rgba(255,77,109,0.08)", color: "#ff6b8b", border: "1px solid rgba(255,77,109,0.25)" }}>
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <div>{scanCreateErrorMessage(mutation.error)}</div>
          </div>
        )}

        <button type="submit" disabled={!canSubmit}
          className={canSubmit ? "sky-primary relative w-full py-4 rounded-xl font-semibold text-sm text-white transition-all overflow-hidden" : "relative w-full py-4 rounded-xl font-semibold text-sm transition-all overflow-hidden"}
          style={canSubmit ? { boxShadow: "0 8px 20px rgba(176, 24, 216, 0.18)" } : {
            background: "var(--surface-3)", color: "var(--muted)", cursor: "not-allowed", opacity: 0.6,
          }}>
          {mutation.isPending ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Launching scan…
            </span>
          ) : "Launch Accessibility Scan"}
        </button>
      </form>
    </div>
  );
}

// =============================================================================
// Subcomponents (identical to ProductionScanPage.tsx)
// =============================================================================
function GradientCard({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-2xl overflow-hidden"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}>
      <div className="absolute top-0 left-0 right-0 h-[2px]" style={{ background: "var(--sky-gradient)" }} />
      <div className="p-6">{children}</div>
    </motion.div>
  );
}

function SectionHeader({ label, required }: { label: string; required?: boolean }) {
  return (
    <div className="flex items-center gap-2 mb-5">
      <div className="w-1 h-4 rounded-full" style={{ background: "var(--sky-gradient)" }} />
      <h2 className="text-sm font-semibold tracking-wide" style={{ color: "var(--text-strong)", fontFamily: "'DM Sans', sans-serif" }}>
        {label}
        {required && <span className="ml-1" style={{ color: "var(--sky-pink)" }}>*</span>}
      </h2>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--muted-strong)" }}>
      {children}
    </label>
  );
}

function Divider() {
  return <div className="my-4 h-px" style={{ background: "var(--border)" }} />;
}

function PremiumInput({
  label, hint, value, onChange, placeholder, type = "text", autoComplete,
  focused, onFocus, onBlur,
}: {
  label: string; hint?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; autoComplete?: string;
  focused: boolean; onFocus: () => void; onBlur: () => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative rounded-xl p-[1.5px] transition-all"
        style={{
          background: focused ? "var(--sky-pink)" : "var(--border-strong)",
          boxShadow: focused ? "0 0 0 3px rgba(224, 0, 98, 0.10)" : "none",
        }}>
        <input type={type} value={value} onChange={e => onChange(e.target.value)}
          onFocus={onFocus} onBlur={onBlur} placeholder={placeholder} autoComplete={autoComplete}
          className="w-full px-4 py-3.5 rounded-[10px] text-sm outline-none border-0"
          style={{ background: "var(--input-bg)", color: "var(--text-strong)" }} />
      </div>
      {hint && <div className="text-[10px] mt-2 ml-1 leading-relaxed" style={{ color: "var(--muted)" }}>{hint}</div>}
    </div>
  );
}

function ChoiceCard({
  active, title, subtitle, onClick,
}: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="text-left rounded-xl p-4 transition-all relative overflow-hidden"
      style={{
        background: active ? "rgba(224, 0, 98, 0.06)" : "var(--surface-2)",
        border: active ? "1.5px solid var(--sky-pink)" : "1.5px solid var(--border-strong)",
        boxShadow: active ? "0 0 0 3px rgba(224, 0, 98, 0.08)" : "none",
      }}>
      <div className="text-sm font-semibold mb-1" style={{ color: active ? "var(--sky-pink)" : "var(--text-strong)" }}>{title}</div>
      <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>{subtitle}</div>
    </button>
  );
}

function PremiumToggle({
  checked, onChange, label,
}: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 py-2 cursor-pointer group">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className="w-11 h-6 rounded-full flex-shrink-0 relative transition-all"
        style={{
          background: checked ? "var(--sky-gradient)" : "var(--surface-3)",
          boxShadow: checked ? "0 4px 12px -2px rgba(176,24,216,0.35)" : "none",
        }}>
        <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
          style={{ left: checked ? "22px" : "2px", boxShadow: "0 2px 4px rgba(0,0,0,0.2)" }} />
      </button>
      <span className="text-xs transition-colors" style={{ color: "var(--text)" }}>{label}</span>
    </label>
  );
}
