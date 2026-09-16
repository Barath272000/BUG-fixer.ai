"""Mirrors: backend/src/modules/analysis/analysis.service.ts"""
from datetime import datetime, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.errors.app_error import AppError
from app.models.analysis import AnalysisRun, PipelineLog, PipelinePhase
from app.models.bug import Bug
from app.models.enums import AnalysisStatus, BugStatus, ProjectStatus
from app.models.project import Project
from app.modules.analysis.phase_manager import PIPELINE_DEFINITIONS


async def _assert_project_access(db: AsyncSession, owner_id: str, project_id: str) -> Project:
    stmt = select(Project).where(Project.id == project_id, Project.ownerId == owner_id)
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise AppError(404, "PROJECT_NOT_FOUND", "Project was not found")
    return project


async def create_analysis(db: AsyncSession, owner_id: str, project_id: str) -> AnalysisRun:
    await _assert_project_access(db, owner_id, project_id)

    run = AnalysisRun(projectId=project_id, requestedBy=owner_id)
    db.add(run)
    await db.flush()  # get run.id before creating phases

    for p in PIPELINE_DEFINITIONS:
        db.add(
            PipelinePhase(
                analysisRunId=run.id,
                number=p["number"],
                name=p["name"],
                description=p["description"],
            )
        )

    project = await db.get(Project, project_id)
    project.status = ProjectStatus.ANALYZING

    await db.commit()
    await db.refresh(run)

    # Enqueue the pipeline job. STUB: worker only accepts the job right now;
    # see app/workers/celery_app.py for the note on what's pending.
    try:
        from app.workers.celery_app import run_analysis_task

        run_analysis_task.delay(run.id, project_id, owner_id)
    except Exception:
        pass  # Celery broker may not be reachable in dev without `docker-compose up redis`

    return run


async def get_analysis(db: AsyncSession, owner_id: str, analysis_id: str) -> AnalysisRun:
    stmt = (
        select(AnalysisRun)
        .join(Project, AnalysisRun.projectId == Project.id)
        .where(AnalysisRun.id == analysis_id, Project.ownerId == owner_id)
        .options(selectinload(AnalysisRun.phases))
    )
    run = (await db.execute(stmt)).scalar_one_or_none()
    if run is None:
        raise AppError(404, "ANALYSIS_NOT_FOUND", "Analysis run was not found")
    return run


async def list_logs(
    db: AsyncSession,
    owner_id: str,
    analysis_id: str,
    phase_number: int | None = None,
    limit: int = 1000,
) -> list[PipelineLog]:
    """Real log lines for the Inspector modal's Terminal / Raw Logs tab.

    Reuses get_analysis's ownership join (raises 404 if the run doesn't exist
    or doesn't belong to owner_id) instead of duplicating that check here.
    `phase_number` is the 1-8 phase number the frontend already works with
    (PipelinePhase.number), not the phase's internal uuid — we resolve it to
    the uuid ourselves since PipelineLog.phaseId stores the uuid.
    """
    await get_analysis(db, owner_id, analysis_id)

    stmt = select(PipelineLog).where(PipelineLog.analysisRunId == analysis_id)

    if phase_number is not None:
        phase_stmt = select(PipelinePhase.id).where(
            PipelinePhase.analysisRunId == analysis_id, PipelinePhase.number == phase_number
        )
        phase_id = (await db.execute(phase_stmt)).scalar_one_or_none()
        if phase_id is None:
            return []
        stmt = stmt.where(PipelineLog.phaseId == phase_id)

    stmt = stmt.order_by(PipelineLog.timestamp.asc()).limit(limit)
    return (await db.execute(stmt)).scalars().all()


async def list_analyses(db: AsyncSession, owner_id: str, project_id: str) -> list[AnalysisRun]:
    await _assert_project_access(db, owner_id, project_id)
    stmt = (
        select(AnalysisRun)
        .where(AnalysisRun.projectId == project_id)
        .order_by(AnalysisRun.createdAt.desc())
        .limit(100)
        .options(selectinload(AnalysisRun.phases))
    )
    return (await db.execute(stmt)).scalars().all()


async def cancel_analysis(db: AsyncSession, owner_id: str, analysis_id: str) -> AnalysisRun:
    run = await get_analysis(db, owner_id, analysis_id)
    if run.status in (AnalysisStatus.COMPLETED, AnalysisStatus.FAILED, AnalysisStatus.CANCELLED):
        return run
    run.status = AnalysisStatus.CANCELLED
    run.completedAt = datetime.now(timezone.utc)
    run.errorMessage = "Cancelled by user"
    await db.commit()
    await db.refresh(run)
    return run


async def list_recent_analyses(db: AsyncSession, owner_id: str, limit: int = 20) -> dict:
    stmt = (
        select(AnalysisRun)
        .join(Project, AnalysisRun.projectId == Project.id)
        .where(Project.ownerId == owner_id)
        .order_by(AnalysisRun.createdAt.desc())
        .limit(limit)
        .options(selectinload(AnalysisRun.project), selectinload(AnalysisRun.bugs))
    )
    runs = (await db.execute(stmt)).scalars().all()

    items = []
    for run in runs:
        bugs_found = len(run.bugs)
        bugs_fixed = sum(1 for b in run.bugs if b.status in (BugStatus.Fixed, BugStatus.Closed))
        duration_ms = None
        if run.startedAt and run.completedAt:
            duration_ms = int((run.completedAt - run.startedAt).total_seconds() * 1000)
        items.append(
            {
                "id": run.id,
                "projectId": run.projectId,
                "projectName": run.project.name,
                "status": run.status,
                "startedAt": run.startedAt,
                "completedAt": run.completedAt,
                "createdAt": run.createdAt,
                "durationMs": duration_ms,
                "bugsFound": bugs_found,
                "bugsFixed": bugs_fixed,
            }
        )

    total_runs = (
        await db.execute(
            select(func.count()).select_from(AnalysisRun).join(Project).where(Project.ownerId == owner_id)
        )
    ).scalar_one()
    fixed = (
        await db.execute(
            select(func.count())
            .select_from(AnalysisRun)
            .join(Project)
            .where(Project.ownerId == owner_id, AnalysisRun.status == AnalysisStatus.COMPLETED)
        )
    ).scalar_one()
    failed = (
        await db.execute(
            select(func.count())
            .select_from(AnalysisRun)
            .join(Project)
            .where(Project.ownerId == owner_id, AnalysisRun.status == AnalysisStatus.FAILED)
        )
    ).scalar_one()

    return {"items": items, "stats": {"totalRuns": total_runs, "fixed": fixed, "failed": failed}}


async def count_analysis_runs(db: AsyncSession, owner_id: str, project_id: str) -> int:
    await _assert_project_access(db, owner_id, project_id)
    return (
        await db.execute(
            select(func.count()).select_from(AnalysisRun).where(AnalysisRun.projectId == project_id)
        )
    ).scalar_one()


async def clear_analysis_runs(db: AsyncSession, owner_id: str, project_id: str) -> int:
    """Deletes every AnalysisRun (pipeline execution) for a project — this is
    what the Dashboard's "Recent Runs" panel and the header's run/phase
    counters read from.

    FK cascades take care of the rest: PipelineLog and PipelinePhase rows
    (ondelete=CASCADE) and each run's recorded TestRun results
    (ondelete=CASCADE) go with it. Bug and FixProposal rows are NOT deleted —
    their analysisRunId FK is ondelete=SET NULL, so bugs/fixes survive with
    their "which run found this" link cleared. Clear those separately via
    clear_bugs()/clear_fix_history() if that's also wanted.
    """
    await _assert_project_access(db, owner_id, project_id)
    count = (
        await db.execute(
            select(func.count()).select_from(AnalysisRun).where(AnalysisRun.projectId == project_id)
        )
    ).scalar_one()
    await db.execute(delete(AnalysisRun).where(AnalysisRun.projectId == project_id))
    await db.commit()
    return count


async def clear_all_analysis_runs(db: AsyncSession, owner_id: str) -> int:
    """Deletes every analysis run visible in the Dashboard's Recent Runs panel."""
    project_ids = select(Project.id).where(Project.ownerId == owner_id)
    count = (
        await db.execute(
            select(func.count()).select_from(AnalysisRun).where(AnalysisRun.projectId.in_(project_ids))
        )
    ).scalar_one()
    await db.execute(delete(AnalysisRun).where(AnalysisRun.projectId.in_(project_ids)))
    await db.commit()
    return count
