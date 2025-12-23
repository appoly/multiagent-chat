// State
let currentConfig = null;
let agentData = {};
let currentAgentTab = null;
let terminals = {};
let agentColors = {};  // Map of agent name -> color
let chatMessages = []; // Array of chat messages
let inputLocked = {};  // Map of agent name -> boolean (default true)
let planHasContent = false;  // Track if PLAN_FINAL has content
let implementationStarted = false;  // Track if implementation has started
let autoScrollEnabled = true;

const CHAT_SCROLL_THRESHOLD = 40;

// DOM Elements
const challengeScreen = document.getElementById('challenge-screen');
const sessionScreen = document.getElementById('session-screen');
const challengeInput = document.getElementById('challenge-input');
const startButton = document.getElementById('start-button');
const configDetails = document.getElementById('config-details');
const stopButton = document.getElementById('stop-button');
const workspacePath = document.getElementById('workspace-path');
const agentTabsContainer = document.getElementById('agent-tabs');
const agentOutputsContainer = document.getElementById('agent-outputs');
const chatViewer = document.getElementById('chat-viewer');
const chatNewMessages = document.getElementById('chat-new-messages');
const chatNewMessagesButton = document.getElementById('chat-new-messages-button');
const userMessageInput = document.getElementById('user-message-input');
const sendMessageButton = document.getElementById('send-message-button');
const planViewer = document.getElementById('plan-viewer');
const startImplementingButton = document.getElementById('start-implementing-button');

// Modal elements
const implementationModal = document.getElementById('implementation-modal');
const agentSelectionContainer = document.getElementById('agent-selection');
const modalCancelButton = document.getElementById('modal-cancel');
const modalStartButton = document.getElementById('modal-start');

// Initialize
async function initialize() {
  console.log('Initializing app...');

  // Check if xterm is available
  console.log('Terminal available?', typeof Terminal !== 'undefined');
  console.log('FitAddon available?', typeof FitAddon !== 'undefined');
  console.log('FitAddon object:', FitAddon);
  console.log('marked available?', typeof marked !== 'undefined');

  // Check if electronAPI is available
  if (!window.electronAPI) {
    console.error('electronAPI not available!');
    configDetails.innerHTML = '<span style="color: #dc3545;">Error: Electron API not available</span>';
    return;
  }

  console.log('electronAPI available:', Object.keys(window.electronAPI));

  try {
    console.log('Loading config...');
    currentConfig = await window.electronAPI.loadConfig();
    console.log('Config loaded:', currentConfig);
    displayConfig();
  } catch (error) {
    console.error('Error loading config:', error);
    configDetails.innerHTML = `<span style="color: #dc3545;">Error loading configuration: ${error.message}</span>`;
  }
}

// Display configuration info
function displayConfig() {
  if (!currentConfig) {
    configDetails.innerHTML = '<span style="color: #dc3545;">No configuration loaded</span>';
    return;
  }

  const agentList = currentConfig.agents.map(a => {
    const color = a.color || '#667eea';
    return `<span style="color: ${color}">• ${a.name}</span> (${a.command})`;
  }).join('<br>');

  configDetails.innerHTML = `
    <strong>Agents:</strong><br>${agentList}
  `;
}

// Start session
async function startSession() {
  const challenge = challengeInput.value.trim();

  if (!challenge) {
    alert('Please enter a challenge for the agents to work on.');
    return;
  }

  startButton.disabled = true;
  startButton.textContent = 'Starting...';

  try {
    const result = await window.electronAPI.startSession(challenge);

    if (result.success) {
      // Initialize agent data and colors
      agentColors = result.colors || {};
      chatMessages = []; // Reset chat messages

      result.agents.forEach(agent => {
        agentData[agent.name] = {
          name: agent.name,
          status: 'starting',
          output: [],
          use_pty: agent.use_pty
        };
      });

      // Switch to session screen
      challengeScreen.classList.remove('active');
      sessionScreen.classList.add('active');

      // Setup UI
      workspacePath.textContent = result.workspace;
      createAgentTabs(result.agents);
      renderChatMessages(); // Initial render (empty)
      startChatPolling();
    } else {
      alert(`Failed to start session: ${result.error}`);
      startButton.disabled = false;
      startButton.textContent = 'Start Collaboration';
    }
  } catch (error) {
    console.error('Error starting session:', error);
    alert('Error starting session. Check console for details.');
    startButton.disabled = false;
    startButton.textContent = 'Start Collaboration';
  }
}

// Create agent tabs
function createAgentTabs(agents) {
  agentTabsContainer.innerHTML = '';
  agentOutputsContainer.innerHTML = '';

  agents.forEach((agent, index) => {
    const agentInfo = agentData[agent.name];

    // Create tab
    const tab = document.createElement('button');
    tab.className = 'tab';
    if (index === 0) {
      tab.classList.add('active');
      currentAgentTab = agent.name;
    }
    tab.textContent = agent.name;
    tab.onclick = () => switchAgentTab(agent.name);
    agentTabsContainer.appendChild(tab);

    // Create output container
    const outputDiv = document.createElement('div');
    outputDiv.className = 'agent-output';
    outputDiv.id = `output-${agent.name}`;
    if (index === 0) {
      outputDiv.classList.add('active');
    }

    // Add status indicator
    const statusDiv = document.createElement('div');
    statusDiv.className = 'agent-status starting';
    statusDiv.textContent = 'Starting...';
    statusDiv.id = `status-${agent.name}`;
    outputDiv.appendChild(statusDiv);

    if (agentInfo && agentInfo.use_pty) {
      // Create xterm terminal for PTY agents
      const terminalDiv = document.createElement('div');
      terminalDiv.id = `terminal-${agent.name}`;
      terminalDiv.className = 'terminal-container';
      outputDiv.appendChild(terminalDiv);

      // Create and initialize terminal
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Courier New, monospace',
        theme: {
          background: '#1e1e1e',
          foreground: '#e0e0e0'
        },
        rows: 40,
        cols: 120
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalDiv);
      fitAddon.fit();

      terminals[agent.name] = { terminal, fitAddon };

      // Initialize input lock state (default: locked)
      inputLocked[agent.name] = true;

      // Disable stdin by default (prevents cursor/typing when locked)
      terminal.options.disableStdin = true;

      // Add lock toggle button (inside terminal container so it stays anchored)
      const lockToggle = document.createElement('button');
      lockToggle.className = 'input-lock-toggle';
      lockToggle.innerHTML = '🔒 Input locked';
      lockToggle.onclick = () => toggleInputLock(agent.name);
      terminalDiv.appendChild(lockToggle);

      // Wire terminal input to PTY (only when unlocked)
      terminal.onData((data) => {
        if (!inputLocked[agent.name]) {
          window.electronAPI.sendPtyInput(agent.name, data);
        }
      });

      // Fit terminal on window resize
      window.addEventListener('resize', () => {
        if (terminals[agent.name]) {
          terminals[agent.name].fitAddon.fit();
        }
      });
    } else {
      // Create regular text output for non-PTY agents
      const contentPre = document.createElement('pre');
      contentPre.id = `content-${agent.name}`;
      outputDiv.appendChild(contentPre);
    }

    agentOutputsContainer.appendChild(outputDiv);
  });
}

// Switch agent tab
function switchAgentTab(agentName) {
  currentAgentTab = agentName;

  // Update tabs
  document.querySelectorAll('.tab').forEach(tab => {
    if (tab.textContent === agentName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Update outputs
  document.querySelectorAll('.agent-output').forEach(output => {
    if (output.id === `output-${agentName}`) {
      output.classList.add('active');
    } else {
      output.classList.remove('active');
    }
  });

  // Fit terminal if this agent uses PTY
  if (terminals[agentName]) {
    setTimeout(() => {
      terminals[agentName].fitAddon.fit();
    }, 100);
  }
}

// Toggle input lock for a terminal
function toggleInputLock(agentName) {
  inputLocked[agentName] = !inputLocked[agentName];
  const toggle = document.querySelector(`#terminal-${agentName} .input-lock-toggle`);
  const terminal = terminals[agentName]?.terminal;

  if (inputLocked[agentName]) {
    toggle.innerHTML = '🔒 Input locked';
    toggle.classList.remove('unlocked');
    // Disable stdin and blur terminal when locked
    if (terminal) {
      terminal.options.disableStdin = true;
      if (terminal.textarea) {
        terminal.textarea.blur();
      }
    }
  } else {
    toggle.innerHTML = '🔓 Input unlocked';
    toggle.classList.add('unlocked');
    // Enable stdin and focus terminal when unlocked
    if (terminal) {
      terminal.options.disableStdin = false;
      terminal.focus();
    }
  }
}

// Update agent output
function updateAgentOutput(agentName, output, isPty) {
  if (!agentData[agentName]) {
    agentData[agentName] = { name: agentName, output: [] };
  }

  agentData[agentName].output.push(output);

  // Check if this agent uses PTY/terminal
  if (isPty && terminals[agentName]) {
    // Write directly to xterm terminal
    terminals[agentName].terminal.write(output);
  } else {
    // Use regular text output
    const contentElement = document.getElementById(`content-${agentName}`);
    if (contentElement) {
      contentElement.textContent = agentData[agentName].output.join('');

      // Auto-scroll if this is the active tab
      if (currentAgentTab === agentName) {
        const outputContainer = document.getElementById(`output-${agentName}`);
        if (outputContainer) {
          outputContainer.scrollTop = outputContainer.scrollHeight;
        }
      }
    }
  }
}

// Update agent status
function updateAgentStatus(agentName, status, exitCode = null, error = null) {
  if (agentData[agentName]) {
    agentData[agentName].status = status;
  }

  const statusElement = document.getElementById(`status-${agentName}`);
  if (statusElement) {
    statusElement.className = `agent-status ${status}`;

    if (status === 'running') {
      statusElement.textContent = 'Running';
    } else if (status === 'stopped') {
      statusElement.textContent = `Stopped (exit code: ${exitCode})`;
    } else if (status === 'error') {
      statusElement.textContent = `Error: ${error}`;
    }
  }
}

// Format timestamp for display
function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Render a single chat message as HTML
function renderChatMessage(message) {
  const isUser = message.type === 'user';
  const alignClass = isUser ? 'chat-message-right' : 'chat-message-left';
  const color = message.color || agentColors[message.agent?.toLowerCase()] || '#667eea';

  // Parse markdown content
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

// Render all chat messages
function renderChatMessages() {
  if (chatMessages.length === 0) {
    chatViewer.innerHTML = '<div class="chat-empty">No messages yet. Agents are starting...</div>';
    setNewMessagesBanner(false);
    return;
  }

  chatViewer.innerHTML = chatMessages.map(renderChatMessage).join('');
  if (autoScrollEnabled) {
    scrollChatToBottom();
  }
}

// Add a new message to chat
function addChatMessage(message) {
  // Check if message already exists (by sequence number)
  const exists = chatMessages.some(m => m.seq === message.seq);
  if (!exists) {
    const shouldScroll = autoScrollEnabled;
    chatMessages.push(message);
    chatMessages.sort((a, b) => a.seq - b.seq); // Ensure order
    renderChatMessages();
    if (!shouldScroll) {
      setNewMessagesBanner(true);
    }
  }
}

// Update chat from full message array (for refresh/sync)
function updateChatFromMessages(messages) {
  if (Array.isArray(messages)) {
    const prevLastSeq = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1].seq : null;
    const nextLastSeq = messages.length > 0 ? messages[messages.length - 1].seq : null;
    const hasChanges = messages.length !== chatMessages.length || prevLastSeq !== nextLastSeq;
    if (!hasChanges) {
      return;
    }

    const shouldScroll = autoScrollEnabled;
    chatMessages = messages;
    renderChatMessages();
    if (!shouldScroll) {
      setNewMessagesBanner(true);
    }
  }
}

// Send user message
async function sendUserMessage() {
  const message = userMessageInput.value.trim();

  if (!message) {
    return;
  }

  sendMessageButton.disabled = true;
  sendMessageButton.textContent = 'Sending...';

  try {
    const result = await window.electronAPI.sendUserMessage(message);

    if (result.success) {
      userMessageInput.value = '';
      // Chat will be updated via file watcher
    } else {
      alert(`Failed to send message: ${result.error}`);
    }
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Error sending message. Check console for details.');
  } finally {
    sendMessageButton.disabled = false;
    sendMessageButton.textContent = 'Send Message';
  }
}

// Refresh plan and update button visibility
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

    // Update button visibility
    updateImplementButtonState();
  } catch (error) {
    console.error('Error refreshing plan:', error);
  }
}

// Update the Start Implementing button state
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

// Show implementation modal
function showImplementationModal() {
  // Populate agent selection with enabled agents
  agentSelectionContainer.innerHTML = '';

  const enabledAgents = currentConfig.agents || [];

  enabledAgents.forEach((agent, index) => {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'implementer';
    radio.value = agent.name;
    if (index === 0 || enabledAgents.length === 1) {
      radio.checked = true;  // Auto-select first (or only) agent
    }

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

// Hide implementation modal
function hideImplementationModal() {
  implementationModal.style.display = 'none';
}

// Start implementation with selected agent
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

  // Mark implementation as started
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
    alert('Error starting implementation. Check console for details.');
    implementationStarted = false;
    updateImplementButtonState();
  }
}

// Start polling chat content (fallback if file watcher has issues)
function startChatPolling() {
  setInterval(async () => {
    try {
      const messages = await window.electronAPI.getChatContent();
      if (messages && messages.length > 0) {
        updateChatFromMessages(messages);
      }
    } catch (error) {
      console.error('Error polling chat:', error);
    }
  }, 2000);

  // Also poll plan
  setInterval(refreshPlan, 3000);
}

// Stop all agents
async function stopAllAgents() {
  if (confirm('Are you sure you want to stop all agents?')) {
    try {
      await window.electronAPI.stopAgents();
      alert('All agents stopped.');
    } catch (error) {
      console.error('Error stopping agents:', error);
      alert('Error stopping agents. Check console for details.');
    }
  }
}

// Utility: Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function isChatNearBottom() {
  return chatViewer.scrollHeight - chatViewer.scrollTop - chatViewer.clientHeight <= CHAT_SCROLL_THRESHOLD;
}

function scrollChatToBottom() {
  chatViewer.scrollTop = chatViewer.scrollHeight;
}

function setNewMessagesBanner(visible) {
  if (!chatNewMessages) {
    return;
  }
  chatNewMessages.classList.toggle('visible', visible);
  chatNewMessages.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

// Event Listeners
startButton.addEventListener('click', startSession);
stopButton.addEventListener('click', stopAllAgents);
sendMessageButton.addEventListener('click', sendUserMessage);
startImplementingButton.addEventListener('click', showImplementationModal);
modalCancelButton.addEventListener('click', hideImplementationModal);
modalStartButton.addEventListener('click', startImplementation);
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

// Allow Enter+Shift to send message
userMessageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
});

// Allow Enter to submit challenge
challengeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    startSession();
  }
});

// IPC Listeners
window.electronAPI.onAgentOutput((data) => {
  updateAgentOutput(data.agentName, data.output, data.isPty);
});

window.electronAPI.onAgentStatus((data) => {
  updateAgentStatus(data.agentName, data.status, data.exitCode, data.error);
});

// Listen for full chat refresh (array of messages)
window.electronAPI.onChatUpdated((messages) => {
  updateChatFromMessages(messages);
});

// Listen for new individual messages
window.electronAPI.onChatMessage((message) => {
  addChatMessage(message);
});

// Initialize on load
initialize();
