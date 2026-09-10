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
from app.modules.analysis.pipeline_service import add_log, set_security_report, set_subprocesses
from app.modules.code_analysis.project_inspector import inspect_project
from app.modules.bugs.service import create_bug_from_error
from app.modules.errors.error_collector import record_error
from app.modules.errors.test_result_parser import parse_generic_test_output
from app.modules.sandbox.sandbox_service import run_sandbox
from app.modules.uploads.security_scanner import run_security_scan
from app.modules.uploads.zip_extractor import extract_archive
from app.models.context import ContextDocument


class PipelineError(Exception):
    pass


def _command_failure_detail(result) -> str:
    """Combine stdout + stderr into one labeled string for error messages.

    Docker prints image-pull noise ("Unable to find image ... Pulling from
    library/python ... Status: Downloaded newer image") to stderr on a cold
    pull, while the actual tool output (e.g. python -m compileall's
    SyntaxError) goes to stdout. Reading stderr alone shows the Docker noise
    and hides the real error. This surfaces both, stdout first since that's
    almost always where the actual failure detail lives.
    """
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    parts = []
    if stdout:
        parts.append(f"--- stdout ---\n{stdout}")
    if stderr:
        parts.append(f"--- stderr ---\n{stderr}")
    if not parts:
        return "(command produced no output)"
    return "\n".join(parts)


def _zip_phase1_subprocesses() -> list[dict]:
    """Real steps for a local ZIP/TAR upload. Step 0 is already true by the
    time the pipeline reaches Phase 1 — validate_archive() + checksum ran
    during the upload request itself (uploads/service.py)."""
    return [
        {"id": "source_received", "name": "Archive integrity & quota verified", "completed": True, "status": "completed", "category": "upload"},
        {"id": "extract_workspace", "name": "Extract archive into sandbox workspace", "completed": False, "status": "pending", "category": "extract"},
        {"id": "workspace_ready", "name": "Workspace ready for inspection", "completed": False, "status": "pending", "category": "extract"},
    ]


def _github_phase1_subprocesses() -> list[dict]:
    """Real steps for a GitHub-sourced project. None of these are implemented
    in the pipeline yet (see HONEST GAP note above) — shown as a checklist so
    the modal reflects the truth instead of faking progress."""
    return [
        {"id": "token_verified", "name": "GitHub connector authorization verified", "completed": False, "status": "pending", "category": "github"},
        {"id": "repo_resolved", "name": "Repository & branch resolved", "completed": False, "status": "pending", "category": "github"},
        {"id": "clone_repo", "name": "Clone repository into workspace", "completed": False, "status": "pending", "category": "github"},
        {"id": "workspace_ready", "name": "Workspace ready for inspection", "completed": False, "status": "pending", "category": "github"},
    ]


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
                    subprocesses = _github_phase1_subprocesses()
                    # First real step (repo cloning) is the honest failure point —
                    # nothing before it actually runs yet either, so we don't
                    # fake a tick on token/repo resolution.
                    subprocesses[2]["status"] = "failed"
                    subprocesses[2]["metrics"] = {"reason": "Not yet implemented in this build"}
                    await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
                    raise PipelineError(
                        "GitHub-sourced projects aren't supported yet in this build — "
                        "the GitHub integration module hasn't been ported. Upload a ZIP instead."
                    )
                if not project.sourcePath:
                    raise PipelineError("Project source archive is missing")

                subprocesses = _zip_phase1_subprocesses()
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)

                await extract_archive(project.sourcePath, work_root)
                subprocesses[1]["completed"] = True
                subprocesses[1]["status"] = "completed"
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)

                project.workspacePath = work_root
                ws_stmt = select(Workspace).where(Workspace.projectId == project_id)
                workspace = (await db.execute(ws_stmt)).scalar_one_or_none()
                if workspace:
                    workspace.rootPath = work_root
                else:
                    db.add(Workspace(projectId=project_id, rootPath=work_root))
                await db.commit()

                subprocesses[2]["completed"] = True
                subprocesses[2]["status"] = "completed"
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)

                # Real Phase 1 security-check results (size/zip-bomb, malicious/junk
                # files, path traversal, magic-bytes/checksum, context docs) —
                # surfaced to the Inspector modal's Security & Sanitization tab.
                ext = os.path.splitext(project.sourcePath)[1].lower()
                archive_type = "zip" if ext == ".zip" else "tar"
                ctx_docs_stmt = select(ContextDocument.id).where(ContextDocument.projectId == project_id)
                context_doc_count = len((await db.execute(ctx_docs_stmt)).scalars().all())
                security_checks = await run_security_scan(
                    project.sourcePath, work_root, archive_type, context_doc_count
                )
                await set_security_report(db, gateway, analysis_id, project_id, phase, security_checks)

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
                    detail = _command_failure_detail(result)
                    error = await record_error(
                        db, project_id, f"Build command failed: {command}",
                        analysis_run_id=analysis_id, name="BuildError", stack_trace=detail,
                    )
                    await create_bug_from_error(db, project, error)
                    await add_log(db, gateway, analysis_id, project_id, "ERROR", "Install & Build",
                                  f"Build failed: {detail[:4000]}", phase.id)
                    raise PipelineError(f"Build failed: {detail[:2000]}")

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
                    detail = _command_failure_detail(result)
                    error = await record_error(
                        db, project_id, f"Test command failed: {command}",
                        analysis_run_id=analysis_id, name="TestFailure", stack_trace=detail,
                    )
                    await create_bug_from_error(db, project, error)
                    await add_log(db, gateway, analysis_id, project_id, "ERROR", "Testing",
                                  f"Tests failed: {detail[:4000]}", phase.id)

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

        try:
            await add_log(db, gateway, analysis_id, project_id, "ERROR", "Pipeline",
                          f"Analysis failed: {message[:4000]}")
        except Exception:  # noqa: BLE001
            # Never let a logging failure mask the real pipeline error.
            pass

        await gateway.publish(
            project_id,
            {"type": "analysis.failed", "projectId": project_id, "analysisId": analysis_id, "payload": {"message": message}},
        )
        raise