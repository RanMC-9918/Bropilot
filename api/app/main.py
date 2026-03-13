from fastapi import FastAPI
from dotenv import load_dotenv
import json
from typing import Optional, Any
from .schemas import Query, Output
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.agents import create_agent
from .tools import openNewTab

load_dotenv()

tools = [openNewTab]

llm = ChatGoogleGenerativeAI(model="") # looking for new models 

agent = create_agent(
    model=llm,
    tools=tools,
    system_prompt=(
        "Use tools when needed. Do not rewrite tool results. "
        "Return tool output as-is."
    ),
)

def extract_tool_output(result: Any) -> Optional[Output]:
    messages = result.get("messages", []) if isinstance(result, dict) else []

    for msg in reversed(messages):
        is_tool_msg = (
            getattr(msg, "type", "") == "tool"
            or msg.__class__.__name__ == "ToolMessage"
        )
        if not is_tool_msg:
            continue

        payload = getattr(msg, "content", "")

        if isinstance(payload, dict):
            return Output(**payload)

        if isinstance(payload, str):
            try:
                decoded = json.loads(payload)
                if isinstance(decoded, dict):
                    return Output(**decoded)
            except Exception:
                pass

        return Output(
            command="assistant_text",
            commandInfo=str(payload),
            timeTaken=0,
            error=None,
        )

    return None


app = FastAPI()

@app.post("/", response_model=Output)
async def root(inp: Query):
    try:
        result = agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": inp.query,
                    }
                ]
            }
        )

        tool_result = extract_tool_output(result)
        if tool_result:
            return tool_result

        return Output(
            command="no_tool_called",
            commandInfo=extract_text(result),
            timeTaken=0,
            error=None,
        )
    except Exception as e:
        return Output(
            command="error",
            commandInfo=str(e),
            timeTaken=0,
            error=1,
        )