import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Cpu,
  Info,
  Layers,
  Loader2,
  X,
  Zap
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { fetchSettings, updateSettings } from '../api/settings';

export interface AIModelOption {
  id: string;
  name: string;
  provider: string;
  badge?: string;
  contextWindow: string;
  latency: string;
  description: string;
  strengths: string[];
  enabled: boolean;
  status: 'available' | 'high-demand' | 'preview';
  benchmarkScore: number;
  /** Real backend provider/model identifiers this UI entry maps to. */
  backend: { provider: string; model: string };
}

export const defaultModels: AIModelOption[] = [
  {
    id: 'GPT-4-Turbo',
    name: 'GPT-4-Turbo',
    provider: 'OpenAI',
    badge: 'Standard',
    contextWindow: '128k tokens',
    latency: '1.2s avg',
    description: 'High-throughput reasoning model tuned for rapid AST parsing, unit test generation, and multi-step bug reproduction.',
    strengths: ['Fast Synthesis', 'Broad Ecosystem', 'Reliable Diffs'],
    enabled: true,
    status: 'available',
    benchmarkScore: 92.4,
    backend: { provider: 'openai', model: 'gpt-4-turbo' },
  },
  {
    id: 'GPT-4o',
    name: 'GPT-4o (Omni)',
    provider: 'OpenAI',
    badge: 'Popular',
    contextWindow: '128k tokens',
    latency: '0.8s avg',
    description: 'Flagship omni-modal reasoning with fast execution, exceptional code explanation, and deep cross-file dependency awareness.',
    strengths: ['Low Latency', 'Multi-File Context', 'High Confidence'],
    enabled: true,
    status: 'available',
    benchmarkScore: 95.8,
    backend: { provider: 'openai', model: 'gpt-4o' },
  },
  {
    id: 'Claude-3-5-Sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    badge: 'Top Coder',
    contextWindow: '200k tokens',
    latency: '1.4s avg',
    description: 'State-of-the-art coding benchmark performance. Excels at complex refactoring, subtle race conditions, and zero-regression patches.',
    strengths: ['Precise Syntax', 'Zero-Regressions', 'Complex Logic'],
    enabled: true,
    status: 'available',
    benchmarkScore: 98.2,
    backend: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  },
  {
    id: 'Gemini-1-5-Pro',
    name: 'Gemini 1.5 Pro',
    provider: 'Google DeepMind',
    badge: '2M Context',
    contextWindow: '2M tokens',
    latency: '1.5s avg',
    description: 'Extreme context window suitable for ingesting full multi-service monorepos, complete framework trees, and massive log dumps.',
    strengths: ['Massive Context', 'Deep Log Analysis', 'Monorepo Search'],
    enabled: true,
    status: 'available',
    benchmarkScore: 94.6,
    backend: { provider: 'google', model: 'gemini-1.5-pro' },
  },
  {
    id: 'DeepSeek-V3',
    name: 'DeepSeek-V3 / R1',
    provider: 'DeepSeek AI',
    badge: 'Reasoning',
    contextWindow: '64k tokens',
    latency: '1.9s avg',
    description: 'High-density chain-of-thought model specialized in mathematical correctness, algorithmic edge-cases, and formal verification.',
    strengths: ['Chain-of-Thought', 'Low Cost', 'Deep Algorithmic Fixes'],
    enabled: true,
    status: 'available',
    benchmarkScore: 96.1,
    backend: { provider: 'deepseek', model: 'deepseek-chat' },
  },
  {
    id: 'Llama-3-3-70B',
    name: 'Llama 3.3 70B Versatile',
    provider: 'Groq',
    badge: 'Free Tier',
    contextWindow: '131k tokens',
    latency: '0.4s avg',
    description: 'Open-weights model served on Groq\'s LPU hardware for extremely fast inference. Strong all-around free option — no cost, no card required.',
    strengths: ['Free & Fast', 'Zero Cost', 'Open Weights'],
    enabled: true,
    status: 'available',
    benchmarkScore: 89.9,
    backend: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  },
  {
    id: 'GPT-OSS-20B',
    name: 'GPT OSS 20B',
    provider: 'Groq',
    badge: 'Available',
    contextWindow: '131k tokens',
    latency: 'Fast',
    description: 'OpenAI open-weight model served through Groq for fast coding assistance.',
    strengths: ['Fast Inference', 'Coding', 'Open Weights'],
    enabled: true,
    status: 'available',
    benchmarkScore: 89.0,
    backend: { provider: 'groq', model: 'openai/gpt-oss-20b' },
  },
  {
    id: 'Llama-3-1-8B-Instant',
    name: 'Llama 3.1 8B Instant',
    provider: 'Groq',
    badge: 'Free Tier',
    contextWindow: '131k tokens',
    latency: '0.2s avg',
    description: 'Smaller, extremely fast open-weights model on Groq. Best free option for quick, high-volume chat where the 70B model\'s extra reasoning isn\'t needed.',
    strengths: ['Fastest Response', 'Highest Free Quota', 'Zero Cost'],
    enabled: true,
    status: 'available',
    benchmarkScore: 85.2,
    backend: { provider: 'groq', model: 'llama-3.1-8b-instant' },
  },
  {
    id: 'Llama-4-Scout',
    name: 'Llama 4 Scout',
    provider: 'Groq',
    badge: 'Free Tier',
    contextWindow: '131k tokens',
    latency: '0.5s avg',
    description: 'Meta\'s newer MoE model on Groq\'s free tier — a solid step up in reasoning quality over Llama 3.x at similar speed.',
    strengths: ['Newer Architecture', 'Free & Fast', 'Good Reasoning'],
    enabled: true,
    status: 'available',
    benchmarkScore: 91.0,
    backend: { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct' },
  },
  {
    id: 'Qwen3-32B',
    name: 'Qwen3 32B',
    provider: 'Groq',
    badge: 'Free Tier',
    contextWindow: '131k tokens',
    latency: '0.4s avg',
    description: 'Alibaba\'s Qwen3 served free on Groq. Competitive coding and reasoning performance for a fully free model.',
    strengths: ['Strong Coding', 'Free & Fast', 'Open Weights'],
    enabled: true,
    status: 'available',
    benchmarkScore: 90.4,
    backend: { provider: 'groq', model: 'qwen3-32b' },
  },
  {
    id: 'DeepSeek-R1-Distill-70B',
    name: 'DeepSeek R1 Distill 70B',
    provider: 'Groq',
    badge: 'Free Tier',
    contextWindow: '131k tokens',
    latency: '0.6s avg',
    description: 'Distilled reasoning model on Groq\'s free tier — chain-of-thought style reasoning at no cost.',
    strengths: ['Chain-of-Thought', 'Free & Fast', 'Zero Cost'],
    enabled: true,
    status: 'available',
    benchmarkScore: 92.8,
    backend: { provider: 'groq', model: 'deepseek-r1-distill-70b' },
  },
  {
    id: 'Kimi-K2',
    name: 'Kimi K2 Instruct',
    provider: 'Groq',
    badge: 'Free Tier',
    contextWindow: '262k tokens',
    latency: '0.5s avg',
    description: 'Moonshot AI\'s Kimi K2 on Groq\'s free tier — the largest free context window available here, useful for bigger files.',
    strengths: ['Largest Free Context', 'Free & Fast', 'Zero Cost'],
    enabled: true,
    status: 'available',
    benchmarkScore: 90.1,
    backend: { provider: 'groq', model: 'kimi-k2-instruct' },
  }
];

/** Maps a real backend (provider, model) pair back to this UI's model id, for
 * showing the correct selection when settings were set some other way. */
export function resolveModelId(provider: string, model: string): string {
  const match = defaultModels.find(
    m => m.backend.provider === provider && m.backend.model === model
  );
  return match?.id ?? defaultModels[0].id;
}

interface ModelSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentModel: string;
  onSelectModel: (modelId: string) => void;
}

export const ModelSelectorModal: React.FC<ModelSelectorModalProps> = ({
  isOpen,
  onClose,
  currentModel,
  onSelectModel
}) => {
  const [models, setModels] = useState<AIModelOption[]>(defaultModels);
  const [selectedId, setSelectedId] = useState<string>(currentModel);
  const [filterProvider, setFilterProvider] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync with the real persisted setting whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    (async () => {
      try {
        const settings = await fetchSettings();
        const resolved = resolveModelId(settings.primaryProvider, settings.primaryModel);
        setSelectedId(resolved);
      } catch (err) {
        // Non-fatal — keep whatever was passed in as currentModel.
        setError(err instanceof ApiError ? err.message : 'Could not load saved model preference.');
      }
    })();
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleModelAvailability = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setModels(prev => prev.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m));
  };

  const handleApplySelection = async (modelId: string) => {
    const target = models.find(m => m.id === modelId);
    if (!target) return;

    if (!target.enabled) {
      setModels(prev => prev.map(m => m.id === modelId ? { ...m, enabled: true } : m));
    }

    setSaving(true);
    setError(null);
    try {
      await updateSettings(target.backend.provider, target.backend.model);
      setSelectedId(modelId);
      onSelectModel(modelId);
      setTimeout(() => {
        onClose();
      }, 400);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not save this model as the active engine.'
      );
    } finally {
      setSaving(false);
    }
  };

  const filteredModels = models.filter(m => {
    const matchesSearch = m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          m.provider.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          m.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesProvider = filterProvider === 'ALL' || m.provider.toLowerCase().includes(filterProvider.toLowerCase());
    return matchesSearch && matchesProvider;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl bg-[#0D1117] border border-[#30363D] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in duration-150 text-[#E2E8F0]">

        {/* Modal Header */}
        <div className="p-5 border-b border-[#30363D] flex items-center justify-between bg-[#161B22]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-900/30">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">AI Engine & Model Management</h2>
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-green-500/10 text-green-400 border border-green-500/30 rounded-full">
                  6 Models Connected
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Switch the active LLM engine for AST parsing, real-time code fixes, and workspace chat.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-[#21262D] rounded-lg transition-colors cursor-pointer"
            title="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filter Toolbar */}
        <div className="p-4 border-b border-[#30363D] bg-[#0B0E14] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {['ALL', 'Groq', 'OpenAI', 'Anthropic', 'Google', 'DeepSeek'].map(p => (
              <button
                key={p}
                onClick={() => setFilterProvider(p)}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  filterProvider === p
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-[#161B22] text-gray-400 hover:text-gray-200 border border-[#30363D]'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="relative">
            <input
              type="text"
              placeholder="Search model or capability..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full sm:w-56 px-3 py-1.5 bg-[#161B22] border border-[#30363D] rounded-md text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-[#F48771] bg-[#4B1113]/30 border border-[#F48771]/40 rounded px-3 py-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Model Cards Grid */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3.5 bg-[#0B0E14]">
          {filteredModels.map((model) => {
            const isCurrentlySelected = selectedId === model.id;

            return (
              <div
                key={model.id}
                onClick={() => void handleApplySelection(model.id)}
                className={`group rounded-lg border p-4 transition-all cursor-pointer relative ${
                  isCurrentlySelected
                    ? 'bg-indigo-950/20 border-indigo-500 shadow-md shadow-indigo-950/30'
                    : 'bg-[#0D1117] border-[#30363D] hover:border-gray-500 hover:bg-[#161B22]'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">

                  {/* Left info */}
                  <div className="space-y-2 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2.5 h-2.5 rounded-full ${model.enabled ? 'bg-green-500 shadow-xs shadow-green-500/50' : 'bg-gray-600'}`} />
                        <h3 className="text-sm font-bold text-white font-mono">{model.name}</h3>
                      </div>

                      <span className="text-[11px] text-gray-400 font-mono">by {model.provider}</span>

                      {model.badge && (
                        <span className="px-2 py-0.2 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                          {model.badge}
                        </span>
                      )}

                      {isCurrentlySelected && (
                        <span className="px-2 py-0.2 rounded text-[10px] font-bold bg-green-500/20 text-green-300 border border-green-500/40 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          ACTIVE ENGINE
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-gray-300 leading-relaxed pr-2">
                      {model.description}
                    </p>

                    {/* Metadata tags */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <span className="px-2 py-0.5 rounded bg-[#161B22] border border-[#30363D] text-[11px] text-gray-400 flex items-center gap-1">
                        <Layers className="w-3 h-3 text-indigo-400" />
                        {model.contextWindow}
                      </span>

                      <span className="px-2 py-0.5 rounded bg-[#161B22] border border-[#30363D] text-[11px] text-gray-400 flex items-center gap-1">
                        <Clock className="w-3 h-3 text-amber-400" />
                        {model.latency}
                      </span>

                      <span className="px-2 py-0.5 rounded bg-[#161B22] border border-[#30363D] text-[11px] text-gray-400 flex items-center gap-1">
                        <Zap className="w-3 h-3 text-green-400" />
                        {model.benchmarkScore}% CodeEval
                      </span>

                      {model.strengths.map((str, i) => (
                        <span key={i} className="px-2 py-0.5 rounded bg-[#161B22] text-gray-400 text-[10px]">
                          • {str}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Right actions */}
                  <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-[#21262D]">

                    {/* Availability Switch */}
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[11px] text-gray-400">Availability</span>
                      <button
                        onClick={(e) => toggleModelAvailability(model.id, e)}
                        className={`w-9 h-5 rounded-full p-0.5 transition-colors cursor-pointer ${
                          model.enabled ? 'bg-indigo-600' : 'bg-gray-700'
                        }`}
                        title={model.enabled ? "Disable model" : "Enable model"}
                      >
                        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                          model.enabled ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>

                    {/* Choose button */}
                    <button
                      onClick={() => void handleApplySelection(model.id)}
                      disabled={saving}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 ${
                        isCurrentlySelected
                          ? 'bg-green-600 text-white shadow-sm'
                          : 'bg-[#21262D] hover:bg-indigo-600 text-gray-200 hover:text-white border border-[#30363D]'
                      }`}
                    >
                      {saving && isCurrentlySelected ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : isCurrentlySelected ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Active</span>
                        </>
                      ) : (
                        <span>Select Model</span>
                      )}
                    </button>

                  </div>

                </div>
              </div>
            );
          })}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-[#30363D] bg-[#161B22] flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-gray-400">
            <Info className="w-4 h-4 text-indigo-400" />
            <span>Active model applies immediately to Workspace IDE, AST diagnostics & PR bots.</span>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md bg-[#21262D] hover:bg-[#30363D] text-gray-200 font-medium transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>

      </div>
    </div>
  );
};
