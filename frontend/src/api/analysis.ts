import { apiRequest } from './client';
import { LogLine } from '../types';

interface BackendPipelineLog {
  id: string;
  phaseId: string | null;
  timestamp: string;
  level: string;
  category: string;
  message: string;
}

function toFrontendLog(l: BackendPipelineLog): LogLine {
  return {
    id: l.id,
    timestamp: l.timestamp,
    level: (l.level as LogLine['level']) ?? 'INFO',
    category: l.category,
    message: l.message,
  };
}

export async function fetchAnalysisLogs(analysisId: string, phaseNumber?: number): Promise<LogLine[]> {
  const params = new URLSearchParams();
  if (phaseNumber !== undefined) params.set('phase', String(phaseNumber));
  const qs = params.toString();
  const result = await apiRequest<BackendPipelineLog[]>(`/analysis/${analysisId}/logs${qs ? `?${qs}` : ''}`);
  return result.map(toFrontendLog);
}

/** Count of analysis runs recorded for a project (what "Recent Runs" is built from). */
export async function countAnalysisRuns(projectId: string): Promise<number> {
  const result = await apiRequest<{ count: number }>(`/analysis/projects/${encodeURIComponent(projectId)}/count`);
  return result.count;
}

/** Deletes a project's analysis run history. Bugs/fixes survive (their
 * analysisRunId link is just cleared); recorded test-run results for those
 * runs are deleted along with them since TestRun belongs to a run. */
export async function clearAnalysisRuns(projectId: string): Promise<number> {
  const result = await apiRequest<{ deleted: number }>(`/analysis/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
  return result.deleted;
}

/** Deletes all analysis history shown in the Dashboard's account-wide Recent Runs panel. */
export async function clearRecentAnalysisRuns(): Promise<number> {
  const result = await apiRequest<{ deleted: number }>('/analysis/recent', {
    method: 'DELETE',
  });
  return result.deleted;
}
