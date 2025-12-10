# Multi-Agent Chat Orchestrator

An Electron-based application that orchestrates multiple AI agents to collaborate on programming challenges in real-time through a shared chat interface.

## Overview

This application enables multiple AI agents (like Claude, GitHub Copilot, etc.) to work together by:
- Communicating through a shared `CHAT.md` file
- Discussing approaches and challenging each other's ideas
- Reaching consensus on solutions
- Producing a final implementation plan in `PLAN_FINAL.md`

**Why Electron?** The original TUI implementation had issues embedding TUI-based agents (like Claude Code) within another TUI. This Electron version provides a native GUI that cleanly separates agent processes from the UI.

## Features

- 🖥️ **Modern Electron UI** - Clean, responsive interface with tabbed agent outputs
- 💬 **Live Chat Monitoring** - See agents collaborate in real-time
- 🤖 **Multi-Agent Support** - Run multiple AI agents simultaneously
- 👤 **User Intervention** - Send messages to guide agent discussion
- 📋 **Final Plan Viewer** - See the agreed-upon solution
- 🧪 **Mock Agents** - Test without real AI agents using built-in mock agents

## Installation

```bash
# Install dependencies
npm install
```

## Configuration

Edit `config.yaml` to configure your agents:

```yaml
agents:
  - name: "Claude"
    command: "claude"
    args: ['--dangerously-skip-permissions']
    use_pty: true

  - name: "Copilot"
    command: "gh"
    args: ["copilot", "chat"]
    use_pty: false
```

### Configuration Options

- **name**: Display name for the agent
- **command**: CLI command to start the agent
- **args**: Command-line arguments (array)
- **use_pty**: Set to `true` for interactive TUI agents (like Claude Code)

## Usage

### Run with Real Agents

```bash
npm start
```

### Run with Mock Agents (Testing)

```bash
npm test
# or manually:
cp config.test.yaml config.yaml && npm start
```

### Using the Application

1. **Enter a Challenge**: Type or paste your programming challenge
2. **Start Collaboration**: Click "Start Collaboration" to launch agents
3. **Monitor Progress**:
   - Watch agent outputs in the left panel (tabbed view)
   - See live chat discussion in the top-right panel
   - Send messages to agents via the message input
4. **View Final Plan**: Check the bottom-right panel for the final agreed plan

## How It Works

### Architecture

```
Electron App (main.js)
    ↓
Spawns Agent Processes
    ↓
Agents Read/Write CHAT.md
    ↓
File Watcher Detects Changes
    ↓
UI Updates in Real-Time
```

### Agent Communication Protocol

1. Each agent receives the initial challenge via stdin
2. Agents read `CHAT.md` periodically to see messages from others
3. Agents append their messages to `CHAT.md` (never overwrite)
4. One agent eventually writes the final plan to `PLAN_FINAL.md`

### Message Format

Agents should write messages in this format:
```
[AgentName @ timestamp]: Message content here...
```

## Mock Agents

The included `mock-agent.js` simulates three AI agent personalities:

- **Claude**: Analytical and thorough, focuses on architecture
- **Codex**: Practical and code-focused, focuses on implementation
- **Gemini**: Creative and explorative, focuses on innovation

Perfect for testing the orchestrator without real AI CLI tools.

## Development

### Project Structure

```
.
├── main.js              # Electron main process (orchestration logic)
├── preload.js          # Security bridge between main and renderer
├── renderer.js         # Client-side UI logic
├── index.html          # UI layout
├── styles.css          # UI styling
├── mock-agent.js       # Mock agent for testing
├── config.yaml         # Production configuration
├── config.test.yaml    # Test configuration (mock agents)
└── workspace/          # Created at runtime
    ├── CHAT.md         # Agent collaboration chat
    └── PLAN_FINAL.md   # Final solution plan
```

### IPC Communication

Main process exposes these methods to renderer:
- `loadConfig()` - Load configuration
- `startSession(challenge)` - Start agent collaboration
- `sendUserMessage(message)` - Send user message to chat
- `getChatContent()` - Get current chat content
- `getPlanContent()` - Get final plan content
- `stopAgents()` - Stop all running agents

Events sent to renderer:
- `agent-output` - Agent stdout/stderr output
- `agent-status` - Agent status changes (running/stopped/error)
- `chat-updated` - CHAT.md file changed

## Keyboard Shortcuts

- **Cmd/Ctrl+Enter** - Submit challenge (on challenge screen)
- **Shift+Enter** - Send message to agents (on session screen)

## Troubleshooting

### Agents Not Starting

- Verify the command and args in `config.yaml`
- Check that the agent CLI is installed and in PATH
- Look at console output for error messages

### Chat Not Updating

- Ensure agents have write access to workspace directory
- Check that agents are appending (not overwriting) CHAT.md
- Verify file watcher is running (check console)

### UI Not Displaying Output

- Open DevTools (View → Toggle Developer Tools)
- Check for JavaScript errors in console
- Verify IPC communication is working

## Creating Custom Agents

To create your own agent compatible with this orchestrator:

1. Accept the initial prompt via stdin
2. Parse the prompt to find workspace directory and file names
3. Read `CHAT.md` periodically for new messages
4. Append messages to `CHAT.md` (don't overwrite!)
5. Optionally write final plan to `PLAN_FINAL.md`

See `mock-agent.js` for a reference implementation.

### Example Custom Agent (Node.js)

```javascript
#!/usr/bin/env node
const fs = require('fs').promises;
const readline = require('readline');

async function main() {
  // Read initial prompt from stdin
  const prompt = await readStdin();
  console.error('Received challenge:', prompt.substring(0, 50) + '...');

  // Main loop
  while (true) {
    await sleep(5000);

    // Read current chat
    const chat = await fs.readFile('CHAT.md', 'utf8');

    // Generate response based on chat content
    const response = analyzeAndRespond(chat);

    // Append to chat
    const timestamp = new Date().toLocaleTimeString();
    await fs.appendFile('CHAT.md', `\n\n[MyAgent @ ${timestamp}]: ${response}\n`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
```

## Tips for Best Results

1. **Clear Challenges**: Provide specific, well-defined challenges
2. **Let Them Discuss**: Don't interrupt too early - agents need time to converge
3. **Guide When Needed**: If they're going off-track, inject a guiding message
4. **Encourage Disagreement**: The config template tells them not to be too agreeable - this leads to better solutions
5. **Monitor Both Views**: Watch individual agent tabs AND the chat viewer to see both thinking and collaboration

## Migrating from Python TUI Version

If you were using the old Python TUI version:
- The core functionality remains the same
- Agent configuration format is unchanged
- `config.yaml` is fully compatible
- Install Node.js dependencies instead of Python: `npm install`
- Run with `npm start` instead of `python orchestrator.py`

## Contributing

Improvements welcome:
- Better error handling
- Agent state management
- Session recording/replay
- Multiple workspace support
- PTY support improvements for TUI agents

## License

MIT License - feel free to modify and extend!

## FAQ

**Q: Can I use this with non-AI agents?**
A: Yes! Any program that can read stdin and write to files can participate.

**Q: What if agents have different working directories?**
A: All agents are started with `cwd` set to the workspace, ensuring they see the same files.

**Q: Can I save sessions?**
A: Currently, the workspace directory persists. You can copy it to save a session.

**Q: How do I stop the session?**
A: Click "Stop All Agents" button or close the application window.

**Q: Can agents see each other's output tabs?**
A: No - agents can only communicate via CHAT.md (by design). This forces explicit collaboration.

**Q: Why Electron instead of a web app?**
A: Electron provides native process management, file system access, and a clean separation between agent processes and the UI.
