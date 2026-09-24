import asyncio
import sys

from app.common.errors.app_error import AppError
from app.core.config import settings
from app.modules.orchestrator.service import Orchestrator


def test_orchestrator_keeps_live_and_staging_files_separate(tmp_path, monkeypatch):
    live = tmp_path / "live"
    staging = tmp_path / "staging"
    monkeypatch.setattr(settings, "LIVE_WORKSPACE_ROOT", str(live))
    monkeypatch.setattr(settings, "PIPELINE_SANDBOX_ROOT", str(staging))
    service = Orchestrator()

    async def scenario():
        await service.write_file("live", "screen.txt", "human")
        await service.write_file("staging", "screen.txt", "ai")
        assert await service.read_file("live", "screen.txt") == "human"
        assert await service.read_file("staging", "screen.txt") == "ai"

    asyncio.run(scenario())


def test_orchestrator_rejects_paths_outside_state_root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "LIVE_WORKSPACE_ROOT", str(tmp_path / "live"))
    monkeypatch.setattr(settings, "PIPELINE_SANDBOX_ROOT", str(tmp_path / "staging"))
    service = Orchestrator()

    try:
        service.safe_path("live", "../outside.txt")
    except AppError as exc:
        assert exc.code == "INVALID_PATH"
    else:
        raise AssertionError("path traversal was accepted")


def test_orchestrator_collects_process_output_and_publishes_events(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "LIVE_WORKSPACE_ROOT", str(tmp_path / "live"))
    monkeypatch.setattr(settings, "PIPELINE_SANDBOX_ROOT", str(tmp_path / "staging"))
    service = Orchestrator()
    queue = service.subscribe()

    async def scenario():
        process_id = await service.start_process(
            "staging", sys.executable, ["-c", "print('ready')"], "", {}
        )
        for _ in range(100):
            output, running, _ = await service.output(process_id)
            if not running:
                break
            await asyncio.sleep(0.01)
        assert output == ["ready"]
        events = [await queue.get() for _ in range(3)]
        assert [event["type"] for event in events] == [
            "process.started",
            "process.output",
            "process.finished",
        ]

    asyncio.run(scenario())
    service.unsubscribe(queue)