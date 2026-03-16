(function () {
  "use strict";

  const micBtn = document.getElementById("micBtn");
  const statusEl = document.getElementById("status");
  const interimEl = document.getElementById("interim");
  const finalEl = document.getElementById("final");
  const clearBtn = document.getElementById("clearBtn");

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

  function startListening() {
    recognition.start();
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
        finalTranscript += transcript + "\n";
        handleResult(finalTranscript[finalTranscript.length-1]);
      } else {
        interimTranscript += transcript;
      }
    }

    finalEl.textContent = finalTranscript;
    interimEl.textContent = interimTranscript;
    
    // Auto-scroll to the bottom of the transcript box
    const box = document.querySelector(".transcript-box");
    box.scrollTop = box.scrollHeight;
    
  });

  function handleResult(result){
    let firstPart = result.substring(0, result.indexOf(" "));
    let secondPart = result.substring(result.indexOf(" ")+1);
    
     switch(firstPart){
       case "alert":
         alert(secondPart);
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
