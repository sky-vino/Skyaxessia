import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { scanApi } from "../services/api";
import { motion } from "framer-motion";
import { Plus, Trash2, ChevronDown, ChevronUp, ArrowLeft, Loader2, Shield } from "lucide-react";

const AUTHENTICATED_PAGE_OPTIONS = [
  "Gestisci",
  "Offerte",
  "Profilo",
  "Impostazioni",
  "Fatture",
  "Scopri l'app My Sky",
];
const JOURNEY_START_URL = "https://test.abbonamento.sky.it/home";

type TargetJourneyStep = {
  action: "navigate-page" | "click";
  page: string;
  name: string;
  selector: string;
  text: string;
  cta_text: string;
  href_contains: string;
  click_type: "button" | "link" | "heading-link" | "any";
  scan_after_step: boolean;
};

type TargetInteraction = {
  base_page: string;
  mode: "single-interaction" | "journey";
  name: string;
  selector: string;
  text: string;
  cta_text: string;
  href_contains: string;
  click_type: "button" | "link" | "heading-link" | "any";
  scan_destination_only: boolean;
  scan_launch_page: boolean;
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-accent" : "bg-white/10"}`}
        style={{ boxShadow: checked ? "0 0 10px rgba(15,118,110,0.3)" : "" }}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </div>
      <span className="text-sm text-slate-400">{label}</span>
    </label>
  );
}

export default function NewScanPage() {
  const navigate = useNavigate();
  const [urls, setUrls] = useState([""]);
  const [name, setName] = useState("");
  const [stateLabel, setStateLabel] = useState("default");
  const [showAuth, setShowAuth] = useState(false);
  const [auth, setAuth] = useState({
    login_url: "",
    username_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-email')\n//input[@id='sky-login-email']\n#sky-login-email",
    password_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('div.sky-login-label-password login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-password')\n//input[@id='sky-login-password']\n#sky-login-password",
    submit_selector: "js=document.querySelector('sky-login-component#sky-login button.sky-login-submit[type=\"submit\"]')\n//button[@class='sky-login-submit']\n//button[contains(@class,'sky-login-submit')]\nbutton.sky-login-submit[type='submit']",
    username: "",
    password: "",
    otp_from_page: true,
    otp_selector: "input.otp-input_otp-input__QvpEl\ninput[aria-label^='Please enter OTP character'], input[name*='otp' i], div[role='textbox'], [contenteditable='true']",
    otp_source_selector: "div.otp-verify-sms-content > p",
    otp_code: "",
    otp_submit_selector: "js=document.querySelector(\"button.sky-button-primary[aria-label='Conferma']\")\n//button[normalize-space()='Conferma']\n//button[@aria-label='Conferma' and contains(@class,'sky-button-primary')]\nbutton.sky-button-primary[aria-label='Conferma']",
    auto_accept_cookies: true,
    cookie_accept_selector: "js=document.querySelector('#notice button.accbtn[aria-label=\"Accetta tutto\"]')\n//button[@title='Accetta tutto']\n//*[@id='notice']//button[@aria-label='Accetta tutto' or normalize-space()='Accetta tutto']",
    profile_url: "",
  });
  const [opts, setOpts] = useState({
    run_axe: true, run_heuristics: true, run_focus: true, run_keyboard_nav: true,
    run_zoom: true, run_color: true, run_pointer: true, run_live_dom: true,
    run_states: true, run_dynamic: true, run_motion: true, run_reflow: true,
    capture_screenshots: true,
    scan_depth_mode: "standard",
    scan_entry_mode: "url",
    crawl_mode: false,
    crawl_depth: 2,
    crawl_same_domain: true,
    crawl_max_pages: 30,
    scan_login_page: false,
    scan_post_login_landing: false,
    scan_gestisci_page: false,
    post_login_tab_scan: true,
    post_login_tab_limit: 12,
    post_login_pages: [],
    controlled_interaction_scan: false,
    controlled_interaction_mode: "safe-auto",
    controlled_interaction_limit: 12,
  });
  const [crawlIncludeText, setCrawlIncludeText] = useState("");
  const [crawlExcludeText, setCrawlExcludeText] = useState("");
  const [controlledAllowlistText, setControlledAllowlistText] = useState("");
  const [ownerFallbackText, setOwnerFallbackText] = useState("");
  const [targetInteractions, setTargetInteractions] = useState<TargetInteraction[]>([]);
  const journeyOnlyMode = opts.scan_entry_mode === "journey";

  const mutation = useMutation({
    mutationFn: (data: any) => scanApi.create(data),
    onSuccess: (res) => navigate(`/scans/${res.data.scan.id}`)
  });

  const addUrl = () => setUrls([...urls, ""]);
  const removeUrl = (i: number) => setUrls(urls.filter((_, j) => j !== i));
  const setUrl = (i: number, v: string) => { const u = [...urls]; u[i] = v; setUrls(u); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const journeyTargets = targetInteractions
      .map(target => ({
        base_page: target.base_page.trim(),
        mode: target.mode,
        name: target.name.trim() || undefined,
        selector: target.selector.trim() || undefined,
        text: target.text.trim() || undefined,
        cta_text: target.cta_text.trim() || undefined,
        href_contains: target.href_contains.trim() || undefined,
        click_type: target.click_type,
        scan_destination_only: target.scan_destination_only,
        scan_launch_page: target.scan_launch_page,
        steps: target.steps
          .map(step => ({
            action: step.action,
            page: step.page.trim() || undefined,
            name: step.name.trim() || undefined,
            selector: step.selector.trim() || undefined,
            text: step.text.trim() || undefined,
            cta_text: step.cta_text.trim() || undefined,
            href_contains: step.href_contains.trim() || undefined,
            click_type: step.click_type,
            scan_after_step: step.scan_after_step,
          }))
          .filter(step => step.action === "navigate-page" ? Boolean(step.page) : Boolean(step.selector || step.text || step.cta_text || step.href_contains)),
      }))
      .filter(target => target.base_page && (target.mode === "journey" ? target.steps.length > 0 : (target.selector || target.text || target.cta_text || target.href_contains)));
    const validUrls = journeyOnlyMode ? [JOURNEY_START_URL] : urls.map(u => u.trim()).filter(Boolean);
    if (!journeyOnlyMode && !validUrls.length) return;
    if (journeyOnlyMode && !journeyTargets.length) return;
    const splitPatterns = (s: string) =>
      s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean).slice(0, 30);
    const ownerFallbackRules = ownerFallbackText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [pattern, owner, component, match] = line.split("|").map(part => part.trim());
        return pattern && owner ? { pattern, owner, component: component || undefined, match: (match as any) || "any" } : null;
      })
      .filter(Boolean)
      .slice(0, 80);
    const authPayload = {
      ...auth,
      login_url: auth.login_url.trim(),
      username_selector: auth.username_selector.trim(),
      password_selector: auth.password_selector.trim(),
      submit_selector: auth.submit_selector.trim(),
      otp_selector: auth.otp_selector?.trim() || undefined,
      otp_source_selector: auth.otp_source_selector?.trim() || undefined,
      otp_submit_selector: auth.otp_submit_selector?.trim() || undefined,
      profile_url: auth.profile_url?.trim() || undefined,
      otp_code: auth.otp_code?.trim() || undefined,
    };
    mutation.mutate({
      name: name || undefined,
      urls: validUrls,
      state_label: stateLabel,
      auth_config: showAuth && auth.login_url ? authPayload : undefined,
      scan_options: {
        ...opts,
        crawl_mode: journeyOnlyMode ? false : opts.crawl_mode,
        scan_post_login_landing: journeyOnlyMode ? false : opts.scan_post_login_landing,
        scan_gestisci_page: journeyOnlyMode ? false : opts.scan_gestisci_page,
        crawl_depth: Math.max(0, Math.min(10, Number(opts.crawl_depth) || 0)),
        crawl_max_pages: Math.max(1, Math.min(200, Number(opts.crawl_max_pages) || 30)),
        crawl_include_patterns: splitPatterns(crawlIncludeText),
        crawl_exclude_patterns: splitPatterns(crawlExcludeText),
        controlled_interaction_allowlist: splitPatterns(controlledAllowlistText),
        owner_fallback_rules: ownerFallbackRules,
        post_login_pages: [],
        target_interactions: journeyOnlyMode ? journeyTargets : [],
      }
    });
  };


  const addTargetInteraction = () => setTargetInteractions(current => [
    ...current,
    { base_page: "Offerte", mode: "single-interaction", name: "", selector: "", text: "", cta_text: "", href_contains: "", click_type: "button", scan_destination_only: true, scan_launch_page: false, steps: [] }
  ]);

  const updateTargetInteraction = (index: number, patch: Partial<TargetInteraction>) => {
    setTargetInteractions(current => current.map((target, i) => i === index ? { ...target, ...patch } : target));
  };

  const removeTargetInteraction = (index: number) => {
    setTargetInteractions(current => current.filter((_, i) => i !== index));
  };

  const addJourneyStep = (targetIndex: number) => {
    setTargetInteractions(current => current.map((target, i) => i === targetIndex ? {
      ...target,
      mode: "journey",
      steps: [
        ...target.steps,
        { action: "click", page: "", name: "", selector: "", text: "", cta_text: "", href_contains: "", click_type: "any", scan_after_step: false }
      ]
    } : target));
  };

  const updateJourneyStep = (targetIndex: number, stepIndex: number, patch: Partial<TargetJourneyStep>) => {
    setTargetInteractions(current => current.map((target, i) => i === targetIndex ? {
      ...target,
      steps: target.steps.map((step, j) => j === stepIndex ? { ...step, ...patch } : step)
    } : target));
  };

  const removeJourneyStep = (targetIndex: number, stepIndex: number) => {
    setTargetInteractions(current => current.map((target, i) => i === targetIndex ? {
      ...target,
      steps: target.steps.filter((_, j) => j !== stepIndex)
    } : target));
  };

  const inputStyle = {
    background: "var(--input-bg)",
    border: "1px solid var(--border-strong)",
    color: "var(--text)",
    borderRadius: "8px",
    fontSize: "14px",
    padding: "10px 14px",
    width: "100%",
    outline: "none",
    transition: "border-color 0.2s"
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <button onClick={() => navigate("/")} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 mb-6 transition-colors">
        <ArrowLeft size={14} /> Back to Dashboard
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-100">New Accessibility Scan</h1>
        <p className="text-sm text-slate-500 mt-1">Configure and launch a comprehensive WCAG audit</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Scan Details</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">Scan Name (optional)</label>
              <input style={inputStyle} placeholder="e.g. Homepage Q2 Audit" value={name} onChange={e => setName(e.target.value)}
                onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">State Label</label>
              <input style={inputStyle} placeholder="default / authenticated / expanded" value={stateLabel}
                onChange={e => setStateLabel(e.target.value)}
                onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
            </div>
          </div>
        </motion.div>

        {/* Scan entry */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Scan entry <span className="text-accent text-xs ml-1">*</span></h2>
          <div className="mb-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <button
              type="button"
              onClick={() => setOpts({ ...opts, scan_entry_mode: "url" })}
              className={`text-left rounded-xl px-4 py-3 border transition-all ${opts.scan_entry_mode === "url" ? "text-accent" : "text-slate-400 hover:text-slate-200"}`}
              style={{ background: opts.scan_entry_mode === "url" ? "rgba(15,118,110,0.08)" : "rgba(255,255,255,0.025)", borderColor: opts.scan_entry_mode === "url" ? "rgba(15,118,110,0.45)" : "var(--border)" }}
            >
              <div className="text-sm font-semibold">Scan target URL</div>
              <div className="text-[11px] text-slate-600 mt-1">Use each URL as a page to scan.</div>
            </button>
            <button
              type="button"
              onClick={() => setOpts({ ...opts, scan_entry_mode: "journey", crawl_mode: false, scan_post_login_landing: false, scan_gestisci_page: false })}
              className={`text-left rounded-xl px-4 py-3 border transition-all ${journeyOnlyMode ? "text-accent" : "text-slate-400 hover:text-slate-200"}`}
              style={{ background: journeyOnlyMode ? "rgba(15,118,110,0.08)" : "rgba(255,255,255,0.025)", borderColor: journeyOnlyMode ? "rgba(15,118,110,0.45)" : "var(--border)" }}
            >
              <div className="text-sm font-semibold">Use journey configuration</div>
              <div className="text-[11px] text-slate-600 mt-1">Hide target URL input; scan only configured target journeys.</div>
            </button>
          </div>
          {journeyOnlyMode && (
            <div className="mb-4 rounded-lg px-3 py-2 text-xs text-slate-400" style={{ background: "rgba(15,118,110,0.08)", border: "1px solid rgba(15,118,110,0.25)" }}>
              Journey mapping mode disables target URL entry and uses an internal authenticated start page only for login/navigation. Add at least one target journey below.
            </div>
          )}
          {!journeyOnlyMode && (
            <div className="space-y-2">
              {urls.map((url, i) => (
                <div key={i} className="flex gap-2">
                  <input type="url" style={inputStyle} required placeholder={`https://example.com${i > 0 ? "/page-" + (i + 1) : ""}`}
                    value={url} onChange={e => setUrl(i, e.target.value)}
                    onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                    onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
                  {urls.length > 1 && (
                    <button type="button" onClick={() => removeUrl(i)}
                      className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition-all">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {urls.length < 20 && (
                <button type="button" onClick={addUrl}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-accent transition-colors mt-2">
                  <Plus size={13} /> Add URL
                </button>
              )}
            </div>
          )}
          {journeyOnlyMode && (
          <div className="rounded-xl p-4 space-y-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-300">Targeted destination interactions</h3>
                <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                  Use this when a selected page is only a launch point. Configure a single promo/link click, or a deterministic multi-step journey. Crawling remains separate and runs only when enabled.
                </p>
              </div>
              <button type="button" onClick={addTargetInteraction}
                className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border text-accent hover:bg-white/[0.03]"
                style={{ borderColor: "rgba(15,118,110,0.35)" }}>
                <Plus size={13} /> Add target / journey
              </button>
            </div>

            {targetInteractions.length > 0 && (
              <div className="space-y-3">
                {targetInteractions.map((target, index) => (
                  <div key={index} className="rounded-lg p-3 space-y-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold text-slate-400">Target #{index + 1}</span>
                      <button type="button" onClick={() => removeTargetInteraction(index)}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10">
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1.5">Target mode</label>
                        <select style={inputStyle} value={target.mode} onChange={e => updateTargetInteraction(index, { mode: e.target.value as TargetInteraction["mode"] })}>
                          <option value="single-interaction">Single promo/link click</option>
                          <option value="journey">Multi-step journey</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1.5">Launch page</label>
                        <select style={inputStyle} value={target.base_page} onChange={e => updateTargetInteraction(index, { base_page: e.target.value })}>
                          {AUTHENTICATED_PAGE_OPTIONS.map(label => <option key={label} value={label}>{label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1.5">Target / journey name</label>
                        <input style={inputStyle} placeholder="e.g. Netflix Standard offer"
                          value={target.name} onChange={e => updateTargetInteraction(index, { name: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1.5">Click type</label>
                        <select style={inputStyle} value={target.click_type} onChange={e => updateTargetInteraction(index, { click_type: e.target.value as TargetInteraction["click_type"] })}>
                          <option value="button">Button / CTA</option>
                          <option value="link">Link</option>
                          <option value="heading-link">Heading/title link</option>
                          <option value="any">Any interactive element</option>
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1.5">Visible text / accessible name</label>
                        <input style={inputStyle} placeholder="e.g. Netflix Standard"
                          value={target.text} onChange={e => updateTargetInteraction(index, { text: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1.5">CTA text inside card</label>
                        <input style={inputStyle} placeholder="e.g. Scopri di piu"
                          value={target.cta_text} onChange={e => updateTargetInteraction(index, { cta_text: e.target.value })} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1.5">Href contains</label>
                        <input style={inputStyle} placeholder="e.g. sky-wifi or /offerte/"
                          value={target.href_contains} onChange={e => updateTargetInteraction(index, { href_contains: e.target.value })} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1.5">Selector fallback</label>
                      <textarea rows={2} style={{ ...inputStyle, minHeight: 58, resize: "vertical" }}
                        placeholder={"Optional. CSS, XPath, or js= selector for the exact card/link/button."}
                        value={target.selector} onChange={e => updateTargetInteraction(index, { selector: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      <Toggle checked={target.scan_destination_only}
                        onChange={v => updateTargetInteraction(index, { scan_destination_only: v })}
                        label="Use launch page only for navigation; scan the destination/final target" />
                      <Toggle checked={target.scan_launch_page}
                        onChange={v => updateTargetInteraction(index, { scan_launch_page: v })}
                        label="Also scan the launch page before executing this target" />
                    </div>
                    {target.mode === "journey" && (
                      <div className="rounded-lg p-3 space-y-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <h4 className="text-xs font-semibold text-slate-300">Journey steps</h4>
                            <p className="text-[11px] text-slate-600 mt-1">Use navigation steps for known pages and click steps for links/buttons. Enable scan on the final step, or leave all off to scan the final page automatically.</p>
                          </div>
                          <button type="button" onClick={() => addJourneyStep(index)}
                            className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border text-accent hover:bg-white/[0.03]"
                            style={{ borderColor: "rgba(15,118,110,0.35)" }}>
                            <Plus size={13} /> Add step
                          </button>
                        </div>
                        {target.steps.map((step, stepIndex) => (
                          <div key={stepIndex} className="rounded-lg p-3 space-y-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-semibold text-slate-500">Step #{stepIndex + 1}</span>
                              <button type="button" onClick={() => removeJourneyStep(index, stepIndex)}
                                className="w-7 h-7 inline-flex items-center justify-center rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10">
                                <Trash2 size={12} />
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs text-slate-500 mb-1.5">Action</label>
                                <select style={inputStyle} value={step.action} onChange={e => updateJourneyStep(index, stepIndex, { action: e.target.value as TargetJourneyStep["action"] })}>
                                  <option value="navigate-page">Navigate known page</option>
                                  <option value="click">Click link/button</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs text-slate-500 mb-1.5">Step name</label>
                                <input style={inputStyle} placeholder="Optional label" value={step.name} onChange={e => updateJourneyStep(index, stepIndex, { name: e.target.value })} />
                              </div>
                            </div>
                            {step.action === "navigate-page" ? (
                              <div>
                                <label className="block text-xs text-slate-500 mb-1.5">Page</label>
                                <select style={inputStyle} value={step.page} onChange={e => updateJourneyStep(index, stepIndex, { page: e.target.value })}>
                                  <option value="">Select page</option>
                                  {AUTHENTICATED_PAGE_OPTIONS.map(label => <option key={label} value={label}>{label}</option>)}
                                </select>
                              </div>
                            ) : (
                              <>
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-xs text-slate-500 mb-1.5">Container / visible text</label>
                                    <input style={inputStyle} placeholder="e.g. Dispositivi e protezioni" value={step.text} onChange={e => updateJourneyStep(index, stepIndex, { text: e.target.value })} />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-slate-500 mb-1.5">CTA text</label>
                                    <input style={inputStyle} placeholder="Optional button text" value={step.cta_text} onChange={e => updateJourneyStep(index, stepIndex, { cta_text: e.target.value })} />
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="block text-xs text-slate-500 mb-1.5">Href contains</label>
                                    <input style={inputStyle} placeholder="Optional URL fragment" value={step.href_contains} onChange={e => updateJourneyStep(index, stepIndex, { href_contains: e.target.value })} />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-slate-500 mb-1.5">Click type</label>
                                    <select style={inputStyle} value={step.click_type} onChange={e => updateJourneyStep(index, stepIndex, { click_type: e.target.value as TargetJourneyStep["click_type"] })}>
                                      <option value="any">Any interactive element</option>
                                      <option value="button">Button / CTA</option>
                                      <option value="link">Link</option>
                                      <option value="heading-link">Heading/title link</option>
                                    </select>
                                  </div>
                                </div>
                                <div>
                                  <label className="block text-xs text-slate-500 mb-1.5">Selector fallback</label>
                                  <textarea rows={2} style={{ ...inputStyle, minHeight: 54, resize: "vertical" }} value={step.selector} onChange={e => updateJourneyStep(index, stepIndex, { selector: e.target.value })} />
                                </div>
                              </>
                            )}
                            <Toggle checked={step.scan_after_step} onChange={v => updateJourneyStep(index, stepIndex, { scan_after_step: v })} label="Scan the page/state reached after this step" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
        </motion.div>

        {/* Crawl (post-login discovery) */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-1">Link crawl</h2>
          <p className="text-xs text-slate-600 mb-4 leading-relaxed">
            After login (if configured), discover same-site links from each target URL and scan additional pages automatically. Depth counts link hops from each seed.
          </p>
          <Toggle checked={opts.crawl_mode} onChange={v => setOpts({ ...opts, crawl_mode: v })} label="Enable crawl mode" />
          {opts.crawl_mode && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Max link hops from seed</label>
                  <input type="number" min={0} max={10} style={inputStyle}
                    value={opts.crawl_depth}
                    onChange={e => setOpts({ ...opts, crawl_depth: Number(e.target.value) })}
                    onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                    onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Max pages per seed</label>
                  <input type="number" min={1} max={200} style={inputStyle}
                    value={opts.crawl_max_pages}
                    onChange={e => setOpts({ ...opts, crawl_max_pages: Number(e.target.value) })}
                    onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                    onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
                </div>
              </div>
              <Toggle checked={opts.crawl_same_domain} onChange={v => setOpts({ ...opts, crawl_same_domain: v })} label="Same hostname only (recommended)" />
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Include URL patterns (optional)</label>
                <textarea rows={2} style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
                  placeholder={"One per line or comma-separated. Substring match, or use * as wildcard.\nExample: https://example.com/app/*"}
                  value={crawlIncludeText} onChange={e => setCrawlIncludeText(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Exclude URL patterns (optional)</label>
                <textarea rows={2} style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
                  placeholder={"e.g. */logout*, */api/*"}
                  value={crawlExcludeText} onChange={e => setCrawlExcludeText(e.target.value)} />
              </div>
            </div>
          )}
        </motion.div>

        {/* Scan Options */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Scan Modules</h2>
          <div className="mb-4 grid grid-cols-3 gap-2">
            {[
              ["shallow", "Shallow", "Fast: minimal state expansion"],
              ["standard", "Standard", "Balanced sampled state matrix"],
              ["exhaustive", "Exhaustive", "Deeper interactions and more evidence"],
            ].map(([value, label, description]) => (
              <button
                key={value}
                type="button"
                onClick={() => setOpts({ ...opts, scan_depth_mode: value })}
                className={`text-left rounded-xl px-3 py-2 border transition-all ${(opts as any).scan_depth_mode === value ? "text-accent" : "text-slate-400 hover:text-slate-200"}`}
                style={{ background: (opts as any).scan_depth_mode === value ? "rgba(15,118,110,0.08)" : "rgba(255,255,255,0.025)", borderColor: (opts as any).scan_depth_mode === value ? "rgba(15,118,110,0.45)" : "var(--border)" }}
              >
                <div className="text-xs font-semibold">{label}</div>
                <div className="text-[10px] text-slate-600 mt-1">{description}</div>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries({
              run_axe: "axe-core WCAG (recommended)",
              run_heuristics: "Heuristic Checks",
              run_focus: "Focus Visibility & Traps",
              run_keyboard_nav: "Keyboard Navigation",
              run_zoom: "Zoom & Resize Checks",
              run_color: "Color & Contrast",
              run_pointer: "Pointer & Gestures",
              run_live_dom: "Live DOM / A11y Tree",
              run_states: "Multi-State Testing",
              run_dynamic: "Dynamic Interactions",
              run_motion: "Motion / Animation",
              run_reflow: "Reflow (320px / 400% Zoom)"
            }).map(([key, label]) => (
              <Toggle key={key} checked={(opts as any)[key]} onChange={v => setOpts({ ...opts, [key]: v })} label={label} />
            ))}
          </div>
          <div className="mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
            <Toggle checked={opts.capture_screenshots} onChange={v => setOpts({ ...opts, capture_screenshots: v })} label="Capture screenshots" />
          </div>
          <div className="mt-4 pt-4 border-t space-y-3" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
            <Toggle checked={Boolean((opts as any).controlled_interaction_scan)} onChange={v => setOpts({ ...opts, controlled_interaction_scan: v })} label="Controlled interaction scan for links, buttons, popups, and in-page changes" />
            {(opts as any).controlled_interaction_scan && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Interaction mode</label>
                  <select style={inputStyle} value={(opts as any).controlled_interaction_mode} onChange={e => setOpts({ ...opts, controlled_interaction_mode: e.target.value })}>
                    <option value="safe-auto">Safe auto</option>
                    <option value="tester-selected">Tester selected</option>
                    <option value="exhaustive">Exhaustive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Max interactions per page</label>
                  <input type="number" min={1} max={60} style={inputStyle} value={(opts as any).controlled_interaction_limit}
                    onChange={e => setOpts({ ...opts, controlled_interaction_limit: Number(e.target.value) })} />
                </div>
                {(opts as any).controlled_interaction_mode === "tester-selected" && (
                  <div className="col-span-2">
                    <label className="block text-xs text-slate-500 mb-1.5">Tester-selected labels, selectors, or URL fragments</label>
                    <textarea rows={3} style={{ ...inputStyle, minHeight: 72, resize: "vertical" }}
                      placeholder={"One per line. Example:\nTi chiamiamo noi\nScopri di piu\n#open-sidebar"}
                      value={controlledAllowlistText} onChange={e => setControlledAllowlistText(e.target.value)} />
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="mt-4">
            <label className="block text-xs text-slate-500 mb-1.5">Owner fallback rules</label>
            <textarea
              rows={3}
              style={{ ...inputStyle, minHeight: 78, resize: "vertical" }}
              placeholder={"One per line: pattern | owner | component | match\nExample: /offers | Commercial Offers | Offers | url"}
              value={ownerFallbackText}
              onChange={e => setOwnerFallbackText(e.target.value)}
            />
            <p className="text-[11px] text-slate-600 mt-1">Used when DOM data-owner/data-component is missing. Match can be url, selector, message, or any.</p>
          </div>
        </motion.div>

        {/* Auth */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="card overflow-hidden">
          <button type="button" onClick={() => setShowAuth(!showAuth)}
            className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-white/[0.02] transition-colors">
            <div className="flex items-center gap-2.5">
              <Shield size={15} className="text-accent" />
              <span className="text-sm font-semibold text-slate-300">Login Authentication</span>
              <span className="text-xs text-slate-600 border border-white/10 px-2 py-0.5 rounded">Optional</span>
            </div>
            {showAuth ? <ChevronUp size={15} className="text-slate-500" /> : <ChevronDown size={15} className="text-slate-500" />}
          </button>
          {showAuth && (
            <div className="px-6 pb-6 space-y-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
              <p className="text-xs text-slate-600 mt-4 leading-relaxed">
                Use this when the target pages need a logged-in session. The scanner will log in first, accept cookies if enabled, then scan or crawl with the same browser session.
              </p>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Login URL</label>
                <input style={inputStyle} type="url" placeholder="https://example.com/login"
                  value={auth.login_url} onChange={e => setAuth({ ...auth, login_url: e.target.value })}
                  onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                  onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Username / Email</label>
                  <input style={inputStyle} placeholder="user@example.com" value={auth.username}
                    onChange={e => setAuth({ ...auth, username: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Password</label>
                  <input style={inputStyle} type="password" placeholder="Password" value={auth.password}
                    onChange={e => setAuth({ ...auth, password: e.target.value })} />
                </div>
              </div>

              {journeyOnlyMode && (
              <div className="rounded-xl p-4 space-y-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
                <Toggle checked={Boolean(auth.auto_accept_cookies)} onChange={v => setAuth({ ...auth, auto_accept_cookies: v })} label="Accept all cookie prompts automatically" />
                <Toggle checked={Boolean(auth.otp_from_page)} onChange={v => setAuth({ ...auth, otp_from_page: v })} label="OTP is shown on the login page and can be read automatically" />
                {!auth.otp_from_page && (
                  <div className="pt-2">
                    <label className="block text-xs text-slate-500 mb-1.5">OTP Code</label>
                    <input style={inputStyle} placeholder="Enter OTP for this scan"
                      value={auth.otp_code} onChange={e => setAuth({ ...auth, otp_code: e.target.value })} />
                  </div>
                )}
              </div>
              )}
              <div className="rounded-xl p-4 space-y-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
                <h3 className="text-sm font-semibold text-slate-300">Authenticated page scan scope</h3>
                <Toggle checked={opts.scan_login_page} onChange={v => setOpts({ ...opts, scan_login_page: v })} label="Scan login page before entering credentials" />
                <Toggle checked={opts.scan_post_login_landing} onChange={v => setOpts({ ...opts, scan_post_login_landing: v })} label="Scan page immediately after OTP login" />
                <Toggle checked={opts.scan_gestisci_page} onChange={v => setOpts({ ...opts, scan_gestisci_page: v })} label="Scan Gestisci / profile page" />
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  When these are off, the scanner may still use login or Gestisci for authentication/navigation, but it will not run accessibility modules on those pages.
                </p>
              </div>
            </div>
          )}
        </motion.div>

        {mutation.isError && (
          <div className="text-sm text-red-400 px-4 py-3 rounded-lg" style={{ background: "rgba(255,77,109,0.1)", border: "1px solid rgba(255,77,109,0.2)" }}>
            {scanCreateErrorMessage(mutation.error)}
          </div>
        )}

        <button type="submit" disabled={mutation.isPending}
          className="sky-primary w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-60">
          {mutation.isPending ? <><Loader2 size={16} className="animate-spin" />Starting Scan…</> : "Launch Accessibility Scan"}
        </button>
      </form>
    </div>
  );
}
