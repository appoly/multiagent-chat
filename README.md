# Multi-Agent Chat

An Electron app that enables multiple AI agents (Claude, Codex, etc.) to collaborate on challenges through a shared chat interface.

Uses your local installations of AI agents via command line. Bring your own API keys and configurations.

## Installation

### Global Install (Recommended)

```bash
npm i -g multiagent-chat
```

### From Source

```bash
git clone <repo>
cd multiagent-chat
npm install
npm start
```

## Usage

```bash
# Run in current directory (uses cwd as workspace)
multiagent-chat

# Specify workspace explicitly
multiagent-chat /path/to/project
multiagent-chat --workspace /path/to/project

# With custom config file
multiagent-chat --config /path/to/config.yaml

# Environment variables also work
WORKSPACE=/path/to/project multiagent-chat
```

## Configuration

On first run, a default config is created at `~/.multiagent-chat/config.yaml`.

```yaml
agents:
  - name: "Claude"
    command: "claude"
    args: ['--dangerously-skip-permissions']
    use_pty: true

  - name: "Codex"
    command: "codex"
    args: []
    use_pty: true
```

You can override with a project-local config using `--config /path/to/config.yaml`.

### Config Location

- **Global config**: `~/.multiagent-chat/config.yaml`
- **Recent workspaces**: `~/.multiagent-chat/recent-workspaces.json`

## How It Works

1. Select a workspace (project directory) or use current directory
2. Enter a challenge/topic for agents to discuss
3. Agents communicate via outbox files (messages delivered to their PTY)
4. Watch live collaboration in the chat panel
5. Final agreed plan written to `PLAN_FINAL.md` in the workspace
6. Optionally execute the plan -- other agents will review the implementation

## License

MIT
