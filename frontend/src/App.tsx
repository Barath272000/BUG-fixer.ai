import { ChevronDown } from 'lucide-react';
import React, { useState } from 'react';
import { createBugApi, fetchBugs, getOrCreateDefaultProject, updateBugStatusApi } from './api/bugs';
import { AIFixHistoryView } from './components/AIFixHistoryView';
import { AnalyticsView } from './components/AnalyticsView';
import { BugListView } from './components/BugListView';
import { DashboardView } from './components/DashboardView';
import { DocsView } from './components/DocsView';
import { InspectFixModal } from './components/InspectFixModal';
import { LogBugModal } from './components/LogBugModal';
import { ModelSelectorModal } from './components/ModelSelectorModal';
import { NotificationBell, NotificationCenter } from './components/NotificationCenter';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';
import { WorkspaceView } from './components/WorkspaceView';
import { AIFixHistoryItem, AppNotification, Bug, NavigationTab } from './types';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavigationTab>('workspace');
  const [bugs, setBugs] = useState<Bug[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [backendConnected, setBackendConnected] = useState(false);
  const [isLogBugOpen, setIsLogBugOpen] = useState(false);
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [inspectingBug, setInspectingBug] = useState<Bug | null>(null);
  const [inspectingHistoryItem, setInspectingHistoryItem] = useState<AIFixHistoryItem | null>(null);
  const [workspaceTargetBug, setWorkspaceTargetBug] = useState<Bug | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentModel, setCurrentModel] = useState('GPT-4-Turbo');

  // --- Notifications (starts empty — populated from real events as they happen) ---
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);

  const handleMarkNotificationAsRead = (id: string) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
  };

  const handleMarkAllNotificationsAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const handleDismissNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const handleClearAllNotifications = () => {
    setNotifications([]);
  };

  const handleSelectBugById = (bugId: string) => {
    const target = bugs.find(b => b.id === bugId || b.code === bugId);
    if (target) setInspectingBug(target);
    setActiveTab('bugs');
  };

  React.useEffect(() => {
    (async () => {
      try {
        const pid = await getOrCreateDefaultProject();
        setProjectId(pid);
        const realBugs = await fetchBugs(pid);
        setBugs(realBugs);
        setBackendConnected(true);
      } catch (err) {
        console.error('Failed to load backend data:', err);
        setBackendConnected(false);
      }
    })();
  }, []);

  const handleAddBug = async (newBug: Bug) => {
    if (!projectId) return;
    try {
      const created = await createBugApi(projectId, newBug);
      setBugs(prev => [created, ...prev]);
    } catch (err) {
      console.error('Failed to create bug:', err);
    }
  };

  const handleApplyPatch = async (bugId: string) => {
    const target = bugs.find(b => b.code === bugId || b.id === bugId);
    if (!target) return;
    try {
      const updated = await updateBugStatusApi(target.id, 'Fixed');
      setBugs(prev => prev.map(b => (b.id === updated.id ? updated : b)));
    } catch (err) {
      console.error('Failed to apply patch:', err);
    }
  };

  const handleNavigateToWorkspaceWithBug = (bug: Bug) => {
    setWorkspaceTargetBug(bug);
    setActiveTab('workspace');
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0B0E14] text-[#E2E8F0] font-sans overflow-hidden select-none">
      
      {/* Top Navigation Bar (Professional Polish Design) */}
      <header className="flex items-center justify-between px-6 py-2.5 bg-[#161B22] border-b border-[#30363D] shrink-0 z-40">
        
        {/* Brand Logo */}
        <div 
          className="flex items-center gap-3 cursor-pointer group"
          onClick={() => setActiveTab('dashboard')}
        >
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center shadow-md shadow-indigo-900/30 group-hover:bg-indigo-500 transition-colors">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
          </div>
          <span className="font-bold text-base tracking-tight text-white">
            BugFixer<span className="text-indigo-400">.ai</span>
          </span>
        </div>

        {/* Right Section Controls */}
        <div className="flex items-center gap-4">
          
          {/* Active Model Pill (Clickable Model Selector) */}
          <button
            onClick={() => setIsModelSelectorOpen(true)}
            className="flex items-center gap-2 bg-[#0D1117] hover:bg-[#21262D] px-3 py-1.5 rounded-md border border-[#30363D] hover:border-indigo-500/60 text-xs transition-all cursor-pointer group shadow-xs"
            title="Click to switch active AI model & manage availability"
          >
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse shadow-sm shadow-green-500/50" />
            <span className="text-gray-400 group-hover:text-gray-300">Model:</span>
            <span className="text-gray-200 font-mono font-semibold text-indigo-300">{currentModel}</span>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400 group-hover:text-white transition-transform group-hover:translate-y-0.5" />
          </button>

          {/* Nav Links */}
          <div className="flex items-center gap-4">
            <NotificationBell
              notifications={notifications}
              isOpen={isNotificationOpen}
              onToggle={() => setIsNotificationOpen(prev => !prev)}
              position="header"
            />

            <button 
              onClick={() => setActiveTab('docs')}
              className={`text-xs transition-colors cursor-pointer ${
                activeTab === 'docs' ? 'text-indigo-400 font-semibold' : 'text-gray-400 hover:text-white'
              }`}
            >
              Documentation
            </button>

            <button
              onClick={() => setIsLogBugOpen(true)}
              className="hidden sm:flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md text-xs font-medium transition-colors shadow-sm cursor-pointer"
            >
              <span>+ Quick Triage</span>
            </button>

            {/* User Avatar */}
            <div 
              onClick={() => setActiveTab('settings')}
              className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/50 flex items-center justify-center text-xs font-bold text-indigo-300 cursor-pointer hover:bg-indigo-500/30 transition-colors shadow-inner"
              title="User Account: JD"
            >
              JD
            </div>
          </div>

        </div>
      </header>

      {/* Main App Body with Sidebar & Content */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar */}
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          openLogBugModal={() => setIsLogBugOpen(true)}
        />

        {/* Dynamic Center View */}
        <main className="flex-1 flex flex-col bg-[#0B0E14] overflow-hidden min-w-0">
          {activeTab === 'dashboard' && <DashboardView />}
          
          {activeTab === 'bugs' && (
            <BugListView
              bugs={bugs}
              onOpenNewBugModal={() => setIsLogBugOpen(true)}
              onSelectBugForDiff={(bug) => setInspectingBug(bug)}
              onNavigateToWorkspaceWithBug={handleNavigateToWorkspaceWithBug}
            />
          )}

          {activeTab === 'ai-fix-history' && (
            <AIFixHistoryView
              onInspectFix={(item) => setInspectingHistoryItem(item)}
            />
          )}


          {activeTab === 'workspace' && (
            <WorkspaceView 
              initialSelectedBug={workspaceTargetBug}
              activeModel={currentModel}
              onOpenModelSelector={() => setIsModelSelectorOpen(true)}
              projectId={projectId}
              bugs={bugs}
            />
          )}

            {activeTab === 'analytics' && <AnalyticsView projectId={projectId} />}

          {activeTab === 'docs' && <DocsView />}

          {activeTab === 'settings' && <SettingsView />}
        </main>

      </div>

      {/* Footer Status Bar (Professional Polish Design) */}
      <footer className="bg-[#0D1117] border-t border-[#30363D] px-6 py-2 flex items-center justify-between text-[11px] text-gray-400 shrink-0 select-none">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-gray-300">
            <span className={`w-2 h-2 rounded-full ${backendConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            {backendConnected ? 'Connected to Backend' : 'Backend Unreachable'}
          </span>
          <span className="text-gray-500">|</span>
          <span className="text-gray-400 font-mono">UTF-8</span>
          <span className="text-gray-500">|</span>
          <span className="text-gray-400 font-mono">Line 6, Col 24</span>
        </div>

        <div className="flex items-center gap-4 uppercase tracking-widest font-bold text-[10px]">
          <span className="text-indigo-400">Nexus v3.4.1</span>
        </div>
      </footer>

      {/* Modals */}
      <LogBugModal
        isOpen={isLogBugOpen}
        onClose={() => setIsLogBugOpen(false)}
        onAddBug={handleAddBug}
      />

      <InspectFixModal
        isOpen={!!inspectingBug || !!inspectingHistoryItem}
        onClose={() => {
          setInspectingBug(null);
          setInspectingHistoryItem(null);
        }}
        bug={inspectingBug}
        historyItem={inspectingHistoryItem}
        onApplyPatch={handleApplyPatch}
      />

      <ModelSelectorModal
        isOpen={isModelSelectorOpen}
        onClose={() => setIsModelSelectorOpen(false)}
        currentModel={currentModel}
        onSelectModel={(model) => setCurrentModel(model)}
      />

      <NotificationCenter
        notifications={notifications}
        isOpen={isNotificationOpen}
        onClose={() => setIsNotificationOpen(false)}
        onToggle={() => setIsNotificationOpen(prev => !prev)}
        onMarkAsRead={handleMarkNotificationAsRead}
        onMarkAllAsRead={handleMarkAllNotificationsAsRead}
        onDismiss={handleDismissNotification}
        onClearAll={handleClearAllNotifications}
        onNavigateTab={setActiveTab}
        onSelectBugById={handleSelectBugById}
      />
    </div>
  );
}