"use strict";

const API_URL = "http://127.0.0.1:8000/";
const MAX_HTML_CONTEXT = 60000;
const HISTORY_LIMIT = 120;

function nowIso() {
  return new Date().toISOString();
}

async function getState() {
  const data = await chrome.storage.local.get(["chatHistory", "pendingRequest"]);
  return {
    chatHistory: Array.isArray(data.chatHistory) ? data.chatHistory : [],
    pendingRequest: data.pendingRequest || null,
  };
}

async function setPendingRequest(pendingRequest) {
  await chrome.storage.local.set({ pendingRequest });
}

async function clearPendingRequest() {
  await chrome.storage.local.set({ pendingRequest: null });
}

async function appendHistory(item) {
  const { chatHistory } = await getState();
  const next = [...chatHistory, item].slice(-HISTORY_LIMIT);
  await chrome.storage.local.set({ chatHistory: next });
}

function normalizeActions(responseData) {
  if (Array.isArray(responseData.actions)) {
    return responseData.actions
      .filter((a) => a && typeof a.command === "string" && typeof a.commandInfo === "string")
      .map((a) => ({ command: a.command, commandInfo: a.commandInfo }));
  }

  if (typeof responseData.command === "string" && typeof responseData.commandInfo === "string") {
    if (responseData.command === "scroll_to_word" || responseData.command === "click") {
      return [{ command: responseData.command, commandInfo: responseData.commandInfo }];
    }
  }

  return [];
}

function normalizeAssistantText(responseData) {
  if (typeof responseData.assistantMessage === "string" && responseData.assistantMessage.trim()) {
    return responseData.assistantMessage.trim();
  }

  if (
    typeof responseData.commandInfo === "string" &&
    responseData.commandInfo.trim() &&
    (responseData.command === "assistant_response" || responseData.command === "no_tool_called" || responseData.command === "assistant_text")
  ) {
    return responseData.commandInfo.trim();
  }

  return "";
}

async function getPageContext(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxChars) => {
      const html = document.documentElement ? document.documentElement.outerHTML : "";
      return {
        html: html.slice(0, maxChars),
        url: location.href,
        title: document.title || "",
      };
    },
    args: [MAX_HTML_CONTEXT],
  });

  return {
    pageHtml: result?.html || "",
    pageUrl: result?.url || "",
    pageTitle: result?.title || "",
  };
}

async function runScrollTool(tabId, regexText) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (rawRegex) => {
      const HIGHLIGHT_ID = "bropilot-scroll-highlight";
      const styleId = "bropilot-scroll-style";

      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          .${HIGHLIGHT_ID} {
            background: #fff2a8 !important;
            outline: 2px solid #ffd33d !important;
            border-radius: 2px;
            transition: background 0.2s ease;
          }
        `;
        document.head.appendChild(style);
      }

      const parseRegex = (input) => {
        const s = String(input || "").trim();
        if (!s) return null;
        const slash = s.match(/^\/(.*)\/([a-z]*)$/i);
        if (slash) {
          try {
            return new RegExp(slash[1], slash[2] || "i");
          } catch (e) {
            return null;
          }
        }
        try {
          return new RegExp(s, "i");
        } catch (e) {
          return null;
        }
      };

      const regex = parseRegex(rawRegex);
      if (!regex) return { ok: false, reason: "Invalid regex." };

      document.querySelectorAll(`.${HIGHLIGHT_ID}`).forEach((el) => el.classList.remove(HIGHLIGHT_ID));

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue || "";
        if (!text.trim()) continue;
        if (!regex.test(text)) continue;

        const parent = node.parentElement;
        if (!parent) continue;
        parent.classList.add(HIGHLIGHT_ID);
        parent.scrollIntoView({ behavior: "smooth", block: "center" });
        return { ok: true, match: text.trim().slice(0, 120) };
      }

      return { ok: false, reason: "No matching text found on page." };
    },
    args: [regexText],
  });

  return result || { ok: false, reason: "Unknown scroll error." };
}

async function runClickTool(tabId, regexText) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (rawRegex) => {
      const HIGHLIGHT_ID = "bropilot-click-highlight";
      const styleId = "bropilot-click-style";

      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          .${HIGHLIGHT_ID} {
            box-shadow: 0 0 0 3px #4de0ff inset !important;
            background-color: rgba(77, 224, 255, 0.14) !important;
            transition: background-color 0.2s ease;
          }
        `;
        document.head.appendChild(style);
      }

      const parseRegex = (input) => {
        const s = String(input || "").trim();
        if (!s) return null;
        const slash = s.match(/^\/(.*)\/([a-z]*)$/i);
        if (slash) {
          try {
            return new RegExp(slash[1], slash[2] || "i");
          } catch (e) {
            return null;
          }
        }
        try {
          return new RegExp(s, "i");
        } catch (e) {
          return null;
        }
      };

      const regex = parseRegex(rawRegex);
      if (!regex) return { ok: false, reason: "Invalid regex." };

      document.querySelectorAll(`.${HIGHLIGHT_ID}`).forEach((el) => el.classList.remove(HIGHLIGHT_ID));

      const candidates = Array.from(
        document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button']")
      );

      for (const el of candidates) {
        const text = (el.innerText || el.textContent || el.value || "").trim();
        if (!text) continue;
        if (!regex.test(text)) continue;

        el.classList.add(HIGHLIGHT_ID);
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.click();
        return { ok: true, match: text.slice(0, 120) };
      }

      return { ok: false, reason: "No matching clickable element found." };
    },
    args: [regexText],
  });

  return result || { ok: false, reason: "Unknown click error." };
}

async function executeToolAction(tabId, action) {
  if (action.command === "scroll_to_word") {
    const result = await runScrollTool(tabId, action.commandInfo);
    return result.ok ? `Scrolled to match: ${result.match}` : `Scroll failed: ${result.reason}`;
  }

  if (action.command === "click") {
    const result = await runClickTool(tabId, action.commandInfo);
    return result.ok ? `Clicked: ${result.match}` : `Click failed: ${result.reason}`;
  }

  return `Unsupported tool action: ${action.command}`;
}

async function processMessage({ requestId, text, source, tabId }) {
  const id = requestId || `${Date.now()}`;

  await appendHistory({
    id: `${id}:user`,
    role: "user",
    text,
    source,
    timestamp: nowIso(),
  });

  await setPendingRequest({ id, text, source, tabId, startedAt: nowIso() });
  await appendHistory({
    id: `${id}:thinking`,
    role: "system",
    text: "Assistant is thinking...",
    timestamp: nowIso(),
  });

  try {
    const context = await getPageContext(tabId);

    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: text,
        pageHtml: context.pageHtml,
        pageUrl: context.pageUrl,
        pageTitle: context.pageTitle,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const assistantText = normalizeAssistantText(data);
    const actions = normalizeActions(data);

    if (assistantText) {
      await appendHistory({
        id: `${id}:assistant`,
        role: "bot",
        text: assistantText,
        timestamp: nowIso(),
      });
    }

    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      await appendHistory({
        id: `${id}:tool:${i}:start`,
        role: "tool",
        text: `Using tool: ${action.command} (${action.commandInfo})`,
        timestamp: nowIso(),
      });

      const toolText = await executeToolAction(tabId, action);
      await appendHistory({
        id: `${id}:tool:${i}:end`,
        role: "tool",
        text: toolText,
        timestamp: nowIso(),
      });
    }

    if (!assistantText && actions.length === 0) {
      await appendHistory({
        id: `${id}:empty`,
        role: "bot",
        text: "I could not generate a response. Please try again.",
        timestamp: nowIso(),
      });
    }
  } catch (error) {
    await appendHistory({
      id: `${id}:error`,
      role: "bot",
      text: `Failed to process request: ${error.message}`,
      timestamp: nowIso(),
    });
  } finally {
    await clearPendingRequest();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { chatHistory } = await getState();
  if (!chatHistory.length) {
    await appendHistory({
      id: "welcome",
      role: "bot",
      text: "I can chat, use tools, and continue requests even if popup closes.",
      timestamp: nowIso(),
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "Invalid message." });
    return;
  }

  if (message.type === "process_message") {
    processMessage(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "clear_history") {
    chrome.storage.local
      .set({ chatHistory: [], pendingRequest: null })
      .then(async () => {
        await appendHistory({
          id: `clear-${Date.now()}`,
          role: "bot",
          text: "Chat cleared. Ask me anything about this page.",
          timestamp: nowIso(),
        });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  sendResponse({ ok: false, error: "Unknown message type." });
});
