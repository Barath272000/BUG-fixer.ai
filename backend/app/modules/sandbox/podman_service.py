"""Mirrors: backend/src/modules/sandbox/docker.service.ts

Renamed from docker_service.py now that the sandbox runs on Podman."""
from app.modules.sandbox.container_manager import CommandResult, execute_in_podman


async def podman_execute(
    workspace: str,
    command: str,
    language: str | None = None,
    network: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> CommandResult:
    return await execute_in_podman(workspace, command, language, network=network, extra_env=extra_env)
