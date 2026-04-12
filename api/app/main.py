from fastapi import FastAPI
from dotenv import load_dotenv
import os
from time import perf_counter
from typing import Any, Optional

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_ollama import ChatOllama

from .schemas import Query, Output
from .tools import ALL_TOOLS

load_dotenv()

TOOL_MAP = {tool.name: tool for tool in ALL_TOOLS}
PROVIDER = os.getenv("PROVIDER", "google").strip().lower()
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemma-4-26b-a4b-it")
BACKUP_GEMINI_MODEL = os.getenv("BACKUP_GEMINI_MODEL", "gemma-4-31b-a4b-it")
GEMINI_TEMPERATURE = float(os.getenv("GEMINI_TEMPERATURE", "0"))
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

if PROVIDER not in {"google", "ollama"}:
    raise RuntimeError("PROVIDER must be either 'google' or 'ollama'.")


def build_llm(provider: str, model: str, temperature: float):
    if provider == "google":
        kwargs: dict[str, Any] = {
            "model": model,
            "api_key": GOOGLE_API_KEY,
            "temperature": temperature,
        }
        return ChatGoogleGenerativeAI(**kwargs)

    if provider == "ollama":
        return ChatOllama(
            model=model,
            base_url=OLLAMA_BASE_URL,
            temperature=temperature,
            validate_model_on_init=True,
        )

    raise RuntimeError(f"Unsupported provider: {provider}")


if PROVIDER == "google":
    primary_llm = build_llm(PROVIDER, GEMINI_MODEL, GEMINI_TEMPERATURE)
    backup_llm = build_llm(PROVIDER, BACKUP_GEMINI_MODEL, GEMINI_TEMPERATURE)
else:
    primary_llm = build_llm(PROVIDER, OLLAMA_MODEL, GEMINI_TEMPERATURE)
    backup_llm = None

primary_llm_with_tools = primary_llm.bind_tools(ALL_TOOLS)
backup_llm_with_tools = backup_llm.bind_tools(ALL_TOOLS) if backup_llm else None

SYSTEM_PROMPT = (
    "You are a browser automation agent.\n"
    "Use only the provided tools to complete the user's request.\n"
    "Call multiple tools when several steps are needed.\n"
    "If the request is ambiguous, return no tool calls."
)


def build_user_prompt(query: str, html: Optional[str], current_url: str) -> str:
    if not html:
        return (
            f"User request:\n{query}\n\n"
            f"Current page url:\n{current_url}\n"
        )

    return (
        f"User request:\n{query}\n\n"
        f"Page HTML:\n{html}\n\n"
        f"Current page url:\n{current_url}\n\n"
        "Use the HTML to choose the best selector for the requested action."
    )


def build_messages(query: str, html: Optional[str], current_url: str):
    return [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=build_user_prompt(query, html, current_url)),
    ]


def response_text(response: Any) -> str:
    content = getattr(response, "content", "")
    if isinstance(content, str):
        return content.strip()
    if content is None:
        return ""
    return str(content).strip()


def invoke_and_get_tool_calls(messages: list[Any]) -> list[Any]:
    try:
        response = primary_llm_with_tools.invoke(messages)
    except Exception as primary_error:
        if backup_llm_with_tools is None:
            raise RuntimeError(f"Primary model failed: {primary_error}") from primary_error

        try:
            response = backup_llm_with_tools.invoke(messages)
        except Exception as backup_error:
            raise RuntimeError(
                f"Primary model failed: {primary_error}; Backup model failed: {backup_error}"
            ) from backup_error

    tool_calls = list(getattr(response, "tool_calls", []) or [])
    if tool_calls:
        return tool_calls

    text = response_text(response)
    if text:
        raise RuntimeError(f"model returned text, no tool calls: {text}")

    raise RuntimeError("model returned no tool calls")


def execute_tool_step(tool_name: str, params: dict[str, Any]):
    if tool_name not in TOOL_MAP:
        return Output(
            command="error",
            commandInfo={"error": f"Unknown tool: {tool_name}"},
            timeTaken=0,
            error=1,
        )

    try:
        tool_fn = TOOL_MAP[tool_name]
        result = tool_fn.invoke(params or {})

        if hasattr(result, "model_dump"):
            result = result.model_dump()

        if isinstance(result, dict):
            return Output(
                command=result.get("command", tool_name),
                commandInfo=result.get("commandInfo", result),
                timeTaken=0,
                error=1 if result.get("error") else None,
            )

        return Output(
            command=tool_name,
            commandInfo=result,
            timeTaken=0,
            error=None,
        )
    except Exception as error:
        return Output(
            command="error",
            commandInfo={"error": str(error)},
            timeTaken=0,
            error=1,
        )


def elapsed_seconds(start_time: float) -> float:
    return round(perf_counter() - start_time, 2)


app = FastAPI()


def error_output(start_time: float, message: str, **details: Any):
    command_info: dict[str, Any] = {"error": message}
    command_info.update(details)
    return Output(
        command="error",
        commandInfo=command_info,
        timeTaken=elapsed_seconds(start_time),
        error=1,
    )


def format_results(results: list[Output], start_time: float):
    elapsed = elapsed_seconds(start_time)
    if len(results) == 1:
        result = results[0]
        return Output(
            command=result.command,
            commandInfo=result.commandInfo,
            timeTaken=elapsed,
            error=result.error,
        )

    return Output(
        command="batch",
        commandInfo={"steps": [r.model_dump() for r in results]},
        timeTaken=elapsed,
        error=None,
    )


@app.post("/", response_model=Output)
async def root(inp: Query):
    start_time = perf_counter()

    try:
        messages = build_messages(inp.query, inp.html, inp.current_url)
        tool_calls = invoke_and_get_tool_calls(messages)

        tool_outputs = []
        for tool_call in tool_calls:
            if isinstance(tool_call, dict):
                tool_name = tool_call.get("name")
                params = tool_call.get("args", {})
            else:
                tool_name = getattr(tool_call, "name", None)
                params = getattr(tool_call, "args", {})

            if not isinstance(tool_name, str) or not tool_name:
                continue

            if not isinstance(params, dict):
                params = {}

            tool_outputs.append(execute_tool_step(tool_name, params))

        if not tool_outputs:
            return error_output(start_time, "No valid tool calls returned from model")

        return format_results(tool_outputs, start_time)

    except Exception as error:
        return error_output(start_time, str(error))
