#!/bin/bash
# Quick test script to run the orchestrator with mock agents

echo "Multi-Agent Orchestrator - Test Mode"
echo "===================================="
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is not installed"
    exit 1
fi

# Check if dependencies are installed
if ! python3 -c "import textual" 2> /dev/null; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
fi

# Use test config
if [ ! -f "config.yaml" ]; then
    echo "Setting up test configuration..."
    cp config.test.yaml config.yaml
    echo "✓ Created config.yaml from config.test.yaml"
fi

# Make mock_agent.py executable
chmod +x mock_agent.py

echo ""
echo "Starting orchestrator with mock agents..."
echo "This will simulate Claude, Codex, and Gemini collaborating."
echo ""
echo "Tips:"
echo "  - Enter a challenge like: 'Design a REST API for a todo app'"
echo "  - Watch the agents discuss in real-time"
echo "  - Send messages to guide them using the input box"
echo "  - Press Ctrl+C to quit"
echo ""
echo "Starting in 3 seconds..."
sleep 3

python3 orchestrator.py
