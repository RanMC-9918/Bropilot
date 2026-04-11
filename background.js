"use strict";

importScripts("tools.js");

const API_URL = "https://api.sarveshs.dev";
const MAX_HTML_CONTEXT = 262144;
const HISTORY_LIMIT = 120;

function nowIso() {
  return new Date().toISOString();
}

async function getState() {
  const data = await chrome.storage.local.get([
    "chatHistory",
    "pendingRequest",
  ]);
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
  const toAction = (item) => {
    if (!item || typeof item.command !== "string") return null;
    return {
      command: item.command,
      commandInfo: item.commandInfo ?? {},
    };
  };

  if (
    responseData &&
    responseData.command === "batch" &&
    responseData.commandInfo &&
    Array.isArray(responseData.commandInfo.steps)
  ) {
    return responseData.commandInfo.steps
      .map((step) => toAction(step))
      .filter(Boolean);
  }

  if (Array.isArray(responseData.actions)) {
    return responseData.actions.map((a) => toAction(a)).filter(Boolean);
  }

  if (responseData && typeof responseData.command === "string") {
    const action = toAction(responseData);
    return action ? [action] : [];
  }

  return [];
}

async function getPageContext(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxChars) => {
      const html = document.documentElement
        ? document.documentElement.outerHTML
        : "";
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

async function processMessage({ requestId, text, source, tabId }) {
  const id = requestId || `${Date.now()}`;
  console.info("[Bropilot] processMessage start", { id, source, tabId });

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
        html: context.pageHtml,
        current_url: context.pageUrl,
      }),
    });
    console.info("[Bropilot] API response status", response.status);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    console.log("[Bropilot] API response data", data);
    const actions = normalizeActions(data);

    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      const actionInfoText =
        typeof action.commandInfo === "string"
          ? action.commandInfo
          : JSON.stringify(action.commandInfo);

      await appendHistory({
        id: `${id}:tool:${i}:start`,
        role: "tool",
        text: `Using tool: ${action.command} (${actionInfoText})`,
        timestamp: nowIso(),
      });

      const toolText = await BropilotTools.executeAction(tabId, action);
      await appendHistory({
        id: `${id}:tool:${i}:end`,
        role: "tool",
        text: toolText,
        timestamp: nowIso(),
      });
    }

    if (actions.length === 0) {
      await appendHistory({
        id: `${id}:empty`,
        role: "bot",
        text: "No actions returned from API.",
        timestamp: nowIso(),
      });
    }
  } catch (error) {
    console.error("[Bropilot] processMessage failed", error);
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
