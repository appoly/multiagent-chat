# Multi-Agent Orchestrator

A terminal-based orchestrator for coordinating multiple AI agents (Claude, Codex, Gemini, etc.) to collaborate on programming challenges through a shared CHAT.md file.

## Overview

This tool allows you to:
- Run multiple AI agents simultaneously
- Have them discuss and collaborate via a shared CHAT.md file
- Monitor each agent's output in separate tabs
- Inject messages into their conversation
- Watch them converge on a solution in real-time

## Features

- **Tabbed Interface**: Separate views for each agent's output
- **Live Chat Viewer**: Real-time updates of CHAT.md conversations
- **Auto-spawning**: Automatically starts all configured agents
- **Prompt Injection**: Send the same challenge to all agents automatically
- **User Participation**: Send messages to CHAT.md to guide the conversation
- **File Watching**: Automatic updates when agents modify CHAT.md

## Installation

1. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Configure your agents** in `config.yaml`:
   ```yaml
   agents:
     - name: "Claude"
       command: "claude"  # Replace with actual command
       args: ['dangerously-skip-permissions']

     - name: "Codex"
       command: "codex"  # Replace with actual command
       args: []
   ```

   **Important**: Update the `command` field for each agent with the actual CLI command to start them.

## Configuration

Edit `config.yaml` to customize:

### Agent Setup
```yaml
agents:
  - name: "AgentName"      # Display name in UI
    command: "command"      # CLI command to start agent
    args: []                # Optional arguments
```

### Workspace Settings
```yaml
workspace: "./workspace"   # Where CHAT.md and PLAN_FINAL.md are created
chat_file: "CHAT.md"       # Chat file name
plan_file: "PLAN_FINAL.md" # Final plan file name
```

### Prompt Template
Customize the initial prompt sent to each agent. Use placeholders:
- `{challenge}`: Your challenge text
- `{agent_names}`: Comma-separated list of all agent names

## Usage

### Basic Usage

1. **Start the orchestrator**:
   ```bash
   python orchestrator.py
   ```

2. **Enter your challenge** in the text area (e.g., "Design a caching system for a web API")

3. **Click "Start Session"** or press Enter

4. **Monitor the conversation**:
   - Each agent's output appears in its own tab
   - The CHAT.md viewer shows their collaboration in real-time
   - Watch as they discuss, challenge each other, and converge on a solution

5. **Participate** by typing messages in the input box at the bottom and clicking "Send" (or Ctrl+S)

### Keyboard Shortcuts

- `Ctrl+C`: Quit the application
- `Ctrl+S`: Send your typed message to CHAT.md
- `Tab`: Switch between UI elements

### Example Workflow

1. Start the app
2. Enter challenge: "Implement a rate limiter for an API"
3. Click "Start Session"
4. Agents automatically receive the prompt and start working
5. They begin discussing in CHAT.md
6. You can inject guidance: "Consider both token bucket and sliding window approaches"
7. Agents refine their discussion
8. They decide on a final solution and one writes to PLAN_FINAL.md

## Project Structure

```
multiagent-chat/
├── orchestrator.py      # Main application
├── config.yaml          # Configuration file
├── requirements.txt     # Python dependencies
├── README.md           # This file
└── workspace/          # Created at runtime
    ├── CHAT.md         # Agents' conversation
    └── PLAN_FINAL.md   # Final agreed solution
```

## How It Works

1. **Initialization**:
   - Creates workspace directory
   - Initializes empty CHAT.md and PLAN_FINAL.md files

2. **Agent Spawning**:
   - Spawns each configured agent as a subprocess
   - Sets their working directory to the workspace
   - Captures their stdout/stderr for display

3. **Prompt Distribution**:
   - Sends the formatted prompt to each agent via stdin
   - Includes challenge text and collaboration instructions

4. **Monitoring**:
   - File watcher monitors CHAT.md for changes
   - Agent output is continuously captured and displayed
   - UI updates in real-time

5. **Collaboration Flow**:
   - Agents read CHAT.md to see others' messages
   - Agents append their thoughts to CHAT.md
   - Once agreed, one agent writes final plan to PLAN_FINAL.md

## Troubleshooting

### Agents Not Starting

**Problem**: "Error starting [Agent]" message

**Solutions**:
- Verify the `command` in `config.yaml` is correct
- Test the command manually in terminal: `which claude` or `which codex`
- Ensure the agent CLI is installed and in your PATH
- Check that you have proper permissions/authentication

### No Output in Agent Tabs

**Problem**: Agent tab is blank

**Solutions**:
- Check if the agent requires interactive terminal (TTY)
- Some agents might need specific environment variables
- Try running the agent manually to see its requirements

### CHAT.md Not Updating

**Problem**: Chat viewer doesn't show updates

**Solutions**:
- Verify the agents are actually writing to CHAT.md (check the file directly)
- Ensure agents are appending (not overwriting) the file
- Check file permissions in the workspace directory

### Agent Commands

Different agents have different CLI interfaces. Here are examples:

**Claude Code**:
```yaml
- name: "Claude"
  command: "claude"
  args: []
```

**GitHub Copilot CLI** (if available):
```yaml
- name: "Copilot"
  command: "gh"
  args: ["copilot", "chat"]
```

**Custom Python Agent**:
```yaml
- name: "MyAgent"
  command: "python"
  args: ["path/to/agent.py"]
```

## Customization

### Modifying the Prompt Template

Edit the `prompt_template` in `config.yaml` to change how agents are instructed. The template supports:
- Markdown formatting
- Multi-line text
- Placeholders: `{challenge}`, `{agent_names}`

### Adding More Agents

Simply add more entries to the `agents` list in `config.yaml`:

```yaml
agents:
  - name: "Claude"
    command: "claude"
    args: []

  - name: "Codex"
    command: "codex"
    args: []

  - name: "Gemini"
    command: "gemini"
    args: []

  - name: "CustomAgent"
    command: "python"
    args: ["my_agent.py"]
```

### Styling

The UI is styled using Textual CSS in `orchestrator.py`. To customize colors, sizes, or layout, edit the `CSS` property in the `MultiAgentOrchestrator` class.

## Advanced Usage

### Monitoring Files Directly

While the app is running, you can also monitor the workspace files directly:

```bash
# Watch CHAT.md in real-time
tail -f workspace/CHAT.md

# Check final plan
cat workspace/PLAN_FINAL.md
```

### Using with Different Agent Types

This orchestrator is agent-agnostic. As long as an agent can:
1. Accept input via stdin
2. Read/write files in its working directory
3. Run as a CLI command

...it can participate in the collaboration.

### Creating Custom Agents

You can create simple Python agents that follow the protocol:

```python
#!/usr/bin/env python3
import sys
import time
from pathlib import Path

def main():
    # Read initial prompt
    prompt = sys.stdin.read()
    print(f"Received challenge: {prompt[:50]}...")

    # Access CHAT.md
    chat_file = Path("CHAT.md")

    # Participate in conversation
    while True:
        # Read chat
        if chat_file.exists():
            content = chat_file.read_text()
            # Analyze and respond...

        # Append your message
        with open(chat_file, "a") as f:
            f.write(f"\n[MyAgent]: My thoughts...\n")

        time.sleep(10)

if __name__ == "__main__":
    main()
```

## Tips for Best Results

1. **Clear Challenges**: Provide specific, well-defined challenges
2. **Let Them Discuss**: Don't interrupt too early - agents need time to converge
3. **Guide When Needed**: If they're going off-track, inject a guiding message
4. **Encourage Disagreement**: The config template tells them not to be too agreeable - this leads to better solutions
5. **Monitor Both Views**: Watch individual agent tabs AND the chat viewer to see both thinking and collaboration

## Contributing

This is a POC (Proof of Concept). Improvements welcome:
- Better error handling
- Agent state management
- Session recording/replay
- Multiple workspace support
- Web-based UI alternative

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
A: Press `Ctrl+C` to quit. All agent processes will be terminated gracefully.

**Q: Can agents see each other's output tabs?**
A: No - agents can only communicate via CHAT.md (by design). This forces explicit collaboration.
