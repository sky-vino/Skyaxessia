import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Loader2, ChevronRight, ChevronDown, Trees, Camera, AlertCircle } from "lucide-react";
import { scanApi } from "../services/api";

/**
 * Live DOM tab — renders the DOM/accessibility-tree snapshots the scanner
 * already captures (backend/src/scanner/scanner.ts:captureSnapshot). Data is
 * fetched from GET /api/scans/:id/dom-snapshots which returns:
 *   { snapshots: [{ id, scan_id, url, phase, a11y_tree, screenshot, created_at }] }
 * where a11y_tree is a JSON string of the Playwright accessibility.snapshot()
 * output (roughly { role, name, children: [...] }).
 *
 * Previous version of this tab was a placeholder ("Paused for now"). The
 * underlying data was already being written to the DB — the tab just never
 * rendered it. Fixed as part of the Tier 2 review.
 */

interface Snapshot {
  id: string;
  scan_id: string;
  url: string;
  phase: string;
  a11y_tree: string | null;
  screenshot: string | null;
  created_at: string;
}

interface AxNode {
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  children?: AxNode[];
  disabled?: boolean;
  focused?: boolean;
  focusable?: boolean;
  expanded?: boolean;
  selected?: boolean;
  checked?: boolean | string;
  level?: number;
}

function safeParseTree(raw: string | null): AxNode | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as AxNode;
    return null;
  } catch {
    return null;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return url;
  }
}

function TreeNode({ node, depth, defaultOpen }: { node: AxNode; depth: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen || depth < 2);
  const kids = node.children || [];
  const hasKids = kids.length > 0;

  const stateChips: string[] = [];
  if (node.focused) stateChips.push("focused");
  if (node.disabled) stateChips.push("disabled");
  if (node.expanded === true) stateChips.push("expanded");
  if (node.expanded === false) stateChips.push("collapsed");
  if (node.selected) stateChips.push("selected");
  if (node.checked === true) stateChips.push("checked");
  if (node.checked === "mixed") stateChips.push("mixed");
  if (typeof node.level === "number") stateChips.push(`level ${node.level}`);

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      <div className="flex items-start gap-1.5 py-1 group hover:bg-white/[0.02] rounded px-1">
        <button
          onClick={() => setOpen(!open)}
          className="mt-0.5 text-slate-500 hover:text-slate-300 flex-shrink-0"
          aria-label={open ? "Collapse" : "Expand"}
          disabled={!hasKids}
          style={{ opacity: hasKids ? 1 : 0 }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-1.5">
          <span className="text-[11px] font-mono text-accent whitespace-nowrap">
            {node.role || "generic"}
          </span>
          {node.name && (
            <span className="text-xs text-slate-200 truncate" title={node.name}>
              "{node.name.length > 90 ? `${node.name.slice(0, 90)}…` : node.name}"
            </span>
          )}
          {stateChips.map((chip) => (
            <span
              key={chip}
              className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ background: "rgba(167,139,250,0.1)", color: "#a78bfa" }}
            >
              {chip}
            </span>
          ))}
          {node.value && (
            <span className="text-[10px] text-slate-500 truncate">= {String(node.value).slice(0, 60)}</span>
          )}
        </div>
      </div>
      {open && hasKids && (
        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.05)", marginLeft: 6 }}>
          {kids.map((child, i) => (
            <TreeNode key={i} node={child} depth={depth + 1} defaultOpen={false} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function LiveDomTab({ scanId }: { scanId: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dom-snapshots", scanId],
    queryFn: () => scanApi.domSnapshots(scanId).then((r) => r.data as { snapshots: Snapshot[] }),
    enabled: Boolean(scanId),
  });

  const snapshots = useMemo(() => data?.snapshots || [], [data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && snapshots.length > 0) setSelectedId(snapshots[0].id);
  }, [snapshots, selectedId]);

  const selected = snapshots.find((s) => s.id === selectedId) || snapshots[0];
  const tree = useMemo(() => (selected ? safeParseTree(selected.a11y_tree) : null), [selected]);

  if (isLoading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-accent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <div className="card p-6 flex items-start gap-3" style={{ borderColor: "rgba(255,77,109,0.4)" }}>
          <AlertCircle size={20} className="text-rose-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-slate-200 mb-1">Could not load DOM snapshots</div>
            <div className="text-xs text-slate-500">{(error as any)?.message || "Unknown error"}</div>
          </div>
        </div>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="p-6">
        <div className="card p-6 text-sm text-slate-500 text-center">
          No DOM snapshots were captured for this scan. This can happen when
          <code className="mx-1 text-xs">run_live_dom</code>
          was turned off in Scan Options, or when the scanner could not read
          the page (auth failure, navigation error). Rerun with Live DOM
          enabled to populate this tab.
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="p-4 grid gap-4"
      style={{ gridTemplateColumns: "260px 1fr" }}
    >
      {/* Snapshot list */}
      <aside className="card p-3 max-h-[70vh] overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-2 px-1">
          {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}
        </div>
        <div className="space-y-1">
          {snapshots.map((s) => {
            const isActive = selected && selected.id === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left rounded-lg px-3 py-2 transition-colors ${
                  isActive ? "text-accent" : "text-slate-400 hover:text-slate-200"
                }`}
                style={{
                  background: isActive ? "rgba(15,118,110,0.08)" : "rgba(255,255,255,0.02)",
                  border: `1px solid ${isActive ? "rgba(15,118,110,0.35)" : "var(--border)"}`,
                }}
              >
                <div className="text-[10px] uppercase tracking-wide" style={{ color: isActive ? "var(--accent)" : "#64748b" }}>
                  {s.phase || "initial"}
                </div>
                <div className="text-xs font-medium truncate mt-0.5" title={s.url}>
                  {shortUrl(s.url)}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Selected snapshot detail */}
      <section className="space-y-4">
        {selected && (
          <>
            <div className="card p-4">
              <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-1">Snapshot</div>
              <div className="text-sm text-slate-200 truncate" title={selected.url}>{selected.url}</div>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500">
                <span>Phase: <span className="text-slate-300">{selected.phase || "initial"}</span></span>
                <span>Captured: <span className="text-slate-300">{new Date(selected.created_at).toLocaleString()}</span></span>
              </div>
            </div>

            {selected.screenshot && (
              <div className="card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Camera size={14} className="text-accent" />
                  <div className="text-xs font-semibold text-slate-300">Rendered screenshot</div>
                </div>
                <img
                  src={selected.screenshot}
                  alt={`Screenshot of ${selected.url} at phase ${selected.phase}`}
                  className="w-full rounded-lg border"
                  style={{ borderColor: "rgba(255,255,255,0.05)" }}
                />
              </div>
            )}

            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <Trees size={14} className="text-accent" />
                <div className="text-xs font-semibold text-slate-300">Accessibility tree</div>
                <span className="text-[10px] text-slate-600">(computed by the browser, filtered by the scanner)</span>
              </div>
              {tree ? (
                <div className="text-xs max-h-[50vh] overflow-y-auto pr-2" style={{ fontFamily: "ui-monospace, monospace" }}>
                  <TreeNode node={tree} depth={0} defaultOpen={true} />
                </div>
              ) : (
                <div className="text-xs text-slate-500 py-4 text-center">
                  Accessibility tree was not captured for this snapshot (or could not be parsed).
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </motion.div>
  );
}
