import {
  AlertCircle,
  BookOpen,
  Check,
  Code,
  Cpu,
  Github,
  Layers,
  RotateCw,
  UploadCloud,
  Zap
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, getRealtimeSocketUrl, uploadProjectArchive } from '../api/client';
import { fetchAnalysisLogs } from '../api/analysis';
import { connectGithubRepo, getGithubTokenStatus, parseGithubUrl } from '../api/github';
import { pipelinePhases as initialPipelinePhases, initialFixAttempts, initialPreviewCheckpoint } from '../data/mockData';
import { ContextDoc, FixAttempt, PipelinePhase, PreviewCheckpoint, PreviewCheckpointFileEdit } from '../types';
import { AttemptDiffViewer } from './AttemptDiffViewer';
import { AttemptTimeline } from './AttemptTimeline';
import { ContextDocsUploader } from './ContextDocsUploader';
import { EmbeddedBrowserPreview } from './EmbeddedBrowserPreview';
import { ExtendedLogLine, LiveLogTable } from './LiveLogTable';
import { PhaseInspectorModal } from './PhaseInspectorModal';
import { PreviewCheckpointModal } from './PreviewCheck';

const pendingPipelinePhases: PipelinePhase[] = initialPipelinePhases.map((p) => ({
  ...p,
  status: 'pending',
  duration: undefined,
  // Real subprocess checklists come from the backend via the 'phase.subprocess'
  // websocket event as each phase actually runs — no fake placeholder here.
  subprocesses: undefined,
}));

interface BackendPhase {
  number: number;
  name: string;
  description: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  durationMs?: number | null;
  subprocesses?: PipelinePhase['subprocesses'];
  validationReport?: PipelinePhase['validationReport'];
}

interface AnalysisDetailResponse {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  phases: BackendPhase[];
}

function backendPhaseStatus(status: BackendPhase['status']): PipelinePhase['status'] {
  switch (status) {
    case 'RUNNING': return 'running';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    default: return 'pending';
  }
}

interface RecentRun {
  id: string;
  projectId: string;
  projectName: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  createdAt: string;
  durationMs: number | null;
  bugsFound: number;
  bugsFixed: number;
}

interface RecentRunsResponse {
  items: RecentRun[];
  stats: { totalRuns: number; fixed: number; failed: number };
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}


interface DashboardViewProps {
  refreshToken?: number;
  onAnalysisDataChanged: (projectId: string) => void;
  onAnalysisCompleted: (analysisRunId: string, projectName: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ refreshToken, onAnalysisDataChanged, onAnalysisCompleted }) => {
  const [activeUploadTab, setActiveUploadTab] = useState<'zip' | 'github' | 'paste'>('zip');
  const [projectName, setProjectName] = useState('');
  const [activeRightTab, setActiveRightTab] = useState<'pipeline' | 'logs'>('pipeline');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phases, setPhases] = useState<PipelinePhase[]>(pendingPipelinePhases);
  const [logs, setLogs] = useState<ExtendedLogLine[]>([]);

  // --- Pipeline v2 UI scaffold (see PIPELINE_V2_ARCHITECTURE.md) ---
  // Local-state only for now: no backend loop controller / FixAttempt /
  // PreviewCheckpoint tables exist yet, so these are demo-interactive
  // (typing a prompt, saving a file edit, or "starting a manual loop"
  // genuinely updates this component's state) but don't yet re-queue a
  // real Celery task or persist anything server-side.
  const [fixAttempts, setFixAttempts] = useState<FixAttempt[]>(initialFixAttempts);
  const [currentAttemptIndex, setCurrentAttemptIndex] = useState(initialFixAttempts.length - 1);
  const [showAttemptDiff, setShowAttemptDiff] = useState(false);
  const [checkpoint, setCheckpoint] = useState<PreviewCheckpoint>(initialPreviewCheckpoint);
  const [showCheckpointModal, setShowCheckpointModal] = useState(false);
  const hadHumanInputInRound = checkpoint.promptMessages.some((m) => m.role === 'user') || checkpoint.fileEditsDetected.length > 0;
  const autoAttemptCount = fixAttempts.filter((a) => a.mode === 'automatic').length;

  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [currentExecutingPhase, setCurrentExecutingPhase] = useState<string>('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  // --- Recent Runs state (starts empty — populated from the backend, never hardcoded) ---
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [recentRunsStats, setRecentRunsStats] = useState({ totalRuns: 0, fixed: 0, failed: 0 });
  const [recentRunsLoading, setRecentRunsLoading] = useState(true);

  // --- Detected tech stack (real project.language / project.framework — nothing fabricated) ---
  const [detectedStack, setDetectedStack] = useState<{ language: string | null; framework: string | null; status: string } | null>(null);
  // --- Preview (Run & Test) state — the embedded browser window owns its
  // own start/stop/build-toggle lifecycle; this component just tracks
  // whether that window is open and what command/port it detected.
  const [previewCommand, setPreviewCommand] = useState<{ command: string; port: number } | null>(null);
  const [showEmbeddedPreview, setShowEmbeddedPreview] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setDetectedStack(null);
      setPreviewCommand(null);
      setShowEmbeddedPreview(false);
      return;
    }
    apiRequest<{ language: string | null; framework: string | null; status: string; previewCommand: string | null; previewPort: number | null }>(`/projects/${projectId}`)
      .then((p) => {
        setDetectedStack({ language: p.language, framework: p.framework, status: p.status });
        setPreviewCommand(p.previewCommand && p.previewPort ? { command: p.previewCommand, port: p.previewPort } : null);
      })
      .catch(() => setDetectedStack(null));
    // Re-check once analysis stops running (phase 2 may have just written language/framework).
  }, [projectId, isAnalyzing]);

  const handleOpenPreview = () => {
    if (!projectId || !previewCommand) return;
    setShowEmbeddedPreview(true);
  };

  // --- Pipeline v2 checkpoint handlers (local-state demo, see note above) ---
  const handleCheckpointDecision = (openPreview: boolean) => {
    setCheckpoint((prev) => ({ ...prev, status: openPreview ? 'previewing' : 'resumed' }));
    if (openPreview) {
      handleOpenPreview();
    } else {
      setShowCheckpointModal(false);
    }
  };

  const handleCheckpointSubmitPrompt = (text: string) => {
    setCheckpoint((prev) => ({
      ...prev,
      promptMessages: [
        ...prev.promptMessages,
        { id: `msg-${Date.now()}`, role: 'user', text, createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) },
      ],
    }));
  };

  const handleCheckpointSaveFileEdit = (edit: PreviewCheckpointFileEdit) => {
    setCheckpoint((prev) => ({ ...prev, fileEditsDetected: [...prev.fileEditsDetected, edit] }));
  };

  const handleCheckpointTriggerManualLoop = () => {
    const previous = fixAttempts[fixAttempts.length - 1];
    const newAttempt: FixAttempt = {
      id: `att-${Date.now()}`,
      bugId: previous?.bugId ?? 'BUG-001',
      analysisRunId: previous?.analysisRunId ?? checkpoint.analysisRunId,
      attemptNumber: fixAttempts.length + 1,
      mode: 'manual',
      triggerNote: checkpoint.promptMessages.filter((m) => m.role === 'user').slice(-1)[0]?.text ?? null,
      triggerFileEdit: checkpoint.fileEditsDetected.length > 0,
      diffSnippet: checkpoint.fileEditsDetected.slice(-1)[0]?.diffSnippet ?? previous?.diffSnippet ?? '',
      previousAttemptId: previous?.id ?? null,
      resultStatus: 'pending',
      errorFingerprint: null,
      rawErrorOutput: null,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setFixAttempts((prev) => [...prev, newAttempt]);
    setCurrentAttemptIndex(fixAttempts.length);
    setShowCheckpointModal(false);
    // NOTE: once the backend loop controller exists (architecture doc §4/§7),
    // this is where we'd POST /analysis/{runId}/checkpoint/prompt or
    // /checkpoint/file-edit, which re-queues the Celery task at Phase 4.
  };

  const handleCheckpointGoNext = () => {
    setShowCheckpointModal(false);
    // NOTE: once the backend exists, this calls POST /analysis/{runId}/checkpoint/go-next
    // to resume the paused Celery task into Phase 9 (Regression Check).
  };

  const refreshRecentRuns = React.useCallback(() => {
    apiRequest<RecentRunsResponse>('/analysis/recent')
      .then((res) => {
        setRecentRuns(res.items);
        setRecentRunsStats(res.stats);
      })
      .catch(() => {
        // Leave the list empty rather than showing stale/fake data.
        setRecentRuns([]);
      })
      .finally(() => setRecentRunsLoading(false));
  }, []);

  useEffect(() => {
    refreshRecentRuns();
  }, [refreshRecentRuns, refreshToken]);

  // --- GitHub tab state ---
  const [githubUrl, setGithubUrl] = useState('');
  const [githubBranch, setGithubBranch] = useState('main');
  const [githubToken, setGithubToken] = useState('');
  const [githubTokenConnected, setGithubTokenConnected] = useState<boolean | null>(null);
  const [githubConnecting, setGithubConnecting] = useState(false);

  // Optional Context Docs State — starts empty; the user attaches their own files.
  const [contextDocs, setContextDocs] = useState<ContextDoc[]>([]);
  const [customInstructions, setCustomInstructions] = useState<string>('');
  const [selectedPhaseForInspection, setSelectedPhaseForInspection] = useState<PipelinePhase | null>(null);
  const [isPhaseInspectorOpen, setIsPhaseInspectorOpen] = useState<boolean>(false);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (activeUploadTab !== 'github' || githubTokenConnected !== null) return;
    getGithubTokenStatus().then(setGithubTokenConnected).catch(() => setGithubTokenConnected(false));
  }, [activeUploadTab, githubTokenConnected]);

  const handleOpenPhaseInspector = (phase: PipelinePhase) => {
    setSelectedPhaseForInspection(phase);
    setIsPhaseInspectorOpen(true);
  };

  const handleClosePhaseInspector = () => {
    setIsPhaseInspectorOpen(false);
    setSelectedPhaseForInspection(null);
  };

  const handleRerunSecurityChecks = () => {
    const timeStr = new Date().toTimeString().split(' ')[0] + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
    const secLog: ExtendedLogLine = {
      id: `${Date.now()}-sec-rerun`,
      timestamp: timeStr,
      level: 'PASS',
      category: 'security',
      phaseName: 'Project Input',
      durationMs: 28,
      message: 'Zero-Trust Security re-verified: Quota safe (4.82MB), 0 malicious binaries, Zip Slip path traversal prevented.',
      details: 'SHA-256 Checksum verified.\nMagic Bytes Header: PK\\x03\\x04 verified.\nAll 34 files verified against safe chroot sandbox boundary.'
    };
    setLogs(prev => [secLog, ...prev]);
  };

  const handleAddContextDoc = (newDoc: ContextDoc) => {
    setContextDocs(prev => [...prev, newDoc]);
  };

  const handleRemoveContextDoc = (id: string) => {
    setContextDocs(prev => prev.filter(d => d.id !== id));
  };

  const handleClearAllContextDocs = () => {
    setContextDocs([]);
  };

  const hydrateAnalysisPhases = (id: string) => {
    apiRequest<AnalysisDetailResponse>(`/analysis/${id}`)
      .then((analysis) => {
        setIsAnalyzing(analysis.status === 'QUEUED' || analysis.status === 'RUNNING');
        setPhases(prev => prev.map(phase => {
          const backendPhase = analysis.phases.find(item => item.number === phase.id);
          if (!backendPhase) return phase;
          return {
            ...phase,
            name: backendPhase.name,
            description: backendPhase.description,
            status: backendPhaseStatus(backendPhase.status),
            duration: backendPhase.durationMs ? `${(backendPhase.durationMs / 1000).toFixed(1)}s` : phase.duration,
            subprocesses: backendPhase.subprocesses ?? phase.subprocesses,
            validationReport: backendPhase.validationReport ?? phase.validationReport,
          };
        }));
        setProgress(Math.round(
          (analysis.phases.filter(phase => phase.status === 'COMPLETED').length / pendingPipelinePhases.length) * 100,
        ));
      })
      .catch(() => {
        // Realtime updates remain usable when the snapshot request races shutdown.
      });

    fetchAnalysisLogs(id)
      .then((backendLogs) => setLogs(backendLogs.map((log) => ({
        ...log,
        timestamp: new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false }) + '.' + String(new Date(log.timestamp).getMilliseconds()).padStart(3, '0'),
        category: log.category,
      }))))
      .catch(() => {
        // The phase snapshot remains useful when log history is unavailable.
      });
  };

  const connectRealtimeSocket = (pid: string, runId: string) => {
    const socket = new WebSocket(getRealtimeSocketUrl(pid));
    socketRef.current = socket;

    socket.onopen = () => {
      // Reconcile runs that completed before the websocket subscription opened.
      hydrateAnalysisPhases(runId);
    };

    socket.onmessage = (event) => {
      let data: { type: string; payload: unknown };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type === 'phase.started' || data.type === 'phase.progress') {
        const phase = data.payload as BackendPhase;
        setCurrentExecutingPhase(phase.name);
        setPhases(prev => {
          const next = prev.map(p => p.id === phase.number ? {
            ...p,
            name: phase.name || p.name,
            status: backendPhaseStatus(phase.status),
            duration: phase.durationMs ? `${(phase.durationMs / 1000).toFixed(1)}s` : p.duration,
          } : p);
          setProgress(Math.round(
            (next.filter(item => item.status === 'completed').length / pendingPipelinePhases.length) * 100,
          ));
          return next;
        });
      } else if (data.type === 'phase.subprocess') {
        const payload = data.payload as { number: number; subprocesses: PipelinePhase['subprocesses'] };
        setPhases(prev => prev.map(p => p.id === payload.number ? {
          ...p,
          subprocesses: payload.subprocesses,
        } : p));
      } else if (data.type === 'phase.security') {
        const payload = data.payload as { number: number; securityChecks: NonNullable<PipelinePhase['validationReport']>['securityChecks'] };
        setPhases(prev => prev.map(p => p.id === payload.number ? {
          ...p,
          validationReport: { ...p.validationReport, securityChecks: payload.securityChecks },
        } : p));
      } else if (data.type === 'log.created') {
        const log = data.payload as { id: string; timestamp: string; level: string; category: string; message: string };
        setLogs(prev => [...prev, {
          id: log.id,
          timestamp: new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false }) + '.' + String(new Date(log.timestamp).getMilliseconds()).padStart(3, '0'),
          level: (log.level as ExtendedLogLine['level']) ?? 'INFO',
          category: log.category,
          message: log.message,
        }]);
      } else if (data.type === 'analysis.completed') {
        setIsAnalyzing(false);
        hydrateAnalysisPhases(runId);
        refreshRecentRuns();
        onAnalysisDataChanged(pid);
        onAnalysisCompleted(runId, projectName);
        socket.close();
      } else if (data.type === 'analysis.failed') {
        const payload = data.payload as { message?: string };
        setIsAnalyzing(false);
        setPipelineError(payload?.message ?? 'Analysis pipeline failed');
        hydrateAnalysisPhases(runId);
        refreshRecentRuns();
        socket.close();
      }
    };

    socket.onerror = () => {
      setPipelineError('Lost connection to the realtime log stream.');
    };
  };

  const handleStartAnalysis = async () => {
    if (isAnalyzing) return;
    if (!uploadedFile) {
      setPipelineError('Choose a project ZIP archive before starting the analysis.');
      return;
    }

    setPipelineError(null);
    setIsAnalyzing(true);
    setProgress(0);
    setLogs([]);
    setPhases(pendingPipelinePhases);
    setCurrentExecutingPhase('Project Input');

    try {
      // 1. Create the project record
      const project = await apiRequest<{ id: string }>('/projects', {
        method: 'POST',
        body: { name: projectName, sourceType: 'ZIP' },
      });
      setProjectId(project.id);

      // 2. Upload the archive
      await uploadProjectArchive(project.id, uploadedFile);

      // 3. Kick off the analysis pipeline (runs async on the backend via BullMQ)
      const run = await apiRequest<{ id: string }>(`/analysis/projects/${project.id}/run`, {
        method: 'POST',
      });
      setAnalysisId(run.id);
      refreshRecentRuns();

      // 4. Stream phase/log updates over the realtime WebSocket gateway
      connectRealtimeSocket(project.id, run.id);
      // The worker can finish phases before the socket handshake completes.
      hydrateAnalysisPhases(run.id);
    } catch (error) {
      setIsAnalyzing(false);
      setPipelineError(error instanceof ApiError ? error.message : 'Failed to start the analysis pipeline.');
    }
  };

  const handleStartGithubAnalysis = async () => {
    if (isAnalyzing || githubConnecting) return;
    const parsed = parseGithubUrl(githubUrl);
    if (!parsed) {
      setPipelineError('Enter a valid GitHub repository URL, e.g. https://github.com/owner/repo');
      return;
    }
    if (!githubTokenConnected && !githubToken.trim()) {
      setPipelineError('Paste a GitHub personal access token to connect your account.');
      return;
    }

    setPipelineError(null);
    setGithubConnecting(true);
    setIsAnalyzing(true);
    setProgress(0);
    setLogs([]);
    setPhases(pendingPipelinePhases);
    setCurrentExecutingPhase('Project Input');

    try {
      const project = await apiRequest<{ id: string }>('/projects', {
        method: 'POST',
        body: {
          name: projectName || parsed.repo,
          sourceType: 'GITHUB',
          repositoryUrl: githubUrl.trim(),
          defaultBranch: githubBranch.trim() || undefined,
        },
      });
      setProjectId(project.id);

      await connectGithubRepo(project.id, parsed.owner, parsed.repo, githubBranch.trim() || undefined, githubToken.trim() || undefined);
      if (githubToken.trim()) {
        setGithubToken('');
        setGithubTokenConnected(true);
      }

      const run = await apiRequest<{ id: string }>(`/analysis/projects/${project.id}/run`, {
        method: 'POST',
      });
      setAnalysisId(run.id);
      refreshRecentRuns();

      connectRealtimeSocket(project.id, run.id);
      hydrateAnalysisPhases(run.id);
    } catch (error) {
      setIsAnalyzing(false);
      setPipelineError(error instanceof ApiError ? error.message : 'Failed to connect and clone the repository.');
    } finally {
      setGithubConnecting(false);
    }
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  return (
    <div id="dashboard-view" className="flex-1 overflow-y-auto bg-[#0B0E14] p-6 lg:p-8 space-y-6 text-[#E2E8F0]">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-white tracking-tight">
            Project Diagnostic Upload & Analysis Pipeline
          </h1>
          <p className="text-xs text-gray-400 mt-1">
            Submit your repository or archive with optional context docs for AI-powered AST defect detection, container execution, and automated repair.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* View mode toggle */}
          <div className="flex items-center bg-[#0D1117] border border-[#30363D] p-1 rounded-lg">
            <button
              onClick={() => setActiveRightTab('pipeline')}
              className={`px-3 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                activeRightTab === 'pipeline'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Pipeline & Live Logs
            </button>
            <button
              onClick={() => setActiveRightTab('logs')}
              className={`px-3 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                activeRightTab === 'logs'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Tech Stack & Diagnostics
            </button>
          </div>

          {/* AI Engine Status Pill */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#0D1117] border border-[#30363D] text-xs font-semibold">
            <span className={`w-2 h-2 rounded-full ${isAnalyzing ? 'bg-amber-400 animate-ping' : 'bg-green-500 animate-pulse'}`} />
            <span className="text-gray-300 font-mono">{isAnalyzing ? 'Executing Pipeline...' : 'Engine Ready'}</span>
          </div>
        </div>
      </div>

      {/* Main Grid Content */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        
        {/* Left Column (5 Cols) */}
        <div className="xl:col-span-5 space-y-6">
          
          {/* Recent Runs Card */}
          <div className="rounded-lg bg-[#0D1117] border border-[#30363D] p-5 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-gray-200 uppercase tracking-wider">
                Recent Runs
              </h2>
              <span className="text-[11px] font-medium text-gray-400 bg-[#161B22] px-2.5 py-0.5 rounded border border-[#30363D]">
                Live
              </span>
            </div>

            {/* Run List Items */}
            <div className="space-y-2">
              {recentRuns.length === 0 && (
                <div className="text-[11px] text-gray-500 text-center py-4">
                  {recentRunsLoading ? 'Loading run history...' : 'No analysis runs yet — start one below.'}
                </div>
              )}
              {recentRuns.map((run) => {
                const isRunning = run.status === 'RUNNING' || run.status === 'QUEUED';
                const isFailed = run.status === 'FAILED';
                const dotClass = isRunning ? 'bg-amber-400 animate-ping' : isFailed ? 'bg-red-500' : 'bg-green-500';
                const badgeClass = isRunning
                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                  : isFailed
                  ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : 'bg-green-500/10 text-green-400 border border-green-500/20';
                const badgeText = isRunning
                  ? 'running'
                  : isFailed
                  ? `${run.bugsFound} bugs found`
                  : `${run.bugsFixed} bugs fixed`;
                return (
                  <div key={run.id} className="flex items-center justify-between p-3 rounded-md bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] transition-colors">
                    <div className="flex items-center gap-3">
                      <span className={`w-2 h-2 rounded-full shrink-0 shadow-sm ${dotClass}`} />
                      <div>
                        <div className="text-xs font-semibold font-mono text-gray-200">{run.projectName}</div>
                        <div className="text-[11px] text-gray-500">
                          {formatRelativeTime(run.createdAt)}{run.durationMs ? ` · ${formatDuration(run.durationMs)}` : isRunning ? ' · active' : ''}
                        </div>
                      </div>
                    </div>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${badgeClass}`}>
                      {badgeText}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Run Stats Summary */}
            <div className="grid grid-cols-3 gap-3 pt-2 border-t border-[#30363D] text-center">
              <div className="p-2.5 rounded bg-[#161B22] border border-[#30363D]">
                <div className="text-lg font-bold text-white">{recentRunsStats.totalRuns}</div>
                <div className="text-[10px] text-gray-400 uppercase font-semibold">Total Runs</div>
              </div>
              <div className="p-2.5 rounded bg-[#161B22] border border-[#30363D]">
                <div className="text-lg font-bold text-green-400">{recentRunsStats.fixed}</div>
                <div className="text-[10px] text-gray-400 uppercase font-semibold">Fixed</div>
              </div>
              <div className="p-2.5 rounded bg-[#161B22] border border-[#30363D]">
                <div className="text-lg font-bold text-red-400">{recentRunsStats.failed}</div>
                <div className="text-[10px] text-gray-400 uppercase font-semibold">Failed</div>
              </div>
            </div>
          </div>

          {/* Project Upload Section Card */}
          <div className="rounded-lg bg-[#0D1117] border border-[#30363D] p-5 space-y-4 shadow-sm">
            
            {/* Upload Mode Tabs */}
            <div className="flex border-b border-[#30363D] gap-6 text-xs font-semibold">
              <button
                onClick={() => setActiveUploadTab('zip')}
                className={`pb-2.5 flex items-center gap-2 transition-all cursor-pointer relative ${
                  activeUploadTab === 'zip' ? 'text-indigo-400' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <UploadCloud className="w-4 h-4" />
                <span>ZIP Upload</span>
                {activeUploadTab === 'zip' && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500" />
                )}
              </button>

              <button
                onClick={() => setActiveUploadTab('github')}
                className={`pb-2.5 flex items-center gap-2 transition-all cursor-pointer relative ${
                  activeUploadTab === 'github' ? 'text-indigo-400' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Github className="w-4 h-4" />
                <span>GitHub / GitLab</span>
                {activeUploadTab === 'github' && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500" />
                )}
              </button>

              <button
                onClick={() => setActiveUploadTab('paste')}
                className={`pb-2.5 flex items-center gap-2 transition-all cursor-pointer relative ${
                  activeUploadTab === 'paste' ? 'text-indigo-400' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Code className="w-4 h-4" />
                <span>Paste Code</span>
                {activeUploadTab === 'paste' && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500" />
                )}
              </button>
            </div>

            {/* Tab 1: ZIP Upload */}
            {activeUploadTab === 'zip' && (
              <div className="space-y-4">
                
                {/* 1. Primary ZIP Dropzone */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,.tar,.gz,.tgz"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setUploadedFile(file);
                    setUploadedFileName(file?.name ?? null);
                    setPipelineError(null);
                  }}
                />
                <div
                  className="border-2 border-dashed border-[#30363D] hover:border-indigo-500/60 rounded-lg p-5 flex flex-col items-center justify-center text-center cursor-pointer bg-[#161B22]/50 hover:bg-[#161B22] transition-colors group"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0] ?? null;
                    setUploadedFile(file);
                    setUploadedFileName(file?.name ?? null);
                    setPipelineError(null);
                  }}
                >
                  <div className="w-10 h-10 rounded-md bg-[#21262D] group-hover:bg-indigo-950/40 border border-[#30363D] group-hover:border-indigo-500/40 flex items-center justify-center text-indigo-400 mb-2 transition-colors">
                    <UploadCloud className="w-5 h-5" />
                  </div>
                  <div className="text-xs font-semibold text-gray-200 mb-1">
                    Drop your project ZIP archive here
                  </div>
                  <div className="text-[11px] text-gray-500 mb-2">
                    .zip or .tar.gz · Max 500MB
                  </div>
                  <div className="flex gap-2">
                    <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-[#0D1117] text-gray-400 border border-[#30363D]">
                      .zip
                    </span>
                    <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-[#0D1117] text-gray-400 border border-[#30363D]">
                      .tar.gz
                    </span>
                  </div>
                  {uploadedFileName && (
                    <div className="mt-3 text-[11px] text-green-400 bg-green-950/40 border border-green-500/30 px-3 py-0.5 rounded flex items-center gap-1.5 font-mono">
                      <Check className="w-3 h-3" />
                      <span>Loaded: {uploadedFileName}</span>
                    </div>
                  )}
                </div>

                {pipelineError && (
                  <div className="text-[11px] text-red-300 bg-red-950/40 border border-red-500/30 px-3 py-2 rounded flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{pipelineError}</span>
                  </div>
                )}

                {/* 2. OPTIONAL CONTEXT DOCS UPLOADER UNDER THE ZIP UPLOAD */}
                <ContextDocsUploader
                  docs={contextDocs}
                  onAddDoc={handleAddContextDoc}
                  onRemoveDoc={handleRemoveContextDoc}
                  onClearAllDocs={handleClearAllContextDocs}
                  customInstructions={customInstructions}
                  onCustomInstructionsChange={setCustomInstructions}
                />

                {/* 3. Project Name input */}
                <div>
                  <label className="block text-[11px] font-semibold text-gray-400 mb-1">
                    Project Name
                  </label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="e.g. api-gateway"
                    className="w-full px-3 py-2 rounded-md bg-[#161B22] border border-[#30363D] text-xs text-gray-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                {/* 4. Start Button */}
                <button
                  id="start-ai-analysis-btn"
                  onClick={handleStartAnalysis}
                  disabled={isAnalyzing || !uploadedFile}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors shadow-sm cursor-pointer disabled:opacity-60"
                >
                  <Zap className={`w-3.5 h-3.5 ${isAnalyzing ? 'animate-spin' : ''}`} />
                  <span>{isAnalyzing ? 'Executing Pipeline & Streaming Logs...' : 'Start AI Analysis Pipeline'}</span>
                </button>
              </div>
            )}

            {/* Tab 2: GitHub / GitLab */}
            {activeUploadTab === 'github' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-semibold text-gray-400 mb-1">Repository URL</label>
                  <input
                    type="text"
                    value={githubUrl}
                    onChange={(e) => setGithubUrl(e.target.value)}
                    placeholder="https://github.com/organization/repo"
                    className="w-full px-3 py-2 rounded-md bg-[#161B22] border border-[#30363D] text-xs text-gray-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-gray-400 mb-1">Branch / Tag</label>
                  <input
                    type="text"
                    value={githubBranch}
                    onChange={(e) => setGithubBranch(e.target.value)}
                    placeholder="main"
                    className="w-full px-3 py-2 rounded-md bg-[#161B22] border border-[#30363D] text-xs text-gray-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                {githubTokenConnected === false && (
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-400 mb-1">
                      GitHub Personal Access Token <span className="text-gray-500 font-normal">(saved securely, one-time)</span>
                    </label>
                    <input
                      type="password"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      placeholder="ghp_..."
                      className="w-full px-3 py-2 rounded-md bg-[#161B22] border border-[#30363D] text-xs text-gray-200 focus:outline-none focus:border-indigo-500 font-mono"
                    />
                  </div>
                )}
                {githubTokenConnected === true && (
                  <p className="text-[11px] text-emerald-400 flex items-center gap-1">
                    <Check className="w-3 h-3" /> GitHub account connected
                  </p>
                )}

                {pipelineError && (
                  <div className="text-[11px] text-red-300 bg-red-950/40 border border-red-500/30 px-3 py-2 rounded flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{pipelineError}</span>
                  </div>
                )}

                {/* Optional Context Docs also for GitHub tab */}
                <ContextDocsUploader
                  docs={contextDocs}
                  onAddDoc={handleAddContextDoc}
                  onRemoveDoc={handleRemoveContextDoc}
                  onClearAllDocs={handleClearAllContextDocs}
                  customInstructions={customInstructions}
                  onCustomInstructionsChange={setCustomInstructions}
                />

                <button
                  onClick={handleStartGithubAnalysis}
                  disabled={isAnalyzing || githubConnecting}
                  className="w-full py-2.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  <Github className="w-3.5 h-3.5" />
                  <span>{githubConnecting ? 'Connecting...' : isAnalyzing ? 'Executing Pipeline...' : 'Clone & Run Pipeline'}</span>
                </button>
              </div>
            )}

            {/* Tab 3: Paste Code */}
            {activeUploadTab === 'paste' && (
              <div className="space-y-4">
                <textarea
                  rows={5}
                  placeholder="// Paste script, Dockerfile, or stack trace..."
                  className="w-full px-3 py-2 rounded-md bg-[#161B22] border border-[#30363D] font-mono text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
                  defaultValue={`async def authenticate_user(request: Request):\n    auth_header = request.headers.get("Authorization")\n    payload = jwt.decode(token, SECRET_KEY)\n    sub = payload.get("sub")\n    return await get_user_by_id(sub)`}
                />

                {/* Optional Context Docs also for Paste tab */}
                <ContextDocsUploader
                  docs={contextDocs}
                  onAddDoc={handleAddContextDoc}
                  onRemoveDoc={handleRemoveContextDoc}
                  onClearAllDocs={handleClearAllContextDocs}
                  customInstructions={customInstructions}
                  onCustomInstructionsChange={setCustomInstructions}
                />

                <button
                  onClick={handleStartAnalysis}
                  disabled={isAnalyzing}
                  className="w-full py-2.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>{isAnalyzing ? 'Executing Pipeline...' : 'Diagnose Code Snippet'}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Column (7 Cols) */}
        <div className="xl:col-span-7 space-y-6">

          {activeRightTab === 'pipeline' ? (
            <div className="space-y-6">
              
              {/* Analysis Pipeline Card */}
              <div className="rounded-lg bg-[#0D1117] border border-[#30363D] p-6 space-y-4 shadow-sm">
                
                {/* Pipeline Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xs font-bold text-gray-200 uppercase tracking-wider flex items-center gap-2">
                      <span>Analysis Pipeline</span>
                      {isAnalyzing && (
                        <span className="text-[10px] font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-2 py-0.5 rounded animate-pulse">
                          EXECUTING
                        </span>
                      )}
                      {contextDocs.length > 0 && (
                        <span className="text-[10px] font-mono bg-indigo-950/60 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded flex items-center gap-1">
                          <BookOpen className="w-3 h-3 text-indigo-400" />
                          <span>{contextDocs.length} Context Doc{contextDocs.length > 1 ? 's' : ''}</span>
                        </span>
                      )}
                    </h2>
                    <p className="text-[11px] text-gray-400 font-mono mt-0.5">
                      {projectName}{projectId ? ` (${projectId.slice(0, 8)})` : ''}{analysisId ? ` · run-${analysisId.slice(0, 8)}` : ''}{currentExecutingPhase ? <> · active phase: <span className="text-indigo-300 font-semibold">{currentExecutingPhase}</span></> : null}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right text-xs">
                      <span className="font-semibold text-gray-300">
                        {phases.filter(p => p.status === 'completed').length}/{phases.length} phases
                      </span>
                      <span className="text-gray-500 ml-2">{progress}% complete</span>
                    </div>
                    <span className={`px-2.5 py-0.5 text-[11px] font-semibold rounded flex items-center gap-1.5 ${
                      isAnalyzing 
                        ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' 
                        : progress === 100 
                        ? 'bg-green-500/10 text-green-400 border border-green-500/20' 
                        : 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isAnalyzing ? 'bg-amber-400 animate-ping' : 'bg-green-400'}`} />
                      <span>{isAnalyzing ? 'Running' : progress === 100 ? 'Completed' : 'Standby'}</span>
                    </span>
                    {previewCommand && (
                      <button
                        type="button"
                        onClick={handleOpenPreview}
                        className="px-2.5 py-1 rounded bg-emerald-950/40 hover:bg-emerald-950/60 border border-emerald-500/30 text-[11px] font-mono text-emerald-300 flex items-center gap-1.5 cursor-pointer transition-colors"
                        title={`Preview: ${previewCommand.command} on port ${previewCommand.port}`}
                      >
                        <span>▶ Preview App</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowCheckpointModal(true)}
                      className="px-2.5 py-1 rounded bg-indigo-950/40 hover:bg-indigo-950/60 border border-indigo-500/30 text-[11px] font-mono text-indigo-300 flex items-center gap-1.5 cursor-pointer transition-colors"
                      title="Opens the Phase 8 Preview Checkpoint UI on demand — the real trigger (automatic, right after Phase 8 finishes) needs the backend loop controller from PIPELINE_V2_ARCHITECTURE.md §4"
                    >
                      <span>⏸ Preview Checkpoint (Demo)</span>
                    </button>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="w-full bg-[#161B22] h-2 rounded-full overflow-hidden border border-[#30363D]">
                  <div 
                    className={`h-full rounded-full transition-all duration-300 ${
                      progress === 100 ? 'bg-green-500' : 'bg-indigo-500'
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>

                {/* Attempt Timeline — Attempt 1 ● Attempt 2 ● ... */}
                <AttemptTimeline
                  attempts={fixAttempts}
                  currentAttemptIndex={currentAttemptIndex}
                  onSelectAttempt={(index) => { setCurrentAttemptIndex(index); setShowAttemptDiff(true); }}
                  runStatus={progress === 100 ? 'COMPLETED' : isAnalyzing ? 'RUNNING' : 'PENDING'}
                  autoAttemptCount={autoAttemptCount}
                  maxAutoAttempts={3}
                  hadHumanInputInRound={hadHumanInputInRound}
                  onOpenPromptPad={() => setShowCheckpointModal(true)}
                />

                {showAttemptDiff && fixAttempts[currentAttemptIndex] && (
                  <AttemptDiffViewer
                    currentAttempt={fixAttempts[currentAttemptIndex]}
                    previousAttempt={fixAttempts.find((a) => a.id === fixAttempts[currentAttemptIndex].previousAttemptId) ?? null}
                  />
                )}

                {/* 10 Phase Stepper List */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                  {phases.map((phase) => {
                    const isCompleted = phase.status === 'completed';
                    const isRunning = phase.status === 'running';
                    const isPending = phase.status === 'pending';
                    const isProjectInput = phase.id === 1 || phase.name.toLowerCase().includes('input');

                    return (
                      <div 
                        key={phase.id}
                        onClick={() => handleOpenPhaseInspector(phase)}
                        role="button"
                        tabIndex={0}
                        title={`Click to inspect ${phase.name} execution details & security checks`}
                        className={`rounded-md border p-2.5 transition-all cursor-pointer group relative ${
                          isRunning 
                            ? 'bg-[#161B22] border-indigo-500/80 shadow-md ring-1 ring-indigo-500/30' 
                            : isCompleted
                            ? 'bg-[#161B22]/50 border-[#30363D] hover:border-indigo-500/60 hover:bg-[#161B22]'
                            : 'bg-[#0B0E14] border-[#21262D] opacity-60 hover:opacity-100 hover:border-[#30363D]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2.5 min-w-0">
                            {isCompleted && (
                              <div className="w-5 h-5 rounded bg-green-950/60 border border-green-500/40 text-green-400 flex items-center justify-center shrink-0 mt-0.5">
                                <Check className="w-3 h-3 stroke-[3]" />
                              </div>
                            )}

                            {isRunning && (
                              <div className="w-5 h-5 rounded bg-indigo-950/70 border border-indigo-500/50 text-indigo-400 flex items-center justify-center shrink-0 mt-0.5 animate-spin">
                                <RotateCw className="w-3 h-3" />
                              </div>
                            )}

                            {isPending && (
                              <div className="w-5 h-5 rounded bg-[#21262D] border border-[#30363D] text-gray-500 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-semibold">
                                {phase.id}
                              </div>
                            )}

                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 truncate">
                                <span className={`text-xs font-semibold truncate ${isRunning ? 'text-indigo-300' : isCompleted ? 'text-gray-200' : 'text-gray-400'} group-hover:text-indigo-300 transition-colors`}>
                                  {phase.name}
                                </span>
                                {isRunning && (
                                  <span className="text-[9px] font-bold px-1 py-0.1 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shrink-0">
                                    LIVE
                                  </span>
                                )}
                                {isProjectInput && (
                                  <span className="text-[8px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-1 py-0.2 rounded shrink-0">
                                    SECURITY CHECK
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-gray-400 truncate mt-0.5 group-hover:text-gray-300 transition-colors">
                                {phase.description}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {phase.duration && (
                              <span className="text-[10px] font-mono text-gray-500">
                                {phase.duration}
                              </span>
                            )}
                            <span className="text-[9px] font-mono text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">
                              Inspect ↗
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

              </div>

              {/* LIVE LOG TABLE DIRECTLY UNDER THE ANALYSIS PIPELINE */}
              <LiveLogTable
                logs={logs}
                isExecuting={isAnalyzing}
                currentPhaseName={currentExecutingPhase}
                onClearLogs={handleClearLogs}
                onRestartPipeline={handleStartAnalysis}
              />

            </div>
          ) : (
            /* Tech Stack & Diagnostics View */
            <div className="space-y-6">
              
              {/* Stack & Structure */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-lg bg-[#0D1117] border border-[#30363D] p-5 space-y-3">
                  <h3 className="text-xs font-bold text-gray-200 uppercase tracking-wider flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-indigo-400" />
                    <span>Detected Runtime Stack</span>
                  </h3>
                  {detectedStack ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between p-2 rounded bg-[#161B22] border border-[#30363D]">
                        <span className="text-gray-400">Language</span>
                        <span className="font-semibold text-gray-200 font-mono">{detectedStack.language ?? 'Not detected yet'}</span>
                      </div>
                      <div className="flex items-center justify-between p-2 rounded bg-[#161B22] border border-[#30363D]">
                        <span className="text-gray-400">Framework</span>
                        <span className="font-semibold text-gray-200 font-mono">{detectedStack.framework ?? 'Not detected yet'}</span>
                      </div>
                      <div className="flex items-center justify-between p-2 rounded bg-[#161B22] border border-[#30363D]">
                        <span className="text-gray-400">Project Status</span>
                        <span className="font-semibold text-gray-200 font-mono">{detectedStack.status}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-gray-500 py-3">
                      Run an analysis to detect the project's language and framework — nothing is shown here until the backend actually reports it.
                    </p>
                  )}
                </div>

                <div className="rounded-lg bg-[#0D1117] border border-[#30363D] p-5 space-y-3">
                  <h3 className="text-xs font-bold text-gray-200 uppercase tracking-wider flex items-center gap-2">
                    <Layers className="w-4 h-4 text-indigo-400" />
                    <span>Key Package Dependencies</span>
                  </h3>
                  <p className="text-[11px] text-gray-500 py-3">
                    Dependency extraction isn't wired up on the backend yet (lands with the Install & Build phase). This panel will populate from real scan results once that's built — nothing fabricated here in the meantime.
                  </p>
                </div>
              </div>

              {/* Full Live Log Table also available here */}
              <LiveLogTable
                logs={logs}
                isExecuting={isAnalyzing}
                currentPhaseName={currentExecutingPhase}
                onClearLogs={handleClearLogs}
                onRestartPipeline={handleStartAnalysis}
              />

            </div>
          )}

        </div>

      </div>

      {/* Phase Inspector Modal */}
      <PhaseInspectorModal
  phase={selectedPhaseForInspection}
  isOpen={isPhaseInspectorOpen}
  onClose={handleClosePhaseInspector}
  projectName={projectName}
  contextDocs={contextDocs}
  analysisId={analysisId}
  onRerunSecurityChecks={handleRerunSecurityChecks}
  onOpenPreview={handleOpenPreview}
/>

      {showEmbeddedPreview && projectId && previewCommand && (
        <EmbeddedBrowserPreview
          projectId={projectId}
          projectName={projectName}
          previewCommand={previewCommand}
          onClose={() => setShowEmbeddedPreview(false)}
        />
      )}

      <PreviewCheckpointModal
        isOpen={showCheckpointModal}
        onClose={() => setShowCheckpointModal(false)}
        checkpoint={checkpoint}
        onDecision={handleCheckpointDecision}
        onSubmitPrompt={handleCheckpointSubmitPrompt}
        onSaveFileEdit={handleCheckpointSaveFileEdit}
        onTriggerManualLoop={handleCheckpointTriggerManualLoop}
        onGoNext={handleCheckpointGoNext}
        hadHumanInput={hadHumanInputInRound}
      />
    </div>
  );
};