# Bropilot
## Simple Installation
1. Click on Code in Github and download as zip
2. Extract the zip file
3. Go to Extensions page in your respective browser

   Chrome
   ```
   chrome://extensions
   ```
   Edge
   ```
   edge://extensions
   ```
4. Switch on developer mode (Read <a href="https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked" target="_blank" rel="noopener noreferrer">Loading an Unpacked Extension</a>)
5. 

## Local model setup (Ollama) {id="local"}

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

## Tools

We have a number of tools to cover everyday tasks where bropilot could be used, but the tools list can always be customized.

- GetPageContent (returns all visible text)
- GetPageClickables (returns all clickable elements)
- GetPageLinks (returns all link elements \gt a \lt)
- ClickElementWithCSSSelector (returns after clicks CSS selected element)
- ClickElementWithRegexp (returns after clicks a regexp matched element)
- OpenNewTab (returns after opens the url in a new tab)
- CreateNewTab (returns after creates tab with URL in background)
- ChangeURL (returns after changes tab's url)
- ScrollWithRegexp (returns after scrolling to a regexp matched element)
- ScrollDistance (returns after scrolls a certain distance)
- GetPageInputs (returns page's textarea and input fields)
- TypeWithCSSSelector (returns after types into CSS selected element)
- TypeWithRegexp (returns after types into regexp selected element)
- RespondToUser (returns after messages user)
