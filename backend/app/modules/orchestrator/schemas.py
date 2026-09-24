from typing import Literal

from pydantic import BaseModel, Field


StateName = Literal["live", "staging"]


class OrchestratorState(BaseModel):
    active: StateName
    liveWorkspace: str
    pipelineSandbox: str


class SetStateRequest(BaseModel):
    active: StateName


class FileRequest(BaseModel):
    state: StateName
    path: str = Field(min_length=1)


class FileContent(FileRequest):
    content: str


class FileResponse(BaseModel):
    state: StateName
    path: str
    content: str


class ProcessRequest(BaseModel):
    state: StateName = "staging"
    executable: str = Field(min_length=1)
    args: list[str] = Field(default_factory=list)
    cwd: str = ""
    env: dict[str, str] = Field(default_factory=dict)


class ProcessResponse(BaseModel):
    id: str
    state: StateName
    running: bool


class ProcessOutput(BaseModel):
    id: str
    output: list[str]
    running: bool
    returnCode: int | None = None


class NativeServerRequest(BaseModel):
    application: str = Field(default="main:app", pattern=r"^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_.]*$")
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)


class NativeServerResponse(BaseModel):
    id: str
    application: str
    host: str
    port: int
    reload: bool
    root: str
    running: bool


class PipelineStartRequest(BaseModel):
    command: str = Field(min_length=1)
    language: str = "python"
    containerPort: int = Field(default=8000, ge=1, le=65535)
    env: dict[str, str] = Field(default_factory=dict)


class PipelineStartResponse(BaseModel):
    id: str
    previewUrl: str
    containerPort: int
    hostPort: int
    snapshotRoot: str
    running: bool


class OrchestratorEvent(BaseModel):
    type: str
    payload: dict[str, object]