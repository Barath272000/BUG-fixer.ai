export type NavigationTab = 'dashboard' | 'bugs' | 'ai-fix-history' | 'workspace' | 'analytics' | 'docs' | 'settings';

export type SeverityLevel = 'Critical' | 'High' | 'Medium' | 'Low';
export type BugStatus = 'Open' | 'In Review' | 'Fixed' | 'Closed' | 'AI Suggested' | 'Applying Fix';
export type AIStatus = 'Pending' | 'Ready' | 'Applied';
export type AIModel = string;

export interface Bug {
  id: string;
  code: string;
  title: string;
  tags: string[];
  severity: SeverityLevel;
  status: BugStatus;
  aiStatus: AIStatus;
  language: string;
  component: string;
  loggedDate: string;
  updatedDate: string;
  description?: string;
  stackTrace?: string;
  filePath?: string;
  lineNumber?: number;
  fixSuggestion?: {
    model: AIModel;
    confidence: number;
    explanation: string;
    diffSnippet: string;
    status: 'Ready' | 'Applied' | 'Superseded';
    lines: number;
    estTime: string;
  };
}

export interface AIFixHistoryItem {
  id: string;
  bugId: string;
  bugTitle: string;
  patchSummary: string;
  date: string;
  model: AIModel;
  confidence: number;
  status: 'Ready' | 'Applied' | 'Superseded';
  lines: number;
  estTime: string;
  fullDiff?: string;
  codeContext?: string;
}

export interface FixSummary {
  projectCount: number;
  dateSpanDays: number;
  regressionsFound: number;
  acceptanceRate: number;
  estimatedDollarsSaved: number;
}

export interface PhaseSubprocess {
  id: string;
  name: string;
  category?: string;
  description?: string;
  completed: boolean;
  status?: 'completed' | 'running' | 'pending' | 'failed';
  metrics?: Record<string, string>;
}

export interface SecurityCheck {
  id: string;
  title: string;
  description: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  metrics: Record<string, string>;
}

export interface PipelinePhase {
  id: number;
  name: string;
  description: string;
  duration?: string;
  status: 'completed' | 'running' | 'pending' | 'failed';
  subtasks?: { name: string; completed: boolean }[];
  subprocesses?: PhaseSubprocess[];
  validationStatus?: 'idle' | 'running' | 'passed' | 'failed' | 're_analyzing';
  validationReport?: {
    testPassRate?: string;
    totalTests?: number;
    passedTests?: number;
    failedTests?: number;
    regressionFound?: boolean;
    recommendation?: string;
    summary?: string;
    diffSnippet?: string;
    timestamp?: string;
    cycleCount?: number;
    securityChecks?: SecurityCheck[];
  };
}

export interface LogLine {
  id: string;
  timestamp: string;
  level: 'INFO' | 'PASS' | 'WARN' | 'ERROR';
  category: string;
  message: string;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: WorkspaceFile[];
  content?: string;
  language?: string;
  hasBug?: boolean;
  bugId?: string;
}

export interface ContextDoc {
  id: string;
  name: string;
  size: string;
  type: 'markdown' | 'openapi' | 'pdf' | 'json' | 'text' | 'schema';
  content?: string;
  uploadedAt: string;
  description?: string;
}

export type NotificationType = 'critical' | 'fix' | 'security' | 'system' | 'info';

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  type: NotificationType;
  bugId?: string;
  actionTab?: NavigationTab;
  codeSnippet?: string;
  downloadAnalysisRunId?: string;
  downloadProjectName?: string;
}
