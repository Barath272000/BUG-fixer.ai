import { apiRequest, API_BASE_URL, getAuthToken } from './client';

export type OrchestratorStateName = 'live' | 'staging';

export interface OrchestratorState {
  active: OrchestratorStateName;
  liveWorkspace: string;
  pipelineSandbox: string;
}

export interface OrchestratorEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface NativeIdeCoreResponse {
  id: string;
  application: string;
  host: string;
  port: number;
  reload: boolean;
  root: string;
  running: boolean;
}

export interface PipelineStartResponse {
  id: string;
  previewUrl: string;
  containerPort: number;
  hostPort: number;
  snapshotRoot: string;
  running: boolean;
}

export function fetchOrchestratorState(): Promise<OrchestratorState> {
  return apiRequest<OrchestratorState>('/orchestrator/state');
}

export function setOrchestratorState(active: OrchestratorStateName): Promise<OrchestratorState> {
  return apiRequest<OrchestratorState>('/orchestrator/state', {
    method: 'PUT',
    body: { active },
  });
}

export function startNativeIdeCore(
  application = 'main:app',
  port = 8000,
): Promise<NativeIdeCoreResponse> {
  return apiRequest<NativeIdeCoreResponse>('/orchestrator/ide/start', {
    method: 'POST',
    body: { application, host: '127.0.0.1', port },
  });
}

export async function stopNativeIdeCore(): Promise<void> {
  await apiRequest<void>('/orchestrator/ide/stop', { method: 'POST' });
}

export function startPipelineStaging(
  command: string,
  language = 'python',
  containerPort = 8000,
): Promise<PipelineStartResponse> {
  return apiRequest<PipelineStartResponse>('/orchestrator/pipeline/start', {
    method: 'POST',
    body: { command, language, containerPort },
  });
}

export async function stopPipelineStaging(runId: string): Promise<void> {
  await apiRequest<void>(`/orchestrator/pipeline/${encodeURIComponent(runId)}`, { method: 'DELETE' });
}

export function getOrchestratorStreamUrl(): string {
  const wsBase = API_BASE_URL
    ? API_BASE_URL.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  const token = getAuthToken();
  return `${wsBase}/api/v1/orchestrator/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

export function connectOrchestratorStream(
  onEvent: (event: OrchestratorEvent) => void,
  onError?: () => void,
): WebSocket {
  const socket = new WebSocket(getOrchestratorStreamUrl());
  socket.onmessage = message => {
    try {
      onEvent(JSON.parse(message.data) as OrchestratorEvent);
    } catch {
      onError?.();
    }
  };
  socket.onerror = () => onError?.();
  return socket;
}