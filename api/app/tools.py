
from langchain_core.tools import tool
from .schemas import Output

@tool
def openNewTab() -> Output:
    """Opens a new browser tab."""
    return {
        "command": "open_tab",
        "commandInfo": "A new browser tab has been opened.",
        "timeTaken": 0,
        "error": None
    }
