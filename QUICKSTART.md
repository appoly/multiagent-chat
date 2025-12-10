# Quick Start Guide

Get the Multi-Agent Orchestrator running in under 2 minutes!

## Option 1: Test with Mock Agents (Recommended for First Run)

This lets you see the orchestrator in action without needing real AI agent CLIs installed.

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Run the test script
./test.sh
```

Or manually:
```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Copy test config
cp config.test.yaml config.yaml

# 3. Run orchestrator
python orchestrator.py
```

Then:
1. Enter a challenge like: **"Design a caching system for a web API"**
2. Click "Start Session"
3. Watch three mock agents (Claude, Codex, Gemini) discuss the problem
4. Send messages to guide them using the input box at the bottom
5. See them converge on a solution and write to `PLAN_FINAL.md`

## Option 2: Use Real AI Agents

If you have Claude, Codex, or other AI agent CLIs installed:

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Edit config.yaml with your actual agent commands
# For example:
#   agents:
#     - name: "Claude"
#       command: "claude"  # or whatever your CLI command is
#       args: []

# 3. Run orchestrator
python orchestrator.py
```

## What to Expect

### Initial Screen
- Text area to enter your challenge
- "Start Session" button

### After Starting
- **Tabbed view**: Each tab shows one agent's output
- **CHAT.md viewer**: Live feed of agent conversation (bottom half)
- **Input box**: Send messages to agents (very bottom)
- **Status bar**: Shows workspace location and agent count

### Typical Flow (with mock agents)
1. Agents introduce themselves (~5 seconds)
2. First agent shares initial thoughts (~10 seconds)
3. Other agents respond and discuss (~15-30 seconds)
4. They challenge each other's ideas
5. They converge on an approach
6. One agent writes the final plan to `PLAN_FINAL.md`
7. Others acknowledge and agree

### Your Role
- Monitor the conversation
- Inject guidance if they go off-track
- Ask questions to prompt deeper discussion
- Call out if they're being too agreeable

## Example Challenges

Try these to see different types of collaboration:

**System Design**:
```
Design a distributed rate limiting system that can handle 100k requests per second
```

**Architecture**:
```
Propose an architecture for a real-time collaborative text editor (like Google Docs)
```

**Algorithms**:
```
Design an efficient algorithm for finding the shortest path in a graph with negative edge weights
```

**API Design**:
```
Design a RESTful API for a social media platform with posts, comments, and user relationships
```

**Database**:
```
Design a database schema for an e-commerce platform with products, orders, and inventory tracking
```

## Keyboard Shortcuts

- `Ctrl+C`: Quit
- `Ctrl+S`: Send your typed message to CHAT.md
- `Tab`: Navigate between UI elements

## Checking Results

While the app is running, you can also check files directly:

```bash
# Watch the chat in real-time
tail -f workspace/CHAT.md

# Check the final plan
cat workspace/PLAN_FINAL.md
```

## Troubleshooting

### "Error starting agent"
- **With mock agents**: Make sure `mock_agent.py` exists and is executable (`chmod +x mock_agent.py`)
- **With real agents**: Verify the command in `config.yaml` is correct (test it in terminal)

### Mock agents not responding
- Check `workspace/CHAT.md` exists and is being created
- Look at the agent's output tab for error messages
- Ensure Python 3.7+ is installed

### Chat viewer not updating
- File watcher might need a moment to initialize
- Check if agents are actually writing to `CHAT.md` (open the file directly)
- Try sending a manual message to trigger an update

## Next Steps

Once you've tested with mock agents:

1. **Configure real agents**: Edit `config.yaml` with your actual AI CLI commands
2. **Customize the prompt**: Modify `prompt_template` in `config.yaml`
3. **Try complex challenges**: Give them harder problems that require real debate
4. **Observe patterns**: Notice how different agent personalities emerge
5. **Iterate**: Refine your prompts based on what works

## Tips for Best Results

✅ **Do**:
- Give clear, specific challenges
- Let agents discuss for a while before intervening
- Encourage them to challenge each other
- Use the input box to provide clarifications

❌ **Don't**:
- Make challenges too vague
- Interrupt too quickly
- Accept the first solution without debate
- Forget to monitor both agent tabs AND chat viewer

## Files to Check

- `workspace/CHAT.md` - The conversation
- `workspace/PLAN_FINAL.md` - The final agreed solution
- Agent tabs - Individual agent thinking/output

## What Makes a Good Challenge?

**Good**: "Design a caching layer for a microservices architecture with eventual consistency requirements"
- Specific
- Has trade-offs to discuss
- Multiple valid approaches
- Room for disagreement

**Bad**: "Make something good"
- Too vague
- No clear constraints
- Nothing to debate
- No way to evaluate solutions

## Enjoy!

Watch as agents collaborate, disagree, refine ideas, and converge on elegant solutions!
