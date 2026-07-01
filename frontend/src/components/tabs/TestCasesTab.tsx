import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { scanApi } from "../../services/api";
import { motion } from "framer-motion";
import {
  CheckCircle2, XCircle, Clock, Loader2, SlidersHorizontal,
} from "lucide-react";
import { AccordionChevron } from "../ui/AccordionChevron";
import { useEffect, useRef, useState } from "react";

const STATUS_CONFIG: Record<string, { icon: any; color: string; bg: string; label: string }> = {
  pass:    { icon: CheckCircle2, color: "#22c55e", bg: "rgba(34,197,94,0.1)",   label: "Pass" },
  fail:    { icon: XCircle,      color: "#ff4d6d", bg: "rgba(255,77,109,0.1)",  label: "Fail" },
  pending: { icon: Clock,        color: "#94a3b8", bg: "rgba(148,163,184,0.1)", label: "In Progress" },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const Icon = c.icon;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
      style={{ color: c.color, background: c.bg, border: `1px solid ${c.color}35` }}>
      <Icon size={11} /> {c.label}
    </span>
  );
}

function cleanName(name: string) {
  return (name || "Untitled test case")
    .replace(/^\[(MANUAL|HYBRID)\]\s*/i, "")
    .replace(/^\[[A-Z]+\]\s*/, "")
    .trim();
}

function prettyRuleName(ruleId?: string) {
  const map: Record<string, string> = {
    "axe:nested-interactive": "Nested interactive controls",
    "axe:aria-required-children": "ARIA required children",
    "axe:aria-allowed-role": "ARIA role validity",
    "axe:landmark-unique": "Landmark naming",
    "axe:meta-viewport": "Mobile zoom support",
    "axe:autocomplete-valid": "Autocomplete attribute validation",
    "color:focus-indicator-low-contrast": "Focus indicator contrast",
    "heuristic:input-no-label": "Form label coverage",
    "heuristic:image-missing-alt": "Image alternative text",
    "heuristic:text-truncation": "Text truncation risk",
    "heuristic:target-size": "Touch target size",
    "heuristic:reflow": "Reflow and small-screen layout",
    "heuristic:landmark-main-missing": "Main landmark availability",
    "heuristic:status-message": "Status message announcement",
    "focus:invisible": "Visible focus indicator",
    "focus:trap-missing": "Keyboard focus trap",
    "focus:escape-key-missing": "Escape key modal dismissal",
    "keyboard:tab-order": "Keyboard tab order",
    "keyboard:arrow-key-no-response": "Composite widget arrow-key navigation",
    "pointer:target-size-minimum": "Touch target size",
  };
  if (!ruleId) return "Accessibility requirement";
  if (map[ruleId]) return map[ruleId];
  return ruleId
    .replace(/^(axe|heuristic|keyboard|focus|pointer|zoom):/i, "")
    .replace(/[-_:]+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function compactUrl(value?: string) {
  const url = String(value || "");
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname}${path}`;
  } catch {
    return url.replace(/^https?:\/\//, "").split(/[?#]/)[0] || "";
  }
}

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

function firstUrl(value?: string) {
  return String(value || "").match(/https?:\/\/\S+/i)?.[0] || "";
}

function testCasePageLabel(tc: any) {
  return pageLabelFromUrl(tc.issue_url || tc.issueUrl || firstUrl(`${tc.description || ""} ${tc.result || ""}`));
}

function stripUrls(value?: string) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+on\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function automatedCaseName(tc: any) {
  const text = `${tc.name || ""} ${tc.description || ""}`;
  const ruleMatch = text.match(/(?:Verify|Rule:)\s*([a-z]+:[a-z0-9-]+)/i) || text.match(/\b((?:axe|heuristic|keyboard|focus|pointer|zoom|color):[a-z0-9-]+)\b/i);
  const ruleName = prettyRuleName(tc.rule_id || tc.ruleId || ruleMatch?.[1]);
  return `${ruleName} check`;
}

function displayName(tc: any, showSteps: boolean) {
  if (!showSteps) return automatedCaseName(tc);
  return stripUrls(cleanName(tc.name)).replace(/\s*:\s*$/, "").trim();
}

function displayDescription(tc: any, showSteps: boolean) {
  const text = `${tc.name || ""} ${tc.description || ""}`;
  if (!showSteps) return "Verify this accessibility requirement is resolved for the affected page.";
  if (/screen reader/i.test(text)) return "Validate reading order, announcements, names, roles, and state changes with assistive technology.";
  if (/keyboard-only|keyboard validation/i.test(text)) return "Validate the main task flow using keyboard-only navigation.";
  if (/dynamic|menus|modals|accordions|tabs/i.test(text)) return "Validate task-critical interactive states such as dialogs, menus, accordions, tabs, and validation states.";
  if (/responsive|zoom|touch/i.test(text)) return "Validate zoom, reflow, mobile viewport behavior, touch targets, and orientation support.";
  if (/form completion|error recovery|form validation/i.test(text)) return "Validate form submission, error identification, recovery guidance, autocomplete, and success messaging.";
  return stripUrls(tc.description) || "Review the listed steps and mark the case after verification.";
}

function isManualCase(tc: any) {
  return tc.category === "manual-review" || (tc.status === "manual" && !/hybrid/i.test(tc.category || ""));
}

function isHybridCase(tc: any) {
  return tc.category === "hybrid-review" || /hybrid/i.test(tc.category || "");
}


function sortTestCases(cases: any[]) {
  const rank: Record<string, number> = { fail: 0, pending: 1, pass: 2 };
  return [...cases].sort((a, b) => {
    const statusDiff = (rank[a.status] ?? 1) - (rank[b.status] ?? 1);
    if (statusDiff !== 0) return statusDiff;
    return String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""));
  });
}
function TestCaseRow({ tc, scanId, showSteps }: { tc: any; scanId: string; showSteps: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const steps: string[] = showSteps ? (tc.steps || []) : [];
  const qc = useQueryClient();
  const pageUrl = firstUrl(`${tc.description || ""} ${tc.result || ""}`);
  const pageLabel = compactUrl(pageUrl);
  const clampStyle = {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden"
  };

  const statusMut = useMutation({
    mutationFn: (status: string) => scanApi.updateTestCase(scanId, tc.id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["test-cases", scanId] }),
  });

  return (
    <div className="card overflow-hidden" style={{ marginBottom: 6 }}>
      <div className="grid gap-4 px-5 py-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
        style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}
        onClick={() => setExpanded(!expanded)}>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-300 font-medium leading-snug whitespace-normal break-words" style={clampStyle}>{displayName(tc, showSteps)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-xs text-slate-600 leading-relaxed min-w-0" style={clampStyle}>{displayDescription(tc, showSteps)}</p>
            {pageLabel && (
              <span
                className="inline-flex max-w-xs items-center rounded-full border px-2 py-0.5 text-[10px] text-slate-500"
                style={{ borderColor: "var(--border-strong)", background: "var(--soft)" }}
                title={pageUrl}
              >
                <span className="truncate">{pageLabel}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2 flex-shrink-0 flex-wrap justify-end max-w-md">
          {tc.wcag_ref && (
            <span className="text-[10px] px-2 py-0.5 rounded border max-w-40 truncate text-center"
              style={{ color: "#a78bfa", background: "rgba(167,139,250,0.08)", borderColor: "rgba(167,139,250,0.2)" }}>
              {tc.wcag_ref.replace("wcag", "WCAG ")}
            </span>
          )}
          <StatusBadge status={tc.status} />
          <select
            value={showSteps ? (["pass", "fail", "pending"].includes(tc.status) ? tc.status : "pending") : (["pass", "fail"].includes(tc.status) ? tc.status : "fail")}
            onClick={e => e.stopPropagation()}
            onChange={e => statusMut.mutate(e.target.value)}
            disabled={statusMut.isPending}
            className="px-2.5 py-1 rounded-lg text-xs font-semibold outline-none border"
            style={{ background: "var(--input-bg)", borderColor: "var(--border-strong)", color: "var(--text-strong)" }}
            title="Update test case verification status"
          >
            {showSteps && <option value="pending">In Progress</option>}
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
          {statusMut.isPending && <Loader2 size={12} className="animate-spin text-accent" />}
          <AccordionChevron open={expanded} framed={false} size={14} />
        </div>
      </div>

      {expanded && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
          className="border-t px-5 py-4 overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          {steps.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-semibold text-slate-500 mb-2">
                {isHybridCase(tc) ? "Hybrid Steps for This URL" : "Manual Steps for This URL"}
              </div>
              <ol className="space-y-2">
                {steps.map((step: string, i: number) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-slate-400 leading-relaxed whitespace-normal break-words">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center"
                      style={{ background: "rgba(15,118,110,0.12)", color: "#0f766e" }}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 whitespace-normal break-words">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {!showSteps && (
            <p className="text-xs text-slate-600 leading-relaxed">
              Automated checks are generated from scan findings. Manual step-by-step instructions are shown only for manual and hybrid review cases.
            </p>
          )}
          {tc.result && (
            <div className="p-3 rounded-lg text-xs text-slate-400 leading-relaxed whitespace-normal break-words mt-3"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <span className="font-medium text-slate-500 mr-2">Result:</span>{stripUrls(tc.result) || tc.result}
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

function TestCaseSection({ title, description, cases, scanId, defaultOpen, showSteps }: {
  title: string;
  description?: string;
  cases: any[];
  scanId: string;
  defaultOpen?: boolean;
  showSteps: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  if (!cases.length) return null;

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="solid-section-header w-full flex items-start justify-between gap-4 mb-3 text-left rounded-lg px-3 py-2 transition-colors"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-300 whitespace-normal break-words">{title} ({cases.length})</h3>
          {description && <p className="text-xs text-slate-600 mt-0.5 leading-relaxed whitespace-normal break-words">{description}</p>}
        </div>
        <AccordionChevron open={open} size={15} className="text-slate-500" />
      </button>

      {open && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
          {cases.map((tc: any) => <TestCaseRow key={tc.id} tc={tc} scanId={scanId} showSteps={showSteps} />)}
        </motion.div>
      )}
    </div>
  );
}

export default function TestCasesTab({ scanId }: { scanId: string }) {
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [pageFilter, setPageFilter] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelRef = useRef<HTMLDivElement | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["test-cases", scanId],
    queryFn: () => scanApi.testCases(scanId),
  });

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

  const testCases: any[] = data?.data?.test_cases || [];
  const pageOptions = Array.from(new Set(testCases.map(testCasePageLabel).filter(Boolean))).sort();
  const visibleTestCases = testCases.filter(tc =>
    (!statusFilter.length || statusFilter.includes(tc.status)) &&
    (!pageFilter || testCasePageLabel(tc) === pageFilter)
  );
  const manualCases = sortTestCases(visibleTestCases.filter(tc => isManualCase(tc) && !isHybridCase(tc)));
  const hybridCases = sortTestCases(visibleTestCases.filter(tc => isHybridCase(tc)));
  const automatedCases = sortTestCases(visibleTestCases.filter(tc => !isManualCase(tc) && !isHybridCase(tc)));

  const counts = testCases.reduce((acc: any, tc: any) => {
    acc[tc.status] = (acc[tc.status] || 0) + 1;
    return acc;
  }, {});

  const passRate = testCases.length > 0
    ? Math.round(((counts.pass || 0) / testCases.length) * 100)
    : 0;
  const toggleStatusFilter = (status: string) => {
    setStatusFilter(current => current.includes(status) ? current.filter(item => item !== status) : [...current, status]);
  };

  return (
    <div className="p-6">
      <div className="grid grid-cols-3 gap-3 mb-6">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
          const Icon = cfg.icon;
          return (
            <div key={key} className="card px-4 py-3 flex items-center gap-3">
              <Icon size={16} style={{ color: cfg.color }} />
              <div>
                <div className="text-lg font-bold text-slate-200">{counts[key] || 0}</div>
                <div className="text-xs text-slate-600">{cfg.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      {testCases.length > 0 && (
        <div className="flex items-center justify-end mb-4">
          <div className="relative" ref={filterPanelRef}>
            <button
              type="button"
              onClick={() => setFiltersOpen(open => !open)}
              aria-expanded={filtersOpen}
              aria-haspopup="true"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-300 outline-none transition-colors hover:bg-white/[0.04]"
              style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}
            >
              <SlidersHorizontal size={15} className="text-slate-500" />
              Filters
              {(statusFilter.length + (pageFilter ? 1 : 0)) > 0 && (
                <span className="min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-bold flex items-center justify-center" style={{ background: "rgba(167,139,250,0.2)", color: "#c4b5fd" }}>
                  {statusFilter.length + (pageFilter ? 1 : 0)}
                </span>
              )}
              <AccordionChevron open={filtersOpen} framed={false} size={14} className="text-slate-500" />
            </button>
            {filtersOpen && (
              <div
                className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl p-4 shadow-2xl space-y-3"
                style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}
                role="dialog"
                aria-label="Test case filters"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-300">Filter test cases</span>
                  {(statusFilter.length > 0 || pageFilter) && (
                    <button type="button" onClick={() => { setStatusFilter([]); setPageFilter(""); }} className="text-[11px] font-semibold text-accent hover:underline">
                      Clear
                    </button>
                  )}
                </div>
                <label className="block space-y-1">
                  <span className="text-[10px] uppercase tracking-wide text-slate-600">Status subtype: page</span>
                  <select value={pageFilter} onChange={e => setPageFilter(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-slate-300 outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)" }}>
                    <option value="">All selected pages</option>
                    {pageOptions.map(label => <option key={label} value={label}>{label}</option>)}
                  </select>
                </label>
                <div className="space-y-2">
                  {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                    <label key={key} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 cursor-pointer hover:bg-white/[0.03]">
                      <span className="inline-flex items-center gap-2 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          checked={statusFilter.includes(key)}
                          onChange={() => toggleStatusFilter(key)}
                          className="h-4 w-4"
                        />
                        {cfg.label}
                      </span>
                      <span className="text-xs text-slate-600">{counts[key] || 0}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {testCases.length > 0 && (
        <div className="card px-6 py-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400">Pass Rate</span>
            <span className="text-sm font-bold" style={{ color: passRate >= 80 ? "#22c55e" : passRate >= 50 ? "#ffd60a" : "#ff4d6d" }}>
              {passRate}%
            </span>
          </div>
          <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-3)", border: "1px solid var(--border-strong)" }}>
            <motion.div className="h-full rounded-full"
              initial={{ width: 0 }} animate={{ width: `${passRate}%` }}
              transition={{ duration: 1, ease: "easeOut" }}
              style={{ background: passRate >= 80 ? "#22c55e" : passRate >= 50 ? "#ffd60a" : "#ff4d6d" }} />
          </div>
          <p className="text-xs text-slate-600 mt-1">{counts.pass || 0} of {testCases.length} tests passing</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={20} className="animate-spin text-accent" />
        </div>
      ) : testCases.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Clock size={40} className="text-slate-700 mb-4" />
          <p className="text-slate-500 text-sm">No test cases generated yet. Run a scan to generate test cases.</p>
        </div>
      ) : visibleTestCases.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Clock size={40} className="text-slate-700 mb-4" />
          <p className="text-slate-500 text-sm">No test cases match this status filter.</p>
        </div>
      ) : (
        <div>
          <TestCaseSection
            title="Manual Review Cases"
            description="Human judgment checks for content meaning, screen reader behavior, media quality, and visual usability."
            cases={manualCases}
            scanId={scanId}
            showSteps={true}
            defaultOpen={false}
          />
          <TestCaseSection
            title="Hybrid Review Cases"
            description="Guided checks that combine automation findings with real task-flow validation."
            cases={hybridCases}
            scanId={scanId}
            showSteps={true}
            defaultOpen={false}
          />
          <TestCaseSection
            title="Automated Test Cases"
            description="Generated from detected scan issues. These do not include manual step lists."
            cases={automatedCases}
            scanId={scanId}
            showSteps={false}
            defaultOpen={false}
          />
        </div>
      )}
    </div>
  );
}



