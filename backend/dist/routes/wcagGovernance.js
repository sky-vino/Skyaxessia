"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wcagGovernanceRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const wcagGovernanceService_1 = require("../services/wcagGovernanceService");
exports.wcagGovernanceRouter = (0, express_1.Router)();
exports.wcagGovernanceRouter.use(auth_1.authenticate);
exports.wcagGovernanceRouter.get("/status", async (_req, res, next) => {
    try {
        res.json(await (0, wcagGovernanceService_1.getWcagGovernanceStatus)());
    }
    catch (error) {
        next(error);
    }
});
exports.wcagGovernanceRouter.get("/reviews", (0, auth_1.requireRole)("admin"), async (req, res, next) => {
    try {
        res.json(await (0, wcagGovernanceService_1.listWcagMappingReviews)(String(req.query.status || "pending")));
    }
    catch (error) {
        next(error);
    }
});
exports.wcagGovernanceRouter.patch("/reviews/:id", (0, auth_1.requireRole)("admin"), async (req, res, next) => {
    try {
        res.json(await (0, wcagGovernanceService_1.updateWcagMappingReview)(String(req.params.id), String(req.body?.status || "pending"), req.user?.id));
    }
    catch (error) {
        next(error);
    }
});
exports.wcagGovernanceRouter.post("/refresh", (0, auth_1.requireRole)("admin"), async (_req, res, next) => {
    try {
        await (0, wcagGovernanceService_1.ensureWcagGovernanceReady)(true);
        res.json(await (0, wcagGovernanceService_1.getWcagGovernanceStatus)());
    }
    catch (error) {
        next(error);
    }
});
