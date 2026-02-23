const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const pty = require('node-pty');
const path = require('path');

// Diagnostic: Log node-pty module info for debugging ABI issues
// Enable with MULTIAGENT_PTY_DEBUG=1
if (process.env.MULTIAGENT_PTY_DEBUG) {
  try {
    const ptyPath = require.resolve('node-pty');
    console.log('[node-pty] Module path:', ptyPath);
    console.log('[node-pty] Node version:', process.version);
    console.log('[node-pty] Electron version:', process.versions.electron || 'N/A');
    console.log('[node-pty] ABI:', process.versions.modules);
  } catch (e) {
    console.warn('[node-pty] Could not resolve module path:', e.message);
  }
}
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const yaml = require('yaml');
const chokidar = require('chokidar');
const crypto = require('crypto');

// Home config directory: ~/.multiagent-chat/
const HOME_CONFIG_DIR = path.join(os.homedir(), '.multiagent-chat');
const RECENT_WORKSPACES_FILE = path.join(HOME_CONFIG_DIR, 'recent-workspaces.json');
const HOME_CONFIG_FILE = path.join(HOME_CONFIG_DIR, 'config.yaml');
const MAX_RECENT_WORKSPACES = 8;

const execAsync = promisify(exec);

let mainWindow;
let agents = [];
let config;
let workspacePath;        // Points to current session dir (e.g. .multiagent-chat/sessions/<id>/)
let workspaceBasePath;    // Points to .multiagent-chat/ inside project root
let agentCwd;             // Parent directory of workspace - where agents are launched
let fileWatcher;
let outboxWatcher;
let customWorkspacePath = null;
let customConfigPath = null;  // CLI --config path
let messageSequence = 0;  // For ordering messages in chat
let agentColors = {};     // Map of agent name -> color
let sessionBaseCommit = null;  // Git commit hash at session start for diff baseline
let currentSessionId = null;  // Current active session ID

// ═══════════════════════════════════════════════════════════
// Session Storage Functions
// ═══════════════════════════════════════════════════════════

function generateSessionId() {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hex = crypto.randomBytes(2).toString('hex');
  return `${ts}-${hex}`;
}

function generateSessionTitle(prompt) {
  if (!prompt) return 'Untitled Session';
  // Truncate at ~60 chars on a word boundary
  if (prompt.length <= 60) return prompt.split('\n')[0];
  const truncated = prompt.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

function getSessionsIndexPath(projectRoot) {
  const wsName = (config && config.workspace) || '.multiagent-chat';
  return path.join(projectRoot, wsName, 'sessions.json');
}

function getSessionsDir(projectRoot) {
  const wsName = (config && config.workspace) || '.multiagent-chat';
  return path.join(projectRoot, wsName, 'sessions');
}

async function loadSessionsIndex(projectRoot) {
  const indexPath = getSessionsIndexPath(projectRoot);
  try {
    const content = await fs.readFile(indexPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('Corrupt sessions.json - failed to parse:', indexPath, error.message);
    }
    return { version: 1, sessions: [] };
  }
}

async function saveSessionsIndex(projectRoot, index) {
  const indexPath = getSessionsIndexPath(projectRoot);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  // Atomic write: write to temp file then rename (rename is atomic on all platforms)
  const tmpPath = indexPath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(index, null, 2));
  await fs.rename(tmpPath, indexPath);
}

// Async mutex to serialize all sessions.json read-modify-write cycles
let sessionsWriteQueue = Promise.resolve();

function withSessionsLock(fn) {
  const next = sessionsWriteQueue.then(fn, fn);
  sessionsWriteQueue = next.catch(() => {});
  return next;
}

async function addSessionToIndex(projectRoot, sessionMeta) {
  return withSessionsLock(async () => {
    const index = await loadSessionsIndex(projectRoot);
    index.sessions.unshift(sessionMeta);
    await saveSessionsIndex(projectRoot, index);
    return index;
  });
}

async function updateSessionInIndex(projectRoot, sessionId, updates) {
  return withSessionsLock(async () => {
    const index = await loadSessionsIndex(projectRoot);
    const session = index.sessions.find(s => s.id === sessionId);
    if (session) {
      Object.assign(session, updates);
      await saveSessionsIndex(projectRoot, index);
    }
    return index;
  });
}

async function setupSessionDirectory(projectRoot, sessionId) {
  const sessionsDir = getSessionsDir(projectRoot);
  const sessionDir = path.join(sessionsDir, sessionId);

  await fs.mkdir(sessionDir, { recursive: true });

  // Initialize chat.jsonl
  const chatPath = path.join(sessionDir, config.chat_file || 'chat.jsonl');
  await fs.writeFile(chatPath, '');

  // Initialize PLAN_FINAL.md
  const planPath = path.join(sessionDir, config.plan_file || 'PLAN_FINAL.md');
  await fs.writeFile(planPath, '');

  // Create outbox directory and per-agent outbox files
  const outboxDir = path.join(sessionDir, config.outbox_dir || 'outbox');
  await fs.mkdir(outboxDir, { recursive: true });

  for (const agentConfig of config.agents) {
    const outboxFile = path.join(outboxDir, `${agentConfig.name.toLowerCase()}.md`);
    await fs.writeFile(outboxFile, '');
  }

  return sessionDir;
}

async function loadSessionData(projectRoot, sessionId) {
  const sessionsDir = getSessionsDir(projectRoot);
  const sessionDir = path.join(sessionsDir, sessionId);

  // Read chat
  let messages = [];
  const chatPath = path.join(sessionDir, config.chat_file || 'chat.jsonl');
  try {
    const content = await fs.readFile(chatPath, 'utf8');
    if (content.trim()) {
      messages = content.trim().split('\n').map(line => {
        try { return JSON.parse(line); }
        catch (e) { return null; }
      }).filter(Boolean);
    }
  } catch (e) {
    // No chat file
  }

  // Read plan
  let plan = '';
  const planPath = path.join(sessionDir, config.plan_file || 'PLAN_FINAL.md');
  try {
    plan = await fs.readFile(planPath, 'utf8');
  } catch (e) {
    // No plan file
  }

  return { messages, plan, sessionDir };
}

// Migrate from old flat .multiagent-chat/ to session-based structure
async function migrateFromFlatWorkspace(projectRoot) {
  const wsName = (config && config.workspace) || '.multiagent-chat';
  const wsBase = path.join(projectRoot, wsName);

  // Check if old flat structure exists (chat.jsonl directly in .multiagent-chat/)
  const oldChatPath = path.join(wsBase, config.chat_file || 'chat.jsonl');
  const sessionsDir = path.join(wsBase, 'sessions');

  try {
    await fs.access(oldChatPath);
    // Old flat structure exists - check if sessions dir already exists
    try {
      await fs.access(sessionsDir);
      // Sessions dir exists, already migrated or mixed state - skip
      return;
    } catch (e) {
      // Sessions dir doesn't exist, migrate
    }
  } catch (e) {
    // No old chat file, nothing to migrate
    return;
  }

  console.log('Migrating flat workspace to session-based structure...');

  // Read old chat to determine session metadata
  let oldMessages = [];
  try {
    const content = await fs.readFile(oldChatPath, 'utf8');
    if (content.trim()) {
      oldMessages = content.trim().split('\n').map(line => {
        try { return JSON.parse(line); }
        catch (e) { return null; }
      }).filter(Boolean);
    }
  } catch (e) {
    // Empty or unreadable
  }

  // Create a session for the old data
  const sessionId = generateSessionId();
  const sessionDir = path.join(sessionsDir, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  // Move chat.jsonl
  try {
    await fs.rename(oldChatPath, path.join(sessionDir, config.chat_file || 'chat.jsonl'));
  } catch (e) {
    // Copy instead if rename fails (cross-device)
    try {
      await fs.copyFile(oldChatPath, path.join(sessionDir, config.chat_file || 'chat.jsonl'));
      await fs.unlink(oldChatPath);
    } catch (copyErr) {
      console.warn('Could not migrate chat file:', copyErr.message);
    }
  }

  // Move PLAN_FINAL.md
  const oldPlanPath = path.join(wsBase, config.plan_file || 'PLAN_FINAL.md');
  try {
    await fs.rename(oldPlanPath, path.join(sessionDir, config.plan_file || 'PLAN_FINAL.md'));
  } catch (e) {
    // Create empty if not found
    await fs.writeFile(path.join(sessionDir, config.plan_file || 'PLAN_FINAL.md'), '');
  }

  // Move outbox directory
  const oldOutboxDir = path.join(wsBase, config.outbox_dir || 'outbox');
  const newOutboxDir = path.join(sessionDir, config.outbox_dir || 'outbox');
  try {
    await fs.rename(oldOutboxDir, newOutboxDir);
  } catch (e) {
    // Create fresh outbox
    await fs.mkdir(newOutboxDir, { recursive: true });
    for (const agentConfig of config.agents) {
      await fs.writeFile(path.join(newOutboxDir, `${agentConfig.name.toLowerCase()}.md`), '');
    }
  }

  // Create sessions.json index
  const firstPrompt = oldMessages.find(m => m.type === 'user')?.content || '';
  const firstTs = oldMessages.length > 0 ? oldMessages[0].timestamp : new Date().toISOString();
  const lastTs = oldMessages.length > 0 ? oldMessages[oldMessages.length - 1].timestamp : new Date().toISOString();

  const sessionMeta = {
    id: sessionId,
    title: generateSessionTitle(firstPrompt),
    firstPrompt: firstPrompt.slice(0, 200),
    workspace: projectRoot,
    createdAt: firstTs,
    lastActiveAt: lastTs,
    messageCount: oldMessages.length,
    status: 'completed'
  };

  await withSessionsLock(async () => {
    await saveSessionsIndex(projectRoot, { version: 1, sessions: [sessionMeta] });
  });
  console.log('Migration complete. Created session:', sessionId);
}

function generateChatSummary(messages) {
  // Take last ~20 messages and create a condensed summary
  const recent = messages.slice(-20);
  if (recent.length === 0) return 'No previous messages.';

  return recent.map(m => {
    const content = (m.content || '').slice(0, 200);
    return `[${m.agent}]: ${content}${m.content && m.content.length > 200 ? '...' : ''}`;
  }).join('\n\n');
}

function buildResumePrompt(chatSummary, plan, newMessage, agentName) {
  const template = config.resume_template || `## Multi-Agent Collaboration Session (Resumed)
**You are: {agent_name}**
You are collaborating with: {agent_names}

### Previous Discussion Summary
{chat_summary}

### Existing Plan
{existing_plan}

### How to Send Messages
\`\`\`bash
cat << 'EOF' > {outbox_file}
Your message here.
EOF
\`\`\`

## New Message from User
{new_message}

### Behavior on Resume
- Default to discussion-first collaboration with the other agents
- Do NOT implement or edit files unless the newest user message explicitly asks for implementation
- If intent is ambiguous, ask a quick clarification before making code changes

Please respond taking into account the context above.`;

  const relFromProject = path.relative(agentCwd, workspacePath);
  const outboxDir = config.outbox_dir || 'outbox';
  const outboxFile = `${relFromProject}/${outboxDir}/${agentName.toLowerCase()}.md`;
  const planFile = `${relFromProject}/${config.plan_file || 'PLAN_FINAL.md'}`;

  return template
    .replace(/{agent_name}/g, agentName)
    .replace(/{agent_names}/g, config.agents.map(a => a.name).join(', '))
    .replace(/{chat_summary}/g, chatSummary)
    .replace(/{existing_plan}/g, plan || 'No plan yet.')
    .replace(/{new_message}/g, newMessage)
    .replace(/{outbox_file}/g, outboxFile)
    .replace(/{plan_file}/g, planFile);
}

// ═══════════════════════════════════════════════════════════
// Init workspace base (just ensures dirs exist, sets agentCwd)
// ═══════════════════════════════════════════════════════════

async function initWorkspaceBase(projectRoot) {
  agentCwd = projectRoot;

  const wsName = (config && config.workspace) || '.multiagent-chat';
  workspaceBasePath = path.join(projectRoot, wsName);
  await fs.mkdir(workspaceBasePath, { recursive: true });
  await fs.mkdir(path.join(workspaceBasePath, 'sessions'), { recursive: true });

  // Build agent colors map from config
  const defaultColors = config.default_agent_colors || ['#667eea', '#f093fb', '#4fd1c5', '#f6ad55', '#68d391', '#fc8181'];
  agentColors = {};
  config.agents.forEach((agentConfig, index) => {
    agentColors[agentConfig.name.toLowerCase()] = agentConfig.color || defaultColors[index % defaultColors.length];
  });
  agentColors['user'] = config.user_color || '#a0aec0';

  // Capture git base commit for diff baseline
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: agentCwd });
    sessionBaseCommit = stdout.trim();
    console.log('Session base commit:', sessionBaseCommit);
  } catch (error) {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: agentCwd });
      sessionBaseCommit = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      console.log('Git repo with no commits, using empty tree hash for diff baseline');
    } catch (e) {
      console.log('Not a git repository:', e.message);
      sessionBaseCommit = null;
    }
  }

  console.log('Workspace base initialized:', workspaceBasePath);
  console.log('Agent working directory:', agentCwd);
}

// ═══════════════════════════════════════════════════════════
// Parse command-line arguments
// ═══════════════════════════════════════════════════════════

function parseCommandLineArgs() {
  if (process.env.WORKSPACE) {
    customWorkspacePath = process.env.WORKSPACE;
    console.log('Using workspace from environment variable:', customWorkspacePath);
  }

  if (process.env.CONFIG) {
    customConfigPath = process.env.CONFIG;
    console.log('Using config from environment variable:', customConfigPath);
  }

  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      customWorkspacePath = args[i + 1];
      console.log('Using workspace from --workspace flag:', customWorkspacePath);
      i++;
    } else if (args[i] === '--config' && args[i + 1]) {
      customConfigPath = args[i + 1];
      console.log('Using config from --config flag:', customConfigPath);
      i++;
    } else if (!args[i].startsWith('--') && !customWorkspacePath) {
      customWorkspacePath = args[i];
      console.log('Using workspace from positional argument:', customWorkspacePath);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Home config directory setup
// ═══════════════════════════════════════════════════════════

async function ensureHomeConfigDir() {
  try {
    await fs.mkdir(HOME_CONFIG_DIR, { recursive: true });
    console.log('Home config directory ensured:', HOME_CONFIG_DIR);

    const userDataDir = app.getPath('userData');
    const oldRecentsFile = path.join(userDataDir, 'recent-workspaces.json');

    try {
      await fs.access(HOME_CONFIG_FILE);
      console.log('Home config exists:', HOME_CONFIG_FILE);
    } catch (e) {
      const bundledConfig = path.join(__dirname, 'config.yaml');
      try {
        await fs.copyFile(bundledConfig, HOME_CONFIG_FILE);
        console.log('Copied default config to:', HOME_CONFIG_FILE);
      } catch (copyError) {
        console.warn('Could not copy default config:', copyError.message);
      }
    }

    try {
      await fs.access(RECENT_WORKSPACES_FILE);
    } catch (e) {
      try {
        await fs.access(oldRecentsFile);
        await fs.copyFile(oldRecentsFile, RECENT_WORKSPACES_FILE);
        console.log('Migrated recent workspaces from:', oldRecentsFile);
      } catch (migrateError) {
        await fs.writeFile(RECENT_WORKSPACES_FILE, JSON.stringify({ recents: [] }, null, 2));
        console.log('Initialized recent workspaces file:', RECENT_WORKSPACES_FILE);
      }
    }
  } catch (error) {
    console.error('Error setting up home config directory:', error);
  }
}

// ═══════════════════════════════════════════════════════════
// Recent workspaces (kept for backward compat / sidebar)
// ═══════════════════════════════════════════════════════════

async function loadRecentWorkspaces() {
  try {
    const content = await fs.readFile(RECENT_WORKSPACES_FILE, 'utf8');
    const data = JSON.parse(content);
    return data.recents || [];
  } catch (error) {
    console.warn('Could not load recent workspaces:', error.message);
    return [];
  }
}

async function saveRecentWorkspaces(recents) {
  try {
    await fs.writeFile(RECENT_WORKSPACES_FILE, JSON.stringify({ recents }, null, 2));
  } catch (error) {
    console.error('Error saving recent workspaces:', error);
  }
}

async function addRecentWorkspace(wsPath) {
  const recents = await loadRecentWorkspaces();
  const now = new Date().toISOString();
  const filtered = recents.filter(r => r.path.toLowerCase() !== wsPath.toLowerCase());
  filtered.unshift({ path: wsPath, lastUsed: now });
  const limited = filtered.slice(0, MAX_RECENT_WORKSPACES);
  await saveRecentWorkspaces(limited);
  return limited;
}

async function removeRecentWorkspace(wsPath) {
  const recents = await loadRecentWorkspaces();
  const filtered = recents.filter(r => r.path.toLowerCase() !== wsPath.toLowerCase());
  await saveRecentWorkspaces(filtered);
  return filtered;
}

async function validateWorkspacePath(wsPath) {
  try {
    const stats = await fs.stat(wsPath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// Browser window
// ═══════════════════════════════════════════════════════════

function createWindow() {
  console.log('Creating window...');

  const iconPath = path.join(__dirname, 'robot.png');

  const windowOptions = {
    width: 1400,
    height: 900,
    icon: iconPath,
    show: false,
    backgroundColor: '#0b0e11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 16 };
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath);
  }

  console.log('Window created, loading index.html...');
  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page loaded successfully');
  });

  console.log('Window setup complete');
}

// ═══════════════════════════════════════════════════════════
// Config loading
// ═══════════════════════════════════════════════════════════

async function loadConfig(configPath = null) {
  try {
    let fullPath;

    if (configPath) {
      fullPath = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
      console.log('Loading config from CLI arg:', fullPath);
    } else if (fsSync.existsSync(HOME_CONFIG_FILE)) {
      fullPath = HOME_CONFIG_FILE;
      console.log('Loading config from home dir:', fullPath);
    } else {
      fullPath = path.join(__dirname, 'config.yaml');
      console.log('Loading bundled config from:', fullPath);
    }

    const configFile = await fs.readFile(fullPath, 'utf8');
    config = yaml.parse(configFile);
    console.log('Config loaded successfully');
    return config;
  } catch (error) {
    console.error('Error loading config:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// Agent Process Management
// ═══════════════════════════════════════════════════════════

class AgentProcess {
  constructor(agentConfig, index) {
    this.name = agentConfig.name;
    this.command = agentConfig.command;
    this.args = agentConfig.args || [];
    this.use_pty = agentConfig.use_pty || false;
    this.index = index;
    this.process = null;
    this.outputBuffer = [];
    this.lastPrompt = null;
    this.intentionalStop = false;
    this.restartCount = 0;
    this.maxRestarts = 3;
    this.initDelay = agentConfig.init_delay_ms || (agentConfig.name === 'Codex' ? 5000 : 3000);
  }

  async start(prompt) {
    this.lastPrompt = prompt;
    this.intentionalStop = false;

    return new Promise((resolve, reject) => {
      console.log(`Starting agent ${this.name} with PTY: ${this.use_pty}`);

      if (this.use_pty) {
        const shell = process.env.SHELL || '/bin/bash';

        this.process = pty.spawn(this.command, this.args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: agentCwd,
          env: {
            ...process.env,
            AGENT_NAME: this.name,
            TERM: 'xterm-256color',
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SHELL: shell,
            LINES: '40',
            COLUMNS: '120'
          },
          handleFlowControl: true
        });

        console.log(`PTY spawned for ${this.name}, PID: ${this.process.pid}`);

        setTimeout(() => {
          this.process.write('\x1b[1;1R');
        }, 100);

        this.process.onData((data) => {
          const output = data.toString();
          this.outputBuffer.push(output);
          if (mainWindow) {
            mainWindow.webContents.send('agent-output', {
              agentName: this.name,
              output: output,
              isPty: true
            });
          }
        });

        this.process.onExit(({ exitCode, signal }) => {
          console.log(`Agent ${this.name} exited with code ${exitCode}, signal ${signal}`);
          this.handleExit(exitCode);
        });

        setTimeout(() => {
          console.log(`Injecting prompt into ${this.name} PTY`);
          this.process.write(prompt + '\n');
          setTimeout(() => {
            this.process.write('\r');
          }, 500);
          resolve();
        }, this.initDelay);

      } else {
        const options = {
          cwd: agentCwd,
          env: { ...process.env, AGENT_NAME: this.name }
        };

        this.process = spawn(this.command, this.args, options);
        console.log(`Process spawned for ${this.name}, PID: ${this.process.pid}`);

        this.process.stdout.on('data', (data) => {
          const output = data.toString();
          this.outputBuffer.push(output);
          if (mainWindow) {
            mainWindow.webContents.send('agent-output', { agentName: this.name, output, isPty: false });
          }
        });

        this.process.stderr.on('data', (data) => {
          const output = data.toString();
          this.outputBuffer.push(`[stderr] ${output}`);
          if (mainWindow) {
            mainWindow.webContents.send('agent-output', { agentName: this.name, output: `[stderr] ${output}`, isPty: false });
          }
        });

        this.process.on('close', (code) => {
          console.log(`Agent ${this.name} exited with code ${code}`);
          this.handleExit(code);
        });

        this.process.on('error', (error) => {
          console.error(`Error starting agent ${this.name}:`, error);
          reject(error);
        });

        resolve();
      }
    });
  }

  handleExit(exitCode) {
    if (this.intentionalStop) {
      console.log(`Agent ${this.name} stopped intentionally`);
      if (mainWindow) {
        mainWindow.webContents.send('agent-status', {
          agentName: this.name,
          status: 'stopped',
          exitCode: exitCode
        });
      }
      return;
    }

    // Unexpected exit - attempt relaunch
    if (this.restartCount < this.maxRestarts && this.lastPrompt) {
      this.restartCount++;
      console.log(`Agent ${this.name} exited unexpectedly (code ${exitCode}), restarting (attempt ${this.restartCount}/${this.maxRestarts})...`);

      if (mainWindow) {
        mainWindow.webContents.send('agent-status', {
          agentName: this.name,
          status: 'restarting',
          exitCode: exitCode,
          restartCount: this.restartCount
        });
      }

      // Wait a moment before relaunching (give time for auto-updates etc.)
      const delay = 2000 * this.restartCount;
      setTimeout(() => {
        this.start(this.lastPrompt).then(() => {
          console.log(`Agent ${this.name} restarted successfully (attempt ${this.restartCount})`);
          if (mainWindow) {
            mainWindow.webContents.send('agent-status', {
              agentName: this.name,
              status: 'running'
            });
          }
        }).catch(err => {
          console.error(`Failed to restart agent ${this.name}:`, err);
          if (mainWindow) {
            mainWindow.webContents.send('agent-status', {
              agentName: this.name,
              status: 'stopped',
              exitCode: exitCode,
              error: `Restart failed: ${err.message}`
            });
          }
        });
      }, delay);
    } else {
      console.log(`Agent ${this.name} exited (code ${exitCode}), max restarts reached or no prompt stored`);
      if (mainWindow) {
        mainWindow.webContents.send('agent-status', {
          agentName: this.name,
          status: 'stopped',
          exitCode: exitCode
        });
      }
    }
  }

  sendMessage(message) {
    if (this.use_pty) {
      if (this.process && this.process.write) {
        this.process.write(message + '\n');
        setTimeout(() => { this.process.write('\r'); }, 300);
      }
    } else {
      if (this.process && this.process.stdin) {
        this.process.stdin.write(message + '\n');
      }
    }
  }

  stop() {
    this.intentionalStop = true;
    if (this.process) {
      if (this.use_pty) {
        this.process.kill();
      } else {
        this.process.kill('SIGTERM');
      }
    }
  }
}

function initializeAgents() {
  agents = config.agents.map((agentConfig, index) => {
    return new AgentProcess(agentConfig, index);
  });
  console.log(`Initialized ${agents.length} agents`);
  return agents;
}

function getAgentByName(name) {
  return agents.find(a => a.name.toLowerCase() === name.toLowerCase());
}

// ═══════════════════════════════════════════════════════════
// Message routing
// ═══════════════════════════════════════════════════════════

function getOutboxRelativePath(agentName) {
  // Build path relative to agentCwd: sessions/<id>/outbox/<agent>.md
  // But we need it relative from agentCwd perspective
  const relFromProject = path.relative(agentCwd, workspacePath);
  const outboxDir = config.outbox_dir || 'outbox';
  return `${relFromProject}/${outboxDir}/${agentName.toLowerCase()}.md`;
}

function sendMessageToOtherAgents(senderName, message) {
  for (const agent of agents) {
    if (agent.name.toLowerCase() !== senderName.toLowerCase()) {
      const outboxFile = getOutboxRelativePath(agent.name);
      const formattedMessage = `\n---\n📨 MESSAGE FROM ${senderName.toUpperCase()}:\n\n${message}\n\n---\n(Respond via: cat << 'EOF' > ${outboxFile})\n`;
      console.log(`Delivering message from ${senderName} to ${agent.name}`);
      agent.sendMessage(formattedMessage);
    }
  }
}

function sendMessageToAllAgents(message) {
  for (const agent of agents) {
    const outboxFile = getOutboxRelativePath(agent.name);
    const formattedMessage = `\n---\n📨 MESSAGE FROM USER:\n\n${message}\n\n---\n(Respond via: cat << 'EOF' > ${outboxFile})\n`;
    console.log(`Delivering user message to ${agent.name}`);
    agent.sendMessage(formattedMessage);
  }
}

function buildAgentPrompt(challenge, agentName) {
  const relFromProject = path.relative(agentCwd, workspacePath);
  const outboxDir = config.outbox_dir || 'outbox';
  const outboxFile = `${relFromProject}/${outboxDir}/${agentName.toLowerCase()}.md`;
  const planFile = `${relFromProject}/${config.plan_file || 'PLAN_FINAL.md'}`;

  return config.prompt_template
    .replace('{challenge}', challenge)
    .replace('{workspace}', workspacePath)
    .replace(/{outbox_file}/g, outboxFile)
    .replace(/{plan_file}/g, planFile)
    .replace('{agent_names}', agents.map(a => a.name).join(', '))
    .replace('{agent_name}', agentName);
}

async function startAgents(challenge) {
  console.log('Starting agents with prompts...');

  for (const agent of agents) {
    try {
      const prompt = buildAgentPrompt(challenge, agent.name);
      await agent.start(prompt);
      console.log(`Started agent: ${agent.name}`);

      if (mainWindow) {
        mainWindow.webContents.send('agent-status', {
          agentName: agent.name,
          status: 'running'
        });
      }
    } catch (error) {
      console.error(`Failed to start agent ${agent.name}:`, error);
      if (mainWindow) {
        mainWindow.webContents.send('agent-status', {
          agentName: agent.name,
          status: 'error',
          error: error.message
        });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// File watchers
// ═══════════════════════════════════════════════════════════

function startFileWatcher() {
  const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');

  fileWatcher = chokidar.watch(chatPath, {
    persistent: true,
    ignoreInitial: true
  });

  fileWatcher.on('change', async () => {
    try {
      const messages = await getChatContent();
      if (mainWindow) {
        mainWindow.webContents.send('chat-updated', messages);
      }
    } catch (error) {
      console.error('Error reading chat file:', error);
    }
  });

  console.log('File watcher started for:', chatPath);
}

function startOutboxWatcher() {
  const outboxDir = path.join(workspacePath, config.outbox_dir || 'outbox');
  const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');

  const processing = new Set();

  outboxWatcher = chokidar.watch(outboxDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  outboxWatcher.on('change', async (filePath) => {
    if (!filePath.endsWith('.md')) return;
    if (processing.has(filePath)) return;
    processing.add(filePath);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const trimmedContent = content.trim();

      if (!trimmedContent) {
        processing.delete(filePath);
        return;
      }

      const filename = path.basename(filePath, '.md');
      const agentName = filename.charAt(0).toUpperCase() + filename.slice(1);

      messageSequence++;
      const timestamp = new Date().toISOString();
      const message = {
        seq: messageSequence,
        type: 'agent',
        agent: agentName,
        timestamp: timestamp,
        content: trimmedContent,
        color: agentColors[agentName.toLowerCase()] || '#667eea'
      };

      await fs.appendFile(chatPath, JSON.stringify(message) + '\n');
      console.log(`Merged message from ${agentName} (#${messageSequence}) into chat.jsonl`);

      await fs.writeFile(filePath, '');

      sendMessageToOtherAgents(agentName, trimmedContent);

      // Update session index with message count and lastActiveAt
      if (currentSessionId && agentCwd) {
        updateSessionInIndex(agentCwd, currentSessionId, {
          lastActiveAt: timestamp,
          messageCount: messageSequence
        }).catch(e => console.warn('Failed to update session index:', e.message));
      }

      if (mainWindow) {
        mainWindow.webContents.send('chat-message', message);
      }
    } catch (error) {
      console.error(`Error processing outbox file ${filePath}:`, error);
    } finally {
      processing.delete(filePath);
    }
  });

  console.log('Outbox watcher started for:', outboxDir);
}

function stopOutboxWatcher() {
  if (outboxWatcher) {
    outboxWatcher.close();
    outboxWatcher = null;
  }
}

// ═══════════════════════════════════════════════════════════
// Chat / Plan / Diff
// ═══════════════════════════════════════════════════════════

async function sendUserMessage(messageText) {
  const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');
  messageSequence++;
  const timestamp = new Date().toISOString();

  const message = {
    seq: messageSequence,
    type: 'user',
    agent: 'User',
    timestamp: timestamp,
    content: messageText,
    color: agentColors['user'] || '#a0aec0'
  };

  try {
    await fs.appendFile(chatPath, JSON.stringify(message) + '\n');
    console.log(`User message #${messageSequence} appended to chat`);

    sendMessageToAllAgents(messageText);

    // Update session index
    if (currentSessionId && agentCwd) {
      updateSessionInIndex(agentCwd, currentSessionId, {
        lastActiveAt: timestamp,
        messageCount: messageSequence
      }).catch(e => console.warn('Failed to update session index:', e.message));
    }

    if (mainWindow) {
      mainWindow.webContents.send('chat-message', message);
    }
  } catch (error) {
    console.error('Error appending user message:', error);
    throw error;
  }
}

async function getChatContent() {
  const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');
  try {
    const content = await fs.readFile(chatPath, 'utf8');
    if (!content.trim()) return [];

    const messages = content.trim().split('\n').map(line => {
      try { return JSON.parse(line); }
      catch (e) { console.error('Failed to parse chat line:', line); return null; }
    }).filter(Boolean);

    return messages;
  } catch (error) {
    console.error('Error reading chat:', error);
    return [];
  }
}

async function getPlanContent() {
  const planPath = path.join(workspacePath, config.plan_file || 'PLAN_FINAL.md');
  try {
    return await fs.readFile(planPath, 'utf8');
  } catch (error) {
    return '';
  }
}

async function getGitDiff() {
  if (!agentCwd) {
    return { isGitRepo: false, error: 'No session active' };
  }

  try {
    await execAsync('git rev-parse --git-dir', { cwd: agentCwd });
  } catch (error) {
    return { isGitRepo: false, error: 'Not a git repository' };
  }

  try {
    const result = {
      isGitRepo: true,
      stats: { filesChanged: 0, insertions: 0, deletions: 0 },
      diff: '',
      untracked: []
    };

    let hasHead = true;
    try {
      await execAsync('git rev-parse HEAD', { cwd: agentCwd });
    } catch (e) {
      hasHead = false;
    }

    const diffTarget = hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

    try {
      const { stdout: statOutput } = await execAsync(
        `git diff ${diffTarget} --stat`,
        { cwd: agentCwd, maxBuffer: 10 * 1024 * 1024 }
      );
      const statMatch = statOutput.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (statMatch) {
        result.stats.filesChanged = parseInt(statMatch[1]) || 0;
        result.stats.insertions = parseInt(statMatch[2]) || 0;
        result.stats.deletions = parseInt(statMatch[3]) || 0;
      }
    } catch (e) {
      // No changes
    }

    try {
      const { stdout: diffOutput } = await execAsync(
        `git diff ${diffTarget}`,
        { cwd: agentCwd, maxBuffer: 10 * 1024 * 1024 }
      );
      result.diff = diffOutput;
    } catch (e) {
      result.diff = '';
    }

    try {
      const { stdout: untrackedOutput } = await execAsync(
        'git ls-files --others --exclude-standard',
        { cwd: agentCwd }
      );
      result.untracked = untrackedOutput.trim().split('\n').filter(Boolean);
    } catch (e) {
      result.untracked = [];
    }

    return result;
  } catch (error) {
    console.error('Error getting git diff:', error);
    return { isGitRepo: true, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Stop all agents and watchers
// ═══════════════════════════════════════════════════════════

function stopAllAgents() {
  agents.forEach(agent => agent.stop());
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
  stopOutboxWatcher();
}

// ═══════════════════════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════════════════════

ipcMain.handle('load-config', async () => {
  try {
    console.log('IPC: load-config called');
    await loadConfig(customConfigPath);
    console.log('IPC: load-config returning:', config);
    return config;
  } catch (error) {
    console.error('IPC: load-config error:', error);
    throw error;
  }
});

// Returns CWD (or CLI workspace) as the default workspace
ipcMain.handle('get-current-workspace', async () => {
  const ws = customWorkspacePath || process.cwd();
  const resolved = path.isAbsolute(ws) ? ws : path.resolve(ws);
  return {
    path: resolved,
    name: path.basename(resolved)
  };
});

// Returns sessions for a given workspace/project root
ipcMain.handle('get-sessions-for-workspace', async (event, projectRoot) => {
  try {
    // Migrate from flat workspace if needed
    await migrateFromFlatWorkspace(projectRoot);

    const index = await withSessionsLock(async () => {
      const idx = await loadSessionsIndex(projectRoot);

      // Reconcile stale active sessions: if no agents are running for a session,
      // downgrade it from 'active' to 'completed'
      let reconciled = false;
      for (const session of idx.sessions) {
        if (session.status === 'active' && session.id !== currentSessionId) {
          session.status = 'completed';
          reconciled = true;
        }
      }
      if (reconciled) {
        await saveSessionsIndex(projectRoot, idx);
      }

      return idx;
    });

    return index.sessions || [];
  } catch (error) {
    console.error('Error getting sessions:', error);
    return [];
  }
});

// Load session data (chat, plan) without starting agents
ipcMain.handle('load-session', async (event, { projectRoot, sessionId }) => {
  try {
    const data = await loadSessionData(projectRoot, sessionId);

    // Set workspace path to session dir so getChatContent/getPlanContent work
    workspacePath = data.sessionDir;
    agentCwd = projectRoot;
    currentSessionId = sessionId;

    // Build agent colors
    const defaultColors = config.default_agent_colors || ['#667eea', '#f093fb', '#4fd1c5', '#f6ad55', '#68d391', '#fc8181'];
    agentColors = {};
    config.agents.forEach((agentConfig, index) => {
      agentColors[agentConfig.name.toLowerCase()] = agentConfig.color || defaultColors[index % defaultColors.length];
    });
    agentColors['user'] = config.user_color || '#a0aec0';

    // Set messageSequence to last message's seq
    if (data.messages.length > 0) {
      messageSequence = data.messages[data.messages.length - 1].seq || data.messages.length;
    } else {
      messageSequence = 0;
    }

    return {
      success: true,
      messages: data.messages,
      plan: data.plan,
      colors: agentColors,
      sessionDir: data.sessionDir
    };
  } catch (error) {
    console.error('Error loading session:', error);
    return { success: false, error: error.message };
  }
});

// Resume session - initialize agents with resume context
ipcMain.handle('resume-session', async (event, { projectRoot, sessionId, newMessage }) => {
  try {
    const data = await loadSessionData(projectRoot, sessionId);

    // Set workspace path and agentCwd
    workspacePath = data.sessionDir;
    agentCwd = projectRoot;
    currentSessionId = sessionId;

    await initWorkspaceBase(projectRoot);

    // Set messageSequence
    if (data.messages.length > 0) {
      messageSequence = data.messages[data.messages.length - 1].seq || data.messages.length;
    } else {
      messageSequence = 0;
    }

    // Ensure outbox files are clean
    const outboxDir = path.join(workspacePath, config.outbox_dir || 'outbox');
    await fs.mkdir(outboxDir, { recursive: true });
    for (const agentConfig of config.agents) {
      const outboxFile = path.join(outboxDir, `${agentConfig.name.toLowerCase()}.md`);
      await fs.writeFile(outboxFile, '');
    }

    // Initialize agents
    initializeAgents();

    // Build resume prompts and start agents
    const chatSummary = generateChatSummary(data.messages);
    console.log('Starting agents with resume prompts...');

    for (const agent of agents) {
      try {
        const prompt = buildResumePrompt(chatSummary, data.plan, newMessage, agent.name);
        await agent.start(prompt);
        console.log(`Started agent: ${agent.name} (resumed)`);

        if (mainWindow) {
          mainWindow.webContents.send('agent-status', {
            agentName: agent.name,
            status: 'running'
          });
        }
      } catch (error) {
        console.error(`Failed to start agent ${agent.name}:`, error);
        if (mainWindow) {
          mainWindow.webContents.send('agent-status', {
            agentName: agent.name,
            status: 'error',
            error: error.message
          });
        }
      }
    }

    // Append user message to chat
    await sendUserMessage(newMessage);

    // Start watchers
    startFileWatcher();
    startOutboxWatcher();

    // Update session index
    await updateSessionInIndex(projectRoot, sessionId, {
      lastActiveAt: new Date().toISOString(),
      status: 'active'
    });

    // Add to recent workspaces
    await addRecentWorkspace(projectRoot);

    return {
      success: true,
      agents: agents.map(a => ({ name: a.name, use_pty: a.use_pty })),
      workspace: agentCwd,
      colors: agentColors,
      sessionId: sessionId
    };
  } catch (error) {
    console.error('Error resuming session:', error);
    return { success: false, error: error.message };
  }
});

// Start new session - creates session dir, starts agents
ipcMain.handle('start-session', async (event, { challenge, workspace: selectedWorkspace }) => {
  try {
    const projectRoot = selectedWorkspace || customWorkspacePath || process.cwd();
    const resolvedRoot = path.isAbsolute(projectRoot) ? projectRoot : path.resolve(projectRoot);

    await initWorkspaceBase(resolvedRoot);

    // Migrate if needed
    await migrateFromFlatWorkspace(resolvedRoot);

    // Create new session
    const sessionId = generateSessionId();
    currentSessionId = sessionId;
    const sessionDir = await setupSessionDirectory(resolvedRoot, sessionId);
    workspacePath = sessionDir;

    // Add to session index
    const sessionMeta = {
      id: sessionId,
      title: generateSessionTitle(challenge),
      firstPrompt: challenge.slice(0, 200),
      workspace: resolvedRoot,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 0,
      status: 'active'
    };
    await addSessionToIndex(resolvedRoot, sessionMeta);

    // Reset message sequence
    messageSequence = 0;

    initializeAgents();
    await startAgents(challenge);
    startFileWatcher();
    startOutboxWatcher();

    // Add workspace to recents
    await addRecentWorkspace(resolvedRoot);

    return {
      success: true,
      agents: agents.map(a => ({ name: a.name, use_pty: a.use_pty })),
      workspace: agentCwd,
      colors: agentColors,
      sessionId: sessionId
    };
  } catch (error) {
    console.error('Error starting session:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('send-user-message', async (event, message) => {
  try {
    await sendUserMessage(message);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-chat-content', async () => {
  return await getChatContent();
});

ipcMain.handle('get-plan-content', async () => {
  return await getPlanContent();
});

ipcMain.handle('get-git-diff', async () => {
  return await getGitDiff();
});

ipcMain.handle('stop-agents', async () => {
  stopAllAgents();
  return { success: true };
});

// Reset session - marks current session as completed, stops agents
ipcMain.handle('reset-session', async () => {
  try {
    stopAllAgents();

    // Mark current session as completed in index
    if (currentSessionId && agentCwd) {
      await updateSessionInIndex(agentCwd, currentSessionId, {
        status: 'completed',
        lastActiveAt: new Date().toISOString()
      });
    }

    // Reset state
    messageSequence = 0;
    agents = [];
    sessionBaseCommit = null;
    currentSessionId = null;

    return { success: true };
  } catch (error) {
    console.error('Error resetting session:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-implementation', async (event, selectedAgent, otherAgents) => {
  try {
    const promptTemplate = config.prompts?.implementation_handoff ||
      '{selected_agent}, please now implement this plan. {other_agents} please wait for confirmation from {selected_agent} that they have completed the implementation. You should then check the changes, and provide feedback if necessary. Keep iterating together until you are all happy with the implementation.';

    const prompt = promptTemplate
      .replace(/{selected_agent}/g, selectedAgent)
      .replace(/{other_agents}/g, otherAgents.join(', '));

    await sendUserMessage(prompt);

    console.log(`Implementation started with ${selectedAgent} as implementer`);
    return { success: true };
  } catch (error) {
    console.error('Error starting implementation:', error);
    return { success: false, error: error.message };
  }
});

// Workspace Management IPC Handlers
ipcMain.handle('get-recent-workspaces', async () => {
  const recents = await loadRecentWorkspaces();
  const withValidation = await Promise.all(
    recents.map(async (r) => ({
      ...r,
      exists: await validateWorkspacePath(r.path),
      name: path.basename(r.path)
    }))
  );
  return withValidation;
});

ipcMain.handle('add-recent-workspace', async (event, wsPath) => {
  return await addRecentWorkspace(wsPath);
});

ipcMain.handle('remove-recent-workspace', async (event, wsPath) => {
  return await removeRecentWorkspace(wsPath);
});

ipcMain.handle('get-current-directory', async () => {
  const cwd = process.cwd();
  const appDir = __dirname;
  return {
    path: cwd,
    isUsable: cwd !== appDir && fsSync.existsSync(cwd),
    appDir
  };
});

ipcMain.handle('browse-for-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Workspace Directory'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('open-config-folder', async () => {
  try {
    await shell.openPath(HOME_CONFIG_DIR);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-home-config-path', async () => {
  return HOME_CONFIG_DIR;
});

ipcMain.handle('get-cli-workspace', async () => {
  return customWorkspacePath;
});

// Handle PTY input from renderer (user typing into terminal)
ipcMain.on('pty-input', (event, { agentName, data }) => {
  const agent = getAgentByName(agentName);
  if (agent && agent.use_pty && agent.process) {
    agent.process.write(data);
  }
});

// ═══════════════════════════════════════════════════════════
// App lifecycle
// ═══════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  console.log('App ready, setting up...');
  parseCommandLineArgs();
  await ensureHomeConfigDir();
  createWindow();
});

app.on('window-all-closed', () => {
  stopAllAgents();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  stopAllAgents();
});
