const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const yaml = require('yaml');
const chokidar = require('chokidar');

let mainWindow;
let agents = [];
let config;
let workspacePath;
let fileWatcher;
let customWorkspacePath = null;

// Parse command-line arguments
// Usage: npm start /path/to/workspace
// Or: WORKSPACE=/path/to/workspace npm start
function parseCommandLineArgs() {
  // Check environment variable first
  if (process.env.WORKSPACE) {
    customWorkspacePath = process.env.WORKSPACE;
    console.log('Using workspace from environment variable:', customWorkspacePath);
    return;
  }

  // Then check command-line arguments
  // process.argv looks like: [electron, main.js, ...args]
  const args = process.argv.slice(2);

  // Look for --workspace flag or just a path
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      customWorkspacePath = args[i + 1];
      console.log('Using workspace from --workspace flag:', customWorkspacePath);
      return;
    } else if (!args[i].startsWith('--') && !args[i].includes('config')) {
      // Assume it's a workspace path if it doesn't start with -- and isn't a config file
      customWorkspacePath = args[i];
      console.log('Using workspace from command-line argument:', customWorkspacePath);
      return;
    }
  }
}

// Strip ANSI escape codes for cleaner display
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
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

// Load configuration
async function loadConfig(configPath = 'config.yaml') {
  try {
    // Resolve config path relative to app directory
    const fullPath = path.join(__dirname, configPath);
    console.log('Loading config from:', fullPath);
    const configFile = await fs.readFile(fullPath, 'utf8');
    config = yaml.parse(configFile);
    console.log('Config loaded successfully:', config);
    return config;
  } catch (error) {
    console.error('Error loading config:', error);
    throw error;
  }
}

// Setup workspace directory and files
async function setupWorkspace(customPath = null) {
  // Use custom path if provided, otherwise use config, otherwise default to ./workspace
  if (customPath && path.isAbsolute(customPath)) {
    workspacePath = customPath;
  } else if (customPath) {
    workspacePath = path.join(process.cwd(), customPath);
  } else {
    workspacePath = path.join(__dirname, config.workspace || 'workspace');
  }

  try {
    await fs.mkdir(workspacePath, { recursive: true });

    // Initialize CHAT.md
    const chatPath = path.join(workspacePath, config.chat_file || 'CHAT.md');
    await fs.writeFile(chatPath, '# Agent Collaboration Chat\n\n');

    // Clear PLAN_FINAL.md if it exists
    const planPath = path.join(workspacePath, config.plan_file || 'PLAN_FINAL.md');
    await fs.writeFile(planPath, '');

    console.log('Workspace setup complete:', workspacePath);
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
        // Use PTY for interactive TUI agents like Claude
        const shell = process.env.SHELL || '/bin/bash';

        this.process = pty.spawn(this.command, this.args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: workspacePath,
          env: {
            ...process.env,
            AGENT_NAME: this.name,
            TERM: 'xterm-256color',
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SHELL: shell,
            // Disable terminal capability detection
            LINES: '40',
            COLUMNS: '120'
          },
          // Handle window size
          handleFlowControl: true
        });

        console.log(`PTY spawned for ${this.name}, PID: ${this.process.pid}`);

        // Respond to cursor position query immediately
        // This helps with terminal capability detection
        setTimeout(() => {
          this.process.write('\x1b[1;1R'); // Report cursor at position 1,1
        }, 100);

        // Capture all output from PTY
        this.process.onData((data) => {
          const output = data.toString();
          this.outputBuffer.push(output);

          // Send raw output to renderer for xterm to handle
          if (mainWindow) {
            mainWindow.webContents.send('agent-output', {
              agentName: this.name,
              output: output,
              isPty: true
            });
          }
        });

        // Handle exit
        this.process.onExit(({ exitCode, signal }) => {
          console.log(`Agent ${this.name} exited with code ${exitCode}, signal ${signal}`);
          if (mainWindow) {
            mainWindow.webContents.send('agent-status', {
              agentName: this.name,
              status: 'stopped',
              exitCode: exitCode
            });
          }
        });

        // Send initial prompt after a longer delay to let agent initialize
        // Longer delay for agents that need to query terminal capabilities
        const initDelay = this.name === 'Codex' ? 5000 : 3000;

        setTimeout(() => {
          this.process.write(prompt + '\n');

          // Wait a moment and send Enter to confirm the paste
          setTimeout(() => {
            this.process.write('\r'); // Send Enter key
          }, 500);

          resolve();
        }, initDelay);

      } else {
        // Use regular spawn for non-interactive agents
        const options = {
          cwd: workspacePath,
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

          // Send to renderer
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

        // Handle process exit
        this.process.on('close', (code) => {
          console.log(`Agent ${this.name} exited with code ${code}`);
          if (mainWindow) {
            mainWindow.webContents.send('agent-status', {
              agentName: this.name,
              status: 'stopped',
              exitCode: code
            });
          }
        });

        // Handle errors
        this.process.on('error', (error) => {
          console.error(`Error starting agent ${this.name}:`, error);
          reject(error);
        });

        // Send initial prompt after a brief delay
        setTimeout(() => {
          if (this.process && this.process.stdin) {
            this.process.stdin.write(prompt + '\n');
          }
          resolve();
        }, 500);
      }
    });
  }

  sendMessage(message) {
    if (this.use_pty) {
      if (this.process && this.process.write) {
        this.process.write(message + '\n');
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

// Start all agents with the initial prompt
async function startAgents(challenge) {
  const prompt = config.prompt_template
    .replace('{challenge}', challenge)
    .replace('{workspace}', workspacePath)
    .replace('{chat_file}', config.chat_file || 'CHAT.md')
    .replace('{plan_file}', config.plan_file || 'PLAN_FINAL.md')
    .replace('{agent_names}', agents.map(a => a.name).join(', '));

  console.log('Starting agents with prompt...');

  for (const agent of agents) {
    try {
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

// Watch CHAT.md for changes
function startFileWatcher() {
  const chatPath = path.join(workspacePath, config.chat_file || 'CHAT.md');

  fileWatcher = chokidar.watch(chatPath, {
    persistent: true,
    ignoreInitial: true
  });

  fileWatcher.on('change', async () => {
    try {
      const content = await fs.readFile(chatPath, 'utf8');
      if (mainWindow) {
        mainWindow.webContents.send('chat-updated', content);
      }
    } catch (error) {
      console.error('Error reading chat file:', error);
    }
  });

  console.log('File watcher started for:', chatPath);
}

// Append user message to CHAT.md
async function sendUserMessage(message) {
  const chatPath = path.join(workspacePath, config.chat_file || 'CHAT.md');
  const timestamp = new Date().toLocaleTimeString();
  const formattedMessage = `\n\n[User @ ${timestamp}]: ${message}\n`;

  try {
    await fs.appendFile(chatPath, formattedMessage);
    console.log('User message appended to chat');
  } catch (error) {
    console.error('Error appending user message:', error);
    throw error;
  }
}

// Read current chat content
async function getChatContent() {
  const chatPath = path.join(workspacePath, config.chat_file || 'CHAT.md');
  try {
    return await fs.readFile(chatPath, 'utf8');
  } catch (error) {
    console.error('Error reading chat:', error);
    return '';
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

// Stop all agents
function stopAllAgents() {
  agents.forEach(agent => agent.stop());
  if (fileWatcher) {
    fileWatcher.close();
  }
}

// IPC Handlers
ipcMain.handle('load-config', async () => {
  try {
    console.log('IPC: load-config called');
    await loadConfig();
    console.log('IPC: load-config returning:', config);
    return config;
  } catch (error) {
    console.error('IPC: load-config error:', error);
    throw error;
  }
});

ipcMain.handle('start-session', async (event, challenge) => {
  try {
    await setupWorkspace(customWorkspacePath);
    initializeAgents();
    await startAgents(challenge);
    startFileWatcher();

    return {
      success: true,
      agents: agents.map(a => ({ name: a.name, use_pty: a.use_pty })),
      workspace: workspacePath
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

ipcMain.handle('stop-agents', async () => {
  stopAllAgents();
  return { success: true };
});

// App lifecycle
app.whenReady().then(() => {
  console.log('App ready, creating window...');
  parseCommandLineArgs();
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
