import { useQuery } from "@tanstack/react-query";
import { issueApi, scanApi } from "../../services/api";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import {
  MousePointer2, Keyboard, ChevronDown, AlertCircle,
  Loader2, Camera, CheckCircle2, Layers, Download
} from "lucide-react";
import { formatWcagTag, getIssueComplianceLevels, getIssueCriteria, levelColor } from "../../utils/wcag";

const STATE_META: Record<string, { icon: any; color: string; label: string; description: string }> = {
  default:     { icon: Layers,        color: "#0f766e", label: "Initial",   description: "Default page load state" },
  hover:       { icon: MousePointer2, color: "#6e56cf", label: "Hover",     description: "Mouse hover over interactive elements" },
  focus:       { icon: Keyboard,      color: "#a78bfa", label: "Focus",     description: "Programmatic focus applied to elements" },
  expanded:    { icon: ChevronDown,   color: "#ff9f43", label: "Expanded",  description: "Dropdowns, accordions, modals opened" },
  error:       { icon: AlertCircle,   color: "#ff4d6d", label: "Error",     description: "Form validation errors triggered" },
  "tab-interaction": { icon: Layers,  color: "#ffd60a", label: "Tab Panel", description: "Tab panel switching interaction" },
  keyboard:    { icon: Keyboard,      color: "#22c55e", label: "Keyboard",  description: "Keyboard navigation simulation" },
  zoom:        { icon: Layers,        color: "#0b84a5", label: "Zoom",      description: "400% zoom / 320px reflow test" },
  pointer:     { icon: MousePointer2, color: "#ff9f43", label: "Pointer",   description: "Touch target and gesture checks" },
};

const SEV_COLOR: Record<string, string> = {
  critical: "#ff4d6d", serious: "#ff9f43", moderate: "#ffd60a", minor: "#0b84a5"
};

function pageLabelFromUrl(value?: string) {
  const raw = String(value || "");
  try {
    const parsed = new URL(raw);
    const hash = decodeURIComponent(parsed.hash.replace(/^#/, "")).trim();
    if (hash) return hash;
    const path = parsed.pathname.split("/").filter(Boolean).pop();
    return path ? path.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : parsed.hostname;
  } catch {
    const hash = raw.split("#")[1];
    return hash ? decodeURIComponent(hash).trim() : "";
  }
}

function isNavigationOnlyPhase(value?: string) {
  const phase = String(value || "").trim().toLowerCase();
  return phase.startsWith("navigation:") || phase.startsWith("scan start:");
}

function ScreenshotCard({ snap, issueCount }: { snap: any; issueCount: number }) {
  const [enlarged, setEnlarged] = useState(false);
  return (
    <>
      <div
        className="relative rounded-lg overflow-hidden cursor-pointer group"
        style={{ border: issueCount > 0 ? "1px solid rgba(255,77,109,0.45)" : "1px solid rgba(255,255,255,0.07)" }}
        onClick={() => setEnlarged(true)}
      >
        <img src={snap.screenshot} alt={`${snap.phase} screenshot`} className="w-full object-cover" style={{ maxHeight: 160 }} />
        {issueCount > 0 && (
          <div
            className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold"
            style={{ background: "rgba(255,77,109,0.82)", color: "#fff" }}
            title={`${issueCount} issue${issueCount !== 1 ? "s" : ""} linked to this state + page`}
          >
            <AlertCircle size={10} />
            {issueCount} issue{issueCount !== 1 ? "s" : ""}
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: "rgba(0,0,0,0.5)" }}>
          <Camera size={20} className="text-white" />
        </div>
        <div className="absolute bottom-0 left-0 right-0 px-2 py-1 text-[10px] text-slate-300"
          style={{ background: "rgba(0,0,0,0.6)" }}>
          {snap.phase} · {snap.url ? new URL(snap.url).pathname : ""}
        </div>
      <a href={snap.screenshot} download={`accessibility_${(snap.phase || "state").replace(/[^a-z0-9]/gi, "_")}_${snap.id?.slice(0, 8) || "img"}.jpg`} className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "rgba(0,0,0,0.68)", color: "#fff" }} onClick={e => e.stopPropagation()}><Download size={10} /> Download</a></div>
      {enlarged && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-8"
          style={{ background: "rgba(0,0,0,0.9)" }}
          onClick={() => setEnlarged(false)}>
          <div onClick={e => e.stopPropagation()} className="relative max-w-5xl max-h-full overflow-auto rounded-xl">
            <img src={snap.screenshot} alt="Enlarged screenshot" className="max-w-full rounded-xl" />
            <button onClick={() => setEnlarged(false)}
              className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center text-white hover:bg-white/20 transition-all">
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function StatesTab({ scanId, focusedIssueId, preferredState, onBackToIssue }: { scanId: string; focusedIssueId?: string | null; preferredState?: string | null; onBackToIssue?: (issueId: string) => void }) {
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [wcagLevelFilter, setWcagLevelFilter] = useState("");
  const [pageFilter, setPageFilter] = useState("");
  const focusedIssueRef = useRef<HTMLDivElement | null>(null);

  const { data: issuesData, isLoading: issuesLoading } = useQuery({
    queryKey: ["issues", scanId, "all-states"],
    queryFn: () => issueApi.list({ scan_id: scanId, limit: 500 }),
  });

  const { data: snapshotData, isLoading: snapsLoading } = useQuery({
    queryKey: ["dom-snapshots", scanId],
    queryFn: () => scanApi.domSnapshots(scanId),
  });

  const allIssues: any[] = issuesData?.data?.issues || [];
  const allSnapshots: any[] = (snapshotData?.data?.snapshots || []).filter((snap: any) => !isNavigationOnlyPhase(snap.phase));

  // Group issues by state
  const byState = allIssues.reduce((acc: Record<string, any[]>, issue) => {
    const st = issue.state_label || "default";
    if (!acc[st]) acc[st] = [];
    acc[st].push(issue);
    return acc;
  }, {});

  // Group snapshots by phase
  const snapByPhase = allSnapshots.reduce((acc: Record<string, any[]>, snap) => {
    const ph = snap.phase || "initial";
    if (!acc[ph]) acc[ph] = [];
    acc[ph].push(snap);
    return acc;
  }, {});

  const states = Array.from(new Set([
    ...Object.keys(byState),
    ...Object.keys(snapByPhase),
  ]));

  const matchesWcagLevel = (issue: any) =>
    !wcagLevelFilter || getIssueComplianceLevels(issue).includes(wcagLevelFilter as any);
  const matchesPage = (value?: string) => !pageFilter || pageLabelFromUrl(value) === pageFilter;
  const pageOptions = Array.from(new Set([...allIssues.map(i => i.url), ...allSnapshots.map(s => s.url)].map(pageLabelFromUrl).filter(Boolean))).sort();

  const filteredByState = Object.fromEntries(
    Object.entries(byState).map(([state, issues]) => [state, (issues as any[]).filter((issue: any) => matchesWcagLevel(issue) && matchesPage(issue.url))])
  ) as Record<string, any[]>;
  const filteredSnapByPhase = Object.fromEntries(
    Object.entries(snapByPhase).map(([phase, snaps]) => [phase, (snaps as any[]).filter((snap: any) => matchesPage(snap.url))])
  ) as Record<string, any[]>;

  useEffect(() => {
    if (!preferredState) return;
    setSelectedState(preferredState);
  }, [preferredState]);

  useEffect(() => {
    if (!focusedIssueId) return;
    const t = window.setTimeout(() => focusedIssueRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    return () => window.clearTimeout(t);
  }, [focusedIssueId, selectedState, wcagLevelFilter, pageFilter]);

  if (issuesLoading || snapsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={22} className="animate-spin text-accent" />
      </div>
    );
  }

  const activeStateIssues = selectedState ? (filteredByState[selectedState] || []) : [];
  const activeStateSnaps = selectedState ? (filteredSnapByPhase[selectedState] || []) : [];

  return (
    <div className="flex h-full" style={{ minHeight: "calc(100vh - 200px)" }}>
      {/* State sidebar */}
      <div className="w-56 flex-shrink-0 border-r overflow-y-auto"
        style={{ borderColor: "rgba(255,255,255,0.05)", padding: "16px 8px" }}>
        <div className="text-xs font-semibold text-slate-600 px-3 mb-3 uppercase tracking-wide">UI States</div>
        {states.length === 0 ? (
          <p className="text-xs text-slate-600 px-3">No state data yet — run a scan with states enabled.</p>
        ) : states.map(state => {
          const meta = STATE_META[state] || { icon: Layers, color: "#64748b", label: state, description: "" };
          const Icon = meta.icon;
          const issueCount = (filteredByState[state] || []).length;
          const snapCount  = (filteredSnapByPhase[state] || []).length;
          const isActive   = selectedState === state;
          return (
            <button key={state} onClick={() => setSelectedState(isActive ? null : state)}
              className="w-full text-left px-3 py-3 rounded-lg text-xs transition-all mb-1 group"
              style={isActive
                ? { background: `${meta.color}12`, border: `1px solid ${meta.color}30` }
                : { border: "1px solid transparent" }}>
              <div className="flex items-center gap-2 mb-1">
                <Icon size={13} style={{ color: meta.color }} />
                <span className={`font-semibold ${isActive ? "" : "text-slate-400"}`}
                  style={isActive ? { color: meta.color } : {}}>
                  {meta.label}
                </span>
              </div>
              <div className="flex items-center gap-3 ml-5">
                {issueCount > 0 && (
                  <span className="text-[10px] text-red-400">{issueCount} issues</span>
                )}
                {snapCount > 0 && (
                  <span className="text-[10px] text-slate-600 flex items-center gap-0.5">
                    <Camera size={9} /> {snapCount}
                  </span>
                )}
                {issueCount === 0 && snapCount === 0 && (
                  <span className="text-[10px] text-slate-700">no data</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 flex items-center justify-end gap-3 flex-wrap">
          <select
            value={wcagLevelFilter}
            onChange={e => setWcagLevelFilter(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm text-slate-300 outline-none"
            style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}
          >
            <option value="">All WCAG Levels</option>
            <option value="A">Level A</option>
            <option value="AA">Level AA</option>
            <option value="AAA">Level AAA</option>
          </select>
          <select
            value={pageFilter}
            onChange={e => setPageFilter(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm text-slate-300 outline-none"
            style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}
          >
            <option value="">All selected pages</option>
            {pageOptions.map(label => <option key={label} value={label}>{label}</option>)}
          </select>
        </div>
        {!selectedState ? (
          /* Overview grid */
          <div>
            <h2 className="text-base font-semibold text-slate-200 mb-1">Multi-State Testing Overview</h2>
            <p className="text-xs text-slate-500 mb-6">
              Accessibility tests your pages across {states.length} distinct UI states — click a state to drill down.
            </p>
            <div className="grid grid-cols-3 gap-4">
              {states.map(state => {
                const meta = STATE_META[state] || { icon: Layers, color: "#64748b", label: state, description: "" };
                const Icon = meta.icon;
                const issues = filteredByState[state] || [];
                const snaps  = filteredSnapByPhase[state] || [];
                const sevCounts = issues.reduce((a: any, i: any) => { a[i.severity] = (a[i.severity]||0)+1; return a; }, {});
                return (
                  <motion.button key={state} onClick={() => setSelectedState(state)}
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    className="card card-hover text-left p-5 group"
                    style={{ cursor: "pointer" }}>
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ background: `${meta.color}15`, color: meta.color }}>
                        <Icon size={18} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-slate-200 group-hover:text-accent transition-colors">
                          {meta.label}
                        </div>
                        <div className="text-[11px] text-slate-600 mt-0.5">{meta.description}</div>
                      </div>
                    </div>

                    {issues.length > 0 ? (
                      <div className="flex items-center gap-3 flex-wrap">
                        {["critical","serious","moderate","minor"].map(sev =>
                          sevCounts[sev] ? (
                            <span key={sev} className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                              style={{ color: SEV_COLOR[sev], background: `${SEV_COLOR[sev]}15` }}>
                              {sevCounts[sev]} {sev}
                            </span>
                          ) : null
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-[11px] text-green-400">
                        <CheckCircle2 size={11} /> No issues in this state
                      </div>
                    )}

                    {snaps.length > 0 && (
                      <div className="flex items-center gap-1 text-[10px] text-slate-600 mt-2">
                        <Camera size={9} /> {snaps.length} screenshot{snaps.length !== 1 ? "s" : ""}
                      </div>
                    )}
                  </motion.button>
                );
              })}
            </div>
          </div>
        ) : (
          /* State detail */
          <div>
            {(() => {
              const meta = STATE_META[selectedState] || { icon: Layers, color: "#64748b", label: selectedState, description: "" };
              const Icon = meta.icon;
              const issues = filteredByState[selectedState] || [];
              const snaps  = (filteredSnapByPhase[selectedState] || []).filter((s: any) => s.screenshot);
              return (
                <>
                  <div className="flex items-center gap-3 mb-6">
                    <button onClick={() => setSelectedState(null)}
                      className="text-xs text-slate-500 hover:text-accent transition-colors">← All States</button>
                    <span className="text-slate-700">/</span>
                    <div className="flex items-center gap-2">
                      <Icon size={16} style={{ color: meta.color }} />
                      <span className="text-sm font-semibold" style={{ color: meta.color }}>{meta.label} State</span>
                    </div>
                    <span className="text-xs text-slate-600">— {meta.description}</span>
                  </div>

                  {/* Screenshots row */}
                  {snaps.length > 0 && (
                    <div className="mb-6">
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3 flex items-center gap-2">
                        <Camera size={12} /> Screenshots ({snaps.length})
                      </h3>
                      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                        {snaps.map((snap: any) => (
                          <ScreenshotCard
                            key={snap.id}
                            snap={snap}
                            issueCount={issues.filter((issue: any) => issue.url === snap.url).length}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Issues list */}
                  <div>
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
                      Issues in {meta.label} State ({issues.length})
                    </h3>
                    {issues.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center card">
                        <CheckCircle2 size={32} className="text-green-400/40 mb-3" />
                        <p className="text-slate-500 text-sm">No issues detected in the {meta.label} state.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {issues.map((issue: any) => (
                          <div key={issue.id} ref={issue.id === focusedIssueId ? focusedIssueRef : null} className="card px-5 py-4" style={issue.id === focusedIssueId ? { border: "1px solid rgba(167,139,250,0.55)", boxShadow: "0 0 0 1px rgba(167,139,250,0.35)" } : {}}>
                            <div className="flex items-start gap-3 flex-wrap mb-2">
                              <span className="text-xs font-semibold px-2.5 py-1 rounded-full border"
                                style={{ color: SEV_COLOR[issue.severity], background: `${SEV_COLOR[issue.severity]}12`, borderColor: `${SEV_COLOR[issue.severity]}30` }}>
                                {issue.severity}
                              </span>
                              <code className="text-[11px] font-mono text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">
                                {issue.rule_id}
                              </code>
                              {getIssueCriteria(issue).slice(0, 2).map((w: string) => (
                                <span key={w} className="text-[10px] px-2 py-0.5 rounded border"
                                  style={{ color: "#a78bfa", background: "rgba(167,139,250,0.08)", borderColor: "rgba(167,139,250,0.2)" }}>
                                  {formatWcagTag(w)}
                                </span>
                              ))}
                              {getIssueComplianceLevels(issue).slice(0, 2).map((level: string) => {
                                const color = levelColor(level as any);
                                return <span key={level} className="text-[10px] px-2 py-0.5 rounded-full border font-semibold" style={{ color, background: `${color}14`, borderColor: `${color}35` }}>Level {level}</span>;
                              })}
                            </div>
                            <p className="text-sm text-slate-300">{issue.message}</p>
                            {issue.selector && (
                              <p className="text-xs font-mono text-slate-600 mt-1 truncate">{issue.selector}</p>
                            )}
                            {(issue.evidence_screenshot || issue.evidence_explanation) && (
                              <div className="mt-3 p-3 rounded-lg" style={{ background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.08)" }}>
                                <div className="text-xs font-medium text-slate-300 mb-2 flex items-center gap-2">
                                  <Camera size={13} /> Issue Screenshot Evidence
                                </div>
                                {issue.evidence_explanation && (
                                  <p className="text-xs text-slate-400 leading-relaxed mb-3">{issue.evidence_explanation}</p>
                                )}
                                {issue.evidence_screenshot && (
                                  <img src={issue.evidence_screenshot} alt={`Screenshot evidence for ${issue.rule_id}`} className="w-full rounded-lg border border-white/10" style={{ maxHeight: 260, objectFit: "contain", background: "#05070b" }} />
                                )}
                              </div>
                            )}
                            {issue.fix_suggestion && (
                              <p className="text-xs text-accent mt-2 leading-relaxed"
                                style={{ background: "rgba(15,118,110,0.06)", padding: "6px 10px", borderRadius: 6 }}>
                                💡 {issue.fix_suggestion?.slice(0, 180)}
                              </p>
                            )}
                            {onBackToIssue && (
                              <div className="mt-3 pt-2 border-t border-white/10">
                                <button
                                  type="button"
                                  onClick={() => onBackToIssue(issue.id)}
                                  className="text-xs px-3 py-2 rounded-lg border border-accent/30 text-accent hover:bg-accent/10 transition-all"
                                >
                                  Back to this issue in Issues tab
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}




