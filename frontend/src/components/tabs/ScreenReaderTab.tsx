/**
 * ScreenReaderTab.tsx
 * -----------------------------------------------------------------------------
 * Visualises Axessia's screen-reader-perspective analysis for the selected scan.
 * Pulls the ScreenReaderReport captured during the scan (attached to each
 * DomSnapshot as `screen_reader_report`) and renders four sections:
 *
 *   1. Score gauge + counts (nodes, interactive, landmarks, headings)
 *   2. Landmarks + Headings structure
 *   3. Simulated announcement transcript (what a SR would say)
 *   4. Live regions + reading order divergence highlights
 *
 * If no report is present (older scan or run_screen_reader=false), shows an
 * empty-state with a "how to enable" hint.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { scanApi } from "../../services/api";
import {
  Ear, Compass, Heading1, MessageSquare, Volume2, AlertOctagon,
  ArrowRight, ChevronDown, ChevronRight
} from "lucide-react";

interface Props {
  scanId: string;
}

interface AnnouncementStep {
  index: number;
  announcement: string;
  role: string;
  name: string;
  domSelector?: string;
  hasName: boolean;
  isGenericName: boolean;
}

interface LandmarkInfo { role: string; name: string; domSelector?: string; }
interface HeadingInfo  { level: number; text: string; domSelector?: string; }
interface LiveRegionInfo { ariaLive: string; role?: string; text: string; domSelector?: string; }

interface ScreenReaderReport {
  url: string;
  extractedAt: string;
  nodeCount: number;
  ignoredCount: number;
  interactiveCount: number;
  landmarks: LandmarkInfo[];
  headings: HeadingInfo[];
  liveRegions: LiveRegionInfo[];
  announcementTranscript: AnnouncementStep[];
  readingOrderDivergences: number;
  score: number;
}

export default function ScreenReaderTab({ scanId }: Props) {
  const { data: snapshotData, isLoading } = useQuery({
    queryKey: ["scan", scanId, "dom-snapshots"],
    queryFn: () => scanApi.domSnapshots(scanId).then(r => r.data),
    staleTime: 30000
  });

  const snapshots: any[] = useMemo(() => {
    if (!snapshotData) return [];
    if (Array.isArray(snapshotData.snapshots)) return snapshotData.snapshots;
    return [];
  }, [snapshotData]);

  // Prefer the "initial" phase of the first URL scanned that has a report attached.
  const reports: { url: string; report: ScreenReaderReport }[] = useMemo(() => {
    const out: { url: string; report: ScreenReaderReport }[] = [];
    const seen = new Set<string>();
    for (const snap of snapshots) {
      const report = snap?.screen_reader_report;
      if (!report) continue;
      const key = `${snap.url}::${snap.phase || "initial"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: snap.url, report });
    }
    return out;
  }, [snapshots]);

  const [selectedUrl, setSelectedUrl] = useState<string>("");
  const activeReport = useMemo(() => {
    if (!reports.length) return null;
    const match = reports.find(r => r.url === selectedUrl);
    return match?.report || reports[0].report;
  }, [reports, selectedUrl]);

  if (isLoading) {
    return <div className="p-6 text-slate-400 text-sm">Loading screen reader report…</div>;
  }

  if (!reports.length) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-3 p-4 rounded-xl" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <Ear size={20} style={{ color: "var(--muted)" }} className="mt-0.5 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              No screen reader report for this scan
            </div>
            <div className="text-xs mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>
              This scan was run before screen-reader perspective was enabled, or the option
              was turned off. Rerun the scan with <code className="px-1 py-0.5 rounded"
              style={{ background: "var(--surface-3)" }}>run_screen_reader: true</code> in
              scan options (the default). The next scan will populate this tab with the
              simulated announcement transcript, landmarks, headings, and live regions.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {reports.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {reports.map(r => (
            <button
              key={r.url}
              onClick={() => setSelectedUrl(r.url)}
              className="text-xs px-3 py-1.5 rounded-lg border transition-all"
              style={{
                borderColor: (selectedUrl || reports[0].url) === r.url ? "rgba(15,118,110,0.5)" : "var(--border-strong)",
                color: (selectedUrl || reports[0].url) === r.url ? "#0f766e" : "var(--text)",
                background: (selectedUrl || reports[0].url) === r.url ? "rgba(15,118,110,0.08)" : "transparent"
              }}
            >
              {new URL(r.url).pathname || r.url}
            </button>
          ))}
        </div>
      )}

      {activeReport && <ReportView report={activeReport} />}
    </div>
  );
}

function ReportView({ report }: { report: ScreenReaderReport }) {
  const missingName = report.announcementTranscript.filter(a => !a.hasName).length;
  const genericName = report.announcementTranscript.filter(a => a.isGenericName).length;

  return (
    <>
      {/* Row 1 — Score + stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Ear size={16} />}
          label="Screen Reader Score"
          value={`${report.score}/100`}
          hint={report.score >= 80 ? "Excellent" : report.score >= 50 ? "Needs work" : "Critical gaps"}
          accent={report.score >= 80 ? "#0f766e" : report.score >= 50 ? "#ffd60a" : "#ff4d6d"}
        />
        <StatCard
          icon={<Compass size={16} />}
          label="Landmarks"
          value={report.landmarks.length}
          hint={report.landmarks.some(l => l.role === "main") ? "main present" : "main missing"}
          accent={report.landmarks.some(l => l.role === "main") ? "#0f766e" : "#ff9f43"}
        />
        <StatCard
          icon={<Heading1 size={16} />}
          label="Headings"
          value={report.headings.length}
          hint={
            report.headings.filter(h => h.level === 1).length
              ? `${report.headings.filter(h => h.level === 1).length} h1`
              : "no h1"
          }
          accent={report.headings.filter(h => h.level === 1).length ? "#0f766e" : "#ff9f43"}
        />
        <StatCard
          icon={<AlertOctagon size={16} />}
          label="Missing / Generic Names"
          value={`${missingName + genericName}`}
          hint={`${missingName} missing • ${genericName} generic`}
          accent={missingName + genericName === 0 ? "#0f766e" : missingName > 0 ? "#ff4d6d" : "#ffd60a"}
        />
      </div>

      {/* Row 2 — Landmarks + Headings side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Landmarks" icon={<Compass size={14} />}>
          {report.landmarks.length === 0 ? (
            <Empty text="No landmarks detected. Screen reader users rely on landmarks to skip to main content." />
          ) : (
            <div className="space-y-1.5">
              {report.landmarks.map((l, i) => (
                <div key={i} className="flex items-center gap-2 text-xs" style={{ color: "var(--text)" }}>
                  <span className="px-2 py-0.5 rounded font-mono text-[10px]"
                    style={{ background: "rgba(15,118,110,0.12)", color: "#0f766e" }}>
                    {l.role}
                  </span>
                  <span>{l.name || <em style={{ color: "var(--muted)" }}>(no accessible name)</em>}</span>
                  {l.domSelector && (
                    <code className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: "var(--surface-3)", color: "var(--muted)" }}>
                      {l.domSelector}
                    </code>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Headings" icon={<Heading1 size={14} />}>
          {report.headings.length === 0 ? (
            <Empty text="No headings detected. Screen reader users navigate by pressing h/1-6 keys; no headings breaks that flow." />
          ) : (
            <div className="space-y-1.5">
              {report.headings.map((h, i) => (
                <div key={i} className="flex items-center gap-2 text-xs" style={{ color: "var(--text)" }}>
                  <span className="px-2 py-0.5 rounded font-mono text-[10px]"
                    style={{ background: "rgba(110,86,207,0.12)", color: "#6e56cf" }}>
                    h{h.level}
                  </span>
                  <span style={{ paddingLeft: `${(h.level - 1) * 8}px` }}>{h.text || <em>(empty)</em>}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* Row 3 — Simulated announcement transcript */}
      <Section
        title="Simulated Announcement Transcript"
        icon={<MessageSquare size={14} />}
        subtitle="What a screen reader would say as user tabs through the page. Approximates NVDA output."
      >
        {report.announcementTranscript.length === 0 ? (
          <Empty text="No interactive elements or landmarks announced." />
        ) : (
          <TranscriptList steps={report.announcementTranscript} />
        )}
      </Section>

      {/* Row 4 — Live regions + reading order */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Live Regions" icon={<Volume2 size={14} />}>
          {report.liveRegions.length === 0 ? (
            <Empty text="No live regions detected. That's fine for static pages; if the page has dynamic updates (toasts, error alerts, cart updates) they will not be announced." />
          ) : (
            <div className="space-y-2">
              {report.liveRegions.map((lr, i) => (
                <div key={i} className="p-2.5 rounded-lg text-xs" style={{ background: "var(--surface-3)" }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-2 py-0.5 rounded font-mono text-[10px]"
                      style={{ background: "rgba(224,0,98,0.12)", color: "#e00062" }}>
                      aria-live="{lr.ariaLive}"
                    </span>
                    {lr.role && (
                      <span className="px-2 py-0.5 rounded font-mono text-[10px]"
                        style={{ background: "var(--surface-2)", color: "var(--muted)" }}>
                        role="{lr.role}"
                      </span>
                    )}
                  </div>
                  <div style={{ color: "var(--text)" }}>{lr.text || <em style={{ color: "var(--muted)" }}>(currently empty)</em>}</div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Reading Order" icon={<ArrowRight size={14} />}>
          <div className="text-xs space-y-2" style={{ color: "var(--text)" }}>
            <div>
              <span className="text-2xl font-semibold" style={{ color: report.readingOrderDivergences > 0 ? "#ff9f43" : "#0f766e" }}>
                {report.readingOrderDivergences}
              </span>{" "}
              <span style={{ color: "var(--muted)" }}>
                {report.readingOrderDivergences === 1 ? "divergence" : "divergences"} detected
              </span>
            </div>
            <div style={{ color: "var(--muted)" }}>
              A screen reader announces content in DOM order. When visual layout uses
              flex/grid/absolute positioning to reorder, screen reader users experience
              content in a different sequence than sighted users. This can make forms,
              instructions, and cause-effect relationships confusing.
            </div>
            <div style={{ color: "var(--muted)" }} className="pt-2 border-t" >
              Tree stats: <strong style={{ color: "var(--text)" }}>{report.nodeCount}</strong> nodes ·{" "}
              <strong style={{ color: "var(--text)" }}>{report.interactiveCount}</strong> interactive ·{" "}
              <strong style={{ color: "var(--text)" }}>{report.ignoredCount}</strong> ignored by screen reader
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// Small subcomponents
// -----------------------------------------------------------------------------

function StatCard({ icon, label, value, hint, accent }: {
  icon: React.ReactNode; label: string; value: string | number; hint: string; accent: string;
}) {
  return (
    <div className="p-3 rounded-xl border" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
      <div className="flex items-center gap-2 mb-1.5 text-xs" style={{ color: "var(--muted)" }}>
        <span style={{ color: accent }}>{icon}</span>
        {label}
      </div>
      <div className="text-lg font-semibold" style={{ color: "var(--text)" }}>{value}</div>
      <div className="text-[10px] mt-0.5" style={{ color: accent }}>{hint}</div>
    </div>
  );
}

function Section({ title, icon, subtitle, children }: {
  title: string; icon: React.ReactNode; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
      <div className="flex items-center gap-2 mb-1 text-sm font-medium" style={{ color: "var(--text)" }}>
        <span style={{ color: "var(--muted-strong)" }}>{icon}</span>
        {title}
      </div>
      {subtitle && <div className="text-[11px] mb-3" style={{ color: "var(--muted)" }}>{subtitle}</div>}
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="text-xs italic p-2" style={{ color: "var(--muted)" }}>{text}</div>
  );
}

function TranscriptList({ steps }: { steps: AnnouncementStep[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? steps : steps.slice(0, 20);
  return (
    <div>
      <div className="space-y-1 max-h-[440px] overflow-y-auto pr-1">
        {visible.map(step => (
          <div
            key={step.index}
            className="flex items-start gap-3 py-1.5 px-2 rounded"
            style={{
              background: !step.hasName ? "rgba(255, 77, 109, 0.05)"
                : step.isGenericName ? "rgba(255, 159, 67, 0.05)" : "transparent"
            }}
          >
            <span className="text-[10px] font-mono w-6 flex-shrink-0 mt-0.5" style={{ color: "var(--muted)" }}>
              {String(step.index).padStart(3, "0")}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-xs leading-relaxed" style={{
                color: !step.hasName ? "#ff4d6d" : step.isGenericName ? "#ff9f43" : "var(--text)"
              }}>
                {step.announcement}
              </div>
              {step.domSelector && (
                <code className="text-[10px] block truncate mt-0.5" style={{ color: "var(--muted)" }}>
                  {step.domSelector}
                </code>
              )}
            </div>
            {!step.hasName && (
              <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                style={{ background: "rgba(255,77,109,0.15)", color: "#ff4d6d" }}>
                unlabeled
              </span>
            )}
            {step.hasName && step.isGenericName && (
              <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                style={{ background: "rgba(255,159,67,0.15)", color: "#ff9f43" }}>
                generic
              </span>
            )}
          </div>
        ))}
      </div>
      {steps.length > 20 && (
        <button
          className="mt-3 text-xs flex items-center gap-1 hover:opacity-80 transition-opacity"
          style={{ color: "var(--muted)" }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? "Show first 20 only" : `Show all ${steps.length} announcements`}
        </button>
      )}
    </div>
  );
}
