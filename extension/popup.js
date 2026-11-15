/*
 * QCM Pilot - popup logic.
 *
 * Flow: scan the form (content script) -> edit the question/choices ->
 * send ONE question to the local backend -> show the suggestion.
 * "Practice Auto-Fill" does the whole flow in one click and ticks the suggested
 * choices, but nothing here ever presses Next or Submit.
 */
"use strict";

const DEFAULT_BACKEND = "http://127.0.0.1:8000";
const BACKEND_PATTERN = /^(http:\/\/(127\.0\.0\.1|localhost):\d{2,5}|https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d{2,5})?)$/i;
const REQUEST_TIMEOUT_MS = 90000;
const BATCH_TIMEOUT_MS = 200000;
const BATCH_SIZE = 10;
const LETTERS = "ABCDEFGHIJKL";

const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"), statusText: $("statusText"),
  scanBtn: $("scanBtn"), addBtn: $("addBtn"), scanMsg: $("scanMsg"),
  editorCard: $("editorCard"), questionSelect: $("questionSelect"),
  questionText: $("questionText"), typeSelect: $("typeSelect"),
  optionsList: $("optionsList"), addOptionBtn: $("addOptionBtn"),
  deleteBtn: $("deleteBtn"), analyzeBtn: $("analyzeBtn"),
  loading: $("loading"), resultCard: $("resultCard"),
  confidenceBadge: $("confidenceBadge"), errorBox: $("errorBox"),
  resultBody: $("resultBody"), answerText: $("answerText"),
  choiceList: $("choiceList"), explanationText: $("explanationText"),
  cautionBox: $("cautionBox"), cautionText: $("cautionText"),
  backendUrl: $("backendUrl"), saveBackendBtn: $("saveBackendBtn"),
  settingsMsg: $("settingsMsg"), accessToken: $("accessToken"),
  autoBtn: $("autoBtn"), autoMsg: $("autoMsg"),
  ackBox: $("ackBox"), skipLowBox: $("skipLowBox"),
};

const state = {
  tabId: null,
  tabUrl: "",
  backend: DEFAULT_BACKEND,
  token: "",
  questions: [], // { id, question, options[], multiple, result }
  current: -1,
  busy: false,
};

/* ----------------------------- helpers ---------------------------------- */

const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

function setMessage(element, text, kind) {
  element.textContent = text;
  element.className = "hint" + (kind ? " " + kind : "");
}

function currentQuestion() {
  return state.questions[state.current] || null;
}

function isGoogleForm(url) {
  return /^https:\/\/docs\.google\.com\/forms\//.test(url || "");
}

/* --------------------------- state persistence -------------------------- */
// Kept only in this browser session so the work survives closing the popup.

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (state.tabId == null || !chrome.storage.session) return;
    try {
      await chrome.storage.session.set({
        [`qcm:${state.tabId}`]: { questions: state.questions, current: state.current },
      });
    } catch (_error) { /* storage is optional */ }
  }, 150);
}

async function restore() {
  if (state.tabId == null || !chrome.storage.session) return;
  try {
    const key = `qcm:${state.tabId}`;
    const saved = (await chrome.storage.session.get(key))[key];
    if (saved && Array.isArray(saved.questions) && saved.questions.length) {
      state.questions = saved.questions;
      state.current = Math.min(saved.current, saved.questions.length - 1);
      renderAll();
      setMessage(els.scanMsg, `${state.questions.length} question(s) restored.`);
    }
  } catch (_error) { /* ignore */ }
}

/* ------------------------------ backend --------------------------------- */

async function loadSettings() {
  try {
    const saved = await chrome.storage.local.get(["backendUrl", "accessToken", "ack", "skipLow"]);
    if (saved.backendUrl && BACKEND_PATTERN.test(saved.backendUrl)) state.backend = saved.backendUrl;
    state.token = saved.accessToken || "";
    els.ackBox.checked = saved.ack === true;
    els.skipLowBox.checked = saved.skipLow !== false;
  } catch (_error) { /* use default */ }
  els.backendUrl.value = state.backend;
  els.accessToken.value = state.token;
}

function saveFlags() {
  try { chrome.storage.local.set({ ack: els.ackBox.checked, skipLow: els.skipLowBox.checked }); } catch (_error) { /* ignore */ }
}

// Headers for every backend call (the token is only needed for an online backend).
function backendHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["X-Access-Token"] = state.token;
  return headers;
}

async function saveBackend() {
  const value = els.backendUrl.value.trim().replace(/\/+$/, "");
  if (!BACKEND_PATTERN.test(value)) {
    setMessage(els.settingsMsg, "Use http://127.0.0.1:PORT, http://localhost:PORT or an https:// address.", "error");
    return;
  }
  if (value.startsWith("https://")) {
    // Ask Chrome for permission to talk to this one server (needs this click).
    try {
      const granted = await chrome.permissions.request({ origins: [`${value}/*`] });
      if (!granted) {
        setMessage(els.settingsMsg, "Permission to reach that server was refused.", "error");
        return;
      }
    } catch (_error) { /* older Chrome: CORS on the server still allows the extension */ }
  }
  state.backend = value;
  state.token = els.accessToken.value.trim();
  els.backendUrl.value = value;
  try { await chrome.storage.local.set({ backendUrl: value, accessToken: state.token }); } catch (_error) { /* ignore */ }
  setMessage(els.settingsMsg, "Saved.", "ok");
  checkBackend();
}

async function checkBackend() {
  els.status.className = "status";
  els.statusText.textContent = "Checking…";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${state.backend}/health`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await response.json();
    if (data.status !== "ok") {
      els.status.className = "status bad";
      els.statusText.textContent = "Config error";
      els.status.title = data.detail || "Check backend/.env";
    } else if (!data.configured) {
      els.status.className = "status warn";
      els.statusText.textContent = "API key missing";
      els.status.title = "Add your API key to backend/.env and restart the server.";
    } else {
      els.status.className = "status ok";
      els.statusText.textContent = data.model || "Online";
      els.status.title = `Backend online (${data.provider})`;
    }
  } catch (_error) {
    els.status.className = "status bad";
    els.statusText.textContent = "Backend offline";
    els.status.title = "Start the backend: see README.md";
  }
}

function requestAnalysis(payload) {
  return postJson("/analyze", payload, REQUEST_TIMEOUT_MS);
}

function requestBatch(questions) {
  return postJson("/analyze-batch", { questions }, BATCH_TIMEOUT_MS);
}

async function postJson(path, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${state.backend}${path}`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = null;
    try { data = await response.json(); } catch (_error) { /* non-JSON body */ }
    if (!response.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Server error (HTTP ${response.status}).`;
      throw new Error(detail);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The request timed out. Please try again.");
    if (error.name === "TypeError") {
      throw new Error(`Cannot reach the backend at ${state.backend}. Is it running? (see README.md)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ page access ----------------------------- */

async function sendToTab(message) {
  try {
    return await chrome.tabs.sendMessage(state.tabId, message);
  } catch (_error) {
    // Tab opened before the extension was installed: inject, then retry once.
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(state.tabId, message);
  }
}

async function scan() {
  if (!isGoogleForm(state.tabUrl)) {
    setMessage(els.scanMsg, "This tab is not a Google Form. Open one, or add a question manually.", "error");
    return;
  }
  els.scanBtn.disabled = true;
  setMessage(els.scanMsg, "Scanning…");
  try {
    const reply = await sendToTab({ type: "QCM_SCAN" });
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || "No answer from the page.");
    const found = reply.questions.map((q) => ({
      id: q.id, question: q.question, options: q.options, multiple: q.multiple, result: null,
    }));
    if (!found.length) {
      setMessage(
        els.scanMsg,
        "No multiple-choice questions found on this page. Scroll to load them, or add one manually.",
        "error"
      );
      return;
    }
    state.questions = found;
    state.current = 0;
    renderAll();
    persist();
    setMessage(els.scanMsg, `${found.length} question(s) found. Edit them if needed, then press Analyze.`, "ok");
  } catch (error) {
    setMessage(els.scanMsg, `Scan failed: ${error.message}. Reload the form page and try again.`, "error");
  } finally {
    els.scanBtn.disabled = false;
  }
}

/* ------------------------------ rendering ------------------------------- */

function renderAll() {
  const hasQuestions = state.questions.length > 0;
  els.editorCard.hidden = !hasQuestions;
  if (!hasQuestions) {
    els.resultCard.hidden = true;
    return;
  }
  renderSelector();
  renderEditor();
}

function renderSelector() {
  els.questionSelect.textContent = "";
  state.questions.forEach((q, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1}. ${truncate(q.question || "(empty question)", 55)}`;
    els.questionSelect.appendChild(option);
  });
  els.questionSelect.value = String(state.current);
}

function renderEditor() {
  const q = currentQuestion();
  if (!q) return;
  els.questionText.value = q.question;
  els.typeSelect.value = q.multiple ? "multiple" : "single";
  renderOptions();
  renderResult();
}

function renderOptions() {
  const q = currentQuestion();
  els.optionsList.textContent = "";
  if (!q) return;
  const suggested = q.result && q.result.choices ? q.result.choices : [];

  q.options.forEach((text, index) => {
    const row = document.createElement("div");
    row.className = "option-row";
    if (suggested.includes(text.trim())) row.classList.add("suggested");

    const letter = document.createElement("span");
    letter.className = "option-letter";
    letter.textContent = LETTERS[index] || String(index + 1);

    const input = document.createElement("input");
    input.type = "text";
    input.value = text;
    input.maxLength = 1000;
    input.placeholder = `Choice ${LETTERS[index] || index + 1}`;
    input.addEventListener("input", () => {
      q.options[index] = input.value;
      persist();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.title = "Remove this choice";
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      q.options.splice(index, 1);
      renderOptions();
      persist();
    });

    row.append(letter, input, remove);
    els.optionsList.appendChild(row);
  });
  els.addOptionBtn.disabled = q.options.length >= 12;
}

function renderResult() {
  const q = currentQuestion();
  const result = q && q.result;
  if (!result) {
    els.resultCard.hidden = true;
    return;
  }
  els.resultCard.hidden = false;

  if (result.error) {
    els.errorBox.hidden = false;
    els.errorBox.textContent = result.error;
    els.resultBody.hidden = true;
    els.confidenceBadge.textContent = "";
    els.confidenceBadge.className = "badge";
    return;
  }

  els.errorBox.hidden = true;
  els.resultBody.hidden = false;
  els.answerText.textContent = result.answer;
  els.explanationText.textContent = result.explanation;

  els.choiceList.textContent = "";
  (result.choices && result.choices.length ? result.choices : [result.choice_text]).forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    els.choiceList.appendChild(li);
  });

  const level = String(result.confidence || "").toLowerCase();
  els.confidenceBadge.textContent = `Confidence: ${result.confidence}`;
  els.confidenceBadge.className = "badge " + (["high", "medium", "low"].includes(level) ? level : "");

  els.cautionBox.hidden = !result.caution;
  els.cautionText.textContent = result.caution || "";
}

function setBusy(busy) {
  state.busy = busy;
  els.loading.hidden = !busy;
  els.analyzeBtn.disabled = busy;
  els.scanBtn.disabled = busy;
  els.autoBtn.disabled = busy;
  if (busy) els.resultCard.hidden = true;
}

/* ------------------------------- actions -------------------------------- */

function selectQuestion(index) {
  if (index < 0 || index >= state.questions.length) return;
  state.current = index;
  els.questionSelect.value = String(index);
  renderEditor();
  persist();
  const q = currentQuestion();
  if (q && q.id !== null && q.id !== undefined && isGoogleForm(state.tabUrl)) {
    // Scroll to the question on the page (visual only). Errors are ignored.
    sendToTab({ type: "QCM_FOCUS", id: q.id }).catch(() => {});
  }
}

function addManualQuestion() {
  state.questions.push({
    id: null, question: "", options: ["", "", "", ""], multiple: false, result: null,
  });
  state.current = state.questions.length - 1;
  renderAll();
  persist();
  els.questionText.focus();
}

function deleteQuestion() {
  if (!currentQuestion()) return;
  state.questions.splice(state.current, 1);
  state.current = Math.min(state.current, state.questions.length - 1);
  renderAll();
  persist();
}

async function analyze() {
  const q = currentQuestion();
  if (!q || state.busy) return;

  const question = q.question.trim();
  const options = q.options.map((o) => o.trim()).filter(Boolean);
  if (question.length < 3) {
    return showClientError(q, "Please enter the question text (at least 3 characters).");
  }
  if (options.length < 2) {
    return showClientError(q, "Please provide at least 2 answer choices.");
  }

  setBusy(true);
  try {
    const data = await requestAnalysis({ question, options, multiple: q.multiple });
    const choices = (data.answer_indexes || []).map((n) => options[n - 1]).filter(Boolean);
    q.result = { ...data, choices };
  } catch (error) {
    q.result = { error: error.message };
  } finally {
    setBusy(false);
    renderOptions(); // highlight the suggested choice in the editor
    renderResult();
    persist();
  }
}

function showClientError(q, message) {
  q.result = { error: message };
  renderResult();
}

/* ---------------------------- practice auto-fill ------------------------ */

const isValidForApi = (q) =>
  q.question.length >= 3 && q.question.length <= 4000 &&
  q.options.length >= 2 && q.options.length <= 12 &&
  q.options.every((o) => o.length <= 1000);

async function autoFill() {
  if (state.busy) return;
  if (!els.ackBox.checked) {
    return setMessage(els.autoMsg, "Tick the confirmation box first: use this only where AI help is allowed.", "error");
  }
  if (!isGoogleForm(state.tabUrl)) {
    return setMessage(els.autoMsg, "Open a Google Form (the /viewform page) in this tab first.", "error");
  }

  setBusy(true);
  try {
    setMessage(els.autoMsg, "1/3 Scanning the form…");
    const scanReply = await sendToTab({ type: "QCM_SCAN" });
    if (!scanReply || !scanReply.ok) throw new Error((scanReply && scanReply.error) || "No answer from the page.");
    const found = scanReply.questions.map((q) => ({
      id: q.id, question: q.question, options: q.options, multiple: q.multiple, result: null,
    }));
    if (!found.length) throw new Error("No multiple-choice questions found on this page. Scroll to load them and try again.");
    state.questions = found;
    state.current = 0;

    const askable = found.filter((q) => {
      if (isValidForApi(q)) return true;
      q.result = { error: "Skipped: question or choices too long/short for the AI." };
      return false;
    });
    for (let i = 0; i < askable.length; i += BATCH_SIZE) {
      const slice = askable.slice(i, i + BATCH_SIZE);
      setMessage(els.autoMsg, `2/3 Asking the AI… (${Math.min(i + BATCH_SIZE, askable.length)}/${askable.length})`);
      const data = await requestBatch(slice.map((q) => ({ question: q.question, options: q.options, multiple: q.multiple })));
      for (const item of data.results || []) {
        const q = slice[item.index];
        if (!q) continue;
        if (item.result) {
          const choices = (item.result.answer_indexes || []).map((n) => q.options[n - 1]).filter(Boolean);
          q.result = { ...item.result, choices };
        } else {
          q.result = { error: item.error || "No answer for this question." };
        }
      }
    }

    setMessage(els.autoMsg, "3/3 Ticking the suggested answers…");
    const skipLow = els.skipLowBox.checked;
    let failed = 0, lowSkipped = 0;
    const toFill = [];
    for (const q of found) {
      if (!q.result || q.result.error) failed++;
      else if (skipLow && q.result.confidence === "Low") lowSkipped++;
      else toFill.push({ id: q.id, choices: q.result.choices });
    }
    let filled = 0;
    if (toFill.length) {
      const fillReply = await sendToTab({ type: "QCM_FILL", items: toFill });
      if (!fillReply || !fillReply.ok) throw new Error((fillReply && fillReply.error) || "Could not fill the form.");
      for (const r of fillReply.results) {
        if (r.status === "filled") filled++; else failed++;
      }
    }
    const parts = [`${filled} filled`];
    if (lowSkipped) parts.push(`${lowSkipped} left blank (low confidence)`);
    if (failed) parts.push(`${failed} not filled`);
    setMessage(
      els.autoMsg,
      `Done: ${parts.join(" · ")}. Review every answer on the form, then submit it yourself.`,
      filled ? "ok" : "error"
    );
  } catch (error) {
    setMessage(els.autoMsg, `Auto-Fill stopped: ${error.message}`, "error");
  } finally {
    setBusy(false);
    renderAll();
    persist();
  }
}

/* -------------------------------- events -------------------------------- */

els.autoBtn.addEventListener("click", autoFill);
els.ackBox.addEventListener("change", saveFlags);
els.skipLowBox.addEventListener("change", saveFlags);
els.scanBtn.addEventListener("click", scan);
els.addBtn.addEventListener("click", addManualQuestion);
els.deleteBtn.addEventListener("click", deleteQuestion);
els.analyzeBtn.addEventListener("click", analyze);
els.saveBackendBtn.addEventListener("click", saveBackend);
els.questionSelect.addEventListener("change", () => selectQuestion(Number(els.questionSelect.value)));

els.addOptionBtn.addEventListener("click", () => {
  const q = currentQuestion();
  if (!q || q.options.length >= 12) return;
  q.options.push("");
  renderOptions();
  persist();
  const inputs = els.optionsList.querySelectorAll("input");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

els.questionText.addEventListener("input", () => {
  const q = currentQuestion();
  if (!q) return;
  q.question = els.questionText.value;
  const label = els.questionSelect.options[state.current];
  if (label) label.textContent = `${state.current + 1}. ${truncate(q.question || "(empty question)", 55)}`;
  persist();
});

els.typeSelect.addEventListener("change", () => {
  const q = currentQuestion();
  if (!q) return;
  q.multiple = els.typeSelect.value === "multiple";
  persist();
});

/* -------------------------------- startup ------------------------------- */

(async function init() {
  await loadSettings();
  checkBackend();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      state.tabId = tab.id;
      state.tabUrl = tab.url || "";
    }
  } catch (_error) { /* leave defaults */ }

  if (!isGoogleForm(state.tabUrl)) {
    setMessage(els.scanMsg, "This tab is not a Google Form. You can still add questions manually.");
  }
  await restore();
})();
