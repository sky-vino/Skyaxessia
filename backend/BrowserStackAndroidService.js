class BrowserStackAndroidService {

    // ============================================================
    // MAIN LOGIN FLOW
    // ============================================================

    async login(driver, username, password) {

        console.log("");
        console.log("=================================");
        console.log("BROWSERSTACK LOGIN FLOW STARTED");
        console.log("=================================");

        if (!username || !password) {
            throw new Error(
                "MSA username or MSA password is missing."
            );
        }

        // --------------------------------------------------------
        // ALWAYS USE NATIVE APP
        // --------------------------------------------------------

        await this.ensureNativeContext(driver);

        console.log("Context: NATIVE_APP");

        // Do not blindly wait 2-5 seconds.
        // Start detecting immediately.
        await this.navigateToLogin(driver);

        // --------------------------------------------------------
        // USERNAME + PASSWORD
        // --------------------------------------------------------

        await this.enterLoginCredentials(
            driver,
            username,
            password
        );

        // --------------------------------------------------------
        // CLICK ACCEDI WITH RETRY
        // --------------------------------------------------------

        await this.clickAccediWithRetry(driver);

        // --------------------------------------------------------
        // OTP
        // --------------------------------------------------------

        await this.waitAndEnterOtp(driver);

        // Handle Android notification permission popup
        await this.dismissNotificationPermission(driver);

        // --------------------------------------------------------
        // WAIT FOR HOME / POST LOGIN
        // --------------------------------------------------------

        await this.waitForHomeAfterLogin(driver);

        console.log("");
        console.log("=================================");
        console.log("BROWSERSTACK LOGIN COMPLETED");
        console.log("HOME PAGE REACHED");
        console.log("=================================");
    }


    // ============================================================
    // ENSURE NATIVE CONTEXT
    // ============================================================

    async ensureNativeContext(driver) {

        try {
            const currentContext = await driver.getContext();

            if (currentContext !== "NATIVE_APP") {
                await driver.switchContext("NATIVE_APP");
            }

        } catch {
            try {
                await driver.switchContext("NATIVE_APP");
            } catch {
                // Already native or context unavailable.
            }
        }
    }


    // ============================================================
    // NAVIGATE TO LOGIN
    //
    // Possible screens:
    //
    // Privacy
    // Continue
    // Accedi ora
    // Login
    //
    // Privacy always has priority.
    // ============================================================

    // ============================================================
    // DISMISS ANDROID NOTIFICATION PERMISSION
    // ============================================================

    async dismissNotificationPermission(driver) {
        const selectors = [
            'android=new UiSelector().text("Don\'t allow")',
            'android=new UiSelector().textContains("Don\'t allow")',
            'android=new UiSelector().text("Non consentire")',
            'android=new UiSelector().textContains("Non consentire")',
            '//*[@text="Don\'t allow"]',
            '//*[@text="Non consentire"]'
        ];

        const element = await this.findFirstVisible(
            driver,
            selectors,
            1500
        );

        if (!element) {
            return false;
        }

        console.log(
            'Android notification permission detected. Clicking "Don\'t allow"...'
        );

        await this.tapElement(element, driver);

        await driver.pause(500);

        console.log(
            'Android notification permission dismissed.'
        );

        return true;
    }




    async navigateToLogin(driver) {

        console.log("");
        console.log("=================================");
        console.log("DETECTING CURRENT SKY SCREEN");
        console.log("=================================");

        const deadline = Date.now() + 60000;

        while (Date.now() < deadline) {

            await this.ensureNativeContext(driver);

            // ----------------------------------------------------
            // ANDROID NOTIFICATION PERMISSION
            // ----------------------------------------------------

            await this.dismissNotificationPermission(driver);

            // ----------------------------------------------------
            // PRIVACY
            // ----------------------------------------------------

            if (await this.isPrivacyVisible(driver)) {

                console.log("Privacy screen detected.");

                await this.clickPrivacy(driver);

                console.log(
                    '"Accetta tutto" clicked.'
                );

                // No large blind wait.
                await this.waitForScreenChange(
                    driver,
                    5000
                );

                continue;
            }

            // ----------------------------------------------------
            // LOGIN PAGE
            // ----------------------------------------------------

            if (await this.isLoginPageVisible(driver)) {

                console.log(
                    "Login page detected."
                );

                return;
            }

            // ----------------------------------------------------
            // BROWSERSTACK / OAUTH CONTINUE
            // ----------------------------------------------------

            const continueButton =
                await this.findFirstVisible(
                    driver,
                    [
                        'android=new UiSelector().resourceId("oauth-login")',
                        'android=new UiSelector().description("Continue")',
                        'android=new UiSelector().text("Continue")',
                        '//*[@content-desc="Continue"]',
                        '//*[@text="Continue"]'
                    ],
                    750
                );

            if (continueButton) {

                console.log(
                    '"Continue" button detected.'
                );

                await this.tapElement(
                    continueButton,
                    driver
                );

                console.log(
                    '"Continue" clicked.'
                );

                await this.waitForScreenChange(
                    driver,
                    5000
                );

                continue;
            }

            // ----------------------------------------------------
            // LANDING PAGE
            // ----------------------------------------------------

            if (await this.isLandingPageVisible(driver)) {

                console.log(
                    "Sky landing page detected."
                );

                await this.clickAccediOra(driver);

                console.log(
                    '"Accedi ora" clicked.'
                );

                await this.waitForScreenChange(
                    driver,
                    5000
                );

                continue;
            }

            // ----------------------------------------------------
            // NOTHING KNOWN YET
            // ----------------------------------------------------

            await driver.pause(300);
        }

        throw new Error(
            "Unable to reach the Sky login page within 60 seconds."
        );
    }


    // ============================================================
    // WAIT FOR SCREEN CHANGE
    // ============================================================

    async waitForScreenChange(
        driver,
        timeoutMs = 5000
    ) {

        const deadline =
            Date.now() + timeoutMs;

        while (Date.now() < deadline) {

            if (await this.isPrivacyVisible(driver)) {
                return;
            }

            if (await this.isLoginPageVisible(driver)) {
                return;
            }

            if (await this.isLandingPageVisible(driver)) {
                return;
            }

            if (await this.isOtpPageVisible(driver)) {
                return;
            }

            await driver.pause(300);
        }
    }


    // ============================================================
    // PRIVACY DETECTION
    // ============================================================

    async isPrivacyVisible(driver) {

        return this.isAnyVisible(
            driver,
            [
                'android=new UiSelector().description("Accetta tutto")',
                'android=new UiSelector().text("Accetta tutto")',
                'android=new UiSelector().textContains("Accetta tutto")',
                'android=new UiSelector().descriptionContains("Accetta tutto")',

                '//*[@content-desc="Accetta tutto"]',
                '//*[@text="Accetta tutto"]',

                '//*[contains(@content-desc,"Accetta tutto")]',
                '//*[contains(@text,"Accetta tutto")]'
            ]
        );
    }


    // ============================================================
    // CLICK PRIVACY
    // ============================================================

    async clickPrivacy(driver) {

        console.log(
            'Looking for "Accetta tutto"...'
        );

        const element =
            await this.findFirstVisible(
                driver,
                [
                    'android=new UiSelector().description("Accetta tutto")',
                    'android=new UiSelector().text("Accetta tutto")',
                    'android=new UiSelector().textContains("Accetta tutto")',
                    'android=new UiSelector().descriptionContains("Accetta tutto")',

                    '//*[@content-desc="Accetta tutto"]',
                    '//*[@text="Accetta tutto"]',

                    '//*[contains(@content-desc,"Accetta tutto")]',
                    '//*[contains(@text,"Accetta tutto")]'
                ],
                10000
            );

        if (!element) {
            throw new Error(
                'Privacy detected but "Accetta tutto" was not found.'
            );
        }

        await this.tapElement(
            element,
            driver
        );

        console.log(
            '"Accetta tutto" tapped successfully.'
        );
    }


    // ============================================================
    // LANDING PAGE DETECTION
    // ============================================================

    async isLandingPageVisible(driver) {

        return this.isAnyVisible(
            driver,
            [
                'android=new UiSelector().text("Accedi ora")',
                'android=new UiSelector().textContains("Accedi ora")',

                'android=new UiSelector().description("Accedi ora")',
                'android=new UiSelector().descriptionContains("Accedi ora")',

                '//*[@text="Accedi ora"]',
                '//*[contains(@text,"Accedi ora")]',

                '//*[@content-desc="Accedi ora"]',
                '//*[contains(@content-desc,"Accedi ora")]'
            ]
        );
    }


    // ============================================================
    // CLICK ACCEDI ORA
    // ============================================================

    async clickAccediOra(driver) {

        const element =
            await this.findFirstVisible(
                driver,
                [
                    'android=new UiSelector().text("Accedi ora")',
                    'android=new UiSelector().textContains("Accedi ora")',

                    'android=new UiSelector().description("Accedi ora")',
                    'android=new UiSelector().descriptionContains("Accedi ora")',

                    '//*[@text="Accedi ora"]',
                    '//*[contains(@text,"Accedi ora")]',

                    '//*[@content-desc="Accedi ora"]',
                    '//*[contains(@content-desc,"Accedi ora")]'
                ],
                10000
            );

        if (!element) {
            throw new Error(
                '"Accedi ora" button not found.'
            );
        }

        await this.tapElement(
            element,
            driver
        );

        console.log(
            '"Accedi ora" tapped successfully.'
        );
    }


    // ============================================================
    // LOGIN PAGE DETECTION
    // ============================================================

    async isLoginPageVisible(driver) {

        return this.isAnyVisible(
            driver,
            [
                'android=new UiSelector().resourceId("sky-login-email")',

                'android=new UiSelector().resourceId("sky-login-password")',

                'android=new UiSelector().text("Username o email")',

                'android=new UiSelector().textContains("Username")',

                'android=new UiSelector().textContains("Password")',

                'android=new UiSelector().textContains("Accedi con il tuo Sky ID")'
            ]
        );
    }


    // ============================================================
    // ENTER LOGIN CREDENTIALS
    // ============================================================

    async enterLoginCredentials(
        driver,
        username,
        password
    ) {

        console.log("");
        console.log("=================================");
        console.log("ENTERING LOGIN CREDENTIALS");
        console.log("=================================");

        const deadline =
            Date.now() + 30000;

        let usernameField = null;
        let passwordField = null;

        while (Date.now() < deadline) {

            // Privacy can appear at any moment.

            if (await this.isPrivacyVisible(driver)) {

                console.log(
                    "Privacy appeared during login."
                );

                await this.clickPrivacy(driver);

                continue;
            }

            usernameField =
                await this.findFirstVisible(
                    driver,
                    [
                        'android=new UiSelector().resourceId("sky-login-email")',
                        'android=new UiSelector().text("Username o email")'
                    ],
                    500
                );

            passwordField =
                await this.findFirstVisible(
                    driver,
                    [
                        'android=new UiSelector().resourceId("sky-login-password")'
                    ],
                    500
                );

            if (usernameField && passwordField) {
                break;
            }

            await driver.pause(300);
        }

        // --------------------------------------------------------
        // FALLBACK
        // --------------------------------------------------------

        if (!usernameField || !passwordField) {

            console.log(
                "Using visible EditText fallback."
            );

            const fields =
                await driver.$$(
                    'android=new UiSelector().className("android.widget.EditText")'
                );

            const visibleFields = [];

            for (const field of fields) {

                if (
                    await field
                        .isDisplayed()
                        .catch(() => false)
                ) {
                    visibleFields.push(field);
                }
            }

            if (visibleFields.length >= 2) {

                usernameField =
                    usernameField || visibleFields[0];

                passwordField =
                    passwordField || visibleFields[1];
            }
        }

        if (!usernameField || !passwordField) {

            throw new Error(
                "Unable to find username/password fields."
            );
        }

        // --------------------------------------------------------
        // USERNAME
        // --------------------------------------------------------

        console.log(
            "Entering username..."
        );

        await usernameField.click();

        await this.clearField(
            usernameField
        );

        await usernameField.setValue(
            username
        );

        console.log(
            "Username entered successfully."
        );

        // --------------------------------------------------------
        // PASSWORD
        // --------------------------------------------------------

        console.log(
            "Entering password..."
        );

        await passwordField.click();

        await this.clearField(
            passwordField
        );

        await passwordField.setValue(
            password
        );

        console.log(
            "Password entered successfully."
        );

        console.log(
            "Both login credentials entered successfully."
        );
    }


    // ============================================================
    // CLICK ACCEDI WITH RETRY
    //
    // IMPORTANT:
    // We only retry when the login page is genuinely still visible.
    // ============================================================

    async clickAccediWithRetry(driver) {

        console.log("");
        console.log("=================================");
        console.log("STARTING LOGIN");
        console.log("=================================");

        const maxAttempts = 3;

        for (
            let attempt = 1;
            attempt <= maxAttempts;
            attempt++
        ) {

            console.log(
                `LOGIN ATTEMPT ${attempt}/${maxAttempts}`
            );

            // ----------------------------------------------------
            // OTP already appeared
            // ----------------------------------------------------

            if (
                await this.isOtpPageVisible(driver)
            ) {

                console.log(
                    "OTP page already visible."
                );

                return;
            }

            // ----------------------------------------------------
            // PRIVACY
            // ----------------------------------------------------

            if (
                await this.isPrivacyVisible(driver)
            ) {

                console.log(
                    "Privacy appeared before Accedi."
                );

                await this.clickPrivacy(driver);

                continue;
            }

            // ----------------------------------------------------
            // WAIT FOR LOGIN PAGE
            // ----------------------------------------------------

            const loginReady =
                await this.waitForLoginPage(
                    driver,
                    5000
                );

            if (!loginReady) {

                if (
                    await this.isOtpPageVisible(driver)
                ) {
                    return;
                }

                if (attempt === maxAttempts) {

                    throw new Error(
                        "Login page did not become ready."
                    );
                }

                continue;
            }

            // ----------------------------------------------------
            // HIDE KEYBOARD
            // ----------------------------------------------------

            try {
                await driver.hideKeyboard();
            } catch {
                // Keyboard already hidden.
            }

            // ----------------------------------------------------
            // FIND ACTUAL BUTTON
            // ----------------------------------------------------

            const accediButton =
                await this.findFirstVisible(
                    driver,
                    [
                        'android=new UiSelector().className("android.widget.Button").description("Accedi al tuo account")',

                        'android=new UiSelector().description("Accedi al tuo account")',

                        '//*[@content-desc="Accedi al tuo account"]'
                    ],
                    5000
                );

            if (!accediButton) {

                throw new Error(
                    '"Accedi al tuo account" button not found.'
                );
            }

            console.log(
                `Clicking "Accedi" - attempt ${attempt}`
            );

            await this.tapElement(
                accediButton,
                driver
            );

            // ----------------------------------------------------
            // WAIT FOR OTP
            //
            // NO FIXED 10 SECOND WAIT.
            // Poll immediately.
            // ----------------------------------------------------

            console.log(
                "Waiting for OTP page..."
            );

            const otpDeadline =
                Date.now() + 30000;

            while (
                Date.now() < otpDeadline
            ) {

                // Privacy may appear during transition.

                if (
                    await this.isPrivacyVisible(driver)
                ) {

                    console.log(
                        "Privacy appeared during login transition."
                    );

                    await this.clickPrivacy(driver);

                    continue;
                }

                if (
                    await this.isOtpPageVisible(driver)
                ) {

                    console.log(
                        "OTP page detected."
                    );

                    return;
                }

                // If login page disappears, do NOT immediately
                // click Accedi again. It may be transitioning.

                if (
                    !(await this.isLoginPageVisible(driver))
                ) {

                    console.log(
                        "Login page disappeared. Waiting for transition..."
                    );

                    const transitionDeadline =
                        Date.now() + 5000;

                    while (
                        Date.now() < transitionDeadline
                    ) {

                        if (
                            await this.isOtpPageVisible(driver)
                        ) {
                            return;
                        }

                        if (
                            await this.isLoginPageVisible(driver)
                        ) {
                            break;
                        }

                        await driver.pause(300);
                    }

                    if (
                        await this.isOtpPageVisible(driver)
                    ) {
                        return;
                    }
                }

                await driver.pause(500);
            }

            // ----------------------------------------------------
            // OTP NOT FOUND
            // ----------------------------------------------------

            console.log(
                "OTP was not detected after this attempt."
            );

            // ----------------------------------------------------
            // RETRY ONLY IF LOGIN PAGE IS STILL THERE
            // ----------------------------------------------------

            if (
                await this.isLoginPageVisible(driver)
            ) {

                console.log(
                    "Login page is still visible."
                );

                if (
                    attempt < maxAttempts
                ) {

                    console.log(
                        "Retrying Accedi..."
                    );

                    continue;
                }

                throw new Error(
                    `Login failed after ${maxAttempts} attempts.`
                );
            }

            // ----------------------------------------------------
            // Something else appeared.
            // Check OTP one final time.
            // ----------------------------------------------------

            if (
                await this.isOtpPageVisible(driver)
            ) {
                return;
            }
        }

        throw new Error(
            "Login flow ended without reaching OTP."
        );
    }


    // ============================================================
    // WAIT FOR LOGIN PAGE
    // ============================================================

    async waitForLoginPage(
        driver,
        timeoutMs = 10000
    ) {

        const deadline =
            Date.now() + timeoutMs;

        while (Date.now() < deadline) {

            if (
                await this.isPrivacyVisible(driver)
            ) {

                await this.clickPrivacy(driver);

                continue;
            }

            if (
                await this.isLoginPageVisible(driver)
            ) {
                return true;
            }

            if (
                await this.isOtpPageVisible(driver)
            ) {
                return false;
            }

            await driver.pause(300);
        }

        return false;
    }


    // ============================================================
    // OTP PAGE DETECTION
    // ============================================================

    async isOtpPageVisible(driver) {

        return this.isAnyVisible(
            driver,
            [
                'android=new UiSelector().textContains("Your sky code is:")',

                'android=new UiSelector().textContains("Il tuo codice Sky")',

                'android=new UiSelector().textContains("Digita il codice di sicurezza")',

                'android=new UiSelector().textContains("codice di sicurezza")',

                'android=new UiSelector().textContains("codice")'
            ]
        );
    }


    // ============================================================
    // WAIT FOR OTP + ENTER OTP
    //
    // OTP is displayed in the UI.
    //
    // IMPORTANT:
    // We do NOT blindly wait 10 seconds.
    // We start polling immediately.
    // ============================================================

    async waitAndEnterOtp(driver) {

        console.log("");
        console.log("=================================");
        console.log("OTP FLOW STARTED");
        console.log("=================================");

        const deadline =
            Date.now() + 40000;

        let otp = "";

        while (Date.now() < deadline) {

            // Privacy can still appear.

            if (
                await this.isPrivacyVisible(driver)
            ) {

                console.log(
                    "Privacy appeared during OTP transition."
                );

                await this.clickPrivacy(driver);

                continue;
            }

            // ----------------------------------------------------
            // OTP TEXT
            // ----------------------------------------------------

            try {

                const source =
                    await driver.getPageSource();

                const match =
                    source.match(/\b\d{6}\b/);

                if (
                    match &&
                    await this.isOtpPageVisible(driver)
                ) {

                    otp = match[0];

                    console.log(
                        "6-digit OTP detected."
                    );

                    break;
                }

            } catch {
                // Page source not ready.
            }

            // ----------------------------------------------------
            // Direct OTP text elements
            // ----------------------------------------------------

            try {

                const selectors = [
                    'android=new UiSelector().textContains("Your sky code is:")',
                    'android=new UiSelector().textContains("Il tuo codice Sky")',
                    'android=new UiSelector().textContains("Digita il codice di sicurezza")',
                    'android=new UiSelector().textContains("codice di sicurezza")'
                ];

                for (const selector of selectors) {

                    const elements =
                        await driver.$$(selector);

                    for (const element of elements) {

                        if (
                            !(await element
                                .isDisplayed()
                                .catch(() => false))
                        ) {
                            continue;
                        }

                        const text =
                            await element
                                .getText()
                                .catch(() => "");

                        const match =
                            text.match(/\b\d{6}\b/);

                        if (match) {

                            otp = match[0];

                            console.log(
                                "6-digit OTP captured from UI."
                            );

                            break;
                        }
                    }

                    if (otp) {
                        break;
                    }
                }

            } catch {
                // OTP not ready.
            }

            if (otp) {
                break;
            }

            await driver.pause(500);
        }

        if (!otp) {

            throw new Error(
                "6-digit OTP was not found on the screen within 40 seconds."
            );
        }

        console.log(
            `OTP captured successfully: ${otp}`
        );

        // ========================================================
        // FIND OTP FIELDS
        // ========================================================

        const fieldDeadline =
            Date.now() + 15000;

        let otpFields = [];

        while (
            Date.now() < fieldDeadline
        ) {

            try {

                const fields =
                    await driver.$$(
                        'android=new UiSelector().className("android.widget.EditText")'
                    );

                otpFields = [];

                for (const field of fields) {

                    if (
                        await field
                            .isDisplayed()
                            .catch(() => false)
                    ) {
                        otpFields.push(field);
                    }
                }

                if (
                    otpFields.length >= 6
                ) {
                    break;
                }

            } catch {
                // Fields not ready.
            }

            await driver.pause(300);
        }

        if (
            otpFields.length < 6
        ) {

            throw new Error(
                `Expected 6 OTP fields, found ${otpFields.length}.`
            );
        }

        console.log(
            `OTP fields found: ${otpFields.length}`
        );

        // ========================================================
        // ENTER OTP
        // ========================================================

        await otpFields[0].click();

        await driver.pause(200);

        try {

            await driver.keys(otp);

            console.log(
                "OTP entered using keyboard."
            );

        } catch {

            console.log(
                "Keyboard OTP entry failed. Entering digit by digit..."
            );

            for (
                let i = 0;
                i < 6;
                i++
            ) {

                try {

                    await otpFields[i].click();

                    await otpFields[i].setValue(
                        otp[i]
                    );

                } catch {

                    // Some OTP implementations automatically
                    // move focus to the next field.
                    if (i === 0) {
                        throw new Error(
                            "Unable to enter OTP."
                        );
                    }
                }
            }
        }

        // ========================================================
        // CLICK CONFERMA
        // ========================================================

        console.log(
            'Waiting for "Conferma"...'
        );

        const conferma =
            await this.findFirstVisible(
                driver,
                [
                    'android=new UiSelector().description("Conferma")',

                    'android=new UiSelector().text("Conferma")',

                    'android=new UiSelector().textContains("Conferma")',

                    'android=new UiSelector().className("android.widget.Button").description("Conferma")',

                    '//*[@content-desc="Conferma"]',

                    '//*[@text="Conferma"]',

                    '//*[contains(@content-desc,"Conferma")]',

                    '//*[contains(@text,"Conferma")]'
                ],
                15000
            );

        if (!conferma) {

            throw new Error(
                '"Conferma" button was not found.'
            );
        }

        console.log(
            '"Conferma" button found.'
        );

        await this.tapElement(
            conferma,
            driver
        );

        console.log(
            '"Conferma" clicked successfully.'
        );
    }


    // ============================================================
    // WAIT FOR HOME AFTER LOGIN
    //
    // IMPORTANT:
    // We do NOT use a blind 15-second wait.
    //
    // We continuously check:
    //
    // Privacy
    // Salta
    // Ok, grazie
    // Login
    // OTP
    //
    // Once authentication screens are gone and onboarding
    // popups are handled, the application is considered
    // to have reached the post-login/Home state.
    // ============================================================

    async waitForHomeAfterLogin(driver) {

        console.log("");
        console.log("=================================");
        console.log("WAITING FOR HOME PAGE");
        console.log("=================================");

        const deadline =
            Date.now() + 45000;

        let stableHomeChecks = 0;

        while (
            Date.now() < deadline
        ) {

            await this.ensureNativeContext(driver);

            // ----------------------------------------------------
            // PRIVACY
            // ----------------------------------------------------

            if (
                await this.isPrivacyVisible(driver)
            ) {

                console.log(
                    "Privacy appeared after authentication."
                );

                await this.clickPrivacy(driver);

                stableHomeChecks = 0;

                continue;
            }

            // ----------------------------------------------------
            // SALTA
            // ----------------------------------------------------

            const salta =
                await this.findFirstVisible(
                    driver,
                    [
                        'android=new UiSelector().text("Salta")',
                        'android=new UiSelector().textContains("Salta")',
                        'android=new UiSelector().description("Salta")',
                        'android=new UiSelector().descriptionContains("Salta")',
                        '//*[@text="Salta"]',
                        '//*[@content-desc="Salta"]'
                    ],
                    300
                );

            if (salta) {

                console.log(
                    '"Salta" popup detected.'
                );

                await this.tapElement(
                    salta,
                    driver
                );

                stableHomeChecks = 0;

                await driver.pause(500);

                continue;
            }

            // ----------------------------------------------------
            // OK, GRAZIE
            // ----------------------------------------------------

            const okGrazie =
                await this.findFirstVisible(
                    driver,
                    [
                        'android=new UiSelector().text("Ok, grazie")',
                        'android=new UiSelector().textContains("Ok, grazie")',
                        'android=new UiSelector().description("Ok, grazie")',
                        'android=new UiSelector().descriptionContains("Ok, grazie")',
                        '//*[@text="Ok, grazie"]',
                        '//*[@content-desc="Ok, grazie"]'
                    ],
                    300
                );

            if (okGrazie) {

                console.log(
                    '"Ok, grazie" popup detected.'
                );

                await this.tapElement(
                    okGrazie,
                    driver
                );

                stableHomeChecks = 0;

                await driver.pause(500);

                continue;
            }

            // ----------------------------------------------------
            // LOGIN STILL VISIBLE
            // ----------------------------------------------------

            if (
                await this.isLoginPageVisible(driver)
            ) {

                stableHomeChecks = 0;

                console.log(
                    "Login page still visible."
                );

                await driver.pause(500);

                continue;
            }

            // ----------------------------------------------------
            // OTP STILL VISIBLE
            // ----------------------------------------------------

            if (
                await this.isOtpPageVisible(driver)
            ) {

                stableHomeChecks = 0;

                console.log(
                    "OTP page still visible."
                );

                await driver.pause(500);

                continue;
            }

            // ----------------------------------------------------
            // POST LOGIN STATE
            // ----------------------------------------------------

            stableHomeChecks++;

            console.log(
                `Post-login screen detected. Stability check ${stableHomeChecks}/3`
            );

            // Require three consecutive checks.
            // This avoids declaring Home during a short transition.

            if (
                stableHomeChecks >= 3
            ) {

                console.log(
                    "Home/post-login screen is stable."
                );

                return;
            }

            await driver.pause(500);
        }

        throw new Error(
            "Application did not reach a stable Home/post-login screen within 45 seconds."
        );
    }


    // ============================================================
    // FIND FIRST VISIBLE
    // ============================================================

    async findFirstVisible(
        driver,
        selectors,
        timeoutMs
    ) {

        const deadline =
            Date.now() + timeoutMs;

        while (
            Date.now() < deadline
        ) {

            for (
                const selector of selectors
            ) {

                try {

                    const elements =
                        await driver.$$(selector);

                    for (
                        const element of elements
                    ) {

                        if (
                            await element
                                .isDisplayed()
                                .catch(() => false)
                        ) {

                            return element;
                        }
                    }

                } catch {
                    // Try next selector.
                }
            }

            await driver.pause(150);
        }

        return null;
    }


    // ============================================================
    // CHECK ANY SELECTOR
    // ============================================================

    async isAnyVisible(
        driver,
        selectors
    ) {

        for (
            const selector of selectors
        ) {

            try {

                const elements =
                    await driver.$$(selector);

                for (
                    const element of elements
                ) {

                    if (
                        await element
                            .isDisplayed()
                            .catch(() => false)
                    ) {

                        return true;
                    }
                }

            } catch {
                // Try next selector.
            }
        }

        return false;
    }


    // ============================================================
    // TAP ELEMENT
    // ============================================================

    async tapElement(
        element,
        driver
    ) {

        try {

            await element.waitForDisplayed({
                timeout: 3000
            });

        } catch {}

        try {

            await element.waitForEnabled({
                timeout: 3000
            });

        } catch {}

        // --------------------------------------------------------
        // TAP
        // --------------------------------------------------------

        try {

            await element.tap();

            return;

        } catch {
            // Continue.
        }

        // --------------------------------------------------------
        // CLICK
        // --------------------------------------------------------

        try {

            await element.click();

            return;

        } catch {
            // Continue.
        }

        // --------------------------------------------------------
        // COORDINATE FALLBACK
        // --------------------------------------------------------

        const rect =
            await element.getRect();

        const x =
            Math.round(
                rect.x +
                rect.width / 2
            );

        const y =
            Math.round(
                rect.y +
                rect.height / 2
            );

        console.log(
            `Coordinate fallback: x=${x}, y=${y}`
        );

        await driver.execute(
            "mobile: clickGesture",
            {
                x,
                y
            }
        );
    }


    // ============================================================
    // CLEAR FIELD
    // ============================================================

    async clearField(element) {

        try {

            await element.clearValue();

            return;

        } catch {}

        try {

            await element.setValue("");

        } catch {}
    }

}


// ================================================================
// EXPORT
// ================================================================

module.exports = {
    BrowserStackAndroidService
};