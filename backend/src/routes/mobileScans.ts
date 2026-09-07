import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { runBrowserStackScan } from "../../browserstack-config";

export const mobileScanRouter = Router();

mobileScanRouter.use(authenticate);

mobileScanRouter.post("/browserstack", async (req, res) => {
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