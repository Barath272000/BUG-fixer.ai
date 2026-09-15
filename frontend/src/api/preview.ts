import { apiRequest } from './client';

export interface PreviewStartResponse {
  url: string;
  command: string;
  port: number;
}

/**
 * Starts (or restarts) the live preview container for a project and returns
 * a real, reachable URL — meant to be opened in a new browser tab.
 * Requires that analysis has run at least once (Phase 2 detects the
 * project's web-server command); the backend returns a 422 with code
 * PREVIEW_NOT_SUPPORTED otherwise.
 */
export async function startPreview(projectId: string): Promise<PreviewStartResponse> {
  return apiRequest<PreviewStartResponse>(`/projects/${projectId}/preview/start`, {
    method: 'POST',
  });
}

/** Stops the running preview container for a project, if any. */
export async function stopPreview(projectId: string): Promise<void> {
  await apiRequest<void>(`/projects/${projectId}/preview/stop`, {
    method: 'POST',
  });
}
