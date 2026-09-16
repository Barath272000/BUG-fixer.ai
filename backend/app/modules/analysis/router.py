"""Mirrors: backend/src/modules/analysis/{analysis.routes,analysis.controller}.ts"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.middleware.auth import AuthUser, require_auth
from app.db.session import get_db
from app.modules.analysis.schemas import (
    AnalysisRunDetailOut,
    AnalysisRunOut,
    PipelineLogOut,
    RecentAnalysisResponse,
)
from app.modules.analysis.service import (
    cancel_analysis,
    clear_all_analysis_runs,
    clear_analysis_runs,
    count_analysis_runs,
    create_analysis,
    get_analysis,
    list_analyses,
    list_logs,
    list_recent_analyses,
)

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.get("/recent", response_model=RecentAnalysisResponse)
async def recent(
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    result = await list_recent_analyses(db, current_user.id)
    return result


@router.delete("/recent")
async def clear_recent(
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    """Deletes all analysis history shown by the Dashboard's Recent Runs panel."""
    count = await clear_all_analysis_runs(db, current_user.id)
    return {"deleted": count}


@router.post("/projects/{project_id}/run", response_model=AnalysisRunOut, status_code=202)
async def create(
    project_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    run = await create_analysis(db, current_user.id, project_id)
    return AnalysisRunOut.model_validate(run)


@router.get("/projects/{project_id}", response_model=list[AnalysisRunOut])
async def list_(
    project_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    runs = await list_analyses(db, current_user.id, project_id)
    return [AnalysisRunOut.model_validate(r) for r in runs]


@router.get("/projects/{project_id}/count")
async def count(
    project_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    count = await count_analysis_runs(db, current_user.id, project_id)
    return {"count": count}


@router.delete("/projects/{project_id}")
async def clear(
    project_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    """Deletes a project's analysis run history — what the Dashboard's
    "Recent Runs" panel reads from. Bugs/fixes are kept (see
    clear_analysis_runs docstring); their recorded test results go with
    the run since TestRun.analysisRunId cascades."""
    count = await clear_analysis_runs(db, current_user.id, project_id)
    return {"deleted": count}


@router.get("/{analysis_id}", response_model=AnalysisRunDetailOut)
async def get(
    analysis_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    run = await get_analysis(db, current_user.id, analysis_id)
    return AnalysisRunDetailOut.model_validate(run)


@router.get("/{analysis_id}/logs", response_model=list[PipelineLogOut])
async def logs(
    analysis_id: str,
    phase: int | None = Query(default=None, description="Filter to one phase by its number (1-8)"),
    limit: int = Query(default=1000, le=5000),
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    rows = await list_logs(db, current_user.id, analysis_id, phase_number=phase, limit=limit)
    return [PipelineLogOut.model_validate(r) for r in rows]


@router.post("/{analysis_id}/cancel", response_model=AnalysisRunOut)
async def cancel(
    analysis_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    run = await cancel_analysis(db, current_user.id, analysis_id)
    return AnalysisRunOut.model_validate(run)
