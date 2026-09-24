"""Persistent shell sessions for the Workspace IDE.

This is the first step toward a full VS Code-style terminal. Sessions live in
memory for the lifetime of the API process; the workspace is mounted at the
same path used by the Workspace API, so file changes are shared immediately.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import dataclass, field


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

    async def start(self, workspace: str, shell: str = "bash") -> TerminalSession:
        if shell not in {"bash", "sh"}:
            raise ValueError("Unsupported shell")
        shell_args = [f"/bin/{shell}", "-i"] if shell == "sh" else [f"/bin/{shell}", "--noprofile", "--norc", "-i"]
        process = await asyncio.create_subprocess_exec(
            *shell_args,
            cwd=workspace,
            env={
                **os.environ,
                "HOME": "/tmp",
                "TERM": "xterm-256color",
                "PS1": "",
                "PROMPT_COMMAND": "",
            },
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        session = TerminalSession(id=str(uuid.uuid4()), workspace=workspace, process=process)
        session.reader_task = asyncio.create_task(self._read_output(session))
        async with self._lock:
            self._sessions[session.id] = session
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
        return await asyncio.to_thread(self._listening_ports, workspace)

    def _listening_ports(self, workspace: str) -> list[dict[str, int | str]]:
        inode_to_process: dict[str, tuple[int, str]] = {}
        for entry in os.listdir('/proc'):
            if not entry.isdigit():
                continue
            pid = int(entry)
            try:
                command = open(f'/proc/{pid}/cmdline', encoding='utf-8').read().replace('\x00', ' ').strip()
                for fd in os.listdir(f'/proc/{pid}/fd'):
                    try:
                        target = os.readlink(f'/proc/{pid}/fd/{fd}')
                    except (FileNotFoundError, PermissionError, OSError):
                        continue
                    if target.startswith('socket:['):
                        inode_to_process[target[8:-1]] = (pid, command or 'unknown')
            except (FileNotFoundError, PermissionError, OSError):
                continue

        ports: list[dict[str, int | str]] = []
        try:
            tcp_lines = open('/proc/net/tcp', encoding='utf-8').read().splitlines()[1:]
        except (FileNotFoundError, PermissionError):
            tcp_lines = []
        for line in tcp_lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != '0A':
                continue
            port = int(fields[1].rsplit(':', 1)[1], 16)
            process = inode_to_process.get(fields[9])
            if not process:
                continue
            pid, command = process
            ports.append({'port': port, 'pid': pid, 'command': command, 'source': workspace})
        return sorted(ports, key=lambda item: int(item['port']))

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
        async with self._lock:
            self._sessions.pop(session_id, None)


terminal_manager = TerminalManager()
