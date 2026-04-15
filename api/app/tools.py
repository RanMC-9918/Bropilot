
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
def openNewTab(url: str = "about:blank") -> Output:
    """Open new tab."""
    return _build_output("open_tab", {"url": url})


@tool
def navigateCurrentTab(url: str) -> Output:
    """Navigate to URL."""
    return _build_output("navigate", {"url": url})


@tool
def searchWeb(query: str) -> Output:
    """Search web."""
    return _build_output("search_web", {"query": query})


@tool
def clickElement(selector: str) -> Output:
    """Click element by CSS selector."""
    return _build_output("click", {"selector": selector})


@tool
def typeIntoElement(selector: str, text: str, pressEnter: bool = False) -> Output:
    """Type into element by selector."""
    return _build_output(
        "type",
        {
            "selector": selector,
            "text": text,
            "pressEnter": pressEnter,
        },
    )


@tool
def scrollPage(direction: str = "down", amount: Union[int, str] = 600) -> Output:
    """Scroll page."""
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
    return _build_output("scroll", {"direction": normalized, "amount": amount})


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
    """Close tab."""
    return _build_output("close_tab", {})


@tool
def switchToTab(index: Union[int, str]) -> Output:
    """Switch to tab by index."""
    index = int(index) if isinstance(index, str) else index
    return _build_output("switch_tab", {"index": index})


@tool
def wait(milliseconds: Union[int, str] = 1000) -> Output:
    """Wait milliseconds."""
    milliseconds = int(milliseconds) if isinstance(milliseconds, str) else milliseconds
    return _build_output("wait", {"milliseconds": milliseconds})


@tool
def scrollToWord(regex: str) -> Output:
    """Scroll to the first word matching a regex."""
    return _build_output("scroll_to_word", {"regex": regex})


@tool
def getPageHtml(maxChars: Union[int, str] = 60000) -> Output:
    """Request current page HTML from the frontend when DOM context is needed."""
    max_chars = int(maxChars) if isinstance(maxChars, str) else maxChars
    if max_chars < 1000:
        max_chars = 1000
    if max_chars > 120000:
        max_chars = 120000
    return _build_output("get_page_html", {"maxChars": max_chars})


ALL_TOOLS = [
    openNewTab,
    navigateCurrentTab,
    searchWeb,
    clickElement,
    typeIntoElement,
    scrollPage,
    goBack,
    goForward,
    refreshPage,
    closeCurrentTab,
    switchToTab,
    scrollToWord,
    getPageHtml,
    wait,
]
