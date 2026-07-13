import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issueApi } from "../../services/api";
import { motion, AnimatePresence } from "framer-motion";
import {
  ExternalLink, CheckCircle2,
  AlertOctagon, AlertTriangle, Info, Search, Loader2, Camera, Code2, Sparkles,
  MapPin, MousePointerClick, ClipboardCheck, Wrench, X, Layers, SlidersHorizontal,
} from "lucide-react";
import { AccordionChevron } from "../ui/AccordionChevron";
import { formatWcagTag, getIssueComplianceLevels, getIssueCriteria, levelColor } from "../../utils/wcag";

const SEV_CONFIG: Record<string, { color: string; bg: string; border: string; icon: any; label: string }> = {
  critical: { color: "#ff4d6d", bg: "rgba(255,77,109,0.1)",  border: "rgba(255,77,109,0.25)",  icon: AlertOctagon, label: "Critical" },
  serious:  { color: "#ff9f43", bg: "rgba(255,159,67,0.1)", border: "rgba(255,159,67,0.25)",  icon: AlertTriangle, label: "Serious" },
  moderate: { color: "#ffd60a", bg: "rgba(255,214,10,0.1)", border: "rgba(255,214,10,0.25)",  icon: AlertTriangle, label: "Moderate" },
  minor:    { color: "#0b84a5", bg: "rgba(0,207,232,0.1)",  border: "rgba(0,207,232,0.25)",   icon: Info, label: "Minor" },
};

function SeverityBadge({ severity }: { severity: string }) {
  const c = SEV_CONFIG[severity] || SEV_CONFIG.minor;
  const Icon = c.icon;
  return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border" style={{ color: c.color, background: c.bg, borderColor: c.border }}><Icon size={11} /> {c.label}</span>;
}

function PriorityBadge({ priority }: { priority?: number }) {
  const p = priority || 5;
  const label = p === 1 ? "Fix first" : p === 2 ? "High priority" : p === 3 ? "Medium priority" : p === 4 ? "Low priority" : "Backlog";
  const color = p <= 2 ? "#0f766e" : p === 3 ? "#ffd60a" : "#94a3b8";
  return <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border" style={{ color, background: `${color}14`, borderColor: `${color}35` }}>P{p} - {label}</span>;
}

function WcagBadge({ tag }: { tag: string }) {
  return <span className="text-[10px] px-2 py-0.5 rounded border" style={{ color: "#a78bfa", background: "rgba(167,139,250,0.08)", borderColor: "rgba(167,139,250,0.2)" }}>{formatWcagTag(tag)}</span>;
}

function ComplianceBadge({ level }: { level: string }) {
  const color = levelColor(level as any);
  return <span className="text-[10px] px-2 py-0.5 rounded-full border font-semibold" style={{ color, background: `${color}14`, borderColor: `${color}35` }}>Level {level}</span>;
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: any; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-2 mb-2">
      <Icon size={14} className="text-accent mt-0.5 flex-shrink-0" />
      <div>
        <div className="text-xs font-semibold text-slate-200">{title}</div>
        {subtitle && <div className="text-[11px] text-slate-600 mt-0.5">{subtitle}</div>}
      </div>
    </div>
  );
}

function getAffectedCount(issue: any) {
  return issue.affected_count || issue.affectedCount || issue.selectors?.length || (issue.selector ? 1 : 0);
}

function cleanLabel(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function titleCase(value: string) {
  return cleanLabel(value).replace(/\b\w/g, c => c.toUpperCase());
}

function pageLabelFromUrl(value?: string) {
  const raw = String(value || "");
  try {
    const parsed = new URL(raw);
    const hash = decodeURIComponent(parsed.hash.replace(/^#/, "")).trim();
    if (hash) return hash;
    const path = parsed.pathname.split("/").filter(Boolean).pop();
    return path ? titleCase(path) : parsed.hostname;
  } catch {
    const hash = raw.split("#")[1];
    return hash ? decodeURIComponent(hash).trim() : "";
  }
}

function friendlyElementName(selector: string) {
  if (!selector) return "Page-level item";

  const cleaned = selector.replace(/:nth-(?:of-type|child)\(\d+\)/g, "").trim();
  const idMatch = cleaned.match(/#([a-zA-Z0-9_-]+)/);
  const roleMatch = cleaned.match(/\[role=["']?([^"'\]]+)/);
  const ariaMatch = cleaned.match(/\[aria-label=["']([^"']+)/);
  const titleMatch = cleaned.match(/\[title=["']([^"']+)/);
  const classMatch = cleaned.match(/\.([a-zA-Z0-9_-]+)/);
  const tagMatch = cleaned.match(/^([a-z0-9]+)/i) || cleaned.match(/\s([a-z0-9]+)(?:[#.\[:]|$)/i);
  const tag = (tagMatch?.[1] || "").toLowerCase();

  const typeMap: Record<string, string> = {
    a: "Link",
    button: "Button",
    input: "Input field",
    select: "Dropdown",
    textarea: "Text area",
    img: "Image",
    meta: "Page setting",
    form: "Form",
    label: "Form label",
    nav: "Navigation region",
    main: "Main content region",
    header: "Header region",
    footer: "Footer region",
    dialog: "Dialog",
    body: "Page body",
    html: "Document root",
  };

  const base = roleMatch?.[1] ? `${titleCase(roleMatch[1])} role` : typeMap[tag] || "Affected control or region";
  const label = ariaMatch?.[1] || titleMatch?.[1] || idMatch?.[1] || classMatch?.[1] || "";
  return label ? `${base}: ${titleCase(label)}` : base;
}

function affectedElementLabels(issue: any) {
  const raw = issue.affected_elements || issue.affectedElements || [];
  if (Array.isArray(raw) && raw.length) return raw.map(String).filter(Boolean);
  return [];
}

function locationSummary(issue: any) {
  const count = getAffectedCount(issue);
  const labels = affectedElementLabels(issue);
  const location = labels[0] || (issue.selector ? friendlyElementName(issue.selector) : "Whole page or document metadata");
  if (count > 1) return `${location} (${count} matching items grouped)`;
  if (count === 1) return `${location} (1 affected item)`;
  return location;
}

function issueContextSummary(issue: any) {
  const parts: string[] = [];
  const state = issue.state_label || issue.state;
  const phase = issue.phase;
  if (state && state !== "default") parts.push(`State: ${cleanLabel(state)}`);
  if (phase && phase !== "initial") parts.push(`Phase: ${cleanLabel(phase)}`);
  parts.push(locationSummary(issue));
  return parts.join(" | ");
}

function issueDisplayId(issue: any) {
  return String(issue.id || "unknown").slice(0, 8).toUpperCase();
}

function hasAiFix(issue: any) {
  return Boolean(issue.ai_explanation || issue.ai_fix_code || issue.ai_impact);
}

function testerImpact(issue: any) {
  const count = getAffectedCount(issue);
  const text = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/focus:invisible/i.test(text)) return `Keyboard users may lose track of where they are. This pattern appears on ${count || "multiple"} focusable control${count === 1 ? "" : "s"}.`;
  if (/focus:obscured/i.test(text)) return "Keyboard focus may move to a control that is hidden behind another layer or sticky area.";
  if (/meta-viewport/i.test(text)) return "Mobile users may be blocked from zooming or scaling the page.";
  if (/color|contrast/i.test(text)) return "Some users may not be able to read the content clearly due to contrast.";
  if (/label|input|form/i.test(text)) return "Form users and screen reader users may not understand what information is required.";
  if (/aria|role|landmark/i.test(text)) return "Screen reader users may receive missing, confusing, or incorrect structure or control information.";
  if (/target-size|pointer/i.test(text)) return "Touch or mouse users may have difficulty activating small controls.";
  if (/reflow|zoom/i.test(text)) return "Users who zoom or use small screens may need extra scrolling or may miss content.";
  if (/nested-interactive/i.test(text)) return "Keyboard and screen reader users may get confusing focus behavior when one interactive control is placed inside another.";
  return "This issue may make the page harder to understand, navigate, or operate for users with disabilities.";
}

function testerAction(issue: any) {
  const text = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/nested-interactive/i.test(text)) return "Use Tab to reach the affected control. Confirm each interactive item receives focus separately and that activation does not trigger the wrong parent or child control.";
  if (/focus/i.test(text)) return "Use Tab and Shift+Tab on the page and confirm a clear visible indicator appears on every affected link, button, and input.";
  if (/meta-viewport/i.test(text)) return "On mobile or browser emulation, confirm the page allows pinch zoom and does not disable scaling.";
  if (/aria|role|landmark/i.test(text)) return "Review with a screen reader or accessibility tree and confirm the element has the correct name, role, state, and landmark purpose.";
  if (/color|contrast/i.test(text)) return "Verify the highlighted text or control remains readable in normal, hover, focus, and disabled states.";
  return "Reproduce the issue using the screenshot, page URL, and affected element summary before marking it fixed.";
}

function DeveloperDetails({ issue }: { issue: any }) {
  const [open, setOpen] = useState(false);
  const selectors = issue.selectors || (issue.selector ? [issue.selector] : []);
  const affectedLabels = affectedElementLabels(issue);
  return (
    <div className="rounded-lg" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <button type="button" onClick={() => setOpen(!open)} className="solid-section-header w-full px-4 py-3 flex items-center justify-between gap-3 text-left rounded-lg transition-colors">
        <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-300"><Code2 size={14} /> Developer details</span>
        <span className="inline-flex items-center gap-2 text-[11px] text-slate-600">
          Selectors, HTML, ownership
          <AccordionChevron open={open} framed size={14} className="!h-7 !w-7" />
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4">
          <p className="text-xs text-slate-500 leading-relaxed">Use these technical details to locate the affected components in the page and source code. Testers can usually rely on the summary above.</p>
          {affectedLabels.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-2 font-medium">Affected components ({affectedLabels.length})</div>
              <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                {affectedLabels.slice(0, 20).map((label: string, i: number) => (
                  <div key={i} className="code-block px-3 py-1.5 text-xs text-slate-300 flex items-start gap-2">
                    <span className="text-slate-600 flex-shrink-0">[{i + 1}]</span>
                    <span className="min-w-0 break-words">{label}</span>
                  </div>
                ))}
                {affectedLabels.length > 20 && <p className="text-xs text-slate-600 pl-3">+{affectedLabels.length - 20} more grouped components</p>}
              </div>
            </div>
          )}
          {selectors.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-2 font-medium">Affected selectors ({selectors.length})</div>
              <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                {selectors.slice(0, 20).map((sel: string, i: number) => (
                  <div key={i} className="code-block px-3 py-1.5 text-xs text-slate-300 flex items-start gap-2">
                    <span className="text-slate-600 flex-shrink-0">[{i + 1}]</span>
                    <span className="min-w-0 break-all">{sel}</span>
                  </div>
                ))}
                {selectors.length > 20 && <p className="text-xs text-slate-600 pl-3">+{selectors.length - 20} more grouped selectors</p>}
              </div>
            </div>
          )}
          {issue.html_snippet && (
            <div>
              <div className="text-xs text-slate-400 mb-2 font-medium">HTML snippet</div>
              <pre className="code-block p-3 text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap">{issue.html_snippet}</pre>
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-xs text-slate-500">
            {issue.component_id && <span>Component: <span className="text-slate-300">{issue.component_id}</span></span>}
            {issue.component_owner && <span>Owner: <span className="text-slate-300">{issue.component_owner}</span></span>}
            {issue.help_url && <a href={issue.help_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink size={11} /> Rule documentation</a>}
          </div>
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue, onResolveRequest, onAiAssist, onOpenState, focused }: { issue: any; onResolveRequest: (issue: any) => void; onAiAssist: (issue: any) => void; onOpenState?: (issue: any) => void; focused?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    window.setTimeout(() => rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }, [focused]);

  const criteria = getIssueCriteria(issue).slice(0, 2);
  const levels = getIssueComplianceLevels(issue).slice(0, 2);

  return (
    <div ref={rowRef} className={`card-hover transition-all ${issue.is_resolved ? "opacity-50" : ""}`} style={{ background: "var(--surface-1)", border: focused ? "1px solid rgba(15,118,110,0.65)" : "1px solid var(--border)", boxShadow: focused ? "0 0 0 1px rgba(178,148,255,0.35)" : undefined, borderRadius: 10, marginBottom: 12 }}>
      <div className="p-5">
        <div className="flex items-start gap-4">

          <div className="flex-1 min-w-0 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <SeverityBadge severity={issue.severity} />
                  <PriorityBadge priority={issue.priority} />
                  {issue.is_resolved && <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full text-green-400 bg-green-400/10"><CheckCircle2 size={11} /> Resolved</span>}
                  {/* Ship 2 / Item 5 — cross-URL landmark grouping */}
                  {issue.page_occurrences && issue.page_occurrences > 1 && (
                    <span
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold"
                      style={{ color: "#a78bfa", background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.3)" }}
                      title={`Same issue appears on ${issue.page_occurrences} pages: ${(issue.page_urls || []).slice(0, 5).join(", ")}${(issue.page_urls || []).length > 5 ? " …" : ""}`}
                    >
                      Appears on {issue.page_occurrences} pages
                    </span>
                  )}
                </div>
                <div>
                  <p className="text-base text-slate-100 leading-relaxed font-semibold whitespace-normal break-words">{issue.message}</p>
                  <p className="text-xs text-slate-500 mt-1">Issue ID: <span className="font-mono text-slate-300">{issueDisplayId(issue)}</span></p>
                  <p className="text-xs text-slate-600 mt-1 leading-relaxed">Issue instance: {issueContextSummary(issue)}</p>
                  <div className="flex items-center gap-2 flex-wrap mt-2">
                    <span className="text-[10px] uppercase tracking-wide text-slate-600">Rule</span>
                    <code className="text-xs text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded font-mono">{issue.rule_id}</code>
                    {criteria.map((w: string) => <WcagBadge key={w} tag={w} />)}
                    {levels.map((level: string) => <ComplianceBadge key={level} level={level} />)}
                  </div>
                </div>
              </div>
              <button type="button" className="flex-shrink-0 h-8 w-8 rounded-lg border border-white/10 flex items-center justify-center text-slate-400 hover:border-accent/40 hover:text-accent transition-all" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Collapse issue" : "Expand issue"}>
                <AccordionChevron open={expanded} framed={false} size={16} />
              </button>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              <div className="rounded-lg px-3 py-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-1">Tester impact</div>
                <p className="text-sm text-slate-400 leading-relaxed">{testerImpact(issue)}</p>
              </div>

              <div className="rounded-lg px-3 py-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-1">Where it occurs</div>
                <p className="text-sm text-slate-400 leading-relaxed flex items-start gap-1.5"><MapPin size={13} className="mt-0.5 flex-shrink-0" /> <span>{locationSummary(issue)}</span></p>
              </div>
            </div>

            <div className="flex items-end justify-between gap-3 flex-wrap pt-1">
              <div className="flex flex-col gap-2 min-w-0">
                <button type="button" onClick={() => setExpanded(!expanded)} className="inline-flex items-center gap-2 text-xs font-semibold rounded-lg px-3 py-2 border transition-all text-accent hover:bg-accent/10 w-fit" style={{ borderColor: "rgba(15,118,110,0.45)", background: expanded ? "rgba(178,148,255,0.16)" : "rgba(15,118,110,0.08)" }}>
                  <MousePointerClick size={13} /> {expanded ? "Hide evidence and fix details" : "View evidence, tester steps, and developer details"}
                </button>
                {issue.url && <a href={issue.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-accent max-w-md min-w-0"><ExternalLink size={11} className="flex-shrink-0" /><span className="text-slate-600 flex-shrink-0">Page:</span><span className="truncate">{issue.url}</span></a>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                <button onClick={e => { e.stopPropagation(); onOpenState?.(issue); }} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border font-semibold transition-all hover:bg-white/[0.04]" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,0.4)", background: "rgba(167,139,250,0.08)" }}>
                  <Layers size={12} /> UI State
                </button>
                <button onClick={e => { e.stopPropagation(); onAiAssist(issue); }} className="sky-primary flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border font-semibold transition-all hover:opacity-90">
                  <Sparkles size={12} /> AI Assist
                </button>
                <button onClick={e => { e.stopPropagation(); onResolveRequest(issue); }} disabled={issue.is_resolved} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border font-semibold transition-all disabled:cursor-default" style={issue.is_resolved ? { color: "#14532d", borderColor: "rgba(34,197,94,0.45)", background: "rgba(34,197,94,0.18)" } : { color: "#ecfdf5", borderColor: "rgba(16,185,129,0.55)", background: "#059669" }}>
                  <CheckCircle2 size={12} /> {issue.is_resolved ? "Resolved" : "Resolve"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
            <div className="p-5 space-y-4">
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
                <div className="p-4 rounded-lg" style={{ background: "rgba(15,118,110,0.055)", border: "1px solid rgba(15,118,110,0.14)" }}>
                  <SectionTitle icon={ClipboardCheck} title="Tester verification" subtitle="Use this before marking the issue as passed or resolved." />
                  <p className="text-sm text-slate-300 leading-relaxed">{testerAction(issue)}</p>
                </div>

                {issue.fix_suggestion && (
                  <div className="p-4 rounded-lg" style={{ background: "rgba(15,118,110,0.045)", border: "1px solid rgba(15,118,110,0.12)" }}>
                    <SectionTitle icon={Wrench} title="Recommended fix" subtitle="Primary remediation guidance for the development team." />
                    <p className="text-sm text-slate-300 leading-relaxed">{issue.fix_suggestion}</p>
                  </div>
                )}
              </div>

              {(issue.evidence_screenshot || issue.evidence_explanation) && (
                <div className="p-4 rounded-lg" style={{ background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <SectionTitle icon={Camera} title="Screenshot evidence" subtitle="Visual proof captured during the scan, when available." />
                  {issue.evidence_explanation && <p className="text-sm text-slate-400 leading-relaxed mb-3">{issue.evidence_explanation}</p>}
                  {issue.evidence_screenshot && <img src={issue.evidence_screenshot} alt={`Screenshot evidence for ${issue.rule_id}`} className="w-full rounded-lg border border-white/10" style={{ maxHeight: 360, objectFit: "contain", background: "#05070b" }} />}
                </div>
              )}

              <DeveloperDetails issue={issue} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IssueSection({ title, description, issues, total, children, onResolveRequest, onAiAssist, onOpenState, focusedIssueId, open, onToggle }: { title: string; description: string; issues: any[]; total: number; children?: any; onResolveRequest: (issue: any) => void; onAiAssist: (issue: any) => void; onOpenState?: (issue: any) => void; focusedIssueId?: string | null; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-lg" style={{ background: "rgba(255,255,255,0.018)", border: "1px solid rgba(255,255,255,0.055)" }}>
      <button type="button" onClick={onToggle} className="solid-section-header w-full px-4 py-3 flex items-center justify-between gap-3 text-left rounded-lg transition-colors">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-300">{title} ({total})</div>
          <div className="text-xs text-slate-600 mt-0.5 leading-relaxed whitespace-normal break-words">{description}</div>
        </div>
        <span className="flex-shrink-0"><AccordionChevron open={open} size={15} /></span>
        <span className="sr-only">{open ? "Collapse" : "Expand"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="px-3 pb-3">
              {issues.length > 0 ? issues.map((issue: any) => <IssueRow key={issue.id} issue={issue} focused={issue.id === focusedIssueId} onResolveRequest={onResolveRequest} onAiAssist={onAiAssist} onOpenState={onOpenState} />) : <div className="px-3 py-5 text-sm text-slate-600">No issues in this group.</div>}
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function IssuesTab({ scanId, onOpenAiFix, onOpenState, focusedIssueId }: { scanId: string; onOpenAiFix?: (issueId: string) => void; onOpenState?: (issue: any) => void; focusedIssueId?: string | null }) {
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [wcagLevel, setWcagLevel] = useState("");
  const [pageFilter, setPageFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<any>(null);
  const [aiUnavailable, setAiUnavailable] = useState<any>(null);

  const [sectionOpen, setSectionOpen] = useState({ unresolved: false, resolved: false });
  const [filterEmptyDismissed, setFilterEmptyDismissed] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelRef = useRef<HTMLDivElement | null>(null);

  const activeSubfilterCount = [severity, category, priority, wcagLevel, pageFilter].filter(Boolean).length;

  useEffect(() => {
    if (!filtersOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFiltersOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtersOpen]);

  useEffect(() => {
    if (!filtersOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = filterPanelRef.current;
      if (el && !el.contains(e.target as Node)) setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filtersOpen]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const qc = useQueryClient();
  const resolveMut = useMutation({
    mutationFn: (issue: any) => issueApi.patch(issue.id, { is_resolved: true }),
    onSuccess: (_res, issue) => {
      qc.invalidateQueries({ queryKey: ["issues"] });
      
      setNotice(issue);
    },
  });

  const handleResolveRequest = (issue: any) => {
    if (issue.is_resolved) return;
    resolveMut.mutate(issue);
  };

  const handleAiAssist = (issue: any) => {
    if (onOpenAiFix) {
      onOpenAiFix(issue.id);
      return;
    }
    setAiUnavailable(issue);
  };

  const baseParams = { scan_id: scanId, severity: severity || undefined, category: category || undefined, priority: priority || undefined };

  const { data: unresolvedData, isLoading: unresolvedLoading } = useQuery({
    queryKey: ["issues", scanId, severity, category, priority, pageFilter, "unresolved", page],
    queryFn: () => issueApi.list({ ...baseParams, is_resolved: false, page: pageFilter ? 1 : page, limit: pageFilter ? 1000 : 30 }),
  });

  const { data: resolvedData, isLoading: resolvedLoading } = useQuery({
    queryKey: ["issues", scanId, severity, category, priority, "resolved"],
    queryFn: () => issueApi.list({ ...baseParams, is_resolved: true, page: 1, limit: 1000 }),
  });

  const unresolvedIssues: any[] = unresolvedData?.data?.issues || [];
  const resolvedIssues: any[] = resolvedData?.data?.issues || [];
  const unresolvedTotal: number = unresolvedData?.data?.total || 0;
  const resolvedTotal: number = resolvedData?.data?.total || 0;
  const apiGrandTotal = unresolvedTotal + resolvedTotal;
  const totalPages = pageFilter ? 1 : Math.ceil(unresolvedTotal / 30);
  const isLoading = unresolvedLoading || resolvedLoading;

  const matchesSearch = (i: any) => !search ||
    i.message?.toLowerCase().includes(search.toLowerCase()) ||
    i.rule_id?.toLowerCase().includes(search.toLowerCase()) ||
    issueDisplayId(i).toLowerCase().includes(search.toLowerCase()) ||
    locationSummary(i).toLowerCase().includes(search.toLowerCase());

  const matchesWcagLevel = (i: any) => !wcagLevel || getIssueComplianceLevels(i).includes(wcagLevel as any);
  const matchesPage = (i: any) => !pageFilter || pageLabelFromUrl(i.url) === pageFilter;

  const visibleUnresolved = unresolvedIssues.filter(i => matchesSearch(i) && matchesWcagLevel(i) && matchesPage(i));
  const visibleResolved = resolvedIssues.filter(i => matchesSearch(i) && matchesWcagLevel(i) && matchesPage(i));
  const pageOptions = Array.from(new Set([...unresolvedIssues, ...resolvedIssues].map(i => pageLabelFromUrl(i.url)).filter(Boolean))).sort();

  const filtersActive = Boolean(severity || category || priority || search || wcagLevel || pageFilter);
  const clientRefine = Boolean(search || wcagLevel || pageFilter);
  const displayUnresolvedCount = clientRefine ? visibleUnresolved.length : unresolvedTotal;
  const displayResolvedCount = clientRefine ? visibleResolved.length : resolvedTotal;
  const displayGrandTotal = clientRefine
    ? visibleUnresolved.length + visibleResolved.length
    : apiGrandTotal;

  const nothingVisible = visibleUnresolved.length === 0 && visibleResolved.length === 0;
  useEffect(() => {
    setFilterEmptyDismissed(false);
  }, [severity, category, priority, search, wcagLevel, pageFilter]);

  const showFilterEmptyDialog = !isLoading && filtersActive && nothingVisible;
  const showFilterEmptyToast = showFilterEmptyDialog && !filterEmptyDismissed;

  useEffect(() => {
    if (!showFilterEmptyToast) return;
    const t = window.setTimeout(() => setFilterEmptyDismissed(true), 5000);
    return () => window.clearTimeout(t);
  }, [showFilterEmptyToast]);

  useEffect(() => {
    if (!focusedIssueId) return;
    const hasFocusedUnresolved = unresolvedIssues.some((issue: any) => issue.id === focusedIssueId);
    const hasFocusedResolved = resolvedIssues.some((issue: any) => issue.id === focusedIssueId);
    if (hasFocusedUnresolved) setSectionOpen(prev => ({ ...prev, unresolved: true }));
    if (hasFocusedResolved) setSectionOpen(prev => ({ ...prev, resolved: true }));
  }, [focusedIssueId, unresolvedIssues, resolvedIssues]);

  const resetFilters = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  const clearSubfilters = () => {
    setSeverity("");
    setCategory("");
    setPriority("");
    setWcagLevel("");
    setPageFilter("");
    setPage(1);
  };

  return (
    <div className="p-6 relative">
      <AnimatePresence>
        {showFilterEmptyToast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-5 right-5 z-50 w-80 rounded-xl p-4 shadow-2xl"
            style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }}
            role="alert"
            aria-live="polite"
          >
            <button type="button" onClick={() => setFilterEmptyDismissed(true)} className="absolute top-2 right-2 text-slate-500 hover:text-slate-200" aria-label="Close notification"><X size={14} /></button>
            <div className="flex items-start gap-3 pr-6">
              <Info size={18} className="text-accent flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-semibold text-slate-100">No issues match this filter</div>
                <div className="text-xs text-slate-500 mt-1 leading-relaxed">Try adjusting severity, category, WCAG level, priority, or search.</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-5 right-5 z-50 w-80 rounded-xl p-4 shadow-2xl"
            style={{ background: "var(--surface-1)", border: "1px solid rgba(34,197,94,0.35)" }}
            role="status"
            aria-live="polite"
          >
            <button type="button" onClick={() => setNotice(null)} className="absolute top-2 right-2 text-slate-500 hover:text-slate-200" aria-label="Close notification"><X size={14} /></button>
            <div className="flex items-start gap-3 pr-5">
              <CheckCircle2 size={18} className="text-green-400 flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-semibold text-slate-100">Issue resolved</div>
                <div className="text-xs text-slate-500 mt-1 leading-relaxed">Issue ID <span className="font-mono text-green-300">{issueDisplayId(notice)}</span> has been marked as resolved.</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {aiUnavailable && (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.45)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }} className="w-full max-w-lg rounded-xl p-5 shadow-2xl" style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }}>
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-100">AI Assist not available</h3>
                  <p className="text-xs text-slate-500 mt-1">Issue ID: <span className="font-mono text-slate-300">{issueDisplayId(aiUnavailable)}</span></p>
                </div>
                <button type="button" onClick={() => setAiUnavailable(null)} className="text-slate-500 hover:text-slate-200" aria-label="Close dialog"><X size={16} /></button>
              </div>
              <p className="text-sm text-slate-400 leading-relaxed mb-4">No AI fix card or guidance is available for this issue yet. The Resolve button is still available on the issue card after you verify the fix manually.</p>
              <div className="rounded-lg p-3 mb-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                <p className="text-xs text-slate-500 leading-relaxed whitespace-normal break-words">{aiUnavailable.message}</p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => setAiUnavailable(null)} className="px-3 py-2 text-xs rounded-lg border border-white/10 text-slate-400 hover:bg-white/[0.04]">Close</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="search-outline flex items-center gap-2 px-3 py-2 rounded-lg flex-1 min-w-48" style={{}}>
          <Search size={14} className="text-slate-500 flex-shrink-0" />
          <input className="bg-transparent text-sm text-slate-300 outline-none w-full placeholder-slate-600" placeholder="Search issue ID, rules, messages, or locations..." value={search} onChange={e => setSearch(e.target.value)} />
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
            {activeSubfilterCount > 0 && (
              <span className="min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-bold flex items-center justify-center" style={{ background: "rgba(167,139,250,0.2)", color: "#c4b5fd" }}>
                {activeSubfilterCount}
              </span>
            )}
            <AccordionChevron open={filtersOpen} framed={false} size={14} className="text-slate-500" />
          </button>
          {filtersOpen && (
            <div
              className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl p-4 shadow-2xl space-y-3"
              style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}
              role="dialog"
              aria-label="Issue filters"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-300">Refine issues</span>
                {activeSubfilterCount > 0 && (
                  <button type="button" onClick={clearSubfilters} className="text-[11px] font-semibold text-accent hover:underline">
                    Clear all
                  </button>
                )}
              </div>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600">Severity</span>
                <select value={severity} onChange={e => resetFilters(setSeverity, e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-slate-300 outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}>
                  <option value="">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="serious">Serious</option>
                  <option value="moderate">Moderate</option>
                  <option value="minor">Minor</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600">Category</span>
                <select value={category} onChange={e => resetFilters(setCategory, e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-slate-300 outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}>
                  <option value="">All categories</option>
                  <option value="wcag">WCAG</option>
                  <option value="focus">Focus</option>
                  <option value="keyboard">Keyboard</option>
                  <option value="contrast">Contrast</option>
                  <option value="aria">ARIA</option>
                  <option value="pointer">Pointer</option>
                  <option value="zoom">Zoom</option>
                  <option value="readability">Readability</option>
                  <option value="interaction">Interaction</option>
                  <option value="advisory">Advisory / Best-practice</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600">Category subtype: page</span>
                <select value={pageFilter} onChange={e => { setPageFilter(e.target.value); setPage(1); }} className="w-full px-3 py-2 rounded-lg text-sm text-slate-300 outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}>
                  <option value="">All selected pages</option>
                  {pageOptions.map(label => <option key={label} value={label}>{label}</option>)}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600">WCAG conformance</span>
                <select value={wcagLevel} onChange={e => setWcagLevel(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-slate-300 outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}>
                  <option value="">All WCAG levels</option>
                  <option value="A">Level A</option>
                  <option value="AA">Level AA</option>
                  <option value="AAA">Level AAA</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600">Priority</span>
                <select value={priority} onChange={e => resetFilters(setPriority, e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-slate-300 outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}>
                  <option value="">All priorities</option>
                  <option value="1">P1 - Fix first</option>
                  <option value="2">P2 - High priority</option>
                  <option value="3">P3 - Medium priority</option>
                  <option value="4">P4 - Low priority</option>
                  <option value="5">P5 - Backlog</option>
                </select>
              </label>
            </div>
          )}
        </div>
        <span className="text-xs text-slate-600 ml-auto sm:ml-0">{displayGrandTotal} issues</span>
      </div>

      {isLoading ? <div className="flex items-center justify-center py-20"><Loader2 size={20} className="animate-spin text-accent" /></div> : apiGrandTotal === 0 && !filtersActive ? (
        <div className="flex flex-col items-center justify-center py-20 text-center"><CheckCircle2 size={40} className="text-green-400/30 mb-4" /><p className="text-slate-500 text-sm">No issues recorded for this scan.</p></div>
      ) : nothingVisible ? (
        <div className="flex flex-col items-center justify-center py-16 text-center min-h-[120px]"><p className="text-slate-600 text-sm">Adjust filters or search to see matching issues.</p></div>
      ) : (
        <div className="space-y-4">
          <IssueSection title="Unresolved issues" description="Open items that still need fixing or verification." issues={visibleUnresolved} total={displayUnresolvedCount} onResolveRequest={handleResolveRequest} onAiAssist={handleAiAssist} onOpenState={onOpenState} focusedIssueId={focusedIssueId} open={sectionOpen.unresolved} onToggle={() => setSectionOpen(prev => ({ ...prev, unresolved: !prev.unresolved }))}>
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 text-xs text-slate-400 rounded-lg border border-white/10 disabled:opacity-40 hover:bg-white/[0.04] transition-all">Previous</button>
                <span className="text-xs text-slate-600">Unresolved page {page} of {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-4 py-2 text-xs text-slate-400 rounded-lg border border-white/10 disabled:opacity-40 hover:bg-white/[0.04] transition-all">Next</button>
              </div>
            )}
          </IssueSection>
          <IssueSection title="Resolved issues" description="Items marked resolved. They stay visible here for audit and review." issues={visibleResolved} total={displayResolvedCount} onResolveRequest={handleResolveRequest} onAiAssist={handleAiAssist} onOpenState={onOpenState} focusedIssueId={focusedIssueId} open={sectionOpen.resolved} onToggle={() => setSectionOpen(prev => ({ ...prev, resolved: !prev.resolved }))} />
        </div>
      )}
    </div>
  );
}








