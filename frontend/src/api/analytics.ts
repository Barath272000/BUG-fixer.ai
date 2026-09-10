import { apiRequest } from './client';

export interface MttrTrendPoint {
  week: string;
  avgResolutionHours: number;
  resolvedCount: number;
}

export interface AnalyticsResponse {
  mttrMinutes: number;
  aiRepairedBugs: number;
  testPassRate: number;
  bugsDetected: number;
  fixesGenerated: number;
  aiComputeCost: number | null;
  costTracked: boolean;
  rootCauses: Record<string, number>;
  mttrTrend: MttrTrendPoint[];
  timeline: {
    bugs: { date: string; status: string }[];
    fixes: { date: string; status: string; confidence: number }[];
  };
}

export async function fetchAnalytics(projectId: string): Promise<AnalyticsResponse> {
  return apiRequest<AnalyticsResponse>(`/analytics?projectId=${encodeURIComponent(projectId)}`);
}
