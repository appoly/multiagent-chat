#!/usr/bin/env python3
"""
Mock AI Agent for Testing the Multi-Agent Orchestrator

This simulates an AI agent that:
1. Reads the initial prompt from stdin
2. Periodically reads CHAT.md
3. Responds with simulated thinking and messages
4. Eventually contributes to PLAN_FINAL.md

Usage:
    python mock_agent.py <agent_name>

Example:
    python mock_agent.py Claude
"""

import sys
import time
import random
from pathlib import Path
from datetime import datetime


class MockAgent:
    def __init__(self, name: str):
        self.name = name
        self.chat_file = Path("CHAT.md")
        self.plan_file = Path("PLAN_FINAL.md")
        self.last_chat_content = ""
        self.message_count = 0
        self.has_proposed_plan = False

        # Different personalities for variety
        self.personalities = {
            "Claude": {
                "style": "analytical and thorough",
                "responses": [
                    "I think we should consider the architectural implications...",
                    "Let me break this down into components:",
                    "What about edge cases like...",
                    "I agree, but we should also validate...",
                ],
            },
            "Codex": {
                "style": "practical and code-focused",
                "responses": [
                    "Here's how I'd implement that:",
                    "We could use a pattern like...",
                    "From a performance standpoint...",
                    "Let me prototype this approach:",
                ],
            },
            "Gemini": {
                "style": "creative and questioning",
                "responses": [
                    "What if we approached it from a different angle?",
                    "I'm seeing some alternatives here...",
                    "Could we simplify this by...",
                    "Let's challenge that assumption:",
                ],
            },
        }

        self.personality = self.personalities.get(
            name, self.personalities["Claude"]
        )

    def log(self, message: str):
        """Log to stdout (visible in agent's tab)"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {message}", flush=True)

    def read_prompt(self):
        """Read initial prompt from stdin"""
        self.log(f"{self.name} agent starting...")
        self.log("Waiting for challenge prompt...")

        # Read all input (the initial prompt)
        prompt = sys.stdin.read()

        self.log(f"Received prompt ({len(prompt)} chars)")
        self.log(f"Challenge preview: {prompt[:100]}...")
        return prompt

    def read_chat(self) -> str:
        """Read current CHAT.md content"""
        if not self.chat_file.exists():
            return ""
        return self.chat_file.read_text()

    def append_to_chat(self, message: str):
        """Append a message to CHAT.md"""
        with open(self.chat_file, "a") as f:
            f.write(f"\n[{self.name}]: {message}\n")
        self.log(f"Posted to CHAT.md: {message[:50]}...")

    def analyze_chat(self, content: str) -> dict:
        """Analyze the chat content"""
        lines = content.strip().split("\n")
        messages = [
            line for line in lines if line.startswith("[") and "]: " in line
        ]

        return {
            "total_messages": len(messages),
            "my_messages": len([m for m in messages if m.startswith(f"[{self.name}]")]),
            "other_messages": len([m for m in messages if not m.startswith(f"[{self.name}]")]),
            "has_user_messages": any("[User" in m for m in messages),
        }

    def generate_response(self, analysis: dict) -> str:
        """Generate a contextual response"""
        # First message: introduce self
        if self.message_count == 0:
            return f"Hello! I'm {self.name}. I'll analyze this challenge from a {self.personality['style']} perspective. Let me start by examining the requirements..."

        # Second message: provide initial thoughts
        if self.message_count == 1:
            return random.choice(self.personality["responses"]) + "\n\n1. We need to define clear requirements\n2. Consider scalability\n3. Think about maintainability"

        # Third message: respond to others
        if self.message_count == 2 and analysis["other_messages"] > 0:
            return "I see your points. " + random.choice(self.personality["responses"]) + " Let's make sure we're aligned on the core approach."

        # Fourth message: propose or agree on solution
        if self.message_count == 3:
            if not self.has_proposed_plan:
                return "I think we're converging on a solid solution. Shall I draft the final plan, or would one of you like to do it?"
            else:
                return "I agree with the proposed approach. Let's finalize it."

        # Later messages: shorter confirmations
        return random.choice([
            "Agreed.",
            "That makes sense.",
            "Good point!",
            "Let's go with that approach.",
            "I'll defer to your expertise on this.",
        ])

    def write_plan(self, challenge: str):
        """Write a final plan to PLAN_FINAL.md"""
        plan = f"""# Final Solution Plan

**Challenge**: {challenge[:200]}...

**Agreed Approach**:

## Architecture
1. Modular design with clear separation of concerns
2. Scalable components
3. Well-defined interfaces

## Implementation Steps
1. Set up project structure
2. Implement core functionality
3. Add error handling and validation
4. Write comprehensive tests
5. Document the solution

## Key Decisions
- Prioritize simplicity and maintainability
- Use industry-standard patterns
- Ensure extensibility for future requirements

## Testing Strategy
- Unit tests for individual components
- Integration tests for workflows
- Edge case coverage

**Collaborators**: {self.name} and team

**Status**: Ready for implementation

---
*This plan was collaboratively developed by multiple AI agents*
"""
        with open(self.plan_file, "w") as f:
            f.write(plan)

        self.log("Wrote final plan to PLAN_FINAL.md")
        self.append_to_chat("I've written our agreed solution to PLAN_FINAL.md. Please review!")

    def run(self):
        """Main agent loop"""
        # Read initial prompt
        prompt = self.read_prompt()

        # Extract challenge from prompt (it's before the instructions)
        challenge = prompt.split("I have another agent")[0].strip()

        self.log("Starting collaboration loop...")
        self.log("Monitoring CHAT.md for updates...")

        # Main loop
        while True:
            time.sleep(random.uniform(3, 7))  # Random delay to seem natural

            # Read current chat
            current_chat = self.read_chat()

            # Check if there are new messages
            if current_chat != self.last_chat_content:
                analysis = self.analyze_chat(current_chat)

                self.log(
                    f"Chat update detected. Messages: {analysis['total_messages']} "
                    f"(mine: {analysis['my_messages']}, others: {analysis['other_messages']})"
                )

                # Decide if we should respond
                should_respond = (
                    self.message_count < 4  # Always respond for first few messages
                    or analysis["other_messages"] > analysis["my_messages"]  # Others are more active
                    or random.random() < 0.3  # Random chance
                )

                if should_respond:
                    # Wait a bit to simulate thinking
                    think_time = random.uniform(2, 5)
                    self.log(f"Thinking... ({think_time:.1f}s)")
                    time.sleep(think_time)

                    # Generate and post response
                    response = self.generate_response(analysis)
                    self.append_to_chat(response)
                    self.message_count += 1

                    # After 4+ messages, consider writing the plan
                    if (
                        self.message_count >= 4
                        and not self.has_proposed_plan
                        and not self.plan_file.exists()
                        and random.random() < 0.5
                    ):
                        self.log("Proposing to write final plan...")
                        time.sleep(3)
                        self.write_plan(challenge)
                        self.has_proposed_plan = True

                self.last_chat_content = current_chat
            else:
                self.log("No new messages, waiting...")

            # If plan exists and we've contributed enough, slow down
            if self.plan_file.exists() and self.message_count >= 5:
                self.log("Plan finalized. Entering idle mode...")
                time.sleep(30)


def main():
    if len(sys.argv) < 2:
        print("Usage: python mock_agent.py <agent_name>")
        sys.exit(1)

    agent_name = sys.argv[1]
    agent = MockAgent(agent_name)

    try:
        agent.run()
    except KeyboardInterrupt:
        agent.log("Shutting down...")
    except Exception as e:
        agent.log(f"Error: {e}")
        raise


if __name__ == "__main__":
    main()
