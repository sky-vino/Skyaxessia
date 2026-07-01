import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { scanApi } from "../services/api";
import { motion } from "framer-motion";
import { Plus, Clock, CheckCircle2, XCircle, Loader2, ShieldCheck, Activity } from "lucide-react";
import { format } from "date-fns";

const statusIcon: Record<string, any> = {
  queued: <Clock size={14} className="text-slate-500" />,
  running: <Loader2 size={14} className="text-accent animate-spin" />,
  completed: <CheckCircle2 size={14} className="text-green-400" />,
  failed: <XCircle size={14} className="text-red-400" />
};

const statusColor: Record<string, string> = {
  queued: "text-slate-500",
  running: "text-accent",
  completed: "text-green-400",
  failed: "text-red-400"
};

function shortId(id?: string) {
  return String(id || "").slice(0, 8).toUpperCase();
}

function ScoreRing({ score }: { score: number }) {
  const r = 28, c = 2 * Math.PI * r;
  const dash = (score / 100) * c;
  const color = score >= 80 ? "#0f766e" : score >= 50 ? "#ffd60a" : "#ff4d6d";
  const trackStroke = "var(--border-strong)";
  return (
    <svg width="72" height="72" className="rotate-[-90deg]" aria-hidden>
      <circle cx="36" cy="36" r={r} fill="none" stroke={trackStroke} strokeWidth="5" />
      <circle cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={`${dash} ${c}`} strokeLinecap="round"
        style={{ transition: "stroke-dasharray 1s ease-out", filter: `drop-shadow(0 0 6px ${color}60)` }} />
    </svg>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["scans"],
    queryFn: () => scanApi.list({ limit: 5 }),
    refetchInterval: 8000
  });

  const scans = data?.data?.scans || [];
  const activeScansTotal = Number(data?.data?.active_total ?? scans.filter((s: any) => s.status === "running" || s.status === "queued").length);
  const completedScansTotal = Number(data?.data?.completed_total ?? scans.filter((s: any) => s.status === "completed").length);
  const latestCompleted = scans.find((s: any) => s.status === "completed");

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Accessibility Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Monitor, scan, and track your WCAG compliance</p>
        </div>
        <button
          onClick={() => navigate("/scans/new")}
          className="sky-primary flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all hover:opacity-90 active:scale-95"
        >
          <Plus size={16} /> New Scan
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "rgba(15,118,110,0.12)", color: "#0f766e" }}>
              <Activity size={17} />
            </div>
            <div>
              <div className="text-xs text-slate-500">Active scans</div>
              <div className="text-lg font-semibold text-slate-100">{activeScansTotal}</div>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Latest completed</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{latestCompleted?.name || "No completed scans yet"}</div>
          {latestCompleted && <div className="text-xs text-slate-600 mt-1">{format(new Date(latestCompleted.completed_at || latestCompleted.created_at), "MMM d, HH:mm")}</div>}
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "rgba(34,197,94,0.10)", color: "#22c55e" }}>
              <CheckCircle2 size={17} aria-hidden />
            </div>
            <div>
              <div className="text-xs text-slate-500">Total scans completed till now</div>
              <div className="text-lg font-semibold text-slate-100">{completedScansTotal}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Scan list */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <h2 className="text-sm font-semibold text-slate-200">Recent Scans</h2>
          <span className="text-xs text-slate-600">Showing latest {scans.length} of {data?.data?.total || scans.length}</span>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-accent" />
          </div>
        ) : scans.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShieldCheck size={40} className="text-slate-700 mb-4" />
            <p className="text-slate-500 text-sm">No scans yet. Start your first accessibility scan.</p>
            <button onClick={() => navigate("/scans/new")}
              className="mt-4 px-4 py-2 rounded-lg text-xs font-medium text-accent border border-accent/30 hover:bg-accent/10 transition-all">
              Create Scan
            </button>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
            {scans.map((scan: any) => (
              <motion.div key={scan.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                onClick={() => navigate(`/scans/${scan.id}`)}
                className="flex items-center gap-4 px-6 py-4 hover:bg-white/[0.02] cursor-pointer transition-colors group">

                {/* Score ring */}
                <div className="relative flex-shrink-0">
                  {scan.status === "completed" && scan.score != null ? (
                    <>
                      <ScoreRing score={scan.score} />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-sm font-bold text-slate-200">{Math.round(scan.score)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="w-[72px] h-[72px] rounded-full flex items-center justify-center"
                      style={{ background: "rgba(255,255,255,0.04)" }}>
                      {statusIcon[scan.status] || <Clock size={18} className="text-slate-600" />}
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-slate-200 truncate group-hover:text-accent transition-colors">
                      {scan.name || "Untitled Scan"}
                    </span>
                    <span className={`flex items-center gap-1 text-xs capitalize ${statusColor[scan.status]}`}>
                      {statusIcon[scan.status]} {scan.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600">
                    <span>ID: <span className="font-mono text-slate-500">{shortId(scan.id)}</span></span>
                    <span>{(scan.urls || []).length} URL{(scan.urls || []).length !== 1 ? "s" : ""}</span>
                    {scan.status === "completed" && (() => {
                      const total = Number(scan.test_cases_total) || 0;
                      const pass = Number(scan.test_cases_pass) || 0;
                      const fail = Number(scan.test_cases_fail) || 0;
                      const pending = Number(scan.test_cases_pending) || 0;
                      const manual = Number(scan.test_cases_manual) || 0;
                      const skipped = Number(scan.test_cases_skipped) || 0;
                      const open = pending + manual;
                      if (total === 0) {
                        return <span className="text-slate-500">No test cases recorded</span>;
                      }
                      return (
                        <>
                          <span className="text-slate-500">{total} test case{total !== 1 ? "s" : ""}</span>
                          <span className="text-green-400/90">{pass} pass</span>
                          <span className="text-red-400/85">{fail} fail</span>
                          {open > 0 && <span className="text-amber-400/85">{open} open</span>}
                          {skipped > 0 && <span className="text-slate-500">{skipped} skipped</span>}
                        </>
                      );
                    })()}
                    {scan.status === "running" && (
                      <span className="text-accent">Scanning… {scan.progress}%</span>
                    )}
                  </div>
                </div>

                {/* Date */}
                <div className="text-xs text-slate-600 flex-shrink-0">
                  {format(new Date(scan.created_at), "MMM d, HH:mm")}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}





