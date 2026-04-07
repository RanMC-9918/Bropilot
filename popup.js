(function () {
  "use strict";

  const micBtn = document.getElementById("micBtn");
  const statusEl = document.getElementById("status");
  const interimEl = document.getElementById("interim");
  const finalEl = document.getElementById("final");
  const clearBtn = document.getElementById("clearBtn");

  const urlParams = new URLSearchParams(window.location.search);
  const isRequestingMic = urlParams.get("request_mic") === "1";

  if (isRequestingMic) {
    statusEl.textContent = "Click icon to grant mic access";
  }

  // Check for browser support
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    statusEl.textContent = "Speech recognition is not supported in this browser.";
    micBtn.disabled = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  let isListening = false;
  let finalTranscript = [];

  async function startListening() {
    try {
      const perm = await navigator.permissions.query({ name: 'microphone' });
      if (perm.state !== 'granted') {
        if (isRequestingMic) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            statusEl.textContent = "Access granted! You can close this tab.";
            statusEl.style.color = "#99f0ff";
            micBtn.style.display = "none";
          } catch (e) {
            statusEl.textContent = "Access denied. Please check site settings.";
          }
          return;
        } else {
          statusEl.textContent = "Opening tab for mic access...";
          chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?request_mic=1") });
          return;
        }
      }
    } catch (err) {
      if (isRequestingMic) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
          statusEl.textContent = "Access granted! You can close this tab.";
          statusEl.style.color = "#99f0ff";
          micBtn.style.display = "none";
        } catch (e) {
          statusEl.textContent = "Access denied. Please check site settings.";
        }
        return;
      } else {
        statusEl.textContent = "Opening tab for mic access...";
        chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?request_mic=1") });
        return;
      }
    }

    try {
      recognition.start();
    } catch (e) {
      // Ignore if already started
    }
    isListening = true;
    micBtn.classList.add("active");
    micBtn.setAttribute("aria-label", "Stop microphone");
    statusEl.textContent = "Listening…";
  }

  function stopListening() {
    recognition.stop();
    isListening = false;
    micBtn.classList.remove("active");
    micBtn.setAttribute("aria-label", "Start microphone");
    statusEl.textContent = "Microphone off";
    interimEl.textContent = "";
  }

  micBtn.addEventListener("click", function () {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

  clearBtn.addEventListener("click", function () {
    finalTranscript = [];
    finalEl.textContent = "";
    interimEl.textContent = "";
  });

  recognition.addEventListener("result", function (event) {
    let interimTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript.push(transcript);
        handleResult(finalTranscript[finalTranscript.length - 1]);
      } else {
        interimTranscript += transcript;
      }
    }

    finalEl.textContent = finalTranscript.join("\n");
    interimEl.textContent = interimTranscript;
    
    // Auto-scroll to the bottom of the transcript box
    const box = document.querySelector(".transcript-box");
    box.scrollTop = box.scrollHeight;
    
  });

  function command(c, x, func){
    while(x.indexOf(c) != -1){
      x = x.substring(x.indexOf+c.length+1);
    }
    func(x);
  }

  function handleResult(result){
    let firstPart = result;
    
     switch(firstPart){
       case "alert":
         command("alert", result, alert);
         break;
      case "alerts":
         command("alert", result, alert);
         break;
       default:
         break;
     }
  }

  recognition.addEventListener("error", function (event) {
    if (event.error === "aborted") return;
    const messages = {
      "not-allowed": "Microphone access denied. Please allow microphone permission.",
      "no-speech": "No speech detected. Try again.",
      network: "Network error. Check your connection.",
    };
    const msg = messages[event.error] || "Error: " + event.error;
    stopListening();
    statusEl.textContent = msg;
  });

  recognition.addEventListener("end", function () {
    // If the user didn't manually stop, restart to keep continuous mode alive
    if (isListening) {
      try {
        recognition.start();
      } catch (e) {
        // Recognition may not be ready to restart yet; ignore and wait for next end event
      }
    }
  });
})();
