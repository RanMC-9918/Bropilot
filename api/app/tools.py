from typing import Union

from langchain_core.tools import tool

from .schemas import Output


def _build_output(command: str, info: dict) -> Output:
    return {
        "command": command,
        "commandInfo": info,
        "timeTaken": 0,
        "error": None,
    }


def _require_non_empty(value: str, field_name: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field_name} cannot be empty")
    return cleaned


@tool
def getPageContent() -> Output:
    """Returns visible human-readable page text (not HTML).

    Use when you need quick page understanding. Avoid repeating without an action in between.
    """
    return _build_output("get_page_content", {})


@tool
def getPageClickables() -> Output:
    """Returns clickable controls (buttons and links).

    Prefer before clickElement* when the target is uncertain.
    """
    return _build_output("get_page_clickables", {})


@tool
def getPageLinks() -> Output:
    """Returns all anchor links with visible text and URL.

    Prefer for navigation tasks; use getPageClickables for non-link controls.
    """
    return _build_output("get_page_links", {})


@tool
def getPageInputs() -> Output:
    """Returns textarea and input fields.

    Prefer before typeWith* when no reliable selector evidence exists yet.
    """
    return _build_output("get_page_inputs", {})


@tool
def clickElementWithCSSSelector(selector: str) -> Output:
    """Click a CSS-selected element.

    Use only when selector is known/stable. Prefer regexp click when text is known but selector is not.
    """
    selector = _require_non_empty(selector, "selector")
    return _build_output("click_element_with_css_selector", {"selector": selector})


@tool
def clickElementWithRegexp(regex: str) -> Output:
    """Click an element matched by regex over key element text/attributes.

    Good default click tool when visible text is known.
    """
    regex = _require_non_empty(regex, "regex")
    return _build_output("click_element_with_regexp", {"regex": regex})


@tool
def openNewTab(url: str = "about:blank") -> Output:
    """Returns after opens the url in a new tab, making it the active tab."""
    url = _require_non_empty(url, "url")
    return _build_output("open_new_tab", {"url": url})


@tool
def createNewTab(url: str = "about:blank") -> Output:
    """Returns after creates tab with URL in background (does not switch to it)."""
    url = _require_non_empty(url, "url")
    return _build_output("create_new_tab", {"url": url})


@tool
def changeURL(url: str) -> Output:
    """Returns after changes the current tab's url."""
    url = _require_non_empty(url, "url")
    return _build_output("change_url", {"url": url})


@tool
def scrollWithRegexp(regex: str) -> Output:
    """Returns after scrolling to an element. The regex is evaluated natively against the element's innerText, value, placeholder, aria-label, title, id, name, href, and alt."""
    regex = _require_non_empty(regex, "regex")
    return _build_output("scroll_with_regexp", {"regex": regex})


@tool
def scrollDistance(direction: str = "down", amount: Union[int, str] = 600) -> Output:
    """Returns after scrolls a certain distance up or down in pixels."""
    normalized = direction.lower().strip()
    if normalized not in {"up", "down"}:
        return {
            "command": "error",
            "commandInfo": {
                "message": "direction must be 'up' or 'down'",
                "received": direction,
            },
            "timeTaken": 0,
            "error": 1,
        }
    amount = int(amount) if isinstance(amount, str) else amount
    return _build_output("scroll_distance", {"direction": normalized, "amount": amount})


@tool
def typeWithCSSSelector(selector: str, text: str, pressEnter: bool = True) -> Output:
    """Type into an input selected by CSS selector.

    Use when selector is explicit and trustworthy; otherwise prefer typeWithRegexp.
    """
    selector = _require_non_empty(selector, "selector")
    text = _require_non_empty(text, "text")
    return _build_output(
        "type_with_css_selector",
        {
            "selector": selector,
            "text": text,
            "pressEnter": pressEnter,
        },
    )


@tool
def typeWithRegexp(regex: str, text: str, pressEnter: bool = True) -> Output:
    """Type into an input matched by regex over visible/input-related attributes.

    Strong default for forms. Keep pressEnter=True for submit flows unless user requested draft entry.
    """
    regex = _require_non_empty(regex, "regex")
    text = _require_non_empty(text, "text")
    return _build_output(
        "type_with_regexp",
        {
            "regex": regex,
            "text": text,
            "pressEnter": pressEnter,
        },
    )


@tool
def respondToUser(message: str) -> Output:
    """Returns after messages user directly in the chat UI. Use this to ask questions or provide status updates."""
    message = _require_non_empty(message, "message")
    return _build_output("respond_to_user", {"message": message})


@tool
def goBack() -> Output:
    """Go back."""
    return _build_output("go_back", {})


@tool
def goForward() -> Output:
    """Go forward."""
    return _build_output("go_forward", {})


@tool
def refreshPage() -> Output:
    """Refresh page."""
    return _build_output("refresh", {})


@tool
def closeCurrentTab() -> Output:
    """Close current tab."""
    return _build_output("close_tab", {})


@tool
def switchToTab(index: Union[int, str]) -> Output:
    """Switch to tab by index."""
    index = int(index) if isinstance(index, str) else index
    return _build_output("switch_tab", {"index": index})


@tool
def wait(milliseconds: Union[int, str] = 1000) -> Output:
    """Wait for a number of milliseconds."""
    milliseconds = int(milliseconds) if isinstance(milliseconds, str) else milliseconds
    return _build_output("wait", {"milliseconds": milliseconds})


@tool
def getPageHtml(maxChars: Union[int, str] = 60000) -> Output:
    """Request page HTML from frontend.

    Use sparingly for selector debugging or when targeted getter outputs are insufficient.
    """
    max_chars = int(maxChars) if isinstance(maxChars, str) else maxChars
    if max_chars < 1000:
        max_chars = 1000
    if max_chars > 120000:
        max_chars = 120000
    return _build_output("get_page_html", {"maxChars": max_chars})


@tool
def getElementsBySelector(selector: str) -> Output:
    """Return DOM elements matching a CSS selector with compact metadata.

    Prefer over getPageHtml when you only need specific structure checks.
    """
    selector = _require_non_empty(selector, "selector")
    return _build_output("get_elements_by_selector", {"selector": selector})


@tool
def getInteractiveElements(limit: Union[int, str] = 50) -> Output:
    """Return a compact inventory of visible interactive elements.

    Use for discovery when selectors are unclear before attempting click/type actions.
    """
    max_items = int(limit) if isinstance(limit, str) else limit
    if max_items < 1:
        max_items = 1
    if max_items > 200:
        max_items = 200
    return _build_output("get_interactive_elements", {"limit": max_items})


@tool
def findBestElementMatch(query: str, limit: Union[int, str] = 5) -> Output:
    """Find and rank likely interactive targets for a natural-language query.

    Use when direct regex/selector targeting repeatedly fails.
    """
    query_text = _require_non_empty(query, "query")
    max_items = int(limit) if isinstance(limit, str) else limit
    if max_items < 1:
        max_items = 1
    if max_items > 50:
        max_items = 50
    return _build_output(
        "find_best_element_match",
        {
            "query": query_text,
            "limit": max_items,
        },
    )


ALL_TOOLS = [
    getPageContent,
    getPageClickables,
    getPageLinks,
    getPageInputs,
    clickElementWithCSSSelector,
    clickElementWithRegexp,
    openNewTab,
    createNewTab,
    changeURL,
    scrollWithRegexp,
    scrollDistance,
    typeWithCSSSelector,
    typeWithRegexp,
    respondToUser,
    goBack,
    goForward,
    refreshPage,
    closeCurrentTab,
    switchToTab,
    wait,
    getPageHtml,
    getElementsBySelector,
    getInteractiveElements,
    findBestElementMatch,
]
