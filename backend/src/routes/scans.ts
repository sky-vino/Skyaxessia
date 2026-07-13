import { Router, Response } from "express";
import { authenticate, AuthRequest } from "../middleware/auth";
import { db } from "../utils/db";
import { scanQueue } from "../services/scanQueue";
import { generateScanReport } from "../services/reportService";
import { z } from "zod";
import { chromium } from "playwright";

export const scanRouter = Router();
scanRouter.use(authenticate);

const createScanSchema = z.object({
  name: z.string().optional(),
  urls: z.array(z.string().url()).min(1).max(20),
  project_id: z.string().uuid().optional(),
  state_label: z.string().optional().default("default"),
  auth_config: z.object({
    login_url: z.string().url(),
    username_selector: z.string().trim().min(1),
    password_selector: z.string().trim().min(1),
    submit_selector: z.string().trim().min(1),
    username: z.string(),
    password: z.string(),
    otp_from_page: z.boolean().optional(),
    otp_selector: z.string().optional(),
    otp_source_selector: z.string().optional(),
    otp_code: z.string().optional(),
    otp_submit_selector: z.string().optional(),
    auto_accept_cookies: z.boolean().optional().default(true),
    cookie_accept_selector: z.string().optional(),
    profile_url: z.string().url().optional(),
    success_url_pattern: z.string().optional(),
    post_login_wait_ms: z.number().optional().default(2000)
  }).optional(),
  scan_options: z.object({
    run_axe: z.boolean().optional().default(true),
    run_heuristics: z.boolean().optional().default(true),
    run_focus: z.boolean().optional().default(true),
    run_keyboard_nav: z.boolean().optional().default(true),
    run_zoom: z.boolean().optional().default(true),
    run_color: z.boolean().optional().default(true),
    run_pointer: z.boolean().optional().default(true),
    run_live_dom: z.boolean().optional().default(true),
    run_dynamic: z.boolean().optional().default(true),
    run_states: z.boolean().optional().default(true),
    run_motion: z.boolean().optional().default(true),
    run_reflow: z.boolean().optional().default(true),
    capture_screenshots: z.boolean().optional().default(true),
    // Ship 1 / Item 4 — zoom target (200 = AA-lite, 400 = WCAG 1.4.10)
    zoom_target_percent: z.union([z.literal(200), z.literal(400)]).optional(),
    // Ship 1 / Item 7 — drop advisory/best-practice rules entirely instead of downgrading
    suppress_advisory_rules: z.boolean().optional(),
    scan_depth_mode: z.enum(["shallow", "standard", "exhaustive"]).optional().default("standard"),
    viewport_width: z.number().optional().default(1366),
    viewport_height: z.number().optional().default(768),
    headful: z.boolean().optional().default(false),
    scan_entry_mode: z.enum(["url", "journey"]).optional().default("url"),
    crawl_mode: z.boolean().optional().default(false),
    crawl_depth: z.number().optional().default(2),
    crawl_same_domain: z.boolean().optional().default(true),
    crawl_include_patterns: z.array(z.string()).optional().default([]),
    crawl_exclude_patterns: z.array(z.string()).optional().default([]),
    crawl_max_pages: z.number().optional().default(30),
    scan_login_page: z.boolean().optional().default(false),
    scan_post_login_landing: z.boolean().optional().default(false),
    scan_gestisci_page: z.boolean().optional().default(false),
    post_login_tab_scan: z.boolean().optional().default(true),
    post_login_tab_limit: z.number().optional().default(12),
    post_login_pages: z.array(z.string()).optional().default([]),
    controlled_interaction_scan: z.boolean().optional().default(false),
    controlled_interaction_mode: z.enum(["safe-auto", "tester-selected", "exhaustive"]).optional().default("safe-auto"),
    controlled_interaction_allowlist: z.array(z.string().trim()).optional().default([]),
    controlled_interaction_limit: z.number().optional().default(12),
    extension_session_cookies: z.array(z.object({
      name: z.string().trim(),
      value: z.string(),
      domain: z.string().trim(),
      path: z.string().optional().default("/"),
      expires: z.number().optional(),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
      sameSite: z.enum(["Lax", "Strict", "None"]).optional()
    })).optional().default([]),
    target_interactions: z.array(z.object({
      base_page: z.string().trim().min(1),
      mode: z.enum(["single-interaction", "journey"]).optional().default("single-interaction"),
      name: z.string().trim().optional(),
      selector: z.string().trim().optional(),
      text: z.string().trim().optional(),
      cta_text: z.string().trim().optional(),
      href_contains: z.string().trim().optional(),
      click_type: z.enum(["button", "link", "heading-link", "any"]).optional().default("any"),
      scan_destination_only: z.boolean().optional().default(true),
      scan_launch_page: z.boolean().optional().default(false),
      steps: z.array(z.object({
        action: z.enum(["navigate-page", "click"]),
        page: z.string().trim().optional(),
        name: z.string().trim().optional(),
        selector: z.string().trim().optional(),
        text: z.string().trim().optional(),
        cta_text: z.string().trim().optional(),
        href_contains: z.string().trim().optional(),
        click_type: z.enum(["button", "link", "heading-link", "any"]).optional().default("any"),
        scan_after_step: z.boolean().optional().default(false)
      })).optional().default([])
    }).refine(item => {
      if (item.mode === "journey") return item.steps.some(step => step.action === "navigate-page" ? Boolean(step.page) : Boolean(step.selector || step.text || step.cta_text || step.href_contains));
      return Boolean(item.selector || item.text || item.cta_text || item.href_contains);
    }, {
      message: "Provide a single target selector/text/href or at least one valid journey step"
    })).optional().default([]),
    owner_fallback_rules: z.array(z.object({
      pattern: z.string().trim().min(1),
      owner: z.string().trim().min(1),
      component: z.string().trim().optional(),
      source: z.string().trim().optional(),
      match: z.enum(["url", "selector", "message", "any"]).optional().default("any")
    })).optional().default([])
  }).optional().default({})
});

// GET /api/scans
scanRouter.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const page  = Number(req.query.page)  || 1;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const projectId = req.query.project_id as string | undefined;
  const dateFrom = req.query.date_from as string | undefined;
  const dateTo = req.query.date_to as string | undefined;
  const nameFilter = req.query.name as string | undefined;
  const params: any[] = [];
  const conditions: string[] = [];
  if (projectId) { params.push(projectId); conditions.push(`s.project_id = $${params.length}`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`DATE(s.created_at) >= DATE($${params.length})`); }
  if (dateTo) { params.push(dateTo); conditions.push(`DATE(s.created_at) <= DATE($${params.length})`); }
  if (nameFilter) { params.push(`%${nameFilter}%`); conditions.push(`LOWER(COALESCE(s.name, '')) LIKE LOWER($${params.length})`); }
  const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
  const [rows, count, completedCount, activeCount] = await Promise.all([
    db.query(
      `SELECT s.*, u.full_name AS created_by_name,
        COALESCE(tc.total, 0) AS test_cases_total,
        COALESCE(tc.pass_count, 0) AS test_cases_pass,
        COALESCE(tc.fail_count, 0) AS test_cases_fail,
        COALESCE(tc.pending_count, 0) AS test_cases_pending,
        COALESCE(tc.automated_pass_count, 0) AS test_cases_automated_pass,
        COALESCE(tc.automated_fail_count, 0) AS test_cases_automated_fail,
        COALESCE(tc.automated_pending_count, 0) AS test_cases_automated_pending,
        COALESCE(tc.manual_pass_count, 0) AS test_cases_manual_pass,
        COALESCE(tc.manual_fail_count, 0) AS test_cases_manual_fail,
        COALESCE(tc.manual_pending_count, 0) AS test_cases_manual_pending,
        COALESCE(tc.hybrid_pass_count, 0) AS test_cases_hybrid_pass,
        COALESCE(tc.hybrid_fail_count, 0) AS test_cases_hybrid_fail,
        COALESCE(tc.hybrid_pending_count, 0) AS test_cases_hybrid_pending
       FROM scans s
       JOIN users u ON u.id = s.created_by
       LEFT JOIN (
         SELECT scan_id,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS pass_count,
          SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS fail_count,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN category NOT IN ('manual-review','hybrid-review') AND status = 'pass' THEN 1 ELSE 0 END) AS automated_pass_count,
          SUM(CASE WHEN category NOT IN ('manual-review','hybrid-review') AND status = 'fail' THEN 1 ELSE 0 END) AS automated_fail_count,
          SUM(CASE WHEN category NOT IN ('manual-review','hybrid-review') AND status = 'pending' THEN 1 ELSE 0 END) AS automated_pending_count,
          SUM(CASE WHEN category = 'manual-review' AND status = 'pass' THEN 1 ELSE 0 END) AS manual_pass_count,
          SUM(CASE WHEN category = 'manual-review' AND status = 'fail' THEN 1 ELSE 0 END) AS manual_fail_count,
          SUM(CASE WHEN category = 'manual-review' AND status = 'pending' THEN 1 ELSE 0 END) AS manual_pending_count,
          SUM(CASE WHEN category = 'hybrid-review' AND status = 'pass' THEN 1 ELSE 0 END) AS hybrid_pass_count,
          SUM(CASE WHEN category = 'hybrid-review' AND status = 'fail' THEN 1 ELSE 0 END) AS hybrid_fail_count,
          SUM(CASE WHEN category = 'hybrid-review' AND status = 'pending' THEN 1 ELSE 0 END) AS hybrid_pending_count
         FROM test_cases
         GROUP BY scan_id
       ) tc ON tc.scan_id = s.id
       WHERE 1=1 ${where}
       ORDER BY s.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM scans s WHERE 1=1 ${where}`, params),
    db.query("SELECT COUNT(*) FROM scans WHERE status = 'completed'"),
    db.query("SELECT COUNT(*) FROM scans WHERE status IN ('running','queued')"),
  ]);
  res.json({
    scans: rows.rows,
    total: Number(count.rows[0].count),
    completed_total: Number(completedCount.rows[0].count),
    active_total: Number(activeCount.rows[0].count),
    page,
    limit
  });
});

// GET /api/scans/:id
scanRouter.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT s.*, u.full_name AS created_by_name FROM scans s
     JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Scan not found" }); return; }
  res.json({ scan: result.rows[0] });
});

// POST /api/scans
scanRouter.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = createScanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { name, urls, project_id, state_label, auth_config, scan_options } = parsed.data;
  const result = await db.query(
    `INSERT INTO scans (name, urls, project_id, created_by, state_label, auth_config, scan_options, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`,
    [name || `Scan ${new Date().toLocaleDateString()}`, urls, project_id || null,
     req.user!.id, state_label, auth_config ? JSON.stringify(auth_config) : null, JSON.stringify(scan_options)]
  );
  const scan = result.rows[0];
  await scanQueue.add(scan.id);
  res.status(201).json({ scan });
});

// DELETE /api/scans/:id
scanRouter.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const sourceResult = await db.query("SELECT id, name, urls, status FROM scans WHERE id = $1", [req.params.id]);
  const source = sourceResult.rows[0];
  if (!source) { res.status(404).json({ error: "Scan not found" }); return; }
  await db.query("DELETE FROM scans WHERE id = $1", [req.params.id]);
  await db.query(
    `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, entity_name, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user!.id, "scan.delete", "scan", source.id, source.name || "Untitled Scan", JSON.stringify({ urls: source.urls || [], status: source.status })]
  );
  res.json({ message: "Scan deleted" });
});

// POST /api/scans/:id/rerun
scanRouter.post("/:id/rerun", async (req: AuthRequest, res: Response): Promise<void> => {
  const sourceResult = await db.query("SELECT * FROM scans WHERE id = $1", [req.params.id]);
  const source = sourceResult.rows[0];
  if (!source) { res.status(404).json({ error: "Scan not found" }); return; }

  const result = await db.query(
    `INSERT INTO scans (name, urls, project_id, created_by, state_label, auth_config, scan_options, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`,
    [
      `Re-run: ${source.name || "Scan"}`,
      source.urls || [],
      source.project_id || null,
      req.user!.id,
      source.state_label || "default",
      source.auth_config ? JSON.stringify(source.auth_config) : null,
      JSON.stringify(source.scan_options || {})
    ]
  );
  const scan = result.rows[0];
  await db.query(
    `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, entity_name, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user!.id, "scan.rerun", "scan", source.id, source.name || "Untitled Scan", JSON.stringify({ new_scan_id: scan.id, new_scan_name: scan.name })]
  );
  await scanQueue.add(scan.id);
  res.status(201).json({ scan });
});

// GET /api/scans/:id/dom-snapshots
scanRouter.get("/:id/dom-snapshots", async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    "SELECT id, scan_id, url, phase, a11y_tree, screenshot, created_at FROM dom_snapshots WHERE scan_id = $1 ORDER BY created_at",
    [req.params.id]
  );
  res.json({ snapshots: result.rows });
});

// GET /api/scans/:id/test-cases
scanRouter.get("/:id/test-cases", async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT tc.*,
      CASE
        WHEN tc.category IN ('manual-review', 'hybrid-review') THEN
          CASE WHEN tc.status IN ('pass', 'fail') THEN tc.status ELSE 'pending' END
        WHEN EXISTS (
          SELECT 1 FROM issues i
          WHERE i.scan_id = tc.scan_id
            AND i.is_resolved = $2
            AND i.false_positive = $3
            AND (
              i.id = tc.issue_id
              OR (tc.description LIKE '%' || i.rule_id || '%' AND tc.description LIKE '%' || i.url || '%')
            )
        ) THEN 'fail'
        ELSE 'pass'
      END AS status
     FROM test_cases tc
     WHERE tc.scan_id = $1
     ORDER BY CASE status WHEN 'fail' THEN 1 WHEN 'pending' THEN 2 WHEN 'pass' THEN 3 ELSE 4 END, created_at`,
    [req.params.id, false, false]
  );
  res.json({ test_cases: result.rows });
});

// PATCH /api/scans/:id/test-cases/:testCaseId
scanRouter.patch("/:id/test-cases/:testCaseId", async (req: AuthRequest, res: Response): Promise<void> => {
  const { status } = req.body;
  if (!["pass", "fail", "pending"].includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  const result = await db.query(
    "UPDATE test_cases SET status = $1 WHERE id = $2 AND scan_id = $3 RETURNING *",
    [status, req.params.testCaseId, req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Test case not found" }); return; }
  res.json({ test_case: result.rows[0] });
});

// GET /api/scans/:id/report - interactive HTML report
scanRouter.get("/:id/report", async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scanId = String(req.params.id);
    const sectionQuery = req.query.sections;
    const sections = Array.isArray(sectionQuery)
      ? sectionQuery.flatMap(section => String(section).split(","))
      : typeof sectionQuery === "string"
        ? sectionQuery.split(",")
        : undefined;
    const html = await generateScanReport(scanId, sections);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="accessibility-report-${scanId}.html"`);
    res.send(html);
  } catch (err: any) {
    res.status(404).json({ error: err.message || "Report generation failed" });
  }
});

// GET /api/scans/:id/screenshots - all base64 screenshots for download
scanRouter.get("/:id/screenshots", async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT id, url, phase, screenshot, created_at FROM dom_snapshots
     WHERE scan_id = $1 AND screenshot IS NOT NULL ORDER BY created_at`,
    [req.params.id]
  );
  res.json({
    screenshots: result.rows.map(r => ({
      id: r.id, url: r.url, phase: r.phase,
      screenshot: r.screenshot, created_at: r.created_at,
    }))
  });
});

// GET /api/scans/:id/report/pdf - server-rendered downloadable PDF
scanRouter.get("/:id/report/pdf", async (req: AuthRequest, res: Response): Promise<void> => {
  let browser: any;
  try {
    const scanId = String(req.params.id);
    const sectionQuery = req.query.sections;
    const sections = Array.isArray(sectionQuery)
      ? sectionQuery.flatMap(section => String(section).split(","))
      : typeof sectionQuery === "string"
        ? sectionQuery.split(",")
        : undefined;

    const scanResult = await db.query("SELECT name FROM scans WHERE id = $1", [scanId]);
    const scanName = String(scanResult.rows[0]?.name || `accessibility-report-${scanId}`)
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

    const html = await generateScanReport(scanId, sections);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 60000 });
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      margin: { top: "12mm", right: "10mm", bottom: "12mm", left: "10mm" }
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${scanName || "accessibility-report"}.pdf"`);
    res.send(pdf);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "PDF report generation failed" });
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
});
