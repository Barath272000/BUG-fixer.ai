import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
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
  RefreshCw,
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
  execWorkspaceCommand,
  searchWorkspaceFiles,
  WorkspaceSearchMatch,
  fetchWorkspaceGitStatus,
  fetchWorkspaceGitDiff,
  commitWorkspaceChanges,
  WorkspaceGitStatus,
  deleteWorkspacePath,
  renameWorkspacePath,
  createWorkspaceFolder,
} from '../api/workspace';
import { fetchAnalysisLogs, fetchLatestAnalysisRun } from '../api/analysis';
import { ApiError } from '../api/client';
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
type BottomTab = 'problems' | 'output' | 'terminal' | 'debug_console';

interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
}

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
  void initialSelectedBug; // TODO: wire this up to pre-select a file relevant to the bug

  // --- Activity bar / panel layout state ---
  const [activityView, setActivityView] = useState<ActivityView>('explorer');
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<BottomTab>('problems');

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
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([]);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState('');
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const runTerminalCommand = async (command: string) => {
    if (!projectId || !command.trim() || terminalRunning) return;
    setTerminalInput('');
    setTerminalRunning(true);
    const cwdAtRun = terminalCwd;
    try {
      const result = await execWorkspaceCommand(projectId, command, cwdAtRun);
      setTerminalHistory(prev => [...prev, { command, stdout: result.stdout, stderr: result.stderr, code: result.code, cwd: cwdAtRun }]);
      setTerminalCwd(result.cwd);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Command failed to run.';
      // A request-level failure (network/API error, not the command itself
      // failing) shouldn't silently reset the working directory the user
      // was in.
      setTerminalHistory(prev => [...prev, { command, stdout: '', stderr: message, code: 1, cwd: cwdAtRun }]);
    } finally {
      setTerminalRunning(false);
    }
  };

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalHistory]);

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

  // --- Go to File quick-picker (Ctrl+P) ---
  const [isGoToFileOpen, setIsGoToFileOpen] = useState(false);
  const [goToFileQuery, setGoToFileQuery] = useState('');

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
  };

  const handleSelectBottomTab = (tab: string) => {
    if (tab === 'problems' || tab === 'output' || tab === 'terminal' || tab === 'debug_console') {
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

  const openProblems = bugs.filter(b => b.status === 'Open' || b.status === 'In Review' || b.status === 'AI Suggested');

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
        onSaveFile={handleSaveFile}
        onCloseFile={handleCloseFile}
        onOpenModelSelector={onOpenModelSelector}
        wordWrap={wordWrap}
        onToggleWordWrap={() => setWordWrap(w => !w)}
        autoSave={autoSave}
        onToggleAutoSave={() => setAutoSave(a => !a)}
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
            <div className="px-3 py-2.5 text-[11px] font-bold tracking-wider uppercase text-[#BBBBBB] border-b border-[#333333]">
              Extensions
            </div>
            <div className="p-3 text-[#858585] leading-relaxed">
              No extension system exists in this app — this is just a placeholder tab to match the IDE layout.
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
          <div className="h-44 shrink-0 bg-[#1E1E1E] border-t border-[#2D2D2D] flex flex-col text-xs">
            <div className="flex items-center justify-between border-b border-[#2D2D2D] px-2 shrink-0">
              <div className="flex items-center">
                {([
                  { id: 'problems' as const, label: `Problems${openProblems.length ? ` (${openProblems.length})` : ''}` },
                  { id: 'output' as const, label: 'Output' },
                  { id: 'debug_console' as const, label: 'Debug Console' },
                  { id: 'terminal' as const, label: 'Terminal' },
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

              {bottomTab === 'debug_console' && (
                <p className="text-[#858585]">
                  This app has no debugger to attach to — there's no breakpoint/step-through engine anywhere in the
                  codebase. This tab is an intentional placeholder to match the IDE layout, not a wiring gap.
                </p>
              )}

              {bottomTab === 'terminal' && (
                <div className="flex flex-col h-full font-mono">
                  <div className="flex-1 overflow-y-auto space-y-2 pb-1">
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
                    <input
                      value={terminalInput}
                      onChange={e => setTerminalInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void runTerminalCommand(terminalInput);
                      }}
                      disabled={terminalRunning || !projectId}
                      placeholder={terminalRunning ? 'Running...' : 'Type a command and press Enter'}
                      className="flex-1 bg-transparent text-white outline-none disabled:opacity-50"
                    />
                    {terminalRunning && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#858585]" />}
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
          <AgentPanel
            projectId={projectId}
            activeModel={activeModel}
            activePath={activeFile?.path ?? null}
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