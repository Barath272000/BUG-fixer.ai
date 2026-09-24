import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Files,
  File as FileIcon,
  FileCode,
  FilePlus,
  Folder,
  FolderPlus,
  GitBranch,
  GitCommit,
  Loader2,
  Package,
  PanelBottom,
  Pencil,
  Play,
  RefreshCw,
  Radio,
  Save,
  Search,
  Sparkles,
  Copy as CopyIcon,
  Trash2,
  X,
} from 'lucide-react';
import Editor, { OnMount } from '@monaco-editor/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bug as BugType, LogLine } from '../types';
import {
  fetchWorkspaceFile,
  fetchWorkspaceTree,
  saveWorkspaceFile,
  WorkspaceTreeNode,
  WorkspaceExecResult,
  searchWorkspaceFiles,
  WorkspaceSearchMatch,
  fetchWorkspaceGitStatus,
  fetchWorkspaceGitDiff,
  fetchPersistentTerminalProcesses,
  fetchWorkspacePorts,
  commitWorkspaceChanges,
  WorkspaceGitStatus,
  deleteWorkspacePath,
  renameWorkspacePath,
  createWorkspaceFolder,
  interruptPersistentTerminal,
  readPersistentTerminalOutput,
  sendPersistentTerminalInput,
  startPersistentTerminal,
  stopPersistentTerminal,
} from '../api/workspace';
import { fetchAnalysisLogs, fetchLatestAnalysisRun } from '../api/analysis';
import { ApiError } from '../api/client';
import { getPreviewState, startPreview, stopPreview } from '../api/preview';
import {
  connectOrchestratorStream,
  fetchOrchestratorState,
  OrchestratorStateName,
  startNativeIdeCore,
  stopNativeIdeCore,
  setOrchestratorState,
} from '../api/orchestrator';
import { addRecentFile } from '../utils/recentFiles';
import { AgentPanel } from './Agentpanel';
import { IdeMenuBar } from './IdeMenuBar';

interface WorkspaceViewProps {
  initialSelectedBug?: BugType | null;
  activeModel?: string;
  onOpenModelSelector?: () => void;
  projectId?: string | null;
  bugs?: BugType[];
}

type ActivityView = 'explorer' | 'search' | 'git' | 'extensions' | 'none';
type BottomTab = 'problems' | 'output' | 'terminal' | 'debug_console' | 'ports';

type WorkspacePort = {
  id: string;
  port: number;
  name: string;
  description: string;
  source: string;
  protocol: 'http' | 'tcp';
  browser: boolean;
  visibility: 'private' | 'public';
  url?: string;
};

type TaskRunStatus = 'success' | 'failed';

interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
}

interface WorkspaceTask {
  id: string;
  label: string;
  command: string;
  description: string;
  category: 'frontend' | 'backend' | 'workspace';
}

interface WorkspaceExtension {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
  tasks: WorkspaceTask[];
}

const DEFAULT_WORKSPACE_EXTENSIONS: WorkspaceExtension[] = [
  {
    id: 'task-runner',
    name: 'Task Runner',
    description: 'Project commands for build, test, and workspace orchestration.',
    enabled: true,
    tags: ['tools', 'build'],
    tasks: [
      {
        id: 'frontend-build',
        label: 'Build frontend',
        command: 'cd frontend && npm run build',
        description: 'Compile the Vite production bundle.',
        category: 'frontend',
      },
      {
        id: 'backend-tests',
        label: 'Run backend tests',
        command: 'cd backend && pytest -q',
        description: 'Execute the Python backend test suite.',
        category: 'backend',
      },
      {
        id: 'backend-stack',
        label: 'Start backend stack',
        command: 'cd backend && docker compose up -d',
        description: 'Bring up the API and its supporting services.',
        category: 'backend',
      },
    ],
  },
  {
    id: 'build-tools',
    name: 'Build Tools',
    description: 'Compile and validate the active workspace with the right toolchain.',
    enabled: true,
    tags: ['validation', 'build'],
    tasks: [
      {
        id: 'frontend-dev',
        label: 'Run frontend dev server',
        command: 'cd frontend && npm run dev -- --host 0.0.0.0',
        description: 'Start the local UI dev server.',
        category: 'frontend',
      },
      {
        id: 'workspace-lint',
        label: 'Workspace validation',
        command: 'cd frontend && npm run build',
        description: 'Perform a front-end validation pass for the active workspace state.',
        category: 'workspace',
      },
    ],
  },
  {
    id: 'debug-tools',
    name: 'Debug Tools',
    description: 'Runtime commands for the active file and debugger console.',
    enabled: true,
    tags: ['debug', 'runtime'],
    tasks: [
      {
        id: 'active-file-run',
        label: 'Run active file',
        command: 'placeholder-run',
        description: 'Executed dynamically for the current file type.',
        category: 'workspace',
      },
    ],
  },
];

function isDirty(file: OpenFile): boolean {
  return file.content !== file.savedContent;
}

function fileIconColor(name: string): string {
  if (name.endsWith('.py')) return 'text-[#3572A5]';
  if (name.endsWith('.js') || name.endsWith('.jsx')) return 'text-[#F1E05A]';
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'text-[#3178C6]';
  if (name.endsWith('.go')) return 'text-[#00ADD8]';
  if (name.endsWith('.md')) return 'text-[#42A5F5]';
  if (name.endsWith('.json')) return 'text-[#CBCB41]';
  return 'text-[#9CDCFE]';
}

const EXTENSION_TO_MONACO_LANGUAGE: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  dockerfile: 'dockerfile',
  env: 'ini',
  ini: 'ini',
  txt: 'plaintext',
};

const WORKSPACE_PORTS: WorkspacePort[] = [
  { id: 'frontend', port: 3000, name: 'Frontend', description: 'Vite development server', source: 'Codespace', protocol: 'http', browser: true, visibility: 'private' },
  { id: 'backend', port: 4000, name: 'Backend API', description: 'FastAPI application', source: 'Docker', protocol: 'http', browser: true, visibility: 'private' },
  { id: 'postgres', port: 5432, name: 'PostgreSQL', description: 'Database service', source: 'Docker', protocol: 'tcp', browser: false, visibility: 'private' },
  { id: 'redis', port: 6379, name: 'Redis', description: 'Cache and task queue', source: 'Docker', protocol: 'tcp', browser: false, visibility: 'private' },
];

function getWorkspacePortUrl(port: number): string {
  const { protocol, hostname } = window.location;
  const codespacesHost = hostname.match(/^(.*)-\d+(\.app\.github\.dev|\.githubpreview\.dev)$/);
  if (codespacesHost) return `${protocol}//${codespacesHost[1]}-${port}${codespacesHost[2]}`;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `${protocol}//${hostname}:${port}`;
  return `${protocol}//${hostname}:${port}`;
}

function monacoLanguageFor(path: string): string {
  const name = path.split('/').pop() ?? path;
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return EXTENSION_TO_MONACO_LANGUAGE[ext] ?? 'plaintext';
}

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  initialSelectedBug,
  activeModel = 'GPT-4-Turbo',
  onOpenModelSelector,
  projectId = null,
  bugs = [],
}) => {
  const buildBugFileCandidates = useCallback((rawPath?: string) => {
    if (!rawPath) return [] as string[];

    const normalized = rawPath.replace(/\\/g, '/').trim().replace(/^\/+/, '');
    if (!normalized) return [] as string[];

    const candidates = new Set<string>();
    candidates.add(normalized);

    const shortName = normalized.split('/').pop() ?? normalized;
    if (shortName !== normalized) candidates.add(shortName);

    if (!normalized.startsWith('backend/') && !normalized.startsWith('frontend/') && !normalized.startsWith('src/') && !normalized.startsWith('app/')) {
      candidates.add(`backend/${normalized}`);
      candidates.add(`frontend/${normalized}`);
    }

    return Array.from(candidates);
  }, []);

  useEffect(() => {
    if (!initialSelectedBug || !projectId) return;

    const targetPath = initialSelectedBug.filePath;
    if (!targetPath) return;

    let didCancel = false;

    const openBugTarget = async () => {
      const candidates = buildBugFileCandidates(targetPath);

      for (const candidate of candidates) {
        try {
          const result = await fetchWorkspaceFile(projectId, candidate);
          if (didCancel) return;

          setActivityView('explorer');
          setSelectedPath(candidate);
          setOpenFiles(prev => {
            if (prev.some(file => file.path === candidate)) {
              return prev;
            }
            return [...prev, { path: candidate, content: result.content, savedContent: result.content }];
          });
          setActivePath(candidate);
          addRecentFile(projectId, candidate);

          const targetLine = initialSelectedBug.lineNumber ?? 1;
          setTimeout(() => {
            if (!didCancel && editorRef.current) {
              editorRef.current.setPosition({ lineNumber: targetLine, column: 1 });
              editorRef.current.revealLineInCenter(targetLine);
              editorRef.current.focus();
            }
          }, 150);

          return;
        } catch {
          // Keep trying the other likely locations for this bug file.
        }
      }

      const fallbackName = targetPath.split('/').pop() ?? initialSelectedBug.title;
      try {
        const matches = await searchWorkspaceFiles(projectId, fallbackName);
        if (didCancel || matches.length === 0) return;
        const nextTarget = matches[0].file;
        setActivityView('explorer');
        setSelectedPath(nextTarget);
        await openFile(nextTarget);

        const targetLine = initialSelectedBug.lineNumber ?? matches[0].line ?? 1;
        setTimeout(() => {
          if (!didCancel && editorRef.current) {
            editorRef.current.setPosition({ lineNumber: targetLine, column: 1 });
            editorRef.current.revealLineInCenter(targetLine);
            editorRef.current.focus();
          }
        }, 150);
      } catch {
        // Fall back silently when no file can be resolved.
      }
    };

    void openBugTarget();

    return () => {
      didCancel = true;
    };
  }, [buildBugFileCandidates, initialSelectedBug, projectId]);

  // --- Activity bar / panel layout state ---
  const [activityView, setActivityView] = useState<ActivityView>('explorer');
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [agentPanelWidth, setAgentPanelWidth] = useState(320);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(176);
  const [bottomTab, setBottomTab] = useState<BottomTab>('problems');
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const beginPanelResize = useCallback((direction: 'bottom' | 'agent', event: React.PointerEvent) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialWidth = agentPanelWidth;
    const initialHeight = bottomPanelHeight;
    const handleMove = (moveEvent: PointerEvent) => {
      if (direction === 'agent') {
        const maxWidth = Math.min(640, window.innerWidth - 420);
        setAgentPanelWidth(Math.min(Math.max(initialWidth + startX - moveEvent.clientX, 280), maxWidth));
      } else {
        const maxHeight = Math.min(520, window.innerHeight - 180);
        setBottomPanelHeight(Math.min(Math.max(initialHeight + startY - moveEvent.clientY, 120), maxHeight));
      }
    };
    const handleUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      resizeCleanupRef.current = null;
    };
    document.body.style.cursor = direction === 'agent' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    resizeCleanupRef.current = handleUp;
  }, [agentPanelWidth, bottomPanelHeight]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const [previewSupported, setPreviewSupported] = useState<boolean | null>(null);
  const [previewPort, setPreviewPort] = useState<{ port: number; url: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [portQuery, setPortQuery] = useState('');
  const [manualPort, setManualPort] = useState('');
  const [manualPortName, setManualPortName] = useState('');
  const [manualPorts, setManualPorts] = useState<WorkspacePort[]>([]);

  const loadPreviewState = useCallback(async () => {
    if (!projectId) {
      setPreviewSupported(null);
      return;
    }
    try {
      const state = await getPreviewState(projectId);
      setPreviewSupported(state.supported);
      setPreviewError(null);
    } catch (err) {
      setPreviewSupported(false);
      setPreviewError(err instanceof ApiError ? err.message : 'Could not inspect the application preview.');
    }
  }, [projectId]);

  useEffect(() => {
    if (bottomTab === 'ports') void loadPreviewState();
  }, [bottomTab, loadPreviewState]);

  const handleStartPreview = async () => {
    if (!projectId || previewLoading) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await startPreview(projectId, 'original');
      setPreviewPort({ port: result.hostPort, url: result.url });
      setPreviewSupported(true);
    } catch (err) {
      setPreviewError(err instanceof ApiError ? err.message : 'Could not start the application preview.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStopPreview = async () => {
    if (!projectId || previewLoading) return;
    setPreviewLoading(true);
    try {
      await stopPreview(projectId);
      setPreviewPort(null);
    } catch (err) {
      setPreviewError(err instanceof ApiError ? err.message : 'Could not stop the application preview.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const addManualPort = () => {
    const port = Number.parseInt(manualPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const id = `manual-${port}`;
    setManualPorts(prev => [
      ...prev.filter(entry => entry.port !== port),
      {
        id,
        port,
        name: manualPortName.trim() || `Port ${port}`,
        description: 'Manually forwarded workspace port',
        source: 'Manual',
        protocol: 'http' as const,
        browser: true,
        visibility: 'private' as const,
        url: getWorkspacePortUrl(port),
      },
    ]);
    setManualPort('');
    setManualPortName('');
  };

  const copyPortAddress = async (port: WorkspacePort) => {
    await navigator.clipboard.writeText(port.url ?? getWorkspacePortUrl(port.port));
  };

  // --- Editor preference state (driven by the menu bar) ---
  const [wordWrap, setWordWrap] = useState(false);
  const [autoSave, setAutoSave] = useState(true);

  // --- Tree state ---
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  // Explorer-only selection (separate from activePath): lets Delete/F2 act on
  // whichever file or folder was last clicked/right-clicked in the tree,
  // without changing the existing click-to-open behavior.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const explorerTreeRef = useRef<HTMLDivElement>(null);
  // Clipboard for Explorer Copy/Paste (duplicate a file or folder elsewhere
  // in the workspace). Deliberately not bound to Ctrl+C/Ctrl+V globally —
  // that would hijack normal text copy/paste everywhere else on the page.
  const [explorerClipboard, setExplorerClipboard] = useState<{ path: string; type: 'file' | 'folder' } | null>(null);

  // --- Open files / editor state ---
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [openEditorsCollapsed, setOpenEditorsCollapsed] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [orchestratorState, setOrchestratorStateValue] = useState<OrchestratorStateName>('live');

  useEffect(() => {
    let cancelled = false;
    void fetchOrchestratorState()
      .then(result => {
        if (!cancelled) setOrchestratorStateValue(result.active);
      })
      .catch(() => undefined);

    const socket = connectOrchestratorStream(event => {
      if (
        !cancelled
        && event.type === 'state.changed'
        && (event.payload.active === 'live' || event.payload.active === 'staging')
      ) {
        setOrchestratorStateValue(event.payload.active as OrchestratorStateName);
      }
    });
    return () => {
      cancelled = true;
      socket.close();
    };
  }, []);

  const changeOrchestratorState = (nextState: OrchestratorStateName) => {
    setOrchestratorStateValue(nextState);
    void setOrchestratorState(nextState).catch(() => {
      setStatusMessage('Could not change workspace state.');
    });
  };

  const handleStartIdeCore = async () => {
    try {
      const result = await startNativeIdeCore();
      setStatusMessage(`Native IDE Core running on ${result.host}:${result.port} with reload enabled.`);
    } catch (err) {
      setStatusMessage(err instanceof ApiError ? err.message : 'Could not start the native IDE Core.');
    }
  };

  const handleStopIdeCore = async () => {
    try {
      await stopNativeIdeCore();
      setStatusMessage('Native IDE Core stopped.');
    } catch (err) {
      setStatusMessage(err instanceof ApiError ? err.message : 'Could not stop the native IDE Core.');
    }
  };

  // --- New file / new folder UI ---
  const [creatingPath, setCreatingPath] = useState<string | null>(null); // parent folder path, '' for root
  const [creatingKind, setCreatingKind] = useState<'file' | 'folder'>('file');
  const [newFileName, setNewFileName] = useState('');
  const newFileInputRef = useRef<HTMLInputElement>(null);

  // --- Right-click context menu (Explorer) ---
  interface ContextMenuState { x: number; y: number; node: WorkspaceTreeNode | null } // node null = empty-space/root
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // --- Rename UI ---
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const activeFile = openFiles.find(f => f.path === activePath) ?? null;

  // --- Find in Files (real) ---
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<WorkspaceSearchMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  interface WorkspaceDiagnostic {
    id: string;
    title: string;
    severity: 'Critical' | 'High' | 'Medium' | 'Low';
    status: 'Open';
    filePath: string;
    lineNumber: number;
  }

  interface WorkspaceSymbol {
    id: string;
    name: string;
    file: string;
    kind: 'function' | 'class' | 'variable' | 'method';
    line: number;
    preview: string;
  }

  const editorRef = useRef<any>(null);
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnostic[]>([]);
  const [workspaceSymbols, setWorkspaceSymbols] = useState<WorkspaceSymbol[]>([]);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState('');
  const [agentQuickPrompt, setAgentQuickPrompt] = useState<string | null>(null);

  const [isGoToFileOpen, setIsGoToFileOpen] = useState(false);
  const [goToFileQuery, setGoToFileQuery] = useState('');
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [taskQuery, setTaskQuery] = useState('');
  const [workspaceExtensions, setWorkspaceExtensions] = useState<WorkspaceExtension[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_WORKSPACE_EXTENSIONS;
    try {
      const raw = window.localStorage.getItem('bugfixer-workspace-extensions');
      if (!raw) return DEFAULT_WORKSPACE_EXTENSIONS;
      const parsed = JSON.parse(raw) as WorkspaceExtension[];
      if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_WORKSPACE_EXTENSIONS;
      const merged = DEFAULT_WORKSPACE_EXTENSIONS.map(defaultExt => {
        const found = parsed.find(ext => ext.id === defaultExt.id);
        return found ? { ...defaultExt, ...found, tasks: found.tasks?.length ? found.tasks : defaultExt.tasks } : defaultExt;
      });
      return merged;
    } catch {
      return DEFAULT_WORKSPACE_EXTENSIONS;
    }
  });
  const [taskHistory, setTaskHistory] = useState<Array<{
    id: string;
    taskId: string;
    label: string;
    command: string;
    status: TaskRunStatus;
    exitCode: number;
    timestamp: string;
  }>>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem('bugfixer-task-history');
      return raw ? JSON.parse(raw) as Array<{ id: string; taskId: string; label: string; command: string; status: TaskRunStatus; exitCode: number; timestamp: string; }> : [];
    } catch {
      return [];
    }
  });
  const [lastTaskResult, setLastTaskResult] = useState<{ id: string; taskId: string; label: string; command: string; status: TaskRunStatus; exitCode: number; timestamp: string; } | null>(null);

  const recordTaskResult = useCallback((nextResult: { id: string; taskId: string; label: string; command: string; status: TaskRunStatus; exitCode: number; timestamp: string; }) => {
    setTaskHistory(prev => [nextResult, ...prev.filter(item => !(item.taskId === nextResult.taskId && item.label === nextResult.label && item.command === nextResult.command))].slice(0, 8));
    setLastTaskResult(nextResult);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('bugfixer-task-history', JSON.stringify(taskHistory.slice(0, 8)));
      window.localStorage.setItem('bugfixer-workspace-extensions', JSON.stringify(workspaceExtensions));
    }
  }, [taskHistory, workspaceExtensions]);

  const flatFiles = useMemo(() => {
    const out: string[] = [];
    const walkTree = (nodes: WorkspaceTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'file') out.push(node.path);
        else if (node.children) walkTree(node.children);
      }
    };
    walkTree(tree);
    return out;
  }, [tree]);

  const goToFileResults = useMemo(() => {
    const q = goToFileQuery.trim().toLowerCase();
    if (!q) return flatFiles.slice(0, 30);
    return flatFiles.filter(f => f.toLowerCase().includes(q)).slice(0, 30);
  }, [flatFiles, goToFileQuery]);

  const workspaceTasks = useMemo<WorkspaceTask[]>(() => {
    const enabledTasks = workspaceExtensions
      .filter(ext => ext.enabled)
      .flatMap(ext => ext.tasks);

    const activePath = activeFile?.path ?? '';
    if (!activePath) return enabledTasks;

    const activeTasks = [...enabledTasks];
    if (activePath.includes('/frontend/')) {
      return activeTasks.filter(task => task.category !== 'backend' || task.id === 'backend-tests');
    }
    if (activePath.includes('/backend/')) {
      return activeTasks.filter(task => task.category !== 'frontend' || task.id === 'frontend-build');
    }
    return activeTasks;
  }, [activeFile, workspaceExtensions]);

  const taskResults = useMemo(() => {
    const q = taskQuery.trim().toLowerCase();
    if (!q) return workspaceTasks;
    return workspaceTasks.filter(task =>
      task.label.toLowerCase().includes(q) ||
      task.description.toLowerCase().includes(q) ||
      task.command.toLowerCase().includes(q)
    );
  }, [taskQuery, workspaceTasks]);

  const collectWorkspaceSymbolsForFile = useCallback((filePath: string, content: string): WorkspaceSymbol[] => {
    const lines = content.split(/\r?\n/);
    const entries: WorkspaceSymbol[] = [];

    const pushSymbol = (match: RegExpMatchArray, kind: WorkspaceSymbol['kind']) => {
      const name = match[1] ?? match[2] ?? match[0];
      const line = lines.findIndex(line => line.includes(name));
      const preview = lines[line] ?? '';
      entries.push({
        id: `${filePath}:${line + 1}:${name}`,
        name,
        file: filePath,
        kind,
        line: Math.max(1, line + 1),
        preview,
      });
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

      const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
      const methodMatch = trimmed.match(/^(?:public|private|protected|static\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/);
      const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
      const defMatch = trimmed.match(/^def\s+([A-Za-z0-9_]+)/);
      const variableMatch = trimmed.match(/^(?:const|let|var|public|private|protected)\s+([A-Za-z0-9_]+)\s*[:=]/);

      if (functionMatch) pushSymbol(functionMatch, 'function');
      else if (methodMatch && !trimmed.startsWith('if ') && !trimmed.startsWith('for ') && !trimmed.startsWith('while ')) pushSymbol(methodMatch, 'method');
      else if (classMatch) pushSymbol(classMatch, 'class');
      else if (defMatch) pushSymbol(defMatch, 'function');
      else if (variableMatch) pushSymbol(variableMatch, 'variable');
      if (idx > 300) return;
    });

    return entries;
  }, []);

  const inspectOpenFilesForDiagnostics = useCallback(() => {
    const diagnostics: WorkspaceDiagnostic[] = [];

    openFiles.forEach(file => {
      const lines = file.content.split(/\r?\n/);
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (/TODO|FIXME|HACK/i.test(trimmed)) {
          diagnostics.push({
            id: `${file.path}:${index + 1}:todo`,
            title: `Follow-up note: ${trimmed.slice(0, 60)}`,
            severity: 'Low',
            status: 'Open',
            filePath: file.path,
            lineNumber: index + 1,
          });
        }
      });

      if (file.path.endsWith('.py') && !file.content.trim()) {
        diagnostics.push({
          id: `${file.path}:empty`,
          title: 'Empty file is ready for implementation.',
          severity: 'Low',
          status: 'Open',
          filePath: file.path,
          lineNumber: 1,
        });
      }
    });

    setWorkspaceDiagnostics(diagnostics.slice(0, 40));
  }, [openFiles]);

  const loadWorkspaceSymbols = useCallback(async () => {
    if (!projectId) {
      setWorkspaceSymbols([]);
      return;
    }

    const symbolMap = new Map<string, WorkspaceSymbol>();
    const filesForScan = flatFiles.slice(0, 40);

    for (const filePath of filesForScan) {
      try {
        const result = await fetchWorkspaceFile(projectId, filePath);
        const symbols = collectWorkspaceSymbolsForFile(filePath, result.content);
        symbols.forEach(symbol => symbolMap.set(symbol.id, symbol));
      } catch {
        // Skip unreadable files in the workspace symbol index.
      }
    }

    setWorkspaceSymbols(Array.from(symbolMap.values()).slice(0, 200));
  }, [collectWorkspaceSymbolsForFile, flatFiles, projectId]);

  const openSymbolAt = useCallback(async (filePath: string, lineNumber: number) => {
    setSymbolPickerOpen(false);
    setSymbolQuery('');
    setActivityView('explorer');
    try {
      await openFile(filePath);
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.setPosition({ lineNumber, column: 1 });
          editorRef.current.revealLineInCenter(lineNumber);
          editorRef.current.focus();
        }
      }, 120);
    } catch {
      // openFile handles its own error state.
    }
  }, []);

  const handleOpenWorkspaceSymbols = useCallback(() => {
    setSymbolQuery('');
    void loadWorkspaceSymbols();
    setSymbolPickerOpen(true);
  }, [loadWorkspaceSymbols]);

  const handleOpenEditorSymbols = useCallback(() => {
    if (!activeFile) {
      setSymbolPickerOpen(false);
      return;
    }
    const symbols = collectWorkspaceSymbolsForFile(activeFile.path, activeFile.content);
    setWorkspaceSymbols(symbols);
    setSymbolQuery('');
    setSymbolPickerOpen(true);
  }, [activeFile, collectWorkspaceSymbolsForFile]);

  const runSearch = useCallback(async (query: string) => {
    if (!projectId || !query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const results = await searchWorkspaceFiles(projectId, query);
      setSearchResults(results);
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setSearchLoading(false);
    }
  }, [projectId]);

  // --- Source Control (real) ---
  const [gitStatusData, setGitStatusData] = useState<WorkspaceGitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);

  const loadGitStatus = useCallback(async () => {
    if (!projectId) return;
    setGitLoading(true);
    setGitError(null);
    try {
      const status = await fetchWorkspaceGitStatus(projectId);
      setGitStatusData(status);
    } catch (err) {
      setGitError(err instanceof ApiError ? err.message : 'Could not load source control status.');
    } finally {
      setGitLoading(false);
    }
  }, [projectId]);

  const viewDiff = async (path: string) => {
    if (!projectId) return;
    setDiffPath(path);
    setDiffLoading(true);
    try {
      const diff = await fetchWorkspaceGitDiff(projectId, path);
      setDiffContent(diff);
    } catch (err) {
      setDiffContent(err instanceof ApiError ? err.message : 'Could not load diff.');
    } finally {
      setDiffLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!projectId || !commitMessage.trim()) return;
    setCommitting(true);
    try {
      await commitWorkspaceChanges(projectId, commitMessage);
      setCommitMessage('');
      setDiffPath(null);
      await loadGitStatus();
    } catch (err) {
      setGitError(err instanceof ApiError ? err.message : 'Commit failed.');
    } finally {
      setCommitting(false);
    }
  };

  useEffect(() => {
    if (activityView === 'git') void loadGitStatus();
  }, [activityView, loadGitStatus]);

  // --- Terminal (real) ---
  // Each command still runs in its own disposable sandbox container on the
  // backend (no long-lived shell process) -- but exec_command() now cd's
  // into the previous command's ending directory before running the next
  // one and hands back where it ended up, so `cd backend` really does
  // "stick" for the commands you run after it, the way a real terminal
  // feels, even though nothing is actually kept running between calls.
  interface TerminalEntry { command: string; stdout: string; stderr: string; code: number; cwd: string }
  interface TerminalSession {
    id: string;
    name: string;
    history: TerminalEntry[];
    input: string;
    cwd: string;
    commandHistory: string[];
    backendId: string | null;
    outputCursor: number;
    shell: 'bash' | 'sh';
  }
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([]);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState('');
  const [terminalCommandHistory, setTerminalCommandHistory] = useState<string[]>([]);
  const terminalHistoryIndexRef = useRef<number | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([
    { id: 'terminal-1', name: 'Terminal 1', history: [], input: '', cwd: '', commandHistory: [], backendId: null, outputCursor: 0, shell: 'bash' },
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState('terminal-1');
  const [terminalShell, setTerminalShell] = useState<'bash' | 'sh'>('bash');
  const [renamingTerminalId, setRenamingTerminalId] = useState<string | null>(null);
  const [terminalNameInput, setTerminalNameInput] = useState('');
  const [terminalProcessCount, setTerminalProcessCount] = useState(0);
  const [detectedPorts, setDetectedPorts] = useState<WorkspacePort[]>([]);
  const [debugConsoleInput, setDebugConsoleInput] = useState('');
  const [debugConsoleHistory, setDebugConsoleHistory] = useState<string[]>([]);
  const [debugConsoleEntries, setDebugConsoleEntries] = useState<Array<{ id: string; level: 'info' | 'stdout' | 'stderr' | 'error'; text: string; timestamp: string }>>([]);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const debugConsoleEndRef = useRef<HTMLDivElement>(null);

  const saveActiveTerminalSession = useCallback(() => {
    setTerminalSessions(prev => prev.map(session => session.id === activeTerminalId ? {
      ...session,
      history: terminalHistory,
      input: terminalInput,
      cwd: terminalCwd,
      commandHistory: terminalCommandHistory,
      backendId: session.backendId,
      outputCursor: session.outputCursor,
      shell: session.shell,
    } : session));
  }, [activeTerminalId, terminalCommandHistory, terminalCwd, terminalHistory, terminalInput]);

  const switchTerminalSession = useCallback((sessionId: string) => {
    if (sessionId === activeTerminalId || terminalRunning) return;
    const updatedSessions = terminalSessions.map(session => session.id === activeTerminalId ? {
      ...session,
      history: terminalHistory,
      input: terminalInput,
      cwd: terminalCwd,
      commandHistory: terminalCommandHistory,
    } : session);
    const target = updatedSessions.find(session => session.id === sessionId);
    if (!target) return;
    setTerminalSessions(updatedSessions);
    setActiveTerminalId(sessionId);
    setTerminalHistory(target.history);
    setTerminalInput(target.input);
    setTerminalCwd(target.cwd);
    setTerminalCommandHistory(target.commandHistory);
    setTerminalShell(target.shell);
    terminalHistoryIndexRef.current = null;
  }, [activeTerminalId, terminalCommandHistory, terminalCwd, terminalHistory, terminalInput, terminalRunning, terminalSessions]);

  const createTerminalSession = useCallback(() => {
    if (terminalRunning) return;
    saveActiveTerminalSession();
    const nextNumber = terminalSessions.length + 1;
    const session = { id: `terminal-${Date.now()}`, name: `Terminal ${nextNumber}`, history: [], input: '', cwd: '', commandHistory: [], backendId: null, outputCursor: 0, shell: terminalShell };
    setTerminalSessions(prev => [...prev, session]);
    setActiveTerminalId(session.id);
    setTerminalHistory([]);
    setTerminalInput('');
    setTerminalCwd('');
    setTerminalCommandHistory([]);
    terminalHistoryIndexRef.current = null;
  }, [saveActiveTerminalSession, terminalRunning, terminalSessions.length, terminalShell]);

  const closeTerminalSession = useCallback((sessionId: string) => {
    if (terminalSessions.length === 1 || terminalRunning) return;
    const closingSession = terminalSessions.find(session => session.id === sessionId);
    if (closingSession?.backendId && projectId) {
      void stopPersistentTerminal(projectId, closingSession.backendId);
    }
    const remaining = terminalSessions.filter(session => session.id !== sessionId);
    if (sessionId !== activeTerminalId) {
      setTerminalSessions(remaining);
      return;
    }
    const next = remaining[remaining.length - 1];
    setTerminalSessions(remaining);
    setActiveTerminalId(next.id);
    setTerminalHistory(next.history);
    setTerminalInput(next.input);
    setTerminalCwd(next.cwd);
    setTerminalCommandHistory(next.commandHistory);
    setTerminalShell(next.shell);
    terminalHistoryIndexRef.current = null;
  }, [activeTerminalId, projectId, terminalRunning, terminalSessions]);

  const appendDebugConsoleEntry = useCallback((level: 'info' | 'stdout' | 'stderr' | 'error', text: string) => {
    setDebugConsoleEntries(prev => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        level,
        text,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, []);

  const refreshTerminalProcesses = useCallback(async () => {
    if (!projectId) return;
    try {
      const processes = await fetchPersistentTerminalProcesses(projectId);
      setTerminalProcessCount(processes.filter(process => process.running).length);
      const reconnectable = processes.find(process => process.running);
      if (reconnectable) {
        setTerminalSessions(prev => {
          if (prev.some(session => session.backendId)) return prev;
          return prev.map((session, index) => index === 0
            ? { ...session, backendId: reconnectable.id }
            : session);
        });
      }
    } catch {
      setTerminalProcessCount(0);
    }
  }, [projectId]);

  useEffect(() => {
    if (bottomTab === 'terminal') void refreshTerminalProcesses();
  }, [bottomTab, refreshTerminalProcesses, terminalRunning]);

  const refreshDetectedPorts = useCallback(async () => {
    if (!projectId) return;
    try {
      const ports = await fetchWorkspacePorts(projectId);
      setDetectedPorts(ports.map(port => ({
        id: `detected-${port.port}-${port.pid}`,
        port: port.port,
        name: `Process ${port.pid}`,
        description: port.command,
        source: 'Detected',
        protocol: 'http',
        browser: true,
        visibility: 'private',
      })));
    } catch {
      setDetectedPorts([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (bottomTab === 'ports') void refreshDetectedPorts();
  }, [bottomTab, refreshDetectedPorts, previewLoading]);

  const interruptActiveTerminal = useCallback(async () => {
    if (!projectId || !terminalRunning) return;
    const activeSession = terminalSessions.find(session => session.id === activeTerminalId);
    if (!activeSession?.backendId) return;
    try {
      await interruptPersistentTerminal(projectId, activeSession.backendId);
    } catch (err) {
      appendDebugConsoleEntry('error', err instanceof ApiError ? err.message : 'Could not stop the terminal command.');
    }
  }, [activeTerminalId, appendDebugConsoleEntry, projectId, terminalRunning, terminalSessions]);

  const runTerminalCommand = useCallback(async (command: string): Promise<WorkspaceExecResult | undefined> => {
    if (!projectId || !command.trim() || terminalRunning) return undefined;
    const trimmedCommand = command.trim();
    setTerminalInput('');
    setDebugConsoleInput('');
    terminalHistoryIndexRef.current = null;
    setTerminalCommandHistory(prev => {
      const list = prev.length > 0 && prev[prev.length - 1] === trimmedCommand ? prev : [...prev, trimmedCommand];
      return list.slice(-50);
    });
    setDebugConsoleHistory(prev => {
      const list = prev.length > 0 && prev[prev.length - 1] === trimmedCommand ? prev : [...prev, trimmedCommand];
      return list.slice(-50);
    });
    setTerminalRunning(true);
    const cwdAtRun = terminalCwd;
    try {
      const activeSession = terminalSessions.find(session => session.id === activeTerminalId);
      let backendId = activeSession?.backendId ?? null;
      let outputCursor = activeSession?.outputCursor ?? 0;
      if (!backendId) {
        const session = await startPersistentTerminal(projectId, activeSession?.shell ?? terminalShell);
        backendId = session.id;
        outputCursor = 0;
        setTerminalSessions(prev => prev.map(item => item.id === activeTerminalId ? { ...item, backendId } : item));
      }

      const marker = '__BUGFIXER_DONE__';
      await sendPersistentTerminalInput(
        projectId,
        backendId,
        `${trimmedCommand}\nprintf '\\n${marker}%s|%s\\n' "$?" "$(pwd)"\n`,
      );

      let combinedOutput = '';
      let exitCode = 0;
      let completedCwd = cwdAtRun;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const output = await readPersistentTerminalOutput(projectId, backendId, outputCursor);
        outputCursor = output.next;
        combinedOutput += output.chunks.join('');
        const completion = combinedOutput.match(new RegExp(`${marker}(-?\\d+)\\|([^\\n]+)`));
        if (completion) {
          exitCode = Number.parseInt(completion[1], 10);
          const shellCwd = completion[2];
          completedCwd = shellCwd.startsWith('/workspace') ? shellCwd.slice('/workspace'.length).replace(/^\//, '') : cwdAtRun;
          combinedOutput = combinedOutput.replace(completion[0], '').trim();
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 50));
      }

      setTerminalSessions(prev => prev.map(item => item.id === activeTerminalId ? { ...item, outputCursor } : item));
      setTerminalHistory(prev => [...prev, { command: trimmedCommand, stdout: combinedOutput, stderr: '', code: exitCode, cwd: cwdAtRun }]);
      setTerminalCwd(completedCwd);

      const debugText = [
        `> ${trimmedCommand}`,
        combinedOutput,
        exitCode !== 0 ? `exit code ${exitCode}` : '',
      ].filter(Boolean).join('\n');
      if (debugText) appendDebugConsoleEntry(exitCode === 0 ? 'stdout' : 'error', debugText);
      return { stdout: combinedOutput, stderr: '', code: exitCode, durationMs: 0, cwd: completedCwd };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Command failed to run.';
      setTerminalHistory(prev => [...prev, { command: trimmedCommand, stdout: '', stderr: message, code: 1, cwd: cwdAtRun }]);
      appendDebugConsoleEntry('error', `> ${trimmedCommand}\n${message}`);
      return { stdout: '', stderr: message, code: 1, durationMs: 0, cwd: cwdAtRun };
    } finally {
      setTerminalRunning(false);
    }
  }, [activeTerminalId, appendDebugConsoleEntry, projectId, terminalCwd, terminalRunning, terminalSessions]);

  const handleRunActiveFile = useCallback(async () => {
    if (!projectId || !activeFile) return;

    const filePath = activeFile.path;
    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    const runCommands: Record<string, string> = {
      py: `python3 ${filePath}`,
      js: `node ${filePath}`,
      jsx: `node ${filePath}`,
      ts: `npx tsx ${filePath}`,
      tsx: `npx tsx ${filePath}`,
      sh: `bash ${filePath}`,
      bash: `bash ${filePath}`,
      json: `python3 -m json.tool ${filePath}`,
    };
    const command = runCommands[extension] ?? `python3 ${filePath}`;
    await runTerminalCommand(command);
  }, [activeFile, projectId, runTerminalCommand]);

  const handleStartDebugging = useCallback(async () => {
    if (!projectId || !activeFile) return;

    const filePath = activeFile.path;
    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    const debugCommands: Record<string, string> = {
      py: `python3 -m debugpy --listen 5678 --wait-for-client ${filePath}`,
      js: `node --inspect-brk ${filePath}`,
      ts: `npx tsx --inspect-brk ${filePath}`,
      tsx: `npx tsx --inspect-brk ${filePath}`,
      sh: `bash -x ${filePath}`,
    };
    const command = debugCommands[extension] ?? `python3 -m debugpy --listen 5678 --wait-for-client ${filePath}`;
    appendDebugConsoleEntry('info', `Starting debug session for ${filePath}`);
    await runTerminalCommand(command);
  }, [activeFile, projectId, appendDebugConsoleEntry, runTerminalCommand]);

  const openTaskPicker = useCallback(() => {
    setTaskPickerOpen(true);
    setTaskQuery('');
    setBottomPanelOpen(true);
    setBottomTab('terminal');
  }, []);

  const runTask = useCallback(async (task: WorkspaceTask) => {
    if (!projectId) return;

    setTaskPickerOpen(false);
    setTaskQuery('');
    setBottomPanelOpen(true);
    setBottomTab('terminal');
    const startedAt = new Date().toISOString();
    const result = await runTerminalCommand(task.command);
    if (!result) return;
    recordTaskResult({
      id: `${task.id}-${Date.now()}`,
      taskId: task.id,
      label: task.label,
      command: task.command,
      status: result.code === 0 ? 'success' : 'failed',
      exitCode: result.code,
      timestamp: startedAt,
    });
    if (result.code !== 0 && result.stderr) {
      appendDebugConsoleEntry('error', `[task:${task.label}]\n${result.stderr}`);
    }
  }, [appendDebugConsoleEntry, projectId, recordTaskResult, runTerminalCommand, terminalCwd]);

  const rerunTaskFromHistory = useCallback(async (taskRecord: { id: string; taskId: string; label: string; command: string; status: TaskRunStatus; exitCode: number; timestamp: string; }) => {
    const task: WorkspaceTask = {
      id: taskRecord.taskId,
      label: taskRecord.label,
      command: taskRecord.command,
      description: 'Re-run from recent task history',
      category: 'workspace',
    };
    await runTask(task);
  }, [runTask]);

  const runValidationCheck = useCallback(async () => {
    if (!projectId || !activeFile) return;

    const filePath = activeFile.path;
    const suggestedTask: WorkspaceTask = filePath.includes('/frontend/')
      ? {
          id: `validate-frontend-${Date.now()}`,
          label: 'Validate frontend change',
          command: 'cd frontend && npm run build',
          description: 'Build the frontend to catch compile-time regressions in the current workspace.',
          category: 'frontend',
        }
      : filePath.includes('/backend/')
      ? {
          id: `validate-backend-${Date.now()}`,
          label: 'Validate backend change',
          command: 'cd backend && pytest -q',
          description: 'Run the backend test suite to confirm the current fix is still valid.',
          category: 'backend',
        }
      : {
          id: `validate-workspace-${Date.now()}`,
          label: 'Validate workspace state',
          command: 'cd frontend && npm run build',
          description: 'Perform a quick validation pass for the active workspace content.',
          category: 'workspace',
        };

    await runTask(suggestedTask);
  }, [activeFile, projectId, runTask]);

  const handleRunBuildTask = useCallback(() => {
    const preferred = workspaceTasks.find(task => task.id === 'frontend-build' || task.id === 'backend-tests') ?? workspaceTasks[0];
    if (!preferred) {
      openTaskPicker();
      return;
    }
    void runTask(preferred);
  }, [openTaskPicker, runTask, workspaceTasks]);

  const handleTerminalInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void runTerminalCommand(terminalInput);
      return;
    }

    if (terminalCommandHistory.length === 0) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const currentIndex = terminalHistoryIndexRef.current;
      const nextIndex = currentIndex === null ? terminalCommandHistory.length - 1 : Math.max(0, currentIndex - 1);
      terminalHistoryIndexRef.current = nextIndex;
      setTerminalInput(terminalCommandHistory[nextIndex]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const currentIndex = terminalHistoryIndexRef.current;
      if (currentIndex === null) return;
      const nextIndex = currentIndex + 1;
      if (nextIndex >= terminalCommandHistory.length) {
        terminalHistoryIndexRef.current = null;
        setTerminalInput('');
        return;
      }
      terminalHistoryIndexRef.current = nextIndex;
      setTerminalInput(terminalCommandHistory[nextIndex]);
    }
  };

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalHistory]);

  useEffect(() => {
    debugConsoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [debugConsoleEntries]);

  // --- Output (real) — the most recent analysis run's pipeline logs for
  // this project, same data source as the Dashboard's per-phase Raw Logs
  // tab (fetchAnalysisLogs), just unfiltered by phase and shown here too.
  const [outputRunId, setOutputRunId] = useState<string | null>(null);
  const [outputRunStatus, setOutputRunStatus] = useState<string | null>(null);
  const [outputLogs, setOutputLogs] = useState<LogLine[]>([]);
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bottomTab !== 'output' || !projectId) return;
    let cancelled = false;

    const load = async (showSpinner: boolean) => {
      if (showSpinner) setOutputLoading(true);
      try {
        const latest = await fetchLatestAnalysisRun(projectId);
        if (cancelled) return;
        if (!latest) {
          setOutputRunId(null);
          setOutputRunStatus(null);
          setOutputLogs([]);
          setOutputError(null);
          return;
        }
        setOutputRunId(latest.id);
        setOutputRunStatus(latest.status);
        const logs = await fetchAnalysisLogs(latest.id);
        if (!cancelled) {
          setOutputLogs(logs);
          setOutputError(null);
        }
      } catch (err) {
        if (!cancelled) setOutputError(err instanceof ApiError ? err.message : 'Could not load output logs.');
      } finally {
        if (!cancelled && showSpinner) setOutputLoading(false);
      }
    };

    void load(true);
    const isRunning = outputRunStatus === 'RUNNING' || outputRunStatus === 'AWAITING_REVIEW';
    const intervalId = isRunning ? window.setInterval(() => void load(false), 2000) : null;

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomTab, projectId, outputRunStatus]);

  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [outputLogs]);

  useEffect(() => {
    inspectOpenFilesForDiagnostics();
  }, [inspectOpenFilesForDiagnostics]);

  // Go to File quick-picker (Ctrl+P)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setGoToFileQuery('');
        setIsGoToFileOpen(true);
      }
      if (e.key === 'Escape') setIsGoToFileOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const loadTree = useCallback(async () => {
    if (!projectId) {
      setTreeError('No project selected yet.');
      setTreeLoading(false);
      return;
    }

    setTreeError(null);
    setTreeLoading(true);

    try {
      const nodes = await fetchWorkspaceTree(projectId);
      setTree(Array.isArray(nodes) ? nodes : []);
    } catch (err) {
      if (err instanceof ApiError) {
        setTreeError(err.message);
      } else {
        setTreeError('Failed to load workspace files.');
      }
    } finally {
      setTreeLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (creatingPath !== null) {
      newFileInputRef.current?.focus();
    }
  }, [creatingPath]);

  useEffect(() => {
    if (renamingPath !== null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingPath]);

  // Close the context menu on any outside click, scroll, or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const toggleFolder = (path: string) => {
    setOpenFolders(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const findTreeNode = (nodes: WorkspaceTreeNode[], path: string): WorkspaceTreeNode | null => {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.type === 'folder' && n.children) {
        const found = findTreeNode(n.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const openFile = async (path: string) => {
    setActivePath(path);
    setFileError(null);

    const existing = openFiles.find(f => f.path === path);
    if (existing) return;

    if (!projectId) {
      setFileError('No project selected yet.');
      return;
    }
    setFileLoading(true);
    try {
      const result = await fetchWorkspaceFile(projectId, path);
      setOpenFiles(prev => [
        ...prev,
        { path, content: result.content, savedContent: result.content },
      ]);
      addRecentFile(projectId, path);
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Failed to open file.');
    } finally {
      setFileLoading(false);
    }
  };

  const closeFile = (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const file = openFiles.find(f => f.path === path);
    if (file && isDirty(file)) {
      const ok = window.confirm(`${path} has unsaved changes. Close without saving?`);
      if (!ok) return;
    }
    setOpenFiles(prev => prev.filter(f => f.path !== path));
    if (activePath === path) {
      const remaining = openFiles.filter(f => f.path !== path);
      setActivePath(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  };

  const updateContent = (path: string, content: string) => {
    setOpenFiles(prev => prev.map(f => (f.path === path ? { ...f, content } : f)));
  };

  const saveFile = useCallback(async (path: string) => {
    const file = openFiles.find(f => f.path === path);
    if (!file) return;
    if (!projectId) {
      setFileError('No project selected yet.');
      return;
    }
    setSaving(true);
    setFileError(null);
    try {
      await saveWorkspaceFile(projectId, path, file.content);
      setOpenFiles(prev =>
        prev.map(f => (f.path === path ? { ...f, savedContent: f.content } : f))
      );
      setStatusMessage(`Saved ${path}`);
      setTimeout(() => setStatusMessage(null), 2500);
      // A save can create a brand-new file; refresh the tree so it shows up.
      void loadTree();
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Failed to save file.');
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFiles, loadTree]);

  // Ctrl/Cmd+S saves the active file.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (activePath) void saveFile(activePath);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activePath, saveFile]);

  // Workspace-shell shortcuts: focus Explorer, toggle terminal, open Search,
  // toggle sidebar. Global by design (should work regardless of which panel
  // has focus, same as real VS Code) — safe because these are all
  // Ctrl/Cmd-modified combos that never produce plain typed characters, so
  // they can't collide with normal typing in the editor, chat box, etc.
  // Monaco's own shortcuts (undo, find-in-file, Ctrl+/, etc.) are NOT
  // duplicated here — Monaco already handles those itself.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setActivityView('explorer');
      } else if (!e.shiftKey && e.key === '`') {
        e.preventDefault();
        setBottomPanelOpen(true);
        setBottomTab('terminal');
      } else if (e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setActivityView('search');
      } else if (!e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setActivityView(prev => (prev === 'none' ? 'explorer' : 'none'));
      } else if (e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        handleOpenWorkspaceSymbols();
      } else if (e.key.toLowerCase() === 'o' && e.shiftKey) {
        e.preventDefault();
        handleOpenEditorSymbols();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto Save: when enabled, save the active file 1.5s after the user stops typing.
  useEffect(() => {
    if (!autoSave || !activeFile || !isDirty(activeFile)) return;
    const timer = setTimeout(() => {
      void saveFile(activeFile.path);
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, activeFile?.content, activeFile?.path]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activePath) void saveFile(activePath);
    });
  };

  const startCreateFile = (parentPath: string, kind: 'file' | 'folder' = 'file') => {
    setCreatingKind(kind);
    setCreatingPath(parentPath);
    setNewFileName('');
    setContextMenu(null);
  };

  const startCreateFolder = (parentPath: string) => startCreateFile(parentPath, 'folder');

  const confirmCreateFile = async () => {
    if (!creatingPath && creatingPath !== '') return;
    const kind = creatingKind;
    const trimmed = newFileName.trim();
    if (!trimmed) {
      setCreatingPath(null);
      return;
    }
    const fullPath = creatingPath ? `${creatingPath}/${trimmed}` : trimmed;
    setCreatingPath(null);

    if (!projectId) {
      setFileError('No project selected yet.');
      return;
    }
    setSaving(true);
    setFileError(null);
    try {
      if (kind === 'folder') {
        await createWorkspaceFolder(projectId, fullPath);
        setOpenFolders(prev => ({ ...prev, [fullPath]: true }));
      } else {
        await saveWorkspaceFile(projectId, fullPath, '');
        setOpenFiles(prev => [...prev, { path: fullPath, content: '', savedContent: '' }]);
        setActivePath(fullPath);
      }
      await loadTree();
    } catch (err) {
      setFileError(
        err instanceof ApiError ? err.message : `Failed to create ${kind === 'folder' ? 'folder' : 'file'}.`
      );
    } finally {
      setSaving(false);
    }
  };

  // --- Rename (Explorer context menu) ---
  const startRename = (node: WorkspaceTreeNode) => {
    setRenamingPath(node.path);
    setRenameValue(node.name);
    setContextMenu(null);
  };

  const confirmRename = async (node: WorkspaceTreeNode) => {
    const trimmed = renameValue.trim();
    setRenamingPath(null);
    if (!trimmed || trimmed === node.name) return;
    if (!projectId) {
      setFileError('No project selected yet.');
      return;
    }
    const lastSlash = node.path.lastIndexOf('/');
    const parent = lastSlash >= 0 ? node.path.slice(0, lastSlash) : '';
    const newPath = parent ? `${parent}/${trimmed}` : trimmed;

    setSaving(true);
    setFileError(null);
    try {
      await renameWorkspacePath(projectId, node.path, newPath);
      const remap = (p: string) => {
        if (p === node.path) return newPath;
        if (node.type === 'folder' && p.startsWith(`${node.path}/`)) return newPath + p.slice(node.path.length);
        return p;
      };
      setOpenFiles(prev => prev.map(f => ({ ...f, path: remap(f.path) })));
      setActivePath(prev => (prev ? remap(prev) : prev));
      setSelectedPath(prev => (prev ? remap(prev) : prev));
      setOpenFolders(prev => {
        const next: Record<string, boolean> = {};
        for (const [p, v] of Object.entries(prev)) next[remap(p)] = v;
        return next;
      });
      await loadTree();
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Failed to rename.');
    } finally {
      setSaving(false);
    }
  };

  // --- Delete (Explorer context menu) ---
  const handleDeleteNode = async (node: WorkspaceTreeNode) => {
    setContextMenu(null);
    const ok = window.confirm(
      `Delete ${node.type === 'folder' ? 'folder' : 'file'} "${node.name}"? This cannot be undone.`
    );
    if (!ok) return;
    if (!projectId) {
      setFileError('No project selected yet.');
      return;
    }
    const isRemoved = (p: string) => (node.type === 'folder' ? p === node.path || p.startsWith(`${node.path}/`) : p === node.path);

    setSaving(true);
    setFileError(null);
    try {
      await deleteWorkspacePath(projectId, node.path);
      setOpenFiles(prev => prev.filter(f => !isRemoved(f.path)));
      setActivePath(prev => (prev && isRemoved(prev) ? null : prev));
      setSelectedPath(prev => (prev && isRemoved(prev) ? null : prev));
      await loadTree();
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Failed to delete.');
    } finally {
      setSaving(false);
    }
  };

  // --- Copy Path / Copy Relative Path (Explorer context menu) ---
  const copyPathToClipboard = async (text: string, label: string) => {
    setContextMenu(null);
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage(`${label} copied to clipboard`);
      setTimeout(() => setStatusMessage(null), 2000);
    } catch {
      setFileError('Could not copy to clipboard.');
    }
  };

  // --- Copy / Paste a file or folder (Explorer context menu + F2/Delete shortcuts) ---
  // Deliberately separate from copyPathToClipboard above: this duplicates the
  // actual file/folder content elsewhere in the workspace, not just its path text.
  const handleCopyNode = (node: WorkspaceTreeNode) => {
    setContextMenu(null);
    setExplorerClipboard({ path: node.path, type: node.type });
    setStatusMessage(`Copied "${node.name}" — right-click a destination and choose Paste`);
    setTimeout(() => setStatusMessage(null), 2500);
  };

  /** Picks a name that doesn't collide with an existing sibling, e.g. "foo.ts" -> "foo (copy).ts". */
  const uniqueDestName = (parent: string, baseName: string): string => {
    const dot = baseName.lastIndexOf('.');
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot) : '';
    let candidate = baseName;
    let n = 1;
    while (findTreeNode(tree, parent ? `${parent}/${candidate}` : candidate)) {
      candidate = n === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${n})${ext}`;
      n += 1;
    }
    return candidate;
  };

  const handlePasteNode = async (targetFolderPath: string) => {
    setContextMenu(null);
    if (!explorerClipboard || !projectId) return;
    const source = findTreeNode(tree, explorerClipboard.path);
    if (!source) {
      setFileError('The copied item no longer exists.');
      return;
    }
    setSaving(true);
    setFileError(null);
    try {
      if (source.type === 'file') {
        const destName = uniqueDestName(targetFolderPath, source.name);
        const destPath = targetFolderPath ? `${targetFolderPath}/${destName}` : destName;
        const { content } = await fetchWorkspaceFile(projectId, source.path);
        await saveWorkspaceFile(projectId, destPath, content);
      } else {
        // Folder copy: walk the already-loaded subtree client-side and copy each
        // file underneath to the same relative position under the new folder name.
        // write_file() creates parent directories automatically, so no separate
        // "create folder" calls are needed.
        const destFolderName = uniqueDestName(targetFolderPath, source.name);
        const destFolderPath = targetFolderPath ? `${targetFolderPath}/${destFolderName}` : destFolderName;
        const copyRecursive = async (n: WorkspaceTreeNode, destBase: string) => {
          if (n.type === 'file') {
            const { content } = await fetchWorkspaceFile(projectId, n.path);
            await saveWorkspaceFile(projectId, destBase, content);
          } else {
            for (const child of n.children ?? []) {
              await copyRecursive(child, `${destBase}/${child.name}`);
            }
          }
        };
        await copyRecursive(source, destFolderPath);
      }
      await loadTree();
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Failed to paste.');
    } finally {
      setSaving(false);
    }
  };

  // --- Keyboard shortcuts scoped to the Explorer tree itself (Delete, F2) ---
  // Attached directly to the tree container's onKeyDown (not a global window
  // listener) so these only fire while the Explorer has focus — they can't
  // interfere with Delete/Backspace while typing in Monaco, the rename input,
  // the chat box, or anywhere else on the page.
  const handleExplorerKeyDown = (e: React.KeyboardEvent) => {
    if (!selectedPath || renamingPath) return;
    const node = findTreeNode(tree, selectedPath);
    if (!node) return;
    if (e.key === 'Delete') {
      e.preventDefault();
      void handleDeleteNode(node);
    } else if (e.key === 'F2') {
      e.preventDefault();
      startRename(node);
    }
  };

  const selectNode = (node: WorkspaceTreeNode) => {
    setSelectedPath(node.path);
    explorerTreeRef.current?.focus();
  };

  // --- Menu bar wiring ---
  // Only known activity/bottom tabs are honored; anything the menu bar sends that
  // doesn't correspond to a real panel here (e.g. Run/Debug, Testing) is a no-op,
  // matching the "visual-only" items agreed for features we haven't built.
  const handleSelectActivityTab = (tab: string) => {
    if (tab === 'explorer' || tab === 'search' || tab === 'git' || tab === 'extensions') {
      setActivityView(tab);
    }
    if (tab === 'debug') {
      setBottomPanelOpen(true);
      setBottomTab('debug_console');
    }
  };

  const handleSelectBottomTab = (tab: string) => {
    if (tab === 'problems' || tab === 'output' || tab === 'terminal' || tab === 'debug_console' || tab === 'ports') {
      setBottomTab(tab);
    }
  };

  const handleToggleSidebar = () => {
    setActivityView(prev => (prev === 'none' ? 'explorer' : 'none'));
  };

  const handleSaveFile = () => {
    if (activePath) void saveFile(activePath);
  };

  const handleCloseFile = () => {
    if (activePath) closeFile(activePath);
  };

  const renderTree = (nodes: WorkspaceTreeNode[], depth = 0) => {
    return nodes.map(node => {
      const isRenaming = renamingPath === node.path;

      if (node.type === 'folder') {
        const isOpen = openFolders[node.path] ?? depth === 0;
        return (
          <div key={node.path}>
            <div
              className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#2A2D2E] cursor-pointer group"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => {
                selectNode(node);
                toggleFolder(node.path);
              }}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                selectNode(node);
                setContextMenu({ x: e.clientX, y: e.clientY, node });
              }}
            >
              {isOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-[#858585] shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-[#858585] shrink-0" />
              )}
              <Folder className="w-3.5 h-3.5 text-[#DCB67A] shrink-0" />
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onClick={e => e.stopPropagation()}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void confirmRename(node);
                    if (e.key === 'Escape') setRenamingPath(null);
                  }}
                  onBlur={() => void confirmRename(node)}
                  className="flex-1 bg-[#3C3C3C] text-white text-xs px-1 py-0.5 rounded outline-none border border-[#007ACC]"
                />
              ) : (
                <span className="truncate">{node.name}</span>
              )}
              <button
                onClick={e => {
                  e.stopPropagation();
                  setOpenFolders(prev => ({ ...prev, [node.path]: true }));
                  startCreateFile(node.path);
                }}
                className="ml-auto opacity-0 group-hover:opacity-100 hover:text-white text-[#858585] p-0.5"
                title="New file in this folder"
              >
                <FilePlus className="w-3 h-3" />
              </button>
              <button
                onClick={e => {
                  e.stopPropagation();
                  setOpenFolders(prev => ({ ...prev, [node.path]: true }));
                  startCreateFolder(node.path);
                }}
                className="opacity-0 group-hover:opacity-100 hover:text-white text-[#858585] p-0.5"
                title="New folder in this folder"
              >
                <FolderPlus className="w-3 h-3" />
              </button>
            </div>
            {isOpen && node.children && renderTree(node.children, depth + 1)}
            {isOpen && creatingPath === node.path && (
              <div
                className="flex items-center gap-1.5 px-2 py-1"
                style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
              >
                {creatingKind === 'folder' ? (
                  <Folder className="w-3.5 h-3.5 text-[#DCB67A] shrink-0" />
                ) : (
                  <FileIcon className="w-3.5 h-3.5 text-[#9CDCFE] shrink-0" />
                )}
                <input
                  ref={newFileInputRef}
                  value={newFileName}
                  onChange={e => setNewFileName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void confirmCreateFile();
                    if (e.key === 'Escape') setCreatingPath(null);
                  }}
                  onBlur={() => void confirmCreateFile()}
                  placeholder={creatingKind === 'folder' ? 'folder name' : 'filename.ext'}
                  className="flex-1 bg-[#3C3C3C] text-white text-xs px-1 py-0.5 rounded outline-none border border-[#007ACC]"
                />
              </div>
            )}
          </div>
        );
      }

      const isActive = activePath === node.path;
      const openFile_ = openFiles.find(f => f.path === node.path);
      return (
        <div
          key={node.path}
          onClick={() => {
            selectNode(node);
            void openFile(node.path);
          }}
          onContextMenu={e => {
            e.preventDefault();
            e.stopPropagation();
            selectNode(node);
            setContextMenu({ x: e.clientX, y: e.clientY, node });
          }}
          className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer ${
            isActive ? 'bg-[#37373D] text-white' : 'hover:bg-[#2A2D2E]'
          }`}
          style={{ paddingLeft: `${8 + depth * 14 + 18}px` }}
        >
          <FileCode className={`w-3.5 h-3.5 shrink-0 ${fileIconColor(node.name)}`} />
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onClick={e => e.stopPropagation()}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void confirmRename(node);
                if (e.key === 'Escape') setRenamingPath(null);
              }}
              onBlur={() => void confirmRename(node)}
              className="flex-1 bg-[#3C3C3C] text-white text-xs px-1 py-0.5 rounded outline-none border border-[#007ACC]"
            />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
          {openFile_ && isDirty(openFile_) && (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-white shrink-0" />
          )}
        </div>
      );
    });
  };

  const openProblemFile = (path: string) => {
    setActivityView('explorer');
    void openFile(path);
  };

  const openAgentWithPrompt = useCallback((prompt: string) => {
    setAgentPanelOpen(true);
    setAgentQuickPrompt(prompt);
  }, []);

  const openProblems = [
    ...bugs.filter(b => b.status === 'Open' || b.status === 'In Review' || b.status === 'AI Suggested'),
    ...workspaceDiagnostics,
  ];

  const visiblePorts = useMemo(() => {
    const entries: WorkspacePort[] = [
      ...WORKSPACE_PORTS,
      ...detectedPorts,
      ...(previewPort ? [{
        id: 'application-preview',
        port: previewPort.port,
        name: 'Application Preview',
        description: 'Live project server',
        source: 'Docker preview',
        protocol: 'http' as const,
        browser: true,
        visibility: 'private' as const,
        url: previewPort.url,
      }] : []),
      ...manualPorts,
    ];
    const query = portQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(entry => `${entry.port} ${entry.name} ${entry.source}`.toLowerCase().includes(query));
  }, [detectedPorts, manualPorts, portQuery, previewPort]);

  const symbolResults = useMemo(() => {
    const q = symbolQuery.trim().toLowerCase();
    if (!q) return workspaceSymbols.slice(0, 50);
    return workspaceSymbols.filter(symbol =>
      symbol.name.toLowerCase().includes(q) || symbol.file.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [symbolQuery, workspaceSymbols]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#1E1E1E] text-[#CCCCCC] font-sans select-none">
      <IdeMenuBar
        projectName={projectId ?? 'workspace'}
        activeFile={activeFile ? activeFile.path.split('/').pop() : undefined}
        isSidebarOpen={activityView !== 'none'}
        onToggleSidebar={handleToggleSidebar}
        isBottomPanelOpen={bottomPanelOpen}
        onToggleBottomPanel={() => setBottomPanelOpen(o => !o)}
        isRightCopilotOpen={agentPanelOpen}
        onToggleRightCopilot={() => setAgentPanelOpen(o => !o)}
        onSelectActivityTab={handleSelectActivityTab}
        onSelectBottomTab={handleSelectBottomTab}
        onNewTerminal={createTerminalSession}
        onRunActiveFile={handleRunActiveFile}
        onStartDebugging={handleStartDebugging}
        onStartIdeCore={() => void handleStartIdeCore()}
        onStopIdeCore={() => void handleStopIdeCore()}
        onRunBuildTask={handleRunBuildTask}
        onOpenTaskPicker={openTaskPicker}
        onSaveFile={handleSaveFile}
        onCloseFile={handleCloseFile}
        onOpenModelSelector={onOpenModelSelector}
        onOpenWorkspaceSymbols={handleOpenWorkspaceSymbols}
        onOpenEditorSymbols={handleOpenEditorSymbols}
        wordWrap={wordWrap}
        onToggleWordWrap={() => setWordWrap(w => !w)}
        autoSave={autoSave}
        onToggleAutoSave={() => setAutoSave(a => !a)}
        orchestratorState={orchestratorState}
        onChangeOrchestratorState={changeOrchestratorState}
        onOpenGoToFile={() => {
          setGoToFileQuery('');
          setIsGoToFileOpen(true);
        }}
      />
      <div className="flex-1 flex overflow-hidden">
        {/* ACTIVITY BAR */}
        <div className="w-11 bg-[#333333] border-r border-[#191919] flex flex-col items-center justify-between py-2 shrink-0">
          <div className="flex flex-col items-center gap-1">
            {([
              { id: 'explorer' as const, icon: Files, title: 'Explorer' },
              { id: 'search' as const, icon: Search, title: 'Search' },
              { id: 'git' as const, icon: GitBranch, title: 'Source Control' },
              { id: 'extensions' as const, icon: Package, title: 'Extensions' },
            ]).map(({ id, icon: Icon, title }) => (
              <button
                key={id}
                onClick={() => setActivityView(prev => (prev === id ? 'none' : id))}
                title={title}
                className={`relative w-11 h-9 flex items-center justify-center ${
                  activityView === id ? 'text-white' : 'text-[#858585] hover:text-white'
                }`}
              >
                {activityView === id && (
                  <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-white rounded-full" />
                )}
                <Icon className="w-5 h-5" />
                {id === 'git' && openProblems.length > 0 && (
                  <span className="absolute -bottom-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[#007ACC] text-white text-[8px] flex items-center justify-center font-semibold">
                    {openProblems.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={() => setAgentPanelOpen(o => !o)}
              title="Toggle Agent"
              className={`w-11 h-9 flex items-center justify-center ${agentPanelOpen ? 'text-white' : 'text-[#858585] hover:text-white'}`}
            >
              <Sparkles className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* SIDEBAR: EXPLORER / SEARCH / GIT / EXTENSIONS */}
        {activityView === 'explorer' && (
          <div className="w-64 bg-[#252526] border-r border-[#191919] flex flex-col shrink-0 text-xs text-[#CCCCCC]">
          <div className="px-3 py-2.5 flex items-center justify-between text-[11px] font-bold tracking-wider uppercase text-[#BBBBBB] border-b border-[#333333]">
            <span>Explorer</span>
            <div className="flex items-center gap-1 text-[#858585]">
              <button
                onClick={() => startCreateFile('')}
                className="hover:text-white p-1"
                title="New file at workspace root"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => startCreateFolder('')}
                className="hover:text-white p-1"
                title="New folder at workspace root"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => void loadTree()}
                className="hover:text-white p-1"
                title="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${treeLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={() => setActivityView('none')}
                className="hover:text-white p-1"
                title="Minimize Explorer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {openFiles.length > 0 && (
            <div className="border-b border-[#333333] shrink-0">
              <button
                onClick={() => setOpenEditorsCollapsed(v => !v)}
                className="w-full flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase text-[#BBBBBB] hover:text-white"
              >
                {openEditorsCollapsed ? (
                  <ChevronRight className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
                <span>Open Editors</span>
                <span className="ml-auto text-[10px] font-normal normal-case text-[#858585]">
                  {openFiles.length}
                </span>
              </button>

              {!openEditorsCollapsed && (
                <div className="pb-1">
                  {openFiles.map(file => {
                    const active = activePath === file.path;
                    const dirty = isDirty(file);
                    const name = file.path.split('/').pop() ?? file.path;
                    return (
                      <div
                        key={file.path}
                        onClick={() => setActivePath(file.path)}
                        className={`group flex items-center gap-1.5 pl-6 pr-2 py-[3px] cursor-pointer text-[13px] ${
                          active
                            ? 'bg-[#37373D] text-white'
                            : 'text-[#CCCCCC] hover:bg-[#2A2D2E]'
                        }`}
                        title={file.path}
                      >
                        <FileCode className={`w-3.5 h-3.5 shrink-0 ${fileIconColor(name)}`} />
                        <span className={`truncate italic font-mono ${dirty ? '' : ''}`}>{name}</span>
                        {dirty ? (
                          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-white shrink-0 group-hover:hidden" />
                        ) : null}
                        <button
                          onClick={e => closeFile(file.path, e)}
                          className={`shrink-0 hover:bg-[#3C3C3C] p-0.5 rounded text-[#858585] hover:text-white ${
                            dirty ? 'hidden group-hover:block ml-auto' : 'hidden group-hover:block ml-auto'
                          }`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div
            ref={explorerTreeRef}
            tabIndex={0}
            className="flex-1 overflow-y-auto py-1 outline-none"
            onContextMenu={e => {
              e.preventDefault();
              setSelectedPath(null);
              setContextMenu({ x: e.clientX, y: e.clientY, node: null });
            }}
            onKeyDown={handleExplorerKeyDown}
          >
            {treeLoading && tree.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-3 text-[#858585]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Loading workspace...</span>
              </div>
            )}

            {treeError && (
              <div className="mx-2 my-2 p-2 rounded bg-[#4B1113]/30 border border-[#F48771]/40 text-[#F48771] text-[11px] space-y-1.5">
                <div className="flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{treeError}</span>
                </div>
                <button
                  onClick={() => void loadTree()}
                  className="text-[#CCCCCC] underline hover:text-white"
                >
                  Retry
                </button>
              </div>
            )}

            {!treeLoading && !treeError && tree.length === 0 && creatingPath === null && (
              <div className="px-3 py-3 text-[#858585] space-y-2">
                <FolderPlus className="w-5 h-5" />
                <p>This workspace is empty.</p>
                <button
                  onClick={() => startCreateFile('')}
                  className="text-[#4FC1FF] hover:underline"
                >
                  Create your first file
                </button>
              </div>
            )}

            {creatingPath === '' && (
              <div className="flex items-center gap-1.5 px-2 py-1">
                {creatingKind === 'folder' ? (
                  <Folder className="w-3.5 h-3.5 text-[#DCB67A] shrink-0" />
                ) : (
                  <FileIcon className="w-3.5 h-3.5 text-[#9CDCFE] shrink-0" />
                )}
                <input
                  ref={newFileInputRef}
                  value={newFileName}
                  onChange={e => setNewFileName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void confirmCreateFile();
                    if (e.key === 'Escape') setCreatingPath(null);
                  }}
                  onBlur={() => void confirmCreateFile()}
                  placeholder={creatingKind === 'folder' ? 'folder name' : 'filename.ext'}
                  className="flex-1 bg-[#3C3C3C] text-white text-xs px-1 py-0.5 rounded outline-none border border-[#007ACC]"
                />
              </div>
            )}

            {renderTree(tree)}
          </div>
          </div>
        )}

        {activityView === 'search' && (
          <div className="w-64 bg-[#252526] border-r border-[#191919] shrink-0 flex flex-col text-xs">
            <div className="px-3 py-2.5 text-[11px] font-bold tracking-wider uppercase text-[#BBBBBB] border-b border-[#333333]">
              Search
            </div>
            <div className="p-2 border-b border-[#333333]">
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void runSearch(searchQuery);
                }}
                placeholder="Search in workspace..."
                className="w-full bg-[#3C3C3C] text-white text-xs px-2 py-1.5 rounded outline-none border border-transparent focus:border-[#007ACC]"
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {searchLoading && (
                <div className="flex items-center gap-2 px-3 py-3 text-[#858585]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Searching...</span>
                </div>
              )}
              {searchError && (
                <div className="mx-2 my-2 p-2 rounded bg-[#4B1113]/30 border border-[#F48771]/40 text-[#F48771] text-[11px]">
                  {searchError}
                </div>
              )}
              {!searchLoading && !searchError && searchQuery && searchResults.length === 0 && (
                <p className="px-3 py-3 text-[#858585]">No results found.</p>
              )}
              {searchResults.length > 0 && (
                <div className="px-2 py-1 text-[11px] text-[#858585]">
                  {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
                </div>
              )}
              {searchResults.map((match, idx) => (
                <button
                  key={`${match.file}-${match.line}-${idx}`}
                  onClick={() => {
                    setActivityView('explorer');
                    void openFile(match.file);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#2A2D2E] block"
                >
                  <div className="flex items-center gap-1.5 text-[#CCCCCC]">
                    <FileCode className={`w-3 h-3 shrink-0 ${fileIconColor(match.file)}`} />
                    <span className="truncate font-mono">{match.file}</span>
                    <span className="text-[#858585] shrink-0">:{match.line}</span>
                  </div>
                  <div className="text-[#858585] font-mono truncate pl-4.5 mt-0.5">{match.preview}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {activityView === 'git' && (
          <div className="w-64 bg-[#252526] border-r border-[#191919] shrink-0 flex flex-col text-xs">
            <div className="px-3 py-2.5 flex items-center justify-between text-[11px] font-bold tracking-wider uppercase text-[#BBBBBB] border-b border-[#333333]">
              <span>Source Control</span>
              <button onClick={() => void loadGitStatus()} className="text-[#858585] hover:text-white p-0.5" title="Refresh">
                <RefreshCw className={`w-3 h-3 ${gitLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {gitError && (
              <div className="m-2 p-2 rounded bg-[#4B1113]/30 border border-[#F48771]/40 text-[#F48771] text-[11px]">
                {gitError}
              </div>
            )}

            {gitLoading && !gitStatusData && (
              <div className="flex items-center gap-2 px-3 py-3 text-[#858585]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Loading status...</span>
              </div>
            )}

            {gitStatusData && (
              <>
                <div className="px-3 py-2 flex items-center gap-1.5 text-[#858585] border-b border-[#333333]">
                  <GitBranch className="w-3.5 h-3.5" />
                  <span className="font-mono">{gitStatusData.branch}</span>
                </div>

                <div className="p-2 border-b border-[#333333] space-y-1.5">
                  <textarea
                    value={commitMessage}
                    onChange={e => setCommitMessage(e.target.value)}
                    placeholder="Commit message"
                    rows={2}
                    className="w-full bg-[#3C3C3C] text-white text-xs px-2 py-1.5 rounded outline-none resize-none border border-transparent focus:border-[#007ACC]"
                  />
                  <button
                    onClick={() => void handleCommit()}
                    disabled={committing || !commitMessage.trim() || gitStatusData.entries.length === 0}
                    className="w-full flex items-center justify-center gap-1.5 bg-[#007ACC] hover:bg-[#0062A3] disabled:opacity-50 disabled:cursor-default text-white px-2 py-1.5 rounded font-medium"
                  >
                    {committing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCommit className="w-3.5 h-3.5" />}
                    <span>Commit</span>
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {gitStatusData.entries.length === 0 ? (
                    <p className="px-3 py-3 text-[#858585]">No changes since last commit.</p>
                  ) : (
                    gitStatusData.entries.map(entry => (
                      <button
                        key={entry.path}
                        onClick={() => void viewDiff(entry.path)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#2A2D2E] text-left ${diffPath === entry.path ? 'bg-[#37373D]' : ''}`}
                      >
                        <span className="w-4 text-center font-bold text-[#CCA700] shrink-0">{entry.status || '?'}</span>
                        <span className="truncate font-mono text-[#CCCCCC]">{entry.path}</span>
                      </button>
                    ))
                  )}
                </div>

                {diffPath && (
                  <div className="border-t border-[#333333] max-h-56 overflow-y-auto">
                    <div className="px-3 py-1.5 text-[11px] text-[#858585] font-mono border-b border-[#333333] flex items-center justify-between">
                      <span className="truncate">{diffPath}</span>
                      <button onClick={() => setDiffPath(null)} className="hover:text-white shrink-0 ml-2">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    {diffLoading ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-[#858585]">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Loading diff...</span>
                      </div>
                    ) : (
                      <pre className="px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
                        {diffContent.split('\n').map((line, idx) => (
                          <div
                            key={idx}
                            className={
                              line.startsWith('+') && !line.startsWith('+++') ? 'text-[#4EC9B0]' :
                              line.startsWith('-') && !line.startsWith('---') ? 'text-[#F48771]' :
                              'text-[#858585]'
                            }
                          >
                            {line || ' '}
                          </div>
                        ))}
                      </pre>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activityView === 'extensions' && (
          <div className="w-64 bg-[#252526] border-r border-[#191919] shrink-0 flex flex-col text-xs">
            <div className="px-3 py-2.5 flex items-center justify-between text-[11px] font-bold tracking-wider uppercase text-[#BBBBBB] border-b border-[#333333]">
              <span>Extensions</span>
              <span className="text-[10px] text-[#858585]">{workspaceExtensions.filter(ext => ext.enabled).length}</span>
            </div>

            <div className="p-2 space-y-2 overflow-y-auto">
              {workspaceExtensions.map(ext => (
                <div key={ext.id} className="rounded border border-[#3A3A3A] bg-[#1E1E1E] p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-semibold text-white">{ext.name}</div>
                      <div className="text-[10px] text-[#858585]">{ext.description}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setWorkspaceExtensions(prev => prev.map(item => item.id === ext.id ? { ...item, enabled: !item.enabled } : item))}
                      className={`rounded px-2 py-1 text-[10px] font-medium ${ext.enabled ? 'bg-indigo-600 text-white' : 'bg-[#2A2D2E] text-[#CCCCCC]'}`}
                    >
                      {ext.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>

                  <div className="mt-2 space-y-1">
                    {(ext.enabled ? ext.tasks : []).map(task => (
                      <button
                        key={task.id}
                        onClick={() => void runTask(task)}
                        className="w-full text-left rounded border border-[#2D2D2D] bg-[#17191B] px-2 py-1 hover:bg-[#24282B]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-[#D4D4D4]">{task.label}</span>
                          <span className="uppercase text-[9px] tracking-wide text-[#6A6A6A]">{task.category}</span>
                        </div>
                        <div className="mt-0.5 text-[9px] text-[#858585] font-mono truncate">{task.command}</div>
                      </button>
                    ))}

                    {!ext.enabled && (
                      <div className="text-[10px] text-[#858585] italic">This extension is disabled.</div>
                    )}
                  </div>
                </div>
              ))}

              <div className="rounded border border-[#3A3A3A] bg-[#17191B] p-2">
                <div className="text-[11px] font-semibold text-white">Extension architecture</div>
                <div className="mt-1 text-[10px] leading-relaxed text-[#858585]">
                  Built-in workspace extensions are now registered in a runtime registry with metadata, enable/disable state, and task composition.
                </div>
                <button
                  onClick={openTaskPicker}
                  className="mt-2 w-full rounded border border-[#3A3A3A] px-2 py-1 text-[10px] font-medium text-[#D4D4D4] hover:bg-[#2A2D2E]"
                >
                  Open task runner
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MAIN EDITOR + BOTTOM PANEL (stacked vertically) */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#1E1E1E] min-w-0">
          <div className="flex-1 flex flex-col overflow-hidden bg-[#1E1E1E] min-w-0 min-h-0">
          {/* Tabs */}
          <div className="flex items-center justify-between bg-[#252526] border-b border-[#191919] overflow-x-auto text-xs shrink-0">
            <div className="flex items-center overflow-x-auto"></div>
            <div className="flex items-center overflow-x-auto">
              {openFiles.map(file => {
                const active = activePath === file.path;
                const dirty = isDirty(file);
                const name = file.path.split('/').pop() ?? file.path;
                return (
                  <div
                    key={file.path}
                    onClick={() => setActivePath(file.path)}
                    className={`flex items-center gap-2 px-3 py-2 border-r border-[#191919] cursor-pointer transition-colors ${
                      active
                        ? 'bg-[#1E1E1E] text-white border-t-2 border-t-[#007ACC]'
                        : 'bg-[#2D2D2D] text-[#969696] hover:bg-[#2A2A2A] hover:text-[#CCCCCC]'
                    }`}
                    title={file.path}
                  >
                    <FileCode className={`w-3.5 h-3.5 ${fileIconColor(name)}`} />
                    <span className="font-mono text-xs">{name}</span>
                    {dirty && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    <button
                      onClick={e => closeFile(file.path, e)}
                      className="hover:bg-[#3C3C3C] p-0.5 rounded text-[#858585] hover:text-white"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            {activeFile && (
              <div className="flex items-center gap-2 px-3 shrink-0 text-[#858585]">
                {statusMessage && (
                  <span className="text-[11px] text-[#4EC9B0]">{statusMessage}</span>
                )}
                {lastTaskResult && (
                  <span className={`text-[11px] ${lastTaskResult.status === 'success' ? 'text-[#4EC9B0]' : 'text-[#F48771]'}`}>
                    {lastTaskResult.status === 'success' ? 'Task ok' : 'Task failed'}: {lastTaskResult.label}
                  </span>
                )}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => openAgentWithPrompt(`Explain this file and highlight the most important logic, risks, and next steps for ${activeFile.path}.`)}
                    className="px-2 py-1 rounded bg-[#2D2D2D] text-[#D4D4D4] hover:bg-[#3C3C3C] hover:text-white text-[11px]"
                    title="Ask the agent to explain the active file"
                  >
                    Explain
                  </button>
                  <button
                    onClick={() => openAgentWithPrompt(`Review ${activeFile.path} for bugs, identify any likely root causes, and propose the safest fix.`)}
                    className="px-2 py-1 rounded bg-[#2D2D2D] text-[#D4D4D4] hover:bg-[#3C3C3C] hover:text-white text-[11px]"
                    title="Ask the agent to review the active file for bugs"
                  >
                    Fix issue
                  </button>
                  <button
                    onClick={() => openAgentWithPrompt(`Generate or improve tests for ${activeFile.path} and explain what each test covers.`)}
                    className="px-2 py-1 rounded bg-[#2D2D2D] text-[#D4D4D4] hover:bg-[#3C3C3C] hover:text-white text-[11px]"
                    title="Ask the agent to generate or improve tests"
                  >
                    Tests
                  </button>
                  <button
                    onClick={() => void runValidationCheck()}
                    className="px-2 py-1 rounded bg-[#264F78] text-[#D4D4D4] hover:bg-[#2F628E] hover:text-white text-[11px]"
                    title="Validate the current code path against the relevant project checks"
                  >
                    Validate
                  </button>
                </div>
                <button
                  onClick={() => void saveFile(activeFile.path)}
                  disabled={saving || !isDirty(activeFile)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                    isDirty(activeFile)
                      ? 'bg-[#007ACC] hover:bg-[#0062A3] text-white'
                      : 'bg-[#3C3C3C] text-[#858585] cursor-default'
                  }`}
                  title="Save (Ctrl+S)"
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  <span>Save</span>
                </button>
              </div>
            )}
          </div>

          {/* Breadcrumb */}
          {activeFile && (
            <div className="flex items-center gap-1.5 px-4 py-1 bg-[#1E1E1E] border-b border-[#2D2D2D] text-[11px] text-[#858585] font-mono shrink-0">
              {activeFile.path.split('/').map((part, i, arr) => (
                <React.Fragment key={i}>
                  {i > 0 && <ChevronRight className="w-3 h-3" />}
                  <span className={i === arr.length - 1 ? 'text-[#CCCCCC] font-semibold' : ''}>
                    {part}
                  </span>
                </React.Fragment>
              ))}
            </div>
          )}

          {/* Editor body */}
          <div className="flex-1 overflow-hidden bg-[#1E1E1E] relative">
            {!activeFile && !fileLoading && (
              <div className="h-full flex flex-col items-center justify-center text-[#5A5A5A] gap-2">
                <FileCode className="w-10 h-10" />
                <p className="text-sm">Select a file from the explorer to start editing</p>
              </div>
            )}

            {fileLoading && (
              <div className="h-full flex items-center justify-center text-[#858585] gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading file...</span>
              </div>
            )}

            {fileError && (
              <div className="m-4 p-3 rounded bg-[#4B1113]/30 border border-[#F48771]/40 text-[#F48771] text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{fileError}</span>
              </div>
            )}

            {activeFile && !fileLoading && (
              <Editor
                key={activeFile.path}
                path={activeFile.path}
                language={monacoLanguageFor(activeFile.path)}
                value={activeFile.content}
                onChange={(value) => updateContent(activeFile.path, value ?? '')}
                onMount={handleEditorMount}
                theme="vs-dark"
                loading={
                  <div className="h-full w-full flex items-center justify-center text-[#858585] gap-2 bg-[#1E1E1E]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Loading editor...</span>
                  </div>
                }
                options={{
                  fontSize: 13,
                  fontFamily: "'Menlo', 'Monaco', 'Consolas', monospace",
                  minimap: { enabled: false },
                  automaticLayout: true,
                  tabSize: 2,
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  padding: { top: 12 },
                  wordWrap: wordWrap ? 'on' : 'off',
                }}
              />
            )}
          </div>
          </div>

        {bottomPanelOpen && (
          <div className="shrink-0 bg-[#1E1E1E] border-t border-[#2D2D2D] flex flex-col text-xs" style={{ height: bottomPanelHeight }}>
            <div
              onPointerDown={event => beginPanelResize('bottom', event)}
              className="h-1 shrink-0 cursor-ns-resize bg-[#2D2D2D] hover:bg-[#007ACC]"
              title="Drag to resize panel"
            />
            <div className="flex items-center justify-between border-b border-[#2D2D2D] px-2 shrink-0">
              <div className="flex items-center">
                {([
                  { id: 'problems' as const, label: `Problems${openProblems.length ? ` (${openProblems.length})` : ''}` },
                  { id: 'output' as const, label: 'Output' },
                  { id: 'debug_console' as const, label: 'Debug Console' },
                  { id: 'terminal' as const, label: 'Terminal' },
                  { id: 'ports' as const, label: 'Ports' },
                ]).map(t => (
                  <button
                    key={t.id}
                    onClick={() => setBottomTab(t.id)}
                    className={`px-3 py-1.5 border-b-2 transition-colors ${
                      bottomTab === t.id
                        ? 'border-[#007ACC] text-white'
                        : 'border-transparent text-[#858585] hover:text-[#CCCCCC]'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setBottomPanelOpen(false)}
                className="p-1 text-[#858585] hover:text-white"
                title="Close panel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2.5">
              {bottomTab === 'problems' && (
                openProblems.length === 0 ? (
                  <p className="text-[#858585]">No problems have been detected in the workspace.</p>
                ) : (
                  <div className="space-y-1">
                    {openProblems.map(bug => (
                      <button
                        key={bug.id}
                        onClick={() => bug.filePath && openProblemFile(bug.filePath)}
                        disabled={!bug.filePath}
                        className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[#2A2D2E] text-left disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        {bug.severity === 'Critical' || bug.severity === 'High' ? (
                          <AlertCircle className="w-3.5 h-3.5 text-[#F48771] shrink-0" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-[#CCA700] shrink-0" />
                        )}
                        <span className="text-[#CCCCCC]">{bug.title}</span>
                        {bug.filePath && (
                          <span className="text-[#858585] font-mono text-[11px]">
                            {bug.filePath}{bug.lineNumber ? `:${bug.lineNumber}` : ''}
                          </span>
                        )}
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-[#6A6A6A]">{bug.status}</span>
                      </button>
                    ))}
                  </div>
                )
              )}

              {bottomTab === 'output' && (
                <div className="flex flex-col h-full font-mono">
                  {!projectId ? (
                    <p className="text-[#858585] font-sans">Waiting for a project to load…</p>
                  ) : outputLoading && outputLogs.length === 0 ? (
                    <p className="text-[#858585] font-sans">Loading output…</p>
                  ) : outputError ? (
                    <p className="text-[#F48771] font-sans">{outputError}</p>
                  ) : !outputRunId ? (
                    <p className="text-[#858585] font-sans">
                      No analysis run yet for this project — output appears here once you run the pipeline from the Dashboard tab.
                    </p>
                  ) : outputLogs.length === 0 ? (
                    <p className="text-[#858585] font-sans">No output yet for this run.</p>
                  ) : (
                    <div className="flex-1 overflow-y-auto space-y-0.5 pb-1">
                      <div className="text-[#6A6A6A] font-sans mb-1">
                        run-{outputRunId.slice(0, 8)} · {outputLogs.length} line{outputLogs.length === 1 ? '' : 's'}
                        {(outputRunStatus === 'RUNNING' || outputRunStatus === 'AWAITING_REVIEW') && (
                          <span className="ml-2 text-indigo-400">● live</span>
                        )}
                      </div>
                      {outputLogs.map(log => {
                        const levelColor =
                          log.level === 'ERROR' ? 'text-[#F48771]' :
                          log.level === 'WARN' ? 'text-[#CCA700]' :
                          log.level === 'PASS' ? 'text-[#4EC9B0]' :
                          'text-[#9CDCFE]';
                        return (
                          <div key={log.id} className="text-[#CCCCCC] whitespace-pre-wrap">
                            <span className="text-[#6A6A6A]">[{new Date(log.timestamp).toISOString().replace('T', ' ').replace('Z', '')}]</span>{' '}
                            <span className={levelColor}>[{log.level}]</span>{' '}
                            <span className="text-[#858585]">[{log.category}]</span>{' '}
                            {log.message}
                          </div>
                        );
                      })}
                      <div ref={outputEndRef} />
                    </div>
                  )}
                </div>
              )}

              {bottomTab === 'ports' && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 mb-2 text-[#858585]">
                    <Radio className="w-3.5 h-3.5" />
                    <span>Development services and application ports</span>
                  </div>
                  <div className="flex items-center gap-3 rounded border border-[#2D2D2D] bg-[#202225] px-2.5 py-1.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${previewPort ? 'bg-[#4EC9B0]' : 'bg-[#858585]'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[#CCCCCC]">Application preview</div>
                      <div className="text-[10px] text-[#858585]">
                        {previewPort ? `Running on forwarded port ${previewPort.port}` : 'Start the detected project server in an isolated container'}
                      </div>
                    </div>
                    {previewPort ? (
                      <div className="flex items-center gap-2">
                        <a
                          href={previewPort.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[11px] text-[#4FC1FF] hover:text-white"
                        >
                          Open <ExternalLink className="w-3 h-3" />
                        </a>
                        <button
                          type="button"
                          onClick={() => void handleStopPreview()}
                          disabled={previewLoading}
                          className="text-[11px] text-[#F48771] hover:text-white disabled:opacity-50"
                        >
                          Stop
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleStartPreview()}
                        disabled={previewLoading || !projectId || previewSupported === false}
                        className="flex items-center gap-1 rounded bg-[#007ACC] px-2 py-1 text-[11px] text-white hover:bg-[#0062A3] disabled:cursor-not-allowed disabled:opacity-50"
                        title={previewSupported === false ? 'Run analysis first to detect the application start command' : 'Start application preview'}
                      >
                        <Play className="w-3 h-3" />
                        {previewLoading ? 'Starting…' : 'Start'}
                      </button>
                    )}
                  </div>
                  {previewError && <p className="text-[11px] text-[#F48771]">{previewError}</p>}
                  {previewSupported === false && !previewError && (
                    <p className="text-[11px] text-[#858585]">Run project analysis first so the application start command and port can be detected.</p>
                  )}
                  <div className="flex items-center gap-2 rounded border border-[#2D2D2D] bg-[#181818] px-2 py-1.5">
                    <input
                      value={portQuery}
                      onChange={event => setPortQuery(event.target.value)}
                      placeholder="Filter ports"
                      className="min-w-0 flex-1 bg-transparent text-[11px] text-white outline-none"
                      aria-label="Filter ports"
                    />
                    <span className="text-[10px] text-[#6A6A6A]">{visiblePorts.length} ports</span>
                  </div>
                  {visiblePorts.map(entry => (
                    <div key={entry.id} className="flex items-center gap-2 rounded border border-[#2D2D2D] bg-[#202225] px-2.5 py-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#4EC9B0] shrink-0" title="Port is configured" />
                      <span className="w-12 font-mono text-[#D7BA7D]">{entry.port}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[#CCCCCC]">
                          <span className="truncate">{entry.name}</span>
                          <span className="text-[9px] uppercase text-[#6A6A6A]">{entry.protocol}</span>
                        </div>
                        <div className="text-[10px] text-[#858585] truncate">{entry.description} · {entry.source} · {entry.visibility}</div>
                      </div>
                      {entry.browser && (
                        <>
                          <button
                            type="button"
                            onClick={() => void copyPortAddress(entry)}
                            className="text-[10px] text-[#858585] hover:text-white"
                            title="Copy forwarded address"
                          >
                            Copy
                          </button>
                          <a
                            href={entry.url ?? getWorkspacePortUrl(entry.port)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-[11px] text-[#4FC1FF] hover:text-white"
                            title={`Open ${entry.name} on port ${entry.port}`}
                          >
                            Open <ExternalLink className="w-3 h-3" />
                          </a>
                        </>
                      )}
                    </div>
                  ))}
                  {visiblePorts.length === 0 && <p className="text-[11px] text-[#858585]">No matching ports.</p>}
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      value={manualPort}
                      onChange={event => setManualPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
                      placeholder="Port"
                      inputMode="numeric"
                      className="w-16 rounded border border-[#3A3A3A] bg-[#181818] px-2 py-1 text-[11px] text-white outline-none"
                      aria-label="Port number"
                    />
                    <input
                      value={manualPortName}
                      onChange={event => setManualPortName(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Enter') addManualPort(); }}
                      placeholder="Label (optional)"
                      className="min-w-0 flex-1 rounded border border-[#3A3A3A] bg-[#181818] px-2 py-1 text-[11px] text-white outline-none"
                      aria-label="Port label"
                    />
                    <button
                      type="button"
                      onClick={addManualPort}
                      disabled={!manualPort}
                      className="rounded bg-[#3A3A3A] px-2 py-1 text-[11px] text-[#CCCCCC] hover:bg-[#4A4A4A] disabled:opacity-40"
                    >
                      Add Port
                    </button>
                  </div>
                </div>
              )}

              {bottomTab === 'debug_console' && (
                <div className="flex flex-col h-full font-mono">
                  <div className="flex-1 overflow-y-auto space-y-1 pb-1">
                    <div className="flex justify-end mb-1">
                      <button
                        onClick={() => setDebugConsoleEntries([])}
                        className="px-2 py-0.5 rounded border border-[#3A3A3A] text-[#858585] hover:text-white hover:border-[#666]"
                      >
                        Clear
                      </button>
                    </div>
                    {debugConsoleEntries.length === 0 ? (
                      <p className="text-[#858585] font-sans">
                        Debug console is ready. Run a command below to inspect runtime output and exceptions.
                      </p>
                    ) : (
                      debugConsoleEntries.map(entry => (
                        <div key={entry.id} className="whitespace-pre-wrap break-words text-[12px]">
                          <span className="text-[#6A6A6A]">[{new Date(entry.timestamp).toISOString().replace('T', ' ').replace('Z', '')}]</span>{' '}
                          <span className={
                            entry.level === 'error' || entry.level === 'stderr'
                              ? 'text-[#F48771]'
                              : entry.level === 'stdout'
                              ? 'text-[#4EC9B0]'
                              : 'text-[#9CDCFE]'
                          }>
                            {entry.level.toUpperCase()}
                          </span>{' '}
                          <span className="text-[#CCCCCC]">{entry.text}</span>
                        </div>
                      ))
                    )}
                    <div ref={debugConsoleEndRef} />
                  </div>
                  <div className="flex items-center gap-2 border-t border-[#2D2D2D] pt-1.5 shrink-0">
                    <span className="text-[#6A6A6A]">Debug</span>
                    {debugConsoleHistory.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next) {
                            setDebugConsoleInput(next);
                            e.target.value = '';
                          }
                        }}
                        className="bg-[#2A2A2A] text-[#CCCCCC] border border-[#3A3A3A] rounded px-1 py-0.5 text-[10px] outline-none"
                        aria-label="Debug command history"
                      >
                        <option value="">History</option>
                        {[...debugConsoleHistory].reverse().map((entry) => (
                          <option key={entry} value={entry}>{entry}</option>
                        ))}
                      </select>
                    )}
                    <input
                      value={debugConsoleInput}
                      onChange={e => setDebugConsoleInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void runTerminalCommand(debugConsoleInput);
                      }}
                      disabled={terminalRunning || !projectId}
                      placeholder={terminalRunning ? 'Running...' : 'Run a command here...'}
                      className="flex-1 bg-transparent text-white outline-none disabled:opacity-50"
                    />
                    <button
                      onClick={() => void runTerminalCommand(debugConsoleInput)}
                      disabled={terminalRunning || !projectId || !debugConsoleInput.trim()}
                      className="px-2 py-1 rounded bg-[#007ACC] text-white hover:bg-[#0062A3] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Run
                    </button>
                  </div>
                </div>
              )}

              {bottomTab === 'terminal' && (
                <div className="flex flex-col h-full font-mono">
                  <div className="flex items-center gap-1 mb-2 overflow-x-auto border-b border-[#2D2D2D] pb-1">
                    {terminalSessions.map(session => (
                      <div
                        key={session.id}
                        className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] shrink-0 ${
                          activeTerminalId === session.id ? 'bg-[#37373D] text-white' : 'text-[#858585] hover:bg-[#2A2D2E] hover:text-[#CCCCCC]'
                        }`}
                      >
                        {renamingTerminalId === session.id ? (
                          <input
                            autoFocus
                            value={terminalNameInput}
                            onChange={event => setTerminalNameInput(event.target.value)}
                            onBlur={() => {
                              const name = terminalNameInput.trim();
                              if (name) setTerminalSessions(prev => prev.map(item => item.id === session.id ? { ...item, name } : item));
                              setRenamingTerminalId(null);
                            }}
                            onKeyDown={event => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') setRenamingTerminalId(null);
                            }}
                            className="w-20 bg-transparent text-[11px] text-white outline-none"
                            aria-label="Terminal name"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => switchTerminalSession(session.id)}
                            onDoubleClick={() => { setRenamingTerminalId(session.id); setTerminalNameInput(session.name); }}
                            title="Double-click to rename"
                          >
                            {session.name}
                          </button>
                        )}
                        {terminalSessions.length > 1 && (
                          <button
                            type="button"
                            onClick={() => closeTerminalSession(session.id)}
                            className="text-[#6A6A6A] hover:text-white"
                            title={`Close ${session.name}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                    <select
                      value={terminalShell}
                      onChange={event => setTerminalShell(event.target.value as 'bash' | 'sh')}
                      className="rounded bg-[#2A2D2E] px-1.5 py-1 text-[10px] text-[#CCCCCC] outline-none"
                      aria-label="Shell for new terminal"
                    >
                      <option value="bash">bash</option>
                      <option value="sh">sh</option>
                    </select>
                    <button
                      type="button"
                      onClick={createTerminalSession}
                      disabled={terminalRunning}
                      className="rounded px-2 py-1 text-[11px] text-[#858585] hover:bg-[#2A2D2E] hover:text-white disabled:opacity-40"
                      title="Create new terminal"
                    >
                      + New Terminal
                    </button>
                    <span className="ml-auto text-[10px] text-[#6A6A6A]">
                      {terminalProcessCount} active process{terminalProcessCount === 1 ? '' : 'es'}
                    </span>
                  </div>
                  <div className="mb-2 rounded border border-[#2D2D2D] bg-[#202225] p-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-[#858585]">Recent Tasks</span>
                      <button
                        onClick={() => {
                          setTaskHistory([]);
                          setLastTaskResult(null);
                        }}
                        className="text-[10px] text-[#858585] hover:text-white"
                      >
                        Clear
                      </button>
                    </div>
                    {taskHistory.length === 0 ? (
                      <p className="text-[#858585] text-[11px]">No recent task runs yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {taskHistory.map((entry) => (
                          <div key={entry.id} className="flex items-center justify-between gap-2 rounded border border-[#2D2D2D] bg-[#1B1D1F] px-2 py-1">
                            <button
                              onClick={() => void rerunTaskFromHistory(entry)}
                              className="flex-1 min-w-0 text-left hover:text-white"
                              title={`Re-run ${entry.label}`}
                            >
                              <div className="flex items-center gap-2 text-[11px]">
                                <span className={entry.status === 'success' ? 'text-[#4EC9B0]' : 'text-[#F48771]'}>{entry.status === 'success' ? 'OK' : 'FAIL'}</span>
                                <span className="truncate text-[#CCCCCC]">{entry.label}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[10px] text-[#858585] font-mono">{entry.command}</div>
                            </button>
                            <span className="text-[10px] text-[#6A6A6A] whitespace-nowrap">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-2 pb-1">
                    <div className="flex justify-end mb-1">
                      <button
                        onClick={() => setTerminalHistory([])}
                        className="px-2 py-0.5 rounded border border-[#3A3A3A] text-[#858585] hover:text-white hover:border-[#666]"
                      >
                        Clear output
                      </button>
                    </div>
                    {terminalHistory.length === 0 && (
                      <p className="text-[#858585] font-sans">
                        Runs a real command inside a sandboxed Docker container, mounted to this workspace.
                      </p>
                    )}
                    {terminalHistory.map((entry, idx) => (
                      <div key={idx}>
                        <div className="flex items-center gap-1.5 text-[#4EC9B0]">
                          <span className="text-[#6A6A6A]">{`/workspace${entry.cwd ? '/' + entry.cwd : ''}`}</span>
                          <span>$</span>
                          <span>{entry.command}</span>
                        </div>
                        {entry.stdout && <pre className="whitespace-pre-wrap text-[#CCCCCC]">{entry.stdout}</pre>}
                        {entry.stderr && <pre className="whitespace-pre-wrap text-[#F48771]">{entry.stderr}</pre>}
                        {entry.code !== 0 && (
                          <div className="text-[#F48771] text-[11px]">exit code {entry.code}</div>
                        )}
                      </div>
                    ))}
                    <div ref={terminalEndRef} />
                  </div>
                  <div className="flex items-center gap-1.5 border-t border-[#2D2D2D] pt-1.5 shrink-0">
                    <span className="text-[#6A6A6A]">{`/workspace${terminalCwd ? '/' + terminalCwd : ''}`}</span>
                    <span className="text-[#4EC9B0]">$</span>
                    {terminalCommandHistory.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next) {
                            setTerminalInput(next);
                            e.target.value = '';
                          }
                        }}
                        className="bg-[#2A2A2A] text-[#CCCCCC] border border-[#3A3A3A] rounded px-1 py-0.5 text-[10px] outline-none"
                        aria-label="Terminal command history"
                      >
                        <option value="">History</option>
                        {[...terminalCommandHistory].reverse().map((entry) => (
                          <option key={entry} value={entry}>{entry}</option>
                        ))}
                      </select>
                    )}
                    <input
                      value={terminalInput}
                      onChange={e => setTerminalInput(e.target.value)}
                      onKeyDown={handleTerminalInputKeyDown}
                      disabled={terminalRunning || !projectId}
                      placeholder={terminalRunning ? 'Running...' : 'Type a command and press Enter'}
                      className="flex-1 bg-transparent text-white outline-none disabled:opacity-50"
                    />
                    {terminalRunning && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#858585]" />}
                    {terminalRunning && (
                      <button
                        type="button"
                        onClick={() => void interruptActiveTerminal()}
                        className="rounded bg-[#5A1D1D] px-2 py-1 text-[11px] text-[#F48771] hover:bg-[#7A2929]"
                      >
                        Stop
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void runTerminalCommand(terminalInput)}
                      disabled={terminalRunning || !projectId || !terminalInput.trim()}
                      className="rounded bg-[#007ACC] px-2 py-1 text-[11px] text-white hover:bg-[#0062A3] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Run
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!bottomPanelOpen && (
          <button
            onClick={() => setBottomPanelOpen(true)}
            className="h-6 shrink-0 bg-[#1E1E1E] border-t border-[#2D2D2D] flex items-center gap-1.5 px-3 text-[10px] text-[#858585] hover:text-white"
          >
            <PanelBottom className="w-3 h-3" />
            {openProblems.length > 0 ? `${openProblems.length} problem(s)` : 'Problems / Output / Terminal'}
          </button>
        )}
        </div>

                {agentPanelOpen && (
          <>
            <div
              onPointerDown={event => beginPanelResize('agent', event)}
              className="w-1 shrink-0 cursor-ew-resize bg-[#2D2D2D] hover:bg-[#007ACC]"
              title="Drag to resize Agent panel"
            />
            <div style={{ width: agentPanelWidth }} className="h-full shrink-0">
              <AgentPanel
                projectId={projectId}
                activeModel={activeModel}
                activePath={activeFile?.path ?? null}
                initialPrompt={agentQuickPrompt}
                onCollapse={() => setAgentPanelOpen(false)}
                onFileWritten={(path) => {
                  // Refresh the file if it's currently open, and always refresh the tree
                  // (the fix may have created or touched files).
                  setOpenFiles(prev => prev.map(f => (f.path === path ? { ...f } : f)));
                  void loadTree();
                  if (projectId && openFiles.some(f => f.path === path)) {
                    void fetchWorkspaceFile(projectId, path).then(result => {
                      setOpenFiles(prev => prev.map(f => (f.path === path ? { path, content: result.content, savedContent: result.content } : f)));
                    });
                  }
                }}
              />
            </div>
          </>
        )}

        {!agentPanelOpen && (
          <button
            onClick={() => setAgentPanelOpen(true)}
            className="w-6 shrink-0 bg-[#181818] border-l border-[#2D2D2D] flex flex-col items-center justify-center gap-2 text-[#858585] hover:text-white"
            title="Expand Agent panel"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <Sparkles className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* STATUS BAR */}
      <footer className="h-6 bg-[#007ACC] flex items-center justify-between px-3 text-[11px] text-white shrink-0 select-none font-sans z-30">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            {activeFile ? (
              isDirty(activeFile) ? (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                  Unsaved changes
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  Saved
                </span>
              )
            ) : (
              'No file open'
            )}
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <button
            onClick={onOpenModelSelector}
            className="flex items-center gap-1.5 hover:bg-[#0062A3] px-2 py-0.5 rounded transition-colors cursor-pointer"
            title="Click to change active AI model"
          >
            <span>AI Model: {activeModel}</span>
          </button>
          <span className="hidden sm:inline">UTF-8</span>
        </div>
      </footer>

      {taskPickerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24"
          onClick={() => setTaskPickerOpen(false)}
        >
          <div
            className="w-[560px] bg-[#1E1E1E] border border-[#3A3A3A] shadow-2xl rounded-lg overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#2D2D2D] bg-[#252526]">
              <div>
                <div className="text-sm font-semibold text-white">Task Runner</div>
                <div className="text-[11px] text-[#858585]">Choose a project task to run in the workspace terminal.</div>
              </div>
              <button
                onClick={() => setTaskPickerOpen(false)}
                className="text-[#858585] hover:text-white"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 border-b border-[#2D2D2D]">
              <input
                autoFocus
                value={taskQuery}
                onChange={e => setTaskQuery(e.target.value)}
                placeholder="Filter tasks..."
                className="w-full bg-[#2A2A2A] text-white rounded border border-[#3A3A3A] px-2 py-1.5 text-xs outline-none"
              />
            </div>
            <div className="max-h-[320px] overflow-auto p-2">
              {taskResults.length === 0 ? (
                <div className="text-[#858585] text-xs p-2">No matching tasks.</div>
              ) : (
                taskResults.map(task => (
                  <button
                    key={task.id}
                    onClick={() => void runTask(task)}
                    className="w-full text-left rounded px-2 py-2 hover:bg-[#2A2D2E] border border-transparent hover:border-[#3A3A3A]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-white">{task.label}</span>
                      <span className="uppercase text-[10px] tracking-wide text-[#6A6A6A]">{task.category}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-[#858585] font-mono">{task.command}</div>
                    <div className="mt-1 text-[11px] text-[#9CDCFE]">{task.description}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {isGoToFileOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24"
          onClick={() => setIsGoToFileOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-[#252526] border border-[#454545] rounded-lg shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <input
              autoFocus
              value={goToFileQuery}
              onChange={e => setGoToFileQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && goToFileResults[0]) {
                  setIsGoToFileOpen(false);
                  setActivityView('explorer');
                  void openFile(goToFileResults[0]);
                }
                if (e.key === 'Escape') setIsGoToFileOpen(false);
              }}
              placeholder="Go to File..."
              className="w-full bg-transparent text-white text-sm px-4 py-3 outline-none border-b border-[#333333]"
            />
            <div className="max-h-80 overflow-y-auto py-1">
              {goToFileResults.length === 0 && (
                <p className="px-4 py-3 text-[#858585] text-xs">No matching files.</p>
              )}
              {goToFileResults.map(path => {
                const name = path.split('/').pop() ?? path;
                return (
                  <button
                    key={path}
                    onClick={() => {
                      setIsGoToFileOpen(false);
                      setActivityView('explorer');
                      void openFile(path);
                    }}
                    className="w-full flex items-center gap-2 px-4 py-2 hover:bg-[#2A2D2E] text-left text-xs"
                  >
                    <FileCode className={`w-3.5 h-3.5 shrink-0 ${fileIconColor(name)}`} />
                    <span className="text-[#CCCCCC]">{name}</span>
                    <span className="text-[#858585] truncate">{path}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {symbolPickerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24"
          onClick={() => setSymbolPickerOpen(false)}
        >
          <div
            className="w-full max-w-xl bg-[#252526] border border-[#454545] rounded-lg shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <input
              autoFocus
              value={symbolQuery}
              onChange={e => setSymbolQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && symbolResults[0]) {
                  void openSymbolAt(symbolResults[0].file, symbolResults[0].line);
                }
                if (e.key === 'Escape') setSymbolPickerOpen(false);
              }}
              placeholder="Go to symbol..."
              className="w-full bg-transparent text-white text-sm px-4 py-3 outline-none border-b border-[#333333]"
            />
            <div className="max-h-80 overflow-y-auto py-1">
              {symbolResults.length === 0 && (
                <p className="px-4 py-3 text-[#858585] text-xs">No matching symbols.</p>
              )}
              {symbolResults.map(symbol => (
                <button
                  key={symbol.id}
                  onClick={() => void openSymbolAt(symbol.file, symbol.line)}
                  className="w-full flex items-center gap-2 px-4 py-2 hover:bg-[#2A2D2E] text-left text-xs"
                >
                  <span className="text-[#9CDCFE] uppercase tracking-wide text-[10px]">{symbol.kind}</span>
                  <span className="text-[#CCCCCC]">{symbol.name}</span>
                  <span className="text-[#858585] truncate">{symbol.file}:{symbol.line}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* EXPLORER RIGHT-CLICK CONTEXT MENU */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[190px] bg-[#252526] border border-[#454545] rounded shadow-2xl py-1 text-xs text-[#CCCCCC]"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 260),
            left: Math.min(contextMenu.x, window.innerWidth - 210),
          }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          {contextMenu.node === null ? (
            <>
              <button
                onClick={() => startCreateFile('')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
              >
                <FilePlus className="w-3.5 h-3.5" />
                New File
              </button>
              <button
                onClick={() => startCreateFolder('')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                New Folder
              </button>
              {explorerClipboard && (
                <button
                  onClick={() => void handlePasteNode('')}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  Paste
                </button>
              )}
            </>
          ) : (
            <>
              {contextMenu.node.type === 'folder' && (
                <>
                  <button
                    onClick={() => {
                      const p = contextMenu.node!.path;
                      setOpenFolders(prev => ({ ...prev, [p]: true }));
                      startCreateFile(p);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
                  >
                    <FilePlus className="w-3.5 h-3.5" />
                    New File
                  </button>
                  <button
                    onClick={() => {
                      const p = contextMenu.node!.path;
                      setOpenFolders(prev => ({ ...prev, [p]: true }));
                      startCreateFolder(p);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    New Folder
                  </button>
                  {explorerClipboard && (
                    <button
                      onClick={() => void handlePasteNode(contextMenu.node!.path)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
                    >
                      <CopyIcon className="w-3.5 h-3.5" />
                      Paste
                    </button>
                  )}
                  <div className="h-px bg-[#454545] my-1" />
                </>
              )}
              <button
                onClick={() => startRename(contextMenu.node!)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
              >
                <Pencil className="w-3.5 h-3.5" />
                Rename...
              </button>
              <button
                onClick={() => handleCopyNode(contextMenu.node!)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
              >
                <CopyIcon className="w-3.5 h-3.5" />
                Copy
              </button>
              <button
                onClick={() => handleDeleteNode(contextMenu.node!)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
              <div className="h-px bg-[#454545] my-1" />
              <button
                onClick={() => copyPathToClipboard(`/${contextMenu.node!.path}`, 'Path')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
              >
                <CopyIcon className="w-3.5 h-3.5" />
                Copy Path
              </button>
              <button
                onClick={() => copyPathToClipboard(contextMenu.node!.path, 'Relative path')}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#04395E] hover:text-white text-left"
              >
                <CopyIcon className="w-3.5 h-3.5" />
                Copy Relative Path
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};