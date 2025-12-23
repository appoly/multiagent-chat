const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const yaml = require('yaml');
const chokidar = require('chokidar');

// Home config directory: ~/.multiagent-chat/
const HOME_CONFIG_DIR = path.join(os.homedir(), '.multiagent-chat');
const RECENT_WORKSPACES_FILE = path.join(HOME_CONFIG_DIR, 'recent-workspaces.json');
const HOME_CONFIG_FILE = path.join(HOME_CONFIG_DIR, 'config.yaml');
const MAX_RECENT_WORKSPACES = 8;

const execAsync = promisify(exec);

let mainWindow;
let agents = [];
let config;
let workspacePath;
let agentCwd;  // Parent directory of workspace - where agents are launched
let fileWatcher;
let outboxWatcher;
let customWorkspacePath = null;
let customConfigPath = null;  // CLI --config path
let messageSequence = 0;  // For ordering messages in chat
let agentColors = {};     // Map of agent name -> color
let sessionBaseCommit = null;  // Git commit hash at session start for diff baseline

// Parse command-line arguments
// Usage: npm start /path/to/workspace
// Or: npm start --workspace /path/to/workspace
// Or: npm start --config /path/to/config.yaml
// Or: WORKSPACE=/path/to/workspace npm start
function parseCommandLineArgs() {
  // Check environment variables first
  if (process.env.WORKSPACE) {
    customWorkspacePath = process.env.WORKSPACE;
    console.log('Using workspace from environment variable:', customWorkspacePath);
  }

  if (process.env.CONFIG) {
    customConfigPath = process.env.CONFIG;
    console.log('Using config from environment variable:', customConfigPath);
  }

  // Then check command-line arguments
  // process.argv looks like: [electron, main.js, ...args]
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    // Parse --workspace flag
    if (args[i] === '--workspace' && args[i + 1]) {
      customWorkspacePath = args[i + 1];
      console.log('Using workspace from --workspace flag:', customWorkspacePath);
      i++; // Skip next arg
    }
    // Parse --config flag
    else if (args[i] === '--config' && args[i + 1]) {
      customConfigPath = args[i + 1];
      console.log('Using config from --config flag:', customConfigPath);
      i++; // Skip next arg
    }
    // Positional arg (assume workspace path if not a flag)
    else if (!args[i].startsWith('--') && !customWorkspacePath) {
      customWorkspacePath = args[i];
      console.log('Using workspace from positional argument:', customWorkspacePath);
    }
  }
}

// Ensure home config directory exists and set up first-run defaults
async function ensureHomeConfigDir() {
  try {
    // Create ~/.multiagent-chat/ if it doesn't exist
    await fs.mkdir(HOME_CONFIG_DIR, { recursive: true });
    console.log('Home config directory ensured:', HOME_CONFIG_DIR);

    // Migration: check for existing data in Electron userData
    const userDataDir = app.getPath('userData');
    const oldRecentsFile = path.join(userDataDir, 'recent-workspaces.json');

    // Check if config.yaml exists in home dir, if not copy default
    try {
      await fs.access(HOME_CONFIG_FILE);
      console.log('Home config exists:', HOME_CONFIG_FILE);
    } catch (e) {
      // Copy bundled default config to home dir
      const bundledConfig = path.join(__dirname, 'config.yaml');
      try {
        await fs.copyFile(bundledConfig, HOME_CONFIG_FILE);
        console.log('Copied default config to:', HOME_CONFIG_FILE);
      } catch (copyError) {
        console.warn('Could not copy default config:', copyError.message);
      }
    }

    // Initialize or migrate recent-workspaces.json
    try {
      await fs.access(RECENT_WORKSPACES_FILE);
    } catch (e) {
      // Try to migrate from old location first
      try {
        await fs.access(oldRecentsFile);
        await fs.copyFile(oldRecentsFile, RECENT_WORKSPACES_FILE);
        console.log('Migrated recent workspaces from:', oldRecentsFile);
      } catch (migrateError) {
        // No old file, create new empty one
        await fs.writeFile(RECENT_WORKSPACES_FILE, JSON.stringify({ recents: [] }, null, 2));
        console.log('Initialized recent workspaces file:', RECENT_WORKSPACES_FILE);
      }
    }
  } catch (error) {
    console.error('Error setting up home config directory:', error);
  }
}

// Load recent workspaces from JSON file
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

// Save recent workspaces to JSON file
async function saveRecentWorkspaces(recents) {
  try {
    await fs.writeFile(RECENT_WORKSPACES_FILE, JSON.stringify({ recents }, null, 2));
  } catch (error) {
    console.error('Error saving recent workspaces:', error);
  }
}

// Add or update a workspace in recents
async function addRecentWorkspace(workspacePath) {
  const recents = await loadRecentWorkspaces();
  const now = new Date().toISOString();

  // Remove existing entry with same path (case-insensitive on Windows)
  const filtered = recents.filter(r =>
    r.path.toLowerCase() !== workspacePath.toLowerCase()
  );

  // Add new entry at the beginning
  filtered.unshift({
    path: workspacePath,
    lastUsed: now
  });

  // Limit to max entries
  const limited = filtered.slice(0, MAX_RECENT_WORKSPACES);

  await saveRecentWorkspaces(limited);
  return limited;
}

// Remove a workspace from recents
async function removeRecentWorkspace(workspacePath) {
  const recents = await loadRecentWorkspaces();
  const filtered = recents.filter(r =>
    r.path.toLowerCase() !== workspacePath.toLowerCase()
  );
  await saveRecentWorkspaces(filtered);
  return filtered;
}

// Update path of a workspace in recents (for "Locate" functionality)
async function updateRecentWorkspacePath(oldPath, newPath) {
  const recents = await loadRecentWorkspaces();
  const now = new Date().toISOString();

  const updated = recents.map(r => {
    if (r.path.toLowerCase() === oldPath.toLowerCase()) {
      return { path: newPath, lastUsed: now };
    }
    return r;
  });

  await saveRecentWorkspaces(updated);
  return updated;
}

// Validate if a workspace path exists and is a directory
async function validateWorkspacePath(workspacePath) {
  try {
    const stats = await fs.stat(workspacePath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

// Get current working directory info
function getCurrentDirectoryInfo() {
  const cwd = process.cwd();
  const appDir = __dirname;

  // Check if cwd is different from app directory and exists
  const isUsable = cwd !== appDir && fsSync.existsSync(cwd);

  return {
    path: cwd,
    isUsable,
    appDir
  };
}

// Create the browser window
function createWindow() {
  console.log('Creating window...');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  console.log('Window created, loading index.html...');
  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page loaded successfully');
  });

  //mainWindow.webContents.openDevTools(); // Remove in production

  console.log('Window setup complete');
}

// Load configuration with priority: CLI arg > home config > bundled default
async function loadConfig(configPath = null) {
  try {
    let fullPath;

    // Priority 1: CLI argument (--config flag or CONFIG env var)
    if (configPath) {
      fullPath = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
      console.log('Loading config from CLI arg:', fullPath);
    }
    // Priority 2: Home directory config (~/.multiagent-chat/config.yaml)
    else if (fsSync.existsSync(HOME_CONFIG_FILE)) {
      fullPath = HOME_CONFIG_FILE;
      console.log('Loading config from home dir:', fullPath);
    }
    // Priority 3: Bundled default (fallback)
    else {
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

// Setup workspace directory and files
// customPath = project root selected by user (or from CLI)
async function setupWorkspace(customPath = null) {
  // Determine project root (agentCwd) and workspace path (.multiagent-chat inside it)
  let projectRoot;

  if (customPath && path.isAbsolute(customPath)) {
    projectRoot = customPath;
  } else if (customPath) {
    projectRoot = path.join(process.cwd(), customPath);
  } else {
    // Fallback: use current directory as project root
    projectRoot = process.cwd();
  }

  // Set agent working directory to the project root
  agentCwd = projectRoot;

  // Set workspace path to .multiagent-chat inside the project root
  const workspaceName = config.workspace || '.multiagent-chat';
  workspacePath = path.join(projectRoot, workspaceName);

  try {
    await fs.mkdir(workspacePath, { recursive: true });

    // Initialize chat.jsonl (empty file - JSONL format)
    const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');
    await fs.writeFile(chatPath, '');

    // Clear PLAN_FINAL.md if it exists
    const planPath = path.join(workspacePath, config.plan_file || 'PLAN_FINAL.md');
    await fs.writeFile(planPath, '');

    // Create outbox directory and per-agent outbox files
    const outboxDir = path.join(workspacePath, config.outbox_dir || 'outbox');
    await fs.mkdir(outboxDir, { recursive: true });

    // Build agent colors map from config
    const defaultColors = config.default_agent_colors || ['#667eea', '#f093fb', '#4fd1c5', '#f6ad55', '#68d391', '#fc8181'];
    agentColors = {};
    config.agents.forEach((agentConfig, index) => {
      agentColors[agentConfig.name.toLowerCase()] = agentConfig.color || defaultColors[index % defaultColors.length];
    });
    // Add user color
    agentColors['user'] = config.user_color || '#a0aec0';

    // Create empty outbox file for each agent
    for (const agentConfig of config.agents) {
      const outboxFile = path.join(outboxDir, `${agentConfig.name.toLowerCase()}.md`);
      await fs.writeFile(outboxFile, '');
    }

    // Reset message sequence
    messageSequence = 0;

    // Capture git base commit for diff baseline
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: agentCwd });
      sessionBaseCommit = stdout.trim();
      console.log('Session base commit:', sessionBaseCommit);
    } catch (error) {
      // Check if it's a git repo with no commits yet
      try {
        await execAsync('git rev-parse --git-dir', { cwd: agentCwd });
        // It's a git repo but no commits - use empty tree hash
        sessionBaseCommit = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        console.log('Git repo with no commits, using empty tree hash for diff baseline');
      } catch (e) {
        console.log('Not a git repository:', e.message);
        sessionBaseCommit = null;
      }
    }

    console.log('Workspace setup complete:', workspacePath);
    console.log('Agent working directory:', agentCwd);
    console.log('Outbox directory created:', outboxDir);
    console.log('Agent colors:', agentColors);
    return workspacePath;
  } catch (error) {
    console.error('Error setting up workspace:', error);
    throw error;
  }
}

// Agent Process Management
class AgentProcess {
  constructor(agentConfig, index) {
    this.name = agentConfig.name;
    this.command = agentConfig.command;
    this.args = agentConfig.args || [];
    this.use_pty = agentConfig.use_pty || false;
    this.index = index;
    this.process = null;
    this.outputBuffer = [];
  }

  async start(prompt) {
    return new Promise((resolve, reject) => {
      console.log(`Starting agent ${this.name} with PTY: ${this.use_pty}`);

      if (this.use_pty) {
        // Use PTY for interactive TUI agents
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

        // Respond to cursor position query immediately
        // This helps with terminal capability detection (needed for Codex)
        setTimeout(() => {
          this.process.write('\x1b[1;1R'); // Report cursor at position 1,1
        }, 100);

        // Capture all output from PTY
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

        // Handle exit - trigger resume if enabled
        this.process.onExit(({ exitCode, signal }) => {
          console.log(`Agent ${this.name} exited with code ${exitCode}, signal ${signal}`);
          this.handleExit(exitCode);
        });

        // Inject prompt via PTY after TUI initializes (original working pattern)
        const initDelay = this.name === 'Codex' ? 5000 : 3000;
        setTimeout(() => {
          console.log(`Injecting prompt into ${this.name} PTY`);
          this.process.write(prompt + '\n');

          // Send Enter key after a brief delay to submit
          setTimeout(() => {
            this.process.write('\r');
          }, 500);

          resolve();
        }, initDelay);

      } else {
        // Use regular spawn for non-interactive agents
        const options = {
          cwd: agentCwd,
          env: {
            ...process.env,
            AGENT_NAME: this.name
          }
        };

        this.process = spawn(this.command, this.args, options);

        console.log(`Process spawned for ${this.name}, PID: ${this.process.pid}`);

        // Capture stdout
        this.process.stdout.on('data', (data) => {
          const output = data.toString();
          this.outputBuffer.push(output);

          if (mainWindow) {
            mainWindow.webContents.send('agent-output', {
              agentName: this.name,
              output: output,
              isPty: false
            });
          }
        });

        // Capture stderr
        this.process.stderr.on('data', (data) => {
          const output = data.toString();
          this.outputBuffer.push(`[stderr] ${output}`);

          if (mainWindow) {
            mainWindow.webContents.send('agent-output', {
              agentName: this.name,
              output: `[stderr] ${output}`,
              isPty: false
            });
          }
        });

        // Handle process exit - trigger resume if enabled
        this.process.on('close', (code) => {
          console.log(`Agent ${this.name} exited with code ${code}`);
          this.handleExit(code);
        });

        // Handle errors
        this.process.on('error', (error) => {
          console.error(`Error starting agent ${this.name}:`, error);
          reject(error);
        });

        resolve();
      }
    });
  }

  // Handle agent exit
  handleExit(exitCode) {
    if (mainWindow) {
      mainWindow.webContents.send('agent-status', {
        agentName: this.name,
        status: 'stopped',
        exitCode: exitCode
      });
    }
  }

  sendMessage(message) {
    if (this.use_pty) {
      if (this.process && this.process.write) {
        this.process.write(message + '\n');
        // Send Enter key to submit for PTY
        setTimeout(() => {
          this.process.write('\r');
        }, 300);
      }
    } else {
      if (this.process && this.process.stdin) {
        this.process.stdin.write(message + '\n');
      }
    }
  }

  stop() {
    if (this.process) {
      if (this.use_pty) {
        this.process.kill();
      } else {
        this.process.kill('SIGTERM');
      }
    }
  }
}

// Initialize agents from config
function initializeAgents() {
  agents = config.agents.map((agentConfig, index) => {
    return new AgentProcess(agentConfig, index);
  });

  console.log(`Initialized ${agents.length} agents`);
  return agents;
}

// Get agent by name
function getAgentByName(name) {
  return agents.find(a => a.name.toLowerCase() === name.toLowerCase());
}

// Send a message to all agents EXCEPT the sender
function sendMessageToOtherAgents(senderName, message) {
  const workspaceFolder = path.basename(workspacePath);
  const outboxDir = config.outbox_dir || 'outbox';

  for (const agent of agents) {
    if (agent.name.toLowerCase() !== senderName.toLowerCase()) {
      // Path relative to agentCwd (includes workspace folder)
      const outboxFile = `${workspaceFolder}/${outboxDir}/${agent.name.toLowerCase()}.md`;
      const formattedMessage = `\n---\n📨 MESSAGE FROM ${senderName.toUpperCase()}:\n\n${message}\n\n---\n(Respond via: cat << 'EOF' > ${outboxFile})\n`;

      console.log(`Delivering message from ${senderName} to ${agent.name}`);
      agent.sendMessage(formattedMessage);
    }
  }
}

// Send a message to ALL agents (for user messages)
function sendMessageToAllAgents(message) {
  const workspaceFolder = path.basename(workspacePath);
  const outboxDir = config.outbox_dir || 'outbox';

  for (const agent of agents) {
    // Path relative to agentCwd (includes workspace folder)
    const outboxFile = `${workspaceFolder}/${outboxDir}/${agent.name.toLowerCase()}.md`;
    const formattedMessage = `\n---\n📨 MESSAGE FROM USER:\n\n${message}\n\n---\n(Respond via: cat << 'EOF' > ${outboxFile})\n`;

    console.log(`Delivering user message to ${agent.name}`);
    agent.sendMessage(formattedMessage);
  }
}

// Build prompt for a specific agent
function buildAgentPrompt(challenge, agentName) {
  const workspaceFolder = path.basename(workspacePath);
  const outboxDir = config.outbox_dir || 'outbox';
  // Path relative to agentCwd (includes workspace folder)
  const outboxFile = `${workspaceFolder}/${outboxDir}/${agentName.toLowerCase()}.md`;
  const planFile = `${workspaceFolder}/${config.plan_file || 'PLAN_FINAL.md'}`;

  return config.prompt_template
    .replace('{challenge}', challenge)
    .replace('{workspace}', workspacePath)
    .replace(/{outbox_file}/g, outboxFile)  // Replace all occurrences
    .replace(/{plan_file}/g, planFile)  // Replace all occurrences
    .replace('{agent_names}', agents.map(a => a.name).join(', '))
    .replace('{agent_name}', agentName);
}

// Start all agents with their individual prompts
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

// Watch chat.jsonl for changes (backup - real-time updates via chat-message event)
function startFileWatcher() {
  const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');

  fileWatcher = chokidar.watch(chatPath, {
    persistent: true,
    ignoreInitial: true
  });

  // Note: Primary updates happen via 'chat-message' events sent when outbox is processed
  // This watcher is a backup for any external modifications
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

// Watch outbox directory and merge messages into chat.jsonl
function startOutboxWatcher() {
  const outboxDir = path.join(workspacePath, config.outbox_dir || 'outbox');
  const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');

  // Track which files we're currently processing to avoid race conditions
  const processing = new Set();

  outboxWatcher = chokidar.watch(outboxDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,  // Wait for file to be stable for 500ms
      pollInterval: 100
    }
  });

  outboxWatcher.on('change', async (filePath) => {
    // Only process .md files
    if (!filePath.endsWith('.md')) return;

    // Avoid processing the same file concurrently
    if (processing.has(filePath)) return;
    processing.add(filePath);

    try {
      // Read the outbox file
      const content = await fs.readFile(filePath, 'utf8');
      const trimmedContent = content.trim();

      // Skip if empty
      if (!trimmedContent) {
        processing.delete(filePath);
        return;
      }

      // Extract agent name from filename (e.g., "claude.md" -> "Claude")
      const filename = path.basename(filePath, '.md');
      const agentName = filename.charAt(0).toUpperCase() + filename.slice(1);

      // Increment sequence and create message object
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

      // Append to chat.jsonl
      await fs.appendFile(chatPath, JSON.stringify(message) + '\n');
      console.log(`Merged message from ${agentName} (#${messageSequence}) into chat.jsonl`);

      // Clear the outbox file
      await fs.writeFile(filePath, '');

      // PUSH message to other agents' PTYs
      sendMessageToOtherAgents(agentName, trimmedContent);

      // Notify renderer with the new message
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

// Stop outbox watcher
function stopOutboxWatcher() {
  if (outboxWatcher) {
    outboxWatcher.close();
    outboxWatcher = null;
  }
}

// Append user message to chat.jsonl and push to all agents
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
    // Append to chat.jsonl
    await fs.appendFile(chatPath, JSON.stringify(message) + '\n');
    console.log(`User message #${messageSequence} appended to chat`);

    // PUSH message to all agents' PTYs
    sendMessageToAllAgents(messageText);

    // Notify renderer with the new message
    if (mainWindow) {
      mainWindow.webContents.send('chat-message', message);
    }

  } catch (error) {
    console.error('Error appending user message:', error);
    throw error;
  }
}

// Read current chat content (returns array of message objects)
async function getChatContent() {
  const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');
  try {
    const content = await fs.readFile(chatPath, 'utf8');
    if (!content.trim()) return [];

    // Parse JSONL (one JSON object per line)
    const messages = content.trim().split('\n').map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.error('Failed to parse chat line:', line);
        return null;
      }
    }).filter(Boolean);

    return messages;
  } catch (error) {
    console.error('Error reading chat:', error);
    return [];
  }
}

// Read final plan
async function getPlanContent() {
  const planPath = path.join(workspacePath, config.plan_file || 'PLAN_FINAL.md');
  try {
    return await fs.readFile(planPath, 'utf8');
  } catch (error) {
    return '';
  }
}

// Get git diff - shows uncommitted changes only (git diff HEAD)
async function getGitDiff() {
  // Not a git repo or session hasn't started
  if (!agentCwd) {
    return { isGitRepo: false, error: 'No session active' };
  }

  // Check if git repo
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

    // Check if HEAD exists (repo might have no commits)
    let hasHead = true;
    try {
      await execAsync('git rev-parse HEAD', { cwd: agentCwd });
    } catch (e) {
      hasHead = false;
    }

    // Determine diff target - use empty tree hash if no commits yet
    const diffTarget = hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

    // Get diff stats
    try {
      const { stdout: statOutput } = await execAsync(
        `git diff ${diffTarget} --stat`,
        { cwd: agentCwd, maxBuffer: 10 * 1024 * 1024 }
      );

      // Parse stats from last line (e.g., "3 files changed, 10 insertions(+), 5 deletions(-)")
      const statMatch = statOutput.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (statMatch) {
        result.stats.filesChanged = parseInt(statMatch[1]) || 0;
        result.stats.insertions = parseInt(statMatch[2]) || 0;
        result.stats.deletions = parseInt(statMatch[3]) || 0;
      }
    } catch (e) {
      // No changes or other error
    }

    // Get full diff
    try {
      const { stdout: diffOutput } = await execAsync(
        `git diff ${diffTarget}`,
        { cwd: agentCwd, maxBuffer: 10 * 1024 * 1024 }
      );
      result.diff = diffOutput;
    } catch (e) {
      result.diff = '';
    }

    // Get untracked files
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

// Stop all agents and watchers
function stopAllAgents() {
  agents.forEach(agent => agent.stop());
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
  stopOutboxWatcher();
}

// IPC Handlers
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

ipcMain.handle('start-session', async (event, { challenge, workspace: selectedWorkspace }) => {
  try {
    // Use selected workspace if provided, otherwise fall back to customWorkspacePath
    const workspaceToUse = selectedWorkspace || customWorkspacePath;
    await setupWorkspace(workspaceToUse);
    initializeAgents();
    await startAgents(challenge);
    startFileWatcher();
    startOutboxWatcher();  // Watch for agent messages and merge into chat.jsonl

    // Add workspace to recents (agentCwd is the project root)
    if (agentCwd) {
      await addRecentWorkspace(agentCwd);
    }

    // Check if this session was started with CLI workspace (and user didn't change it)
    const isFromCli = customWorkspacePath && (
      workspaceToUse === customWorkspacePath ||
      agentCwd === customWorkspacePath ||
      agentCwd === path.resolve(customWorkspacePath)
    );

    return {
      success: true,
      agents: agents.map(a => ({ name: a.name, use_pty: a.use_pty })),
      workspace: agentCwd,  // Show the project root, not the internal .multiagent-chat folder
      colors: agentColors,
      fromCli: isFromCli
    };
  } catch (error) {
    console.error('Error starting session:', error);
    return {
      success: false,
      error: error.message
    };
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

ipcMain.handle('reset-session', async () => {
  try {
    // Stop all agents and watchers
    stopAllAgents();

    // Clear chat file (handle missing file gracefully)
    if (workspacePath) {
      const chatPath = path.join(workspacePath, config.chat_file || 'chat.jsonl');
      try {
        await fs.writeFile(chatPath, '');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Clear plan file (handle missing file gracefully)
      const planPath = path.join(workspacePath, config.plan_file || 'PLAN_FINAL.md');
      try {
        await fs.writeFile(planPath, '');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Clear outbox files
      const outboxDir = path.join(workspacePath, config.outbox_dir || 'outbox');
      try {
        const files = await fs.readdir(outboxDir);
        for (const file of files) {
          if (file.endsWith('.md')) {
            await fs.writeFile(path.join(outboxDir, file), '');
          }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }

    // Reset state
    messageSequence = 0;
    agents = [];
    sessionBaseCommit = null;

    return { success: true };
  } catch (error) {
    console.error('Error resetting session:', error);
    return { success: false, error: error.message };
  }
});

// Handle start implementation request
ipcMain.handle('start-implementation', async (event, selectedAgent, otherAgents) => {
  try {
    // Get the implementation handoff prompt from config
    const promptTemplate = config.prompts?.implementation_handoff ||
      '{selected_agent}, please now implement this plan. {other_agents} please wait for confirmation from {selected_agent} that they have completed the implementation. You should then check the changes, and provide feedback if necessary. Keep iterating together until you are all happy with the implementation.';

    // Substitute placeholders
    const prompt = promptTemplate
      .replace(/{selected_agent}/g, selectedAgent)
      .replace(/{other_agents}/g, otherAgents.join(', '));

    // Send as user message (this handles chat log + delivery to all agents)
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
  // Add validation info for each workspace
  const withValidation = await Promise.all(
    recents.map(async (r) => ({
      ...r,
      exists: await validateWorkspacePath(r.path),
      name: path.basename(r.path)
    }))
  );
  return withValidation;
});

ipcMain.handle('add-recent-workspace', async (event, workspacePath) => {
  return await addRecentWorkspace(workspacePath);
});

ipcMain.handle('remove-recent-workspace', async (event, workspacePath) => {
  return await removeRecentWorkspace(workspacePath);
});

ipcMain.handle('update-recent-workspace-path', async (event, oldPath, newPath) => {
  return await updateRecentWorkspacePath(oldPath, newPath);
});

ipcMain.handle('validate-workspace-path', async (event, workspacePath) => {
  return await validateWorkspacePath(workspacePath);
});

ipcMain.handle('get-current-directory', async () => {
  return getCurrentDirectoryInfo();
});

ipcMain.handle('browse-for-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Workspace Directory'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return {
    canceled: false,
    path: result.filePaths[0]
  };
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

// App lifecycle
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

// Cleanup on quit
app.on('before-quit', () => {
  stopAllAgents();
});
