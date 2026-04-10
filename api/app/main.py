from fastapi import FastAPI
from dotenv import load_dotenv
import json
from typing import Optional, Any
from .schemas import Query, Output, Action
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.agents import create_agent
from .tools import scrollToWord, click

load_dotenv()

tools = [scrollToWord, click]

llm = ChatGoogleGenerativeAI(model="gemini-3.1-flash-lite-preview") # looking for new models 

agent = create_agent(
    model=llm,
    tools=tools,
    system_prompt=(
        "You are a browser chatbot assistant. "
        "You should always provide a short plain-language reply for the user. "
        "You can also call tools when the user asks for on-page actions. "
        "Available tools: scrollToWord(regex_pattern), click(regex_pattern). "
        "Use regex patterns that are specific enough to target the right element/text. "
        "If the user asks to scroll/find text, call scrollToWord. "
        "If the user asks to click a button/link, call click. "
        "You may call multiple tools in one turn when necessary, then continue with a normal user-facing response. "
        "Do not invent tools."
    ),
)

def extract_tool_actions(result: Any) -> list[Action]:
    messages = result.get("messages", []) if isinstance(result, dict) else []
    actions: list[Action] = []

    for msg in messages:
        is_tool_msg = (
            getattr(msg, "type", "") == "tool"
            or msg.__class__.__name__ == "ToolMessage"
        )
        if not is_tool_msg:
            continue

        payload = getattr(msg, "content", "")

        if isinstance(payload, dict):
            cmd = payload.get("command")
            info = payload.get("commandInfo")
            if isinstance(cmd, str) and isinstance(info, str):
                actions.append(Action(command=cmd, commandInfo=info))
            continue

        if isinstance(payload, str):
            try:
                decoded = json.loads(payload)
                if isinstance(decoded, dict):
                    cmd = decoded.get("command")
                    info = decoded.get("commandInfo")
                    if isinstance(cmd, str) and isinstance(info, str):
                        actions.append(Action(command=cmd, commandInfo=info))
                    continue
            except Exception:
                pass

        text_payload = str(payload).strip()
        if text_payload:
            actions.append(Action(command="respond", commandInfo=text_payload))

    return actions


def extract_ai_text(result: Any) -> str:
    """Extract the latest AI text message and ignore user/context messages."""
    messages = result.get("messages", []) if isinstance(result, dict) else []

    for msg in reversed(messages):
        is_ai_msg = (
            getattr(msg, "type", "") == "ai"
            or msg.__class__.__name__ == "AIMessage"
        )
        if not is_ai_msg:
            continue

        content = getattr(msg, "content", "")
        if isinstance(content, str) and content.strip():
            return content.strip()

        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, str) and block.strip():
                    parts.append(block.strip())
                elif isinstance(block, dict):
                    text = block.get("text")
                    if isinstance(text, str) and text.strip():
                        parts.append(text.strip())
            joined = "\n".join(parts).strip()
            if joined:
                return joined

    return ""


app = FastAPI()
@app.post("/", response_model=Output)
async def root(inp: Query):
    try:
        page_url = inp.pageUrl or ""
        page_title = inp.pageTitle or ""
        page_html = inp.pageHtml or ""

        user_message = (
            f"User message:\n{inp.query}\n\n"
            f"Active page URL:\n{page_url}\n\n"
            f"Active page title:\n{page_title}\n\n"
            f"Active page HTML (possibly truncated):\n{page_html}"
        )

        result = agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": user_message,
                    }
                ]
            }
        )

        actions = extract_tool_actions(result)
        last_text = extract_ai_text(result)
        if not last_text:
            last_text = "I could not generate a response. Please try again."

        return Output(
            command="assistant_response",
            commandInfo=last_text,
            timeTaken=0,
            error=None,
            assistantMessage=last_text,
            actions=actions,
        )
    except Exception as e:
        return Output(
            command="error",
            commandInfo=str(e),
            timeTaken=0,
            error=1,
        )