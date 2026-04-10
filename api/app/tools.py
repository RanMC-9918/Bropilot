
from langchain_core.tools import tool


@tool
def scrollToWord(regex_pattern: str) -> dict:
    """Return a regex pattern the extension should use to find text, scroll to it, and highlight it."""
    return {
        "command": "scroll_to_word",
        "commandInfo": regex_pattern,
        "timeTaken": 0,
        "error": None,
    }


@tool
def click(regex_pattern: str) -> dict:
    """Return a regex pattern the extension should use to find and click a matching button/link, then highlight it."""
    return {
        "command": "click",
        "commandInfo": regex_pattern,
        "timeTaken": 0,
        "error": None,
    }


def respond(response: str) -> dict:
    """Responds to the user."""
    return {
        "command": "respond",
        "commandInfo": response,
        "timeTaken": 0,
        "error": None,
    }
