"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extensionSessionRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const assistedScanService_1 = require("../services/assistedScanService");
exports.extensionSessionRouter = (0, express_1.Router)();
exports.extensionSessionRouter.use(auth_1.authenticate);
const createSessionSchema = zod_1.z.object({
    url: zod_1.z.string().url(),
    name: zod_1.z.string().optional()
});
const interactionSchema = zod_1.z.object({
    label: zod_1.z.string().optional(),
    role: zod_1.z.string().optional(),
    selector: zod_1.z.string().optional(),
    href: zod_1.z.string().optional(),
    status: zod_1.z.string().optional(),
    reason: zod_1.z.string().optional()
});
const stateSchema = zod_1.z.object({
    url: zod_1.z.string().url(),
    title: zod_1.z.string().optional(),
    html: zod_1.z.string().min(1),
    screenshot: zod_1.z.string().optional(),
    state_label: zod_1.z.string().optional(),
    viewport: zod_1.z.object({
        width: zod_1.z.number().optional(),
        height: zod_1.z.number().optional()
    }).optional(),
    interactions: zod_1.z.array(interactionSchema).optional().default([])
});
exports.extensionSessionRouter.post("/", async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
        return;
    }
    const scan = await (0, assistedScanService_1.createAssistedScan)(req.user.id, parsed.data.url, parsed.data.name);
    res.status(201).json({ scan, session_id: scan.id });
});
exports.extensionSessionRouter.post("/:id/states", async (req, res) => {
    const parsed = stateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
        return;
    }
    const result = await (0, assistedScanService_1.submitAssistedState)(String(req.params.id), parsed.data);
    res.status(201).json(result);
});
exports.extensionSessionRouter.post("/:id/stop", async (req, res) => {
    const scan = await (0, assistedScanService_1.completeAssistedScan)(String(req.params.id));
    res.json({ scan });
});
