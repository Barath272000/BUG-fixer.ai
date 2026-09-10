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
