const { remote } = require("webdriverio");
const fs = require("fs");

const {
    BrowserStackAndroidService
} = require("./BrowserStackAndroidService");

// ============================================================
// CONFIGURATION
// ============================================================

const HOME_TIMEOUT = 30000;

// Set to true only when explicitly requested by the caller.
// Default = false.
const DEFAULT_KEEP_SESSION = false;


// ============================================================
// HELPER
// ============================================================

async function isAnyElementVisible(driver, selectors) {

    for (const selector of selectors) {

        try {

            const elements = await driver.$$(selector);

            for (const element of elements) {

                try {

                    if (await element.isDisplayed()) {
                        return true;
                    }

                } catch {
                    // Ignore stale/invalid element
                }
            }

        } catch {
            // Try next selector
        }
    }

    return false;
}


// ============================================================
// WAIT FOR HOME PAGE
// ============================================================

async function waitForHomePage(driver) {

    console.log("");
    console.log("=================================");
    console.log("CHECKING MSA HOME PAGE");
    console.log("=================================");

    const deadline =
        Date.now() + HOME_TIMEOUT;

    while (Date.now() < deadline) {

        // ----------------------------------------------------
        // Try likely Home indicators.
        // ----------------------------------------------------

        const homeVisible =
            await isAnyElementVisible(
                driver,
                [

                    // Common accessibility/content descriptions
                    'android=new UiSelector().descriptionContains("Home")',

                    'android=new UiSelector().descriptionContains("home")',

                    // Common text
                    'android=new UiSelector().textContains("Home")',

                    'android=new UiSelector().textContains("home")',

                    // Sky-related Home labels
                    'android=new UiSelector().textContains("Casa")',

                    'android=new UiSelector().textContains("Homepage")',

                    // XPath fallbacks
                    '//*[contains(@content-desc,"Home")]',

                    '//*[contains(@content-desc,"home")]',

                    '//*[contains(@text,"Home")]',

                    '//*[contains(@text,"home")]',

                    '//*[contains(@text,"Casa")]'
                ]
            );

        if (homeVisible) {

            console.log(
                "✅ Possible MSA Home screen detected."
            );

            return true;
        }


        // ----------------------------------------------------
        // Also inspect page source for useful Home indicators.
        // ----------------------------------------------------

        try {

            const source =
                await driver.getPageSource();

            if (source) {

                const lowerSource =
                    source.toLowerCase();

                const possibleHomeIndicators = [
                    "homepage",
                    "home screen",
                    "casa",
                    "dashboard"
                ];

                for (
                    const indicator
                    of possibleHomeIndicators
                ) {

                    if (
                        lowerSource.includes(indicator)
                    ) {

                        console.log(
                            `✅ Home indicator found in page source: ${indicator}`
                        );

                        return true;
                    }
                }
            }

        } catch {
            // Continue polling
        }

        await driver.pause(500);
    }

    console.log(
        "⚠️ Home page could not be confirmed within timeout."
    );

    return false;
}


// ============================================================
// SAVE DEBUG INFORMATION
// ============================================================

async function saveDebugInformation(driver) {

    console.log("");
    console.log("=================================");
    console.log("SAVING DEBUG INFORMATION");
    console.log("=================================");


    // --------------------------------------------------------
    // PAGE SOURCE
    // --------------------------------------------------------

    try {

        const source =
            await driver.getPageSource();

        if (source) {

            fs.writeFileSync(
                "browserstack-debug-page-source.xml",
                source,
                "utf8"
            );

            console.log(
                "✅ Saved: browserstack-debug-page-source.xml"
            );
        }

    } catch (error) {

        console.error(
            "Could not save page source:",
            error.message
        );
    }


    // --------------------------------------------------------
    // SCREENSHOT
    // --------------------------------------------------------

    try {

        await driver.saveScreenshot(
            "browserstack-debug-screenshot.png"
        );

        console.log(
            "✅ Saved: browserstack-debug-screenshot.png"
        );

    } catch (error) {

        console.error(
            "Could not save screenshot:",
            error.message
        );
    }
}


// ============================================================
// MAIN BROWSERSTACK RUNNER
// ============================================================

/**
 * Run an Android accessibility scan through BrowserStack.
 *
 * All BrowserStack and MSA credentials/configuration are
 * supplied by the caller.
 *
 * @param {Object} config
 * @param {string} config.browserStackUsername
 * @param {string} config.browserStackAccessKey
 * @param {string} config.browserStackLocalIdentifier
 * @param {string} config.browserStackAppId
 * @param {string} config.deviceModel
 * @param {string} config.androidVersion
 * @param {string} config.appUsername
 * @param {string} config.appPassword
 * @param {string} config.flow
 * @param {boolean} [config.keepSession]
 */
async function runBrowserStackScan(config) {

    console.log("");
    console.log("=================================");
    console.log("AXESSIA BROWSERSTACK MOBILE SCAN");
    console.log("=================================");
    console.log("");


    // ========================================================
    // VALIDATE CONFIGURATION
    // ========================================================

    if (!config) {
        throw new Error("BrowserStack scan configuration is required.");
    }

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
        keepSession = DEFAULT_KEEP_SESSION
    } = config;


    if (!browserStackUsername) {
        throw new Error("BrowserStack username is required.");
    }

    if (!browserStackAccessKey) {
        throw new Error("BrowserStack access key is required.");
    }

    if (!browserStackLocalIdentifier) {
        throw new Error("BrowserStack Local Identifier is required.");
    }

    if (!browserStackAppId) {
        throw new Error("BrowserStack App ID is required.");
    }

    if (!deviceModel) {
        throw new Error("Device Model is required.");
    }

    if (!androidVersion) {
        throw new Error("Android Version is required.");
    }

    if (!appUsername) {
        throw new Error("MSA Login Username is required.");
    }

    if (!appPassword) {
        throw new Error("MSA Login Password is required.");
    }

    if (!flow) {
        throw new Error("Scan Flow is required.");
    }


    // ========================================================
    // LOG CONFIGURATION
    // ========================================================

    console.log(
        "BrowserStack credentials detected."
    );

    console.log(
        "BrowserStack username:",
        browserStackUsername
    );

    console.log(
        "App:",
        browserStackAppId
    );

    console.log(
        "Local identifier:",
        browserStackLocalIdentifier
    );

    console.log(
        "Device:",
        deviceModel
    );

    console.log(
        "Android version:",
        androidVersion
    );

    console.log(
        "Scan flow:",
        flow
    );

    console.log("");


    // ========================================================
    // CREATE BROWSERSTACK SESSION
    // ========================================================

    console.log(
        "Creating BrowserStack session..."
    );

    let driver = null;

    try {

        driver = await remote({

            hostname: "hub.browserstack.com",

            port: 443,

            protocol: "https",

            path: "/wd/hub",

            capabilities: {

                platformName: "Android",

                "appium:automationName":
                    "UiAutomator2",

                "appium:app":
                    browserStackAppId,

                "bstack:options": {

                    userName:
                        browserStackUsername,

                    accessKey:
                        browserStackAccessKey,

                    deviceName:
                        deviceModel,

                    platformVersion:
                        androidVersion,

                    projectName:
                        "Axessia",

                    buildName:
                        "BrowserStack Mobile Scan",

                    sessionName:
                        `MSA ${flow} Accessibility Scan`,

                    // BrowserStack Local
                    local:
                        true,

                    localIdentifier:
                        browserStackLocalIdentifier,

                    // Debugging
                    debug:
                        true,

                    video:
                        true,

                    interactiveDebugging:
                        true
                }
            }
        });


        // ====================================================
        // SESSION CREATED
        // ====================================================

        console.log("");
        console.log("=================================");
        console.log("BROWSERSTACK SESSION CREATED");
        console.log("=================================");

        console.log(
            "Session ID:",
            driver.sessionId
        );

        console.log("");


        // ====================================================
        // LOGIN
        // ====================================================

        console.log("");
        console.log("=================================");
        console.log("STARTING MSA LOGIN");
        console.log("=================================");
        console.log("");


        const service =
            new BrowserStackAndroidService();


        await service.login(
            driver,
            appUsername,
            appPassword
        );


        // ====================================================
        // LOGIN SUCCESS
        // ====================================================

        console.log("");
        console.log("=================================");
        console.log("✅ MSA LOGIN COMPLETED");
        console.log("=================================");
        console.log("");


        // ====================================================
        // CHECK HOME PAGE
        // ====================================================

        const homeDetected =
            await waitForHomePage(driver);


        if (!homeDetected) {

            console.log("");
            console.log(
                "⚠️ Login completed, but Home could not be confirmed."
            );

            console.log(
                "Saving current screen for analysis..."
            );

            await saveDebugInformation(driver);

        } else {

            console.log("");
            console.log("=================================");
            console.log("✅ MSA HOME PAGE DETECTED");
            console.log("=================================");
        }


        // ====================================================
        // GET FINAL PAGE SOURCE
        // ====================================================

        console.log("");
        console.log("=================================");
        console.log("GETTING FINAL PAGE SOURCE");
        console.log("=================================");


        const source =
            await driver.getPageSource();


        if (!source) {

            throw new Error(
                "BrowserStack returned an empty page source."
            );
        }


        console.log(
            `✅ Page source received: ${source.length} characters`
        );


        // ====================================================
        // SAVE PAGE SOURCE
        // ====================================================

        fs.writeFileSync(
            "browserstack-page-source.xml",
            source,
            "utf8"
        );


        console.log(
            "✅ Saved: browserstack-page-source.xml"
        );


        // ====================================================
        // SAVE FINAL SCREENSHOT
        // ====================================================

        let screenshot = null;

        try {

            screenshot =
                await driver.saveScreenshot(
                    "browserstack-final-screen.png"
                );

            console.log(
                "✅ Saved: browserstack-final-screen.png"
            );

        } catch (error) {

            console.log(
                "⚠️ Could not save final screenshot:",
                error.message
            );
        }


        // ====================================================
        // RESULT
        // ====================================================

        console.log("");
        console.log("=================================");

        if (homeDetected) {

            console.log(
                "✅ BROWSERSTACK MOBILE SCAN SETUP COMPLETED"
            );

        } else {

            console.log(
                "⚠️ LOGIN SUCCESSFUL - HOME NOT CONFIRMED"
            );
        }

        console.log("=================================");
        console.log("");


        // ====================================================
        // OPTIONAL LIVE DEBUG
        // ====================================================

        if (keepSession) {

            console.log("");
            console.log("=================================");
            console.log("KEEPING SESSION OPEN");
            console.log("=================================");

            console.log(
                "BrowserStack session will remain open."
            );

            console.log(
                "The caller must terminate the process when finished."
            );

            await new Promise(() => {});
        }


        // ====================================================
        // RETURN RESULT TO API
        // ====================================================

        return {

            success: true,

            sessionId:
                driver.sessionId,

            flow,

            homeDetected,

            pageSource:
                source,

            screenshot
        };


    } catch (error) {

        // ====================================================
        // FAILURE
        // ====================================================

        console.error("");
        console.error("=================================");
        console.error("❌ BROWSERSTACK MOBILE SCAN FAILED");
        console.error("=================================");

        console.error(
            error && error.stack
                ? error.stack
                : error
        );


        // ====================================================
        // SAVE DEBUG DATA
        // ====================================================

        if (driver) {

            try {

                await saveDebugInformation(
                    driver
                );

            } catch {
                // Ignore debug failure
            }
        }


        throw error;


    } finally {

        // ====================================================
        // CLOSE SESSION
        // ====================================================

        if (driver && !keepSession) {

            console.log("");
            console.log("=================================");
            console.log("CLOSING BROWSERSTACK SESSION");
            console.log("=================================");

            try {

                await driver.deleteSession();

                console.log(
                    "✅ BrowserStack session closed."
                );

            } catch (error) {

                console.error(
                    "Could not close BrowserStack session:",
                    error.message
                );
            }
        }
    }
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {
    runBrowserStackScan
};