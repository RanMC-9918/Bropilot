"use strict";

importScripts("tools.js");

const API_URL = true ? "http://localhost:8000" : "https://api.sarveshs.dev";
const MAX_HTML_CONTEXT = 60000;
const HISTORY_LIMIT = 120;
const WS_CONNECT_TIMEOUT_MS = 10000;
const WS_EVENT_TIMEOUT_MS = 50000;
const WS_MAX_EVENTS = 300;

let activeRequestId = null;

const WS_URL = (() => {
  try {
    const parsed = new URL(API_URL);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    parsed.pathname = "/ws";
    return parsed.toString();
  } catch (_error) {
    return "wss://api.sarveshs.dev/ws";
  }
})();

function nowIso() {
  return new Date().toISOString();
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error");
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

async function getPageContext(tabId, maxChars = MAX_HTML_CONTEXT) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxCaptureChars) => {
      let html = "";
      if (maxCaptureChars > 0) {
        const raw = document.documentElement
          ? document.documentElement.outerHTML
          : "";
        html = raw
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, maxCaptureChars);
      }
      return {
        html,
        url: location.href,
        title: document.title || "",
      };
    },
    args: [maxChars],
  });

  return {
    pageHtml: result?.html || "",
    pageUrl: result?.url || "",
    pageTitle: result?.title || "",
  };
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (_error) {
        // no-op
      }
      reject(new Error("WebSocket connection timed out"));
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("WebSocket failed to connect"));
    };

    ws.onclose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("WebSocket closed before opening"));
    };
  });
}

function waitForSocketMessage(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };

    const onMessage = (event) => {
      cleanup();
      try {
        resolve(JSON.parse(event.data));
      } catch (_error) {
        reject(new Error("Invalid JSON event from websocket"));
      }
    };

    const onError = () => {
      cleanup();
      reject(new Error("WebSocket message error"));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

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
  try {
    ws.close();
  } catch (_error) {
    // no-op
  }
}

function toolSucceeded(action, toolText) {
  if (action.command === "error") return false;
  const text = String(toolText || "").toLowerCase();
  return !text.includes("failed") && !text.includes("tool error");
}

async function waitForTabLoadComplete(tabId, timeoutMs = 15000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.status === "complete") return true;
  } catch (_error) {
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(value);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        finish(true);
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      finish(false);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function processMessageViaHttp(id, text, tabId, context) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: text,
      html: context.pageHtml,
      current_url: context.pageUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  const actions = normalizeActions(data);

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const actionInfoText =
      typeof action.commandInfo === "string"
        ? action.commandInfo
        : JSON.stringify(action.commandInfo);

    if (action.command === "respond_to_user") {
        await appendHistory({
          id: `${id}:tool:${i}:message`,
          role: "bot",
          text: action.commandInfo.message || "Working...",
          timestamp: nowIso(),
        });
    } else {
        await appendHistory({
          id: `${id}:tool:${i}:start`,
          role: "tool",
          text: `Using tool: ${action.command} (${actionInfoText})`,
          timestamp: nowIso(),
        });
        await waitForTabLoadComplete(tabId);
    }

    const toolText = await BropilotTools.executeAction(tabId, action);
    
    if (action.command !== "respond_to_user") {
        await appendHistory({
          id: `${id}:tool:${i}:end`,
          role: "tool",
          text: toolText,
          timestamp: nowIso(),
        });
    }
  }

  if (actions.length === 0) {
    await appendHistory({
      id: `${id}:empty`,
      role: "bot",
      text: "No actions returned from API.",
      timestamp: nowIso(),
    });
  }
}

async function processMessageViaWebSocket(id, text, tabId, context) {
  const ws = await openWebSocket(WS_URL, WS_CONNECT_TIMEOUT_MS);
  let stepCount = 0;

  try {
    sendSocketJson(ws, {
      type: "start_session",
      request_id: id,
      query: text,
      current_url: context.pageUrl,
      html: null,
    });

    for (let eventCount = 0; eventCount < WS_MAX_EVENTS; eventCount += 1) {
      const event = await waitForSocketMessage(ws, WS_EVENT_TIMEOUT_MS);
      if (!event || typeof event.type !== "string") {
        throw new Error("Malformed websocket event");
      }

      if (event.type === "status") {
        const msg = event.message || "Working...";
        if (!msg.startsWith("Planning step") && !msg.startsWith("Execution finished")) {
          // You could optionally log 'status' events less aggressively, but we'll leave it
        }
        await appendHistory({
          id: `${id}:status:${eventCount}`,
          role: "system",
          text: msg,
          timestamp: nowIso(),
        });
        continue;
      }

      if (event.type === "tool_call") {
        const action = event.action;
        if (!action || typeof action.command !== "string") {
          throw new Error("Backend returned invalid tool_call action payload");
        }

        const actionInfoText =
          typeof action.commandInfo === "string"
            ? action.commandInfo
            : JSON.stringify(action.commandInfo);

        if (action.command === "respond_to_user") {
            await appendHistory({
              id: `${id}:tool:${stepCount}:message`,
              role: "bot",
              text: action.commandInfo.message || "Working...",
              timestamp: nowIso(),
            });
        } else {
            await appendHistory({
              id: `${id}:tool:${stepCount}:start`,
              role: "tool",
              text: `Using tool: ${action.command} (${actionInfoText})`,
              timestamp: nowIso(),
            });
            await waitForTabLoadComplete(tabId);
        }

        let toolText = "";
        let success = false;
        let latestContext = context;
        const wantsHtml = action.command === "get_page_html";

        try {
          toolText = await BropilotTools.executeAction(tabId, action);
          success = toolSucceeded(action, toolText);
          latestContext = await getPageContext(
            tabId,
            wantsHtml
              ? Number(action.commandInfo?.maxChars) || MAX_HTML_CONTEXT
              : 0,
          );
        } catch (error) {
          toolText = `Tool execution failed: ${toErrorMessage(error)}`;
          success = false;
        }

        if (action.command !== "respond_to_user") {
            await appendHistory({
              id: `${id}:tool:${stepCount}:end`,
              role: "tool",
              text: toolText,
              timestamp: nowIso(),
            });
        }

        sendSocketJson(ws, {
          type: "tool_result",
          request_id: id,
          step_index:
            typeof event.step_index === "number" ? event.step_index : stepCount,
          success,
          result_text: toolText,
          current_url: latestContext.pageUrl,
          html: wantsHtml ? latestContext.pageHtml : undefined,
        });

        stepCount += 1;
        continue;
      }

      if (event.type === "tool_result_ack") {
        continue;
      }

      if (event.type === "complete") {
        const doneMessage =
          typeof event.message === "string" && event.message.trim()
            ? event.message.trim()
            : "Task complete.";

        if (!doneMessage.includes("Stopped after max steps") && !doneMessage.includes("Validation checks finished")) {
            await appendHistory({
              id: `${id}:complete`,
              role: "bot",
              text: doneMessage,
              timestamp: nowIso(),
            });
        }
        return;
      }

      if (event.type === "error") {
        throw new Error(event.error || "WebSocket session failed");
      }
    }

    throw new Error("WebSocket session exceeded event limit");
  } finally {
    closeSocket(ws);
  }
}

async function processMessage({ requestId, text, source, tabId }) {
  const id = requestId || `${Date.now()}`;
  console.info("[Bropilot] processMessage start", { id, source, tabId });

  if (activeRequestId && activeRequestId !== id) {
    throw new Error("Another request is already in progress");
  }

  activeRequestId = id;

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
    const context = await getPageContext(tabId, 0);

    try {
      await processMessageViaWebSocket(id, text, tabId, context);
    } catch (wsError) {
      await appendHistory({
        id: `${id}:ws:fallback`,
        role: "system",
        text: `WebSocket unavailable, using HTTP fallback: ${toErrorMessage(wsError)}`,
        timestamp: nowIso(),
      });
      const httpContext = await getPageContext(tabId, MAX_HTML_CONTEXT);
      await processMessageViaHttp(id, text, tabId, httpContext);
    }
  } catch (error) {
    console.error("[Bropilot] processMessage failed", error);
    await appendHistory({
      id: `${id}:error`,
      role: "bot",
      text: `Failed to process request: ${toErrorMessage(error)}`,
      timestamp: nowIso(),
    });
  } finally {
    activeRequestId = null;
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
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));
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
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));
    return true;
  }

  sendResponse({ ok: false, error: "Unknown message type." });
});
