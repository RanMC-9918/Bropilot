from typing import Optional, Any
from pydantic import BaseModel

class Query(BaseModel):
    query: str


class Output(BaseModel):
    command: str
    commandInfo: str
    timeTaken: int
    error: Optional[int] = None

