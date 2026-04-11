from fastapi import FastAPI
from dotenv import load_dotenv
import json
import os
import re
from time import perf_counter
from typing import Any, Optional
from .schemas import Query, Output
from langchain_google_genai import ChatGoogleGenerativeAI
from .tools import (
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
    wait,
)

load_dotenv()

TOOL_MAP = {
    "openNewTab": openNewTab,
    "navigateCurrentTab": navigateCurrentTab,
    "searchWeb": searchWeb,
    "clickElement": clickElement,
    "typeIntoElement": typeIntoElement,
    "scrollPage": scrollPage,
    "goBack": goBack,
    "goForward": goForward,
    "refreshPage": refreshPage,
    "closeCurrentTab": closeCurrentTab,
    "switchToTab": switchToTab,
    "wait": wait,
}

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemma-4-26b-a4b-it")
BACKUP_GEMINI_MODEL = os.getenv("BACKUP_GEMINI_MODEL", "gemma-4-31b-it")
GEMINI_TEMPERATURE = float(os.getenv("GEMINI_TEMPERATURE", "0"))
THINKING_CONFIG = {"thinking_config": {"thinking_budget": 0}}

primary_llm = ChatGoogleGenerativeAI(
    model=GEMINI_MODEL,
    google_api_key=GOOGLE_API_KEY,
    temperature=GEMINI_TEMPERATURE,
    model_kwargs=THINKING_CONFIG,
)

backup_llm = ChatGoogleGenerativeAI(
    model=BACKUP_GEMINI_MODEL,
    google_api_key=GOOGLE_API_KEY,
    temperature=GEMINI_TEMPERATURE,
    model_kwargs=THINKING_CONFIG,
)

SYSTEM_PROMPT = (
    "You are a browser automation planner. Convert the user request into a tool plan.\n\n"
    "Output Rules:\n"
    "1. Respond with ONLY valid JSON.\n"
    "2. Do not use markdown code fences.\n"
    "3. Do not include explanation text before or after JSON.\n"
    "4. Top-level JSON MUST be an object with exactly one key: steps.\n"
    "5. steps MUST be an array.\n"
    "6. Each item in steps MUST be an object with exactly two keys: tool and params.\n"
    "7. tool MUST be one of: openNewTab, navigateCurrentTab, searchWeb, clickElement, typeIntoElement, scrollPage, goBack, goForward, refreshPage, closeCurrentTab, switchToTab, wait.\n"
    "8. params MUST be an object. Use {} when no params are needed.\n"
    "9. Use short CSS selectors only: #id, .class, [name].\n"
    "10. If the request is ambiguous or cannot be completed, return {\"steps\": []}.\n\n"
    "Parameter Rules:\n"
    "- openNewTab: {\"url\": string} optional\n"
    "- navigateCurrentTab: {\"url\": string} required\n"
    "- searchWeb: {\"query\": string} required\n"
    "- clickElement: {\"selector\": string} required\n"
    "- typeIntoElement: {\"selector\": string, \"text\": string, \"pressEnter\": boolean optional}\n"
    "- scrollPage: {\"direction\": string, \"amount\": integer optional}\n"
    "- goBack: {}\n"
    "- goForward: {}\n"
    "- refreshPage: {}\n"
    "- closeCurrentTab: {}\n"
    "- switchToTab: {\"tabIndex\": integer} required\n"
    "- wait: {\"milliseconds\": integer} required\n\n"
    "Valid output example:\n"
    "{\"steps\":[{\"tool\":\"searchWeb\",\"params\":{\"query\":\"latest fastapi docs\"}}]}\n\n"
    "Invalid output example:\n"
    "I will search now...\n"
    "```json\n"
    "{\"steps\":[...]}\n"
    "```\n"
    "Correction: return only the JSON object, no markdown and no prose."
)


def build_user_prompt(query: str, html: Optional[str], current_url: str) -> str:
    if not html:
        return (
            f"User request:\n{query}\n\n"
            "Current page url:\n"
            f"{current_url}\n\n"
        )

    return (
        f"User request:\n{query}\n\n"
        "Page HTML:\n"
        f"{html}\n\n"
        "Use the HTML to choose the best selector for the requested action."
        "Current page url:\n"
        f"{current_url}\n\n"
    )


def _content_to_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload

    if isinstance(payload, dict):
        try:
            return json.dumps(payload, ensure_ascii=True)
        except Exception:
            return str(payload)

    if isinstance(payload, list):
        parts: list[str] = []
        for item in payload:
            if isinstance(item, str):
                parts.append(item)
                continue

            if isinstance(item, dict):
                text_value = item.get("text")
                if isinstance(text_value, str):
                    parts.append(text_value)
                    continue

                content_value = item.get("content")
                if isinstance(content_value, str):
                    parts.append(content_value)
                    continue

                try:
                    parts.append(json.dumps(item, ensure_ascii=True))
                except Exception:
                    parts.append(str(item))
                continue

            parts.append(str(item))

        return "\n".join(part for part in parts if part)

    return str(payload)


def parse_model_response(payload: Any) -> tuple[list[dict[str, Any]], Any]:
    """Parse raw LLM payload into normalized tool steps and parsed plan."""

    def extract_balanced_blocks(text: str, open_ch: str, close_ch: str) -> list[str]:
        blocks: list[str] = []
        depth = 0
        start = -1

        for i, ch in enumerate(text):
            if ch == open_ch:
                if depth == 0:
                    start = i
                depth += 1
            elif ch == close_ch and depth > 0:
                depth -= 1
                if depth == 0 and start != -1:
                    blocks.append(text[start : i + 1])
                    start = -1

        return blocks

    def plan_score(value: Any) -> int:
        if isinstance(value, list):
            return 3 if value else 1

        if isinstance(value, dict):
            if isinstance(value.get("steps"), list):
                return 5
            if isinstance(value.get("actions"), list):
                return 4
            if isinstance(value.get("tool_calls"), list) or isinstance(value.get("calls"), list):
                return 4
            if isinstance(value.get("tool"), str) or isinstance(value.get("name"), str):
                return 3
            if isinstance(value.get("function"), dict):
                return 3
            return 1

        return 0

    def coerce_params(raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str):
            raw = raw.strip()
            if not raw:
                return {}
            try:
                decoded = json.loads(raw)
                if isinstance(decoded, dict):
                    return decoded
            except json.JSONDecodeError:
                return {}
        return {}

    def coerce_step(item: Any) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None

        if isinstance(item.get("tool"), str):
            return {"tool": item["tool"], "params": coerce_params(item.get("params", {}))}

        if isinstance(item.get("name"), str):
            return {
                "tool": item["name"],
                "params": coerce_params(item.get("arguments", item.get("params", {}))),
            }

        function_obj = item.get("function")
        if isinstance(function_obj, dict) and isinstance(function_obj.get("name"), str):
            return {
                "tool": function_obj["name"],
                "params": coerce_params(function_obj.get("arguments", {})),
            }

        return None

    text = _content_to_text(payload).strip()
    if not text:
        return [], None

    candidates: list[Any] = []

    try:
        candidates.append(json.loads(text))
    except json.JSONDecodeError:
        pass

    fenced_match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    if fenced_match:
        try:
            candidates.append(json.loads(fenced_match.group(1)))
        except json.JSONDecodeError:
            pass

    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        for block in extract_balanced_blocks(text, open_ch, close_ch):
            try:
                candidates.append(json.loads(block))
            except json.JSONDecodeError:
                pass

    if not candidates:
        return [], None

    plan = max(candidates, key=plan_score)

    candidate_items: list[Any]
    if isinstance(plan, list):
        candidate_items = plan
    elif isinstance(plan, dict):
        current = plan
        while isinstance(current.get("plan"), dict):
            current = current["plan"]

        if isinstance(current.get("steps"), list):
            candidate_items = current["steps"]
        elif isinstance(current.get("actions"), list):
            candidate_items = current["actions"]
        elif isinstance(current.get("tool_calls"), list):
            candidate_items = current["tool_calls"]
        elif isinstance(current.get("calls"), list):
            candidate_items = current["calls"]
        else:
            candidate_items = [current]
    else:
        return [], plan

    steps: list[dict[str, Any]] = []
    for item in candidate_items:
        step = coerce_step(item)
        if step:
            steps.append(step)

    return steps, plan


def execute_tool_step(tool_name: str, params: dict):
    if tool_name not in TOOL_MAP:
        return Output(
            command="error",
            commandInfo={"error": f"Unknown tool: {tool_name}"},
            timeTaken=0,
            error=1,
        )
    
    try:
        tool_fn = TOOL_MAP[tool_name]
        result = tool_fn.invoke(params)

        if isinstance(result, dict):
            return Output(
                command=result.get("command", tool_name),
                commandInfo=result.get("commandInfo", result),
                timeTaken=0,
                error=None,
            )
        
        return Output(
            command=tool_name,
            commandInfo=result,
            timeTaken=0,
            error=None,
        )
    except Exception as e:
        return Output(
            command="error",
            commandInfo={"error": str(e)},
            timeTaken=0,
            error=1,
        )


def elapsed_seconds(start_time: float) -> float:
    return round(perf_counter() - start_time, 2)


def debug_snippet(payload: Any, limit: int = 4000) -> str:
    text = _content_to_text(payload)
    if len(text) <= limit:
        return text
    return text[:limit] + "...<truncated>"


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


def invoke_model(query: str):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": query},
    ]

    try:
        response = primary_llm.invoke(messages)
    except Exception as primary_error:
        try:
            response = backup_llm.invoke(messages)
        except Exception as backup_error:
            raise RuntimeError(
                f"Primary model failed: {primary_error}; Backup model failed: {backup_error}"
            ) from backup_error

    return response.content if hasattr(response, "content") else response


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
        user_prompt = build_user_prompt(inp.query, inp.html, inp.current_url)
        raw_model_output = invoke_model(user_prompt)
        steps, parsed_plan = parse_model_response(raw_model_output)

        if parsed_plan is None:
            return error_output(
                start_time,
                "Failed to parse JSON from LLM response",
                llmResponse=debug_snippet(raw_model_output),
            )

        if not steps:
            return error_output(
                start_time,
                "No steps found in LLM response",
                parsedPlan=parsed_plan,
                llmResponse=debug_snippet(raw_model_output),
            )

        tool_outputs = []
        for step in steps:
            tool_name = step.get("tool")
            params = step.get("params", {})

            if not tool_name:
                continue

            tool_result = execute_tool_step(tool_name, params)
            tool_outputs.append(tool_result)

        if not tool_outputs:
            return error_output(
                start_time,
                "No valid tool steps found in LLM response",
                parsedPlan=parsed_plan,
            )

        return format_results(tool_outputs, start_time)

    except Exception as e:
        return error_output(start_time, str(e))