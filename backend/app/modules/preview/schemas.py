from pydantic import BaseModel


class PreviewStartResponse(BaseModel):
    url: str
    command: str
    port: int
