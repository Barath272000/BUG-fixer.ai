"""Mirrors: backend/src/modules/workspace/workspace.routes.ts + workspace.controller.ts"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.middleware.auth import AuthUser, require_auth
from app.db.session import get_db
from app.modules.workspace.schemas import (
    CreateFolderRequest,
    CreateFolderResponse,
    DeleteResponse,
    ExecRequest,
    ExecResult,
    FileContent,
    GitCommitRequest,
    GitCommitResponse,
    GitDiffResponse,
    GitStatusResult,
    RenameRequest,
    RenameResponse,
    SearchMatch,
    TreeNode,
    TerminalInput,
    TerminalStartRequest,
    TerminalOutputResponse,
    TerminalSessionResponse,
    TerminalProcess,
    WorkspacePort,
    WriteFileRequest,
    WriteFileResponse,
)
from app.modules.workspace.service import (
    create_folder,
    delete_path,
    exec_command,
    git_commit,
    git_diff,
    git_status,
    read_file,
    rename_path,
    search_workspace,
    tree,
    write_file,
)
from app.modules.workspace.service import workspace_for
from app.modules.workspace.terminal_manager import terminal_manager

router = APIRouter(prefix="/workspaces", tags=["workspace"])


async def _owned_terminal(workspace_id: str, session_id: str, current_user: AuthUser, db: AsyncSession):
    workspace = await workspace_for(db, current_user.id, workspace_id)
    session = await terminal_manager.get(session_id)
    if session is None or session.workspace != workspace.rootPath:
        raise HTTPException(status_code=404, detail="Terminal session was not found")
    return session


@router.post("/{workspace_id}/terminal", response_model=TerminalSessionResponse)
async def start_terminal(
    workspace_id: str,
    payload: TerminalStartRequest | None = None,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    workspace = await workspace_for(db, current_user.id, workspace_id)
    session = await terminal_manager.start(workspace.rootPath, (payload or TerminalStartRequest()).shell)
    return TerminalSessionResponse(id=session.id, workspace=workspace_id)


@router.get("/{workspace_id}/terminal/processes", response_model=list[TerminalProcess])
async def terminal_processes(
    workspace_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    workspace = await workspace_for(db, current_user.id, workspace_id)
    return await terminal_manager.list_for_workspace(workspace.rootPath)


@router.get("/{workspace_id}/ports", response_model=list[WorkspacePort])
async def workspace_ports(
    workspace_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    workspace = await workspace_for(db, current_user.id, workspace_id)
    return await terminal_manager.listening_ports(workspace.rootPath)


@router.get("/{workspace_id}/terminal/{session_id}/output", response_model=TerminalOutputResponse)
async def terminal_output(
    workspace_id: str,
    session_id: str,
    after: int = Query(default=0, ge=0),
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    await _owned_terminal(workspace_id, session_id, current_user, db)
    try:
        chunks, next_cursor, running = await terminal_manager.output(session_id, after)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Terminal session was not found") from exc
    return TerminalOutputResponse(chunks=chunks, next=next_cursor, running=running)


@router.post("/{workspace_id}/terminal/{session_id}/input", status_code=204)
async def terminal_input(
    workspace_id: str,
    session_id: str,
    payload: TerminalInput,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    await _owned_terminal(workspace_id, session_id, current_user, db)
    try:
        await terminal_manager.write(session_id, payload.data)
    except KeyError as exc:
        raise HTTPException(status_code=409, detail="Terminal session is no longer running") from exc


@router.delete("/{workspace_id}/terminal/{session_id}", status_code=204)
async def stop_terminal(
    workspace_id: str,
    session_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    await _owned_terminal(workspace_id, session_id, current_user, db)
    await terminal_manager.stop(session_id)


@router.post("/{workspace_id}/terminal/{session_id}/interrupt", status_code=204)
async def interrupt_terminal(
    workspace_id: str,
    session_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    await _owned_terminal(workspace_id, session_id, current_user, db)
    try:
        await terminal_manager.interrupt(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=409, detail="Terminal session is no longer running") from exc


@router.get("/{workspace_id}/tree", response_model=list[TreeNode])
async def get_tree(
    workspace_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    return await tree(db, current_user.id, workspace_id)


@router.get("/{workspace_id}/file", response_model=FileContent)
async def get_file(
    workspace_id: str,
    path: str = Query(min_length=1),
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    result = await read_file(db, current_user.id, workspace_id, path)
    return FileContent(**result)


@router.put("/{workspace_id}/file", response_model=WriteFileResponse)
async def put_file(
    workspace_id: str,
    payload: WriteFileRequest,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    result = await write_file(db, current_user.id, workspace_id, payload.path, payload.content)
    return WriteFileResponse(**result)


@router.delete("/{workspace_id}/path", response_model=DeleteResponse)
async def delete_workspace_path(
    workspace_id: str,
    path: str = Query(min_length=1),
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    result = await delete_path(db, current_user.id, workspace_id, path)
    return DeleteResponse(**result)


@router.post("/{workspace_id}/rename", response_model=RenameResponse)
async def post_rename(
    workspace_id: str,
    payload: RenameRequest,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    result = await rename_path(db, current_user.id, workspace_id, payload.oldPath, payload.newPath)
    return RenameResponse(**result)


@router.post("/{workspace_id}/folder", response_model=CreateFolderResponse)
async def post_folder(
    workspace_id: str,
    payload: CreateFolderRequest,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    result = await create_folder(db, current_user.id, workspace_id, payload.path)
    return CreateFolderResponse(**result)


@router.post("/{workspace_id}/exec", response_model=ExecResult)
async def post_exec(
    workspace_id: str,
    payload: ExecRequest,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    return await exec_command(db, current_user.id, workspace_id, payload.command, payload.cwd)


@router.get("/{workspace_id}/search", response_model=list[SearchMatch])
async def get_search(
    workspace_id: str,
    q: str = Query(min_length=1),
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    return await search_workspace(db, current_user.id, workspace_id, q)


@router.get("/{workspace_id}/git/status", response_model=GitStatusResult)
async def get_git_status(
    workspace_id: str,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    return await git_status(db, current_user.id, workspace_id)


@router.get("/{workspace_id}/git/diff", response_model=GitDiffResponse)
async def get_git_diff(
    workspace_id: str,
    path: str | None = Query(default=None, min_length=1),
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    diff = await git_diff(db, current_user.id, workspace_id, path)
    return GitDiffResponse(diff=diff)


@router.post("/{workspace_id}/git/commit", response_model=GitCommitResponse)
async def post_git_commit(
    workspace_id: str,
    payload: GitCommitRequest,
    current_user: AuthUser = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
):
    result = await git_commit(db, current_user.id, workspace_id, payload.message)
    return GitCommitResponse(**result)
