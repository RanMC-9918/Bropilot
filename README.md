# Bropilot
Bropilot

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
