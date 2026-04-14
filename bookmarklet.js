/**
 * Bropilot Bookmarklet — iOS Safari compatible
 *
 * HOW TO USE:
 *   1. Copy the entire content of this file (the IIFE below).
 *   2. Create a new bookmark in Safari on iOS.
 *   3. Edit the bookmark URL and replace it with:
 *        javascript:<paste the IIFE here>
 *      (The URL must start with "javascript:" followed immediately by the code.)
 *   4. Tap the bookmark on any page to open the Bropilot overlay.
 *      Tapping it again while the overlay is visible will hide it.
 *
 * FEATURES:
 *   - Floating chat overlay injected into the current page.
 *   - Dictation via the Web Speech API (webkitSpeechRecognition on iOS/Safari).
 *   - Scroll-to-word, click, type, navigate, and more — all run directly in the
 *     page without any extension APIs.
 *   - Chat history persisted in localStorage across bookmarklet activations.
 */
(function () {
  "use strict";

  // ── Toggle if already injected ───────────────────────────────────────────
  const existing = document.getElementById("bropilot-overlay");
  if (existing) {
    existing.style.display = existing.style.display === "none" ? "flex" : "none";
    return;
  }

  const API_URL = "https://api.sarveshs.dev";
  const MAX_HTML_CONTEXT = 262144;
  const HISTORY_LIMIT = 120;
  const STORAGE_KEY = "bropilot_chatHistory";

  // ── Storage (localStorage) ───────────────────────────────────────────────

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (_) {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (_) {}
  }

  function appendHistory(item) {
    const next = [...loadHistory(), item].slice(-HISTORY_LIMIT);
    saveHistory(next);
    return next;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // ── Tools (run directly in the page) ────────────────────────────────────

  function ensureString(v) {
    return typeof v === "string" ? v : "";
  }

  function parseRegex(input) {
    const s = String(input || "").trim();
    if (!s) return null;
    const slash = s.match(/^\/(.*)\/([a-z]*)$/i);
    if (slash) {
      try {
        return new RegExp(slash[1], slash[2] || "i");
      } catch (_) {
        return null;
      }
    }
    try {
      return new RegExp(s, "i");
    } catch (_) {
      return null;
    }
  }

  function runScrollToWord(regexText) {
    const HIGHLIGHT_CLASS = "bropilot-scroll-highlight";
    const styleId = "bropilot-scroll-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent =
        "." +
        HIGHLIGHT_CLASS +
        "{background:#fff2a8!important;outline:2px solid #ffd33d!important;border-radius:2px;}";
      document.head.appendChild(style);
    }
    const regex = parseRegex(regexText);
    if (!regex) return { ok: false, reason: "Invalid regex." };
    document
      .querySelectorAll("." + HIGHLIGHT_CLASS)
      .forEach(function (el) {
        el.classList.remove(HIGHLIGHT_CLASS);
      });
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || "";
      if (!text.trim() || !regex.test(text)) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      parent.classList.add(HIGHLIGHT_CLASS);
      parent.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true, match: text.trim().slice(0, 120) };
    }
    return { ok: false, reason: "No matching text found on page." };
  }

  function runClickByRegex(regexText) {
    const HIGHLIGHT_CLASS = "bropilot-click-highlight";
    const styleId = "bropilot-click-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent =
        "." +
        HIGHLIGHT_CLASS +
        "{box-shadow:0 0 0 3px #4de0ff inset!important;background-color:rgba(77,224,255,0.14)!important;}";
      document.head.appendChild(style);
    }
    const regex = parseRegex(regexText);
    if (!regex) return { ok: false, reason: "Invalid regex." };
    document
      .querySelectorAll("." + HIGHLIGHT_CLASS)
      .forEach(function (el) {
        el.classList.remove(HIGHLIGHT_CLASS);
      });
    const candidates = Array.from(
      document.querySelectorAll(
        "a,button,input[type='button'],input[type='submit'],[role='button']",
      ),
    );
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const text = (el.innerText || el.textContent || el.value || "").trim();
      if (!text || !regex.test(text)) continue;
      el.classList.add(HIGHLIGHT_CLASS);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.click();
      return { ok: true, match: text.slice(0, 120) };
    }
    return { ok: false, reason: "No matching clickable element found." };
  }

  function runClickBySelector(selector) {
    const target = document.querySelector(selector);
    if (!target) return { ok: false, reason: "No element matched selector." };
    const linkEl = target.closest ? target.closest("a[href]") : null;
    const href = linkEl ? linkEl.getAttribute("href") || "" : "";
    const targetAttr = linkEl
      ? (linkEl.getAttribute("target") || "").toLowerCase()
      : "";
    const hrefLower = href.toLowerCase();
    const isNavigatingLink = Boolean(
      href &&
        href !== "#" &&
        !hrefLower.startsWith("javascript:") &&
        !hrefLower.startsWith("data:") &&
        !hrefLower.startsWith("vbscript:"),
    );
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.click();
    return {
      ok: true,
      isNavigatingLink: isNavigatingLink,
      opensNewTab: targetAttr === "_blank",
    };
  }

  function runTypeBySelector(selector, text, pressEnter) {
    const target = document.querySelector(selector);
    if (!target) return { ok: false, reason: "No element matched selector." };
    const isEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable;
    if (!isEditable)
      return { ok: false, reason: "Target element is not editable." };
    target.focus();
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      target.value = String(text != null ? text : "");
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      target.textContent = String(text != null ? text : "");
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (pressEnter) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        }),
      );
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        const form = target.form;
        if (form) {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            form.submit();
          }
        }
      }
    }
    return { ok: true };
  }

  function runDirectionalScroll(direction, amount) {
    const sign = direction === "up" ? -1 : 1;
    const value = Number(amount) || 600;
    window.scrollBy({ top: sign * value, left: 0, behavior: "smooth" });
    return { ok: true, amount: value, direction: direction };
  }

  async function executeAction(action) {
    const info =
      action && typeof action.commandInfo === "object" && action.commandInfo
        ? action.commandInfo
        : {};

    if (action.command === "open_tab") {
      const url = ensureString(info.url) || "about:blank";
      window.open(url, "_blank");
      return "Opened tab: " + url;
    }

    if (action.command === "navigate") {
      const url = ensureString(info.url);
      if (!url) return "Navigate failed: url is missing.";
      window.location.href = url;
      return "Navigated to: " + url;
    }

    if (action.command === "search_web") {
      const query = ensureString(info.query);
      if (!query) return "Search failed: query is missing.";
      window.open(
        "https://duckduckgo.com/?q=" + encodeURIComponent(query),
        "_blank",
      );
      return "Opened web search for: " + query;
    }

    if (action.command === "click") {
      if (typeof info.selector === "string" && info.selector.trim()) {
        const result = runClickBySelector(info.selector.trim());
        return result.ok
          ? "Clicked selector: " + info.selector.trim()
          : "Click failed: " + result.reason;
      }
      const regexText =
        typeof action.commandInfo === "string"
          ? action.commandInfo
          : ensureString(info.regex);
      if (!regexText) return "Click failed: selector or regex is missing.";
      const result = runClickByRegex(regexText);
      return result.ok
        ? "Clicked: " + result.match
        : "Click failed: " + result.reason;
    }

    if (action.command === "type") {
      const selector = ensureString(info.selector).trim();
      if (!selector) return "Type failed: selector is missing.";
      const result = runTypeBySelector(
        selector,
        ensureString(info.text),
        Boolean(info.pressEnter),
      );
      return result.ok
        ? "Typed into selector: " + selector
        : "Type failed: " + result.reason;
    }

    if (action.command === "scroll") {
      const direction =
        ensureString(info.direction).toLowerCase() === "up" ? "up" : "down";
      const amount = Number(info.amount) || 600;
      const result = runDirectionalScroll(direction, amount);
      return result.ok
        ? "Scrolled " + direction + " by " + amount + "px"
        : "Scroll failed: " + result.reason;
    }

    if (action.command === "go_back") {
      window.history.back();
      return "Went back.";
    }

    if (action.command === "go_forward") {
      window.history.forward();
      return "Went forward.";
    }

    if (action.command === "refresh") {
      window.location.reload();
      return "Refreshed page.";
    }

    if (action.command === "close_tab") {
      window.close();
      return "Closed tab.";
    }

    if (action.command === "wait") {
      const millisFromPayload = Number(info.milliseconds);
      const secondsFromPayload = Number(info.seconds);
      const millis = Number.isFinite(millisFromPayload)
        ? Math.max(0, millisFromPayload)
        : Math.max(
            0,
            (Number.isFinite(secondsFromPayload) ? secondsFromPayload : 1) *
              1000,
          );
      await new Promise(function (resolve) {
        setTimeout(resolve, millis);
      });
      return "Waited " + Math.round(millis) + "ms.";
    }

    if (action.command === "scroll_to_word") {
      const regexText =
        typeof action.commandInfo === "string"
          ? action.commandInfo
          : ensureString(info.regex);
      if (!parseRegex(regexText))
        return "Scroll failed: regex is missing or invalid.";
      const result = runScrollToWord(regexText);
      return result.ok
        ? "Scrolled to match: " + result.match
        : "Scroll failed: " + result.reason;
    }

    if (action.command === "error") {
      const info = JSON.stringify(action.commandInfo != null ? action.commandInfo : {});
      return "Tool error: " + info.slice(0, 200);
    }

    return "Unsupported tool action: " + action.command;
  }

  // ── API ──────────────────────────────────────────────────────────────────

  function normalizeActions(data) {
    function toAction(item) {
      if (!item || typeof item.command !== "string") return null;
      return {
        command: item.command,
        commandInfo: item.commandInfo != null ? item.commandInfo : {},
      };
    }
    if (
      data &&
      data.command === "batch" &&
      data.commandInfo &&
      Array.isArray(data.commandInfo.steps)
    ) {
      return data.commandInfo.steps.map(toAction).filter(Boolean);
    }
    if (Array.isArray(data.actions)) {
      return data.actions.map(toAction).filter(Boolean);
    }
    if (data && typeof data.command === "string") {
      const a = toAction(data);
      return a ? [a] : [];
    }
    return [];
  }

  async function processMessage(text, source, onUpdate) {
    const id = String(Date.now());
    const pageHtml = (
      document.documentElement
        ? document.documentElement.outerHTML
        : ""
    ).slice(0, MAX_HTML_CONTEXT);
    const pageUrl = location.href;

    appendHistory({
      id: id + ":user",
      role: "user",
      text: text,
      source: source,
      timestamp: nowIso(),
    });
    appendHistory({
      id: id + ":thinking",
      role: "system",
      text: "Assistant is thinking...",
      timestamp: nowIso(),
    });
    onUpdate();

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: text,
          html: pageHtml,
          current_url: pageUrl,
        }),
      });

      if (!response.ok) {
        throw new Error("API error: " + response.status);
      }

      const data = await response.json();
      const actions = normalizeActions(data);

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const actionInfoText =
          typeof action.commandInfo === "string"
            ? action.commandInfo
            : JSON.stringify(action.commandInfo);

        appendHistory({
          id: id + ":tool:" + i + ":start",
          role: "tool",
          text: "Using tool: " + action.command + " (" + actionInfoText + ")",
          timestamp: nowIso(),
        });
        onUpdate();

        const toolText = await executeAction(action);

        appendHistory({
          id: id + ":tool:" + i + ":end",
          role: "tool",
          text: toolText,
          timestamp: nowIso(),
        });
        onUpdate();
      }

      if (actions.length === 0) {
        appendHistory({
          id: id + ":empty",
          role: "bot",
          text: "No actions returned from API.",
          timestamp: nowIso(),
        });
        onUpdate();
      }
    } catch (error) {
      const msg = error.message || String(error);
      const friendly = msg.includes("API error:")
        ? "The assistant API returned an error. Please try again."
        : msg.includes("Failed to fetch") || msg.includes("NetworkError")
          ? "Network error — check your internet connection and try again."
          : "Failed to process request: " + msg;
      appendHistory({
        id: id + ":error",
        role: "bot",
        text: friendly,
        timestamp: nowIso(),
      });
      onUpdate();
    }
  }

  // ── CSS ──────────────────────────────────────────────────────────────────

  const STYLE = [
    "#bropilot-overlay{",
    "position:fixed;bottom:16px;right:16px;",
    "width:360px;max-width:calc(100vw - 24px);",
    "max-height:90vh;display:flex;flex-direction:column;",
    "background:#171f31;border-radius:18px;",
    "box-shadow:0 8px 32px rgba(0,0,0,0.6);",
    "z-index:2147483647;",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    "overflow:hidden;",
    "}",
    "#bropilot-overlay *{box-sizing:border-box;margin:0;padding:0;}",
    "#bropilot-inner{",
    "display:flex;flex-direction:column;",
    "padding:16px 14px 14px;gap:10px;",
    "height:100%;max-height:90vh;overflow:hidden;",
    "}",
    "#bropilot-header{display:flex;align-items:center;gap:8px;}",
    "#bropilot-title{",
    "font-size:19px;font-weight:700;color:#b5cfff;letter-spacing:1px;flex:1;",
    "}",
    "#bropilot-close{",
    "background:transparent;border:none;color:#8690ad;",
    "font-size:22px;cursor:pointer;padding:4px 6px;line-height:1;",
    "min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;",
    "}",
    "#bropilot-status{font-size:12px;color:#8690ad;min-height:14px;}",
    "#bropilot-chatbox{",
    "flex:1;background:#1a2338;border:1px solid #2a3657;border-radius:14px;",
    "padding:10px;overflow-y:auto;display:flex;flex-direction:column;gap:7px;",
    "min-height:100px;max-height:38vh;",
    "-webkit-overflow-scrolling:touch;",
    "}",
    ".bropilot-msg{",
    "max-width:92%;font-size:13px;line-height:1.35;border-radius:10px;",
    "padding:7px 10px;word-break:break-word;white-space:pre-wrap;",
    "}",
    ".bropilot-msg.user{align-self:flex-end;background:#33488c;color:#e7edff;}",
    ".bropilot-msg.bot{align-self:flex-start;background:#222f4f;color:#cad7ff;}",
    ".bropilot-msg.system{align-self:center;background:#29375c;color:#d6deff;font-size:11px;}",
    ".bropilot-msg.tool{",
    "align-self:flex-start;background:#213a4f;color:#b7ecff;",
    "border:1px solid #2f5f80;font-size:12px;",
    "}",
    "#bropilot-composer{display:flex;flex-direction:column;gap:7px;}",
    "#bropilot-input{",
    "width:100%;resize:none;border:1px solid #3b4a73;border-radius:10px;",
    "padding:9px;font-family:inherit;font-size:14px;color:#e4ebff;",
    "background:#1f2a45;outline:none;",
    "-webkit-appearance:none;",
    "}",
    "#bropilot-input::placeholder{color:#8d9bc2;}",
    "#bropilot-input:focus{border-color:#6f8ef4;}",
    "#bropilot-actions{display:flex;gap:7px;}",
    ".bropilot-btn{",
    "flex:1;border-radius:10px;border:none;",
    "min-height:44px;font-size:14px;font-weight:600;",
    "font-family:inherit;cursor:pointer;",
    "-webkit-appearance:none;",
    "}",
    "#bropilot-mic{background:#2f3f6d;color:#e2e9ff;}",
    "#bropilot-mic.active{background:#83c9ff;color:#0f233d;}",
    "#bropilot-send{background:#4a69c8;color:#f3f6ff;}",
    "#bropilot-clear{",
    "align-self:flex-end;background:transparent;",
    "border:1px solid #455278;color:#9eb0dd;font-size:12px;font-weight:500;",
    "border-radius:8px;min-height:36px;padding:0 12px;",
    "cursor:pointer;font-family:inherit;-webkit-appearance:none;",
    "}",
  ].join("");

  const styleEl = document.createElement("style");
  styleEl.id = "bropilot-styles";
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  // ── Overlay HTML ─────────────────────────────────────────────────────────

  const overlay = document.createElement("div");
  overlay.id = "bropilot-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Bropilot assistant");
  overlay.innerHTML =
    '<div id="bropilot-inner">' +
    '<div id="bropilot-header">' +
    '<span id="bropilot-title">Bropilot</span>' +
    '<button id="bropilot-close" aria-label="Close Bropilot">\u2715</button>' +
    "</div>" +
    '<div id="bropilot-status">Type or dictate a message</div>' +
    '<div id="bropilot-chatbox" role="log" aria-live="polite"></div>' +
    '<div id="bropilot-composer">' +
    '<textarea id="bropilot-input" rows="3"' +
    ' placeholder="Ask about this page or give a command..."' +
    ' aria-label="Message input"></textarea>' +
    '<div id="bropilot-actions">' +
    '<button id="bropilot-mic" class="bropilot-btn" aria-label="Start dictation">Dictate</button>' +
    '<button id="bropilot-send" class="bropilot-btn" aria-label="Send message">Send</button>' +
    "</div>" +
    "</div>" +
    '<button id="bropilot-clear">Clear Chat</button>' +
    "</div>";
  document.body.appendChild(overlay);

  const chatBox = document.getElementById("bropilot-chatbox");
  const messageInput = document.getElementById("bropilot-input");
  const statusEl = document.getElementById("bropilot-status");
  const micBtn = document.getElementById("bropilot-mic");
  const sendBtn = document.getElementById("bropilot-send");
  const clearBtn = document.getElementById("bropilot-clear");
  const closeBtn = document.getElementById("bropilot-close");

  // ── Render ───────────────────────────────────────────────────────────────

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function renderHistory() {
    const history = loadHistory();
    chatBox.innerHTML = "";
    history.forEach(function (item) {
      const node = document.createElement("div");
      const roleClass =
        item.role === "user"
          ? "user"
          : item.role === "bot"
            ? "bot"
            : item.role === "tool"
              ? "tool"
              : "system";
      node.className = "bropilot-msg " + roleClass;
      node.textContent = item.text;
      chatBox.appendChild(node);
    });
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // ── Speech Recognition ───────────────────────────────────────────────────

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const hasSpeech = Boolean(SpeechRecognition);
  const recognition = hasSpeech ? new SpeechRecognition() : null;
  const DICTATION_IDLE_MS = 5000;
  let isListening = false;
  let dictationIdleTimer = null;

  if (recognition) {
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
  }

  function resetDictationIdleTimer() {
    clearTimeout(dictationIdleTimer);
    dictationIdleTimer = setTimeout(function () {
      if (!isListening) return;
      const text = messageInput.value.trim();
      if (!text) return;
      stopListening();
      doSend("dictation");
    }, DICTATION_IDLE_MS);
  }

  function stopListening() {
    if (!recognition) return;
    recognition.stop();
    isListening = false;
    micBtn.classList.remove("active");
    micBtn.setAttribute("aria-label", "Start dictation");
    micBtn.textContent = "Dictate";
    clearTimeout(dictationIdleTimer);
    setStatus("Dictation off");
  }

  function startListening() {
    if (!recognition) return;
    try {
      recognition.start();
    } catch (_) {
      return;
    }
    isListening = true;
    micBtn.classList.add("active");
    micBtn.setAttribute("aria-label", "Stop dictation");
    micBtn.textContent = "Listening...";
    setStatus("Dictating... auto-send after " + Math.round(DICTATION_IDLE_MS / 1000) + "s silence");
    resetDictationIdleTimer();
  }

  if (recognition) {
    recognition.addEventListener("result", function (event) {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.trim();
        if (!transcript) continue;
        if (event.results[i].isFinal) {
          messageInput.value = (messageInput.value + " " + transcript).trim();
          resetDictationIdleTimer();
        } else {
          interim += transcript + " ";
        }
      }
      if (interim.trim()) {
        setStatus("Dictating: " + interim.trim());
        resetDictationIdleTimer();
      }
    });

    recognition.addEventListener("error", function (event) {
      if (event.error === "aborted") return;
      const messages = {
        "not-allowed": "Microphone access denied.",
        "no-speech": "No speech detected. Keep speaking.",
        "network": "Network error. Check your connection.",
      };
      stopListening();
      setStatus(messages[event.error] || "Error: " + event.error);
    });

    recognition.addEventListener("end", function () {
      if (!isListening) return;
      try {
        recognition.start();
      } catch (_) {}
    });
  } else {
    micBtn.disabled = true;
    setStatus("Dictation unavailable in this browser. Typing still works.");
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  let isBusy = false;

  async function doSend(source) {
    const text = messageInput.value.trim();
    if (!text || isBusy) return;
    isBusy = true;
    messageInput.value = "";
    sendBtn.disabled = true;
    setStatus(
      source === "dictation" ? "Sending dictated message..." : "Sending...",
    );

    await processMessage(text, source, function () {
      renderHistory();
      setStatus("Working...");
    });

    isBusy = false;
    sendBtn.disabled = false;
    setStatus("Ready");
    renderHistory();
  }

  // ── Events ───────────────────────────────────────────────────────────────

  micBtn.addEventListener("click", function () {
    if (!hasSpeech) return;
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

  sendBtn.addEventListener("click", function () {
    doSend("typed");
  });

  messageInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend("typed");
    }
  });

  clearBtn.addEventListener("click", function () {
    saveHistory([]);
    appendHistory({
      id: "clear-" + Date.now(),
      role: "bot",
      text: "Chat cleared. Ask me anything about this page.",
      timestamp: nowIso(),
    });
    renderHistory();
    setStatus("Chat cleared");
  });

  closeBtn.addEventListener("click", function () {
    overlay.style.display = "none";
  });

  // ── Init ─────────────────────────────────────────────────────────────────

  if (!loadHistory().length) {
    appendHistory({
      id: "welcome",
      role: "bot",
      text: "I can chat, scroll to text, and click matching buttons or links on this page.",
      timestamp: nowIso(),
    });
  }

  renderHistory();
  setStatus("Ready");
})();
