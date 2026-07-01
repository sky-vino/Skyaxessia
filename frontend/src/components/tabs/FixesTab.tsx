import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issueApi } from "../../services/api";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Loader2, Copy, Check,
  AlertOctagon, AlertTriangle, Info, CheckCircle2, ExternalLink, Search, ArrowLeft, SlidersHorizontal
} from "lucide-react";
import { AccordionChevron } from "../ui/AccordionChevron";

const SEV_ICON: Record<string, any> = { critical: AlertOctagon, serious: AlertTriangle, moderate: AlertTriangle, minor: Info };
const SEV_COLOR: Record<string, string> = { critical: "#ff4d6d", serious: "#ff9f43", moderate: "#ffd60a", minor: "#0b84a5" };

const RULE_NAMES: Record<string, string> = {
  "axe:nested-interactive": "Nested Interactive Controls",
  "axe:label": "Missing Form Label",
  "heuristic:input-no-label": "Missing Form Label",
  "axe:color-contrast": "Insufficient Color Contrast",
  "heuristic:text-truncation": "Text Truncation Risk",
  "heuristic:target-size": "Small Touch Target",
  "focus:invisible": "Missing Visible Focus Indicator",
  "focus:trap-missing": "Missing Keyboard Focus Trap",
  "focus:obscured": "Obscured Focus Indicator",
  "axe:landmark-unique": "Landmark Needs Unique Name",
  "axe:meta-viewport": "Mobile Zoom Disabled",
  "heuristic:reflow": "Reflow or Small Screen Layout Risk",
  "heuristic:reduced-motion": "Motion Preference Not Respected",
  "heuristic:image-missing-alt": "Image Missing Alternative Text",
  "axe:aria-allowed-role": "Invalid ARIA Role",
};

function issueDisplayId(issue: any) { return String(issue.id || "unknown").slice(0, 8).toUpperCase(); }
function cleanLabel(value: string) { return (value || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(); }
function titleCase(value: string) { return cleanLabel(value).replace(/\b\w/g, c => c.toUpperCase()); }
function friendlyElementName(selector?: string) {
  if (!selector) return "Page-level issue";
  const cleaned = selector.replace(/:nth-(?:of-type|child)\(\d+\)/g, "").trim();
  const idMatch = cleaned.match(/#([a-zA-Z0-9_-]+)/);
  const roleMatch = cleaned.match(/\[role=["']?([^"'\]]+)/);
  const classMatch = cleaned.match(/\.([a-zA-Z0-9_-]+)/);
  const tagMatch = cleaned.match(/^([a-z0-9]+)/i) || cleaned.match(/\s([a-z0-9]+)(?:[#.\[:]|$)/i);
  const tag = (tagMatch?.[1] || "").toLowerCase();
  const typeMap: Record<string, string> = { a: "Link", button: "Button", input: "Input field", select: "Dropdown", textarea: "Text area", img: "Image", meta: "Page setting", form: "Form", nav: "Navigation", header: "Header", footer: "Footer", dialog: "Dialog", body: "Page body", html: "Document root" };
  const base = roleMatch?.[1] ? `${titleCase(roleMatch[1])} role` : typeMap[tag] || "Affected control or region";
  const label = idMatch?.[1] || classMatch?.[1] || "";
  return label ? `${base}: ${titleCase(label)}` : base;
}
function issueTitle(issue: any) {
  if (RULE_NAMES[issue.rule_id]) return RULE_NAMES[issue.rule_id];
  if (issue.rule_id?.startsWith("axe:")) return titleCase(issue.rule_id.replace("axe:", ""));
  if (issue.rule_id?.startsWith("heuristic:")) return titleCase(issue.rule_id.replace("heuristic:", ""));
  if (issue.category) return `${titleCase(issue.category)} Accessibility Issue`;
  return "Accessibility Issue";
}
function affectedCount(issue: any) { return issue.affected_count || issue.affectedCount || issue.selectors?.length || (issue.selector ? 1 : 0); }
function issueSubtitle(issue: any) {
  const count = affectedCount(issue);
  const where = friendlyElementName(issue.selector);
  return count > 1 ? `${where} (${count} grouped items)` : where;
}
function fallbackImpact(issue: any) {
  const text = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/nested-interactive/i.test(text)) return "Keyboard and screen reader users may encounter confusing focus and activation behavior when one control is placed inside another.";
  if (/label|input|form/i.test(text)) return "Screen reader users and voice-control users may not know what information a form field requires.";
  if (/focus/i.test(text)) return "Keyboard users may lose track of their current position or become blocked while navigating the page.";
  if (/contrast|color/i.test(text)) return "Low-vision users and users in bright environments may not be able to read or identify the affected content.";
  if (/viewport|zoom|reflow/i.test(text)) return "Mobile and low-vision users may be blocked from zooming or may need excessive scrolling to use the page.";
  if (/aria|role|landmark/i.test(text)) return "Assistive technology users may receive incorrect names, roles, states, or page structure.";
  return "This issue may affect users who rely on keyboard navigation, screen readers, zoom, or other assistive technologies.";
}
function aiUnavailableReason(issue: any) {
  if (!issue.ai_explanation && !issue.ai_fix_code) return "No AI fix has been generated for this issue yet. Use Generate AI Fix to create guidance before AI-assisted remediation.";
  return "AI guidance is incomplete for this issue. Review the scanner details, selector, and rule documentation.";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return <button onClick={copy} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all" style={{ background: "rgba(255,255,255,0.05)", color: copied ? "#0f766e" : "#64748b" }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}</button>;
}

function IssueCard({ issue, focused, onBackToIssue }: { issue: any; focused?: boolean; onBackToIssue?: (issueId: string) => void }) {
  const [expanded, setExpanded] = useState(Boolean(focused));
  const [aiData, setAiData] = useState<any>(null);
  const qc = useQueryClient();

  useEffect(() => { if (focused) setExpanded(true); }, [focused]);

  const aiMut = useMutation({
    mutationFn: () => issueApi.aiExplain(issue.id),
    onSuccess: (res) => { setAiData(res.data); setExpanded(true); qc.invalidateQueries({ queryKey: ["issues"] }); },
  });

  const ai = aiData || { explanation: issue.ai_explanation, impact: issue.ai_impact, fix_code: issue.ai_fix_code };
  const hasAi = Boolean(ai.explanation || ai.fix_code);
  const hasUsefulFix = Boolean(ai.fix_code && !/Please refer to WCAG documentation/i.test(ai.fix_code));
  const Icon = SEV_ICON[issue.severity] || Info;
  const color = SEV_COLOR[issue.severity] || "#0b84a5";

  return (
    <div className="card overflow-hidden card-hover" style={{ marginBottom: 10, borderColor: focused ? "rgba(15,118,110,0.65)" : undefined, boxShadow: focused ? "0 0 0 1px rgba(178,148,255,0.35)" : undefined }}>
      <div className="flex items-start gap-4 p-5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: `${color}15`, color }}><Icon size={16} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className="text-[10px] uppercase tracking-wide text-slate-600">Issue ID</span>
                <span className="font-mono text-xs text-slate-300 bg-white/[0.04] px-2 py-0.5 rounded">{issueDisplayId(issue)}</span>
                {focused && <span className="text-[10px] px-2 py-0.5 rounded-full text-accent bg-accent/10">Selected from Issues</span>}
                {issue.is_resolved && <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-green-400 bg-green-400/10"><CheckCircle2 size={11} /> Resolved</span>}
              </div>
              <p className="text-sm text-slate-100 font-semibold leading-snug whitespace-normal break-words">{issueTitle(issue)}</p>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed whitespace-normal break-words">{issueSubtitle(issue)}</p>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed whitespace-normal break-words">{issue.message}</p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <code className="text-[11px] font-mono px-2 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "#94a3b8" }}>{issue.rule_id}</code>
                {(issue.wcag_criteria || []).slice(0, 2).map((w: string) => <span key={w} className="text-[10px] px-2 py-0.5 rounded border" style={{ color: "#a78bfa", background: "rgba(167,139,250,0.08)", borderColor: "rgba(167,139,250,0.2)" }}>{w.replace("wcag", "WCAG ")}</span>)}
              </div>
            </div>
            <div className="flex-shrink-0 flex flex-col items-end gap-3">
              <div className="text-slate-500">
                <AccordionChevron open={expanded} framed size={14} className="!h-7 !w-7" />
              </div>
              <div className="flex justify-end gap-2 flex-wrap">
                {focused && onBackToIssue && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); onBackToIssue(issue.id); }} className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border font-semibold transition-all hover:bg-accent/10" style={{ borderColor: "rgba(15,118,110,0.45)", color: "#0f766e", background: "rgba(15,118,110,0.08)" }}>
                    <ArrowLeft size={12} /> Back to issue
                  </button>
                )}
                {!hasAi && (
                  <button onClick={(e) => { e.stopPropagation(); aiMut.mutate(); }} disabled={aiMut.isPending} className="sky-primary flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border font-semibold transition-all hover:opacity-90">
                    {aiMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{aiMut.isPending ? "Generating..." : "Generate AI Fix"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {expanded && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          <div className="p-5 space-y-5">
            {hasAi ? <>
              <div className="p-4 rounded-xl" style={{ background: "rgba(15,118,110,0.05)", border: "1px solid rgba(15,118,110,0.12)" }}><div className="flex items-center gap-2 mb-2"><Sparkles size={13} className="text-accent" /><span className="text-xs font-semibold text-accent">AI Fix Summary</span></div><p className="text-sm text-slate-300 leading-relaxed whitespace-normal break-words">{ai.explanation}</p></div>
              <div className="p-4 rounded-xl" style={{ background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.15)" }}><div className="text-xs font-semibold mb-2" style={{ color: "#a78bfa" }}>User impact</div><p className="text-sm text-slate-300 leading-relaxed whitespace-normal break-words">{ai.impact || fallbackImpact(issue)}</p></div>
              {hasUsefulFix ? <div><div className="flex items-center justify-between mb-2"><span className="text-xs font-semibold text-slate-400">Suggested code fix</span><CopyButton text={ai.fix_code} /></div><pre className="code-block p-4 text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap leading-relaxed">{ai.fix_code}</pre></div> : <div className="p-4 rounded-xl" style={{ background: "rgba(255,159,67,0.06)", border: "1px solid rgba(255,159,67,0.18)" }}><div className="text-xs font-semibold text-orange-300 mb-1">AI fix not available</div><p className="text-sm text-slate-400 leading-relaxed">{aiUnavailableReason(issue)}</p></div>}
            </> : <div className="p-4 rounded-xl" style={{ background: "rgba(255,159,67,0.06)", border: "1px solid rgba(255,159,67,0.18)" }}><div className="text-xs font-semibold text-orange-300 mb-1">AI fix not generated</div><p className="text-sm text-slate-400 leading-relaxed mb-4">{aiUnavailableReason(issue)}</p><button onClick={(e) => { e.stopPropagation(); aiMut.mutate(); }} disabled={aiMut.isPending} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-all" style={{ background: "rgba(15,118,110,0.1)", color: "#0f766e", border: "1px solid rgba(15,118,110,0.2)" }}>{aiMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{aiMut.isPending ? "Generating..." : "Generate AI Fix"}</button></div>}
            <div className="pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>{issue.help_url ? <a href={issue.help_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"><ExternalLink size={12} /> Rule documentation</a> : <span className="text-xs text-slate-600">No external rule documentation available.</span>}</div>
          </div>
        </motion.div>}
      </AnimatePresence>
    </div>
  );
}

export default function FixesTab({ scanId, focusedIssueId, onBackToIssue }: { scanId: string; focusedIssueId?: string | null; onBackToIssue?: (issueId: string) => void }) {
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!filtersOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = filterPanelRef.current;
      if (el && !el.contains(e.target as Node)) setFiltersOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [filtersOpen]);

  const { data, isLoading } = useQuery({
    queryKey: ["issues", scanId, "fixes", focusedIssueId],
    queryFn: async () => {
      if (focusedIssueId) {
        const res = await issueApi.get(focusedIssueId);
        return { data: { issues: res.data.issue ? [res.data.issue] : [] } };
      }
      return issueApi.list({ scan_id: scanId, is_resolved: false, limit: 200 });
    },
  });

  const issues: any[] = data?.data?.issues || [];
  const normalizedSearch = search.trim().toLowerCase();
  const sortedIssues = normalizedSearch
    ? issues.filter((issue: any) =>
        issueDisplayId(issue).toLowerCase().includes(normalizedSearch) ||
        String(issue.id || "").toLowerCase().includes(normalizedSearch) ||
        issueTitle(issue).toLowerCase().includes(normalizedSearch) ||
        String(issue.rule_id || "").toLowerCase().includes(normalizedSearch)
      )
    : issues;
  const visibleIssues = severity ? sortedIssues.filter((issue: any) => issue.severity === severity) : sortedIssues;
  const activeFilterCount = severity ? 1 : 0;

  return <div className="p-6">
    <div className="flex items-start justify-between mb-6 gap-4"><div><h2 className="text-base font-semibold text-slate-200">AI Fix Recommendations</h2><p className="text-xs text-slate-500 mt-1 leading-relaxed">{focusedIssueId ? "Showing the issue selected from the Issues tab. Generate AI guidance here if it has not been created yet." : "Each fix is mapped to an issue ID. Resolve decisions stay in the Issues tab; this tab provides AI guidance only."}</p></div></div>
    {!focusedIssueId && (
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="search-outline flex items-center gap-2 px-3 py-2 rounded-lg flex-1 min-w-48" style={{}}>
          <Search size={14} className="text-slate-500 flex-shrink-0" />
          <input className="bg-transparent text-sm text-slate-300 outline-none w-full placeholder-slate-600" placeholder="Search AI fixes by issue ID, rule, or fix name..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="relative flex-shrink-0" ref={filterPanelRef}>
          <button
            type="button"
            onClick={() => setFiltersOpen(v => !v)}
            aria-expanded={filtersOpen}
            aria-haspopup="true"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-300 outline-none transition-colors hover:bg-white/[0.04]"
            style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}
          >
            <SlidersHorizontal size={15} className="text-slate-500 flex-shrink-0" />
            Filters
            {activeFilterCount > 0 && (
              <span className="min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-bold flex items-center justify-center" style={{ background: "rgba(167,139,250,0.2)", color: "#c4b5fd" }}>
                {activeFilterCount}
              </span>
            )}
            <AccordionChevron open={filtersOpen} framed={false} size={14} className="text-slate-500" />
          </button>
          {filtersOpen && (
            <div
              className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl p-4 shadow-2xl space-y-3"
              style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}
              role="dialog"
              aria-label="AI fix filters"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-300">Refine AI fixes</span>
                {activeFilterCount > 0 && <button type="button" onClick={() => setSeverity("")} className="text-[11px] font-semibold text-accent hover:underline">Clear</button>}
              </div>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600">Severity</span>
                <select value={severity} onChange={e => setSeverity(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-slate-300 outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}>
                  <option value="">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="serious">Serious</option>
                  <option value="moderate">Moderate</option>
                  <option value="minor">Minor</option>
                </select>
              </label>
            </div>
          )}
        </div>
        <span className="text-xs text-slate-600">{visibleIssues.length} fixes</span>
      </div>
    )}
    {isLoading ? <div className="flex items-center justify-center py-20"><Loader2 size={20} className="animate-spin text-accent" /></div> : visibleIssues.length === 0 ? <div className="flex flex-col items-center justify-center py-20 text-center"><Sparkles size={40} className="text-accent/30 mb-4" /><p className="text-slate-500 text-sm">No unresolved issues to show for this filter.</p></div> : <div>{visibleIssues.map((issue: any) => <IssueCard key={issue.id} issue={issue} focused={issue.id === focusedIssueId} onBackToIssue={onBackToIssue} />)}</div>}
  </div>;
}



