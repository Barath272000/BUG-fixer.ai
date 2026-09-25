"""
App entrypoint.
Mirrors: backend/src/app.ts + backend/src/main.ts
"""
import os
import re
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.common.errors.handlers import register_error_handlers
from app.common.middleware.request_id import RequestIdMiddleware
from app.core.config import settings
from app.db.session import connect_database, disconnect_database

# --- CORS origin resolution (matches the Codespaces-aware logic in app.ts) ---


def resolve_allowed_origins() -> set[str]:
    configured = {o.strip() for o in settings.CORS_ORIGIN.split(",") if o.strip()}

    codespace_name = os.environ.get("CODESPACE_NAME")
    forwarding_domain = os.environ.get("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN")
    if codespace_name and forwarding_domain:
        configured.add(f"https://{codespace_name}-3000.{forwarding_domain}")
        configured.add(f"https://{codespace_name}-4000.{forwarding_domain}")

    return configured


_LOCALHOST_RE = re.compile(r"^localhost(?::\d+)?$")
_CODESPACE_HOST_RE = re.compile(r"\.app\.github\.dev$|\.githubpreview\.dev$", re.IGNORECASE)


def is_origin_allowed(origin: str) -> bool:
    allowed = resolve_allowed_origins()
    try:
        hostname = urlparse(origin).hostname or origin
    except Exception:  # noqa: BLE001
        hostname = origin

    is_localhost = bool(_LOCALHOST_RE.match(hostname)) or hostname == "127.0.0.1"
    is_codespace_host = bool(_CODESPACE_HOST_RE.search(hostname))
    return origin in allowed or is_localhost or is_codespace_host


# NOTE: starlette's CORSMiddleware doesn't support a per-request callback the
# way Express's `cors()` does, so we pass allow_origins as a regex covering
# localhost + Codespaces hosts, and the explicit configured origin list.
def build_cors_origin_regex() -> str:
    parts = [r"^https?://localhost(:\d+)?$", r"^https?://127\.0\.0\.1(:\d+)?$",
             r".*\.app\.github\.dev$", r".*\.githubpreview\.dev$"]
    return "|".join(parts)


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(settings.STORAGE_ROOT, exist_ok=True)
    os.makedirs(settings.SANDBOX_WORK_ROOT, exist_ok=True)
    os.makedirs(settings.LIVE_WORKSPACE_ROOT, exist_ok=True)
    os.makedirs(settings.PIPELINE_SANDBOX_ROOT, exist_ok=True)
    os.makedirs(settings.PIPELINE_TMPFS_ROOT, exist_ok=True)
    await connect_database()
    yield
    from app.modules.orchestrator.pipeline import pipeline_manager
    await pipeline_manager.shutdown()
    await disconnect_database()


limiter = Limiter(key_func=get_remote_address)


def create_app() -> FastAPI:
    app = FastAPI(title="bugfixai-backend", version="1.0.0", lifespan=lifespan)

    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolve_allowed_origins()),
        allow_origin_regex=build_cors_origin_regex(),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
    )

    register_error_handlers(app)

    @app.get("/health")
    async def health():
        return {"status": "ok", "service": "bugfixai-backend", "version": "1.0.0"}

    @app.get("/api/v1/health")
    async def api_health():
        return {"status": "ok", "service": "bugfixai-backend", "version": "1.0.0"}

    @app.api_route(
        "/pipeline-preview/{session_id}/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        include_in_schema=False,
    )
    async def pipeline_preview_proxy(request: Request, session_id: str, path: str = "") -> Response:
        from app.common.errors.app_error import AppError
        from app.modules.orchestrator.pipeline import pipeline_manager

        try:
            target = pipeline_manager.target(session_id)
        except AppError:
            return HTMLResponse(
                content="<html><body><h1>Pipeline preview unavailable</h1><p>The staging container is not running or is still rebuilding.</p></body></html>",
                status_code=503,
                media_type="text/html",
            )

        target_url = f"{target.rstrip('/')}/{path}" if path else target.rstrip('/')
        if request.url.query:
            target_url = f"{target_url}?{request.url.query}"

        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "content-length", "connection"}
        }

        try:
            async with httpx.AsyncClient(follow_redirects=False, timeout=30.0) as client:
                upstream = await client.request(
                    request.method,
                    target_url,
                    content=await request.body(),
                    headers=headers,
                )
        except httpx.HTTPError:
            return HTMLResponse(
                content="<html><body><h1>Pipeline preview is rebuilding</h1><p>The sandbox is restarting after a patch update. Please retry in a moment.</p></body></html>",
                status_code=503,
                media_type="text/html",
            )

        response_headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower() not in {"content-length", "connection", "transfer-encoding"}
        }
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=upstream.headers.get("content-type"),
        )

    # --- Route mounting ---
    from app.modules.auth.router import router as auth_router
    from app.modules.users.router import router as users_router
    from app.modules.projects.router import router as projects_router
    from app.modules.uploads.router import router as uploads_router
    from app.modules.context_docs.router import router as context_docs_router
    from app.modules.workspace.router import router as workspace_router
    from app.modules.bugs.router import router as bugs_router
    from app.modules.fixes.router import router as fixes_router
    from app.modules.analysis.router import router as analysis_router
    from app.modules.copilot.router import router as copilot_router
    from app.modules.settings.router import router as settings_router
    from app.modules.credentials.router import router as credentials_router
    from app.modules.analytics.router import router as analytics_router
    from app.modules.preview.router import router as preview_router
    from app.modules.github.router import router as github_router
    from app.modules.realtime.router import router as realtime_router
    from app.modules.orchestrator.router import router as orchestrator_router

    app.include_router(auth_router, prefix="/api/v1")
    app.include_router(users_router, prefix="/api/v1")
    app.include_router(projects_router, prefix="/api/v1")
    app.include_router(uploads_router, prefix="/api/v1")
    app.include_router(context_docs_router, prefix="/api/v1")
    app.include_router(workspace_router, prefix="/api/v1")
    app.include_router(bugs_router, prefix="/api/v1")
    app.include_router(fixes_router, prefix="/api/v1")
    app.include_router(analysis_router, prefix="/api/v1")
    app.include_router(copilot_router, prefix="/api/v1")
    app.include_router(settings_router, prefix="/api/v1")
    app.include_router(credentials_router, prefix="/api/v1")
    app.include_router(analytics_router, prefix="/api/v1")
    app.include_router(preview_router, prefix="/api/v1")
    app.include_router(github_router, prefix="/api/v1")
    app.include_router(realtime_router)  # no /api/v1 prefix: ws(s)://host/realtime
    app.include_router(orchestrator_router, prefix="/api/v1")

    # The following modules are converted in later phases and will be
    # mounted here the same way once ready:
    #   /api/v1/context      -> context-docs module  (Phase 4)
    #   /api/v1/github       -> github integration   (Phase 5)

    return app


app = create_app()