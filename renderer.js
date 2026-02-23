// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════

let sessionState = 'empty';     // 'empty' | 'loaded' | 'active' | 'stopped'
let currentSessionId = null;
let currentWorkspace = null;    // Project root path
let sessionsList = [];          // Array of session metadata

let currentConfig = null;
let agentData = {};
let currentAgentTab = null;
let terminals = {};
let agentColors = {};
let chatMessages = [];
let inputLocked = {};
let planHasContent = false;
let implementationStarted = false;
let autoScrollEnabled = true;
let currentRightTab = 'terminal';
let lastDiffData = null;
let parsedDiffFiles = [];
let selectedDiffFile = null;
let pollingIntervals = [];

const CHAT_SCROLL_THRESHOLD = 40;
const LAYOUT_STORAGE_KEY = 'multiagent-layout';

// ═══════════════════════════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════════════════════════

const sidebarWorkspaceName = document.getElementById('sidebar-workspace-name');
const sidebarWorkspacePath = document.getElementById('sidebar-workspace-path');
const newSessionButton = document.getElementById('new-session-button');
const sessionListEl = document.getElementById('session-list');
const changeWorkspaceButton = document.getElementById('change-workspace-button');
const settingsButton = document.getElementById('settings-button');

const welcomeView = document.getElementById('welcome-view');
const sessionView = document.getElementById('session-view');
const rightPanel = document.getElementById('right-panel');

const promptInput = document.getElementById('prompt-input');
const promptSendBtn = document.getElementById('prompt-send-btn');
const configDetails = document.getElementById('config-details');

const chatViewer = document.getElementById('chat-viewer');
const chatNewMessages = document.getElementById('chat-new-messages');
const chatNewMessagesButton = document.getElementById('chat-new-messages-button');
const userMessageInput = document.getElementById('user-message-input');
const sendMessageButton = document.getElementById('send-message-button');

const agentTabsContainer = document.getElementById('agent-tabs');
const agentOutputsContainer = document.getElementById('agent-outputs');

const mainTabTerminal = document.getElementById('main-tab-terminal');
const mainTabPlan = document.getElementById('main-tab-plan');
const mainTabDiff = document.getElementById('main-tab-diff');
const terminalTabContent = document.getElementById('terminal-tab-content');
const planTabContent = document.getElementById('plan-tab-content');
const diffTabContent = document.getElementById('diff-tab-content');

const planViewer = document.getElementById('plan-viewer');
const startImplementingButton = document.getElementById('start-implementing-button');
const refreshPlanButton = document.getElementById('refresh-plan-button');

const diffBadge = document.getElementById('diff-badge');
const diffStats = document.getElementById('diff-stats');
const diffContent = document.getElementById('diff-content');
const diffUntracked = document.getElementById('diff-untracked');
const diffFileListItems = document.getElementById('diff-file-list-items');
const refreshDiffButton = document.getElementById('refresh-diff-button');

const implementationModal = document.getElementById('implementation-modal');
const agentSelectionContainer = document.getElementById('agent-selection');
const modalCancelButton = document.getElementById('modal-cancel');
const modalStartButton = document.getElementById('modal-start');

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function getTerminalTheme() {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue('--terminal-bg').trim() || '#0b0e11',
    foreground: style.getPropertyValue('--terminal-fg').trim() || '#e0e0e0',
    cursor: style.getPropertyValue('--terminal-cursor').trim() || '#e0e0e0',
    selectionBackground: style.getPropertyValue('--terminal-selection').trim() || '#264f78',
  };
}

// ═══════════════════════════════════════════════════════════
// Initialize
// ═══════════════════════════════════════════════════════════

async function initializeApp() {
  // Set platform class for platform-specific CSS (e.g., macOS hidden title bar)
  if (window.electronAPI?.platform) {
    document.body.classList.add(`platform-${window.electronAPI.platform}`);
  }

  console.log('Initializing app...');
  console.log('Terminal available?', typeof Terminal !== 'undefined');
  console.log('FitAddon available?', typeof FitAddon !== 'undefined');
  console.log('marked available?', typeof marked !== 'undefined');

  if (!window.electronAPI) {
    console.error('electronAPI not available!');
    configDetails.innerHTML = '<span style="color: #dc3545;">Error: Electron API not available</span>';
    return;
  }

  try {
    // Load config
    currentConfig = await window.electronAPI.loadConfig();
    displayConfig();

    // Get CWD as workspace
    const wsInfo = await window.electronAPI.getCurrentWorkspace();
    currentWorkspace = wsInfo.path;

    // Update sidebar
    sidebarWorkspaceName.textContent = wsInfo.name;
    sidebarWorkspacePath.textContent = wsInfo.path;
    sidebarWorkspacePath.title = wsInfo.path;

    // Load sessions for this workspace
    await loadSessionsList();

    // Show welcome view
    showWelcomeView();
  } catch (error) {
    console.error('Error initializing:', error);
    configDetails.innerHTML = `<span style="color: #dc3545;">Error: ${error.message}</span>`;
  }
}

// ═══════════════════════════════════════════════════════════
// View Management
// ═══════════════════════════════════════════════════════════

function showWelcomeView() {
  welcomeView.style.display = 'flex';
  sessionView.style.display = 'none';
  rightPanel.style.display = 'none';
  sessionState = 'empty';
  currentSessionId = null;
  promptInput.value = '';
  promptInput.focus();

  // Deselect all session items
  sessionListEl.querySelectorAll('.session-item').forEach(el => {
    el.classList.remove('active');
  });
}

function showSessionView() {
  welcomeView.style.display = 'none';
  sessionView.style.display = 'flex';
}

function showRightPanel() {
  rightPanel.style.display = 'flex';
  // Restore layout after showing
  requestAnimationFrame(() => {
    restoreLayout();
    refitTerminals();
  });
}

function hideRightPanel() {
  rightPanel.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
// Session List (Sidebar)
// ═══════════════════════════════════════════════════════════

async function loadSessionsList() {
  if (!currentWorkspace) return;

  try {
    sessionsList = await window.electronAPI.getSessionsForWorkspace(currentWorkspace);
    renderSessionsList();
  } catch (error) {
    console.error('Error loading sessions:', error);
    sessionsList = [];
    renderSessionsList();
  }
}

function renderSessionsList() {
  if (sessionsList.length === 0) {
    sessionListEl.innerHTML = '<div class="session-list-empty">No sessions yet</div>';
    return;
  }

  // Group by time
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const weekAgo = new Date(today - 7 * 86400000);

  const groups = {
    today: [],
    yesterday: [],
    thisWeek: [],
    older: []
  };

  for (const session of sessionsList) {
    const date = new Date(session.lastActiveAt || session.createdAt);
    if (date >= today) {
      groups.today.push(session);
    } else if (date >= yesterday) {
      groups.yesterday.push(session);
    } else if (date >= weekAgo) {
      groups.thisWeek.push(session);
    } else {
      groups.older.push(session);
    }
  }

  let html = '';

  const renderGroup = (label, sessions) => {
    if (sessions.length === 0) return '';
    let groupHtml = `<div class="session-group-label">${label}</div>`;
    for (const session of sessions) {
      const isActive = session.id === currentSessionId;
      const statusClass = session.status === 'active' ? 'active' : '';
      const statusTitle = session.status === 'active' ? 'Session active' : 'Session completed';
      const timeStr = formatRelativeTime(session.lastActiveAt || session.createdAt);

      groupHtml += `
        <div class="session-item ${isActive ? 'active' : ''}" data-session-id="${escapeHtml(session.id)}">
          <div class="session-item-title">${escapeHtml(session.title)}</div>
          <div class="session-item-meta">
            <span class="session-item-status ${statusClass}" title="${statusTitle}"></span>
            <span>${timeStr}</span>
            <span>${session.messageCount || 0} msgs</span>
          </div>
        </div>
      `;
    }
    return groupHtml;
  };

  html += renderGroup('Today', groups.today);
  html += renderGroup('Yesterday', groups.yesterday);
  html += renderGroup('This Week', groups.thisWeek);
  html += renderGroup('Older', groups.older);

  sessionListEl.innerHTML = html;

  // Add click handlers
  sessionListEl.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      const sessionId = item.dataset.sessionId;
      handleLoadSession(sessionId);
    });
  });
}

function formatRelativeTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ═══════════════════════════════════════════════════════════
// Session Flows
// ═══════════════════════════════════════════════════════════

// Handle sending a message - dispatches based on sessionState
async function handleSendMessage(text) {
  if (!text.trim()) return;

  if (sessionState === 'empty') {
    await handleNewSession(text.trim());
  } else if (sessionState === 'loaded') {
    await handleResumeSession(text.trim());
  } else if (sessionState === 'active' || sessionState === 'stopped') {
    await handleSendUserMessage(text.trim());
  }
}

// New session: user typed in welcome prompt
async function handleNewSession(challenge) {
  promptSendBtn.disabled = true;
  promptSendBtn.classList.add('loading');

  try {
    const result = await window.electronAPI.startSession({
      challenge,
      workspace: currentWorkspace
    });

    if (result.success) {
      currentSessionId = result.sessionId;
      agentColors = result.colors || {};
      chatMessages = [];
      sessionState = 'active';

      result.agents.forEach(agent => {
        agentData[agent.name] = {
          ...agentData[agent.name],
          name: agent.name,
          status: agentData[agent.name]?.status || 'starting',
          output: agentData[agent.name]?.output || [],
          use_pty: agent.use_pty
        };
      });

      // Switch to session view
      showSessionView();
      showRightPanel();
      createAgentTabs(result.agents);
      renderChatMessages();
      startChatPolling();

      // Refresh sessions list
      await loadSessionsList();
    } else {
      alert(`Failed to start session: ${result.error}`);
    }
  } catch (error) {
    console.error('Error starting session:', error);
    alert('Error starting session. Check console for details.');
  } finally {
    promptSendBtn.disabled = false;
    promptSendBtn.classList.remove('loading');
  }
}

// Load past session (click sidebar) - dormant, no agents
async function handleLoadSession(sessionId) {
  try {
    // Stop any running agents first
    if (sessionState === 'active') {
      stopChatPolling();
      await window.electronAPI.resetSession();
      cleanupTerminals();
    }

    const result = await window.electronAPI.loadSession(currentWorkspace, sessionId);

    if (result.success) {
      currentSessionId = sessionId;
      agentColors = result.colors || {};
      chatMessages = result.messages || [];
      sessionState = 'loaded';

      // Show session view, hide right panel (dormant - no agents)
      showSessionView();
      hideRightPanel();

      // Render chat history
      renderChatMessages();

      // Update sidebar highlighting
      renderSessionsList();

      // Set placeholder to indicate resume behavior
      userMessageInput.placeholder = 'Type a message to resume this session with agents...';
    } else {
      console.error('Failed to load session:', result.error);
    }
  } catch (error) {
    console.error('Error loading session:', error);
  }
}

// Resume session: user typed while dormant (loaded state)
async function handleResumeSession(newMessage) {
  sendMessageButton.disabled = true;
  sendMessageButton.classList.add('loading');

  try {
    const result = await window.electronAPI.resumeSession(currentWorkspace, currentSessionId, newMessage);

    if (result.success) {
      agentColors = result.colors || {};
      sessionState = 'active';

      result.agents.forEach(agent => {
        agentData[agent.name] = {
          ...agentData[agent.name],
          name: agent.name,
          status: agentData[agent.name]?.status || 'starting',
          output: agentData[agent.name]?.output || [],
          use_pty: agent.use_pty
        };
      });

      // Show right panel, create terminals
      showRightPanel();
      createAgentTabs(result.agents);
      startChatPolling();

      // Reset placeholder
      userMessageInput.placeholder = 'Send a message to all agents... (Enter to send)';
      userMessageInput.value = '';

      // Refresh sessions list
      await loadSessionsList();
    } else {
      alert(`Failed to resume session: ${result.error}`);
    }
  } catch (error) {
    console.error('Error resuming session:', error);
    alert('Error resuming session. Check console for details.');
  } finally {
    sendMessageButton.disabled = false;
    sendMessageButton.classList.remove('loading');
  }
}

// Send user message to active session
async function handleSendUserMessage(message) {
  sendMessageButton.disabled = true;
  sendMessageButton.classList.add('loading');

  try {
    const result = await window.electronAPI.sendUserMessage(message);
    if (result.success) {
      userMessageInput.value = '';
    } else {
      alert(`Failed to send message: ${result.error}`);
    }
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Error sending message. Check console for details.');
  } finally {
    sendMessageButton.disabled = false;
    sendMessageButton.classList.remove('loading');
  }
}

// New session button - return to welcome view
async function handleNewSessionButton() {
  if (sessionState === 'active') {
    stopChatPolling();
    await window.electronAPI.resetSession();
    cleanupTerminals();
  }

  // Reset UI state
  chatMessages = [];
  planHasContent = false;
  implementationStarted = false;
  agentData = {};
  currentAgentTab = null;
  autoScrollEnabled = true;
  lastDiffData = null;
  parsedDiffFiles = [];
  selectedDiffFile = null;
  agentTabsContainer.innerHTML = '';
  agentOutputsContainer.innerHTML = '';

  showWelcomeView();

  // Refresh sessions list
  await loadSessionsList();
}

function cleanupTerminals() {
  Object.values(terminals).forEach(({ terminal }) => {
    try { terminal.dispose(); } catch (e) { /* ignore */ }
  });
  terminals = {};
}

// ═══════════════════════════════════════════════════════════
// Display Config
// ═══════════════════════════════════════════════════════════

function displayConfig() {
  if (!currentConfig) {
    configDetails.innerHTML = '<span style="color: #dc3545;">No configuration loaded</span>';
    return;
  }

  const agentList = currentConfig.agents.map(a => {
    const color = a.color || '#667eea';
    return `<span style="color: ${color}">&#8226; ${a.name}</span> (${a.command})`;
  }).join('<br>');

  configDetails.innerHTML = `<strong>Agents:</strong><br>${agentList}`;
}

// ═══════════════════════════════════════════════════════════
// Agent Tabs & Terminal
// ═══════════════════════════════════════════════════════════

function createAgentTabs(agents) {
  agentTabsContainer.innerHTML = '';
  agentOutputsContainer.innerHTML = '';

  agents.forEach((agent, index) => {
    const agentInfo = agentData[agent.name];

    const tab = document.createElement('button');
    tab.className = 'tab';
    if (index === 0) {
      tab.classList.add('active');
      currentAgentTab = agent.name;
    }
    tab.textContent = agent.name;
    tab.onclick = () => switchAgentTab(agent.name);
    agentTabsContainer.appendChild(tab);

    const outputDiv = document.createElement('div');
    outputDiv.className = 'agent-output';
    outputDiv.id = `output-${agent.name}`;
    if (index === 0) outputDiv.classList.add('active');

    const statusDiv = document.createElement('div');
    const knownStatus = agentInfo?.status || 'starting';
    statusDiv.className = `agent-status ${knownStatus}`;
    statusDiv.id = `status-${agent.name}`;
    if (knownStatus === 'running') {
      statusDiv.textContent = 'Running';
    } else if (knownStatus === 'stopped') {
      statusDiv.textContent = 'Stopped';
    } else if (knownStatus === 'error') {
      statusDiv.textContent = 'Error';
    } else {
      statusDiv.textContent = 'Starting...';
    }
    outputDiv.appendChild(statusDiv);

    if (agentInfo && agentInfo.use_pty) {
      const terminalDiv = document.createElement('div');
      terminalDiv.id = `terminal-${agent.name}`;
      terminalDiv.className = 'terminal-container';
      outputDiv.appendChild(terminalDiv);

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Courier New, monospace',
        theme: getTerminalTheme(),
        rows: 40,
        cols: 120
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalDiv);
      fitAddon.fit();

      terminals[agent.name] = { terminal, fitAddon };
      inputLocked[agent.name] = true;
      terminal.options.disableStdin = true;

      const lockToggle = document.createElement('button');
      lockToggle.className = 'input-lock-toggle';
      lockToggle.innerHTML = '🔒 Input locked';
      lockToggle.onclick = () => toggleInputLock(agent.name);
      terminalDiv.appendChild(lockToggle);

      terminal.onData((data) => {
        if (!inputLocked[agent.name]) {
          window.electronAPI.sendPtyInput(agent.name, data);
        }
      });

      window.addEventListener('resize', () => {
        if (terminals[agent.name]) {
          terminals[agent.name].fitAddon.fit();
        }
      });
    } else {
      const contentPre = document.createElement('pre');
      contentPre.id = `content-${agent.name}`;
      outputDiv.appendChild(contentPre);
    }

    agentOutputsContainer.appendChild(outputDiv);
  });
}

function switchAgentTab(agentName) {
  currentAgentTab = agentName;

  document.querySelectorAll('#agent-tabs .tab').forEach(tab => {
    tab.classList.toggle('active', tab.textContent === agentName);
  });

  document.querySelectorAll('.agent-output').forEach(output => {
    output.classList.toggle('active', output.id === `output-${agentName}`);
  });

  if (terminals[agentName]) {
    setTimeout(() => terminals[agentName].fitAddon.fit(), 100);
  }
}

function toggleInputLock(agentName) {
  inputLocked[agentName] = !inputLocked[agentName];
  const toggle = document.querySelector(`#terminal-${agentName} .input-lock-toggle`);
  const terminal = terminals[agentName]?.terminal;

  if (inputLocked[agentName]) {
    toggle.innerHTML = '🔒 Input locked';
    toggle.classList.remove('unlocked');
    if (terminal) {
      terminal.options.disableStdin = true;
      if (terminal.textarea) terminal.textarea.blur();
    }
  } else {
    toggle.innerHTML = '🔓 Input unlocked';
    toggle.classList.add('unlocked');
    if (terminal) {
      terminal.options.disableStdin = false;
      terminal.focus();
    }
  }
}

function updateAgentOutput(agentName, output, isPty) {
  if (!agentData[agentName]) {
    agentData[agentName] = { name: agentName, output: [] };
  }
  agentData[agentName].output.push(output);

  if (isPty && terminals[agentName]) {
    terminals[agentName].terminal.write(output);
  } else {
    const contentElement = document.getElementById(`content-${agentName}`);
    if (contentElement) {
      contentElement.textContent = agentData[agentName].output.join('');
      if (currentAgentTab === agentName) {
        const outputContainer = document.getElementById(`output-${agentName}`);
        if (outputContainer) outputContainer.scrollTop = outputContainer.scrollHeight;
      }
    }
  }
}

function updateAgentStatus(agentName, status, exitCode = null, error = null) {
  if (!agentData[agentName]) {
    agentData[agentName] = { name: agentName, status, output: [] };
  } else {
    agentData[agentName].status = status;
  }

  const statusElement = document.getElementById(`status-${agentName}`);
  if (statusElement) {
    statusElement.className = `agent-status ${status}`;
    if (status === 'running') {
      statusElement.textContent = 'Running';
    } else if (status === 'restarting') {
      statusElement.textContent = 'Restarting...';
    } else if (status === 'stopped') {
      statusElement.textContent = `Stopped (exit code: ${exitCode})`;
    } else if (status === 'error') {
      statusElement.textContent = `Error: ${error}`;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Chat
// ═══════════════════════════════════════════════════════════

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderChatMessage(message) {
  const isUser = message.type === 'user';
  const alignClass = isUser ? 'chat-message-right' : 'chat-message-left';
  const color = message.color || agentColors[message.agent?.toLowerCase()] || '#667eea';
  const htmlContent = marked.parse(message.content || '');

  return `
    <div class="chat-message ${alignClass}" data-seq="${message.seq}">
      <div class="chat-bubble" style="--agent-color: ${color}">
        <div class="chat-header">
          <span class="chat-agent" style="color: ${color}">${escapeHtml(message.agent)}</span>
          <span class="chat-time">${formatTimestamp(message.timestamp)}</span>
        </div>
        <div class="chat-content markdown-content">${htmlContent}</div>
      </div>
    </div>
  `;
}

function renderChatMessages() {
  if (chatMessages.length === 0) {
    if (sessionState === 'active') {
      chatViewer.innerHTML = '<div class="chat-empty">No messages yet. Agents are starting...</div>';
    } else if (sessionState === 'loaded') {
      chatViewer.innerHTML = '<div class="chat-empty">Empty session. Type a message to start.</div>';
    } else {
      chatViewer.innerHTML = '';
    }
    setNewMessagesBanner(false);
    return;
  }

  chatViewer.innerHTML = chatMessages.map(renderChatMessage).join('');
  if (autoScrollEnabled) scrollChatToBottom();
}

function addChatMessage(message) {
  const exists = chatMessages.some(m => m.seq === message.seq);
  if (!exists) {
    const shouldScroll = autoScrollEnabled;
    chatMessages.push(message);
    chatMessages.sort((a, b) => a.seq - b.seq);
    renderChatMessages();
    if (!shouldScroll) setNewMessagesBanner(true);
    updateSidebarMessageCount();
  }
}

function updateChatFromMessages(messages) {
  if (Array.isArray(messages)) {
    const prevLastSeq = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1].seq : null;
    const nextLastSeq = messages.length > 0 ? messages[messages.length - 1].seq : null;
    const hasChanges = messages.length !== chatMessages.length || prevLastSeq !== nextLastSeq;
    if (!hasChanges) return;

    const shouldScroll = autoScrollEnabled;
    chatMessages = messages;
    renderChatMessages();
    if (!shouldScroll) setNewMessagesBanner(true);
    updateSidebarMessageCount();
  }
}

function updateSidebarMessageCount() {
  if (!currentSessionId) return;
  const currentSession = sessionsList.find(s => s.id === currentSessionId);
  if (currentSession && currentSession.messageCount !== chatMessages.length) {
    currentSession.messageCount = chatMessages.length;
    currentSession.lastActiveAt = new Date().toISOString();
    renderSessionsList();
  }
}

function isChatNearBottom() {
  return chatViewer.scrollHeight - chatViewer.scrollTop - chatViewer.clientHeight <= CHAT_SCROLL_THRESHOLD;
}

function scrollChatToBottom() {
  chatViewer.scrollTop = chatViewer.scrollHeight;
}

function setNewMessagesBanner(visible) {
  if (!chatNewMessages) return;
  chatNewMessages.classList.toggle('visible', visible);
  chatNewMessages.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

// ═══════════════════════════════════════════════════════════
// Right Panel Tabs (Terminal / Plan / Diff)
// ═══════════════════════════════════════════════════════════

function switchRightTab(tabName) {
  currentRightTab = tabName;

  mainTabTerminal.classList.toggle('active', tabName === 'terminal');
  mainTabPlan.classList.toggle('active', tabName === 'plan');
  mainTabDiff.classList.toggle('active', tabName === 'diff');

  terminalTabContent.classList.toggle('active', tabName === 'terminal');
  planTabContent.classList.toggle('active', tabName === 'plan');
  diffTabContent.classList.toggle('active', tabName === 'diff');

  if (tabName === 'terminal') {
    requestAnimationFrame(() => refitTerminals());
  }

  if (tabName === 'diff') {
    refreshGitDiff();
    requestAnimationFrame(() => restoreDiffLayout());
  }

  if (tabName === 'plan') {
    refreshPlan();
  }
}

// ═══════════════════════════════════════════════════════════
// Plan
// ═══════════════════════════════════════════════════════════

async function refreshPlan() {
  try {
    const content = await window.electronAPI.getPlanContent();
    if (content.trim()) {
      const htmlContent = marked.parse(content);
      planViewer.innerHTML = `<div class="markdown-content">${htmlContent}</div>`;
      planHasContent = true;
    } else {
      planViewer.innerHTML = '<em>No plan yet...</em>';
      planHasContent = false;
    }
    updateImplementButtonState();
  } catch (error) {
    console.error('Error refreshing plan:', error);
  }
}

function updateImplementButtonState() {
  if (implementationStarted) {
    startImplementingButton.textContent = 'Implementation in progress';
    startImplementingButton.disabled = true;
    startImplementingButton.style.display = 'block';
  } else if (planHasContent) {
    startImplementingButton.textContent = 'Start Implementing';
    startImplementingButton.disabled = false;
    startImplementingButton.style.display = 'block';
  } else {
    startImplementingButton.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════
// Diff
// ═══════════════════════════════════════════════════════════

async function refreshGitDiff() {
  try {
    const data = await window.electronAPI.getGitDiff();
    lastDiffData = data;
    renderGitDiff(data);
    updateDiffBadge(data);
  } catch (error) {
    console.error('Error fetching git diff:', error);
    diffContent.innerHTML = `<em class="diff-error">Error loading diff: ${error.message}</em>`;
  }
}

function parseDiffIntoFiles(diffText) {
  if (!diffText || !diffText.trim()) return [];

  const files = [];
  const lines = diffText.split('\n');
  let currentFile = null;
  let currentContent = [];

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        currentFile.content = currentContent.join('\n');
        files.push(currentFile);
      }
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      const filename = match ? match[2] : 'unknown';
      currentFile = { filename, status: 'modified', content: '' };
      currentContent = [line];
    } else if (currentFile) {
      currentContent.push(line);
      if (line.startsWith('new file mode')) currentFile.status = 'added';
      else if (line.startsWith('deleted file mode')) currentFile.status = 'deleted';
    }
  }

  if (currentFile) {
    currentFile.content = currentContent.join('\n');
    files.push(currentFile);
  }

  return files;
}

function renderDiffFileList(files, untracked) {
  if (!diffFileListItems) return;

  let html = '';
  const allActive = selectedDiffFile === null ? 'active' : '';
  html += `<li class="file-list-item all-files ${allActive}" data-file="__all__">All Files</li>`;

  for (const file of files) {
    const isActive = selectedDiffFile === file.filename ? 'active' : '';
    const statusLabel = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M';
    html += `<li class="file-list-item ${isActive}" data-file="${escapeHtml(file.filename)}">
      <span class="file-status ${file.status}">${statusLabel}</span>
      <span class="file-name">${escapeHtml(file.filename)}</span>
    </li>`;
  }

  for (const file of (untracked || [])) {
    const isActive = selectedDiffFile === file ? 'active' : '';
    html += `<li class="file-list-item ${isActive}" data-file="${escapeHtml(file)}" data-untracked="true">
      <span class="file-status added">?</span>
      <span class="file-name">${escapeHtml(file)}</span>
    </li>`;
  }

  if (files.length === 0 && (!untracked || untracked.length === 0)) {
    html = '<li class="file-list-item no-changes" style="color: var(--text-dim); cursor: default;">No changes</li>';
  }

  diffFileListItems.innerHTML = html;

  diffFileListItems.querySelectorAll('.file-list-item[data-file]').forEach(item => {
    item.addEventListener('click', () => {
      const file = item.dataset.file;
      selectedDiffFile = file === '__all__' ? null : file;
      renderDiffFileList(parsedDiffFiles, lastDiffData?.untracked);
      renderDiffContent();
    });
  });
}

function renderDiffContent() {
  if (!lastDiffData) {
    diffContent.innerHTML = '<em class="diff-empty">No diff data available</em>';
    return;
  }

  if (selectedDiffFile === null) {
    if (lastDiffData.diff && lastDiffData.diff.trim()) {
      diffContent.innerHTML = `<pre class="diff-output">${formatDiffOutput(lastDiffData.diff)}</pre>`;
    } else {
      diffContent.innerHTML = '<em class="diff-empty">No uncommitted changes</em>';
    }
  } else {
    const file = parsedDiffFiles.find(f => f.filename === selectedDiffFile);
    if (file) {
      diffContent.innerHTML = `<pre class="diff-output">${formatDiffOutput(file.content)}</pre>`;
    } else {
      diffContent.innerHTML = `<em class="diff-empty">Untracked file: ${escapeHtml(selectedDiffFile)}</em>`;
    }
  }
}

function renderGitDiff(data) {
  if (!data.isGitRepo) {
    diffStats.innerHTML = '';
    diffContent.innerHTML = `<em class="diff-no-repo">${data.error || 'Not a git repository'}</em>`;
    diffUntracked.innerHTML = '';
    if (diffFileListItems) diffFileListItems.innerHTML = '';
    return;
  }

  if (data.error) {
    diffStats.innerHTML = '';
    diffContent.innerHTML = `<em class="diff-error">Error: ${data.error}</em>`;
    diffUntracked.innerHTML = '';
    if (diffFileListItems) diffFileListItems.innerHTML = '';
    return;
  }

  parsedDiffFiles = parseDiffIntoFiles(data.diff);

  const { filesChanged, insertions, deletions } = data.stats;
  if (filesChanged > 0 || insertions > 0 || deletions > 0) {
    diffStats.innerHTML = `
      <span class="diff-stat-files">${filesChanged} file${filesChanged !== 1 ? 's' : ''}</span>
      <span class="diff-stat-insertions">+${insertions}</span>
      <span class="diff-stat-deletions">-${deletions}</span>
    `;
  } else {
    diffStats.innerHTML = '<span class="diff-stat-none">No changes</span>';
  }

  renderDiffFileList(parsedDiffFiles, data.untracked);
  renderDiffContent();

  if (data.untracked && data.untracked.length > 0) {
    diffUntracked.innerHTML = `<div class="diff-untracked-header">Untracked files (${data.untracked.length})</div>`;
  } else {
    diffUntracked.innerHTML = '';
  }
}

function formatDiffOutput(diff) {
  return diff.split('\n').map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---')) return `<span class="diff-file-header">${escaped}</span>`;
    if (line.startsWith('@@')) return `<span class="diff-hunk-header">${escaped}</span>`;
    if (line.startsWith('+')) return `<span class="diff-added">${escaped}</span>`;
    if (line.startsWith('-')) return `<span class="diff-removed">${escaped}</span>`;
    if (line.startsWith('diff --git')) return `<span class="diff-file-separator">${escaped}</span>`;
    return `<span class="diff-context">${escaped}</span>`;
  }).join('');
}

function updateDiffBadge(data) {
  if (!data || !data.isGitRepo) {
    diffBadge.style.display = 'none';
    return;
  }
  const totalChanges = (data.stats?.filesChanged || 0) + (data.untracked?.length || 0);
  if (totalChanges > 0) {
    diffBadge.textContent = totalChanges;
    diffBadge.style.display = 'inline-block';
  } else {
    diffBadge.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════
// Implementation Modal
// ═══════════════════════════════════════════════════════════

function showImplementationModal() {
  agentSelectionContainer.innerHTML = '';
  const enabledAgents = currentConfig.agents || [];

  enabledAgents.forEach((agent, index) => {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'implementer';
    radio.value = agent.name;
    if (index === 0 || enabledAgents.length === 1) radio.checked = true;

    const agentNameSpan = document.createElement('span');
    agentNameSpan.className = 'agent-name';
    agentNameSpan.textContent = agent.name;
    agentNameSpan.style.color = agent.color || '#e0e0e0';

    label.appendChild(radio);
    label.appendChild(agentNameSpan);
    agentSelectionContainer.appendChild(label);
  });

  implementationModal.style.display = 'flex';
}

function hideImplementationModal() {
  implementationModal.style.display = 'none';
}

async function startImplementation() {
  const selectedRadio = document.querySelector('input[name="implementer"]:checked');
  if (!selectedRadio) {
    alert('Please select an agent to implement the plan.');
    return;
  }

  const selectedAgent = selectedRadio.value;
  const allAgents = currentConfig.agents.map(a => a.name);
  const otherAgents = allAgents.filter(name => name !== selectedAgent);

  hideImplementationModal();
  implementationStarted = true;
  updateImplementButtonState();

  try {
    const result = await window.electronAPI.startImplementation(selectedAgent, otherAgents);
    if (!result.success) {
      alert(`Failed to start implementation: ${result.error}`);
      implementationStarted = false;
      updateImplementButtonState();
    }
  } catch (error) {
    console.error('Error starting implementation:', error);
    implementationStarted = false;
    updateImplementButtonState();
  }
}

// ═══════════════════════════════════════════════════════════
// Polling
// ═══════════════════════════════════════════════════════════

function stopChatPolling() {
  pollingIntervals.forEach(id => clearInterval(id));
  pollingIntervals = [];
}

function startChatPolling() {
  stopChatPolling();

  pollingIntervals.push(setInterval(async () => {
    try {
      const messages = await window.electronAPI.getChatContent();
      if (messages && messages.length > 0) updateChatFromMessages(messages);
    } catch (error) {
      console.error('Error polling chat:', error);
    }
  }, 2000));

  pollingIntervals.push(setInterval(refreshPlan, 3000));

  pollingIntervals.push(setInterval(async () => {
    try {
      const data = await window.electronAPI.getGitDiff();
      lastDiffData = data;
      updateDiffBadge(data);
      if (currentRightTab === 'diff') renderGitDiff(data);
    } catch (error) {
      console.error('Error polling git diff:', error);
    }
  }, 5000));
}

// ═══════════════════════════════════════════════════════════
// Resize Handles
// ═══════════════════════════════════════════════════════════

function initResizers() {
  const mainHandle = document.querySelector('[data-resize="main"]');
  const diffHandle = document.querySelector('[data-resize="diff"]');

  if (mainHandle) {
    setupResizer({
      handle: mainHandle,
      direction: 'horizontal',
      container: document.querySelector('.app-layout'),
      panelA: document.querySelector('.main-area'),
      panelB: document.querySelector('.right-panel-inner'),
      minA: 300,
      minB: 300,
      layoutKey: 'mainSplit'
    });
  }

  if (diffHandle) {
    setupResizer({
      handle: diffHandle,
      direction: 'horizontal',
      container: document.querySelector('.diff-layout'),
      panelA: document.querySelector('.diff-file-list'),
      panelB: document.querySelector('.diff-content-pane'),
      minA: 150,
      minB: 200,
      layoutKey: 'diffSplit'
    });
  }

  restoreLayout();
}

function setupResizer(config) {
  const { handle, direction, container, panelA, panelB, minA, minB, layoutKey } = config;
  if (!handle || !container || !panelA || !panelB) return;

  let startPos = 0;
  let startSizeA = 0;
  let startSizeB = 0;
  let rafId = null;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing', 'resizing-h');

    startPos = e.clientX;
    startSizeA = panelA.getBoundingClientRect().width;
    startSizeB = panelB.getBoundingClientRect().width;
  }

  function onPointerMove(e) {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    if (rafId) cancelAnimationFrame(rafId);

    rafId = requestAnimationFrame(() => {
      const delta = e.clientX - startPos;
      const availableSize = startSizeA + startSizeB;

      let newSizeA = startSizeA + delta;
      let newSizeB = startSizeB - delta;

      if (newSizeA < minA) { newSizeA = minA; newSizeB = availableSize - minA; }
      if (newSizeB < minB) { newSizeB = minB; newSizeA = availableSize - minB; }

      panelA.style.flex = `0 0 ${newSizeA}px`;
      panelB.style.flex = `0 0 ${newSizeB}px`;

      refitTerminals();
    });
  }

  function onPointerUp(e) {
    if (rafId) cancelAnimationFrame(rafId);
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing', 'resizing-h');

    const sizeA = panelA.getBoundingClientRect().width;
    const sizeB = panelB.getBoundingClientRect().width;
    const ratio = sizeA / (sizeA + sizeB);
    saveLayoutRatio(layoutKey, ratio);
    refitTerminals();
  }

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);
}

function saveLayoutRatio(layoutKey, ratio) {
  try {
    const layout = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}');
    layout[layoutKey] = ratio;
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch (err) {
    console.warn('Failed to save layout:', err);
  }
}

function restoreLayout() {
  try {
    const layout = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}');

    if (layout.mainSplit !== undefined) {
      const mainArea = document.querySelector('.main-area');
      const rightPanelInner = document.querySelector('.right-panel-inner');
      const rightPanelEl = document.querySelector('.right-panel');

      if (mainArea && rightPanelInner && rightPanelEl && rightPanelEl.style.display !== 'none') {
        const appLayout = document.querySelector('.app-layout');
        const sidebarWidth = document.querySelector('.sidebar')?.getBoundingClientRect().width || 260;
        const containerWidth = appLayout.getBoundingClientRect().width - sidebarWidth;

        if (containerWidth > 0) {
          const mainWidth = containerWidth * layout.mainSplit;
          const rightWidth = containerWidth * (1 - layout.mainSplit);
          mainArea.style.flex = `0 0 ${mainWidth}px`;
          rightPanelInner.style.flex = `0 0 ${rightWidth}px`;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to restore layout:', err);
  }
}

function restoreDiffLayout() {
  try {
    const layout = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}');

    if (layout.diffSplit !== undefined) {
      const diffFileList = document.querySelector('.diff-file-list');
      const diffContentPane = document.querySelector('.diff-content-pane');
      const diffLayout = document.querySelector('.diff-layout');
      const diffHandle = document.querySelector('[data-resize="diff"]');

      if (diffFileList && diffContentPane && diffLayout) {
        const containerWidth = diffLayout.getBoundingClientRect().width;
        if (containerWidth <= 0) return;
        const handleWidth = diffHandle ? diffHandle.offsetWidth : 8;
        const availableWidth = containerWidth - handleWidth;
        const fileListWidth = availableWidth * layout.diffSplit;
        const contentWidth = availableWidth * (1 - layout.diffSplit);
        diffFileList.style.flex = `0 0 ${fileListWidth}px`;
        diffContentPane.style.flex = `0 0 ${contentWidth}px`;
      }
    }
  } catch (err) {
    console.warn('Failed to restore diff layout:', err);
  }
}

function refitTerminals() {
  if (refitTerminals.timeout) clearTimeout(refitTerminals.timeout);
  refitTerminals.timeout = setTimeout(() => {
    Object.values(terminals).forEach(({ fitAddon }) => {
      try { fitAddon.fit(); } catch (err) { /* ignore */ }
    });
  }, 50);
}

// Debounced window resize
let resizeTimeout = null;
function onWindowResize() {
  if (resizeTimeout) clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (rightPanel.style.display !== 'none') {
      restoreLayout();
      refitTerminals();
    }
  }, 150);
}

// ═══════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════

// Welcome prompt
promptSendBtn.addEventListener('click', () => handleSendMessage(promptInput.value));
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSendMessage(promptInput.value);
  }
});

// Session message input
sendMessageButton.addEventListener('click', () => handleSendMessage(userMessageInput.value));
userMessageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSendMessage(userMessageInput.value);
  }
});

// Sidebar
newSessionButton.addEventListener('click', handleNewSessionButton);

changeWorkspaceButton.addEventListener('click', async () => {
  const result = await window.electronAPI.browseForWorkspace();
  if (!result.canceled) {
    // Stop any active session before switching workspace
    if (sessionState === 'active') {
      stopChatPolling();
      await window.electronAPI.resetSession();
      cleanupTerminals();
    }

    currentWorkspace = result.path;
    sidebarWorkspaceName.textContent = result.path.split('/').pop() || result.path.split('\\').pop();
    sidebarWorkspacePath.textContent = result.path;
    sidebarWorkspacePath.title = result.path;
    await window.electronAPI.addRecentWorkspace(result.path);
    await loadSessionsList();
    showWelcomeView();
  }
});

settingsButton.addEventListener('click', () => {
  window.electronAPI.openConfigFolder();
});

// Right panel tabs
mainTabTerminal.addEventListener('click', () => switchRightTab('terminal'));
mainTabPlan.addEventListener('click', () => switchRightTab('plan'));
mainTabDiff.addEventListener('click', () => switchRightTab('diff'));

// Diff/Plan buttons
refreshDiffButton.addEventListener('click', refreshGitDiff);
if (refreshPlanButton) refreshPlanButton.addEventListener('click', refreshPlan);
startImplementingButton.addEventListener('click', showImplementationModal);

// Modal
modalCancelButton.addEventListener('click', hideImplementationModal);
modalStartButton.addEventListener('click', startImplementation);

// Chat scroll
chatNewMessagesButton.addEventListener('click', () => {
  autoScrollEnabled = true;
  scrollChatToBottom();
  setNewMessagesBanner(false);
});

chatViewer.addEventListener('scroll', () => {
  if (isChatNearBottom()) {
    autoScrollEnabled = true;
    setNewMessagesBanner(false);
  } else {
    autoScrollEnabled = false;
  }
});

// Keyboard shortcut for New Session (Cmd/Ctrl + Shift + N)
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
    e.preventDefault();
    handleNewSessionButton();
  }
});

// ═══════════════════════════════════════════════════════════
// IPC Listeners
// ═══════════════════════════════════════════════════════════

window.electronAPI.onAgentOutput((data) => {
  updateAgentOutput(data.agentName, data.output, data.isPty);
});

window.electronAPI.onAgentStatus((data) => {
  updateAgentStatus(data.agentName, data.status, data.exitCode, data.error);
});

window.electronAPI.onChatUpdated((messages) => {
  updateChatFromMessages(messages);
});

window.electronAPI.onChatMessage((message) => {
  addChatMessage(message);
});

// ═══════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════

initializeApp();
initResizers();
window.addEventListener('resize', onWindowResize);
