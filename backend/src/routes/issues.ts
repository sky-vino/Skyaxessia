import { Router, Response } from "express";
import { authenticate, AuthRequest } from "../middleware/auth";
import { db } from "../utils/db";
import { aiService } from "../services/aiService";

export const issueRouter = Router();
issueRouter.use(authenticate);

// GET /api/issues?scan_id=...&severity=...&page=...
issueRouter.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { scan_id, severity, category, rule_id, priority, is_resolved, include_advisory, page: pageQ, limit: limitQ } = req.query as any;
  const page = Number(pageQ) || 1;
  const limit = Math.min(Number(limitQ) || 50, 1000);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: any[] = [];

  if (scan_id) { params.push(scan_id); conditions.push(`scan_id = $${params.length}`); }
  if (severity) { params.push(severity); conditions.push(`severity = $${params.length}`); }
  if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
  if (rule_id) { params.push(rule_id); conditions.push(`rule_id = $${params.length}`); }
  if (priority) { params.push(Number(priority)); conditions.push(`priority = $${params.length}`); }
  if (typeof is_resolved !== "undefined") { params.push(is_resolved === "true" || is_resolved === true); conditions.push(`is_resolved = $${params.length}`); }
  if (include_advisory !== "true" && category !== "advisory") { conditions.push(`COALESCE(category, '') <> 'advisory'`); }
  conditions.push(`COALESCE(false_positive, false) = false`);

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const q = `SELECT * FROM issues ${where} ORDER BY
    CASE WHEN is_resolved THEN 1 ELSE 0 END,
    priority ASC,
    CASE severity WHEN 'critical' THEN 1 WHEN 'serious' THEN 2 WHEN 'moderate' THEN 3 ELSE 4 END,
    created_at
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  params.push(limit, offset);

  const [rows, count] = await Promise.all([
    db.query(q, params),
    db.query(`SELECT COUNT(*) FROM issues ${where}`, params.slice(0, -2))
  ]);

  // Ship 2 / Item 5 — cross-URL landmark grouping.
  // Issues sharing a landmark_group_key across different URLs are collapsed:
  // one primary entry kept (the highest-priority one), with page_occurrences
  // and page_urls populated so the frontend + PDF can show "Appears on N
  // pages" instead of listing 30 identical footer duplicates.
  //
  // Non-landmark issues (landmark_group_key NULL) pass through unchanged.
  // If a caller is filtering by scan_id AND that scan has only 1 URL, this
  // still runs but produces page_occurrences=1 for every issue — same
  // behavior as before, no visual change.
  const raw = rows.rows as any[];
  const groups = new Map<string, any[]>();
  const singletons: any[] = [];
  for (const issue of raw) {
    const key = issue.landmark_group_key;
    if (!key) { singletons.push(issue); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(issue);
  }
  const priorityRank = (sev?: string) => sev === "critical" ? 1 : sev === "serious" ? 2 : sev === "moderate" ? 3 : 4;
  const grouped: any[] = [];
  for (const items of groups.values()) {
    // Pick the highest-priority representative. Same rule, likely
    // identical content; we only need one for the report.
    items.sort((a, b) => (a.priority || 3) - (b.priority || 3) || priorityRank(a.severity) - priorityRank(b.severity));
    const primary = items[0];
    const pageUrls = Array.from(new Set(items.map(it => it.url).filter(Boolean)));
    grouped.push({
      ...primary,
      page_occurrences: pageUrls.length,
      page_urls: pageUrls,
      _grouped_issue_ids: items.map(it => it.id), // hidden helper for future actions (mark-resolved on group)
    });
  }
  const finalIssues = [
    ...singletons.map(it => ({ ...it, page_occurrences: 1, page_urls: [it.url].filter(Boolean) })),
    ...grouped,
  ].sort((a, b) => {
    if (a.is_resolved !== b.is_resolved) return a.is_resolved ? 1 : -1;
    if ((a.priority || 3) !== (b.priority || 3)) return (a.priority || 3) - (b.priority || 3);
    return priorityRank(a.severity) - priorityRank(b.severity);
  });

  res.json({ issues: finalIssues, total: Number(count.rows[0].count), page, limit });
});

// GET /api/issues/:id
issueRouter.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query("SELECT * FROM issues WHERE id = $1", [req.params.id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Issue not found" }); return; }
  res.json({ issue: result.rows[0] });
});

// POST /api/issues/:id/ai-explain
issueRouter.post("/:id/ai-explain", async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query("SELECT * FROM issues WHERE id = $1", [req.params.id]);
  const issue = result.rows[0];
  if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }

  if (issue.ai_explanation) {
    // Tier 4 fix — infer source for previously-persisted results (no DB
    // migration required). The generic fallback fix_code contains a fixed
    // marker string; we treat that as evidence the fallback fired. A
    // dedicated ai_source column would be cleaner but requires a migration.
    const cachedIsFallback = /Please refer to WCAG documentation/i.test(String(issue.ai_fix_code || ""));
    res.json({
      explanation: issue.ai_explanation,
      impact: issue.ai_impact,
      fix_code: issue.ai_fix_code,
      source: cachedIsFallback ? "fallback" : "ai",
    });
    return;
  }

  const ai = await aiService.explainIssue(issue);
  await db.query(
    "UPDATE issues SET ai_explanation = $1, ai_impact = $2, ai_fix_code = $3 WHERE id = $4",
    [ai.explanation, ai.impact, ai.fix_code, issue.id]
  );
  res.json(ai); // ai already includes { source, fallback_reason? }
});

// PATCH /api/issues/:id
issueRouter.patch("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const { is_resolved, false_positive, priority } = req.body;
  const sets: string[] = [];
  const params: any[] = [];

  if (typeof is_resolved === "boolean") { params.push(is_resolved); sets.push(`is_resolved = $${params.length}`); }
  if (typeof false_positive === "boolean") { params.push(false_positive); sets.push(`false_positive = $${params.length}`); }
  if (priority) { params.push(priority); sets.push(`priority = $${params.length}`); }

  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }

  params.push(req.params.id);
  const result = await db.query(
    `UPDATE issues SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  const issue = result.rows[0];
  if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }

  if (typeof is_resolved === "boolean" || typeof false_positive === "boolean") {
    const unresolved = await db.query(
      `SELECT COUNT(*) AS count FROM issues
       WHERE scan_id = $1 AND rule_id = $2 AND url = $3 AND is_resolved = $4 AND false_positive = $5`,
      [issue.scan_id, issue.rule_id, issue.url, false, false]
    );
    const nextStatus = Number(unresolved.rows[0]?.count || 0) === 0 ? "pass" : "fail";
    await db.query(
      `UPDATE test_cases SET status = $1
       WHERE scan_id = $2
         AND category NOT IN ('manual-review', 'hybrid-review')
         AND (issue_id = $3 OR (description LIKE $4 AND description LIKE $5))`,
      [nextStatus, issue.scan_id, issue.id, `%${issue.rule_id}%`, `%${issue.url}%`]
    );
  }

  res.json({ issue });
});




