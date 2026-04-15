(function () {
  "use strict";

  if (document.getElementById("bropilot-root")) return;

  var API_URL = "https://api.sarveshs.dev";
  var MAX_HTML_CONTEXT = 60000;
  var DICTATION_IDLE_MS = 5000;
  var WS_CONNECT_TIMEOUT_MS = 10000;
  var WS_EVENT_TIMEOUT_MS = 50000;
  var WS_MAX_EVENTS = 60;

  var WS_URL = (function () {
    try {
      var parsed = new URL(API_URL);
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      parsed.pathname = "/ws";
      return parsed.toString();
    } catch (_) {
      return "wss://api.sarveshs.dev/ws";
    }
  })();

  /* ── state ── */
  var chatHistory = [];
  var pendingRequest = null;
  var isListening = false;
  var dictationIdleTimer = null;

  /* ── speech recognition ── */
  var SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  var hasSpeech = Boolean(SpeechRecognition);
  var recognition = hasSpeech ? new SpeechRecognition() : null;
  if (recognition) {
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
  }

  /* ── inject styles ── */
  var style = document.createElement("style");
  style.id = "bropilot-style";
  style.textContent =
    '#bropilot-root *{box-sizing:border-box;margin:0;padding:0}' +
    '#bropilot-root{position:fixed;bottom:20px;right:20px;z-index:2147483647;' +
    'font-family:"Inter",system-ui,sans-serif;width:380px;height:540px;' +
    'background:#171f31;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.45);' +
    'display:flex;flex-direction:column;overflow:hidden;resize:both;min-width:300px;min-height:400px}' +
    '#bropilot-root.bropilot-collapsed{height:auto;min-height:unset;resize:none}' +
    '#bropilot-root.bropilot-collapsed .bropilot-body{display:none}' +
    '.bropilot-header{display:flex;align-items:center;gap:10px;padding:12px 16px;' +
    'cursor:grab;user-select:none;border-bottom:1px solid #2a3657;flex-shrink:0}' +
    '.bropilot-header h1{font-size:18px;font-weight:700;color:#b5cfff;letter-spacing:1px;flex:1}' +
    '.bropilot-header button{background:none;border:none;color:#8690ad;font-size:18px;cursor:pointer;padding:2px 6px;line-height:1}' +
    '.bropilot-header button:hover{color:#b5cfff}' +
    '.bropilot-body{display:flex;flex-direction:column;flex:1;padding:0 14px 14px;gap:10px;overflow:hidden}' +
    '.bropilot-status{font-size:13px;color:#8690ad;min-height:16px;text-align:left;padding-top:10px;flex-shrink:0}' +
    '.bropilot-chat{flex:1;background:#1a2338;border:1px solid #2a3657;border-radius:14px;' +
    'box-shadow:0 7px 13px 9px rgba(12,13,20,.25);padding:10px;overflow-y:auto;' +
    'display:flex;flex-direction:column;gap:7px}' +
    '.bropilot-msg{max-width:92%;font-size:13.5px;line-height:1.35;border-radius:11px;' +
    'padding:7px 10px;word-break:break-word;white-space:pre-wrap;animation:bropilotFade .12s ease-out forwards}' +
    '.bropilot-msg.user{align-self:flex-end;background:#33488c;color:#e7edff}' +
    '.bropilot-msg.bot{align-self:flex-start;background:#222f4f;color:#cad7ff}' +
    '.bropilot-msg.system{align-self:center;background:#29375c;color:#d6deff;font-size:12px}' +
    '.bropilot-msg.tool{align-self:flex-start;background:#213a4f;color:#b7ecff;' +
    'border:1px solid #2f5f80;font-size:12.5px}' +
    '.bropilot-composer{display:flex;flex-direction:column;gap:7px;flex-shrink:0}' +
    '.bropilot-composer textarea{width:100%;resize:none;border:1px solid #3b4a73;border-radius:11px;' +
    'padding:9px;font:inherit;font-size:13.5px;color:#e4ebff;background:#1f2a45;outline:none}' +
    '.bropilot-composer textarea::placeholder{color:#8d9bc2}' +
    '.bropilot-composer textarea:focus{border-color:#6f8ef4}' +
    '.bropilot-actions{display:flex;gap:7px}' +
    '.bropilot-actions button{flex:1;border-radius:9px;border:none;height:36px;font-size:13px;' +
    'font-weight:600;cursor:pointer;transition:background .2s,transform .2s,color .2s}' +
    '.bropilot-mic{background:#2f3f6d;color:#e2e9ff}' +
    '.bropilot-mic:hover{background:#394ca1}' +
    '.bropilot-mic.active{background:#83c9ff;color:#0f233d}' +
    '.bropilot-send{background:#4a69c8;color:#f3f6ff}' +
    '.bropilot-send:hover{background:#5a79da}' +
    '.bropilot-clear{align-self:flex-end;width:auto;min-width:82px;height:28px;padding:0 9px;' +
    'border-radius:7px;background:transparent;border:1px solid #455278;color:#9eb0dd;' +
    'font-size:12px;font-weight:500;cursor:pointer;transition:background .2s,color .2s}' +
    '.bropilot-clear:hover{background:#2f3b5a;color:#dbe6ff}' +
    '@keyframes bropilotFade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}';
  document.head.appendChild(style);

  /* ── load Inter font ── */
  if (!document.querySelector('link[href*="fonts.googleapis.com/css2?family=Inter"]')) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
  }

  /* ── build DOM ── */
  var root = document.createElement("div");
  root.id = "bropilot-root";
  root.innerHTML =
    '<div class="bropilot-header">' +
      '<h1>Bropilot</h1>' +
      '<button class="bropilot-collapse-btn" title="Collapse">&#x2212;</button>' +
      '<button class="bropilot-close-btn" title="Close">&times;</button>' +
    '</div>' +
    '<div class="bropilot-body">' +
      '<div class="bropilot-status">Type or dictate a message</div>' +
      '<div class="bropilot-chat">' +
        '<div class="bropilot-msg bot">I can chat, scroll to text, and click matching buttons or links on this page.</div>' +
      '</div>' +
      '<div class="bropilot-composer">' +
        '<textarea rows="2" placeholder="Ask about this page or give a command..."></textarea>' +
        '<div class="bropilot-actions">' +
          '<button class="bropilot-mic">Dictate</button>' +
          '<button class="bropilot-send">Send</button>' +
        '</div>' +
      '</div>' +
      '<button class="bropilot-clear">Clear Chat</button>' +
    '</div>';
  document.body.appendChild(root);

  /* element refs */
  var header = root.querySelector(".bropilot-header");
  var collapseBtn = root.querySelector(".bropilot-collapse-btn");
  var closeBtn = root.querySelector(".bropilot-close-btn");
  var statusEl = root.querySelector(".bropilot-status");
  var chatBox = root.querySelector(".bropilot-chat");
  var messageInput = root.querySelector("textarea");
  var micBtn = root.querySelector(".bropilot-mic");
  var sendBtn = root.querySelector(".bropilot-send");
  var clearBtn = root.querySelector(".bropilot-clear");

  /* ── dragging ── */
  var isDragging = false;
  var dragOffsetX = 0;
  var dragOffsetY = 0;

  header.addEventListener("mousedown", function (e) {
    if (e.target.tagName === "BUTTON") return;
    isDragging = true;
    dragOffsetX = e.clientX - root.getBoundingClientRect().left;
    dragOffsetY = e.clientY - root.getBoundingClientRect().top;
    header.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", function (e) {
    if (!isDragging) return;
    var x = e.clientX - dragOffsetX;
    var y = e.clientY - dragOffsetY;
    root.style.left = Math.max(0, x) + "px";
    root.style.top = Math.max(0, y) + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
  });

  document.addEventListener("mouseup", function () {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = "grab";
    }
  });

  /* ── collapse / close ── */
  collapseBtn.addEventListener("click", function () {
    var collapsed = root.classList.toggle("bropilot-collapsed");
    collapseBtn.innerHTML = collapsed ? "&#x002B;" : "&#x2212;";
    collapseBtn.title = collapsed ? "Expand" : "Collapse";
  });

  closeBtn.addEventListener("click", function () {
    root.remove();
    style.remove();
    if (recognition && isListening) recognition.stop();
  });

  /* ── helpers ── */
  function toErrorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error || "Unknown error");
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function toMessageClass(role) {
    if (role === "user") return "user";
    if (role === "bot") return "bot";
    if (role === "tool") return "tool";
    return "system";
  }

  function renderHistory() {
    chatBox.innerHTML = "";
    chatHistory.forEach(function (item) {
      var node = document.createElement("div");
      node.className = "bropilot-msg " + toMessageClass(item.role);
      node.textContent = item.text;
      chatBox.appendChild(node);
    });
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function appendHistory(item) {
    chatHistory.push(item);
    renderHistory();
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /* ── in-page tool execution ── */
  function ensureString(value) {
    return typeof value === "string" ? value : "";
  }

  function parseRegex(input) {
    var s = String(input || "").trim();
    if (!s) return null;
    var slash = s.match(/^\/(.*)\/([a-z]*)$/i);
    if (slash) {
      try { return new RegExp(slash[1], slash[2] || "i"); } catch (_) { return null; }
    }
    try { return new RegExp(s, "i"); } catch (_) { return null; }
  }

  function runScrollToWord(regexText) {
    var HIGHLIGHT_ID = "bropilot-scroll-highlight";
    var styleId = "bropilot-scroll-style";
    if (!document.getElementById(styleId)) {
      var s = document.createElement("style");
      s.id = styleId;
      s.textContent = "." + HIGHLIGHT_ID + "{background:#fff2a8!important;outline:2px solid #ffd33d!important;border-radius:2px;transition:background .2s ease}";
      document.head.appendChild(s);
    }
    var regex = parseRegex(regexText);
    if (!regex) return { ok: false, reason: "Invalid regex." };
    document.querySelectorAll("." + HIGHLIGHT_ID).forEach(function (el) { el.classList.remove(HIGHLIGHT_ID); });
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var text = node.nodeValue || "";
      if (!text.trim() || !regex.test(text)) continue;
      var parent = node.parentElement;
      if (!parent || root.contains(parent)) continue;
      parent.classList.add(HIGHLIGHT_ID);
      parent.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true, match: text.trim().slice(0, 120) };
    }
    return { ok: false, reason: "No matching text found on page." };
  }

  function runClickByRegex(regexText) {
    var HIGHLIGHT_ID = "bropilot-click-highlight";
    var styleId = "bropilot-click-style";
    if (!document.getElementById(styleId)) {
      var s = document.createElement("style");
      s.id = styleId;
      s.textContent = "." + HIGHLIGHT_ID + "{box-shadow:0 0 0 3px #4de0ff inset!important;background-color:rgba(77,224,255,.14)!important;transition:background-color .2s ease}";
      document.head.appendChild(s);
    }
    var regex = parseRegex(regexText);
    if (!regex) return { ok: false, reason: "Invalid regex." };
    document.querySelectorAll("." + HIGHLIGHT_ID).forEach(function (el) { el.classList.remove(HIGHLIGHT_ID); });
    var candidates = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button']"));
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.innerText || el.textContent || el.value || "").trim();
      if (!text || !regex.test(text) || root.contains(el)) continue;
      el.classList.add(HIGHLIGHT_ID);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.click();
      return { ok: true, match: text.slice(0, 120) };
    }
    return { ok: false, reason: "No matching clickable element found." };
  }

  function runClickBySelector(selector) {
    var target = document.querySelector(selector);
    if (!target) return { ok: false, reason: "No element matched selector." };
    if (root.contains(target)) return { ok: false, reason: "Cannot click Bropilot UI elements." };
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.click();
    return { ok: true };
  }

  function runTypeBySelector(selector, text, pressEnter) {
    var target = document.querySelector(selector);
    if (!target) return { ok: false, reason: "No element matched selector." };
    if (root.contains(target)) return { ok: false, reason: "Cannot type into Bropilot UI elements." };
    var isEditable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    if (!isEditable) return { ok: false, reason: "Target element is not editable." };
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value = String(text != null ? text : "");
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      target.textContent = String(text != null ? text : "");
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (pressEnter) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        var form = target.form;
        if (form) {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        }
      }
    }
    return { ok: true };
  }

  function runDirectionalScroll(direction, amount) {
    var sign = direction === "up" ? -1 : 1;
    var value = Number(amount) || 600;
    window.scrollBy({ top: sign * value, left: 0, behavior: "smooth" });
    return { ok: true };
  }

  function getPageHtmlContext(maxChars) {
    var raw = document.documentElement ? document.documentElement.outerHTML : "";
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars || MAX_HTML_CONTEXT);
  }

  function executeAction(action) {
    var info = (action && typeof action.commandInfo === "object" && action.commandInfo) ? action.commandInfo : {};
    switch (action.command) {
      case "open_tab": {
        var url = ensureString(info.url) || "about:blank";
        window.open(url, "_blank");
        return { ok: true, text: "Opened tab: " + url };
      }
      case "navigate": {
        var navUrl = ensureString(info.url);
        if (!navUrl) return { ok: false, text: "Navigate failed: url is missing." };
        window.location.href = navUrl;
        return { ok: true, text: "Navigated to: " + navUrl };
      }
      case "search_web": {
        var query = ensureString(info.query);
        if (!query) return { ok: false, text: "Search failed: query is missing." };
        window.open("https://duckduckgo.com/?q=" + encodeURIComponent(query), "_blank");
        return { ok: true, text: "Opened web search for: " + query };
      }
      case "click": {
        if (typeof info.selector === "string" && info.selector.trim()) {
          var sResult = runClickBySelector(info.selector.trim());
          return { ok: sResult.ok, text: sResult.ok ? "Clicked selector: " + info.selector.trim() : "Click failed: " + sResult.reason };
        }
        var regexText = typeof action.commandInfo === "string" ? action.commandInfo : ensureString(info.regex);
        if (!regexText) return { ok: false, text: "Click failed: selector or regex is missing." };
        var rResult = runClickByRegex(regexText);
        return { ok: rResult.ok, text: rResult.ok ? "Clicked: " + rResult.match : "Click failed: " + rResult.reason };
      }
      case "type": {
        var sel = ensureString(info.selector).trim();
        if (!sel) return { ok: false, text: "Type failed: selector is missing." };
        var tResult = runTypeBySelector(sel, ensureString(info.text), Boolean(info.pressEnter));
        return { ok: tResult.ok, text: tResult.ok ? "Typed into selector: " + sel : "Type failed: " + tResult.reason };
      }
      case "scroll": {
        var dir = ensureString(info.direction).toLowerCase() === "up" ? "up" : "down";
        var amt = Number(info.amount) || 600;
        var scResult = runDirectionalScroll(dir, amt);
        return { ok: scResult.ok, text: "Scrolled " + dir + " by " + amt + "px" };
      }
      case "scroll_to_word": {
        var rxText = typeof action.commandInfo === "string" ? action.commandInfo : ensureString(info.regex);
        if (!parseRegex(rxText)) return { ok: false, text: "Scroll failed: regex is missing or invalid." };
        var swResult = runScrollToWord(rxText);
        return { ok: swResult.ok, text: swResult.ok ? "Scrolled to match: " + swResult.match : "Scroll failed: " + swResult.reason };
      }
      case "get_page_html": {
        var maxChars = Number(info.maxChars) || MAX_HTML_CONTEXT;
        return { ok: true, text: "Requested page HTML (max " + maxChars + " chars).", html: getPageHtmlContext(maxChars) };
      }
      case "go_back":
        window.history.back();
        return { ok: true, text: "Went back." };
      case "go_forward":
        window.history.forward();
        return { ok: true, text: "Went forward." };
      case "refresh":
        window.location.reload();
        return { ok: true, text: "Refreshed page." };
      case "close_tab":
        window.close();
        return { ok: true, text: "Attempted to close tab." };
      case "wait": {
        var millis = Number(info.milliseconds);
        if (!Number.isFinite(millis)) {
          var secs = Number(info.seconds);
          millis = (Number.isFinite(secs) ? secs : 1) * 1000;
        }
        return { ok: true, text: "Wait " + Math.round(Math.max(0, millis)) + "ms (non-blocking in bookmarklet)." };
      }
      case "error":
        return { ok: false, text: "Tool error: " + JSON.stringify(action.commandInfo || {}) };
      default:
        return { ok: false, text: "Unsupported action: " + action.command };
    }
  }

  /* ── normalize HTTP API response ── */
  function normalizeActions(responseData) {
    function toAction(item) {
      if (!item || typeof item.command !== "string") return null;
      return { command: item.command, commandInfo: item.commandInfo || {} };
    }
    if (responseData && responseData.command === "batch" && responseData.commandInfo && Array.isArray(responseData.commandInfo.steps)) {
      return responseData.commandInfo.steps.map(toAction).filter(Boolean);
    }
    if (Array.isArray(responseData.actions)) return responseData.actions.map(toAction).filter(Boolean);
    if (responseData && typeof responseData.command === "string") {
      var a = toAction(responseData);
      return a ? [a] : [];
    }
    return [];
  }

  /* ── page context ── */
  function getPageContext(includeHtml) {
    return {
      pageHtml: includeHtml ? getPageHtmlContext(MAX_HTML_CONTEXT) : "",
      pageUrl: location.href,
      pageTitle: document.title || "",
    };
  }

  function toolSucceeded(action, toolText) {
    if (action.command === "error") return false;
    var text = String(toolText || "").toLowerCase();
    return !text.includes("failed") && !text.includes("tool error");
  }

  /* ── WebSocket transport ── */
  function openWebSocket(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ws = new WebSocket(url);
      var settled = false;

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (_) { /* no-op */ }
        reject(new Error("WebSocket connection timed out"));
      }, timeoutMs);

      ws.onopen = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("WebSocket failed to connect"));
      };
      ws.onclose = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("WebSocket closed before opening"));
      };
    });
  }

  function waitForSocketMessage(ws, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer;
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      }
      function onMessage(event) {
        cleanup();
        try { resolve(JSON.parse(event.data)); }
        catch (_) { reject(new Error("Invalid JSON from websocket")); }
      }
      function onError() { cleanup(); reject(new Error("WebSocket message error")); }
      function onClose() { cleanup(); reject(new Error("WebSocket closed")); }
      timer = setTimeout(function () { cleanup(); reject(new Error("Timed out waiting for websocket message")); }, timeoutMs);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });
  }

  function sendSocketJson(ws, payload) {
    ws.send(JSON.stringify(payload));
  }

  function closeSocket(ws) {
    if (!ws) return;
    try { ws.close(); } catch (_) { /* no-op */ }
  }

  function processMessageViaWebSocket(id, text) {
    return openWebSocket(WS_URL, WS_CONNECT_TIMEOUT_MS).then(function (ws) {
      var context = getPageContext(false);
      var stepCount = 0;

      sendSocketJson(ws, {
        type: "start_session",
        request_id: id,
        query: text,
        current_url: context.pageUrl,
        html: null,
      });

      function processNext(eventCount) {
        if (eventCount >= WS_MAX_EVENTS) {
          closeSocket(ws);
          throw new Error("WebSocket session exceeded event limit");
        }

        return waitForSocketMessage(ws, WS_EVENT_TIMEOUT_MS).then(function (event) {
          if (!event || typeof event.type !== "string") throw new Error("Malformed websocket event");

          if (event.type === "status") {
            appendHistory({ id: id + ":status:" + eventCount, role: "system", text: event.message || "Working...", timestamp: nowIso() });
            return processNext(eventCount + 1);
          }

          if (event.type === "tool_call") {
            var action = event.action;
            if (!action || typeof action.command !== "string") throw new Error("Invalid tool_call action payload");

            var infoText = typeof action.commandInfo === "string" ? action.commandInfo : JSON.stringify(action.commandInfo);
            appendHistory({ id: id + ":tool:" + stepCount + ":start", role: "tool", text: "Using tool: " + action.command + " (" + infoText + ")", timestamp: nowIso() });

            var result;
            try {
              result = executeAction(action);
            } catch (err) {
              result = { ok: false, text: "Tool execution failed: " + toErrorMessage(err) };
            }

            appendHistory({ id: id + ":tool:" + stepCount + ":end", role: "tool", text: result.text, timestamp: nowIso() });

            var latestUrl = location.href;
            var responseHtml = (action.command === "get_page_html" && result.html) ? result.html : undefined;

            sendSocketJson(ws, {
              type: "tool_result",
              request_id: id,
              step_index: typeof event.step_index === "number" ? event.step_index : stepCount,
              success: toolSucceeded(action, result.text),
              result_text: result.text,
              current_url: latestUrl,
              html: responseHtml,
            });

            stepCount += 1;
            return processNext(eventCount + 1);
          }

          if (event.type === "tool_result_ack") {
            return processNext(eventCount + 1);
          }

          if (event.type === "complete") {
            closeSocket(ws);
            var doneMessage = typeof event.message === "string" && event.message.trim() ? event.message.trim() : "Task complete.";
            appendHistory({ id: id + ":complete", role: "bot", text: doneMessage, timestamp: nowIso() });
            return;
          }

          if (event.type === "error") {
            closeSocket(ws);
            throw new Error(event.error || "WebSocket session failed");
          }

          return processNext(eventCount + 1);
        });
      }

      return processNext(0).catch(function (err) {
        closeSocket(ws);
        throw err;
      });
    });
  }

  /* ── HTTP fallback transport ── */
  function processMessageViaHttp(id, text) {
    var context = getPageContext(true);
    return fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: text, html: context.pageHtml, current_url: context.pageUrl }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("API error: " + response.status);
        return response.json();
      })
      .then(function (data) {
        var actions = normalizeActions(data);
        for (var i = 0; i < actions.length; i++) {
          var action = actions[i];
          var infoText = typeof action.commandInfo === "string" ? action.commandInfo : JSON.stringify(action.commandInfo);
          appendHistory({ id: id + ":tool:" + i + ":start", role: "tool", text: "Using tool: " + action.command + " (" + infoText + ")", timestamp: nowIso() });
          var result = executeAction(action);
          appendHistory({ id: id + ":tool:" + i + ":end", role: "tool", text: result.text, timestamp: nowIso() });
        }
        if (actions.length === 0) {
          appendHistory({ id: id + ":empty", role: "bot", text: "No actions returned from API.", timestamp: nowIso() });
        }
      });
  }

  /* ── process message ── */
  function processMessage(text, source) {
    var id = String(Date.now());

    appendHistory({ id: id + ":user", role: "user", text: text, source: source, timestamp: nowIso() });
    appendHistory({ id: id + ":thinking", role: "system", text: "Assistant is thinking...", timestamp: nowIso() });

    pendingRequest = { id: id };
    sendBtn.disabled = true;
    setStatus("Assistant is working...");

    function removeThinking() {
      chatHistory = chatHistory.filter(function (h) { return h.id !== id + ":thinking"; });
    }

    processMessageViaWebSocket(id, text)
      .then(function () {
        removeThinking();
        renderHistory();
      })
      .catch(function (wsError) {
        removeThinking();
        appendHistory({ id: id + ":ws:fallback", role: "system", text: "WebSocket unavailable, using HTTP fallback: " + toErrorMessage(wsError), timestamp: nowIso() });
        return processMessageViaHttp(id, text);
      })
      .catch(function (error) {
        removeThinking();
        appendHistory({ id: id + ":error", role: "bot", text: "Failed to process request: " + toErrorMessage(error), timestamp: nowIso() });
        renderHistory();
      })
      .finally(function () {
        pendingRequest = null;
        sendBtn.disabled = false;
        setStatus("Ready");
      });
  }

  /* ── send message ── */
  function sendCurrentMessage(source) {
    var text = messageInput.value.trim();
    if (!text || pendingRequest) return;
    messageInput.value = "";
    setStatus(source === "dictation" ? "Sending dictated message..." : "Sending...");
    processMessage(text, source);
  }

  /* ── dictation ── */
  function resetDictationIdleTimer() {
    clearTimeout(dictationIdleTimer);
    dictationIdleTimer = setTimeout(function () {
      if (!isListening) return;
      var text = messageInput.value.trim();
      if (!text) return;
      stopListening();
      sendCurrentMessage("dictation");
    }, DICTATION_IDLE_MS);
  }

  function startListening() {
    if (!recognition) return;
    try { recognition.start(); } catch (_) { return; }
    isListening = true;
    micBtn.classList.add("active");
    micBtn.textContent = "Listening...";
    setStatus("Dictating... auto-send after 5s silence");
    resetDictationIdleTimer();
  }

  function stopListening() {
    if (!recognition) return;
    recognition.stop();
    isListening = false;
    micBtn.classList.remove("active");
    micBtn.textContent = "Dictate";
    clearTimeout(dictationIdleTimer);
    setStatus("Dictation off");
  }

  /* ── event listeners ── */
  micBtn.addEventListener("click", function () {
    if (!hasSpeech) return;
    if (isListening) stopListening(); else startListening();
  });

  sendBtn.addEventListener("click", function () { sendCurrentMessage("typed"); });

  messageInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCurrentMessage("typed"); }
  });

  clearBtn.addEventListener("click", function () {
    chatHistory = [];
    renderHistory();
    messageInput.value = "";
    setStatus("Chat cleared");
  });

  if (recognition) {
    recognition.addEventListener("result", function (event) {
      var interim = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var transcript = event.results[i][0].transcript.trim();
        if (!transcript) continue;
        if (event.results[i].isFinal) {
          messageInput.value = (messageInput.value + " " + transcript).trim();
          resetDictationIdleTimer();
        } else {
          interim += transcript + " ";
        }
      }
      if (interim.trim()) { setStatus("Dictating: " + interim.trim()); resetDictationIdleTimer(); }
    });

    recognition.addEventListener("error", function (event) {
      if (event.error === "aborted") return;
      stopListening();
      var messages = { "not-allowed": "Microphone access denied.", "no-speech": "No speech detected.", network: "Network error." };
      setStatus(messages[event.error] || "Error: " + event.error);
    });

    recognition.addEventListener("end", function () {
      if (!isListening) return;
      try { recognition.start(); } catch (_) { /* ignore */ }
    });
  } else {
    micBtn.disabled = true;
    setStatus("Dictation unavailable. Typing still works.");
  }
})();
