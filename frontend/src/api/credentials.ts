import { apiRequest } from './client';

export interface ModelInfo {
  id: string;
  name: string;
  free: boolean;
  pricing?: string | null;
}

export interface CredentialStatus {
  provider: string;
  hasKey: boolean;
  /** True when no user key is saved but the server already has one via .env. */
  envFallback: boolean;
  baseUrl?: string | null;
}

export interface ModelsResponse {
  provider: string;
  configured: boolean;
  models: ModelInfo[];
}

export async function fetchCredentialStatus(): Promise<CredentialStatus[]> {
  return apiRequest<CredentialStatus[]>('/credentials');
}

export async function saveCredential(
  provider: string,
  apiKey: string,
  baseUrl?: string
): Promise<{ provider: string; models: ModelInfo[] }> {
  return apiRequest('/credentials', {
    method: 'POST',
    body: { provider, apiKey, baseUrl },
  });
}

export async function deleteCredential(provider: string): Promise<{ success: boolean }> {
  return apiRequest(`/credentials/${provider}`, { method: 'DELETE' });
}

export async function fetchProviderModels(provider: string): Promise<ModelsResponse> {
  return apiRequest<ModelsResponse>(`/credentials/${provider}/models`);
}
