import React, { useEffect, useState } from 'react';
import { Settings, Cpu, Shield, Check, Loader2, AlertCircle } from 'lucide-react';
import { apiRequest, ApiError } from '../api/client';

// UI model choice <-> backend (provider, model) pair.
const MODEL_OPTIONS = [
  { id: 'gpt-4o', provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', providerLabel: 'OpenAI (Omni)', desc: 'Best for multi-file AST context & high complexity' },
  { id: 'claude-3-5', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', providerLabel: 'Anthropic', desc: 'Superior code syntax precision & refactoring' },
  { id: 'gemini-1-5', provider: 'google', model: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', providerLabel: 'Google DeepMind', desc: '1M+ token context window for large monorepos' },
  { id: 'groq-gpt-oss-20b', provider: 'groq', model: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', providerLabel: 'Groq', desc: 'Fast hosted open-weight model for coding assistance' },
] as const;

interface UserSetting {
  primaryProvider: string;
  primaryModel: string;
  autoRunTests: boolean;
  minimumConfidence: number;
  sandboxGuardrails: boolean;
}

function modelIdFor(provider: string, model: string): string {
  const match = MODEL_OPTIONS.find((m) => m.provider === provider && m.model === model);
  return match?.id ?? MODEL_OPTIONS[0].id;
}

export const SettingsView: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [selectedModel, setSelectedModel] = useState<string>('gpt-4o');
  const [autoRunTests, setAutoRunTests] = useState(true);
  const [minConfidence, setMinConfidence] = useState(85);
  const [sandboxGuardrails, setSandboxGuardrails] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiRequest<UserSetting>('/settings/me');
        if (cancelled) return;
        setSelectedModel(modelIdFor(data.primaryProvider, data.primaryModel));
        setAutoRunTests(data.autoRunTests);
        setMinConfidence(data.minimumConfidence);
        setSandboxGuardrails(data.sandboxGuardrails);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    const chosen = MODEL_OPTIONS.find((m) => m.id === selectedModel) ?? MODEL_OPTIONS[0];
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/settings/me', {
        method: 'PUT',
        body: {
          primaryProvider: chosen.provider,
          primaryModel: chosen.model,
          autoRunTests,
          minimumConfidence: minConfidence,
          sandboxGuardrails,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="settings-view" className="flex-1 overflow-y-auto bg-[#0B0E14] p-6 lg:p-8 space-y-6 text-[#E2E8F0]">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center text-white shadow-md">
            <Settings className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-white tracking-tight">
              Settings & AI Engine Configuration
            </h1>
            <p className="text-xs text-gray-400">
              Configure underlying LLM reasoning models, Docker sandbox execution limits, and notifications.
            </p>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={loading || saving}
          className="flex items-center gap-2 px-3.5 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium shadow-sm transition-colors cursor-pointer"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          <span>{saving ? 'Saving...' : saved ? 'Settings Saved' : 'Save Changes'}</span>
        </button>
      </div>

      {error && (
        <div className="max-w-3xl flex items-center gap-2 px-3.5 py-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="max-w-3xl flex items-center gap-2 text-gray-400 text-xs">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Loading settings...</span>
        </div>
      ) : (
      <div className="max-w-3xl space-y-6">
        
        {/* Model Selection */}
        <div className="rounded-lg bg-[#0D1117] border border-[#30363D] p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-bold text-gray-200 uppercase tracking-wider">
            <Cpu className="w-4 h-4 text-indigo-400" />
            <span>Primary AI Analysis & Synthesis Model</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {MODEL_OPTIONS.map(m => (
              <div
                key={m.id}
                onClick={() => setSelectedModel(m.id)}
                className={`p-3.5 rounded-lg border cursor-pointer transition-all ${
                  selectedModel === m.id
                    ? 'bg-indigo-500/10 border-indigo-500 shadow-sm'
                    : 'bg-[#161B22] border-[#30363D] hover:border-gray-500'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-200 text-xs">{m.name}</span>
                  {selectedModel === m.id && <span className="w-2 h-2 rounded-full bg-indigo-400" />}
                </div>
                <div className="text-[11px] text-indigo-300 mt-0.5">{m.providerLabel}</div>
                <p className="text-[11px] text-gray-400 mt-2">{m.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* AI Confidence & Sandbox Guardrails */}
        <div className="rounded-lg bg-[#0D1117] border border-[#30363D] p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-bold text-gray-200 uppercase tracking-wider">
            <Shield className="w-4 h-4 text-green-400" />
            <span>Sandbox Verification & Guardrails</span>
          </div>

          <div className="space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-gray-200">Auto-execute test suite in Docker container</div>
                <div className="text-gray-400 text-[11px]">Validates that no existing tests break before suggesting a patch</div>
              </div>
              <input
                type="checkbox"
                checked={autoRunTests}
                onChange={(e) => setAutoRunTests(e.target.checked)}
                className="w-4 h-4 rounded text-indigo-600 bg-[#0B0E14] border-[#30363D]"
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[#30363D]">
              <div>
                <div className="font-semibold text-gray-200">Enforce sandbox guardrails</div>
                <div className="text-gray-400 text-[11px]">Runs untrusted code with network disabled and resource limits</div>
              </div>
              <input
                type="checkbox"
                checked={sandboxGuardrails}
                onChange={(e) => setSandboxGuardrails(e.target.checked)}
                className="w-4 h-4 rounded text-indigo-600 bg-[#0B0E14] border-[#30363D]"
              />
            </div>

            <div className="space-y-2 pt-2 border-t border-[#30363D]">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-gray-200">Minimum AI Confidence Score Required</span>
                <span className="font-mono font-bold text-indigo-300">{minConfidence}%</span>
              </div>
              <input
                type="range"
                min={70}
                max={99}
                value={minConfidence}
                onChange={(e) => setMinConfidence(Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </div>
          </div>
        </div>

      </div>
      )}

    </div>
  );
};
