/*
 * QCM Pilot - content script (runs on docs.google.com/forms/*)
 *
 * It reads question text and choices from the page and sends them to the popup.
 * Only when the user explicitly presses "Practice Auto-Fill" it also ticks the
 * suggested choices (QCM_FILL). It NEVER clicks Next/Submit and never types
 * into text fields: the user always reviews the page and submits it themselves.
 */
(() => {
  "use strict";

  // The popup can inject this file again; make sure we only register once.
  if (window.__qcmPilotLoaded) return;
  window.__qcmPilotLoaded = true;

  const OTHER_VALUE = "__other_option__";
  const ID_ATTR = "data-qcm-pilot-id";

  const clean = (text) => (text || "").replace(/\s+/g, " ").trim();

  function getQuestionTitle(item) {
    const heading = item.querySelector('[role="heading"]');
    if (!heading) return "";
    const copy = heading.cloneNode(true);
    copy.querySelectorAll('[aria-label="Required question"]').forEach((n) => n.remove());
    return clean(copy.textContent)
      .replace(/\s*Required question\s*$/i, "")
      .replace(/\s*\*\s*$/, "")
      .trim();
  }

  function getOptionLabel(el) {
    const value = el.getAttribute("data-value");
    if (value === OTHER_VALUE) return ""; // free-text "Other" has no fixed label
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (value) return clean(value);
    return clean(el.textContent);
  }

  function readOptions(item) {
    // Order matters: checkboxes -> radios -> dropdown entries.
    const groups = [
      { selector: '[role="checkbox"]', multiple: true, kind: "checkbox" },
      { selector: '[role="radio"]', multiple: false, kind: "radio" },
      { selector: '[role="listbox"] [role="option"]', multiple: false, kind: "dropdown" },
    ];
    for (const group of groups) {
      const nodes = Array.from(item.querySelectorAll(group.selector));
      const options = [];
      const entries = [];
      for (const node of nodes) {
        // Dropdown placeholder ("Choose") has an empty data-value.
        if (group.kind === "dropdown" && node.getAttribute("data-value") === "") continue;
        const label = getOptionLabel(node);
        if (label && !options.includes(label)) {
          options.push(label);
          entries.push({ node, label });
        }
      }
      if (options.length) return { options, entries, multiple: group.multiple, kind: group.kind };
    }
    return { options: [], entries: [], multiple: false, kind: "none" };
  }

  function scanQuestions() {
    const items = document.querySelectorAll('div[role="listitem"]');
    const questions = [];
    items.forEach((item, index) => {
      const question = getQuestionTitle(item);
      const { options, multiple } = readOptions(item);
      if (!question || options.length < 2) return; // not a multiple-choice question
      item.setAttribute(ID_ATTR, String(index));
      questions.push({ id: index, question, options, multiple });
    });
    return questions;
  }

  function highlightQuestion(id) {
    const item = document.querySelector(`[${ID_ATTR}="${CSS.escape(String(id))}"]`);
    if (!item) return false;
    item.scrollIntoView({ behavior: "smooth", block: "center" });
    const previous = item.style.outline;
    item.style.outline = "2px solid #6c8cff";
    item.style.outlineOffset = "4px";
    setTimeout(() => {
      item.style.outline = previous;
      item.style.outlineOffset = "";
    }, 2000);
    return true;
  }

  // ---- Practice Auto-Fill (only runs on an explicit user request) -----------

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (text) => clean(text).toLowerCase();

  function realClick(node) {
    // Full pointer sequence: plain .click() is not enough for Google's dropdowns.
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  const isChecked = (node) => node.getAttribute("aria-checked") === "true";

  async function fillQuestion(item, wanted) {
    const { entries, kind } = readOptions(item);
    const wantedSet = new Set(wanted.map(norm));
    const targets = entries.filter((e) => wantedSet.has(norm(e.label)));
    if (!targets.length) return "not_found";

    if (kind === "checkbox") {
      // Bring every box to the suggested state.
      for (const { node, label } of entries) {
        const shouldBeChecked = wantedSet.has(norm(label));
        if (isChecked(node) !== shouldBeChecked) node.click();
      }
      return "filled";
    }
    if (kind === "radio") {
      if (!isChecked(targets[0].node)) targets[0].node.click();
      return "filled";
    }
    if (kind === "dropdown") {
      const trigger = item.querySelector('[role="listbox"]');
      if (trigger) realClick(trigger);
      await wait(250);
      realClick(targets[0].node);
      await wait(150);
      return "filled";
    }
    return "not_found";
  }

  async function fillQuestions(items) {
    const results = [];
    for (const entry of items || []) {
      const item = document.querySelector(`[${ID_ATTR}="${CSS.escape(String(entry.id))}"]`);
      if (!item) {
        results.push({ id: entry.id, status: "missing" });
        continue;
      }
      try {
        results.push({ id: entry.id, status: await fillQuestion(item, entry.choices || []) });
      } catch (_error) {
        results.push({ id: entry.id, status: "error" });
      }
    }
    return results;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message && message.type === "QCM_SCAN") {
        sendResponse({ ok: true, questions: scanQuestions() });
      } else if (message && message.type === "QCM_FOCUS") {
        sendResponse({ ok: highlightQuestion(message.id) });
      } else if (message && message.type === "QCM_FILL") {
        fillQuestions(message.items)
          .then((results) => sendResponse({ ok: true, results }))
          .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
        return true; // async response
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    }
    return false;
  });
})();
