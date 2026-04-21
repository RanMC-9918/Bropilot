(function () {
  "use strict";

  const micBtn = document.getElementById("micBtn");
  const sendBtn = document.getElementById("sendBtn");
  const statusEl = document.getElementById("status");
  const chatBox = document.getElementById("chatBox");
  const messageInput = document.getElementById("messageInput");
  const clearBtn = document.getElementById("clearBtn");

  const DICTATION_IDLE_MS = 5000;

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const hasSpeech = Boolean(SpeechRecognition);
  const recognition = hasSpeech ? new SpeechRecognition() : null;

  if (recognition) {
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
  }

  let isListening = false;
  let dictationIdleTimer = null;

  async function requestMicrophoneAccess() {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    };

    if (
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function"
    ) {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((track) => track.stop());
      return true;
    }

    const legacyGetUserMedia =
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia;

    if (!legacyGetUserMedia) {
      throw new Error("This browser does not support microphone capture APIs.");
    }

    await new Promise((resolve, reject) => {
      legacyGetUserMedia.call(navigator, constraints, resolve, reject);
    });

    return true;
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

  function formatMarkdown(text) {
    if (typeof text !== "string") return "";
    let lines = text.replace(/</g, "&lt;").replace(/>/g, "&gt;").split('\n');
    let htmlLines = lines.map(line => {
      line = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      line = line.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');

      if (line.match(/^\s*###\s+(.*)/)) {
        return line.replace(/^\s*###\s+(.*)/, '<div style="font-weight: 700; font-size: 14.5px; margin-top: 8px; margin-bottom: 2px;">$1</div>');
      } else if (line.match(/^\s*##\s+(.*)/)) {
        return line.replace(/^\s*##\s+(.*)/, '<div style="font-weight: 700; font-size: 15.5px; margin-top: 8px; margin-bottom: 2px;">$1</div>');
      } else if (line.match(/^\s*#\s+(.*)/)) {
        return line.replace(/^\s*#\s+(.*)/, '<div style="font-weight: 800; font-size: 16.5px; margin-top: 8px; margin-bottom: 2px;">$1</div>');
      } else if (line.match(/^\s*[\*\-]\s+(.*)/)) {
        return line.replace(/^\s*[\*\-]\s+(.*)/, '<div style="display: list-item; list-style-type: disc; margin-left: 20px; line-height: 1.4;">$1</div>');
      } else {
        return line + '<br>';
      }
    });

    return htmlLines.join('').replace(/(<br>)*$/, "");
  }

  function renderHistory(history) {
    chatBox.innerHTML = "";

    let currentSystemGroup = null;

    const flattenedHistory = [];
    history.forEach((item) => {
      if (item.role === "bot" && typeof item.text === "string" && item.text.includes("'type': 'thinking'")) {
        const parts = item.text.split(/\}\s*,\s*\{/);
        parts.forEach((p) => {
          if (p.includes("'thinking':")) {
            let txt = p.replace(/^\[?\{?\s*'type'\s*:\s*'thinking'\s*,\s*'thinking'\s*:\s*['"]/, "");
            txt = txt.replace(/['"]\s*\}?\]?$/, "");
            txt = txt.replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"');
            flattenedHistory.push({ role: "system", text: txt });
          } else if (p.includes("'text':")) {
            let txt = p.replace(/^\[?\{?\s*'type'\s*:\s*'text'\s*,\s*'text'\s*:\s*['"]/, "");
            txt = txt.replace(/['"]\s*\}?\]?$/, "");
            txt = txt.replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"');
            flattenedHistory.push({ role: "bot", text: txt });
          }
        });
      } else {
        flattenedHistory.push(item);
      }
    });

    flattenedHistory.forEach((item) => {
      let isSystem = item.role === "system";
      
      if (isSystem) {
        if (!currentSystemGroup) {
          currentSystemGroup = document.createElement("details");
          currentSystemGroup.className = "message system";
          
          const summary = document.createElement("summary");
          summary.textContent = "Thinking...";
          summary.style.cursor = "pointer";
          summary.style.fontWeight = "600";
          summary.style.userSelect = "none";
          
          const innerContainer = document.createElement("div");
          innerContainer.style.marginTop = "6px";
          innerContainer.style.display = "flex";
          innerContainer.style.flexDirection = "column";
          innerContainer.style.gap = "4px";
          
          currentSystemGroup.appendChild(summary);
          currentSystemGroup.appendChild(innerContainer);
          chatBox.appendChild(currentSystemGroup);
        }
        
        const node = document.createElement("div");
        node.style.opacity = "0.85";
        node.style.whiteSpace = "normal";
        node.innerHTML = formatMarkdown(item.text);
        
        currentSystemGroup.lastElementChild.appendChild(node);
      } else {
        currentSystemGroup = null;
        
        const node = document.createElement("div");
        node.className = `message ${toMessageClass(item.role)}`;
        node.style.whiteSpace = "normal";

        if (item.role === "tool") {
          const lineCount = (item.text.match(/\n/g) || []).length + 1;
          if (lineCount > 10 || item.text.length > 500) {
            const contentDiv = document.createElement("div");
            contentDiv.style.overflow = "hidden";
            contentDiv.style.display = "-webkit-box";
            contentDiv.style.webkitLineClamp = "10";
            contentDiv.style.webkitBoxOrient = "vertical";
            contentDiv.innerHTML = formatMarkdown(item.text);

            const expandBtn = document.createElement("button");
            expandBtn.textContent = "Show More";
            expandBtn.style.marginTop = "6px";
            expandBtn.style.background = "rgba(0, 0, 0, 0.15)";
            expandBtn.style.border = "1px solid rgba(255, 255, 255, 0.2)";
            expandBtn.style.color = "inherit";
            expandBtn.style.borderRadius = "6px";
            expandBtn.style.padding = "3px 8px";
            expandBtn.style.cursor = "pointer";
            expandBtn.style.fontSize = "11px";
            expandBtn.style.fontWeight = "500";
            expandBtn.style.transition = "background 0.2s";
            
            expandBtn.onmouseover = () => expandBtn.style.background = "rgba(0, 0, 0, 0.3)";
            expandBtn.onmouseout = () => expandBtn.style.background = "rgba(0, 0, 0, 0.15)";

            let isExpanded = false;
            expandBtn.onclick = () => {
              isExpanded = !isExpanded;
              if (isExpanded) {
                contentDiv.style.webkitLineClamp = "unset";
                expandBtn.textContent = "Show Less";
              } else {
                contentDiv.style.webkitLineClamp = "10";
                expandBtn.textContent = "Show More";
              }
            };

            node.appendChild(contentDiv);
            node.appendChild(expandBtn);
          } else {
            node.innerHTML = formatMarkdown(item.text);
          }
        } else {
          node.innerHTML = formatMarkdown(item.text);
        }

        chatBox.appendChild(node);
      }
    });

    chatBox.scrollTop = chatBox.scrollHeight;
  }

  async function loadState() {
    const data = await chrome.storage.local.get([
      "chatHistory",
      "pendingRequest",
    ]);
    const history = Array.isArray(data.chatHistory) ? data.chatHistory : [];
    const pending = data.pendingRequest || null;

    renderHistory(history);

    if (pending) {
      setStatus("Assistant is working in background...");
      sendBtn.disabled = true;
    } else {
      setStatus(
        isListening ? "Dictating... auto-send after 5s silence" : "Ready",
      );
      sendBtn.disabled = false;
    }

    if (!history.length) {
      setStatus("Ready");
    }
  }

  async function getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id;
  }

  function resetDictationIdleTimer() {
    clearTimeout(dictationIdleTimer);
    dictationIdleTimer = setTimeout(() => {
      if (!isListening) return;
      const text = messageInput.value.trim();
      if (!text) return;
      stopListening();
      sendCurrentMessage("dictation");
    }, DICTATION_IDLE_MS);
  }

  async function sendCurrentMessage(source) {
    const text = messageInput.value.trim();
    if (!text) return;

    const tabId = await getActiveTabId();
    if (!tabId) {
      setStatus("No active tab found.");
      return;
    }

    messageInput.value = "";
    setStatus(
      source === "dictation" ? "Sending dictated message..." : "Sending...",
    );

    try {
      await chrome.runtime.sendMessage({
        type: "process_message",
        requestId: `${Date.now()}`,
        text,
        source,
        tabId,
      });
      setStatus("Assistant is working in background...");
      sendBtn.disabled = true;
      await loadState();
    } catch (error) {
      setStatus(`Failed to start request: ${error.message}`);
    }
  }

  async function startListening() {
    if (!recognition) return;

    try {
      setStatus("Requesting microphone access...");
      await requestMicrophoneAccess();
    } catch (err) {
      const message = String(err?.message || err || "").toLowerCase();
      const blocked =
        message.includes("permission") ||
        message.includes("denied") ||
        message.includes("notallowed") ||
        message.includes("not allowed");

      if (blocked) {
        setStatus("Mic prompt blocked here. Opening permission page...");
        try {
          chrome.runtime.openOptionsPage();
        } catch (_) {
          chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
        }
      } else {
        setStatus("Microphone is unavailable on this browser/device.");
      }
      return;
    }

    try {
      recognition.start();
    } catch (_e) {
      return;
    }

    isListening = true;
    micBtn.classList.add("active");
    micBtn.setAttribute("aria-label", "Stop dictation");
    micBtn.textContent = "Listening...";
    setStatus("Dictating... auto-send after 5s silence");
    resetDictationIdleTimer();
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

  micBtn.addEventListener("click", () => {
    if (!hasSpeech) return;
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

  sendBtn.addEventListener("click", () => {
    sendCurrentMessage("typed");
  });

  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage("typed");
    }
  });

  clearBtn.addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "clear_history" });
      await loadState();
      messageInput.value = "";
      setStatus("Chat cleared");
    } catch (error) {
      setStatus(`Failed to clear chat: ${error.message}`);
    }
  });

  if (recognition) {
    recognition.addEventListener("result", (event) => {
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript.trim();
        if (!transcript) continue;

        if (event.results[i].isFinal) {
          messageInput.value = `${messageInput.value} ${transcript}`.trim();
          resetDictationIdleTimer();
        } else {
          interim += `${transcript} `;
        }
      }

      if (interim.trim()) {
        setStatus(`Dictating: ${interim.trim()}`);
        resetDictationIdleTimer();
      }
    });

    recognition.addEventListener("error", (event) => {
      if (event.error === "aborted") return;
      const messages = {
        "not-allowed":
          "Microphone access denied. Please allow microphone permission.",
        "no-speech": "No speech detected. Keep speaking.",
        network: "Network error. Check your connection.",
      };
      stopListening();
      setStatus(messages[event.error] || `Error: ${event.error}`);
    });

    recognition.addEventListener("end", () => {
      if (!isListening) return;
      try {
        recognition.start();
      } catch (_e) {}
    });
  } else {
    micBtn.disabled = true;
    setStatus("Dictation unavailable in this browser. Typing still works.");
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.chatHistory || changes.pendingRequest) {
      loadState();
    }
  });

  const bubbleContainer = document.getElementById("bubble-background");

  if (bubbleContainer) {
    for (let i = 0; i < 20; i++) {
      const bubble = document.createElement("div");
      bubble.classList.add("bubble");

      const size = Math.random() * 40 + 10;

      bubble.style.width = `${size}px`;
      bubble.style.height = `${size}px`;
      bubble.style.left = `${Math.random() * 100}%`;
      bubble.style.animationDuration = `${Math.random() * 8 + 4}s`;
      bubble.style.opacity = Math.random() * 0.5 + 0.2;
    }
  }

  // Interactive trailing gradients
  const gradientsContainer = document.querySelector(".gradients-container");
  if (gradientsContainer) {
      const interactive1 = document.createElement("div");
      interactive1.classList.add("interactive", "i1");
      
      const interactive2 = document.createElement("div");
      interactive2.classList.add("interactive", "i2");

      const interactive3 = document.createElement("div");
      interactive3.classList.add("interactive", "i3");

      gradientsContainer.appendChild(interactive1);
      gradientsContainer.appendChild(interactive2);
      gradientsContainer.appendChild(interactive3);
      
      let tgX = window.innerWidth ? window.innerWidth / 2 : 200;
      let tgY = window.innerHeight ? window.innerHeight / 2 : 280;

      let curX1 = tgX, curY1 = tgY;
      let curX2 = tgX, curY2 = tgY;
      let curX3 = tgX, curY3 = tgY;

      let lastMoveTime = Date.now();
      let pulseAmp = 0;
      let pulsePhase = 0;

      function animateInteractive() {
          const now = Date.now();
          const idleTime = now - lastMoveTime;
          
          if (idleTime > 300) {
              pulseAmp += (0.35 - pulseAmp) * 0.02;
          } else {
              pulseAmp += (0 - pulseAmp) * 0.1;
          }
          
          pulsePhase += 0.015;

          curX1 += (tgX - curX1) / 20;
          curY1 += (tgY - curY1) / 20;

          curX2 += (tgX - curX2) / 35;
          curY2 += (tgY - curY2) / 35;

          curX3 += (tgX - curX3) / 50;
          curY3 += (tgY - curY3) / 50;

          const scale1 = 1 + pulseAmp * Math.sin(pulsePhase);
          const scale2 = 1 + pulseAmp * Math.sin(pulsePhase + Math.PI / 2);
          const scale3 = 1 + pulseAmp * Math.sin(pulsePhase + Math.PI);

          interactive1.style.transform = `translate(${Math.round(curX1)}px, ${Math.round(curY1)}px) scale(${scale1})`;
          interactive2.style.transform = `translate(${Math.round(curX2)}px, ${Math.round(curY2)}px) scale(${scale2})`;
          interactive3.style.transform = `translate(${Math.round(curX3)}px, ${Math.round(curY3)}px) scale(${scale3})`;

          requestAnimationFrame(animateInteractive);
      }

      window.addEventListener("mousemove", (event) => {
          tgX = event.clientX;
          tgY = event.clientY;
          lastMoveTime = Date.now();
      });

      animateInteractive();
  }

  loadState();
})();