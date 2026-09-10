"""Mirrors: backend/src/modules/sandbox/container-manager.ts

Uses the `docker` CLI directly (matching the Node implementation's
child_process.spawn call) rather than the Python docker SDK, so behavior
and flags line up exactly. Requires the `docker` CLI to be available and
/var/run/docker.sock to be mounted into whatever process runs this
(see Dockerfile.worker, which installs docker.io and expects the socket
mount from docker-compose.yml).
"""
import asyncio
import time
from dataclasses import dataclass

from app.modules.sandbox.resource_limits import sandbox_limits
from app.modules.sandbox.sandbox_images import image_for_language


@dataclass
class CommandResult:
    code: int
    stdout: str
    stderr: str
    duration_ms: int


async def execute_in_docker(workspace: str, command: str, language: str | None = None) -> CommandResult:
    image = image_for_language(language)
    args = [
        "docker", "run", "--rm",
        "--network", sandbox_limits.network,
        "--cpus", str(sandbox_limits.cpu),
        "--memory", sandbox_limits.memory,
        "--pids-limit", str(sandbox_limits.pids),
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--user", "10001:10001",
        "-e", "PYTHONDONTWRITEBYTECODE=1",
        "-v", f"{workspace}:/workspace:rw",
        "-w", "/workspace",
        image,
        "/bin/sh", "-lc", command,
    ]

    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    timeout_s = sandbox_limits.timeout_ms / 1000
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        duration_ms = int((time.monotonic() - started) * 1000)
        return CommandResult(
            code=proc.returncode if proc.returncode is not None else 1,
            stdout=stdout_b.decode(errors="replace"),
            stderr=stderr_b.decode(errors="replace"),
            duration_ms=duration_ms,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        duration_ms = int((time.monotonic() - started) * 1000)
        return CommandResult(
            code=124,
            stdout="",
            stderr="Sandbox timed out",
            duration_ms=duration_ms,
        )
