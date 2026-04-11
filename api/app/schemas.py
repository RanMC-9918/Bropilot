from typing import Optional, Any
from pydantic import BaseModel

class Query(BaseModel):
    query: str
    current_url: str 
    html: Optional[str] = None


class Output(BaseModel):
    command: str
    commandInfo: Any
    timeTaken: float
    error: Optional[int] = None

