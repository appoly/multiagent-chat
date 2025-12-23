const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loading...');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Load configuration
  loadConfig: () => ipcRenderer.invoke('load-config'),

  // Start a new session with a challenge and optional workspace
  startSession: (options) => ipcRenderer.invoke('start-session', options),

  // Send a user message to the chat
  sendUserMessage: (message) => ipcRenderer.invoke('send-user-message', message),

  // Get current chat content
  getChatContent: () => ipcRenderer.invoke('get-chat-content'),

  // Get final plan content
  getPlanContent: () => ipcRenderer.invoke('get-plan-content'),

  // Get git diff since session start
  getGitDiff: () => ipcRenderer.invoke('get-git-diff'),

  // Stop all agents
  stopAgents: () => ipcRenderer.invoke('stop-agents'),

  // Reset session (clear chat, plan, stop agents)
  resetSession: () => ipcRenderer.invoke('reset-session'),

  // Start implementation with selected agent
  startImplementation: (selectedAgent, otherAgents) => ipcRenderer.invoke('start-implementation', selectedAgent, otherAgents),

  // Send input to PTY (user typing into terminal)
  sendPtyInput: (agentName, data) => ipcRenderer.send('pty-input', { agentName, data }),

  // Workspace Management
  getRecentWorkspaces: () => ipcRenderer.invoke('get-recent-workspaces'),
  addRecentWorkspace: (path) => ipcRenderer.invoke('add-recent-workspace', path),
  removeRecentWorkspace: (path) => ipcRenderer.invoke('remove-recent-workspace', path),
  updateRecentWorkspacePath: (oldPath, newPath) => ipcRenderer.invoke('update-recent-workspace-path', oldPath, newPath),
  validateWorkspacePath: (path) => ipcRenderer.invoke('validate-workspace-path', path),
  getCurrentDirectory: () => ipcRenderer.invoke('get-current-directory'),
  browseForWorkspace: () => ipcRenderer.invoke('browse-for-workspace'),
  openConfigFolder: () => ipcRenderer.invoke('open-config-folder'),
  getHomeConfigPath: () => ipcRenderer.invoke('get-home-config-path'),
  getCliWorkspace: () => ipcRenderer.invoke('get-cli-workspace'),

  // Listen for agent output
  onAgentOutput: (callback) => {
    ipcRenderer.on('agent-output', (event, data) => callback(data));
  },

  // Listen for agent status changes
  onAgentStatus: (callback) => {
    ipcRenderer.on('agent-status', (event, data) => callback(data));
  },

  // Listen for chat updates (full refresh - array of messages)
  onChatUpdated: (callback) => {
    ipcRenderer.on('chat-updated', (event, messages) => callback(messages));
  },

  // Listen for new chat messages (single message)
  onChatMessage: (callback) => {
    ipcRenderer.on('chat-message', (event, message) => callback(message));
  }
});

console.log('Preload script loaded successfully');
