"""Mirrors: backend/src/modules/bugs/{bug.service,bug.repository}.ts"""
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.errors.app_error import AppError
from app.common.utils.ids import ensure_valid_id
from app.models.bug import Bug
from app.models.enums import BugStatus, Severity
from app.models.fix import FixProposal
from app.models.project import Project
from app.modules.bugs.schemas import CreateBugRequest, UpdateBugRequest


async def _assert_project_access(db: AsyncSession, owner_id: str, project_id: str) -> Project:
    ensure_valid_id(project_id, field="projectId")
    result = await db.execute(
        select(Project).where(Project.id == project_id, Project.ownerId == owner_id)
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise AppError(404, "PROJECT_NOT_FOUND", "Project was not found")
    return project


async def list_bugs(
    db: AsyncSession,
    owner_id: str,
    project_id: str,
    page: int,
    limit: int,
    severity: str | None = None,
    status: str | None = None,
    search: str | None = None,
) -> dict:
    await _assert_project_access(db, owner_id, project_id)

    stmt = select(Bug).where(Bug.projectId == project_id)
    count_stmt = select(func.count()).select_from(Bug).where(Bug.projectId == project_id)

    if severity:
        try:
            sev = Severity(severity)
        except ValueError:
            raise AppError(400, "VALIDATION_ERROR", "Invalid severity value")
        stmt = stmt.where(Bug.severity == sev)
        count_stmt = count_stmt.where(Bug.severity == sev)

    if status:
        try:
            st = BugStatus(status)
        except ValueError:
            raise AppError(400, "VALIDATION_ERROR", "Invalid status value")
        stmt = stmt.where(Bug.status == st)
        count_stmt = count_stmt.where(Bug.status == st)

    if search:
        like = f"%{search}%"
        clause = or_(
            Bug.title.ilike(like),
            Bug.code.ilike(like),
            Bug.component.ilike(like),
            Bug.filePath.ilike(like),
        )
        stmt = stmt.where(clause)
        count_stmt = count_stmt.where(clause)

    stmt = stmt.order_by(Bug.updatedAt.desc()).offset((page - 1) * limit).limit(limit)

    items = (await db.execute(stmt)).scalars().all()
    total = (await db.execute(count_stmt)).scalar_one()

    return {"items": items, "page": page, "limit": limit, "total": total}


async def get_bug(db: AsyncSession, owner_id: str, bug_id: str) -> Bug:
    ensure_valid_id(bug_id, field="bugId")
    stmt = (
        select(Bug)
        .join(Project, Bug.projectId == Project.id)
        .where(Bug.id == bug_id, Project.ownerId == owner_id)
        .options(selectinload(Bug.fixes), selectinload(Bug.occurrences))
    )
    bug = (await db.execute(stmt)).scalar_one_or_none()
    if bug is None:
        raise AppError(404, "BUG_NOT_FOUND", "Bug was not found")
    return bug


async def create_bug(db: AsyncSession, owner_id: str, payload: CreateBugRequest) -> Bug:
    await _assert_project_access(db, owner_id, payload.projectId)

    count = (
        await db.execute(
            select(func.count()).select_from(Bug).where(Bug.projectId == payload.projectId)
        )
    ).scalar_one()
    code = f"BUG-{count + 1:03d}"

    bug = Bug(
        projectId=payload.projectId,
        code=code,
        title=payload.title,
        description=payload.description,
        tags=payload.tags,
        severity=Severity(payload.severity),
        language=payload.language,
        component=payload.component,
        filePath=payload.filePath,
        lineNumber=payload.lineNumber,
        stackTrace=payload.stackTrace,
    )
    db.add(bug)
    await db.commit()
    await db.refresh(bug)
    return bug


async def update_bug(db: AsyncSession, owner_id: str, bug_id: str, payload: UpdateBugRequest) -> Bug:
    bug = await get_bug(db, owner_id, bug_id)
    if payload.status is not None:
        try:
            bug.status = BugStatus(payload.status)
        except ValueError:
            raise AppError(400, "VALIDATION_ERROR", "Invalid status value")
    if payload.severity is not None:
        try:
            bug.severity = Severity(payload.severity)
        except ValueError:
            raise AppError(400, "VALIDATION_ERROR", "Invalid severity value")
    if payload.tags is not None:
        bug.tags = payload.tags
    await db.commit()
    await db.refresh(bug)
    return bug
