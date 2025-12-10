const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loading...');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Load configuration
  loadConfig: () => ipcRenderer.invoke('load-config'),

  // Start a new session with a challenge
  startSession: (challenge) => ipcRenderer.invoke('start-session', challenge),

  // Send a user message to the chat
  sendUserMessage: (message) => ipcRenderer.invoke('send-user-message', message),

  // Get current chat content
  getChatContent: () => ipcRenderer.invoke('get-chat-content'),

  // Get final plan content
  getPlanContent: () => ipcRenderer.invoke('get-plan-content'),

  // Stop all agents
  stopAgents: () => ipcRenderer.invoke('stop-agents'),

  // Listen for agent output
  onAgentOutput: (callback) => {
    ipcRenderer.on('agent-output', (event, data) => callback(data));
  },

  // Listen for agent status changes
  onAgentStatus: (callback) => {
    ipcRenderer.on('agent-status', (event, data) => callback(data));
  },

  // Listen for chat updates
  onChatUpdated: (callback) => {
    ipcRenderer.on('chat-updated', (event, content) => callback(content));
  }
});

console.log('Preload script loaded successfully');
