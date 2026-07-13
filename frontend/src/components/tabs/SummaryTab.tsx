import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { issueApi } from "../../services/api";
import { motion } from "framer-motion";
import {
  ResponsiveContainer,
  Cell, PieChart, Pie
} from "recharts";
import { AlertTriangle, CheckCircle2, Clock, TrendingUp, Shield, Zap } from "lucide-react";
import { summarizeCompliance } from "../../utils/wcag";
import { format } from "date-fns";

const SEV_CONFIG = [
  { key: "critical", label: "Critical", color: "#ff4d6d", scanKey: "critical_count" },
  { key: "serious",  label: "Serious",  color: "#ff9f43", scanKey: "serious_count" },
  { key: "moderate", label: "Moderate", color: "#ffd60a", scanKey: "moderate_count" },
  { key: "minor",    label: "Minor",    color: "#0b84a5", scanKey: "minor_count" },
];

const WCAG_GROUPS: Record<string, string> = {
  "1": "Perceivable", "2": "Operable", "3": "Understandable", "4": "Robust"
};

function ScoreGauge({ score }: { score: number }) {
  const color = score >= 80 ? "#0f766e" : score >= 50 ? "#ffd60a" : "#ff4d6d";
  const data = [{ value: score, fill: color }, { value: 100 - score, fill: "var(--surface-3)" }];
  return (
    <div className="relative flex items-center justify-center" style={{ width: 128, height: 128 }}>
      <ResponsiveContainer width={128} height={128}>
        <PieChart>
          <Pie data={data} cx={60} cy={60} startAngle={225} endAngle={-45}
            innerRadius={46} outerRadius={58} paddingAngle={2} dataKey="value"
            stroke="var(--border-strong)" strokeWidth={1}>
            {data.map((_, i) => <Cell key={i} fill={data[i].fill} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold" style={{ color }}>{Math.round(score)}</span>
        <span className="text-xs text-slate-500">/ 100</span>
      </div>
    </div>
  );
}

export default function SummaryTab({ scan }: { scan: any }) {
  const { data: issuesData } = useQuery({
    queryKey: ["issues", scan.id],
    queryFn: () => issueApi.list({ scan_id: scan.id, limit: 1000 }),
    enabled: scan.status === "completed",
  });

  const issues = issuesData?.data?.issues || [];

  // -------------------------------------------------------------------------
  // Reconcile with the PDF report: the report renders counts using only
  // unresolved issues (issues.filter(i => !i.is_resolved)). Historically this
  // tab showed the STORED scan.total_issues / scan.[severity]_count, which are
  // frozen at scan-completion time and drift the moment anyone marks any
  // issue resolved. Result: dashboard tile said 47, PDF said 45 — same scan.
  //
  // Fix: compute the tile counts from the same source and same filter the
  // PDF uses. Guaranteed to match forever.
  // -------------------------------------------------------------------------
  const openIssues = useMemo(() => issues.filter((i: any) => !i.is_resolved), [issues]);
  const openBySeverity = useMemo(() => {
    const out: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const i of openIssues) {
      const sev = String(i.severity || "").toLowerCase();
      if (out[sev] !== undefined) out[sev]++;
    }
    return out;
  }, [openIssues]);
  const filteredIssuesTotal = issuesData?.data?.total ?? 0;

  const categoryBreakdown = useMemo(() => {
    const map: Record<string, number> = {};
    for (const i of issues) {
      const cat = i.category || "uncategorized";
      map[cat] = (map[cat] || 0) + 1;
    }
    return Object.entries(map)
      .map(([name, value]) => ({ name, value, label: name.replace(/-/g, " ") }))
      .sort((a, b) => b.value - a.value);
  }, [issues]);

  const wcagBreakdown = useMemo(() => {
    const map: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0 };
    for (const i of issues) {
      for (const w of (i.wcag_criteria || [])) {
        const principle = w.replace("wcag", "")[0];
        if (map[principle] !== undefined) map[principle]++;
      }
    }
    return Object.entries(map).map(([k, v]) => ({ name: WCAG_GROUPS[k], value: v }));
  }, [issues]);

  const complianceBreakdown = useMemo(() => summarizeCompliance(issues), [issues]);

  const score = scan.score ?? 0;
  const completed = scan.status === "completed";

  const statCards = [
    // Uses openIssues.length so this tile reconciles with the PDF report,
    // which also counts only unresolved issues.
    { label: "Total Issues", value: openIssues.length, icon: AlertTriangle, color: "#ff9f43" },
    { label: "Accessibility Score", value: `${Math.round(score)}/100`, icon: TrendingUp, color: score >= 80 ? "#0f766e" : score >= 50 ? "#ffd60a" : "#ff4d6d" },
    { label: "URLs Scanned", value: (scan.urls || []).length, icon: Shield, color: "#0f766e" },
    { label: "Scan Duration",
      value: scan.started_at && scan.completed_at
        ? `${Math.round((new Date(scan.completed_at).getTime() - new Date(scan.started_at).getTime()) / 1000)}s`
        : "—",
      icon: Clock, color: "#a78bfa" },
  ];

  return (
    <div className="p-6 space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-4">
        {statCards.map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }} className="card p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-slate-500 mb-1">{s.label}</div>
                <div className="text-2xl font-bold text-slate-100">{s.value}</div>
              </div>
              <div className="w-9 h-9 rounded-lg flex items-center justify-center"
                style={{ background: `${s.color}15`, color: s.color }}>
                <s.icon size={18} />
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {completed && issues.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08 }} className="card p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-300">WCAG Compliance Levels</h3>
            <span className="text-[11px] text-slate-600">Automated failures grouped by primary WCAG level</span>
          </div>
          <div className="grid grid-cols-5 gap-3">
            {complianceBreakdown.map(item => (
              <div key={item.level} className="rounded-lg p-3" style={{ background: `${item.color}10`, border: `1px solid ${item.color}24` }}>
                <div className="text-xs font-semibold" style={{ color: item.color }}>{item.level === "Advisory Checks" || item.level === "Needs Review" ? item.level : `Level ${item.level}`}</div>
                <div className="text-xl font-bold text-slate-100 mt-1">{item.failed}</div>
                <div className="text-[10px] text-slate-600">failed issues</div>
                <div className="text-[10px] text-slate-500 mt-1">{item.criteria} criteria</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-600 mt-3 leading-relaxed">
            Each issue is counted once in its primary WCAG bucket so these cards reconcile with Total Issues. Manual review is still required for criteria that automation cannot fully prove.
          </p>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Score gauge */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
          className="card p-4 flex flex-col items-center justify-center gap-3">
          <h3 className="text-sm font-semibold text-slate-300 self-start">Accessibility Score</h3>
          {completed ? <ScoreGauge score={score} /> : (
            <div className="text-slate-600 text-sm py-8">Scan in progress…</div>
          )}
          <div className="w-full grid grid-cols-2 gap-x-4 gap-y-2">
            {SEV_CONFIG.map(s => (
              <div key={s.key} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                  <span className="text-slate-500">{s.label}</span>
                </div>
                <span className="font-semibold" style={{ color: s.color }}>
                  {openBySeverity[s.key] || 0}
                </span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Category breakdown */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}
          className="card p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Issues by Category</h3>
          {categoryBreakdown.length > 0 ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-5 gap-y-2.5">
              {categoryBreakdown.map((cat, i) => {
                const max = Math.max(...categoryBreakdown.map(x => x.value), 1);
                const pct = Math.max(6, Math.round((cat.value / max) * 100));
                const color = ["#0f766e", "#6e56cf", "#a78bfa", "#ff9f43", "#ff4d6d", "#ffd60a"][i % 6];
                return (
                  <div key={cat.name} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-400 leading-snug break-words min-w-0">{cat.label}</span>
                      <span className="font-semibold flex-shrink-0" style={{ color }}>{cat.value}</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-3)", border: "1px solid var(--border)" }} aria-label={`${cat.label}: ${cat.value} issues`}>
                      <motion.div
                        className="h-full rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.7, delay: 0.05 + i * 0.04 }}
                        style={{ background: color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-center h-40 text-slate-700 text-sm">
              {completed ? "No issues found" : "Waiting for scan…"}
            </div>
          )}
        </motion.div>

        {/* WCAG principles */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}
          className="card p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">WCAG Principles</h3>
          {issues.length > 0 ? (
            <div className="space-y-2.5 mt-1">
              {wcagBreakdown.map((w, i) => {
                const max = Math.max(...wcagBreakdown.map(x => x.value), 1);
                const pct = Math.round((w.value / max) * 100);
                const colors = ["#ff4d6d","#ff9f43","#a78bfa","#0f766e"];
                return (
                  <div key={w.name} className="group relative">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-400">{w.name}</span>
                      <span style={{ color: colors[i] }} className="font-semibold">{w.value}</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-3)", border: "1px solid var(--border)" }}>
                      <motion.div className="h-full rounded-full"
                        initial={{ width: 0 }} animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.8, delay: 0.3 + i * 0.1 }}
                        style={{ background: colors[i] }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-center h-40 text-slate-700 text-sm">
              {completed ? "No issues found 🎉" : "Waiting for scan…"}
            </div>
          )}

          {/* Meta */}
          <div className="mt-4 pt-3 border-t space-y-1.5" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
            <div className="flex justify-between text-xs">
              <span className="text-slate-600">Created</span>
              <span className="text-slate-400">{format(new Date(scan.created_at), "MMM d, yyyy HH:mm")}</span>
            </div>
            {scan.completed_at && (
              <div className="flex justify-between text-xs">
                <span className="text-slate-600">Completed</span>
                <span className="text-slate-400">{format(new Date(scan.completed_at), "MMM d, yyyy HH:mm")}</span>
              </div>
            )}
            <div className="flex justify-between text-xs">
              <span className="text-slate-600">State</span>
              <span className="text-slate-400">{scan.state_label || "default"}</span>
            </div>
          </div>
        </motion.div>
      </div>

      {/* URLs list */}
      {(scan.urls || []).length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="card p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Scanned URLs</h3>
          <div className="space-y-2">
            {(scan.urls || []).map((url: string, i: number) => (
              <div key={i} className="flex items-center justify-between px-4 py-2.5 rounded-lg"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <span className="text-sm text-slate-300 truncate font-mono text-xs">{url}</span>
                <div className="flex items-center gap-1.5 ml-4 flex-shrink-0">
                  {completed ? <CheckCircle2 size={14} className="text-green-400" /> : <Zap size={14} className="text-accent animate-pulse" />}
                  <span className="text-xs text-slate-600">{completed ? "Done" : "Scanning"}</span>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}







