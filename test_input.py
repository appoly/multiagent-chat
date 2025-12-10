#!/usr/bin/env python3
"""
Simple test to verify Input widget Enter key behavior
"""

from textual.app import App, ComposeResult
from textual.widgets import Input, Static, Header, Footer
from textual.containers import Container


class TestInputApp(App):
    """Test app for input"""

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Type a message and press Enter:", id="instructions")
        yield Input(placeholder="Type here and press Enter...", id="test-input")
        yield Static("Messages will appear here:", id="output")
        yield Footer()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle Enter key"""
        message = event.value
        output = self.query_one("#output", Static)
        output.update(f"You sent: {message}")
        event.input.value = ""  # Clear input


if __name__ == "__main__":
    app = TestInputApp()
    app.run()
