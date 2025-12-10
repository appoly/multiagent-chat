#!/usr/bin/env python3
"""
Multi-Agent Orchestrator
A TUI application for coordinating multiple AI agents to collaborate on challenges.
"""

import asyncio
import os
import sys
import pty
import select
import re
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict
import subprocess
import threading
import time

import yaml
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal, VerticalScroll
from textual.widgets import (
    Header,
    Footer,
    TabbedContent,
    TabPane,
    TextArea,
    Input,
    Button,
    Static,
    Label,
    RichLog,
)
from textual.binding import Binding
from textual import events
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# Basic ANSI escape stripping (sufficient for TUI control codes we see)
ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-_]")


class AgentProcess:
    """Manages a single agent process"""

    def __init__(
        self,
        name: str,
        command: str,
        args: List[str],
        workspace: Path,
        use_pty: bool = False,
    ):
        self.name = name
        self.command = command
        self.args = args
        self.workspace = workspace
        self.use_pty = use_pty
        self.process: Optional[subprocess.Popen] = None
        self.output_buffer = []
        self.running = False
        self.output_queue = []
        self.reader_thread = None
        self.master_fd: Optional[int] = None

    def start(self) -> bool:
        """Start the agent process"""
        try:
            if self.use_pty:
                # Create a pseudo-TTY so TUI-based CLIs (e.g., Claude) will produce output
                master_fd, slave_fd = pty.openpty()
                self.master_fd = master_fd
                self.process = subprocess.Popen(
                    [self.command] + self.args,
                    cwd=self.workspace,
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    text=False,
                    bufsize=0,
                )
                # Parent should not keep the slave end open
                os.close(slave_fd)
            else:
                # Change to workspace directory
                self.process = subprocess.Popen(
                    [self.command] + self.args,
                    cwd=self.workspace,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.PIPE,
                    text=True,
                    bufsize=0,  # Unbuffered
                )
            self.running = True

            # Start output reader thread
            self.reader_thread = threading.Thread(target=self._read_output_thread, daemon=True)
            self.reader_thread.start()

            return True
        except Exception as e:
            self.output_buffer.append(f"Error starting {self.name}: {e}\n")
            self.output_queue.append(f"Error starting {self.name}: {e}\n")
            return False

    def _read_output_thread(self):
        """Thread to continuously read output"""
        try:
            if self.use_pty and self.master_fd is not None:
                self._read_from_pty()
            else:
                while self.running and self.process and self.process.stdout:
                    line = self.process.stdout.readline()
                    if line:
                        self._enqueue_output(line)
                    elif self.process.poll() is not None:
                        # Process ended
                        break
        except Exception as e:
            self.output_queue.append(f"Error reading output: {e}\n")
        finally:
            # Stop polling when the process ends or an error occurs
            self.running = False

    def _enqueue_output(self, text: str):
        """Add output to buffers"""
        self.output_queue.append(text)
        self.output_buffer.append(text)
        # Mirror to a log file for debugging purposes
        try:
            log_path = self.workspace / f"{self.name}.log"
            with open(log_path, "a") as f:
                f.write(text)
        except Exception:
            pass

    def _read_from_pty(self):
        """Read output from a PTY-backed process"""
        if self.master_fd is None:
            return

        while self.running:
            try:
                # Wait briefly for data to avoid busy-wait
                ready, _, _ = select.select([self.master_fd], [], [], 0.1)
                if not ready:
                    continue

                data = os.read(self.master_fd, 1024)
                if not data:
                    # EOF
                    break

                text = data.decode(errors="replace")
                self._enqueue_output(text)
            except Exception as e:
                self.output_queue.append(f"Error reading PTY output: {e}\n")
                break

    def send_input(self, text: str, close: bool = False):
        """Send input to the agent"""
        if self.use_pty and self.master_fd is not None:
            try:
                os.write(self.master_fd, (text + "\n").encode())
                # Do not close master fd; agents often need ongoing input in PTY mode
            except Exception as e:
                self.output_buffer.append(f"Error sending input (pty): {e}\n")
                self.output_queue.append(f"Error sending input (pty): {e}\n")
            return

        if self.process and self.process.stdin:
            try:
                self.process.stdin.write(text + "\n")
                self.process.stdin.flush()
                if close:
                    self.process.stdin.close()
            except Exception as e:
                self.output_buffer.append(f"Error sending input: {e}\n")
                self.output_queue.append(f"Error sending input: {e}\n")

    def read_output(self) -> str:
        """Read available output from the agent"""
        if self.output_queue:
            return self.output_queue.pop(0)
        return ""

    def stop(self):
        """Stop the agent process"""
        if self.process:
            self.running = False
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except Exception:
                self.process.kill()
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except Exception:
                pass
            self.master_fd = None


class ChatFileHandler(FileSystemEventHandler):
    """Handles CHAT.md file changes"""

    def __init__(self, callback):
        self.callback = callback

    def on_modified(self, event):
        if not event.is_directory and event.src_path.endswith("CHAT.md"):
            self.callback()


class AgentOutputLog(RichLog):
    """Custom log widget for agent output"""

    def __init__(self, agent_name: str, *args, **kwargs):
        # Disable markup/highlight so raw agent output (incl. ANSI) is shown verbatim
        kwargs.setdefault("markup", False)
        kwargs.setdefault("highlight", False)
        super().__init__(*args, **kwargs)
        self.agent_name = agent_name
        self.border_title = f"{agent_name} Output"


class ChatViewer(VerticalScroll):
    """Widget for viewing the CHAT.md file"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.border_title = "CHAT.md (Live)"

    def compose(self) -> ComposeResult:
        yield Static("", id="chat-content")

    def update_content(self, content: str):
        """Update the chat display"""
        try:
            chat_content = self.query_one("#chat-content", Static)
            chat_content.update(content)
            # Auto-scroll to bottom
            self.scroll_end(animate=False)
        except Exception:
            pass


class AgentTabsContainer(Container):
    """Container for agent tabs"""

    def __init__(self, agents: Dict[str, 'AgentProcess'], *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agents = agents

    def compose(self) -> ComposeResult:
        # Debug: print how many agents we have
        agent_names = list(self.agents.keys())
        print(f"Creating tabs for {len(agent_names)} agents: {agent_names}")

        with TabbedContent(id="agent-tabs"):
            for agent_name in agent_names:
                print(f"  Adding tab for: {agent_name}")
                with TabPane(agent_name, id=f"pane-{agent_name}"):
                    yield AgentOutputLog(agent_name, id=f"log-{agent_name}")


class ChallengeInputScreen(VerticalScroll):
    """Initial screen for entering the challenge"""

    def compose(self) -> ComposeResult:
        yield Static("=== Multi-Agent Orchestrator ===", id="title")
        yield Static("")
        yield Static("Enter your challenge:")
        yield Input(placeholder="e.g., Design a REST API for a blog platform", id="challenge-input")
        yield Static("")
        yield Static("Press Enter or click Start Session")
        yield Static("")
        yield Button("▶ Start Session", variant="primary", id="start-btn")
        yield Button("✕ Quit", variant="error", id="quit-btn")


class MultiAgentOrchestrator(App):
    """Main Textual application"""

    CSS = """
    ChallengeInputScreen {
        align: center middle;
        padding: 2;
    }

    #title {
        text-align: center;
        text-style: bold;
        padding: 1;
        background: $boost;
        width: 100%;
    }

    #challenge-input {
        width: 80;
        margin: 1;
    }

    #start-btn, #quit-btn {
        width: 30;
        margin: 1;
    }

    Static {
        text-align: center;
        width: 100%;
    }

    #chat-viewer {
        height: 40%;
        border: solid $primary;
    }

    #user-input-container {
        height: 3;
        border: solid $accent;
        padding: 0 1;
    }

    #user-message-input {
        width: 80%;
    }

    #send-btn {
        width: 20%;
    }

    TabbedContent {
        height: 55%;
    }

    AgentOutputLog {
        border: solid $secondary;
    }

    .status-bar {
        background: $panel;
        height: 3;
        padding: 1;
    }
    """

    # Bindings are defined in check_bindings() to be conditional
    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit", priority=True),
    ]

    def __init__(self):
        super().__init__()
        self.config = self.load_config()
        self.workspace = Path(self.config["workspace"])
        self.chat_file = self.workspace / self.config["chat_file"]
        self.plan_file = self.workspace / self.config["plan_file"]
        self.close_stdin_after_prompt = self.config.get("close_stdin_after_prompt", True)
        self.agents: Dict[str, AgentProcess] = {}
        self.observer: Optional[Observer] = None
        self.session_active = False
        self.challenge_text = ""

    def load_config(self) -> dict:
        """Load configuration from config.yaml"""
        config_path = Path("config.yaml")
        if not config_path.exists():
            self.exit(message="config.yaml not found!")
            return {}

        with open(config_path) as f:
            return yaml.safe_load(f)

    def compose(self) -> ComposeResult:
        """Create the UI layout"""
        yield Header()

        # If session is not active, show challenge input screen
        if not self.session_active:
            yield ChallengeInputScreen(id="challenge-screen")
        else:
            yield self.create_main_layout()

        yield Footer()

    def create_main_layout(self) -> Container:
        """Create the main application layout"""
        # Status bar
        status = Static(
            f"Workspace: {self.workspace} | Agents: {len(self.agents)}",
            classes="status-bar"
        )

        # Tabbed content for agent outputs
        agent_tabs = AgentTabsContainer(self.agents)

        # Chat viewer
        chat_viewer = ChatViewer(id="chat-viewer")

        # User input for sending messages to CHAT.md
        user_input = Horizontal(
            Input(placeholder="Type a message to send to CHAT.md...", id="user-message-input"),
            Button("Send", variant="primary", id="send-btn"),
            id="user-input-container",
        )

        return Container(status, agent_tabs, chat_viewer, user_input, id="main-container")

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button presses"""
        button_id = event.button.id
        self.notify(f"Button clicked: {button_id}")

        if button_id == "start-btn":
            await self.start_session()
        elif button_id == "quit-btn":
            self.exit()
        elif button_id == "send-btn":
            await self.send_user_message()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle input submission (Enter key in Input widget)"""
        if event.input.id == "user-message-input":
            await self.send_user_message()
        elif event.input.id == "challenge-input":
            # Start session when Enter is pressed in challenge input
            await self.start_session()

    async def on_key(self, event: events.Key) -> None:
        """Handle key presses"""
        if event.key == "ctrl+s":
            try:
                event.prevent_default()
                event.stop()
                if self.session_active:
                    await self.send_user_message()
                else:
                    await self.start_session()
            except Exception as e:
                self.notify(f"Error handling Ctrl+S: {e}", severity="error")

    async def start_session(self):
        """Start the multi-agent session"""
        try:
            self.notify("Starting session...")

            # Get challenge text
            challenge_input = self.query_one("#challenge-input", Input)
            self.challenge_text = challenge_input.value.strip()

            if not self.challenge_text:
                self.notify("Please enter a challenge!", severity="error")
                return

            self.notify(f"Challenge: {self.challenge_text[:50]}...")

            # Setup workspace
            self.setup_workspace()

            # Initialize agents
            self.initialize_agents()
            self.notify(f"Initialized {len(self.agents)} agents")

            # Mark session as active and rebuild UI
            self.session_active = True
            self.notify("Rebuilding UI...")
            await self.recompose()

            # Start file watcher
            self.notify("Starting file watcher...")
            self.start_file_watcher()

            # Start agents and send initial prompts
            self.notify("Starting agents...")
            await self.start_agents()

            self.notify("Session started successfully!")
        except Exception as e:
            self.notify(f"Error starting session: {e}", severity="error")
            import traceback
            traceback.print_exc()

    def setup_workspace(self):
        """Create workspace directory and files"""
        self.workspace.mkdir(exist_ok=True)

        # Create empty CHAT.md
        self.chat_file.write_text("")

        # Create empty PLAN_FINAL.md
        self.plan_file.write_text("")

        self.notify(f"Workspace created at {self.workspace}")

    def initialize_agents(self):
        """Initialize agent processes"""
        for agent_config in self.config["agents"]:
            # Default to PTY for known TUI CLIs (e.g., Claude) unless overridden
            use_pty = agent_config.get("use_pty")
            if use_pty is None:
                cmd_lower = str(agent_config.get("command", "")).lower()
                name_lower = str(agent_config.get("name", "")).lower()
                use_pty = cmd_lower == "claude" or name_lower == "claude"

            agent = AgentProcess(
                name=agent_config["name"],
                command=agent_config["command"],
                args=agent_config.get("args", []),
                workspace=self.workspace,
                use_pty=use_pty,
            )
            self.agents[agent.name] = agent

    async def start_agents(self):
        """Start all agent processes and send initial prompts"""
        agent_names = ", ".join([f'"{name}"' for name in self.agents.keys()])
        self.notify(f"Starting {len(self.agents)} agents: {agent_names}")

        for agent in self.agents.values():
            self.notify(f"Attempting to start {agent.name}...")
            success = agent.start()
            if success:
                self.notify(f"✓ Started {agent.name}")

                # Give the agent a moment to initialize
                await asyncio.sleep(1)

                # Send initial prompt
                prompt = self.config["prompt_template"].format(
                    challenge=self.challenge_text,
                    agent_names=agent_names,
                )
                self.notify(f"Sending prompt to {agent.name} ({len(prompt)} chars)")
                agent.send_input(prompt, close=self.close_stdin_after_prompt)

                # Start output reading task
                self.notify(f"Starting output reader for {agent.name}")
                asyncio.create_task(self.read_agent_output(agent))
            else:
                self.notify(f"✗ Failed to start {agent.name}", severity="error")

    def _sanitize_output(self, text: str) -> List[str]:
        """Strip ANSI/control codes and normalize lines for display"""
        cleaned = text.replace("\r", "\n")
        cleaned = ANSI_ESCAPE_RE.sub("", cleaned)
        cleaned = "".join(ch for ch in cleaned if ch.isprintable() or ch in "\n\t")
        lines = [line if line.strip() else " " for line in cleaned.splitlines()]
        return [line for line in lines if line is not None]

    async def read_agent_output(self, agent: AgentProcess):
        """Continuously read and display agent output"""
        try:
            log_widget = self.query_one(f"#log-{agent.name}", AgentOutputLog)
            log_widget.write(f"[{agent.name}] Starting output capture...")
        except Exception as e:
            self.notify(f"Could not find log widget for {agent.name}: {e}", severity="error")
            return

        output_count = 0
        while agent.running:
            try:
                output = agent.read_output()
                if output:
                    output_count += 1
                    for line in self._sanitize_output(output):
                        log_widget.write(line)
                    # Show we're getting output
                    if output_count % 10 == 0:
                        self.notify(f"{agent.name}: {output_count} lines received")
            except Exception as e:
                self.notify(f"Error reading {agent.name} output: {e}", severity="error")
                log_widget.write(f"ERROR: {e}")
            await asyncio.sleep(0.1)

        log_widget.write(f"[{agent.name}] Output capture stopped.")

    def start_file_watcher(self):
        """Start watching CHAT.md for changes"""
        event_handler = ChatFileHandler(self.on_chat_modified)
        self.observer = Observer()
        self.observer.schedule(event_handler, str(self.workspace), recursive=False)
        self.observer.start()

    def on_chat_modified(self):
        """Called when CHAT.md is modified"""
        if not self.chat_file.exists():
            return

        content = self.chat_file.read_text()

        try:
            chat_viewer = self.query_one("#chat-viewer", ChatViewer)
            chat_viewer.update_content(content)
        except Exception:
            # Widget might not be available yet
            pass

    async def send_user_message(self):
        """Send a user message to CHAT.md"""
        try:
            input_widget = self.query_one("#user-message-input", Input)
            message = input_widget.value.strip()

            if not message:
                return

            # Append to CHAT.md
            timestamp = datetime.now().strftime("%H:%M:%S")
            formatted_message = f"\n[User @ {timestamp}]: {message}\n"

            with open(self.chat_file, "a") as f:
                f.write(formatted_message)

            # Clear input
            input_widget.value = ""

            # Trigger update
            self.on_chat_modified()

            self.notify("Message sent to CHAT.md")
        except Exception as e:
            # Widget might not exist if session not started
            pass

    async def action_send_message(self):
        """Action to send message (Ctrl+S)"""
        await self.send_user_message()

    async def on_unmount(self):
        """Cleanup when app closes"""
        # Stop file watcher
        if self.observer:
            self.observer.stop()
            self.observer.join()

        # Stop all agents
        for agent in self.agents.values():
            agent.stop()


def main():
    """Entry point"""
    app = MultiAgentOrchestrator()
    app.run()


if __name__ == "__main__":
    main()
