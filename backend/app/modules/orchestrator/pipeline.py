import asyncio
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.common.errors.app_error import AppError
from app.core.config import settings
from app.modules.sandbox.resource_limits import sandbox_limits
from app.modules.sandbox.sandbox_images import image_for_language


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
    def _ramdisk_root() -> Path:
        root = Path(settings.PIPELINE_TMPFS_ROOT).resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root

    @staticmethod
    def _snapshot_dir(session_id: str) -> Path:
        return PipelineManager._ramdisk_root() / session_id

    @staticmethod
    def _is_tmpfs_target(path: Path) -> bool:
        resolved = path.resolve()
        for candidate in (Path("/tmp"), Path("/dev/shm"), Path("/run")):
            try:
                resolved.relative_to(candidate)
                return True
            except ValueError:
                continue
        return False

    @classmethod
    def _copy_snapshot(cls, session_id: str, source_root: str | None = None) -> str:
        source = Path(source_root or settings.LIVE_WORKSPACE_ROOT).resolve()
        if not source.is_dir():
            raise AppError(422, "LIVE_WORKSPACE_MISSING", "The live workspace root does not exist")

        tmpfs_root = cls._ramdisk_root()
        if not cls._is_tmpfs_target(tmpfs_root):
            raise AppError(500, "PIPELINE_TMPFS_REQUIRED", "Pipeline staging must live on a tmpfs-backed mount such as /tmp/agis_pipeline_sandboxes")

        destination = tmpfs_root / session_id
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)

        shutil.copytree(
            source,
            destination,
            ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", "__pycache__", ".pytest_cache"),
            dirs_exist_ok=False,
            copy_function=shutil.copy2,
        )
        return str(destination)

    async def sync_snapshot_to_ramdisk(self, session_id: str) -> str:
        return await asyncio.to_thread(self._copy_snapshot, session_id)

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

    async def cleanup_session(self, session_id: str) -> None:
        run = self._runs.get(session_id)
        container_name = run.container_name if run else f"agis-pipeline-{session_id[:12]}"
        snapshot_root = run.snapshot_root if run else str(self._snapshot_dir(session_id))
        try:
            await self._stop_container(container_name)
        finally:
            if snapshot_root and os.path.exists(snapshot_root):
                await asyncio.to_thread(shutil.rmtree, snapshot_root, ignore_errors=True)
            self._runs.pop(session_id, None)

    async def start(self, command: str, language: str, container_port: int, env: dict[str, str]) -> PipelineRun:
        run_id = uuid.uuid4().hex
        snapshot_root = await self.sync_snapshot_to_ramdisk(run_id)
        container_name = f"agis-pipeline-{run_id[:12]}"
        image = image_for_language(language)
        startup = command.strip() or (
            "python -m uvicorn app:app --host 0.0.0.0 --port 8500 --reload --reload-dir /workspace"
        )

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
            "--cap-add=SYS_PTRACE",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=256m",
            "--volume",
            f"{snapshot_root}:/workspace:Z",
            "--workdir",
            "/workspace",
        ]
        if Path("/dev/fuse").exists():
            args.extend(("--device", "/dev/fuse"))
        for key, value in env.items():
            args.extend(("--env", f"{key}={value}"))
        args.extend((image, "/bin/sh", "-lc", startup))

        try:
            code, _, error = await self._command(*args)
            if code != 0:
                raise AppError(502, "PIPELINE_START_FAILED", error.strip() or "Podman failed to start the pipeline")
            code, output, error = await self._command("podman", "port", container_name, str(container_port))
            if code != 0 or not output.strip():
                raise AppError(502, "PIPELINE_PORT_FAILED", error.strip() or "Podman did not publish the pipeline port")
            host_port = int(output.strip().splitlines()[-1].rsplit(":", 1)[-1])
        except Exception:
            await self.cleanup_session(run_id)
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
        await asyncio.to_thread(shutil.rmtree, run.snapshot_root, ignore_errors=True)

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