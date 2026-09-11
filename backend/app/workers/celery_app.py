"""
Mirrors: backend/src/jobs/queue.ts + jobs/analysis.worker.ts (BullMQ -> Celery)

run_analysis_task now actually executes the pipeline (see
app/modules/analysis/pipeline_runner.py) instead of just logging a stub
warning. Celery tasks are sync by design, so this wraps the async pipeline
runner with asyncio.run() and opens its own DB session directly (Celery
workers don't have access to FastAPI's request-scoped `get_db` dependency).
"""
import asyncio

import structlog
from celery import Celery

from app.core.config import settings

celery_app = Celery("bugfixai", broker=settings.REDIS_URL, backend=settings.REDIS_URL)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)

logger = structlog.get_logger(__name__)


async def _run(analysis_id: str, project_id: str) -> None:
    # Imported inside the function so `celery -A app.workers.celery_app worker`
    # doesn't need the full app import graph (models, gateway, etc.) just to
    # start up and register tasks.
    from app.common.websocket.realtime_gateway import RealtimeGateway
    from app.db.session import AsyncSessionLocal, engine
    from app.modules.analysis.pipeline_runner import run_analysis_pipeline

    gateway = RealtimeGateway()
    try:
        async with AsyncSessionLocal() as db:
            await run_analysis_pipeline(db, gateway, analysis_id, project_id)
    finally:
        await engine.dispose()

@celery_app.task(name="analysis.run")
def run_analysis_task(analysis_id: str, project_id: str, owner_id: str) -> None:
    logger.info("run_analysis_task_started", analysis_id=analysis_id, project_id=project_id)
    try:
        asyncio.run(_run(analysis_id, project_id))
        logger.info("run_analysis_task_completed", analysis_id=analysis_id)
    except Exception as exc:  # noqa: BLE001
        # The pipeline runner already marks the AnalysisRun/Project as FAILED
        # with errorMessage before re-raising, so this is just for worker logs.
        logger.error("run_analysis_task_failed", analysis_id=analysis_id, error=str(exc))
        raise