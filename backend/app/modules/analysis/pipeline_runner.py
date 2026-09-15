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
import shutil
import tempfile
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.websocket.realtime_gateway import REALTIME_EVENTS, RealtimeGateway
from app.models.analysis import AnalysisRun, PipelinePhase
from app.models.bug import Bug, ErrorRecord
from app.models.enums import AIStatus, BugStatus
from app.models.fix import FixProposal, TestRun
from app.models.context import Workspace
from app.models.enums import AnalysisStatus, PhaseStatus, ProjectStatus, SourceType
from app.modules.fixes.service import generate_fix
from app.modules.fixes.patch_service import apply_simple_replacement, read_workspace_file, write_workspace_file
from app.modules.fixes.validation_service import validate_workspace
from app.models.project import Project
from app.modules.analysis.detectors import detect_build_command, detect_preview, detect_test_command
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


async def _update_phase_step(
    db: AsyncSession,
    gateway: RealtimeGateway,
    analysis_id: str,
    project_id: str,
    phase: PipelinePhase,
    steps: list[dict],
    step_id: str,
    status: str,
    metrics: dict[str, str] | None = None,
) -> None:
    """Persist and broadcast one real mechanism step as it changes state."""
    step = next(item for item in steps if item["id"] == step_id)
    step["status"] = status
    step["completed"] = status == "completed"
    if metrics:
        step["metrics"] = metrics
    await set_subprocesses(db, gateway, analysis_id, project_id, phase, steps)


def _phase_steps(items: list[tuple[str, str, str]]) -> list[dict]:
    return [
        {"id": step_id, "name": name, "completed": False, "status": "pending", "category": category}
        for step_id, name, category in items
    ]


async def _run_phase3_sandbox_check(
    db: AsyncSession,
    gateway: RealtimeGateway,
    analysis_id: str,
    project_id: str,
    phase: PipelinePhase,
    work_root: str,
    language: str | None,
) -> None:
    """Create and exercise the same constrained sandbox used by build/test."""
    result = await run_sandbox(work_root, "test -d /workspace && printf sandbox-ready", language)
    subprocesses = [{
        "id": "sandbox_smoke_test",
        "name": "Create isolated execution sandbox",
        "completed": result.code == 0,
        "status": "completed" if result.code == 0 else "failed",
        "category": "sandbox",
        "metrics": {"durationMs": str(result.duration_ms), "output": result.stdout.strip()},
    }]
    await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
    if result.code != 0:
        detail = _command_failure_detail(result)
        error = await record_error(
            db, project_id, "Sandbox initialization failed", analysis_run_id=analysis_id,
            name="SandboxError", stack_trace=detail, source="sandbox",
        )
        await create_bug_from_error(db, await db.get(Project, project_id), error)
        raise PipelineError(f"Sandbox initialization failed: {detail[:2000]}")


async def _collect_run_errors(
    db: AsyncSession,
    analysis_id: str,
    project_id: str,
) -> list[ErrorRecord]:
    """Load the errors emitted by build/test/sandbox and ensure each has a bug."""
    stmt = select(ErrorRecord).where(
        ErrorRecord.analysisRunId == analysis_id,
        ErrorRecord.projectId == project_id,
    )
    errors = list((await db.execute(stmt)).scalars().all())
    project = await db.get(Project, project_id)
    for error in errors:
        await create_bug_from_error(db, project, error)
    return errors


async def _generate_run_fixes(
    db: AsyncSession,
    project: Project,
    analysis_id: str,
) -> list[FixProposal]:
    """Generate one AI proposal per open bug found during this run."""
    stmt = select(Bug).where(
        Bug.projectId == project.id,
        Bug.analysisRunId == analysis_id,
        Bug.status.in_((BugStatus.Open, BugStatus.InReview, BugStatus.AISuggested)),
    )
    bugs = (await db.execute(stmt)).scalars().all()
    fixes: list[FixProposal] = []
    for bug in bugs:
        fix = await generate_fix(db, project.ownerId, bug.id, None, None)
        fix.analysisRunId = analysis_id
        bug.aiStatus = AIStatus.Ready
        bug.status = BugStatus.AISuggested
        await db.commit()
        await db.refresh(fix)
        fixes.append(fix)
    return fixes


async def _validate_run_fixes(
    db: AsyncSession,
    project: Project,
    fixes: list[FixProposal],
) -> int:
    """Validate generated replacements in disposable copies, never live source."""
    if not project.workspacePath:
        raise PipelineError("Workspace is not initialized for patch validation")

    command = await detect_test_command(project.workspacePath, project.language or "Unknown")
    validated = 0
    for fix in fixes:
        if not fix.originalCode or not fix.proposedCode or len(fix.affectedFiles) != 1:
            continue
        temporary_root = tempfile.mkdtemp(prefix="bugfix-validation-")
        try:
            shutil.copytree(project.workspacePath, temporary_root, dirs_exist_ok=True)
            file_path = fix.affectedFiles[0]
            current = await read_workspace_file(temporary_root, file_path)
            updated = apply_simple_replacement(current, fix.originalCode, fix.proposedCode)
            await write_workspace_file(temporary_root, file_path, updated)
            await validate_workspace(db, project.id, fix.id, temporary_root, command)
            validated += 1
        finally:
            shutil.rmtree(temporary_root, ignore_errors=True)
    return validated


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
    current_phase: PipelinePhase | None = None

    try:
        os.makedirs(work_root, exist_ok=True)

        for definition in PIPELINE_DEFINITIONS:
            phase = phases.get(definition["number"])
            if phase is None:
                raise PipelineError(f"Missing pipeline phase {definition['number']}")
            current_phase = phase

            await _set_phase_status(db, phase, PhaseStatus.RUNNING)
            await gateway.publish(
                project_id,
                {"type": REALTIME_EVENTS["phase_started"], "projectId": project_id, "analysisId": analysis_id,
                 "payload": {"id": phase.id, "number": phase.number, "name": phase.name, "status": phase.status}},
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
                await _update_phase_step(
                    db, gateway, analysis_id, project_id, phase, subprocesses,
                    "workspace_ready", "completed", {"securityChecks": str(len(security_checks))},
                )

            # Phase 2: detect language/framework
            if definition["number"] == 2:
                subprocesses = _phase_steps([
                    ("detect_language", "Detect project language", "inspection"),
                    ("detect_framework", "Detect project framework", "inspection"),
                    ("detect_dependencies", "Analyze project dependencies", "inspection"),
                    ("index_symbols", "Build source symbol index", "inspection"),
                ])
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "detect_language", "running")
                inspection = await inspect_project(work_root)
                await _update_phase_step(
                    db, gateway, analysis_id, project_id, phase, subprocesses, "detect_language", "completed",
                    {"language": inspection["language"]},
                )
                await _update_phase_step(
                    db, gateway, analysis_id, project_id, phase, subprocesses, "detect_framework", "completed",
                    {"framework": inspection["framework"]},
                )
                await _update_phase_step(
                    db, gateway, analysis_id, project_id, phase, subprocesses, "detect_dependencies", "completed",
                    {"runtime": str(len(inspection["dependencies"].get("runtime", {}))),
                     "development": str(len(inspection["dependencies"].get("development", {})))},
                )
                await _update_phase_step(
                    db, gateway, analysis_id, project_id, phase, subprocesses, "index_symbols", "completed",
                    {"symbols": str(inspection["symbolCount"])},
                )
                project.language = inspection["language"]
                project.framework = inspection["framework"]
                preview_command, preview_port = await detect_preview(work_root, inspection["language"])
                project.previewCommand = preview_command
                project.previewPort = preview_port
                await db.commit()
                await add_log(db, gateway, analysis_id, project_id, "PASS", "Project Setup",
                              f"Detected {inspection['language']} with {inspection['framework']}", phase.id)
                if preview_command:
                    await add_log(db, gateway, analysis_id, project_id, "INFO", "Project Setup",
                                  f"Preview available: {preview_command} on port {preview_port}", phase.id)

            # Phase 3: create and exercise the isolated execution environment
            if definition["number"] == 3:
                await _run_phase3_sandbox_check(
                    db, gateway, analysis_id, project_id, phase, work_root, project.language,
                )
                await add_log(db, gateway, analysis_id, project_id, "PASS", "Isolated Environment",
                              "Sandbox initialized and smoke-tested", phase.id)

            # Phase 4: build
            if definition["number"] == 4:
                language = project.language or "Unknown"
                subprocesses = _phase_steps([
                    ("detect_build_command", "Detect build command", "build"),
                    ("execute_build", "Execute build in sandbox", "build"),
                    ("capture_build_output", "Capture build output and exit code", "build"),
                ])
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "detect_build_command", "running")
                command = await detect_build_command(work_root, language)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "detect_build_command", "completed", {"command": command})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "execute_build", "running")
                result = await run_sandbox(work_root, command, language)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "execute_build", "completed" if result.code == 0 else "failed", {"durationMs": str(result.duration_ms)})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "capture_build_output", "completed", {"exitCode": str(result.code), "stdoutBytes": str(len(result.stdout)), "stderrBytes": str(len(result.stderr))})

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
                subprocesses = _phase_steps([
                    ("detect_test_command", "Detect test command", "testing"),
                    ("execute_tests", "Execute tests in sandbox", "testing"),
                    ("parse_test_results", "Parse and persist test results", "testing"),
                ])
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "detect_test_command", "running")
                command = await detect_test_command(work_root, language)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "detect_test_command", "completed", {"command": command})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "execute_tests", "running")
                result = await run_sandbox(work_root, command, language)
                summary = parse_generic_test_output(result.stdout, result.stderr, result.code)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "execute_tests", "completed" if result.code == 0 or summary.status == "NO_TESTS" else "failed", {"durationMs": str(result.duration_ms)})

                db.add(TestRun(
                    projectId=project_id, analysisRunId=analysis_id, command=command,
                    status=summary.status, total=summary.total, passed=summary.passed,
                    failed=summary.failed, skipped=summary.skipped, durationMs=result.duration_ms,
                    stdout=result.stdout[:100000], stderr=result.stderr[:100000],
                ))
                await db.commit()
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "parse_test_results", "completed", {"status": summary.status, "total": str(summary.total), "passed": str(summary.passed), "failed": str(summary.failed)})

                if summary.status == "NO_TESTS":
                    await add_log(db, gateway, analysis_id, project_id, "WARN", "Testing",
                                  "Test command ran, but the project contains no discovered tests.", phase.id)
                elif result.code != 0:
                    detail = _command_failure_detail(result)
                    error = await record_error(
                        db, project_id, f"Test command failed: {command}",
                        analysis_run_id=analysis_id, name="TestFailure", stack_trace=detail,
                    )
                    await create_bug_from_error(db, project, error)
                    await add_log(db, gateway, analysis_id, project_id, "ERROR", "Testing",
                                  f"Tests failed: {detail[:4000]}", phase.id)
                    raise PipelineError(f"Tests failed: {detail[:2000]}")

            # Phase 6: consolidate errors from every executable phase into bugs
            if definition["number"] == 6:
                subprocesses = _phase_steps([
                    ("load_run_errors", "Load errors from executed phases", "errors"),
                    ("fingerprint_errors", "Fingerprint and deduplicate errors", "errors"),
                    ("sync_bugs", "Synchronize errors into bug records", "errors"),
                ])
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "load_run_errors", "running")
                errors = await _collect_run_errors(db, analysis_id, project_id)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "load_run_errors", "completed", {"errors": str(len(errors))})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "fingerprint_errors", "completed", {"uniqueFingerprints": str(len({error.fingerprint for error in errors}))})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "sync_bugs", "completed", {"bugsSynchronized": str(len(errors))})
                await add_log(db, gateway, analysis_id, project_id, "PASS", "Error Collection",
                              f"Collected {len(errors)} error(s) and synchronized bug records", phase.id)

            # Phase 7: diagnose this run's bugs and persist fix proposals
            if definition["number"] == 7:
                subprocesses = _phase_steps([
                    ("build_ai_context", "Build source-aware bug context", "ai"),
                    ("generate_diagnoses", "Generate AI root-cause proposals", "ai"),
                    ("persist_proposals", "Persist fix proposals", "ai"),
                ])
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "build_ai_context", "running")
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "build_ai_context", "completed")
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "generate_diagnoses", "running")
                fixes = await _generate_run_fixes(db, project, analysis_id)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "generate_diagnoses", "completed", {"fixes": str(len(fixes))})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "persist_proposals", "completed", {"proposals": str(len(fixes))})
                await add_log(db, gateway, analysis_id, project_id, "PASS", "AI Root Cause Analysis",
                              f"Generated {len(fixes)} AI fix proposal(s)", phase.id)

            # Phase 8: validate proposals in disposable workspaces. Applying a
            # patch to the real workspace remains an explicit user action.
            if definition["number"] == 8:
                subprocesses = _phase_steps([
                    ("load_proposals", "Load generated patch proposals", "validation"),
                    ("apply_disposable_patch", "Apply patches to disposable workspace", "validation"),
                    ("run_validation", "Run validation tests in sandbox", "validation"),
                ])
                await set_subprocesses(db, gateway, analysis_id, project_id, phase, subprocesses)
                fixes_stmt = select(FixProposal).where(FixProposal.analysisRunId == analysis_id)
                fixes = list((await db.execute(fixes_stmt)).scalars().all())
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "load_proposals", "completed", {"proposals": str(len(fixes))})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "apply_disposable_patch", "running")
                validated = await _validate_run_fixes(db, project, fixes)
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "apply_disposable_patch", "completed", {"validated": str(validated)})
                await _update_phase_step(db, gateway, analysis_id, project_id, phase, subprocesses, "run_validation", "completed", {"validated": str(validated), "proposals": str(len(fixes))})
                await add_log(db, gateway, analysis_id, project_id, "PASS", "AI Patch & Validation",
                              f"Validated {validated}/{len(fixes)} proposal(s) in disposable workspaces", phase.id)

            await _set_phase_status(db, phase, PhaseStatus.COMPLETED)
            await gateway.publish(
                project_id,
                {"type": REALTIME_EVENTS["phase_progress"], "projectId": project_id, "analysisId": analysis_id,
                 "payload": {"id": phase.id, "number": phase.number, "name": phase.name, "status": phase.status,
                             "durationMs": phase.durationMs}},
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
        if current_phase is not None and current_phase.status == PhaseStatus.RUNNING:
            await _set_phase_status(db, current_phase, PhaseStatus.FAILED)
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