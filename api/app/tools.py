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


@tool
def getPageContent() -> Output:
    """Returns ONLY the visible human-readable text on the page, NOT HTML."""
    return _build_output("get_page_content", {})


@tool
def getPageClickables() -> Output:
    """Returns all clickable elements (buttons, links) present on the page."""
    return _build_output("get_page_clickables", {})


@tool
def getPageLinks() -> Output:
    """Returns all link elements (> a <) present on the page, with their text and URLs."""
    return _build_output("get_page_links", {})


@tool
def getPageInputs() -> Output:
    """Returns all page's textarea and input fields."""
    return _build_output("get_page_inputs", {})


@tool
def clickElementWithCSSSelector(selector: str) -> Output:
    """Returns after clicks CSS selected element."""
    return _build_output("click_element_with_css_selector", {"selector": selector})


@tool
def clickElementWithRegexp(regex: str) -> Output:
    """Returns after clicks a regexp matched element. The regex is evaluated natively against the element's innerText, value, placeholder, aria-label, title, id, name, href, and alt. Ex: /Submit/i or /search_icon/i"""
    return _build_output("click_element_with_regexp", {"regex": regex})


@tool
def openNewTab(url: str = "about:blank") -> Output:
    """Returns after opens the url in a new tab, making it the active tab."""
    return _build_output("open_new_tab", {"url": url})


@tool
def createNewTab(url: str = "about:blank") -> Output:
    """Returns after creates tab with URL in background (does not switch to it)."""
    return _build_output("create_new_tab", {"url": url})


@tool
def changeURL(url: str) -> Output:
    """Returns after changes the current tab's url."""
    return _build_output("change_url", {"url": url})


@tool
def scrollWithRegexp(regex: str) -> Output:
    """Returns after scrolling to an element. The regex is evaluated natively against the element's innerText, value, placeholder, aria-label, title, id, name, href, and alt."""
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
    """Returns after types into CSS selected element."""
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
    """Returns after types into regexp selected element. The regex is evaluated natively against the element's innerText, value, placeholder, aria-label, title, id, name, href, and alt. It automatically finds the precise input control inside the match. IF press enter is true, the extension will submit the input automatically use this 9/10 times."""
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
    """Request current page HTML from the frontend. USE VERY SPARINGLY as it is slow. Use specific gets instead."""
    max_chars = int(maxChars) if isinstance(maxChars, str) else maxChars
    if max_chars < 1000:
        max_chars = 1000
    if max_chars > 120000:
        max_chars = 120000
    return _build_output("get_page_html", {"maxChars": max_chars})


@tool
def getElementsBySelector(selector: str) -> Output:
    """Returns a list of DOM elements matching the CSS selector (with tag, id, classes, and text) without downloading the full HTML. Often a more performant alternative to getPageHtml."""
    return _build_output("get_elements_by_selector", {"selector": selector})


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
]
