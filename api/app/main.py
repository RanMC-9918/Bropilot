import asyncio
import json
import re
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
import os
from time import perf_counter
from typing import Any, Optional

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_ollama import ChatOllama

from .schemas import Query, Output, WsStartSession, WsToolResult
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
WS_MAX_STEPS = int(os.getenv("WS_MAX_STEPS", "8"))
WS_STEP_TIMEOUT_SECONDS = int(os.getenv("WS_STEP_TIMEOUT_SECONDS", "45"))
WS_DONE_CHECK_RETRIES = int(os.getenv("WS_DONE_CHECK_RETRIES", "2"))
WS_STAGNATION_STEPS = int(os.getenv("WS_STAGNATION_STEPS", "3"))

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

WS_SYSTEM_PROMPT = (
    "You are an interactive browser automation agent.\n"
    "Return exactly one tool call for the immediate next step when an action is needed.\n"
    "Call getPageHtml when you need fresh DOM context before choosing selectors.\n"
    "Use only provided tools.\n"
    "If the task is complete or blocked, respond in plain text with a short completion or blocker note and no tool call."
)

DONE_CHECK_SYSTEM_PROMPT = (
    "You validate task completion for a browser automation run.\n"
    "Return ONLY JSON with keys: status and reason.\n"
    "status must be one of: done, not_done, blocked.\n"
    "reason must be a short sentence."
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


def invoke_with_fallback(messages: list[Any]):
    try:
        return primary_llm_with_tools.invoke(messages)
    except Exception as primary_error:
        if backup_llm_with_tools is None:
            raise RuntimeError(f"Primary model failed: {primary_error}") from primary_error

        try:
            return backup_llm_with_tools.invoke(messages)
        except Exception as backup_error:
            raise RuntimeError(
                f"Primary model failed: {primary_error}; Backup model failed: {backup_error}"
            ) from backup_error


def response_text(response: Any) -> str:
    content = getattr(response, "content", "")
    if isinstance(content, str):
        return content.strip()
    if content is None:
        return ""
    return str(content).strip()


def invoke_and_get_tool_calls(messages: list[Any]) -> list[Any]:
    response = invoke_with_fallback(messages)

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


def websocket_iteration_prompt(
    query: str,
    latest_url: str,
    latest_html: Optional[str],
    feedback_log: list[dict[str, Any]],
) -> str:
    feedback_lines: list[str] = []
    for item in feedback_log[-6:]:
        feedback_lines.append(
            f"step={item.get('step')} tool={item.get('tool')} success={item.get('success')} note={item.get('note')}"
        )

    feedback_text = "\n".join(feedback_lines) if feedback_lines else "none"
    html_text = latest_html or "[none]"
    return (
        f"User request:\n{query}\n\n"
        f"Current page url:\n{latest_url}\n\n"
        f"Recent execution feedback:\n{feedback_text}\n\n"
        f"Current page html snippet:\n{html_text}\n\n"
        "Return one next tool call, or plain text if complete/blocked."
    )


def pick_tool_name_and_args(tool_call: Any) -> tuple[Optional[str], dict[str, Any]]:
    if isinstance(tool_call, dict):
        name = tool_call.get("name")
        args = tool_call.get("args", {})
    else:
        name = getattr(tool_call, "name", None)
        args = getattr(tool_call, "args", {})

    if not isinstance(name, str) or not name:
        return None, {}

    if not isinstance(args, dict):
        args = {}

    return name, args


def parse_done_check_payload(text: str) -> Optional[dict[str, Any]]:
    candidate = text.strip()
    if not candidate:
        return None

    try:
        data = json.loads(candidate)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(.*?)\s*```", candidate, re.DOTALL)
    if fenced:
        try:
            data = json.loads(fenced.group(1))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

    first_obj = re.search(r"\{[\s\S]*\}", candidate)
    if first_obj:
        try:
            data = json.loads(first_obj.group(0))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

    return None


def done_check_prompt(
    query: str,
    latest_url: str,
    latest_html: Optional[str],
    feedback_log: list[dict[str, Any]],
) -> str:
    feedback_lines: list[str] = []
    for item in feedback_log[-8:]:
        feedback_lines.append(
            f"step={item.get('step')} tool={item.get('tool')} success={item.get('success')} note={item.get('note')}"
        )

    feedback_text = "\n".join(feedback_lines) if feedback_lines else "none"
    html_hint = latest_html if latest_html else "[none]"

    return (
        f"User goal:\n{query}\n\n"
        f"Current url:\n{latest_url}\n\n"
        f"Recent execution feedback:\n{feedback_text}\n\n"
        f"Current html context:\n{html_hint}\n\n"
        "Decide if the goal is completed."
    )


def validate_task_completion(
    query: str,
    latest_url: str,
    latest_html: Optional[str],
    feedback_log: list[dict[str, Any]],
) -> tuple[str, str]:
    for _ in range(WS_DONE_CHECK_RETRIES):
        messages = [
            SystemMessage(content=DONE_CHECK_SYSTEM_PROMPT),
            HumanMessage(
                content=done_check_prompt(
                    query=query,
                    latest_url=latest_url,
                    latest_html=latest_html,
                    feedback_log=feedback_log,
                )
            ),
        ]

        response = invoke_with_fallback(messages)
        tool_calls = list(getattr(response, "tool_calls", []) or [])
        if tool_calls:
            return "not_done", "Completion check requested another action"

        parsed = parse_done_check_payload(response_text(response))
        if not parsed:
            continue

        status = str(parsed.get("status", "")).strip().lower()
        reason = str(parsed.get("reason", "")).strip() or "No reason provided"
        if status in {"done", "not_done", "blocked"}:
            return status, reason

    return "blocked", "Unable to validate completion reliably"


app = FastAPI()


@app.websocket("/ws")
async def websocket_root(websocket: WebSocket):
    await websocket.accept()
    start_time = perf_counter()

    try:
        start_raw = await websocket.receive_json()
        if not isinstance(start_raw, dict) or start_raw.get("type") != "start_session":
            await websocket.send_json(
                {
                    "type": "error",
                    "request_id": None,
                    "error": "Expected start_session message",
                }
            )
            return

        start_message = WsStartSession.model_validate(start_raw)
        request_id = start_message.request_id.strip()
        query = start_message.query.strip()
        latest_url = start_message.current_url
        latest_html = start_message.html

        if not request_id or not query:
            await websocket.send_json(
                {
                    "type": "error",
                    "request_id": request_id or None,
                    "error": "request_id and query are required",
                }
            )
            return

        feedback_log: list[dict[str, Any]] = []
        stagnation_steps = 0

        for step_index in range(WS_MAX_STEPS):
            await websocket.send_json(
                {
                    "type": "status",
                    "request_id": request_id,
                    "step_index": step_index,
                    "message": f"Planning step {step_index + 1}",
                }
            )

            iteration_messages = [
                SystemMessage(content=WS_SYSTEM_PROMPT),
                HumanMessage(
                    content=websocket_iteration_prompt(
                        query=query,
                        latest_url=latest_url,
                        latest_html=latest_html,
                        feedback_log=feedback_log,
                    )
                ),
            ]

            response = invoke_with_fallback(iteration_messages)
            tool_calls = list(getattr(response, "tool_calls", []) or [])

            if not tool_calls:
                status, reason = validate_task_completion(
                    query=query,
                    latest_url=latest_url,
                    latest_html=latest_html,
                    feedback_log=feedback_log,
                )
                if status == "done":
                    await websocket.send_json(
                        {
                            "type": "complete",
                            "request_id": request_id,
                            "total_steps": step_index,
                            "time_taken": elapsed_seconds(start_time),
                            "message": reason,
                        }
                    )
                    return

                if status == "blocked":
                    await websocket.send_json(
                        {
                            "type": "error",
                            "request_id": request_id,
                            "step_index": step_index,
                            "error": f"Task blocked: {reason}",
                        }
                    )
                    return

                feedback_log.append(
                    {
                        "step": step_index,
                        "tool": "done_check",
                        "success": False,
                        "note": f"Continuation required: {reason}",
                    }
                )
                continue

            tool_name, args = pick_tool_name_and_args(tool_calls[0])
            if tool_name is None:
                await websocket.send_json(
                    {
                        "type": "error",
                        "request_id": request_id,
                        "step_index": step_index,
                        "error": "Model returned invalid tool call",
                    }
                )
                return

            action_output = execute_tool_step(tool_name, args)
            await websocket.send_json(
                {
                    "type": "tool_call",
                    "request_id": request_id,
                    "step_index": step_index,
                    "tool_name": tool_name,
                    "args": args,
                    "action": {
                        "command": action_output.command,
                        "commandInfo": action_output.commandInfo,
                    },
                }
            )

            try:
                result_raw = await asyncio.wait_for(
                    websocket.receive_json(),
                    timeout=WS_STEP_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                await websocket.send_json(
                    {
                        "type": "error",
                        "request_id": request_id,
                        "step_index": step_index,
                        "error": "Timed out waiting for tool_result",
                    }
                )
                return

            if not isinstance(result_raw, dict) or result_raw.get("type") != "tool_result":
                await websocket.send_json(
                    {
                        "type": "error",
                        "request_id": request_id,
                        "step_index": step_index,
                        "error": "Expected tool_result message",
                    }
                )
                return

            result_message = WsToolResult.model_validate(result_raw)

            if result_message.request_id != request_id:
                await websocket.send_json(
                    {
                        "type": "error",
                        "request_id": request_id,
                        "step_index": step_index,
                        "error": "Mismatched request_id in tool_result",
                    }
                )
                return

            previous_url = latest_url
            if result_message.current_url:
                latest_url = result_message.current_url
            if tool_name == "getPageHtml" and result_message.html is not None:
                latest_html = result_message.html

            made_progress = bool(result_message.success)
            if latest_url != previous_url:
                made_progress = True
            if tool_name == "getPageHtml":
                made_progress = False

            if made_progress:
                stagnation_steps = 0
            else:
                stagnation_steps += 1

            if stagnation_steps >= WS_STAGNATION_STEPS:
                await websocket.send_json(
                    {
                        "type": "error",
                        "request_id": request_id,
                        "step_index": step_index,
                        "error": "Task blocked: no progress across recent steps",
                    }
                )
                return

            feedback_log.append(
                {
                    "step": step_index,
                    "tool": tool_name,
                    "success": result_message.success,
                    "note": result_message.result_text,
                }
            )

            await websocket.send_json(
                {
                    "type": "tool_result_ack",
                    "request_id": request_id,
                    "step_index": step_index,
                    "success": result_message.success,
                }
            )

        await websocket.send_json(
            {
                "type": "complete",
                "request_id": request_id,
                "total_steps": WS_MAX_STEPS,
                "time_taken": elapsed_seconds(start_time),
                "message": "Stopped after max steps",
            }
        )

    except WebSocketDisconnect:
        return
    except Exception as error:
        try:
            await websocket.send_json(
                {
                    "type": "error",
                    "request_id": None,
                    "error": str(error),
                }
            )
        except Exception:
            return


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
