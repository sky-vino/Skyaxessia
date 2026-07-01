import { Router, Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { createAssistedScan, submitAssistedState, completeAssistedScan } from "../services/assistedScanService";

export const extensionSessionRouter = Router();
extensionSessionRouter.use(authenticate);

const createSessionSchema = z.object({
  url: z.string().url(),
  name: z.string().optional()
});

const interactionSchema = z.object({
  label: z.string().optional(),
  role: z.string().optional(),
  selector: z.string().optional(),
  href: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional()
});

const stateSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  html: z.string().min(1),
  screenshot: z.string().optional(),
  state_label: z.string().optional(),
  viewport: z.object({
    width: z.number().optional(),
    height: z.number().optional()
  }).optional(),
  interactions: z.array(interactionSchema).optional().default([])
});

extensionSessionRouter.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const scan = await createAssistedScan(req.user!.id, parsed.data.url, parsed.data.name);
  res.status(201).json({ scan, session_id: scan.id });
});

extensionSessionRouter.post("/:id/states", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = stateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const result = await submitAssistedState(String(req.params.id), parsed.data as any);
  res.status(201).json(result);
});

extensionSessionRouter.post("/:id/stop", async (req: AuthRequest, res: Response): Promise<void> => {
  const scan = await completeAssistedScan(String(req.params.id));
  res.json({ scan });
});
