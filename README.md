# Multi-Agent Chat Orchestrator

An Electron app that orchestrates multiple AI agents (Claude, Codex, Gemini, etc.) to collaborate on challenges through a shared chat interface.

Uses your local installations of AI agents via command line. Bring your own API keys and configurations.

## Installation

```bash
npm install
```

## Usage

```bash
npm start /path/to/project
```

## Configuration

Edit `config.yaml` to configure agents:

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

## How It Works

1. Enter a challenge/topic for agents to discuss
2. Agents communicate via outbox files (messages delivered to their PTY)
3. Watch live collaboration in the chat panel
4. Final agreed plan written to `PLAN_FINAL.md`
5. Optionally execute the plan -- other agents will review the implementation

## License

MIT
