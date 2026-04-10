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

  function renderHistory(history) {
    chatBox.innerHTML = "";

    history.forEach((item) => {
      const node = document.createElement("div");
      node.className = `message ${toMessageClass(item.role)}`;
      node.textContent = item.text;
      chatBox.appendChild(node);
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
      } catch (_e) {
        // Ignore transient restart errors while dictation remains active.
      }
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

  loadState();
})();
