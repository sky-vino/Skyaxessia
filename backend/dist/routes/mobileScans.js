"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.mobileScanRouter = void 0;

const express = require("express");
const { authenticate } = require("../middleware/auth");
const { runBrowserStackScan } = require("../../browserstack-config");

exports.mobileScanRouter = express.Router();

exports.mobileScanRouter.use(authenticate);

exports.mobileScanRouter.post("/browserstack", async (req, res) => {
    try {
        const {
            browserStackUsername,
            browserStackAccessKey,
            browserStackLocalIdentifier,
            browserStackAppId,
            deviceModel,
            androidVersion,
            appUsername,
            appPassword,
            flow,
        } = req.body;

        if (
            !browserStackUsername ||
            !browserStackAccessKey ||
            !browserStackLocalIdentifier ||
            !browserStackAppId ||
            !deviceModel ||
            !androidVersion ||
            !appUsername ||
            !appPassword
        ) {
            return res.status(400).json({
                success: false,
                message: "All BrowserStack and MSA fields are required.",
            });
        }

        if (flow && flow !== "Home") {
            return res.status(400).json({
                success: false,
                message: `The ${flow} flow is not implemented yet. Only Home is currently supported.`,
            });
        }

        const result = await runBrowserStackScan({
            browserStackUsername,
            browserStackAccessKey,
            browserStackLocalIdentifier,
            browserStackAppId,
            deviceModel,
            androidVersion,
            appUsername,
            appPassword,
            flow: flow || "Home",
        });

        return res.status(200).json(result);
    } catch (error) {
        console.error("Mobile BrowserStack scan failed:", error);

        return res.status(500).json({
            success: false,
            message:
                error instanceof Error
                    ? error.message
                    : "Mobile BrowserStack scan failed.",
        });
    }
});