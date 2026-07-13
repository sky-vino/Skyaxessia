/**
 * ProductionScanPage.tsx — Sky-branded, theme-aware
 * -----------------------------------------------------------------------------
 * Uses your existing index.css CSS variables so both light and dark themes work:
 *   var(--bg), var(--surface-1..3), var(--text), var(--text-strong),
 *   var(--muted), var(--muted-strong), var(--border), var(--border-strong),
 *   var(--input-bg), var(--sky-gradient), var(--sky-pink), var(--sky-purple),
 *   var(--sky-blue)
 *
 * Same state machine and API surface as Ship 2c/2d. Adds the three missing
 * "Authenticated page scan scope" toggles (parity with Stage).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authSessionApi } from "../services/api";
import { motion } from "framer-motion";
import {
  AlertTriangle, CheckCircle2, Loader2, Mail, Smartphone, KeyRound, ChevronLeft,
  Plus, Trash2,
} from "lucide-react";

// -----------------------------------------------------------------------------
// Ship 2f — Journey configuration types + constants (parity with Stage)
// -----------------------------------------------------------------------------
const AUTHENTICATED_PAGE_OPTIONS = [
  "Gestisci",
  "Offerte",
  "Profilo",
  "Impostazioni",
  "Fatture",
  "Scopri l'app My Sky",
];
const JOURNEY_START_URL = "https://www.sky.it/mysky";

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

type Phase =
  | "launching" | "filling_credentials" | "requesting_otp"
  | "awaiting_otp" | "submitting_otp"
  | "authenticated" | "failed" | "expired";

interface Snapshot {
  id: string;
  phase: Phase;
  createdAt: string;
  expiresAt: string;
  otpChannel: "email" | "sms";
  targetUrl: string;
  scanName?: string;
  otpMaskedRecipient?: string;
  scanId?: string;
  errorMessage?: string;
}

const PHASE_LABELS: Record<Phase, string> = {
  launching: "Launching browser",
  filling_credentials: "Filling credentials",
  requesting_otp: "Requesting OTP from Sky",
  awaiting_otp: "Waiting for OTP",
  submitting_otp: "Submitting OTP",
  authenticated: "Authenticated — starting scan",
  failed: "Failed",
  expired: "Expired",
};

const OTP_LENGTH = 6;

export default function ProductionScanPage() {
  const navigate = useNavigate();

  const [targetUrl, setTargetUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otpChannel, setOtpChannel] = useState<"email" | "sms">("email");
  const [scanName, setScanName] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [opts, setOpts] = useState({
    scan_entry_mode: "url" as "url" | "journey",
    scan_depth_mode: "standard" as "shallow" | "standard" | "exhaustive",
    run_axe: true,
    run_heuristics: true,
    run_focus: true,
    run_keyboard_nav: true,
    run_zoom: true,
    run_color: true,
    run_pointer: true,
    run_live_dom: true,
    run_states: true,
    run_dynamic: true,
    run_motion: true,
    run_reflow: true,
    capture_screenshots: true,
    zoom_target_percent: 200 as 200 | 400,
    suppress_advisory_rules: false,
    run_controlled_interaction: false,
    // Ship 2e — Authenticated page scan scope (parity with Stage NewScanPage)
    scan_login_page: false,
    scan_post_login_landing: false,
    scan_gestisci_page: false,
  });

  const [session, setSession] = useState<Snapshot | null>(null);
  const [otpDigits, setOtpDigits] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [genBtnHover, setGenBtnHover] = useState(false);
  const [submitBtnHover, setSubmitBtnHover] = useState(false);

  // Ship 2f — Journey configuration state + handlers (parity with Stage)
  const [targetInteractions, setTargetInteractions] = useState<TargetInteraction[]>([]);
  const journeyOnlyMode = opts.scan_entry_mode === "journey";

  const addTargetInteraction = () => {
    setTargetInteractions([...targetInteractions, {
      base_page: "Offerte",
      mode: "single-interaction",
      name: "",
      selector: "",
      text: "",
      cta_text: "",
      href_contains: "",
      click_type: "button",
      scan_destination_only: true,
      scan_launch_page: false,
      steps: [],
    }]);
  };
  const updateTargetInteraction = (index: number, patch: Partial<TargetInteraction>) => {
    setTargetInteractions(prev => prev.map((t, i) => i === index ? { ...t, ...patch } : t));
  };
  const removeTargetInteraction = (index: number) => {
    setTargetInteractions(prev => prev.filter((_, i) => i !== index));
  };
  const addJourneyStep = (targetIndex: number) => {
    setTargetInteractions(prev => prev.map((t, i) => i === targetIndex ? {
      ...t,
      steps: [...t.steps, {
        action: "click",
        page: "",
        name: "",
        selector: "",
        text: "",
        cta_text: "",
        href_contains: "",
        click_type: "any",
        scan_after_step: false,
      }],
    } : t));
  };
  const updateJourneyStep = (targetIndex: number, stepIndex: number, patch: Partial<TargetJourneyStep>) => {
    setTargetInteractions(prev => prev.map((t, i) => i === targetIndex ? {
      ...t,
      steps: t.steps.map((s, si) => si === stepIndex ? { ...s, ...patch } : s),
    } : t));
  };
  const removeJourneyStep = (targetIndex: number, stepIndex: number) => {
    setTargetInteractions(prev => prev.map((t, i) => i === targetIndex ? {
      ...t,
      steps: t.steps.filter((_, si) => si !== stepIndex),
    } : t));
  };

  useEffect(() => {
    if (!session || session.phase === "authenticated" || session.phase === "failed" || session.phase === "expired") return;
    const iv = setInterval(async () => {
      try {
        const { data } = await authSessionApi.poll(session.id);
        setSession(data.session);
        if (data.session.phase === "authenticated" && data.session.scanId) {
          setTimeout(() => navigate(`/scans/${data.session.scanId}`), 800);
        }
      } catch (err: any) {
        setSession(prev => prev ? { ...prev, phase: "expired", errorMessage: "Session was lost on the backend. Please start again." } : prev);
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [session, navigate]);

  useEffect(() => {
    if (!session) return;
    const iv = setInterval(() => {
      const remaining = Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
      setCountdown(remaining);
    }, 1000);
    return () => clearInterval(iv);
  }, [session]);

  useEffect(() => {
    if (session?.phase === "awaiting_otp") {
      setTimeout(() => otpInputRefs.current[0]?.focus(), 150);
    }
  }, [session?.phase]);

  const canStart = useMemo(() => {
    // Ship 2f — in journey mode, target_url validation is replaced by
    // "at least one target interaction with a valid base_page and identifier".
    if (!username.trim() || !password || starting) return false;
    if (journeyOnlyMode) {
      const validTargets = targetInteractions.filter(t =>
        t.base_page &&
        (t.mode === "journey" ? t.steps.length > 0 : (t.selector || t.text || t.cta_text || t.href_contains))
      );
      return validTargets.length > 0 && targetUrl.trim().length > 8;
    }
    return targetUrl.trim().length > 8;
  }, [targetUrl, username, password, starting, journeyOnlyMode, targetInteractions]);

  const otpString = otpDigits.join("");
  const canSubmitOtp = otpString.length === OTP_LENGTH && !submitting && session?.phase === "awaiting_otp";

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    setStartError(null);
    try {
      // Ship 2f — in journey mode, only send targets that have real content.
      const journeyTargets = targetInteractions
        .map(t => ({ ...t, steps: t.mode === "journey" ? t.steps : [] }))
        .filter(t => t.base_page && (t.mode === "journey" ? t.steps.length > 0 : (t.selector || t.text || t.cta_text || t.href_contains)));

      const { data } = await authSessionApi.start({
        target_url: targetUrl.trim(),
        username: username.trim(),
        password,
        otp_channel: otpChannel,
        scan_name: scanName.trim() || undefined,
        scan_options: {
          ...opts,
          // Journey mode: send targets; else send empty array.
          target_interactions: journeyOnlyMode ? journeyTargets : [],
          // Journey mode disables login/gestisci auto-scans (Stage parity).
          scan_post_login_landing: journeyOnlyMode ? false : opts.scan_post_login_landing,
          scan_gestisci_page: journeyOnlyMode ? false : opts.scan_gestisci_page,
        },
      });
      setSession(data.session);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "Could not start auth session.";
      setStartError(msg);
    } finally {
      setStarting(false);
    }
  };

  const handleSubmitOtp = async () => {
    if (!canSubmitOtp || !session) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data } = await authSessionApi.submitOtp(session.id, otpString);
      setSession(data.session);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "OTP submit failed.";
      setSubmitError(msg);
      setOtpDigits(Array(OTP_LENGTH).fill(""));
      setTimeout(() => otpInputRefs.current[0]?.focus(), 100);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!session) return;
    try { await authSessionApi.cancel(session.id); } catch { /* ignore */ }
    setSession(null);
    setOtpDigits(Array(OTP_LENGTH).fill(""));
    setStartError(null);
    setSubmitError(null);
  };

  const handleOtpDigitChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(0, 1);
    const next = [...otpDigits];
    next[index] = digit;
    setOtpDigits(next);
    if (digit && index < OTP_LENGTH - 1) otpInputRefs.current[index + 1]?.focus();
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
    if (pasted.length === OTP_LENGTH) {
      e.preventDefault();
      setOtpDigits(pasted.split(""));
      otpInputRefs.current[OTP_LENGTH - 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otpDigits[index] && index > 0) otpInputRefs.current[index - 1]?.focus();
    if (e.key === "Enter" && otpString.length === OTP_LENGTH) handleSubmitOtp();
  };

  const skyBtnShadow = (hover: boolean, disabled: boolean) => {
    if (disabled) return "none";
    return hover
      ? "0 12px 32px rgba(176, 24, 216, 0.35), 0 4px 16px rgba(22, 119, 255, 0.25)"
      : "0 8px 20px rgba(176, 24, 216, 0.18)";
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5 relative">
      <div className="fixed top-0 right-0 w-[500px] h-[500px] rounded-full opacity-[0.10] blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(224,0,98,0.5), transparent 60%)" }} />
      <div className="fixed bottom-0 left-0 w-[500px] h-[500px] rounded-full opacity-[0.10] blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(22,119,255,0.5), transparent 60%)" }} />

      <button
        onClick={() => session ? handleCancel() : navigate("/scans/new")}
        className="text-xs flex items-center gap-1 transition-colors relative z-10"
        style={{ color: "var(--muted)" }}
        onMouseEnter={(e) => e.currentTarget.style.color = "var(--text-strong)"}
        onMouseLeave={(e) => e.currentTarget.style.color = "var(--muted)"}
      >
        <ChevronLeft size={14} /> {session ? "Cancel & restart" : "Back to New Scan"}
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
              Production Authenticated Scan
            </h1>
            <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
              For sites where the OTP arrives on your real phone or email inbox. Enter credentials,
              read the OTP from your inbox, and hand it to the scanner. Runs with the same configuration
              options as a Stage scan.
            </p>
          </div>
        </div>
      </GradientCard>

      {!session && (
        <>
          {/* Card 1 — Login credentials */}
          <GradientCard delay={0.04}>
            <SectionHeader label="Login credentials" />
            <div className="space-y-5">
              <PremiumInput
                label="Username / Email" hint="Your Sky iD email or username"
                value={username} onChange={setUsername} placeholder="user@example.com"
                type="text" autoComplete="off" autoFocus
                focused={focusedField === "username"}
                onFocus={() => setFocusedField("username")}
                onBlur={() => setFocusedField(null)}
              />
              <PremiumInput
                label="Password" value={password} onChange={setPassword}
                placeholder="••••••••" type="password" autoComplete="new-password"
                focused={focusedField === "password"}
                onFocus={() => setFocusedField("password")}
                onBlur={() => setFocusedField(null)}
              />
              <div>
                <FieldLabel>OTP delivery channel</FieldLabel>
                <div className="grid grid-cols-2 gap-3">
                  <ChannelPill active={otpChannel === "email"} icon={<Mail size={16} />} label="Email" onClick={() => setOtpChannel("email")} />
                  <ChannelPill active={otpChannel === "sms"} icon={<Smartphone size={16} />} label="SMS" onClick={() => setOtpChannel("sms")} />
                </div>
              </div>
              <PremiumInput
                label="Scan name (optional)" value={scanName} onChange={setScanName}
                placeholder={`Prod scan ${new Date().toLocaleDateString()}`} type="text"
                focused={focusedField === "scanname"}
                onFocus={() => setFocusedField("scanname")}
                onBlur={() => setFocusedField(null)}
              />
            </div>
          </GradientCard>

          {/* Card 2 — Scan entry */}
          <GradientCard delay={0.06}>
            <SectionHeader label="Scan entry" required />
            <div className="grid grid-cols-2 gap-3 mb-5">
              <ChoiceCard active={opts.scan_entry_mode === "url"} title="Scan target URL" subtitle="Use each URL as a page to scan."
                onClick={() => setOpts({ ...opts, scan_entry_mode: "url" })} />
              <ChoiceCard active={opts.scan_entry_mode === "journey"} title="Use journey configuration" subtitle="Hide target URL input; scan only configured target journeys."
                onClick={() => setOpts({ ...opts, scan_entry_mode: "journey" })} />
            </div>
            {opts.scan_entry_mode === "url" && (
              <PremiumInput
                label="Target URL" hint="The authenticated page you want scanned (e.g. https://www.sky.it/mysky/offerte)"
                value={targetUrl} onChange={setTargetUrl}
                placeholder="https://www.sky.it/mysky/offerte" type="url"
                focused={focusedField === "targeturl"}
                onFocus={() => setFocusedField("targeturl")}
                onBlur={() => setFocusedField(null)}
              />
            )}
            {opts.scan_entry_mode === "journey" && (
              <>
                <PremiumInput
                  label="Login URL"
                  hint="The scanner still needs a URL to reach the login form. Journeys run after authentication completes."
                  value={targetUrl} onChange={setTargetUrl}
                  placeholder="https://www.sky.it/mysky" type="url"
                  focused={focusedField === "loginurl"}
                  onFocus={() => setFocusedField("loginurl")}
                  onBlur={() => setFocusedField(null)}
                />

                {/* Ship 2f — Full journey configuration UI (parity with Stage) */}
                <div className="mt-5 rounded-xl p-4 space-y-3"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
                        Targeted destination interactions
                      </h3>
                      <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>
                        Use this when a selected page is only a launch point. Configure a single promo/link click, or a deterministic multi-step journey.
                      </p>
                    </div>
                    <button type="button" onClick={addTargetInteraction}
                      className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-all font-semibold"
                      style={{
                        background: "var(--sky-gradient)",
                        color: "white",
                        boxShadow: "0 4px 12px -2px rgba(176,24,216,0.35)",
                      }}>
                      <Plus size={13} /> Add target / journey
                    </button>
                  </div>

                  {targetInteractions.length === 0 && (
                    <div className="text-[11px] rounded-lg p-3 text-center"
                      style={{ background: "var(--soft)", color: "var(--muted)", border: "1px dashed var(--border-strong)" }}>
                      No targets configured yet. Click "Add target / journey" to configure at least one.
                    </div>
                  )}

                  {targetInteractions.length > 0 && (
                    <div className="space-y-3">
                      {targetInteractions.map((target, index) => (
                        <TargetCard
                          key={index}
                          target={target}
                          index={index}
                          onUpdate={(patch) => updateTargetInteraction(index, patch)}
                          onRemove={() => removeTargetInteraction(index)}
                          onAddStep={() => addJourneyStep(index)}
                          onUpdateStep={(stepIdx, patch) => updateJourneyStep(index, stepIdx, patch)}
                          onRemoveStep={(stepIdx) => removeJourneyStep(index, stepIdx)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </GradientCard>

          {/* Card 3 — Authenticated page scan scope (Ship 2e — parity with Stage) */}
          <GradientCard delay={0.07}>
            <SectionHeader label="Authenticated page scan scope" />
            <div className="space-y-1">
              <PremiumToggle checked={opts.scan_login_page} onChange={v => setOpts({ ...opts, scan_login_page: v })} label="Scan login page before entering credentials" />
              <PremiumToggle checked={opts.scan_post_login_landing} onChange={v => setOpts({ ...opts, scan_post_login_landing: v })} label="Scan page immediately after OTP login" />
              <PremiumToggle checked={opts.scan_gestisci_page} onChange={v => setOpts({ ...opts, scan_gestisci_page: v })} label="Scan Gestisci / profile page" />
            </div>
            <div className="mt-3 text-[10px] leading-relaxed" style={{ color: "var(--muted)" }}>
              When these are off, the scanner may still use login or Gestisci for authentication / navigation, but it will not run accessibility modules on those pages.
            </div>
          </GradientCard>

          {/* Card 4 — Scan Modules */}
          <GradientCard delay={0.08}>
            <SectionHeader label="Scan Modules" />

            <div className="grid grid-cols-3 gap-3 mb-5">
              {([
                ["shallow", "Shallow", "Fast: minimal state expansion"],
                ["standard", "Standard", "Balanced sampled state matrix"],
                ["exhaustive", "Exhaustive", "Deeper interactions and more evidence"],
              ] as const).map(([value, label, description]) => (
                <ChoiceCard
                  key={value}
                  active={opts.scan_depth_mode === value}
                  title={label} subtitle={description}
                  onClick={() => setOpts({ ...opts, scan_depth_mode: value })}
                />
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
                title="AA-lite (200% only)" subtitle="Matches this team's audit scenario. Skips 320px reflow."
                onClick={() => setOpts({ ...opts, zoom_target_percent: 200 })} />
              <ChoiceCard active={opts.zoom_target_percent === 400}
                title="WCAG AA (400%)" subtitle="Tests 200%/300% intermediate breakpoints AND 320px reflow (WCAG 1.4.10)."
                onClick={() => setOpts({ ...opts, zoom_target_percent: 400 })} />
            </div>

            <Divider />
            <PremiumToggle checked={opts.suppress_advisory_rules}
              onChange={v => setOpts({ ...opts, suppress_advisory_rules: v })}
              label="Suppress advisory / best-practice rules (font size, target-size-enhanced, motion, gestures)" />
            <div className="text-[10px] mt-1 pl-14 leading-relaxed" style={{ color: "var(--muted)" }}>
              When on: drops <code style={{ color: "var(--muted-strong)" }}>target-size-enhanced</code>, <code style={{ color: "var(--muted-strong)" }}>fixed-font-size</code>, <code style={{ color: "var(--muted-strong)" }}>text-truncation</code>, <code style={{ color: "var(--muted-strong)" }}>complex-background</code>, <code style={{ color: "var(--muted-strong)" }}>motion</code>, and <code style={{ color: "var(--muted-strong)" }}>gesture-no-alternative</code> from the report entirely.
            </div>

            <Divider />
            <PremiumToggle checked={opts.run_controlled_interaction}
              onChange={v => setOpts({ ...opts, run_controlled_interaction: v })}
              label="Controlled interaction scan for links, buttons, popups, and in-page changes" />
          </GradientCard>

          {/* Card 5 — Generate OTP */}
          <GradientCard delay={0.1}>
            <div className="space-y-4">
              {startError && (
                <div className="p-4 rounded-xl text-xs flex items-start gap-3"
                  style={{ background: "rgba(255,77,109,0.08)", color: "#ff6b8b", border: "1px solid rgba(255,77,109,0.25)" }}>
                  <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                  <div>{startError}</div>
                </div>
              )}
              <button
                onClick={handleStart} disabled={!canStart}
                onMouseEnter={() => setGenBtnHover(true)} onMouseLeave={() => setGenBtnHover(false)}
                className={canStart ? "sky-primary relative w-full py-4 rounded-xl font-semibold text-sm text-white transition-all overflow-hidden"
                  : "relative w-full py-4 rounded-xl font-semibold text-sm transition-all overflow-hidden"}
                style={canStart ? {
                  boxShadow: skyBtnShadow(genBtnHover, false),
                  transform: genBtnHover ? "translateY(-1px)" : "translateY(0)",
                  transition: "box-shadow 300ms ease, transform 200ms ease",
                } : {
                  background: "var(--surface-3)",
                  color: "var(--muted)",
                  cursor: "not-allowed",
                  opacity: 0.6,
                }}>
                {starting ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 size={16} className="animate-spin" /> Launching browser…
                  </span>
                ) : "Generate OTP"}
              </button>
              <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                This will open a real Chromium browser on the server, log in with your credentials,
                and trigger Sky to send an OTP to your <strong style={{ color: "var(--text-strong)" }}>{otpChannel}</strong>. You'll
                have 5 minutes to check your {otpChannel === "email" ? "inbox" : "phone"} and enter the code.
              </div>
            </div>
          </GradientCard>
        </>
      )}

      {/* STEP 2 — OTP entry */}
      {session && (
        <GradientCard delay={0}>
          <div className="space-y-5">
            <PhaseTimeline phase={session.phase} />

            {session.phase !== "failed" && session.phase !== "expired" && (
              <div className="p-4 rounded-xl text-xs"
                style={{ background: "var(--soft)", border: "1px solid var(--border)" }}>
                <div className="flex items-center justify-between mb-2">
                  <span style={{ color: "var(--muted)" }}>Status</span>
                  <span className="font-medium" style={{ color: "var(--text-strong)" }}>{PHASE_LABELS[session.phase]}</span>
                </div>
                {countdown > 0 && (
                  <div className="flex items-center justify-between">
                    <span style={{ color: "var(--muted)" }}>Expires in</span>
                    <span className="sky-wordmark font-mono text-sm">
                      {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
                    </span>
                  </div>
                )}
              </div>
            )}

            {session.phase === "awaiting_otp" && (
              <>
                <div className="relative rounded-xl p-[1.5px]" style={{ background: "var(--sky-gradient)" }}>
                  <div className="p-4 rounded-[10px] text-xs" style={{ background: "var(--surface-2)" }}>
                    <div className="flex items-center gap-2 font-semibold mb-1.5" style={{ color: "var(--text-strong)" }}>
                      {session.otpChannel === "email" ? <Mail size={14} /> : <Smartphone size={14} />}
                      OTP sent
                    </div>
                    <div className="leading-relaxed" style={{ color: "var(--muted)" }}>
                      Check your <strong style={{ color: "var(--text-strong)" }}>{session.otpChannel}</strong>
                      {session.otpMaskedRecipient && ` (${session.otpMaskedRecipient})`}
                      {" "}for the {OTP_LENGTH}-digit code, then enter it below.
                    </div>
                  </div>
                </div>

                <div>
                  <FieldLabel>Enter the {OTP_LENGTH}-digit code</FieldLabel>
                  <div className="flex gap-2.5 justify-center mt-2">
                    {otpDigits.map((digit, i) => (
                      <OtpBox
                        key={i}
                        digit={digit}
                        inputRef={el => { otpInputRefs.current[i] = el; }}
                        onChange={v => handleOtpDigitChange(i, v)}
                        onKeyDown={e => handleOtpKeyDown(i, e)}
                        onPaste={handleOtpPaste}
                      />
                    ))}
                  </div>
                </div>

                {submitError && (
                  <div className="p-4 rounded-xl text-xs flex items-start gap-3"
                    style={{ background: "rgba(255,77,109,0.08)", color: "#ff6b8b", border: "1px solid rgba(255,77,109,0.25)" }}>
                    <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                    <div>{submitError}</div>
                  </div>
                )}

                <button
                  onClick={handleSubmitOtp} disabled={!canSubmitOtp}
                  onMouseEnter={() => setSubmitBtnHover(true)} onMouseLeave={() => setSubmitBtnHover(false)}
                  className={canSubmitOtp ? "sky-primary relative w-full py-4 rounded-xl font-semibold text-sm text-white transition-all overflow-hidden"
                    : "relative w-full py-4 rounded-xl font-semibold text-sm transition-all overflow-hidden"}
                  style={canSubmitOtp ? {
                    boxShadow: skyBtnShadow(submitBtnHover, false),
                    transform: submitBtnHover ? "translateY(-1px)" : "translateY(0)",
                    transition: "box-shadow 300ms ease, transform 200ms ease",
                  } : {
                    background: "var(--surface-3)",
                    color: "var(--muted)",
                    cursor: "not-allowed",
                    opacity: 0.6,
                  }}>
                  {submitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 size={16} className="animate-spin" /> Verifying…
                    </span>
                  ) : "Login and Scan"}
                </button>
              </>
            )}

            {session.phase === "authenticated" && (
              <div className="relative rounded-xl p-[1.5px]" style={{ background: "var(--sky-gradient)" }}>
                <div className="p-6 rounded-[10px] text-center" style={{ background: "var(--surface-2)" }}>
                  <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center"
                    style={{ background: "var(--sky-gradient)", boxShadow: "0 8px 24px -6px rgba(176,24,216,0.4)" }}>
                    <CheckCircle2 size={26} className="text-white" />
                  </div>
                  <div className="font-semibold" style={{ color: "var(--text-strong)" }}>Authentication successful</div>
                  <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>Redirecting to your scan…</div>
                </div>
              </div>
            )}

            {(session.phase === "failed" || session.phase === "expired") && (
              <>
                <div className="p-4 rounded-xl text-xs flex items-start gap-3"
                  style={{ background: "rgba(255,77,109,0.08)", color: "#ff6b8b", border: "1px solid rgba(255,77,109,0.25)" }}>
                  <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold mb-0.5">{session.phase === "expired" ? "Session expired" : "Auth failed"}</div>
                    <div>{session.errorMessage || "The session ended before authentication completed."}</div>
                  </div>
                </div>
                <button onClick={handleCancel}
                  className="w-full py-3 rounded-xl font-semibold text-sm transition-all"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }}>
                  Try again
                </button>
              </>
            )}
          </div>
        </GradientCard>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents — all theme-aware via var() references
// -----------------------------------------------------------------------------

function GradientCard({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-2xl overflow-hidden"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border-strong)",
      }}
    >
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
    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2"
      style={{ color: "var(--muted-strong)" }}>
      {children}
    </label>
  );
}

function Divider() {
  return <div className="my-4 h-px" style={{ background: "var(--border)" }} />;
}

function PremiumInput({
  label, hint, value, onChange, placeholder, type = "text", autoComplete, autoFocus,
  focused, onFocus, onBlur,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative rounded-xl p-[1.5px] transition-all"
        style={{
          background: focused ? "var(--sky-gradient)" : "var(--border-strong)",
          boxShadow: focused ? "0 0 0 3px rgba(224, 0, 98, 0.10), 0 0 20px -4px rgba(139, 43, 217, 0.28)" : "none",
        }}>
        <input
          type={type} value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={onFocus} onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete} autoFocus={autoFocus}
          className="w-full px-4 py-3.5 rounded-[10px] text-sm outline-none border-0"
        />
      </div>
      {hint && <div className="text-[10px] mt-2 ml-1 leading-relaxed" style={{ color: "var(--muted)" }}>{hint}</div>}
    </div>
  );
}

function ChannelPill({
  active, icon, label, onClick,
}: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="relative py-3 px-4 rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-all"
      style={{
        background: active ? "var(--soft)" : "var(--surface-2)",
        border: active ? "1.5px solid transparent" : "1.5px solid var(--border-strong)",
        color: active ? "var(--text-strong)" : "var(--text)",
        backgroundImage: active ? `linear-gradient(var(--soft), var(--soft)), var(--sky-gradient)` : undefined,
        backgroundClip: active ? "padding-box, border-box" : undefined,
        backgroundOrigin: active ? "padding-box, border-box" : undefined,
        boxShadow: active ? "0 4px 20px -6px rgba(176, 24, 216, 0.28)" : "none",
      }}>
      {icon}
      {label}
    </button>
  );
}

function ChoiceCard({
  active, title, subtitle, onClick,
}: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="text-left rounded-xl p-4 transition-all relative overflow-hidden"
      style={{
        background: active ? "var(--soft)" : "var(--surface-2)",
        border: active ? "1.5px solid transparent" : "1.5px solid var(--border-strong)",
        backgroundImage: active ? `linear-gradient(var(--soft), var(--soft)), var(--sky-gradient)` : undefined,
        backgroundClip: active ? "padding-box, border-box" : undefined,
        backgroundOrigin: active ? "padding-box, border-box" : undefined,
        boxShadow: active ? "0 4px 20px -6px rgba(176, 24, 216, 0.22)" : "none",
      }}>
      <div className="text-sm font-semibold mb-1" style={{ color: active ? "var(--text-strong)" : "var(--text-strong)" }}>{title}</div>
      <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>{subtitle}</div>
    </button>
  );
}

function PremiumToggle({
  checked, onChange, label,
}: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 py-2 cursor-pointer group">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="w-11 h-6 rounded-full flex-shrink-0 relative transition-all"
        style={{
          background: checked ? "var(--sky-gradient)" : "var(--surface-3)",
          boxShadow: checked ? "0 4px 12px -2px rgba(176,24,216,0.35)" : "none",
        }}>
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
          style={{
            left: checked ? "22px" : "2px",
            boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
          }}
        />
      </button>
      <span className="text-xs transition-colors" style={{ color: "var(--text)" }}>{label}</span>
    </label>
  );
}

function OtpBox({
  digit, inputRef, onChange, onKeyDown, onPaste,
}: {
  digit: string;
  inputRef: (el: HTMLInputElement | null) => void;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
}) {
  const [focused, setFocused] = useState(false);
  const filled = digit.length > 0;
  return (
    <div className="rounded-xl p-[1.5px] transition-all"
      style={{
        background: focused || filled ? "var(--sky-gradient)" : "var(--border-strong)",
        boxShadow: focused
          ? "0 0 0 3px rgba(224, 0, 98, 0.15), 0 0 24px -4px rgba(139, 43, 217, 0.4)"
          : filled
          ? "0 4px 20px -6px rgba(176, 24, 216, 0.28)"
          : "none",
      }}>
      <input
        ref={inputRef}
        type="tel" inputMode="numeric" maxLength={1}
        value={digit}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="w-14 h-16 text-center text-2xl font-bold rounded-[10px] outline-none border-0"
        style={{ fontFamily: "'DM Sans', sans-serif" }}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Ship 2f — Journey configuration subcomponents (theme-aware)
// -----------------------------------------------------------------------------

const nativeFieldStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  width: "100%",
  fontSize: 13,
  border: "1px solid var(--border-strong)",
  outline: "none",
};

function SmallLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>{children}</label>;
}

function TargetCard({
  target, index,
  onUpdate, onRemove, onAddStep, onUpdateStep, onRemoveStep,
}: {
  target: TargetInteraction;
  index: number;
  onUpdate: (patch: Partial<TargetInteraction>) => void;
  onRemove: () => void;
  onAddStep: () => void;
  onUpdateStep: (stepIdx: number, patch: Partial<TargetJourneyStep>) => void;
  onRemoveStep: (stepIdx: number) => void;
}) {
  return (
    <div className="rounded-lg p-3 space-y-3"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold" style={{ color: "var(--muted-strong)" }}>Target #{index + 1}</span>
        <button type="button" onClick={onRemove}
          className="w-8 h-8 inline-flex items-center justify-center rounded-lg transition-colors"
          style={{ color: "var(--muted)" }}
          onMouseEnter={e => {
            e.currentTarget.style.color = "#ff6b8b";
            e.currentTarget.style.background = "rgba(255,77,109,0.1)";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = "var(--muted)";
            e.currentTarget.style.background = "transparent";
          }}>
          <Trash2 size={13} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <SmallLabel>Target mode</SmallLabel>
          <select style={nativeFieldStyle} value={target.mode}
            onChange={e => onUpdate({ mode: e.target.value as TargetInteraction["mode"] })}>
            <option value="single-interaction">Single promo/link click</option>
            <option value="journey">Multi-step journey</option>
          </select>
        </div>
        <div>
          <SmallLabel>Launch page</SmallLabel>
          <select style={nativeFieldStyle} value={target.base_page}
            onChange={e => onUpdate({ base_page: e.target.value })}>
            {AUTHENTICATED_PAGE_OPTIONS.map(label => <option key={label} value={label}>{label}</option>)}
          </select>
        </div>
        <div>
          <SmallLabel>Target / journey name</SmallLabel>
          <input style={nativeFieldStyle} placeholder="e.g. Netflix Standard offer"
            value={target.name} onChange={e => onUpdate({ name: e.target.value })} />
        </div>
        <div>
          <SmallLabel>Click type</SmallLabel>
          <select style={nativeFieldStyle} value={target.click_type}
            onChange={e => onUpdate({ click_type: e.target.value as TargetInteraction["click_type"] })}>
            <option value="button">Button / CTA</option>
            <option value="link">Link</option>
            <option value="heading-link">Heading/title link</option>
            <option value="any">Any interactive element</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <SmallLabel>Visible text / accessible name</SmallLabel>
          <input style={nativeFieldStyle} placeholder="e.g. Netflix Standard"
            value={target.text} onChange={e => onUpdate({ text: e.target.value })} />
        </div>
        <div>
          <SmallLabel>CTA text inside card</SmallLabel>
          <input style={nativeFieldStyle} placeholder="e.g. Scopri di piu"
            value={target.cta_text} onChange={e => onUpdate({ cta_text: e.target.value })} />
        </div>
      </div>

      <div>
        <SmallLabel>Href contains</SmallLabel>
        <input style={nativeFieldStyle} placeholder="e.g. sky-wifi or /offerte/"
          value={target.href_contains} onChange={e => onUpdate({ href_contains: e.target.value })} />
      </div>

      <div>
        <SmallLabel>Selector fallback</SmallLabel>
        <textarea rows={2} style={{ ...nativeFieldStyle, minHeight: 58, resize: "vertical" }}
          placeholder="Optional. CSS, XPath, or js= selector for the exact card/link/button."
          value={target.selector} onChange={e => onUpdate({ selector: e.target.value })} />
      </div>

      <div className="space-y-1">
        <PremiumToggle
          checked={target.scan_destination_only}
          onChange={v => onUpdate({ scan_destination_only: v })}
          label="Use launch page only for navigation; scan the destination/final target"
        />
        <PremiumToggle
          checked={target.scan_launch_page}
          onChange={v => onUpdate({ scan_launch_page: v })}
          label="Also scan the launch page before executing this target"
        />
      </div>

      {target.mode === "journey" && (
        <div className="rounded-lg p-3 space-y-3"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border-strong)" }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-semibold" style={{ color: "var(--text-strong)" }}>Journey steps</h4>
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>
                Use navigation steps for known pages and click steps for links/buttons. Enable scan on the final step, or leave all off to scan the final page automatically.
              </p>
            </div>
            <button type="button" onClick={onAddStep}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg font-semibold transition-all"
              style={{
                background: "var(--sky-gradient)",
                color: "white",
                boxShadow: "0 4px 12px -2px rgba(176,24,216,0.35)",
              }}>
              <Plus size={13} /> Add step
            </button>
          </div>

          {target.steps.length === 0 && (
            <div className="text-[11px] rounded-lg p-3 text-center"
              style={{ background: "var(--soft)", color: "var(--muted)", border: "1px dashed var(--border-strong)" }}>
              No steps yet. Click "Add step" to define the journey.
            </div>
          )}

          {target.steps.map((step, stepIndex) => (
            <div key={stepIndex} className="rounded-lg p-3 space-y-3"
              style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold" style={{ color: "var(--muted-strong)" }}>Step #{stepIndex + 1}</span>
                <button type="button" onClick={() => onRemoveStep(stepIndex)}
                  className="w-7 h-7 inline-flex items-center justify-center rounded-lg transition-colors"
                  style={{ color: "var(--muted)" }}
                  onMouseEnter={e => {
                    e.currentTarget.style.color = "#ff6b8b";
                    e.currentTarget.style.background = "rgba(255,77,109,0.1)";
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.color = "var(--muted)";
                    e.currentTarget.style.background = "transparent";
                  }}>
                  <Trash2 size={12} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <SmallLabel>Action</SmallLabel>
                  <select style={nativeFieldStyle} value={step.action}
                    onChange={e => onUpdateStep(stepIndex, { action: e.target.value as TargetJourneyStep["action"] })}>
                    <option value="navigate-page">Navigate known page</option>
                    <option value="click">Click link/button</option>
                  </select>
                </div>
                <div>
                  <SmallLabel>Step name</SmallLabel>
                  <input style={nativeFieldStyle} placeholder="Optional label"
                    value={step.name} onChange={e => onUpdateStep(stepIndex, { name: e.target.value })} />
                </div>
              </div>

              {step.action === "navigate-page" ? (
                <div>
                  <SmallLabel>Page</SmallLabel>
                  <select style={nativeFieldStyle} value={step.page}
                    onChange={e => onUpdateStep(stepIndex, { page: e.target.value })}>
                    <option value="">Select page</option>
                    {AUTHENTICATED_PAGE_OPTIONS.map(label => <option key={label} value={label}>{label}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <SmallLabel>Container / visible text</SmallLabel>
                      <input style={nativeFieldStyle} placeholder="e.g. Dispositivi e protezioni"
                        value={step.text} onChange={e => onUpdateStep(stepIndex, { text: e.target.value })} />
                    </div>
                    <div>
                      <SmallLabel>CTA text</SmallLabel>
                      <input style={nativeFieldStyle} placeholder="Optional button text"
                        value={step.cta_text} onChange={e => onUpdateStep(stepIndex, { cta_text: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <SmallLabel>Href contains</SmallLabel>
                      <input style={nativeFieldStyle} placeholder="Optional URL fragment"
                        value={step.href_contains} onChange={e => onUpdateStep(stepIndex, { href_contains: e.target.value })} />
                    </div>
                    <div>
                      <SmallLabel>Click type</SmallLabel>
                      <select style={nativeFieldStyle} value={step.click_type}
                        onChange={e => onUpdateStep(stepIndex, { click_type: e.target.value as TargetJourneyStep["click_type"] })}>
                        <option value="any">Any interactive element</option>
                        <option value="button">Button / CTA</option>
                        <option value="link">Link</option>
                        <option value="heading-link">Heading/title link</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <SmallLabel>Selector fallback</SmallLabel>
                    <textarea rows={2} style={{ ...nativeFieldStyle, minHeight: 54, resize: "vertical" }}
                      value={step.selector} onChange={e => onUpdateStep(stepIndex, { selector: e.target.value })} />
                  </div>
                </>
              )}

              <PremiumToggle
                checked={step.scan_after_step}
                onChange={v => onUpdateStep(stepIndex, { scan_after_step: v })}
                label="Scan the page/state reached after this step"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseTimeline({ phase }: { phase: Phase }) {
  const stages: Phase[] = ["launching", "filling_credentials", "requesting_otp", "awaiting_otp", "submitting_otp", "authenticated"];
  const currentIndex = stages.indexOf(phase);
  const isFailed = phase === "failed" || phase === "expired";
  return (
    <div className="flex gap-1.5">
      {stages.map((s, i) => (
        <div key={s} className="flex-1 h-1.5 rounded-full transition-all"
          style={{
            background: isFailed
              ? "rgba(255,77,109,0.2)"
              : i <= currentIndex
              ? "var(--sky-gradient)"
              : "var(--surface-3)",
            opacity: isFailed ? 0.5 : 1,
          }} />
      ))}
    </div>
  );
}
