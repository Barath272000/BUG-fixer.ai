"""Persistent shell sessions for the Workspace IDE.

Each session's shell runs inside a long-running, rootless Podman container
-- one container per workspace, shared across every terminal tab open for
that project (see start_workspace_container in sandbox/container_manager.py)
-- instead of directly on the API host. Previously this spawned /bin/bash
straight on the host via asyncio.create_subprocess_exec, so anything typed
into the in-app terminal ran with the host process's own privileges and
filesystem access; this was the last unsandboxed entry point in the
Workspace IDE (the one-shot `/exec` endpoint already goes through
execute_in_podman via sandbox_service.run_sandbox). The workspace is still
bind-mounted at the same path used by the Workspace API, so file changes
are shared immediately.

Container lifecycle: refcounted per workspace. The container is started
lazily on the first terminal session for a project and stopped only once
the last terminal session for that project has been closed, so closing one
tab doesn't kill a shell still in use in another tab.
"""
from __future__ import annotations

import asyncio
import hashlib
import uuid
from dataclasses import dataclass, field

from app.modules.sandbox.container_manager import (
    is_container_running,
    start_workspace_container,
    stop_preview_container,
)


def _container_name(workspace: str) -> str:
    digest = hashlib.sha1(workspace.encode()).hexdigest()[:12]
    return f"bugfixai-term-{digest}"


_PORT_SCAN_SCRIPT = (
    "for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do "
    "cmd=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null); "
    "[ -z \"$cmd\" ] && continue; "
    "for fd in /proc/$pid/fd/*; do "
    "target=$(readlink \"$fd\" 2>/dev/null) || continue; "
    "case \"$target\" in socket:*) printf '%s\\t%s\\t%s\\n' \"$pid\" \"$cmd\" \"$target\" ;; esac; "
    "done; done; "
    "echo '__TCP__'; cat /proc/net/tcp 2>/dev/null"
)


@dataclass
class TerminalSession:
    id: str
    workspace: str
    process: asyncio.subprocess.Process
    chunks: list[str] = field(default_factory=list)
    reader_task: asyncio.Task[None] | None = None


class TerminalManager:
    def __init__(self) -> None:
        self._sessions: dict[str, TerminalSession] = {}
        self._lock = asyncio.Lock()
        self._refcounts: dict[str, int] = {}  # container name -> active session count

    async def start(self, workspace: str, shell: str = "bash", language: str | None = None) -> TerminalSession:
        if shell not in {"bash", "sh"}:
            raise ValueError("Unsupported shell")

        container = _container_name(workspace)
        started = await start_workspace_container(workspace, container, language)
        if not started.get("ok"):
            raise RuntimeError(started.get("error") or "Failed to start sandbox container")

        shell_args = [f"/bin/{shell}", "-i"] if shell == "sh" else [f"/bin/{shell}", "--noprofile", "--norc", "-i"]
        process = await asyncio.create_subprocess_exec(
            "podman", "exec", "-i",
            "-e", "HOME=/tmp",
            "-e", "TERM=xterm-256color",
            "-e", "PS1=",
            "-e", "PROMPT_COMMAND=",
            "--workdir", "/workspace",
            container,
            *shell_args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        session = TerminalSession(id=str(uuid.uuid4()), workspace=workspace, process=process)
        session.reader_task = asyncio.create_task(self._read_output(session))
        async with self._lock:
            self._sessions[session.id] = session
            self._refcounts[container] = self._refcounts.get(container, 0) + 1
        await self.write(session.id, "export PS1='' PROMPT_COMMAND=''; printf '\\n[terminal-ready]\\n'")
        return session

    async def _read_output(self, session: TerminalSession) -> None:
        assert session.process.stdout is not None
        while True:
            data = await session.process.stdout.read(4096)
            if not data:
                break
            session.chunks.append(data.decode(errors="replace"))
        if session.process.returncode is None:
            await session.process.wait()

    async def get(self, session_id: str) -> TerminalSession | None:
        async with self._lock:
            return self._sessions.get(session_id)

    async def list_for_workspace(self, workspace: str) -> list[dict[str, int | str | bool]]:
        async with self._lock:
            sessions = [session for session in self._sessions.values() if session.workspace == workspace]
        return [
            {
                "id": session.id,
                "pid": session.process.pid,
                "running": session.process.returncode is None,
            }
            for session in sessions
        ]

    async def listening_ports(self, workspace: str) -> list[dict[str, int | str]]:
        container = _container_name(workspace)
        if not await is_container_running(container):
            return []
        proc = await asyncio.create_subprocess_exec(
            "podman", "exec", container, "sh", "-c", _PORT_SCAN_SCRIPT,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out_b, _ = await proc.communicate()
        if proc.returncode != 0:
            return []
        return await asyncio.to_thread(self._parse_listening_ports, out_b.decode(errors="replace"), workspace)

    @staticmethod
    def _parse_listening_ports(raw: str, workspace: str) -> list[dict[str, int | str]]:
        proc_lines: list[str] = []
        tcp_lines: list[str] = []
        target_list = proc_lines
        for line in raw.splitlines():
            if line == "__TCP__":
                target_list = tcp_lines
                continue
            target_list.append(line)

        inode_to_process: dict[str, tuple[int, str]] = {}
        for line in proc_lines:
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            pid_s, cmd, target = parts
            if not target.startswith("socket:["):
                continue
            inode_to_process[target[8:-1]] = (int(pid_s), cmd or "unknown")

        ports: list[dict[str, int | str]] = []
        for line in tcp_lines[1:]:  # skip /proc/net/tcp header
            fields = line.split()
            if len(fields) < 10 or fields[3] != "0A":
                continue
            port = int(fields[1].rsplit(":", 1)[1], 16)
            process = inode_to_process.get(fields[9])
            if not process:
                continue
            pid, command = process
            ports.append({"port": port, "pid": pid, "command": command, "source": workspace})
        return sorted(ports, key=lambda item: int(item["port"]))

    async def write(self, session_id: str, data: str) -> None:
        session = await self.get(session_id)
        if session is None or session.process.returncode is not None or session.process.stdin is None:
            raise KeyError(session_id)
        session.process.stdin.write(data.encode())
        await session.process.stdin.drain()

    async def interrupt(self, session_id: str) -> None:
        await self.write(session_id, "\x03")

    async def output(self, session_id: str, after: int = 0) -> tuple[list[str], int, bool]:
        session = await self.get(session_id)
        if session is None:
            raise KeyError(session_id)
        start = max(0, after)
        return session.chunks[start:], len(session.chunks), session.process.returncode is None

    async def stop(self, session_id: str) -> None:
        session = await self.get(session_id)
        if session is None:
            return
        if session.process.returncode is None:
            session.process.terminate()
            try:
                await asyncio.wait_for(session.process.wait(), timeout=2)
            except asyncio.TimeoutError:
                session.process.kill()
                await session.process.wait()
        if session.reader_task:
            session.reader_task.cancel()

        container = _container_name(session.workspace)
        async with self._lock:
            self._sessions.pop(session_id, None)
            remaining = self._refcounts.get(container, 1) - 1
            if remaining <= 0:
                self._refcounts.pop(container, None)
            else:
                self._refcounts[container] = remaining

        if remaining <= 0:
            await stop_preview_container(container)  # generic `podman stop`, name-agnostic despite the name


terminal_manager = TerminalManager()
