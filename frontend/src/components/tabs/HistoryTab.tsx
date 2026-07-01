import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { scanApi } from "../../services/api";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { format } from "date-fns";
import {
  CheckCircle2, XCircle, Clock, Loader2,
  TrendingUp, TrendingDown, Minus, ExternalLink,
  Filter, Search, X, RotateCcw
} from "lucide-react";
import { AccordionChevron } from "../ui/AccordionChevron";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid
} from "recharts";

function HistoryTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  const score = row.score ?? 0;
  const issues = row.issues ?? 0;
  const tc = row.testCasesTotal ?? 0;
  const tcPass = row.testCasesPass ?? 0;
  const tcFail = row.testCasesFail ?? 0;
  const tcPending = row.testCasesPending ?? 0;
  const tcManual = row.testCasesManual ?? 0;
  const tcSkipped = row.testCasesSkipped ?? 0;
  const scoreColor = score >= 80 ? "#22c55e" : score >= 50 ? "#ffd60a" : "#ff4d6d";
  const open = tcPending + tcManual;
  return (
    <div
      className="rounded-lg px-3 py-2 shadow-xl"
      style={{
        minWidth: 220,
        background: "var(--surface-1)",
        border: "1px solid var(--border-strong)",
        color: "var(--text-strong)",
      }}
    >
      <div className="text-xs font-semibold mb-1" style={{ color: "var(--text-strong)" }}>{row.label || row.name}</div>
      <div className="flex items-center justify-between text-[11px] mb-1 gap-3" style={{ color: "var(--muted)" }}>
        <span>Accessibility score</span>
        <span className="font-semibold" style={{ color: scoreColor }}>{score}/100</span>
      </div>
      <div className="flex items-center justify-between text-[11px] mb-1 gap-3" style={{ color: "var(--muted)" }}>
        <span>Total issues</span>
        <span className="font-semibold" style={{ color: "var(--text-strong)" }}>{issues}</span>
      </div>
      {tc > 0 && (
        <div className="pt-1 mt-1 border-t text-[11px] space-y-0.5" style={{ borderColor: "var(--border)" }}>
          <div className="flex justify-between gap-3" style={{ color: "var(--muted)" }}>
            <span>Test cases</span>
            <span className="font-semibold" style={{ color: "var(--text-strong)" }}>{tc}</span>
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: "var(--muted-strong)" }}>
            <span style={{ color: "#22c55e" }}>{tcPass} pass</span>
            <span style={{ color: "#ff4d6d" }}>{tcFail} fail</span>
            {open > 0 && <span>{open} open</span>}
            {tcSkipped > 0 && <span>{tcSkipped} skipped</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const statusIcon: Record<string, any> = {
  completed: <CheckCircle2 size={14} className="text-green-400" />,
  failed:    <XCircle size={14} className="text-red-400" />,
  running:   <Loader2 size={14} className="text-accent animate-spin" />,
  queued:    <Clock size={14} className="text-slate-500" />,
};

export default function HistoryTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedScanId, setExpandedScanId] = useState<string | null>(null);

  const hasFilters = Boolean(dateFrom || dateTo || nameFilter.trim());
  const rerunMut = useMutation({
    mutationFn: (scanId: string) => scanApi.rerun(scanId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["scans-history"] });
      navigate(`/scans/${res.data.scan.id}`);
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["scans-history", page, limit, dateFrom, dateTo, nameFilter],
    queryFn: () => scanApi.list({
      page,
      limit,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      name: nameFilter.trim() || undefined,
    }),
    refetchInterval: 10000,
  });

  const scans: any[] = data?.data?.scans || [];
  const totalScans = Number(data?.data?.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalScans / limit));
  const completed = scans.filter(s => s.status === "completed" && s.score != null);

  const chartData = [...completed].reverse().slice(-20).map(s => ({
    name: format(new Date(s.created_at), "MM/dd"),
    score: Math.round(s.score),
    issues: s.total_issues,
    label: s.name || format(new Date(s.created_at), "MM/dd HH:mm"),
    testCasesTotal: s.test_cases_total ?? 0,
    testCasesPass: s.test_cases_pass ?? 0,
    testCasesFail: s.test_cases_fail ?? 0,
    testCasesPending: s.test_cases_pending ?? 0,
    testCasesManual: s.test_cases_manual ?? 0,
    testCasesSkipped: s.test_cases_skipped ?? 0,
  }));

  const latest = completed[0]?.score ?? null;
  const previous = completed[1]?.score ?? null;
  const trend = latest != null && previous != null ? latest - previous : null;

  const clearFilters = () => {
    setDateFrom("");
    setDateTo("");
    setNameFilter("");
    setPage(1);
  };

  const count = (scan: any, key: string) => Number(scan[key] || 0);
  const testBreakdown = (scan: any) => [
    {
      label: "Automated",
      pass: count(scan, "test_cases_automated_pass"),
      fail: count(scan, "test_cases_automated_fail"),
      pending: count(scan, "test_cases_automated_pending"),
    },
    {
      label: "Manual",
      pass: count(scan, "test_cases_manual_pass"),
      fail: count(scan, "test_cases_manual_fail"),
      pending: count(scan, "test_cases_manual_pending"),
    },
    {
      label: "Hybrid",
      pass: count(scan, "test_cases_hybrid_pass"),
      fail: count(scan, "test_cases_hybrid_fail"),
      pending: count(scan, "test_cases_hybrid_pending"),
    },
  ];

  return (
    <div className="p-6 space-y-6">
      {chartData.length >= 2 && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-300">Accessibility Score Over Time</h3>
            {trend != null && (
              <div className={`flex items-center gap-1.5 text-xs font-semibold ${trend > 0 ? "text-green-400" : trend < 0 ? "text-red-400" : "text-slate-500"}`}>
                {trend > 0 ? <TrendingUp size={14} /> : trend < 0 ? <TrendingDown size={14} /> : <Minus size={14} />}
                {trend > 0 ? "+" : ""}{Math.round(trend)} pts vs last scan
              </div>
            )}
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="name" tick={{ fill: "#475569", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: "#475569", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip
                content={<HistoryTooltip />}
                cursor={{ stroke: "rgba(15,118,110,0.16)", strokeWidth: 1 }}
                wrapperStyle={{ outline: "none", zIndex: 40 }}
                contentStyle={{ margin: 0, padding: 0, background: "transparent", border: "none", boxShadow: "none" }}
              />
              <Line type="monotone" dataKey="score" stroke="#0f766e" strokeWidth={2}
                dot={{ fill: "#0f766e", r: 3, strokeWidth: 0 }}
                activeDot={{ r: 5, fill: "#0f766e", strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
        </motion.div>
      )}

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="card overflow-hidden">
        <div className="px-6 py-4 border-b space-y-4" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-300">Scan History</h3>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <span>Rows</span>
                <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }} className="px-2.5 py-1.5 rounded-lg outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }}>
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </div>
              <button type="button" onClick={() => setFiltersOpen(v => !v)} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors hover:text-accent" style={{ borderColor: "var(--border-strong)", color: hasFilters ? "var(--accent)" : "var(--muted-strong)", background: hasFilters ? "rgba(15,118,110,0.08)" : "var(--input-bg)" }}>
                <Filter size={13} /> Filters {hasFilters && <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: "rgba(15,118,110,0.15)" }}>On</span>}
              </button>
            </div>
          </div>

          {filtersOpen && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
                <label className="text-xs text-slate-500">Scan name
                  <div className="mt-1 relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input type="search" value={nameFilter} onChange={e => { setNameFilter(e.target.value); setPage(1); }} placeholder="Search by scan name" className="w-full pl-9 pr-3 py-2 rounded-lg outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }} />
                  </div>
                </label>
                <label className="text-xs text-slate-500">From
                  <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} className="block mt-1 w-full px-3 py-2 rounded-lg outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }} />
                </label>
                <label className="text-xs text-slate-500">To
                  <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} className="block mt-1 w-full px-3 py-2 rounded-lg outline-none" style={{ background: "var(--input-bg)", border: "1px solid var(--border-strong)", color: "var(--text-strong)" }} />
                </label>
              </div>
              {hasFilters && <button type="button" onClick={clearFilters} className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs text-slate-400 hover:text-accent transition-colors" style={{ borderColor: "var(--border-strong)" }}><X size={12} /> Clear filters</button>}
            </motion.div>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-accent" />
          </div>
        ) : scans.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-600 text-sm">
            No scan history found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  {["", "Scan Name", "Status", "URLs", "Score", "Date", "Re-run"].map(h => (
                    <th key={h} className="text-left text-xs text-slate-600 font-semibold px-5 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scans.map((scan: any, i: number) => {
                  const expanded = expandedScanId === scan.id;
                  return (
                    <Fragment key={scan.id}>
                      <motion.tr key={scan.id}
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }}
                        className="border-b hover:bg-white/[0.015] transition-colors"
                        style={{ borderColor: "rgba(255,255,255,0.04)" }}>
                        <td className="px-5 py-3.5">
                          <button
                            type="button"
                            onClick={() => setExpandedScanId(expanded ? null : scan.id)}
                            className="h-8 w-8 rounded-lg border border-white/10 inline-flex items-center justify-center text-slate-500 hover:text-accent hover:border-accent/30"
                            aria-label={expanded ? "Collapse scan details" : "Expand scan details"}
                          >
                            <AccordionChevron open={expanded} framed={false} size={15} />
                          </button>
                        </td>
                        <td className="px-5 py-3.5"><div className="text-sm text-slate-300 font-medium max-w-[240px] truncate">{scan.name || "Untitled Scan"}</div></td>
                        <td className="px-5 py-3.5"><div className="flex items-center gap-1.5 text-xs capitalize">{statusIcon[scan.status]}<span className={scan.status === "completed" ? "text-green-400" : scan.status === "failed" ? "text-red-400" : "text-slate-500"}>{scan.status}</span></div></td>
                        <td className="px-5 py-3.5 text-xs text-slate-500">{(scan.urls || []).length}</td>
                        <td className="px-5 py-3.5">{scan.score != null ? <span className="text-sm font-bold" style={{ color: scan.score >= 80 ? "#22c55e" : scan.score >= 50 ? "#ffd60a" : "#ff4d6d" }}>{Math.round(scan.score)}</span> : <span className="text-slate-600">-</span>}</td>
                        <td className="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">{format(new Date(scan.created_at), "MMM d, yyyy")}</td>
                        <td className="px-5 py-3.5">
                          <button
                            type="button"
                            onClick={() => rerunMut.mutate(scan.id)}
                            disabled={rerunMut.isPending}
                            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs text-accent transition-all hover:bg-accent/10 disabled:opacity-50"
                            style={{ borderColor: "rgba(15,118,110,0.35)" }}
                          >
                            {rerunMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                            Re-run
                          </button>
                        </td>
                      </motion.tr>
                      {expanded && (
                        <tr key={`${scan.id}-details`} className="border-b" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
                          <td colSpan={7} className="px-5 py-4">
                            <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
                              <div className="flex items-center justify-between gap-3 mb-3">
                                <div>
                                  <div className="text-sm font-semibold text-slate-300">Test case details</div>
                                  <div className="text-xs text-slate-600">Automated, manual, and hybrid verification status for this scan.</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => navigate(`/scans/${scan.id}`)}
                                  className="h-9 w-9 rounded-lg border border-white/10 inline-flex items-center justify-center text-slate-500 hover:text-accent hover:border-accent/30"
                                  title="Open full scan"
                                  aria-label="Open full scan"
                                >
                                  <ExternalLink size={15} />
                                </button>
                              </div>
                              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                                {testBreakdown(scan).map(group => (
                                  <div key={group.label} className="rounded-lg p-3" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
                                    <div className="text-xs font-semibold text-slate-300 mb-2">{group.label}</div>
                                    <div className="flex flex-wrap gap-2 text-xs">
                                      <span className="rounded-full px-2 py-1 text-green-400 bg-green-400/10">{group.pass} passed</span>
                                      <span className="rounded-full px-2 py-1 text-red-400 bg-red-400/10">{group.fail} failed</span>
                                      <span className="rounded-full px-2 py-1 text-slate-400 bg-white/[0.04]">{group.pending} in progress</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!isLoading && totalScans > 0 && (
          <div className="px-6 py-4 border-t flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
            <span className="text-xs text-slate-600">Page {page} of {totalPages} - {totalScans} matching scans</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-2 rounded-lg border text-xs text-slate-400 disabled:opacity-40 hover:text-accent transition-colors" style={{ borderColor: "var(--border-strong)" }}>Previous</button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-2 rounded-lg border text-xs text-slate-400 disabled:opacity-40 hover:text-accent transition-colors" style={{ borderColor: "var(--border-strong)" }}>Next</button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
