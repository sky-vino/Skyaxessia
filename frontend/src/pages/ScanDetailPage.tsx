import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { scanApi, reportApi, issueApi } from "../services/api";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, LayoutDashboard, AlertTriangle, Code2,
  FlaskConical, Eye, Loader2, RefreshCw,
  Layers, FileText, RotateCcw, ListChecks, Trash2, X, Ear
} from "lucide-react";

import SummaryTab      from "../components/tabs/SummaryTab";
import IssuesTab       from "../components/tabs/IssuesTab";
import FixesTab        from "../components/tabs/FixesTab";
import TestCasesTab    from "../components/tabs/TestCasesTab";
import LiveDomTab      from "../components/tabs/LiveDomTab";
import StatesTab       from "../components/tabs/StatesTab";
import ScreenReaderTab from "../components/tabs/ScreenReaderTab";

const TABS = [
  { id: "summary",      label: "Summary",       icon: LayoutDashboard },
  { id: "issues",       label: "Issues",        icon: AlertTriangle },
  { id: "fixes",        label: "AI Fixes",      icon: Code2 },
  { id: "screenreader", label: "Screen Reader", icon: Ear },
  { id: "states",       label: "UI States",     icon: Layers },
  { id: "testcases",    label: "Test Cases",    icon: FlaskConical },
  { id: "livedom",      label: "Live DOM",      icon: Eye },
];

const STATUS_COLORS: Record<string, string> = {
  queued:    "text-slate-400 bg-slate-400/10",
  running:   "text-accent bg-accent/10",
  completed: "text-green-400 bg-green-400/10",
  failed:    "text-red-400 bg-red-400/10",
  cancelled: "text-slate-500 bg-slate-500/10",
};

const REPORT_SECTION_OPTIONS = [
  { id: "executive", label: "Executive report" },
  { id: "navigation", label: "Navigation timeline" },
  { id: "interactions", label: "Controlled interactions" },
  { id: "testcases", label: "Test cases" },
  { id: "states", label: "UI states" },
  { id: "screenreader", label: "Screen reader perspective" },
  { id: "issues", label: "Issues" },
];

function shortId(id?: string) {
  return String(id || "").slice(0, 8).toUpperCase();
}

export default function ScanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState("summary");
  const [focusedFixIssueId, setFocusedFixIssueId] = useState<string | null>(null);
  const [focusedIssueId, setFocusedIssueId] = useState<string | null>(null);
  const [focusedStateIssueId, setFocusedStateIssueId] = useState<string | null>(null);
  const [focusedStateName, setFocusedStateName] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [reportMenuOpen, setReportMenuOpen] = useState(false);
  const [reportSections, setReportSections] = useState<string[]>(REPORT_SECTION_OPTIONS.map(option => option.id));
  const [interactiveReportOpened, setInteractiveReportOpened] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"rerun" | "delete" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scanLogs, setScanLogs] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["scan", id],
    queryFn: () => scanApi.get(id!),
    refetchInterval: (query) => {
      const status = query.state.data?.data?.scan?.status;
      return status === "running" || status === "queued" ? 3000 : false;
    },
  });

  const scan = data?.data?.scan;
  const { data: visibleIssuesData } = useQuery({
    queryKey: ["issues-count", id],
    queryFn: () => issueApi.list({ scan_id: id, limit: 1 }),
    enabled: Boolean(id),
  });
  const visibleIssuesTotal = visibleIssuesData?.data?.total ?? 0;

  // WebSocket for real-time progress
  useEffect(() => {
    if (!id) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const apiUrl = (import.meta as any).env?.VITE_API_URL;
    const host = apiUrl ? new URL(apiUrl).hostname : window.location.hostname;
    const port = apiUrl ? (new URL(apiUrl).port || "4000") : "4000";
    const ws = new WebSocket(`${proto}://${host}:${port}/ws`);
    wsRef.current = ws;
    ws.onopen  = () => ws.send(JSON.stringify({ type: "subscribe", scanId: id }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (["scan:started","scan:completed","scan:failed","scan:progress"].includes(msg.type)) {
        const message = msg.message || (msg.type === "scan:started" ? "Scan started" : msg.type === "scan:completed" ? "Scan completed" : msg.type === "scan:failed" ? `Scan failed: ${msg.error || "Unknown error"}` : "Scan progress updated");
        setScanLogs(prev => [message, ...prev.filter(item => item !== message)].slice(0, 8));
        qc.invalidateQueries({ queryKey: ["scan", id] });
        qc.invalidateQueries({ queryKey: ["issues", id] });
      }
    };
    ws.onerror = () => {};
    return () => ws.close();
  }, [id, qc]);

  // Server-rendered PDF download
  const handleDownloadReport = async () => {
    if (!id || downloading === "report") return;
    const sections = reportSections.length ? reportSections : REPORT_SECTION_OPTIONS.map(option => option.id);
    setDownloading("report");
    try {
      const { data } = await reportApi.getReportPdf(id, sections);
      const blob = new Blob([data], { type: "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `${scan?.name || "accessibility-report"}.pdf`.replace(/[^\w.-]+/g, "-");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } finally {
      setDownloading(null);
      setReportMenuOpen(false);
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!event.data || event.data.type !== "download-report-pdf" || event.data.scanId !== id) return;
      const sections = Array.isArray(event.data.sections) && event.data.sections.length
        ? event.data.sections
        : REPORT_SECTION_OPTIONS.map(option => option.id);
      setReportSections(sections);
      void (async () => {
        if (!id) return;
        setDownloading("report");
        try {
          const { data } = await reportApi.getReportPdf(id, sections);
          const blob = new Blob([data], { type: "application/pdf" });
          const blobUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = blobUrl;
          link.download = `${scan?.name || "accessibility-report"}.pdf`.replace(/[^\w.-]+/g, "-");
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        } finally {
          setDownloading(null);
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id, scan?.name]);

  const handleOpenInteractiveReport = async () => {
    if (!id || downloading === "interactive") return;
    const sections = reportSections.length ? reportSections : REPORT_SECTION_OPTIONS.map(option => option.id);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`
      <html>
        <head><title>Preparing Accessibility Report</title></head>
        <body style="font-family: Arial, sans-serif; padding: 24px; color: #1f2937;">
          <h2>Preparing report...</h2>
          <p>Please wait while the accessibility report is generated.</p>
        </body>
      </html>
    `);
    win.document.close();

    setDownloading("interactive");
    try {
      const { data: html } = await reportApi.getReport(id, sections);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      win.location.replace(blobUrl);
      setInteractiveReportOpened(true);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      win.document.open();
      win.document.write(`
        <html>
          <head><title>Report unavailable</title></head>
          <body style="font-family: Arial, sans-serif; padding: 24px; color: #1f2937;">
            <h2>Report could not be opened</h2>
            <p>Your session may have expired. Please sign in again and try the PDF Report button once more.</p>
          </body>
        </html>
      `);
      win.document.close();
    } finally {
      setDownloading(null);
      setReportMenuOpen(false);
    }
  };

  // Save the interactive HTML report to a local file (no new window).
  const handleDownloadReportHtml = async () => {
    if (!id || downloading === "html") return;
    const sections = reportSections.length ? reportSections : REPORT_SECTION_OPTIONS.map(option => option.id);
    setDownloading("html");
    try {
      const { data: html } = await reportApi.getReport(id, sections);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `${scan?.name || "accessibility-report"}.html`.replace(/[^\w.-]+/g, "-");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } finally {
      setDownloading(null);
      setReportMenuOpen(false);
    }
  };

  // Save the raw scan + issues as JSON — for CI pipelines, Jira import, etc.
  // Download all Playwright auth trace .zip files for this scan.
  // Files are the deep diagnostic capture around each Accedi / Conferma
  // click — screenshots + DOM snapshots + network + console. Sky's ops team
  // opens them at https://trace.playwright.dev to see exactly what our
  // browser saw and sent during authentication.
  const handleDownloadAuthTraces = async () => {
    if (!id || downloading === "traces") return;
    setDownloading("traces");
    try {
      const { data } = await scanApi.authTraces(id);
      const traces: any[] = data?.traces || [];
      if (traces.length === 0) {
        alert("No auth trace files have been captured for this scan yet.\n\n" +
              "Traces are produced only when a scan attempts an authenticated login. " +
              "If this scan failed before login, or was unauthenticated, no traces exist.");
        return;
      }
      for (const trace of traces) {
        const { data: blob } = await scanApi.authTraceDownload(id, trace.filename);
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = trace.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        // Space out downloads so the browser doesn't reject rapid-fire prompts.
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err: any) {
      console.error("Auth trace download failed", err);
      alert("Could not download auth traces. Check the browser console for details.");
    } finally {
      setDownloading(null);
      setReportMenuOpen(false);
    }
  };

  const handleDownloadReportJson = async () => {
    if (!id || downloading === "json") return;
    setDownloading("json");
    try {
      const [{ data: scanData }, { data: issuesData }] = await Promise.all([
        scanApi.get(id),
        issueApi.list({ scan_id: id, limit: 10000 })
      ]);
      const payload = {
        scan: scanData?.scan || scanData,
        issues: issuesData?.issues || issuesData,
        exported_at: new Date().toISOString(),
        exported_by: "axessia-web"
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `${scan?.name || "accessibility-report"}.json`.replace(/[^\w.-]+/g, "-");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } finally {
      setDownloading(null);
      setReportMenuOpen(false);
    }
  };

  const toggleReportSection = (sectionId: string) => {
    setReportSections(current => {
      if (current.includes(sectionId)) {
        const next = current.filter(id => id !== sectionId);
        return next.length ? next : current;
      }
      return [...current, sectionId];
    });
  };

  const handleRefresh = async () => {
    if (!id || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ["issues"] }),
        qc.invalidateQueries({ queryKey: ["scan", id] }),
        qc.invalidateQueries({ queryKey: ["dom-snapshots", id] }),
        qc.invalidateQueries({ queryKey: ["test-cases", id] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };
  const handleRerunScan = async () => {
    if (!id || rerunning) return;
    setRerunning(true);
    try {
      const res = await scanApi.rerun(id);
      navigate(`/scans/${res.data.scan.id}`);
    } finally {
      setRerunning(false);
      setConfirmAction(null);
    }
  };
  const handleDeleteScan = async () => {
    if (!id || deleting) return;
    setDeleting(true);
    try {
      await scanApi.delete(id);
      navigate("/");
    } finally {
      setDeleting(false);
      setConfirmAction(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <p className="text-slate-500">Scan not found.</p>
        <button onClick={() => navigate("/")} className="text-accent text-sm hover:underline">Back to dashboard</button>
      </div>
    );
  }

  const isRunning = scan.status === "running" || scan.status === "queued";
  const canRerun = scan.status === "completed" || scan.status === "failed" || scan.status === "cancelled";

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex-shrink-0 px-8 pt-6 pb-0" style={{ borderBottom: "1px solid var(--border)", background: "rgba(255,255,255,0.025)" }}>
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-start gap-4">
            <button onClick={() => navigate("/")}
              className="mt-1 text-slate-600 hover:text-slate-300 transition-colors">
              <ArrowLeft size={16} />
            </button>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-semibold whitespace-normal break-words" style={{ color: "var(--text-strong)" }}>
                  {scan.name || "Untitled Scan"}
                </h1>
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${STATUS_COLORS[scan.status] || "text-slate-500"}`}>
                  {scan.status}
                  {isRunning && <Loader2 size={10} className="inline-block ml-1.5 animate-spin" />}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600 mt-1">
                <span>ID: <span className="font-mono text-slate-400">{shortId(scan.id)}</span></span>
                <span>{(scan.urls || []).join(", ").slice(0, 100)}</span>
                {isRunning && <span className="text-accent font-medium">Progress: {scan.progress}%</span>}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {canRerun && (
              <button
                onClick={() => setConfirmAction("rerun")}
                disabled={rerunning}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all hover:bg-white/[0.04]"
                style={{ borderColor: "rgba(15,118,110,0.3)", color: "#0f766e" }}
                title="Create a new scan with the same URL and scan options"
              >
                {rerunning ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                Re-run
              </button>
            )}
            <button
              onClick={() => setConfirmAction("delete")}
              disabled={deleting}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all hover:bg-red-400/10"
              style={{ borderColor: "rgba(248,113,113,0.35)", color: "#f87171" }}
              title="Delete this scan and its related results"
            >
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Delete
            </button>
            {scan.status === "completed" && (
              <div className="relative">
                <button
                  onClick={() => setReportMenuOpen(open => !open)}
                  disabled={Boolean(downloading)}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all hover:bg-white/[0.04]"
                  style={{ borderColor: "rgba(15,118,110,0.3)", color: "#0f766e" }}
                  title="Choose report sections before downloading or opening the report"
                >
                  {downloading
                    ? <Loader2 size={13} className="animate-spin" />
                    : <FileText size={13} />}
                  PDF Report
                </button>
                {reportMenuOpen && (
                  <div
                    className="absolute right-0 top-full mt-2 w-72 rounded-xl border p-3 z-30 shadow-2xl"
                    style={{ background: "var(--surface-1)", borderColor: "var(--border-strong)" }}
                  >
                    <div className="text-xs font-semibold mb-2" style={{ color: "var(--text-strong)" }}>Report contents</div>
                    <div className="space-y-2 mb-3">
                      {REPORT_SECTION_OPTIONS.map(option => (
                        <label key={option.id} className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text)" }}>
                          <input
                            type="checkbox"
                            checked={reportSections.includes(option.id)}
                            onChange={() => toggleReportSection(option.id)}
                            className="h-3.5 w-3.5"
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <button
                        type="button"
                        onClick={() => setReportSections(REPORT_SECTION_OPTIONS.map(option => option.id))}
                        className="text-xs px-2 py-1.5 rounded-lg border"
                        style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() => setReportSections(["executive"])}
                        className="text-xs px-2 py-1.5 rounded-lg border"
                        style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                      >
                        Executive
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleDownloadReport}
                      disabled={downloading === "report"}
                      className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all disabled:opacity-60"
                      style={{ borderColor: "rgba(15,118,110,0.35)", color: "#0f766e", background: "rgba(15,118,110,0.08)" }}
                    >
                      {downloading === "report" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                      Download PDF report
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadReportHtml}
                      disabled={downloading === "html"}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all disabled:opacity-60"
                      style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                    >
                      {downloading === "html" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                      Download HTML report
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadReportJson}
                      disabled={downloading === "json"}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all disabled:opacity-60"
                      style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                    >
                      {downloading === "json" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                      Download JSON (raw data)
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenInteractiveReport}
                      disabled={downloading === "interactive"}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all disabled:opacity-60"
                      style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                    >
                      {downloading === "interactive" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                      Open interactive report
                    </button>
                    <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--border)" }}>
                      <div className="text-[10px] uppercase tracking-wide mb-2" style={{ color: "var(--muted)" }}>
                        Diagnostics
                      </div>
                      <button
                        type="button"
                        onClick={handleDownloadAuthTraces}
                        disabled={downloading === "traces"}
                        className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all disabled:opacity-60"
                        style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                        title="Playwright trace files (.zip) captured around Accedi / Conferma clicks. Open at trace.playwright.dev to send to Sky."
                      >
                        {downloading === "traces" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                        Download auth traces (for Sky)
                      </button>
                      <div className="text-[10px] mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
                        Playwright trace .zip files from each auth click.
                        Open at{" "}
                        <a
                          href="https://trace.playwright.dev"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#0f766e", textDecoration: "underline" }}
                        >
                          trace.playwright.dev
                        </a>{" "}
                        (drag & drop, no install).
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            <button onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 px-3 py-2 rounded-lg hover:bg-white/[0.03] transition-all disabled:opacity-60 disabled:cursor-wait">
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> {refreshing ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {isRunning && (
          <div className="mb-4 space-y-3">
            <div className="w-full h-0.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
              <motion.div className="h-full rounded-full"
                style={{ background: "linear-gradient(90deg,#0f766e,#6e56cf)", boxShadow: "0 0 10px rgba(15,118,110,0.5)" }}
                animate={{ width: `${scan.progress || 0}%` }}
                transition={{ duration: 0.8, ease: "easeOut" }} />
            </div>
            <div className="rounded-xl px-4 py-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-300"><ListChecks size={14} className="text-accent" /> Scan activity</div>
                <span className="text-[11px] text-slate-600">Latest checks first</span>
              </div>
              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                {(scanLogs.length ? scanLogs : [scan.status === "queued" ? "Waiting for an available scan worker" : "Preparing scan modules and browser context"]).map((log, index) => {
                  const tone = log.startsWith("SUCCESS:") ? "success" : log.startsWith("WARN:") ? "warn" : log.startsWith("ERROR:") ? "error" : "info";
                  const color = tone === "success" ? "#10b981" : tone === "warn" ? "#f59e0b" : tone === "error" ? "#ff4d6d" : index === 0 ? "var(--accent)" : "var(--muted)";
                  const textColor = tone === "success" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : tone === "error" ? "text-red-400" : "text-slate-500";
                  return (
                  <div key={`${log}-${index}`} className={`flex items-start gap-2 text-xs ${textColor} leading-relaxed`}>
                    <span className="mt-1 h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                    <span className="whitespace-normal break-words">{log}</span>
                  </div>
                );})}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-0.5 overflow-x-auto">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => {
                if (tab.id === "fixes") setFocusedFixIssueId(null);
                setActiveTab(tab.id);
              }}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-all relative whitespace-nowrap flex-shrink-0 ${
                  isActive ? "selected-tab-solid" : "text-slate-500 hover:text-slate-300"
                }`}
                style={isActive ? {} : {}}>
                <tab.icon size={14} />
                {tab.label}
                {tab.id === "issues" && visibleIssuesTotal > 0 && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: "rgba(255,77,109,0.2)", color: "#ff4d6d" }}>
                    {visibleIssuesTotal}
                  </span>
                )}
                {isActive && (
                  <motion.div layoutId="tab-underline"
                    className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                    style={{ background: "linear-gradient(90deg,#0f766e,#6e56cf)" }} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <AnimatePresence>
        {confirmAction && (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.48)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }} className="w-full max-w-md rounded-xl p-5 shadow-2xl" style={{ background: "var(--surface-1)", border: "1px solid var(--border-strong)" }}>
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-100">{confirmAction === "delete" ? "Delete scan?" : "Re-run scan?"}</h3>
                  <p className="text-xs text-slate-500 mt-1">This action will be recorded in the admin audit trail.</p>
                </div>
                <button type="button" onClick={() => setConfirmAction(null)} className="text-slate-500 hover:text-slate-200" aria-label="Close dialog"><X size={16} /></button>
              </div>
              <div className="rounded-lg p-3 mb-4 space-y-1" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                <div className="text-sm text-slate-300">{scan.name || "Untitled Scan"}</div>
                <div className="text-xs font-mono text-slate-500">ID: {shortId(scan.id)}</div>
              </div>
              <p className="text-sm text-slate-400 leading-relaxed mb-5">
                {confirmAction === "delete"
                  ? "Deleting removes the scan, issues, screenshots, and test cases from this workspace."
                  : "Re-running creates a new scan with the same URLs, authentication, and scan options."}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => setConfirmAction(null)} className="px-3 py-2 text-xs rounded-lg border border-white/10 text-slate-400 hover:bg-white/[0.04]">Cancel</button>
                <button
                  type="button"
                  onClick={confirmAction === "delete" ? handleDeleteScan : handleRerunScan}
                  disabled={deleting || rerunning}
                  className={`px-3 py-2 text-xs rounded-lg font-semibold inline-flex items-center gap-2 ${confirmAction === "delete" ? "text-black" : "sky-primary"}`}
                  style={confirmAction === "delete" ? { background: "#f87171" } : undefined}
                >
                  {(deleting || rerunning) && <Loader2 size={13} className="animate-spin" />}
                  {confirmAction === "delete" ? "Delete scan" : "Create re-run"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="h-full">
            {activeTab === "summary"      && <SummaryTab      scan={scan} />}
            {activeTab === "issues"       && <IssuesTab       scanId={scan.id} focusedIssueId={focusedIssueId} onOpenAiFix={(issueId) => { setFocusedIssueId(null); setFocusedFixIssueId(issueId); setActiveTab("fixes"); }} onOpenState={(issue) => { setFocusedIssueId(null); setFocusedStateIssueId(issue.id); setFocusedStateName(issue.state_label || issue.state || issue.phase || "default"); setActiveTab("states"); }} />}
            {activeTab === "fixes"        && <FixesTab        scanId={scan.id} focusedIssueId={focusedFixIssueId} onBackToIssue={(issueId) => { setFocusedFixIssueId(null); setFocusedIssueId(issueId); setActiveTab("issues"); }} />}
            {activeTab === "screenreader" && <ScreenReaderTab scanId={scan.id} />}
            {activeTab === "states"       && <StatesTab       scanId={scan.id} focusedIssueId={focusedStateIssueId} preferredState={focusedStateName} onBackToIssue={(issueId) => { setFocusedIssueId(issueId); setActiveTab("issues"); }} />}
            {activeTab === "testcases"    && <TestCasesTab    scanId={scan.id} />}
            {activeTab === "livedom"      && <LiveDomTab      scanId={scan.id} />}

          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}










