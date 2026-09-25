import asyncio
import sys

from fastapi.testclient import TestClient

from app.common.errors.app_error import AppError
from app.core.config import settings
from app.main import app
from app.modules.orchestrator.pipeline import PipelineManager
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


def test_pipeline_snapshot_sync_creates_ramdisk_copy(tmp_path, monkeypatch):
    live_root = tmp_path / "live-workspace"
    live_root.mkdir()
    (live_root / "project.txt").write_text("hello")
    ramdisk_root = tmp_path / "tmp" / "agis_pipeline_sandboxes"
    monkeypatch.setattr(settings, "LIVE_WORKSPACE_ROOT", str(live_root))
    monkeypatch.setattr(settings, "PIPELINE_TMPFS_ROOT", str(ramdisk_root))

    manager = PipelineManager()
    snapshot_path = asyncio.run(manager.sync_snapshot_to_ramdisk("session-123"))

    assert snapshot_path.startswith(str(ramdisk_root))
    assert (snapshot_path / "project.txt").read_text() == "hello"
    asyncio.run(manager.cleanup_session("session-123"))


def test_pipeline_preview_route_is_public_and_proxies_requests(monkeypatch):
    monkeypatch.setattr(settings, "DEV_SKIP_AUTH", True)

    class DummyResponse:
        def __init__(self):
            self.status_code = 200
            self.headers = {"content-type": "text/html; charset=utf-8"}
            self.content = b"preview ok"

    async def fake_request(self, method, url, content=None, headers=None):
        assert method == "GET"
        assert url.endswith("/health")
        return DummyResponse()

    monkeypatch.setattr("app.modules.orchestrator.pipeline.pipeline_manager.target", lambda run_id: "http://127.0.0.1:8800")
    monkeypatch.setattr("app.main.httpx.AsyncClient.request", fake_request)

    with TestClient(app) as client:
        response = client.get("/pipeline-preview/session-123/health")
        assert response.status_code == 200
        assert response.text == "preview ok"