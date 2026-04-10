from typing import Optional, Any
from pydantic import BaseModel, Field

class Query(BaseModel):
    query: str
    pageHtml: Optional[str] = None
    pageUrl: Optional[str] = None
    pageTitle: Optional[str] = None


class Action(BaseModel):
    command: str
    commandInfo: str


class Output(BaseModel):
    command: str
    commandInfo: str
    timeTaken: int
    error: Optional[int] = None
    assistantMessage: Optional[str] = None
    actions: list[Action] = Field(default_factory=list)

