import asyncio

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from app.common.middleware.auth import AuthUser, require_auth
from app.core.config import settings
from app.core.security import decode_access_token
from app.modules.orchestrator.schemas import (
    FileContent,
    FileRequest,
    FileResponse,
    NativeServerRequest,
    NativeServerResponse,
    OrchestratorState,
    ProcessOutput,
    ProcessRequest,
    ProcessResponse,
    SetStateRequest,
)
from app.modules.orchestrator.service import orchestrator

router = APIRouter(prefix="/orchestrator", tags=["orchestrator"])


@router.get("/state", response_model=OrchestratorState)
async def get_state(_: AuthUser = Depends(require_auth)) -> OrchestratorState:
    return OrchestratorState(
        active=orchestrator.state,
        liveWorkspace=orchestrator.root_for("live"),
        pipelineSandbox=orchestrator.root_for("staging"),
    )


@router.put("/state", response_model=OrchestratorState)
async def put_state(payload: SetStateRequest, _: AuthUser = Depends(require_auth)) -> OrchestratorState:
    orchestrator.set_state(payload.active)
    await orchestrator.publish("state.changed", {"active": payload.active})
    return await get_state(_)


@router.get("/file", response_model=FileResponse)
async def get_file(payload: FileRequest = Query(), _: AuthUser = Depends(require_auth)) -> FileResponse:
    content = await orchestrator.read_file(payload.state, payload.path)
    return FileResponse(state=payload.state, path=payload.path, content=content)


@router.put("/file", response_model=FileResponse)
async def put_file(payload: FileContent, _: AuthUser = Depends(require_auth)) -> FileResponse:
    await orchestrator.write_file(payload.state, payload.path, payload.content)
    return FileResponse(state=payload.state, path=payload.path, content=payload.content)


@router.post("/process", response_model=ProcessResponse)
async def post_process(payload: ProcessRequest, _: AuthUser = Depends(require_auth)) -> ProcessResponse:
    process_id = await orchestrator.start_process(
        payload.state, payload.executable, payload.args, payload.cwd, payload.env
    )
    return ProcessResponse(id=process_id, state=payload.state, running=True)


@router.post("/ide/start", response_model=NativeServerResponse)
async def start_ide_core(payload: NativeServerRequest, _: AuthUser = Depends(require_auth)) -> NativeServerResponse:
    process_id = await orchestrator.start_native_uvicorn(payload.application, payload.host, payload.port)
    return NativeServerResponse(
        id=process_id,
        application=payload.application,
        host=payload.host,
        port=payload.port,
        reload=True,
        root=orchestrator.root_for("live"),
        running=True,
    )


@router.post("/ide/stop", status_code=204)
async def stop_ide_core(_: AuthUser = Depends(require_auth)) -> None:
    await orchestrator.stop_native_uvicorn()


@router.get("/process/{process_id}", response_model=ProcessOutput)
async def get_process(process_id: str, _: AuthUser = Depends(require_auth)) -> ProcessOutput:
    output, running, return_code = await orchestrator.output(process_id)
    return ProcessOutput(id=process_id, output=output, running=running, returnCode=return_code)


@router.delete("/process/{process_id}", status_code=204)
async def delete_process(process_id: str, _: AuthUser = Depends(require_auth)) -> None:
    await orchestrator.stop_process(process_id)


@router.websocket("/stream")
async def stream(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    if not settings.DEV_SKIP_AUTH:
        if not token:
            await websocket.close(code=4400, reason="token is required")
            return
        try:
            decode_access_token(token)
        except ValueError:
            await websocket.close(code=4401, reason="Invalid or expired token")
            return

    await websocket.accept()
    queue = orchestrator.subscribe()
    sender = asyncio.create_task(_send_events(websocket, queue))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        orchestrator.unsubscribe(queue)


async def _send_events(websocket: WebSocket, queue: asyncio.Queue[dict[str, object]]) -> None:
    while True:
        await websocket.send_json(await queue.get())