/**
 * contractSelector.ts (v2 — Sky DOM-aware)
 * ============================================================
 * Handles Sky's contract picker for multi-contract accounts.
 *
 * WHY v2 EXISTS
 * -------------
 * v1 looked for a <label for="..."> on each radio input. Sky's picker
 * uses a Stencil.js custom element (<sky-new-radio-button hydrated>)
 * and the native <label for="..."> is EMPTY — the visible text
 * ("Casa QUARTUCCIU · Contratto Wifi + TV - 10600970") lives in
 * sibling divs, not attached to the radio. v1's detection returned
 * empty label strings and concluded no picker was present, even when
 * it was on screen.
 *
 * v2 DOM CONTRACT (observed via DevTools on production)
 * -----------------------------------------------------
 *   <div class="header_no_style_btn"
 *        id="header-popup-contracts-list-10600970"
 *        aria-label="Contratto 10600970"
 *        zoneid="menu_parco_profilo_seleziona-contratto">
 *     <div class="shwc-avatar-wrapper">...</div>
 *     <sky-new-radio-button class="hydrated">
 *       <div class="radio-item">
 *         <input type="radio" name="sky-radio" id="1060097_0" ...>
 *         <label for="1060097_0" class="label-radio-button primary"></label>
 *       </div>
 *     </sky-new-radio-button>
 *     (visible label text lives in adjacent divs — not shown here)
 *   </div>
 *
 * Reliable identifiers:
 *   - id="header-popup-contracts-list-{contractId}"
 *   - aria-label="Contratto {contractId}"
 *   - container.textContent contains the full label
 *     ("Casa QUARTUCCIU Contratto Wifi + TV - 10600970")
 *
 * v2 targets the CONTAINER (id or aria-label), matches user
 * criteria against the container's textContent + aria-label + id,
 * and clicks the container itself (Sky treats the whole card as
 * clickable — class="header_no_style_btn" is button styling on a div).
 */

import { logger } from "../utils/logger";

export interface ContractSelectorConfig {
  /**
   * Case-insensitive substring the visible label must contain,
   * e.g. "Wifi + TV" or "Contratto TV". Matched against the
   * container's full textContent. Robust across environments
   * because it doesn't depend on the contract number.
   */
  label_contains?: string;
  /**
   * Optional contract-number substring, e.g. "10600970". When
   * set and a matching container is found, this takes priority
   * over label_contains. Matched against the container id and
   * aria-label.
   */
  contract_id?: string;
  /** Max wait (ms) to detect the picker. Default 8000. */
  detection_timeout_ms?: number;
  /** Max wait (ms) for the post-Conferma redirect. Default 15000. */
  confirm_timeout_ms?: number;
}

export interface ContractSelectorResult {
  outcome: "no_picker" | "selected" | "already_selected" | "failed";
  reason?: string;
  labelMatched?: string;
  finalUrl?: string;
  /** All contract cards seen in the picker (for diagnostics). */
  seenLabels?: string[];
}

/**
 * Detect and handle the contract picker.
 *
 * Non-throwing: all errors surface via the result envelope so the
 * caller can log/emit issue/continue. Never let a picker-detection
 * failure crash the scan.
 */
export async function selectContract(
  page: any,
  config: ContractSelectorConfig | undefined | null
): Promise<ContractSelectorResult> {
  if (!config || (!config.label_contains && !config.contract_id)) {
    return { outcome: "no_picker", reason: "No contract_selector configured." };
  }

  const detectionTimeout = Math.max(2000, Math.min(config.detection_timeout_ms ?? 8000, 30000));
  const confirmTimeout = Math.max(3000, Math.min(config.confirm_timeout_ms ?? 15000, 60000));

  // 1. Detect the picker via container elements.
  const detection = await detectPicker(page, detectionTimeout);
  if (!detection.pickerDetected) {
    logger.info(`Contract picker not detected within ${detectionTimeout}ms (single-contract account or picker not shown).`);
    return {
      outcome: "no_picker",
      reason: "Picker DOM not detected within timeout.",
      seenLabels: detection.availableLabels,
    };
  }

  logger.info(`Contract picker detected. ${detection.cards.length} contract card(s): ${detection.availableLabels.map(l => `"${l.slice(0, 60)}"`).join(" | ")}`);

  // 2. Match + click the correct card.
  const clickResult = await clickMatchingCard(page, {
    label_contains: config.label_contains,
    contract_id: config.contract_id,
  });

  if (!clickResult.clicked) {
    return {
      outcome: "failed",
      reason: clickResult.reason || "Could not click a matching contract card.",
      seenLabels: detection.availableLabels,
    };
  }

  logger.info(`Clicked contract card: "${clickResult.labelMatched}"`);

  // 3. Click Conferma.
  await page.waitForTimeout(400).catch(() => undefined); // let the radio-selected state settle
  const confermaClicked = await clickConferma(page);
  if (!confermaClicked) {
    return {
      outcome: "failed",
      labelMatched: clickResult.labelMatched,
      reason: "Contract card was selected but Conferma could not be clicked.",
      seenLabels: detection.availableLabels,
    };
  }

  // 4. Wait for the picker to close.
  const settled = await waitForPickerToClose(page, confirmTimeout);
  const finalUrl = (() => {
    try { return page.url(); } catch { return ""; }
  })();

  if (!settled) {
    return {
      outcome: "failed",
      labelMatched: clickResult.labelMatched,
      finalUrl,
      reason: `Picker still visible after Conferma; timeout after ${confirmTimeout}ms.`,
      seenLabels: detection.availableLabels,
    };
  }

  logger.info(`Contract selection complete: "${clickResult.labelMatched}". Final URL: ${finalUrl}`);
  return {
    outcome: "selected",
    labelMatched: clickResult.labelMatched,
    finalUrl,
    seenLabels: detection.availableLabels,
  };
}

// -----------------------------------------------------------------
// Internals
// -----------------------------------------------------------------

interface DetectedPicker {
  pickerDetected: boolean;
  cards: Array<{ id: string; ariaLabel: string; text: string }>;
  availableLabels: string[];
}

/**
 * Detect the picker by finding contract card CONTAINERS, not native
 * radio inputs. Three heuristics are tried in-order:
 *   1. Elements with id starting with "header-popup-contracts-list-"
 *      (Sky's stable naming convention seen in production DOM).
 *   2. Elements with aria-label starting with "Contratto " followed
 *      by digits (aria naming convention).
 *   3. Fallback: containers wrapping <sky-new-radio-button> that
 *      also contain the word "contratto" in their textContent.
 * Any heuristic returning >= 2 cards constitutes a detected picker.
 */
async function detectPicker(page: any, timeoutMs: number): Promise<DetectedPicker> {
  const deadline = Date.now() + timeoutMs;
  let last: DetectedPicker = { pickerDetected: false, cards: [], availableLabels: [] };

  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => undefined);
    last = await page.evaluate(() => {
      const visible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const cleanText = (t: string) => (t || "").replace(/\s+/g, " ").trim();

      const collected = new Map<Element, { id: string; ariaLabel: string; text: string }>();
      const push = (el: Element) => {
        if (!visible(el)) return;
        if (collected.has(el)) return;
        const id = (el as HTMLElement).id || "";
        const ariaLabel = el.getAttribute("aria-label") || "";
        const text = cleanText(el.textContent || "");
        // Require the container to actually reference a contract.
        if (!/contratto|contract/i.test([id, ariaLabel, text].join(" "))) return;
        collected.set(el, { id, ariaLabel, text });
      };

      // Heuristic 1 — Sky's stable id convention.
      document.querySelectorAll('[id^="header-popup-contracts-list-"]').forEach(push);

      // Heuristic 2 — aria-label naming convention.
      document.querySelectorAll('[aria-label^="Contratto "]').forEach(push);

      // Heuristic 3 — fallback via web-component + textContent.
      document.querySelectorAll('sky-new-radio-button').forEach(radio => {
        // Walk up looking for a container that has "contratto" text.
        let container: Element | null = radio.parentElement;
        for (let depth = 0; container && depth < 6; depth++) {
          const t = cleanText(container.textContent || "");
          if (/contratto|contract/i.test(t) && t.length < 400) {
            push(container);
            break;
          }
          container = container.parentElement;
        }
      });

      // Heuristic 4 — Sky's native radios by name.
      document.querySelectorAll('input[type="radio"][name="sky-radio"]').forEach(radio => {
        let container: Element | null = (radio as HTMLElement).parentElement;
        for (let depth = 0; container && depth < 6; depth++) {
          const t = cleanText(container.textContent || "");
          if (/contratto|contract/i.test(t) && t.length < 400) {
            push(container);
            break;
          }
          container = container.parentElement;
        }
      });

      const cards = Array.from(collected.values());
      // Deduplicate cards that are nested inside each other — keep the
      // OUTER-most container (the one with the id or aria-label).
      // Simple approach: prefer cards that have id or aria-label; if
      // multiple share the same text content, keep the one with an id.
      const bySignature = new Map<string, { id: string; ariaLabel: string; text: string }>();
      for (const c of cards) {
        const sig = c.text.slice(0, 200); // approximate identity
        const existing = bySignature.get(sig);
        if (!existing) { bySignature.set(sig, c); continue; }
        // Prefer the card with an id / aria-label.
        if (!existing.id && c.id) { bySignature.set(sig, c); continue; }
        if (!existing.ariaLabel && c.ariaLabel) { bySignature.set(sig, c); continue; }
      }
      const deduped = Array.from(bySignature.values());

      return {
        pickerDetected: deduped.length >= 2,
        cards: deduped,
        availableLabels: deduped.map(c => c.text.slice(0, 160)),
      };
    }).catch(() => last);

    if (last.pickerDetected) return last;
    await page.waitForTimeout(500).catch(() => undefined);
  }
  return last;
}

async function clickMatchingCard(
  page: any,
  criteria: { label_contains?: string; contract_id?: string }
): Promise<{ clicked: boolean; labelMatched?: string; reason?: string }> {
  const result = await page.evaluate((payload: { label_contains?: string; contract_id?: string }) => {
    const visible = (el: Element): boolean => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(el as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const cleanText = (t: string) => (t || "").replace(/\s+/g, " ").trim();
    const normalize = (v: string) =>
      v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

    // Same detection as detectPicker — inline so it runs in-page.
    const collected = new Map<Element, { id: string; ariaLabel: string; text: string; el: Element }>();
    const push = (el: Element) => {
      if (!visible(el)) return;
      if (collected.has(el)) return;
      const id = (el as HTMLElement).id || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const text = cleanText(el.textContent || "");
      if (!/contratto|contract/i.test([id, ariaLabel, text].join(" "))) return;
      collected.set(el, { id, ariaLabel, text, el });
    };
    document.querySelectorAll('[id^="header-popup-contracts-list-"]').forEach(push);
    document.querySelectorAll('[aria-label^="Contratto "]').forEach(push);
    document.querySelectorAll('sky-new-radio-button').forEach(radio => {
      let container: Element | null = (radio as HTMLElement).parentElement;
      for (let depth = 0; container && depth < 6; depth++) {
        const t = cleanText(container.textContent || "");
        if (/contratto|contract/i.test(t) && t.length < 400) { push(container); break; }
        container = container.parentElement;
      }
    });
    document.querySelectorAll('input[type="radio"][name="sky-radio"]').forEach(radio => {
      let container: Element | null = (radio as HTMLElement).parentElement;
      for (let depth = 0; container && depth < 6; depth++) {
        const t = cleanText(container.textContent || "");
        if (/contratto|contract/i.test(t) && t.length < 400) { push(container); break; }
        container = container.parentElement;
      }
    });
    // Prefer outermost containers (those with id/aria-label).
    const bySignature = new Map<string, { id: string; ariaLabel: string; text: string; el: Element }>();
    for (const c of collected.values()) {
      const sig = c.text.slice(0, 200);
      const existing = bySignature.get(sig);
      if (!existing) { bySignature.set(sig, c); continue; }
      if (!existing.id && c.id) { bySignature.set(sig, c); continue; }
      if (!existing.ariaLabel && c.ariaLabel) { bySignature.set(sig, c); continue; }
    }
    const cards = Array.from(bySignature.values());

    if (!cards.length) {
      return { clicked: false, reason: "No contract cards were visible when we tried to click." };
    }

    const contractId = payload.contract_id ? normalize(payload.contract_id) : "";
    const labelContains = payload.label_contains ? normalize(payload.label_contains) : "";

    // Priority: contract_id (matched against id + aria-label + text)
    // then label_contains (matched against text + aria-label).
    let picked: { id: string; ariaLabel: string; text: string; el: Element } | undefined;
    if (contractId) {
      picked = cards.find(c =>
        normalize(c.id).includes(contractId) ||
        normalize(c.ariaLabel).includes(contractId) ||
        normalize(c.text).includes(contractId)
      );
    }
    if (!picked && labelContains) {
      picked = cards.find(c =>
        normalize(c.text).includes(labelContains) ||
        normalize(c.ariaLabel).includes(labelContains)
      );
    }

    if (!picked) {
      const criteriaStr = [
        payload.contract_id ? `contract_id="${payload.contract_id}"` : "",
        payload.label_contains ? `label_contains="${payload.label_contains}"` : "",
      ].filter(Boolean).join(", ");
      return {
        clicked: false,
        reason: `No card matched ${criteriaStr}. Cards seen: ${cards.map(c => (c.text.slice(0, 80) || c.ariaLabel || c.id)).join(" | ")}`,
      };
    }

    const target = picked.el as HTMLElement;

    // Scroll it into view, then dispatch a full mouse sequence + click.
    target.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new MouseEvent("mouseover", opts));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.click();

    // Safety net: also flip the radio state directly. Sky's Stencil
    // component listens for the input's change event, so this
    // guarantees the framework state syncs even if the container
    // click was intercepted.
    const nativeRadio = target.querySelector('input[type="radio"]') as HTMLInputElement | null;
    if (nativeRadio) {
      nativeRadio.checked = true;
      nativeRadio.dispatchEvent(new Event("input", { bubbles: true }));
      nativeRadio.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // And the web component itself, if present.
    const webRadio = target.querySelector('sky-new-radio-button') as HTMLElement | null;
    if (webRadio) {
      webRadio.dispatchEvent(new CustomEvent("radio-change", { bubbles: true, detail: { checked: true } }));
    }

    return {
      clicked: true,
      labelMatched: (picked.text || picked.ariaLabel || picked.id).slice(0, 160),
    };
  }, criteria).catch((err: any) => ({
    clicked: false,
    reason: `In-page evaluation failed: ${err?.message || err}`,
  }));

  return result;
}

async function clickConferma(page: any): Promise<boolean> {
  const selectors = [
    "button.sky-button-primary[aria-label='Conferma']",
    "button[aria-label='Conferma']",
    "button.sky-button-primary",
    "button:has-text('Conferma')",
    "[role='button']:has-text('Conferma')",
    "button:has-text('Continua')",
    "button:has-text('Confirm')",
    "button:has-text('Continue')",
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
        await locator.click({ timeout: 3000, force: true });
        return true;
      }
    } catch { /* try next */ }
  }
  // Text-based DOM fallback for custom shells.
  const fallback = await page.evaluate(() => {
    const normalize = (v: string) => (v || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (el: Element) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(el as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")) as HTMLElement[];
    const match = candidates.find(el => visible(el) &&
      /(conferma|continua|confirm|continue)/i.test(normalize([
        (el as HTMLElement).innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
      ].filter(Boolean).join(" ")))
    );
    if (!match) return false;
    match.scrollIntoView({ block: "center", inline: "center" });
    match.click();
    return true;
  }).catch(() => false);
  return Boolean(fallback);
}

async function waitForPickerToClose(page: any, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);
    const stillOpen = await page.evaluate(() => {
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      // Look for the same signature we used to detect the picker.
      const ids = Array.from(document.querySelectorAll('[id^="header-popup-contracts-list-"]')).filter(visible);
      if (ids.length >= 2) return true;
      const arias = Array.from(document.querySelectorAll('[aria-label^="Contratto "]')).filter(visible);
      if (arias.length >= 2) return true;
      return false;
    }).catch(() => true);
    if (!stillOpen) return true;
    await page.waitForTimeout(500).catch(() => undefined);
  }
  return false;
}
