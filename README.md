# Bropilot
Bropilot

## Bookmarklet

Add this as a bookmark to use Bropilot on any page:

```
javascript:(function(){var s=document.createElement('script');s.src='https://api.sarveshs.dev/bropilot.js';document.body.appendChild(s);})();
```

1. Create a new bookmark in your browser.
2. Set the name to **Bropilot**.
3. Paste the code above as the URL.
4. Click the bookmark on any page to open the Bropilot panel.

The panel is draggable, collapsible, and supports voice dictation (where the browser allows it).

## Chrome Extension

Install from the repo root as an unpacked extension in `chrome://extensions` (developer mode).

## Local model setup (Ollama)

The API now uses Ollama instead of Gemini.

Set these environment variables before starting the API:

- `OLLAMA_MODEL` (default: `qwen3.5:2b`)
- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`)
- `OLLAMA_THINK` (default: `false`)

Example:

```bash
export OLLAMA_MODEL=qwen3.5:2b
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_THINK=false
```
