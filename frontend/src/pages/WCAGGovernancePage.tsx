import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { wcagGovernanceApi } from "../services/api";

type GovernanceReview = {
  id: string;
  rule_id: string;
  current_wcag: string[];
  suggested_wcag: string[];
  reason: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
};

type GovernanceStatus = {
  metadata_last_fetched_at: string | null;
  metadata_source: string | null;
  next_refresh_due_at: string | null;
  refresh_interval_days: number;
  criteria_count: number;
  pending_review_count: number;
  reviews: GovernanceReview[];
};

function formatDate(value?: string | null) {
  if (!value) return "Not yet cached";
  const parsed = new Date(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function CriteriaTags({ values }: { values: string[] }) {
  if (!values.length) return <span className="text-xs text-slate-500">None</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span key={value} className="rounded-md border px-2 py-1 text-xs font-medium" style={{ borderColor: "var(--border)", color: "var(--muted-strong)", background: "var(--surface-1)" }}>
          {value}
        </span>
      ))}
    </div>
  );
}

export default function WCAGGovernancePage() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ["wcag-governance-status"],
    queryFn: async () => (await wcagGovernanceApi.status()).data as GovernanceStatus
  });
  const reviewsQuery = useQuery({
    queryKey: ["wcag-governance-reviews", "pending"],
    queryFn: async () => (await wcagGovernanceApi.reviews("pending")).data as GovernanceReview[]
  });

  const refreshMutation = useMutation({
    mutationFn: async () => (await wcagGovernanceApi.refresh()).data as GovernanceStatus,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wcag-governance-status"] });
      queryClient.invalidateQueries({ queryKey: ["wcag-governance-reviews"] });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => wcagGovernanceApi.updateReview(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wcag-governance-status"] });
      queryClient.invalidateQueries({ queryKey: ["wcag-governance-reviews"] });
    }
  });

  const status = statusQuery.data;
  const reviews = reviewsQuery.data || status?.reviews || [];
  const isBusy = statusQuery.isLoading || reviewsQuery.isLoading || refreshMutation.isPending;

  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--muted-strong)" }}>
              <ShieldCheck size={18} />
              Governance
            </div>
            <h1 className="mt-2 text-3xl font-bold" style={{ color: "var(--text-strong)" }}>WCAG Rules</h1>
          </div>
          <button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="sky-primary inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
          >
            {refreshMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh now
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-lg border p-5" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
            <div className="text-xs font-medium uppercase" style={{ color: "var(--muted)" }}>Criteria Cached</div>
            <div className="mt-3 text-3xl font-bold" style={{ color: "var(--text-strong)" }}>{status?.criteria_count ?? "--"}</div>
          </div>
          <div className="rounded-lg border p-5" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
            <div className="text-xs font-medium uppercase" style={{ color: "var(--muted)" }}>Pending Checks</div>
            <div className="mt-3 flex items-center gap-2 text-3xl font-bold" style={{ color: "var(--text-strong)" }}>
              {status?.pending_review_count ?? "--"}
              {!!status?.pending_review_count && <AlertTriangle size={20} className="text-amber-500" />}
            </div>
          </div>
          <div className="rounded-lg border p-5" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
            <div className="text-xs font-medium uppercase" style={{ color: "var(--muted)" }}>Last Fetched</div>
            <div className="mt-3 text-sm font-semibold" style={{ color: "var(--text-strong)" }}>{formatDate(status?.metadata_last_fetched_at)}</div>
            <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>{status?.metadata_source || "No source recorded"}</div>
          </div>
          <div className="rounded-lg border p-5" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
            <div className="text-xs font-medium uppercase" style={{ color: "var(--muted)" }}>Next Refresh</div>
            <div className="mt-3 flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
              <Clock size={16} />
              {formatDate(status?.next_refresh_due_at)}
            </div>
          </div>
        </div>

        {(statusQuery.isError || reviewsQuery.isError || refreshMutation.isError || updateMutation.isError) && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm font-medium text-red-700">
            WCAG governance data could not be loaded. Please retry after the backend is running.
          </div>
        )}

        <div className="rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
          <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--border)" }}>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>Manual Review Queue</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>Suspicious or stale WCAG mappings awaiting admin decision.</p>
            </div>
            {isBusy && <Loader2 size={18} className="animate-spin" style={{ color: "var(--muted)" }} />}
          </div>

          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {!isBusy && reviews.length === 0 && (
              <div className="px-5 py-10 text-center text-sm" style={{ color: "var(--muted)" }}>No pending manual checks.</div>
            )}
            {reviews.map((review) => (
              <div key={review.id} className="grid gap-4 px-5 py-5 lg:grid-cols-[1fr_auto]">
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold" style={{ color: "var(--text-strong)" }}>{review.rule_id}</span>
                    <span className="rounded-md bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-500">{review.status}</span>
                  </div>
                  <p className="text-sm leading-6" style={{ color: "var(--muted-strong)" }}>{review.reason}</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase" style={{ color: "var(--muted)" }}>Current Criteria</div>
                      <CriteriaTags values={review.current_wcag || []} />
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase" style={{ color: "var(--muted)" }}>Suggested Criteria</div>
                      <CriteriaTags values={review.suggested_wcag || []} />
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                  <button
                    type="button"
                    onClick={() => updateMutation.mutate({ id: review.id, status: "accepted" })}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"
                    style={{ borderColor: "var(--border)", color: "var(--text-strong)", background: "var(--surface-1)" }}
                  >
                    <Check size={15} />
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => updateMutation.mutate({ id: review.id, status: "dismissed" })}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"
                    style={{ borderColor: "var(--border)", color: "var(--text-strong)", background: "var(--surface-1)" }}
                  >
                    <X size={15} />
                    Dismiss
                  </button>
                  <button
                    type="button"
                    onClick={() => updateMutation.mutate({ id: review.id, status: "resolved" })}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"
                    style={{ borderColor: "var(--border)", color: "var(--text-strong)", background: "var(--surface-1)" }}
                  >
                    <ShieldCheck size={15} />
                    Resolved
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
