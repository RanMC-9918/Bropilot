from typing import Optional, Any, Literal
from pydantic import BaseModel

WsCompletionReason = Literal["task_complete", "blocked", "max_steps"]

class Query(BaseModel):
    query: str
    current_url: str 
    html: Optional[str] = None


class Output(BaseModel):
    command: str
    commandInfo: Any
    timeTaken: float
    error: Optional[int] = None


class WsStartSession(BaseModel):
    type: Literal["start_session"]
    request_id: str
    query: str
    current_url: str
    html: Optional[str] = None


class WsToolResult(BaseModel):
    type: Literal["tool_result"]
    request_id: str
    step_index: int
    success: bool
    result_text: str
    current_url: Optional[str] = None
    html: Optional[str] = None
    result_meta: Optional[dict[str, Any]] = None


class WsComplete(BaseModel):
    type: Literal["complete"]
    request_id: str
    total_steps: int
    time_taken: float
    reason: WsCompletionReason
    message: str

