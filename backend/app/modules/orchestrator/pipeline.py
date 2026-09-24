import asyncio
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.common.errors.app_error import AppError
from app.core.config import settings
from app.modules.sandbox.sandbox_images import image_for_language
from app.modules.sandbox.resource_limits import sandbox_limits


@dataclass
class PipelineRun:
    id: str
    container_name: str
    snapshot_root: str
    container_port: int
    host_port: int


class PipelineManager:
    def __init__(self) -> None:
        self._runs: dict[str, PipelineRun] = {}

    @staticmethod
    def _copy_snapshot(run_id: str) -> str:
        source = Path(settings.LIVE_WORKSPACE_ROOT).resolve()
        tmpfs_root = Path(settings.PIPELINE_TMPFS_ROOT).resolve()
        if tmpfs_root != Path("/dev/shm") and Path("/dev/shm") not in tmpfs_root.parents:
            raise AppError(500, "PIPELINE_TMPFS_REQUIRED", "Pipeline staging must be located under /dev/shm")
        destination = tmpfs_root / run_id
        if not source.is_dir():
            raise AppError(422, "LIVE_WORKSPACE_MISSING", "The live workspace root does not exist")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            source,
            destination,
            ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", "__pycache__"),
        )
        return str(destination)

    async def _command(self, *args: str, capture_stderr: bool = True) -> tuple[int, str, str]:
        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE if capture_stderr else asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError as exc:
            raise AppError(503, "PODMAN_UNAVAILABLE", "Rootless Podman is not installed or is not on PATH") from exc
        stdout, stderr = await process.communicate()
        return process.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")

    async def start(self, command: str, language: str, container_port: int, env: dict[str, str]) -> PipelineRun:
        run_id = uuid.uuid4().hex
        snapshot_root = await asyncio.to_thread(self._copy_snapshot, run_id)
        container_name = f"agis-pipeline-{run_id[:12]}"
        image = image_for_language(language)
        args = [
            "podman",
            "run",
            "--detach",
            "--rm",
            "--name",
            container_name,
            "--network",
            "slirp4netns:allow_host_loopback=true",
            "--publish",
            f"127.0.0.1::{container_port}",
            "--cpus",
            str(sandbox_limits.cpu),
            "--memory",
            sandbox_limits.memory,
            "--pids-limit",
            str(sandbox_limits.pids),
            "--userns",
            "keep-id",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=256m",
            "--volume",
            f"{snapshot_root}:/workspace:Z",
            "--workdir",
            "/workspace",
        ]
        for key, value in env.items():
            args.extend(("--env", f"{key}={value}"))
        args.extend((image, "/bin/sh", "-lc", command))

        try:
            code, _, error = await self._command(*args)
            if code != 0:
                raise AppError(502, "PIPELINE_START_FAILED", error.strip() or "Podman failed to start the pipeline")
            code, output, error = await self._command("podman", "port", container_name, str(container_port))
            if code != 0 or not output.strip():
                raise AppError(502, "PIPELINE_PORT_FAILED", error.strip() or "Podman did not publish the pipeline port")
            host_port = int(output.strip().splitlines()[-1].rsplit(":", 1)[-1])
        except Exception:
            await self._stop_container(container_name)
            await asyncio.to_thread(shutil.rmtree, snapshot_root, True)
            raise

        run = PipelineRun(run_id, container_name, snapshot_root, container_port, host_port)
        self._runs[run_id] = run
        return run

    async def _stop_container(self, container_name: str) -> None:
        try:
            await self._command("podman", "stop", "--time", "2", container_name)
        except AppError:
            return

    async def stop(self, run_id: str) -> None:
        run = self._runs.pop(run_id, None)
        if run is None:
            raise AppError(404, "PIPELINE_NOT_FOUND", "The pipeline run was not found")
        await self._stop_container(run.container_name)
        await asyncio.to_thread(shutil.rmtree, run.snapshot_root, True)

    async def shutdown(self) -> None:
        for run_id in tuple(self._runs):
            await self.stop(run_id)

    def target(self, run_id: str) -> str:
        run = self._runs.get(run_id)
        if run is None:
            raise AppError(404, "PIPELINE_NOT_FOUND", "The pipeline run was not found")
        return f"http://127.0.0.1:{run.host_port}"

    def get(self, run_id: str) -> PipelineRun:
        run = self._runs.get(run_id)
        if run is None:
            raise AppError(404, "PIPELINE_NOT_FOUND", "The pipeline run was not found")
        return run


pipeline_manager = PipelineManager()