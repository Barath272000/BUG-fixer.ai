import asyncio
import os
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.common.errors.app_error import AppError
from app.common.utils.safe_path import resolve_safe_path
from app.core.config import settings
from app.modules.orchestrator.schemas import StateName


@dataclass
class ManagedProcess:
    process: asyncio.subprocess.Process
    output: list[str] = field(default_factory=list)


class Orchestrator:
    def __init__(self) -> None:
        self._active: StateName = "live"
        self._processes: dict[str, ManagedProcess] = {}
        self._subscribers: set[asyncio.Queue[dict[str, object]]] = set()
        self._native_process_id: str | None = None

    @property
    def state(self) -> StateName:
        return self._active

    def root_for(self, state: StateName) -> str:
        return settings.LIVE_WORKSPACE_ROOT if state == "live" else settings.PIPELINE_SANDBOX_ROOT

    def set_state(self, state: StateName) -> None:
        self._active = state

    def safe_path(self, state: StateName, path: str) -> str:
        trimmed = path.strip().strip("/")
        if not trimmed:
            raise AppError(400, "INVALID_PATH", "A relative path is required")
        root = Path(self.root_for(state)).resolve()
        candidate = Path(resolve_safe_path(str(root), trimmed)).resolve(strict=False)
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise AppError(400, "INVALID_PATH", "Path escapes the allowed root") from exc
        return str(candidate)

    async def read_file(self, state: StateName, path: str) -> str:
        target = self.safe_path(state, path)
        if not os.path.isfile(target):
            raise AppError(404, "PATH_NOT_FOUND", "The requested path does not exist")
        try:
            return await asyncio.to_thread(Path(target).read_text, encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise AppError(400, "NOT_TEXT_FILE", "The requested file is not UTF-8 text") from exc

    async def write_file(self, state: StateName, path: str, content: str) -> None:
        target = self.safe_path(state, path)
        await asyncio.to_thread(self._write_text, target, content)
        await self.publish("file.updated", {"state": state, "path": path.strip().strip("/")})

    @staticmethod
    def _write_text(target: str, content: str) -> None:
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        Path(target).write_text(content, encoding="utf-8")

    async def start_process(
        self,
        state: StateName,
        executable: str,
        args: list[str],
        cwd: str,
        env: dict[str, str],
    ) -> str:
        root = self.root_for(state)
        process_cwd = root if not cwd.strip() else self.safe_path(state, cwd)
        if not os.path.isdir(process_cwd):
            raise AppError(400, "INVALID_CWD", "The process working directory does not exist")
        if not executable.strip():
            raise AppError(400, "INVALID_EXECUTABLE", "An executable is required")
        process = await asyncio.create_subprocess_exec(
            executable,
            *args,
            cwd=process_cwd,
            env={**os.environ, **env},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        process_id = str(uuid.uuid4())
        managed = ManagedProcess(process=process)
        self._processes[process_id] = managed
        asyncio.create_task(self._collect_output(process_id, state))
        await self.publish("process.started", {"id": process_id, "state": state})
        return process_id

    async def start_native_uvicorn(self, application: str, host: str, port: int) -> str:
        if self._native_process_id is not None:
            await self.stop_process(self._native_process_id)
        root = self.root_for("live")
        process_id = await self.start_process(
            "live",
            sys.executable,
            [
                "-m",
                "uvicorn",
                application,
                "--host",
                host,
                "--port",
                str(port),
                "--reload",
                "--reload-dir",
                root,
            ],
            "",
            {"PYTHONPATH": os.pathsep.join(filter(None, [root, os.environ.get("PYTHONPATH", "")]))},
        )
        self._native_process_id = process_id
        await self.publish("native_server.started", {"id": process_id, "application": application, "root": root, "port": port})
        return process_id

    async def stop_native_uvicorn(self) -> None:
        if self._native_process_id is None:
            return
        process_id = self._native_process_id
        self._native_process_id = None
        await self.stop_process(process_id)
        await self.publish("native_server.stopped", {"id": process_id})

    async def _collect_output(self, process_id: str, state: StateName) -> None:
        managed = self._processes[process_id]
        assert managed.process.stdout is not None
        async for line in managed.process.stdout:
            text = line.decode(errors="replace").rstrip("\n")
            managed.output.append(text)
            await self.publish("process.output", {"id": process_id, "state": state, "line": text})
        await managed.process.wait()
        await self.publish("process.finished", {"id": process_id, "state": state, "returnCode": managed.process.returncode})

    async def output(self, process_id: str) -> tuple[list[str], bool, int | None]:
        managed = self._processes.get(process_id)
        if managed is None:
            raise AppError(404, "PROCESS_NOT_FOUND", "The process was not found")
        return managed.output, managed.process.returncode is None, managed.process.returncode

    async def stop_process(self, process_id: str) -> None:
        managed = self._processes.get(process_id)
        if managed is None:
            raise AppError(404, "PROCESS_NOT_FOUND", "The process was not found")
        if managed.process.returncode is None:
            managed.process.terminate()
            await managed.process.wait()
        if self._native_process_id == process_id:
            self._native_process_id = None

    def subscribe(self) -> asyncio.Queue[dict[str, object]]:
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, object]]) -> None:
        self._subscribers.discard(queue)

    async def publish(self, event_type: str, payload: dict[str, object]) -> None:
        event = {"type": event_type, "payload": payload}
        for queue in tuple(self._subscribers):
            await queue.put(event)


orchestrator = Orchestrator()