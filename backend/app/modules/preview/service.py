"""Preview: runs the uploaded project as a real, reachable web server so the
person can open it in a new browser tab — distinct from the analysis
pipeline's build/test sandbox, which never publishes a port.

Only ever started by an explicit user action (never automatically by the
pipeline), and only for languages/projects where detect_preview() found a
plausible web-server command in Phase 2 of the last analysis run.
"""
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.errors.app_error import AppError
from app.models.project import Project
from app.modules.sandbox.container_manager import start_preview_container, stop_preview_container


def _container_name(project_id: str) -> str:
    return f"bugfixer-preview-{project_id}"


def _public_url(host_port: int) -> str:
    codespace_name = os.environ.get("CODESPACE_NAME")
    forwarding_domain = os.environ.get("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN")
    if codespace_name and forwarding_domain:
        return f"https://{codespace_name}-{host_port}.{forwarding_domain}"
    return f"http://localhost:{host_port}"


async def _assert_project_access(db: AsyncSession, owner_id: str, project_id: str) -> Project:
    stmt = (
        select(Project)
        .where(Project.id == project_id, Project.ownerId == owner_id)
        .options(selectinload(Project.workspace))
    )
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise AppError(404, "PROJECT_NOT_FOUND", "Project was not found")
    return project


async def start_preview(db: AsyncSession, owner_id: str, project_id: str) -> dict:
    project = await _assert_project_access(db, owner_id, project_id)

    if not project.previewCommand or not project.previewPort:
        raise AppError(
            422, "PREVIEW_NOT_SUPPORTED",
            "No runnable web-server command was detected for this project. "
            "Run analysis at least once first — Preview needs Phase 2 (Project Setup) to have run.",
        )
    if project.workspace is None or not project.workspace.rootPath:
        raise AppError(422, "WORKSPACE_MISSING", "This project has no extracted workspace to preview")

    result = await start_preview_container(
        workspace=project.workspace.rootPath,
        command=project.previewCommand,
        language=project.language or "Unknown",
        container_port=project.previewPort,
        name=_container_name(project_id),
    )
    if not result["ok"]:
        raise AppError(
            502, "PREVIEW_START_FAILED",
            f"Preview container failed to start or exited immediately: {result['error'][:500]}",
        )

    return {
        "url": _public_url(result["hostPort"]),
        "command": project.previewCommand,
        "port": project.previewPort,
    }


async def stop_preview(db: AsyncSession, owner_id: str, project_id: str) -> None:
    await _assert_project_access(db, owner_id, project_id)  # ownership check even though nothing else is read
    await stop_preview_container(_container_name(project_id))
