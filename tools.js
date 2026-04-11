"use strict";

(function initBropilotTools(globalScope) {
  function ensureString(value) {
    return typeof value === "string" ? value : "";
  }

  function parseRegex(input) {
    const s = String(input || "").trim();
    if (!s) return null;

    const slash = s.match(/^\/(.*)\/([a-z]*)$/i);
    if (slash) {
      try {
        return new RegExp(slash[1], slash[2] || "i");
      } catch (_err) {
        return null;
      }
    }

    try {
      return new RegExp(s, "i");
    } catch (_err) {
      return null;
    }
  }

  async function waitForTabLoad(tabId, timeoutMs = 15000) {
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

  async function runScrollToWord(tabId, regexText) {
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

        const parseInPageRegex = (input) => {
          const s = String(input || "").trim();
          if (!s) return null;
          const slash = s.match(/^\/(.*)\/([a-z]*)$/i);
          if (slash) {
            try {
              return new RegExp(slash[1], slash[2] || "i");
            } catch (_err) {
              return null;
            }
          }
          try {
            return new RegExp(s, "i");
          } catch (_err) {
            return null;
          }
        };

        const regex = parseInPageRegex(rawRegex);
        if (!regex) return { ok: false, reason: "Invalid regex." };

        document
          .querySelectorAll(`.${HIGHLIGHT_ID}`)
          .forEach((el) => el.classList.remove(HIGHLIGHT_ID));

        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
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

  async function runClickByRegex(tabId, regexText) {
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

        const parseInPageRegex = (input) => {
          const s = String(input || "").trim();
          if (!s) return null;
          const slash = s.match(/^\/(.*)\/([a-z]*)$/i);
          if (slash) {
            try {
              return new RegExp(slash[1], slash[2] || "i");
            } catch (_err) {
              return null;
            }
          }
          try {
            return new RegExp(s, "i");
          } catch (_err) {
            return null;
          }
        };

        const regex = parseInPageRegex(rawRegex);
        if (!regex) return { ok: false, reason: "Invalid regex." };

        document
          .querySelectorAll(`.${HIGHLIGHT_ID}`)
          .forEach((el) => el.classList.remove(HIGHLIGHT_ID));

        const candidates = Array.from(
          document.querySelectorAll(
            "a, button, input[type='button'], input[type='submit'], [role='button']",
          ),
        );

        for (const el of candidates) {
          const text = (
            el.innerText ||
            el.textContent ||
            el.value ||
            ""
          ).trim();
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

  async function runClickBySelector(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cssSelector) => {
        const target = document.querySelector(cssSelector);
        if (!target) {
          return { ok: false, reason: "No element matched selector." };
        }

        const linkEl = target.closest ? target.closest("a[href]") : null;
        const href = linkEl ? linkEl.getAttribute("href") || "" : "";
        const targetAttr = linkEl
          ? (linkEl.getAttribute("target") || "").toLowerCase()
          : "";
        const isNavigatingLink = Boolean(
          href && href !== "#" && !href.toLowerCase().startsWith("javascript:"),
        );

        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.click();
        return {
          ok: true,
          isNavigatingLink,
          opensNewTab: targetAttr === "_blank",
        };
      },
      args: [selector],
    });

    return result || { ok: false, reason: "Unknown click error." };
  }

  async function runTypeBySelector(tabId, selector, text, pressEnter) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cssSelector, valueToType, shouldPressEnter) => {
        const target = document.querySelector(cssSelector);
        if (!target) {
          return { ok: false, reason: "No element matched selector." };
        }

        const isEditable =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable;

        if (!isEditable) {
          return { ok: false, reason: "Target element is not editable." };
        }

        target.focus();

        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          target.value = String(valueToType ?? "");
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          target.textContent = String(valueToType ?? "");
          target.dispatchEvent(new Event("input", { bubbles: true }));
        }

        if (shouldPressEnter) {
          const keyDown = new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          });
          const keyUp = new KeyboardEvent("keyup", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          });

          target.dispatchEvent(keyDown);
          target.dispatchEvent(keyUp);

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
      },
      args: [selector, text, Boolean(pressEnter)],
    });

    return result || { ok: false, reason: "Unknown type error." };
  }

  async function runDirectionalScroll(tabId, direction, amount) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (dir, pixels) => {
        const sign = dir === "up" ? -1 : 1;
        const value = Number(pixels) || 600;
        window.scrollBy({ top: sign * value, left: 0, behavior: "smooth" });
        return { ok: true, amount: value, direction: dir };
      },
      args: [direction, amount],
    });

    return result || { ok: false, reason: "Unknown scroll error." };
  }

  async function executeAction(tabId, action) {
    const info =
      action && typeof action.commandInfo === "object" && action.commandInfo
        ? action.commandInfo
        : {};

    if (action.command === "open_tab") {
      const url = ensureString(info.url) || "about:blank";
      await chrome.tabs.create({ url });
      return `Opened tab: ${url}`;
    }

    if (action.command === "navigate") {
      const url = ensureString(info.url);
      if (!url) return "Navigate failed: url is missing.";
      await chrome.tabs.update(tabId, { url });
      return `Navigated current tab to: ${url}`;
    }

    if (action.command === "search_web") {
      const query = ensureString(info.query);
      if (!query) return "Search failed: query is missing.";

      await chrome.tabs.create({
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      });
      return `Opened web search for: ${query}`;
    }

    if (action.command === "click") {
      if (typeof info.selector === "string" && info.selector.trim()) {
        const selectorResult = await runClickBySelector(
          tabId,
          info.selector.trim(),
        );

        if (
          selectorResult.ok &&
          selectorResult.isNavigatingLink &&
          !selectorResult.opensNewTab
        ) {
          await waitForTabLoad(tabId);
        }

        return selectorResult.ok
          ? `Clicked selector: ${info.selector.trim()}`
          : `Click failed: ${selectorResult.reason}`;
      }

      const regexText =
        typeof action.commandInfo === "string"
          ? action.commandInfo
          : ensureString(info.regex);

      if (!regexText) return "Click failed: selector or regex is missing.";

      const regexResult = await runClickByRegex(tabId, regexText);
      return regexResult.ok
        ? `Clicked: ${regexResult.match}`
        : `Click failed: ${regexResult.reason}`;
    }

    if (action.command === "type") {
      const selector = ensureString(info.selector).trim();
      if (!selector) return "Type failed: selector is missing.";

      const text = ensureString(info.text);
      const typeResult = await runTypeBySelector(
        tabId,
        selector,
        text,
        Boolean(info.pressEnter),
      );
      return typeResult.ok
        ? `Typed into selector: ${selector}`
        : `Type failed: ${typeResult.reason}`;
    }

    if (action.command === "scroll") {
      const direction =
        ensureString(info.direction).toLowerCase() === "up" ? "up" : "down";
      const amount = Number(info.amount) || 600;
      const result = await runDirectionalScroll(tabId, direction, amount);
      return result.ok
        ? `Scrolled ${direction} by ${amount}px`
        : `Scroll failed: ${result.reason}`;
    }

    if (action.command === "go_back") {
      await chrome.tabs.goBack(tabId);
      return "Went back in current tab.";
    }

    if (action.command === "go_forward") {
      await chrome.tabs.goForward(tabId);
      return "Went forward in current tab.";
    }

    if (action.command === "refresh") {
      await chrome.tabs.reload(tabId);
      return "Refreshed current tab.";
    }

    if (action.command === "close_tab") {
      await chrome.tabs.remove(tabId);
      return "Closed current tab.";
    }

    if (action.command === "switch_tab") {
      const index = Number(info.index);
      if (!Number.isInteger(index) || index < 0) {
        return "Switch tab failed: index must be a non-negative integer.";
      }

      const tabs = await chrome.tabs.query({ currentWindow: true });
      const target = tabs.find((tab) => tab.index === index);
      if (!target || typeof target.id !== "number") {
        return `Switch tab failed: no tab at index ${index}.`;
      }

      await chrome.tabs.update(target.id, { active: true });
      return `Switched to tab index ${index}.`;
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

      await new Promise((resolve) => setTimeout(resolve, millis));
      return `Waited ${Math.round(millis)}ms.`;
    }

    if (action.command === "scroll_to_word") {
      const regexText =
        typeof action.commandInfo === "string"
          ? action.commandInfo
          : ensureString(info.regex);

      if (!parseRegex(regexText)) {
        return "Scroll failed: regex is missing or invalid.";
      }

      const result = await runScrollToWord(tabId, regexText);
      return result.ok
        ? `Scrolled to match: ${result.match}`
        : `Scroll failed: ${result.reason}`;
    }

    if (action.command === "error") {
      return `Tool error: ${JSON.stringify(action.commandInfo ?? {})}`;
    }

    return `Unsupported tool action: ${action.command}`;
  }

  globalScope.BropilotTools = {
    executeAction,
  };
})(self);
