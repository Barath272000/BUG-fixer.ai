"""Mirrors: backend/src/jobs/analysis.worker.ts

This is the real pipeline execution logic, called by the Celery task in
app/workers/celery_app.py. Runs all 8 phases for real:
  1. Input   - extract uploaded archive into a workspace (GitHub clone: see note below)
  2. Setup   - detect language/framework
  3. Sandbox - (implicit; sandbox is created per-command by the Sandbox module)
  4. Build   - run detected build command in the sandbox
  5. Test    - run detected test command, parse results, persist TestRun
  6. Errors  - record build/test failures as ErrorRecord rows
  7. AI Diagnosis - not run automatically here; triggered on-demand via
     POST /fixes/generate for a specific bug (matches the Node version's
     design: AI diagnosis is bug-scoped, not run blindly for the whole project)
  8. AI Patch - same as above, via POST /fixes/{id}/apply

HONEST GAP: GitHub-sourced projects (sourceType == GITHUB) will fail with a
clear error here — repository cloning + GitHub OAuth token storage
(git.service.ts / integrations/github/github.service.ts) haven't been
ported yet. ZIP-uploaded projects work end to end.
"""
import os
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.websocket.realtime_gateway import REALTIME_EVENTS, RealtimeGateway
from app.models.analysis import AnalysisRun, PipelinePhase
from app.models.context import Workspace
from app.models.enums import AnalysisStatus, PhaseStatus, ProjectStatus, SourceType
from app.models.fix import TestRun
from app.models.project import Project
from app.modules.analysis.detectors import detect_build_command, detect_test_command
from app.modules.analysis.phase_manager import PIPELINE_DEFINITIONS
from app.modules.analysis.pipeline_service import add_log
from app.modules.code_analysis.project_inspector import inspect_project
from app.modules.bugs.service import create_bug_from_error
from app.modules.errors.error_collector import record_error
from app.modules.errors.test_result_parser import parse_generic_test_output
from app.modules.sandbox.sandbox_service import run_sandbox
from app.modules.uploads.zip_extractor import extract_archive


class PipelineError(Exception):
    pass


async def _set_phase_status(db: AsyncSession, phase: PipelinePhase, status: PhaseStatus) -> None:
    now = datetime.now(timezone.utc)
    phase.status = status
    if status == PhaseStatus.RUNNING:
        phase.startedAt = now
    else:
        phase.completedAt = now
        if phase.startedAt:
            phase.durationMs = int((now - phase.startedAt.replace(tzinfo=timezone.utc)).total_seconds() * 1000)
    await db.commit()
    await db.refresh(phase)


async def run_analysis_pipeline(db: AsyncSession, gateway: RealtimeGateway, analysis_id: str, project_id: str) -> None:
    run_stmt = (
        select(AnalysisRun)
        .where(AnalysisRun.id == analysis_id)
    )
    run = (await db.execute(run_stmt)).scalar_one_or_none()
    if run is None:
        raise PipelineError("Analysis run not found")

    project = await db.get(Project, project_id)
    if project is None:
        raise PipelineError("Project not found")

    phases_stmt = select(PipelinePhase).where(PipelinePhase.analysisRunId == analysis_id)
    phases = {p.number: p for p in (await db.execute(phases_stmt)).scalars().all()}

    run.status = AnalysisStatus.RUNNING
    run.startedAt = datetime.now(timezone.utc)
    await db.commit()

    await gateway.publish(
        project_id,
        {"type": "analysis.started", "projectId": project_id, "analysisId": analysis_id, "payload": {"analysisId": analysis_id}},
    )

    work_root = os.path.abspath(os.path.join("sandbox-work", project_id, analysis_id))

    try:
        os.makedirs(work_root, exist_ok=True)

        for definition in PIPELINE_DEFINITIONS:
            phase = phases.get(definition["number"])
            if phase is None:
                raise PipelineError(f"Missing pipeline phase {definition['number']}")

            await _set_phase_status(db, phase, PhaseStatus.RUNNING)
            await gateway.publish(
                project_id,
                {"type": REALTIME_EVENTS["phase_started"], "projectId": project_id, "analysisId": analysis_id,
                 "payload": {"id": phase.id, "number": phase.number, "status": phase.status}},
            )
            await add_log(db, gateway, analysis_id, project_id, "INFO", definition["name"],
                          f"Starting {definition['name']}", phase.id)

            # Phase 1: extract/clone project source
            if definition["number"] == 1:
                if project.sourceType == SourceType.GITHUB:
                    raise PipelineError(
                        "GitHub-sourced projects aren't supported yet in this build — "
                        "the GitHub integration module hasn't been ported. Upload a ZIP instead."
                    )
                if not project.sourcePath:
                    raise PipelineError("Project source archive is missing")
                await extract_archive(project.sourcePath, work_root)

                project.workspacePath = work_root
                ws_stmt = select(Workspace).where(Workspace.projectId == project_id)
                workspace = (await db.execute(ws_stmt)).scalar_one_or_none()
                if workspace:
                    workspace.rootPath = work_root
                else:
                    db.add(Workspace(projectId=project_id, rootPath=work_root))
                await db.commit()

            # Phase 2: detect language/framework
            if definition["number"] == 2:
                inspection = await inspect_project(work_root)
                project.language = inspection["language"]
                project.framework = inspection["framework"]
                await db.commit()
                await add_log(db, gateway, analysis_id, project_id, "PASS", "Project Setup",
                              f"Detected {inspection['language']} with {inspection['framework']}", phase.id)

            # Phase 4: build
            if definition["number"] == 4:
                language = project.language or "Unknown"
                command = await detect_build_command(work_root, language)
                result = await run_sandbox(work_root, command, language)

                if result.code != 0:
                    error = await record_error(
                        db, project_id, f"Build command failed: {command}",
                        analysis_run_id=analysis_id, name="BuildError", stack_trace=result.stderr,
                    )
                    await create_bug_from_error(db, project, error)
                    raise PipelineError(f"Build failed: {result.stderr[:2000]}")

                await add_log(db, gateway, analysis_id, project_id, "PASS", "Install & Build",
                              f"Build succeeded with {command}", phase.id)

            # Phase 5: test
            if definition["number"] == 5:
                language = project.language or "Unknown"
                command = await detect_test_command(work_root, language)
                result = await run_sandbox(work_root, command, language)
                summary = parse_generic_test_output(result.stdout, result.stderr, result.code)

                db.add(TestRun(
                    projectId=project_id, analysisRunId=analysis_id, command=command,
                    status=summary.status, total=summary.total, passed=summary.passed,
                    failed=summary.failed, skipped=summary.skipped, durationMs=result.duration_ms,
                    stdout=result.stdout[:100000], stderr=result.stderr[:100000],
                ))
                await db.commit()

                if result.code != 0:
                    error = await record_error(
                        db, project_id, f"Test command failed: {command}",
                        analysis_run_id=analysis_id, name="TestFailure", stack_trace=result.stderr,
                    )
                    await create_bug_from_error(db, project, error)

            await _set_phase_status(db, phase, PhaseStatus.COMPLETED)
            await gateway.publish(
                project_id,
                {"type": REALTIME_EVENTS["phase_progress"], "projectId": project_id, "analysisId": analysis_id,
                 "payload": {"id": phase.id, "number": phase.number, "status": phase.status}},
            )
            await add_log(db, gateway, analysis_id, project_id, "PASS", definition["name"],
                          f"{definition['name']} completed", phase.id)

        run.status = AnalysisStatus.COMPLETED
        run.completedAt = datetime.now(timezone.utc)
        project.status = ProjectStatus.READY
        await db.commit()

        await gateway.publish(
            project_id,
            {"type": "analysis.completed", "projectId": project_id, "analysisId": analysis_id, "payload": {"analysisId": analysis_id}},
        )

    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        run.status = AnalysisStatus.FAILED
        run.completedAt = datetime.now(timezone.utc)
        run.errorMessage = message
        project.status = ProjectStatus.FAILED
        await db.commit()

        await gateway.publish(
            project_id,
            {"type": "analysis.failed", "projectId": project_id, "analysisId": analysis_id, "payload": {"message": message}},
        )
        raise