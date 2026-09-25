"""Mirrors: backend/src/modules/sandbox/container-manager.ts

Uses the `podman` CLI directly (previously `docker`) via child_process-style
subprocess calls, matching the conventions already proven out in
app/modules/orchestrator/pipeline.py:

- `--userns keep-id` instead of a hardcoded `--user 10001:10001`. Rootless
  Podman maps the *host user invoking podman* onto a UID inside the
  container; with keep-id that mapping is 1:1, so files the sandbox writes
  into the bind-mounted workspace come back already owned by the host user
  -- no subuid juggling, no chown step, no dependency on any particular UID
  existing inside the sandbox image.
- No Docker-outside-of-Docker style host-path translation
  (there is no more SANDBOX_HOST_ROOT lookup here). Podman is daemonless and
  runs directly as a subprocess of this process, in the same mount
  namespace -- unlike Docker, there's no separate daemon on the other side
  of a socket that might resolve bind-mount sources differently. A path
  that's valid here is valid to Podman too.
- `:Z` on the workspace volume mount, for hosts running SELinux (harmless
  no-op where SELinux isn't enforcing).

Requires the `podman` CLI on PATH and a working rootless setup -- see
.devcontainer/setup-podman.sh and scripts/verify-podman-sandbox.sh.
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


async def start_preview_container(workspace: str, command: str, language: str, container_port: int, name: str) -> dict:
    """Starts a LONG-RUNNING container for the Preview feature.

    Unlike execute_in_podman (one-shot, --rm, --network none), this needs to
    stay alive and accept incoming connections, so it deliberately uses
    rootless user-mode networking (slirp4netns) with the published port
    bound to loopback only, instead of the pipeline's normal "no network"
    sandbox posture. This is a real, intentional exception -- only used when
    the person explicitly clicks Preview, never automatically. Same network
    mode as orchestrator/pipeline.py's long-running pipeline containers, for
    the same reason: rootless Podman has no "bridge" network by default the
    way rootful Docker does.
    """
    image = image_for_language(language)
    await stop_preview_container(name)  # idempotent: replace any previous preview for this project

    args = [
        "podman", "run", "-d", "--rm",
        "--name", name,
        "--network", "slirp4netns:allow_host_loopback=true",
        "--publish", f"127.0.0.1::{container_port}",
        "--cpus", str(sandbox_limits.cpu),
        "--memory", sandbox_limits.memory,
        "--pids-limit", str(sandbox_limits.pids),
        "--userns", "keep-id",
        "-v", f"{workspace}:/workspace:Z",
        "-w", "/workspace",
        image,
        "/bin/sh", "-lc", command,
    ]
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, stderr_b = await proc.communicate()
    if proc.returncode != 0:
        return {"ok": False, "error": stderr_b.decode(errors="replace").strip() or "podman run failed"}

    # Ask Podman which host port it actually assigned to the container's port.
    port_proc = await asyncio.create_subprocess_exec(
        "podman", "port", name, str(container_port),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await port_proc.communicate()
    if port_proc.returncode != 0 or not out_b.strip():
        await stop_preview_container(name)
        return {"ok": False, "error": err_b.decode(errors="replace").strip() or "container exited immediately"}

    # Output looks like "127.0.0.1:34567" (possibly one line per IP family).
    last_line = out_b.decode(errors="replace").strip().splitlines()[-1]
    host_port = int(last_line.rsplit(":", 1)[-1])
    return {"ok": True, "hostPort": host_port, "containerName": name}


async def execute_in_podman(
    workspace: str,
    command: str,
    language: str | None = None,
    network: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> CommandResult:
    """Executes a one-shot sandbox command inside a disposable Podman container.

    network/extra_env let a caller (Phase 8, via a provisioned database
    sidecar -- see sandbox/db_sidecar.py) attach this one-shot container to
    the sidecar's dedicated network and pass it a DATABASE_URL, instead of
    always using the global --network none default. Passing neither keeps
    prior behavior exactly as it was.
    """
    image = image_for_language(language or "python")
    args = [
        "podman", "run", "--rm",
        "--network", network or sandbox_limits.network,
        "--cpus", str(sandbox_limits.cpu),
        "--memory", sandbox_limits.memory,
        "--pids-limit", str(sandbox_limits.pids),
        "--userns", "keep-id",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "-e", "PYTHONDONTWRITEBYTECODE=1",
        "-e", "PYTHONPYCACHEPREFIX=/tmp/pycache",
    ]
    for key, value in (extra_env or {}).items():
        args += ["-e", f"{key}={value}"]
    args += [
        "-v", f"{workspace}:/workspace:Z",
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


async def stop_preview_container(name: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "podman", "stop", "-t", "2", name,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()  # no-op (exit code ignored) if the container doesn't exist


async def is_container_running(name: str) -> bool:
    """Used by Phase 8's automatic app-start health check (not the manual
    Preview feature, which doesn't need this) to tell "started and is still
    up after N seconds" apart from "started, then crashed immediately"."""
    proc = await asyncio.create_subprocess_exec(
        "podman", "inspect", "-f", "{{.State.Running}}", name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out_b, _ = await proc.communicate()
    return proc.returncode == 0 and out_b.decode().strip() == "true"


async def get_container_logs(name: str, tail: int = 200) -> str:
    """Captures real stdout+stderr from a running/just-stopped container --
    used by Phase 8's app-start check to report why a boot crashed, same
    way build/test failures already capture real command output."""
    proc = await asyncio.create_subprocess_exec(
        "podman", "logs", "--tail", str(tail), name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    out_b, _ = await proc.communicate()
    return out_b.decode(errors="replace")
