import { Router } from "express";
import { authenticate, requireRole, AuthRequest } from "../middleware/auth";
import {
  ensureWcagGovernanceReady,
  getWcagGovernanceStatus,
  listWcagMappingReviews,
  updateWcagMappingReview
} from "../services/wcagGovernanceService";

export const wcagGovernanceRouter = Router();

wcagGovernanceRouter.use(authenticate);

wcagGovernanceRouter.get("/status", async (_req, res, next) => {
  try {
    res.json(await getWcagGovernanceStatus());
  } catch (error) {
    next(error);
  }
});

wcagGovernanceRouter.get("/reviews", requireRole("admin"), async (req, res, next) => {
  try {
    res.json(await listWcagMappingReviews(String(req.query.status || "pending")));
  } catch (error) {
    next(error);
  }
});

wcagGovernanceRouter.patch("/reviews/:id", requireRole("admin"), async (req: AuthRequest, res, next) => {
  try {
    res.json(await updateWcagMappingReview(String(req.params.id), String(req.body?.status || "pending"), req.user?.id));
  } catch (error) {
    next(error);
  }
});

wcagGovernanceRouter.post("/refresh", requireRole("admin"), async (_req, res, next) => {
  try {
    await ensureWcagGovernanceReady(true);
    res.json(await getWcagGovernanceStatus());
  } catch (error) {
    next(error);
  }
});
