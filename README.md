# Axessia — Round 5c: Silent Detour + Visible Diagnostics

## Two Fixes vs Round 5b

### Fix 1 — /home no longer shows as a "scanned URL" in results

Round 5b used `navigateAndRecord()` to detour to /home, which recorded
it as a scanned page. That's why your scan results showed both /home
and the target URL.

Round 5c uses raw `page.goto()` for the detour — pure navigation, no
recording. Only your actual target URL appears in results.

### Fix 2 — Every contract-switcher event now visible in backend PowerShell log

Round 5b called `progress()` which writes to a scan-specific progress
channel that DOESN'T show up in the Windows PowerShell backend log.
That's why you saw only ONE contract-switcher line
(`Scan navigated through URL (contract-switcher detour requested)`)
which was actually printed by `navigateAndRecord`, not my code.

Round 5c introduces a local `dualLog(msg)` helper inside the switcher
method — every event goes to BOTH the progress channel AND `logger.info`,
so you can see the full flow in the backend PowerShell terminal.

The detour orchestration code also uses `logger.info` directly with
diagnostic detail: what authConfig looks like, whether the /home
navigation succeeded, whether the picker method returned normally
or threw.

## Expected Log Output (After Restart)

Run one scan with contract configured. In the backend PowerShell
terminal you should now see:

```
[contract-switcher] Production path — hasContractCfg=true, authConfig_keys=[contract_number,contract_name,...], opts_auth_config_keys=[...]
[contract-switcher] contract configured — detouring silently to https://abbonamento.sky.it/home before target https://...
[contract-switcher] page.goto(https://abbonamento.sky.it/home) status=200, current URL=https://abbonamento.sky.it/home
[contract-switcher] about to call selectContractIfPickerVisible(). URL=https://abbonamento.sky.it/home
[contract-switcher] ENTER — url=https://abbonamento.sky.it/home contract_number="10600970" contract_name="" auth_keys=[contract_number,contract_name,...]
[contract-switcher] toggle found: "Casa QUARTUCCIU"
[contract-switcher] toggle clicked, waiting for popover
[contract-switcher] popover appeared
[contract-switcher] radio matched by number "10600970", label="..."
[contract-switcher] Conferma clicked
[contract-switcher] popover dismissed — contract switch complete
[contract-switcher] selectContractIfPickerVisible() returned normally
Navigating to https://abbonamento.sky.it/offers/pdp/tv/44157?offerId=44157
```

If any of those lines are missing, the log will tell us exactly where
things stop.

## Failure Modes We Can Now Diagnose

If we see `hasContractCfg=false` → authConfig doesn't have contract_number
  → persistence layer is still broken (unlikely since log showed 58 chars,
    but this confirms it)

If we see `hasContractCfg=true` but no `ENTER —` line → the try/catch
  around the detour caught something. Its error message will be logged.

If we see `ENTER — contract_number="10600970"` but no `toggle found` → the
  DOM selector `div.contract-switch[role="button"]` doesn't match on
  /home for the account being tested.

If we see `toggle found` but no `popover appeared` → click didn't fire
  the popover (Angular event handler timing).

If we see `popover appeared` but no `radio matched` → contract_number
  isn't in any radio label text.

## Install

```powershell
Expand-Archive -Path ".\axessia_round5c.zip" `
  -DestinationPath "C:\Users\vvn431\Downloads\axessia (1)\axessia\" -Force
```

**HARD RESTART BACKEND** (Ctrl+C, `npm run dev`).

## After Running One Scan

Send the log. Grep for `contract-switcher` and paste all matches. We'll
know exactly what's happening for the first time in this whole thread.

## Rollback

```powershell
Copy-Item -Path ".\BACKUP\scanner.ts" `
  -Destination ".\backend\src\scanner\scanner.ts" -Force
```
