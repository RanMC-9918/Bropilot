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

  function countListLines(text) {
    const value = String(text || "").trim();
    if (!value) return 0;
    return value.split(/\n+/).filter(Boolean).length;
  }

  function inferErrorCode(text) {
    const lowered = String(text || "").toLowerCase();
    if (lowered.includes("missing") || lowered.includes("invalid")) return "invalid_args";
    if (lowered.includes("not editable")) return "not_editable";
    if (lowered.includes("unsupported")) return "unsupported_action";
    if (lowered.includes("no matching") || lowered.includes("no element") || lowered.includes("no tab at index")) {
      return "not_found";
    }
    if (lowered.includes("tool error") || lowered.includes("error:")) return "execution_error";
    return null;
  }

  function inferStructuredOutcome(action, resultText) {
    const command = action && typeof action.command === "string" ? action.command : "unknown";
    const text = String(resultText || "");
    const lowered = text.toLowerCase();
    const errorCode = inferErrorCode(text);
    const isFailure =
      command === "error" ||
      lowered.includes(" failed") ||
      lowered.startsWith("failed") ||
      lowered.includes("tool error") ||
      lowered.includes("unsupported tool action") ||
      lowered.includes("error:");

    let elementCount = null;
    if (command === "get_page_clickables" || command === "get_page_links" || command === "get_page_inputs") {
      const body = text.includes("\n") ? text.split("\n").slice(1).join("\n") : "";
      elementCount = countListLines(body);
    }

    const elementActionCommands = [
      "click_",
      "type_",
      "scroll_",
      "hover_",
      "double_click_",
      "right_click_",
      "drag_and_drop_",
    ];
    const elementFound =
      elementActionCommands.some((prefix) => command.startsWith(prefix))
        ? !isFailure
        : null;

    return {
      success: !isFailure,
      error_code: isFailure ? errorCode || "execution_error" : null,
      error_message: isFailure ? text : null,
      element_found: elementFound,
      element_count: elementCount,
      diagnostics: {
        command,
        inferred: true,
      },
    };
  }

  function prefersCdpMouse(info) {
    const mode = String((info && info.mouseMode) || "auto").toLowerCase();
    return mode === "cdp";
  }

  function debuggerTarget(tabId) {
    return { tabId };
  }

  function cdpAttach(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(debuggerTarget(tabId), "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(`CDP attach failed: ${chrome.runtime.lastError.message}`));
          return;
        }
        resolve(true);
      });
    });
  }

  function cdpDetach(tabId) {
    return new Promise((resolve) => {
      chrome.debugger.detach(debuggerTarget(tabId), () => resolve(true));
    });
  }

  function cdpCommand(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(debuggerTarget(tabId), method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`CDP ${method} failed: ${chrome.runtime.lastError.message}`));
          return;
        }
        resolve(result || {});
      });
    });
  }

  async function withCdpSession(tabId, fn) {
    await cdpAttach(tabId);
    try {
      return await fn();
    } finally {
      await cdpDetach(tabId);
    }
  }

  async function getElementCenter(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cssSelector) => {
        const target = document.querySelector(cssSelector);
        if (!target) return { ok: false, reason: "No element matched selector." };
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        const rect = target.getBoundingClientRect();
        return {
          ok: true,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      },
      args: [selector],
    });
    return result || { ok: false, reason: "Unable to resolve element center." };
  }

  async function cdpMove(tabId, x, y) {
    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
  }

  async function cdpClick(tabId, x, y, button = "left", clickCount = 1) {
    await cdpMove(tabId, x, y);
    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
    });
    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
    });
  }

  async function cdpDrag(tabId, source, target) {
    await cdpMove(tabId, source.x, source.y);
    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: source.x,
      y: source.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });

    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(source.x + ((target.x - source.x) * i) / steps);
      const y = Math.round(source.y + ((target.y - source.y) * i) / steps);
      await cdpCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
      });
    }

    await cdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
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
        // ... (existing runScrollToWord logic)
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
            try { return new RegExp(slash[1], slash[2] || "i"); } catch (_err) { return null; }
          }
          try { return new RegExp(s, "i"); } catch (_err) { return null; }
        };

        const regex = parseInPageRegex(rawRegex);
        if (!regex) return { ok: false, reason: "Invalid regex." };

        document
          .querySelectorAll(`.${HIGHLIGHT_ID}`)
          .forEach((el) => el.classList.remove(HIGHLIGHT_ID));

        const candidates = Array.from(document.body.querySelectorAll("*")).reverse();
        for (const el of candidates) {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") continue;
          const matchAttr = [el.innerText, el.value, el.placeholder, el.getAttribute("aria-label"), el.title, el.id, el.name, el.getAttribute("href"), el.getAttribute("alt")].some(v => v && regex.test(v));
          if (matchAttr) {
            el.classList.add(HIGHLIGHT_ID);
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            return { ok: true, match: (el.innerText||el.placeholder||el.value||el.id||"").slice(0, 120) };
          }
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
            try { return new RegExp(slash[1], slash[2] || "i"); } catch (_err) { return null; }
          }
          try { return new RegExp(s, "i"); } catch (_err) { return null; }
        };

        const regex = parseInPageRegex(rawRegex);
        if (!regex) return { ok: false, reason: "Invalid regex." };

        document
          .querySelectorAll(`.${HIGHLIGHT_ID}`)
          .forEach((el) => el.classList.remove(HIGHLIGHT_ID));

        const clickablesSelector = "a, button, input[type='button'], input[type='submit'], input[type='reset'], input[type='image'], [role='button'], [role='link'], [role='checkbox'], [role='menuitem'], [role='tab'], [role='option'], [role='switch'], [role='radio'], [tabindex='0'], li, summary";
        const candidates = Array.from(document.body.querySelectorAll(clickablesSelector));
        for (const el of candidates) {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") continue;
          const matchAttr = [el.innerText, el.value, el.placeholder].some(v => v && regex.test(v));
          if (matchAttr) {
            el.classList.add(HIGHLIGHT_ID);
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.click();
            return { ok: true, match: (el.innerText||el.placeholder||el.value||el.id||"").slice(0, 120) };
          }
        }

        return { ok: false, reason: "No matching clickable element found." };
      },
      args: [regexText],
    });

    return result || { ok: false, reason: "Unknown click error." };
  }

  async function runTypeByRegex(tabId, regexText, textToType, pressEnter) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (rawRegex, valueToType, shouldPressEnter) => {
        const HIGHLIGHT_ID = "bropilot-type-highlight";
        const parseInPageRegex = (input) => {
          const s = String(input || "").trim();
          if (!s) return null;
          const slash = s.match(/^\/(.*)\/([a-z]*)$/i);
          if (slash) {
            try { return new RegExp(slash[1], slash[2] || "i"); } catch (_err) { return null; }
          }
          try { return new RegExp(s, "i"); } catch (_err) { return null; }
        };

        const regex = parseInPageRegex(rawRegex);
        if (!regex) return { ok: false, reason: "Invalid regex." };

        const candidates = Array.from(document.body.querySelectorAll("*")).reverse();
        let target = null;
        for (const el of candidates) {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") continue;
          const matchAttr = [el.innerText, el.value, el.placeholder, el.getAttribute("aria-label"), el.title, el.id, el.name, el.getAttribute("href"), el.getAttribute("alt")].some(v => v && regex.test(v));
          if (matchAttr) {
            if (el.tagName === 'INPUT' && el.type !== 'hidden' && el.type !== 'button' && el.type !== 'submit') target = el;
            else if (el.tagName === 'TEXTAREA' || el.hasAttribute('contenteditable')) target = el;
            else if (el.tagName === 'SELECT') target = el;
            else if (el.tagName === "LABEL" && el.control) target = el.control;
            else {
               const inputInside = el.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"], select');
               if (inputInside) target = inputInside;
            }
            if (target) break;
          }
        }

        if (!target) {
            return { ok: false, reason: "No matching input element found." };
        }

        target.scrollIntoView({ behavior: "smooth", block: "center" });
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
            key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
          });
          const keyUp = new KeyboardEvent("keyup", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
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

        return { ok: true, match: target.name || target.placeholder || target.id || "input" };
      },
      args: [regexText, textToType, pressEnter],
    });

    return result || { ok: false, reason: "Unknown type error." };
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
            // ... (keep enter dispatch logic the same)
          const keyDown = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, });
          const keyUp = new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, });

          target.dispatchEvent(keyDown);
          target.dispatchEvent(keyUp);

          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            const form = target.form;
            if (form) {
              if (typeof form.requestSubmit === "function") { form.requestSubmit(); } else { form.submit(); }
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

  async function runHoverBySelector(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cssSelector) => {
        const target = document.querySelector(cssSelector);
        if (!target) return { ok: false, reason: "No element matched selector." };
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      },
      args: [selector],
    });
    return result || { ok: false, reason: "Unknown hover error." };
  }

  async function runDoubleClickBySelector(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cssSelector) => {
        const target = document.querySelector(cssSelector);
        if (!target) return { ok: false, reason: "No element matched selector." };
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
        return { ok: true };
      },
      args: [selector],
    });
    return result || { ok: false, reason: "Unknown double-click error." };
  }

  async function runRightClickBySelector(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cssSelector) => {
        const target = document.querySelector(cssSelector);
        if (!target) return { ok: false, reason: "No element matched selector." };
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        const evt = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          buttons: 2,
        });
        target.dispatchEvent(evt);
        return { ok: true };
      },
      args: [selector],
    });
    return result || { ok: false, reason: "Unknown right-click error." };
  }

  async function runClickAtCoordinates(tabId, x, y) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (xPos, yPos) => {
        const xCoord = Number(xPos);
        const yCoord = Number(yPos);
        if (!Number.isFinite(xCoord) || !Number.isFinite(yCoord)) {
          return { ok: false, reason: "Invalid coordinates." };
        }

        const el = document.elementFromPoint(xCoord, yCoord);
        if (!el) return { ok: false, reason: "No element at coordinates." };

        const mouseDown = new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: xCoord,
          clientY: yCoord,
          button: 0,
          buttons: 1,
        });
        const mouseUp = new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: xCoord,
          clientY: yCoord,
          button: 0,
          buttons: 0,
        });
        const clickEvt = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: xCoord,
          clientY: yCoord,
          button: 0,
          buttons: 0,
        });

        el.dispatchEvent(mouseDown);
        el.dispatchEvent(mouseUp);
        el.dispatchEvent(clickEvt);
        return { ok: true, tag: el.tagName.toLowerCase() };
      },
      args: [x, y],
    });
    return result || { ok: false, reason: "Unknown coordinate click error." };
  }

  async function runDragAndDropBySelector(tabId, sourceSelector, targetSelector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (fromSelector, toSelector) => {
        const source = document.querySelector(fromSelector);
        const target = document.querySelector(toSelector);
        if (!source) return { ok: false, reason: "No source element matched selector." };
        if (!target) return { ok: false, reason: "No target element matched selector." };

        source.scrollIntoView({ behavior: "smooth", block: "center" });
        target.scrollIntoView({ behavior: "smooth", block: "center" });

        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
        source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));

        return { ok: true };
      },
      args: [sourceSelector, targetSelector],
    });
    return result || { ok: false, reason: "Unknown drag-drop error." };
  }

  async function runScrollElementToCenter(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cssSelector) => {
        const target = document.querySelector(cssSelector);
        if (!target) return { ok: false, reason: "No element matched selector." };
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        return { ok: true };
      },
      args: [selector],
    });
    return result || { ok: false, reason: "Unknown scroll-to-center error." };
  }

  async function runCdpHoverBySelector(tabId, selector) {
    const center = await getElementCenter(tabId, selector);
    if (!center.ok) return center;
    await withCdpSession(tabId, async () => {
      await cdpMove(tabId, center.x, center.y);
    });
    return { ok: true };
  }

  async function runCdpDoubleClickBySelector(tabId, selector) {
    const center = await getElementCenter(tabId, selector);
    if (!center.ok) return center;
    await withCdpSession(tabId, async () => {
      await cdpClick(tabId, center.x, center.y, "left", 2);
    });
    return { ok: true };
  }

  async function runCdpRightClickBySelector(tabId, selector) {
    const center = await getElementCenter(tabId, selector);
    if (!center.ok) return center;
    await withCdpSession(tabId, async () => {
      await cdpClick(tabId, center.x, center.y, "right", 1);
    });
    return { ok: true };
  }

  async function runCdpClickAtCoordinates(tabId, x, y) {
    await withCdpSession(tabId, async () => {
      await cdpClick(tabId, x, y, "left", 1);
    });
    return { ok: true };
  }

  async function runCdpDragAndDropBySelector(tabId, sourceSelector, targetSelector) {
    const source = await getElementCenter(tabId, sourceSelector);
    if (!source.ok) return { ok: false, reason: `Source failed: ${source.reason}` };
    const target = await getElementCenter(tabId, targetSelector);
    if (!target.ok) return { ok: false, reason: `Target failed: ${target.reason}` };

    await withCdpSession(tabId, async () => {
      await cdpDrag(tabId, source, target);
    });
    return { ok: true };
  }

  async function runGetPageElements(tabId, type) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (elementType) => {
        const getDeepText = (el) => {
            let text = (el.innerText || "").trim();
            if (!text) {
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
                let node;
                while ((node = walker.nextNode())) {
                    if (node.tagName === 'IMG' && node.alt) text += " " + node.alt;
                    if (node.title) text += " " + node.title;
                }
            }
            if (!text) text = (el.textContent || "").trim();
            return text.replace(/\\s+/g, ' ').trim();
        };

        let els = [];
        if (elementType === "content") {
            const text = (document.body.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
            return { ok: true, data: text.slice(0, 10000) };
        } else if (elementType === "clickables") {
            const candidates = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button']"));
            els = candidates.map(el => {
                const text = getDeepText(el);
                let info = `[${el.tagName.toLowerCase()}] `;
                if (el.id) info += `#${el.id} `;
                if (text) info += `text='${text}' `;
                if (el.value) info += `value='${el.value}' `;
                if (el.placeholder) info += `placeholder='${el.placeholder}' `;
                const aria = el.getAttribute('aria-label');
                if (aria) info += `aria-label='${aria}' `;
                return info.trim();
            }).filter(Boolean);
            return { ok: true, data: els.slice(0, 100).join("\\n").slice(0, 5000) };
        } else if (elementType === "links") {
            const candidates = Array.from(document.querySelectorAll("a[href]"));
            els = candidates.map(el => {
                const text = (el.innerText || "").replace(/\s+/g, ' ').trim();
                let info = `[link] `;
                if (text) info += `text='${text}' `;
                if (el.href) info += `href='${el.href.slice(0, 50)}'`;
                return info.trim();
            }).filter(Boolean);
            return { ok: true, data: els.slice(0, 100).join("\\n").slice(0,5000) };
        } else if (elementType === "inputs") {
            const candidates = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, select"));
            els = candidates.map(el => {
                const labels = el.labels ? Array.from(el.labels).map(l => getDeepText(l)).join(" ") : "";
                let info = `[${el.tagName.toLowerCase()}] `;
                if (el.type) info += `type='${el.type}' `;
                if (el.name) info += `name='${el.name}' `;
                if (el.id) info += `id='${el.id}' `;
                if (el.placeholder) info += `placeholder='${el.placeholder}' `;
                if (labels) info += `label='${labels}' `;
                const aria = el.getAttribute('aria-label');
                if (aria) info += `aria-label='${aria}' `;
                return info.trim();
            }).filter(Boolean);
            return { ok: true, data: els.slice(0, 100).join("\\n").slice(0, 5000) };
        }
        return { ok: false, reason: "Unknown element type." };
      },
      args: [type],
    });

    return result || { ok: false, reason: "Unknown get page elements error." };
  }

  async function runGetElementsBySelector(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        try {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length === 0) return "No elements matched selector.";
          return els.map(el => {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? ` id='${el.id}'` : "";
            const cls = el.className ? ` class='${el.className}'` : "";
            let text = "";
            if (el.innerText) {
                text = ` text='${el.innerText.trim().substring(0, 100).replace(/\\n/g, " ")}'`;
            }
            return `[${tag}]${id}${cls}${text}`;
          }).join("\\n");
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
      args: [selector],
    });
    return result;
  }

  async function runGetInteractiveElements(tabId, limit) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxItems) => {
        const max = Number.isFinite(Number(maxItems)) ? Math.max(1, Math.min(200, Number(maxItems))) : 50;
        const selector = "a[href], button, input:not([type='hidden']), textarea, select, [role='button'], [role='link'], [tabindex]";
        const elements = Array.from(document.querySelectorAll(selector));
        const visible = elements.filter((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        });

        const items = visible.slice(0, max).map((el) => {
          const rect = el.getBoundingClientRect();
          const role = el.getAttribute("role") || "";
          const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || "",
            role,
            name: el.getAttribute("name") || "",
            text,
            enabled: !(el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        });

        return { ok: true, count: items.length, items };
      },
      args: [limit],
    });

    return result || { ok: false, reason: "Unknown interactive inventory error." };
  }

  async function runFindBestElementMatch(tabId, query, limit) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (rawQuery, maxItems) => {
        const q = String(rawQuery || "").trim().toLowerCase();
        if (!q) return { ok: false, reason: "query is missing." };

        const max = Number.isFinite(Number(maxItems)) ? Math.max(1, Math.min(50, Number(maxItems))) : 5;
        const selector = "a[href], button, input:not([type='hidden']), textarea, select, [role='button'], [role='link'], [tabindex]";
        const elements = Array.from(document.querySelectorAll(selector));

        const tokens = q.split(/\s+/).filter(Boolean);
        const scored = elements
          .map((el) => {
            const haystack = [
              el.innerText,
              el.value,
              el.placeholder,
              el.getAttribute("aria-label"),
              el.id,
              el.getAttribute("name"),
              el.getAttribute("title"),
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();

            let score = 0;
            if (haystack.includes(q)) score += 10;
            for (const token of tokens) {
              if (haystack.includes(token)) score += 2;
            }

            if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") score += 1;
            if (score === 0) return null;

            const label = (el.innerText || el.value || el.placeholder || el.id || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120);

            return {
              score,
              tag: el.tagName.toLowerCase(),
              id: el.id || "",
              role: el.getAttribute("role") || "",
              text: label,
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)
          .slice(0, max);

        return { ok: true, query: q, count: scored.length, matches: scored };
      },
      args: [query, limit],
    });

    return result || { ok: false, reason: "Unknown best-match error." };
  }

  async function executeAction(tabId, action) {
    const info =
      action && typeof action.commandInfo === "object" && action.commandInfo
        ? action.commandInfo
        : {};

    if (action.command === "get_page_content") {
      const res = await runGetPageElements(tabId, "content");
      return res.ok ? `Page Content:\\n${res.data}` : res.reason;
    }
    if (action.command === "get_page_clickables") {
      const res = await runGetPageElements(tabId, "clickables");
      return res.ok ? `Clickables:\\n${res.data}` : res.reason;
    }
    if (action.command === "get_page_links") {
      const res = await runGetPageElements(tabId, "links");
      return res.ok ? `Links:\\n${res.data}` : res.reason;
    }
    if (action.command === "get_page_inputs") {
      const res = await runGetPageElements(tabId, "inputs");
      return res.ok ? `Inputs:\\n${res.data}` : res.reason;
    }

    if (action.command === "get_elements_by_selector") {
      const selector = ensureString(info.selector);
      if (!selector) return "Error: selector is missing.";
      const res = await runGetElementsBySelector(tabId, selector);
      return res || "Execution completed.";
    }

    if (action.command === "get_interactive_elements") {
      const limit = Number(info.limit) || 50;
      const res = await runGetInteractiveElements(tabId, limit);
      if (!res.ok) return `Interactive inventory failed: ${res.reason}`;
      return `Interactive Elements (${res.count}):\n${JSON.stringify(res.items)}`;
    }

    if (action.command === "find_best_element_match") {
      const query = ensureString(info.query).trim();
      if (!query) return "Find best match failed: query is missing.";
      const limit = Number(info.limit) || 5;
      const res = await runFindBestElementMatch(tabId, query, limit);
      if (!res.ok) return `Find best match failed: ${res.reason}`;
      return `Best Matches (${res.count}):\n${JSON.stringify(res.matches)}`;
    }


    if (action.command === "open_new_tab") {
      const url = ensureString(info.url) || "about:blank";
      await chrome.tabs.create({ url });
      return `Opened tab: ${url}`;
    }

    if (action.command === "create_new_tab") {
      const url = ensureString(info.url) || "about:blank";
      await chrome.tabs.create({ url, active: false });
      return `Created tab in background: ${url}`;
    }

    if (action.command === "change_url") {
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

    if (action.command === "click_element_with_css_selector") {
      const selector = ensureString(info.selector).trim();
      if (!selector) return "Click failed: selector is missing.";

      const selectorResult = await runClickBySelector(tabId, selector);
      if (selectorResult.ok && selectorResult.isNavigatingLink && !selectorResult.opensNewTab) {
        await waitForTabLoad(tabId);
      }
      return selectorResult.ok
        ? `Clicked selector: ${selector}`
        : `Click failed: ${selectorResult.reason}`;
    }

    if (action.command === "click_element_with_regexp") {
      const regexText = ensureString(info.regex);
      if (!regexText) return "Click failed: regex is missing.";

      const regexResult = await runClickByRegex(tabId, regexText);
      return regexResult.ok
        ? `Clicked: ${regexResult.match}`
        : `Click failed: ${regexResult.reason}`;
    }

    if (action.command === "type_with_css_selector") {
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

    if (action.command === "type_with_regexp") {
      const regex = ensureString(info.regex).trim();
      if (!regex) return "Type failed: regex is missing.";

      const text = ensureString(info.text);
      const typeResult = await runTypeByRegex(
        tabId,
        regex,
        text,
        Boolean(info.pressEnter),
      );
      return typeResult.ok
        ? `Typed into: ${typeResult.match}`
        : `Type failed: ${typeResult.reason}`;
    }

    if (action.command === "scroll_distance") {
      const direction = ensureString(info.direction).toLowerCase() === "up" ? "up" : "down";
      const amount = Number(info.amount) || 600;
      const result = await runDirectionalScroll(tabId, direction, amount);
      return result.ok
        ? `Scrolled ${direction} by ${amount}px`
        : `Scroll failed: ${result.reason}`;
    }

    if (action.command === "scroll_with_regexp") {
      const regexText = ensureString(info.regex);
      if (!parseRegex(regexText)) {
        return "Scroll failed: regex is missing or invalid.";
      }
      const result = await runScrollToWord(tabId, regexText);
      return result.ok
        ? `Scrolled to match: ${result.match}`
        : `Scroll failed: ${result.reason}`;
    }

    if (action.command === "hover_element_with_css_selector") {
      const selector = ensureString(info.selector).trim();
      if (!selector) return "Hover failed: selector is missing.";
      if (prefersCdpMouse(info)) {
        try {
          const cdpResult = await runCdpHoverBySelector(tabId, selector);
          if (cdpResult.ok) return `Hovered selector with CDP: ${selector}`;
        } catch (error) {
          const fallback = await runHoverBySelector(tabId, selector);
          return fallback.ok
            ? `Hovered selector: ${selector} (CDP fallback: ${ensureString(error?.message) || "failed"})`
            : `Hover failed: ${fallback.reason}`;
        }
      }
      const result = await runHoverBySelector(tabId, selector);
      return result.ok ? `Hovered selector: ${selector}` : `Hover failed: ${result.reason}`;
    }

    if (action.command === "double_click_element_with_css_selector") {
      const selector = ensureString(info.selector).trim();
      if (!selector) return "Double click failed: selector is missing.";
      if (prefersCdpMouse(info)) {
        try {
          const cdpResult = await runCdpDoubleClickBySelector(tabId, selector);
          if (cdpResult.ok) return `Double clicked selector with CDP: ${selector}`;
        } catch (error) {
          const fallback = await runDoubleClickBySelector(tabId, selector);
          return fallback.ok
            ? `Double clicked selector: ${selector} (CDP fallback: ${ensureString(error?.message) || "failed"})`
            : `Double click failed: ${fallback.reason}`;
        }
      }
      const result = await runDoubleClickBySelector(tabId, selector);
      return result.ok ? `Double clicked selector: ${selector}` : `Double click failed: ${result.reason}`;
    }

    if (action.command === "right_click_element_with_css_selector") {
      const selector = ensureString(info.selector).trim();
      if (!selector) return "Right click failed: selector is missing.";
      if (prefersCdpMouse(info)) {
        try {
          const cdpResult = await runCdpRightClickBySelector(tabId, selector);
          if (cdpResult.ok) return `Right clicked selector with CDP: ${selector}`;
        } catch (error) {
          const fallback = await runRightClickBySelector(tabId, selector);
          return fallback.ok
            ? `Right clicked selector: ${selector} (CDP fallback: ${ensureString(error?.message) || "failed"})`
            : `Right click failed: ${fallback.reason}`;
        }
      }
      const result = await runRightClickBySelector(tabId, selector);
      return result.ok ? `Right clicked selector: ${selector}` : `Right click failed: ${result.reason}`;
    }

    if (action.command === "click_at_coordinates") {
      const x = Number(info.x);
      const y = Number(info.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "Coordinate click failed: x and y are required.";
      let result;
      if (prefersCdpMouse(info)) {
        try {
          const cdpResult = await runCdpClickAtCoordinates(tabId, x, y);
          if (cdpResult.ok) {
            return `Clicked coordinates with CDP: (${Math.round(x)}, ${Math.round(y)})`;
          }
        } catch (error) {
          result = await runClickAtCoordinates(tabId, x, y);
          return result.ok
            ? `Clicked coordinates: (${Math.round(x)}, ${Math.round(y)}) (CDP fallback: ${ensureString(error?.message) || "failed"})`
            : `Coordinate click failed: ${result.reason}`;
        }
      }
      result = await runClickAtCoordinates(tabId, x, y);
      return result.ok ? `Clicked coordinates: (${Math.round(x)}, ${Math.round(y)})` : `Coordinate click failed: ${result.reason}`;
    }

    if (action.command === "drag_and_drop_with_css_selector") {
      const source = ensureString(info.sourceSelector).trim();
      const target = ensureString(info.targetSelector).trim();
      if (!source || !target) return "Drag and drop failed: sourceSelector and targetSelector are required.";
      if (prefersCdpMouse(info)) {
        try {
          const cdpResult = await runCdpDragAndDropBySelector(tabId, source, target);
          if (cdpResult.ok) return `Dragged with CDP from ${source} to ${target}`;
        } catch (error) {
          const fallback = await runDragAndDropBySelector(tabId, source, target);
          return fallback.ok
            ? `Dragged from ${source} to ${target} (CDP fallback: ${ensureString(error?.message) || "failed"})`
            : `Drag and drop failed: ${fallback.reason}`;
        }
      }
      const result = await runDragAndDropBySelector(tabId, source, target);
      return result.ok ? `Dragged from ${source} to ${target}` : `Drag and drop failed: ${result.reason}`;
    }

    if (action.command === "scroll_element_to_center") {
      const selector = ensureString(info.selector).trim();
      if (!selector) return "Scroll to center failed: selector is missing.";
      const result = await runScrollElementToCenter(tabId, selector);
      return result.ok ? `Scrolled selector to center: ${selector}` : `Scroll to center failed: ${result.reason}`;
    }

    if (action.command === "respond_to_user") {
        return `Responded: ${info.message}`;
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
        : Math.max(0, (Number.isFinite(secondsFromPayload) ? secondsFromPayload : 1) * 1000);

      await new Promise((resolve) => setTimeout(resolve, millis));
      return `Waited ${Math.round(millis)}ms.`;
    }

    if (action.command === "get_page_html") {
      const maxChars = Number(info.maxChars) || 60000;
      return `Requested page HTML context (max ${Math.max(1000, maxChars)} chars).`;
    }

    if (action.command === "error") {
      return `Tool error: ${JSON.stringify(action.commandInfo ?? {})}`;
    }

    return `Unsupported tool action: ${action.command}`;
  }

  async function executeActionDetailed(tabId, action) {
    const resultText = await executeAction(tabId, action);
    const inferred = inferStructuredOutcome(action, resultText);
    return {
      result_text: resultText,
      ...inferred,
      url_changed: null,
    };
  }

  globalScope.BropilotTools = {
    executeAction,
    executeActionDetailed,
  };
})(self);
