#!/usr/bin/env node

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');

// Agent personality traits
const PERSONALITIES = {
  Claude: {
    style: 'analytical and thorough',
    greeting: "Hello! I'm Claude. I'll analyze this challenge systematically.",
    focus: 'architecture and best practices'
  },
  Codex: {
    style: 'practical and code-focused',
    greeting: "Hey, Codex here. Let me think about the implementation details.",
    focus: 'concrete implementation'
  },
  Gemini: {
    style: 'creative and explorative',
    greeting: "Hi! Gemini joining. I'll explore alternative approaches.",
    focus: 'innovative solutions'
  }
};

class MockAgent {
  constructor() {
    this.agentName = process.env.AGENT_NAME || 'Agent';
    this.personality = PERSONALITIES[this.agentName] || PERSONALITIES.Claude;
    this.chatFile = null;
    this.planFile = null;
    this.workspaceDir = process.cwd();
    this.messageCount = 0;
    this.hasGreeted = false;
    this.discussionRounds = 0;
  }

  log(message) {
    console.error(`[${this.agentName}] ${message}`);
  }

  async initialize() {
    this.log('Initializing...');

    // Read the initial prompt from stdin
    const prompt = await this.readPrompt();
    this.log('Received prompt');

    // Parse workspace info from prompt
    const workspaceMatch = prompt.match(/workspace directory: (.+)/);
    if (workspaceMatch) {
      this.workspaceDir = workspaceMatch[1].trim();
    }

    const chatMatch = prompt.match(/shared chat file: (.+)/);
    if (chatMatch) {
      this.chatFile = path.join(this.workspaceDir, chatMatch[1].trim());
    } else {
      this.chatFile = path.join(this.workspaceDir, 'CHAT.md');
    }

    const planMatch = prompt.match(/final plan file: (.+)/);
    if (planMatch) {
      this.planFile = path.join(this.workspaceDir, planMatch[1].trim());
    } else {
      this.planFile = path.join(this.workspaceDir, 'PLAN_FINAL.md');
    }

    this.log(`Chat file: ${this.chatFile}`);
    this.log(`Plan file: ${this.planFile}`);

    // Extract the actual challenge
    const challengeMatch = prompt.match(/CHALLENGE:\s*(.+?)(?=\n\n|$)/s);
    if (challengeMatch) {
      this.challenge = challengeMatch[1].trim();
      this.log(`Challenge: ${this.challenge.substring(0, 50)}...`);
    }
  }

  async readPrompt() {
    return new Promise((resolve) => {
      let promptData = '';
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      rl.on('line', (line) => {
        promptData += line + '\n';
      });

      // Set a timeout to finish reading
      setTimeout(() => {
        rl.close();
        resolve(promptData);
      }, 1000);
    });
  }

  async readChat() {
    try {
      return await fs.readFile(this.chatFile, 'utf8');
    } catch (error) {
      return '';
    }
  }

  async appendToChat(message) {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMessage = `\n\n[${this.agentName} @ ${timestamp}]: ${message}\n`;

    try {
      await fs.appendFile(this.chatFile, formattedMessage);
      this.log('Appended message to chat');
    } catch (error) {
      this.log(`Error appending to chat: ${error.message}`);
    }
  }

  analyzeChat(chatContent) {
    const messages = chatContent.split('\n\n').filter(line =>
      line.includes('[') && line.includes(']:')
    );

    const myMessages = messages.filter(msg => msg.includes(`[${this.agentName}`)).length;
    const otherMessages = messages.length - myMessages;
    const hasUserMessage = chatContent.includes('[User @');

    return {
      totalMessages: messages.length,
      myMessages,
      otherMessages,
      hasUserMessage,
      shouldRespond: otherMessages > myMessages || hasUserMessage
    };
  }

  generateResponse(chatContent, analysis) {
    const responses = {
      greeting: [
        `${this.personality.greeting} Looking at this challenge about: ${this.challenge?.substring(0, 100)}...`,
        `I think we should focus on ${this.personality.focus}.`,
        `What do you all think?`
      ].join(' '),

      analysis: [
        `Based on what's been discussed, I have some thoughts on ${this.personality.focus}.`,
        this.getAnalysisInsight(),
        `Does this align with everyone's thinking?`
      ].join(' '),

      agreement: [
        `I agree with the points raised.`,
        `From my perspective focusing on ${this.personality.focus}, I'd add that ${this.getImplementationDetail()}.`
      ].join(' '),

      challenge: [
        `Interesting points, but I wonder if we've considered ${this.getChallengePoint()}.`,
        `This could be important for ${this.personality.focus}.`
      ].join(' '),

      summary: [
        `Let me summarize what we've discussed:`,
        this.getSummary(chatContent),
        `I think we have enough to create a final plan. Shall I draft it?`
      ].join(' '),

      plan: [
        `I'll create the final plan now based on our discussion.`
      ].join(' ')
    };

    // Determine which response to use
    if (!this.hasGreeted) {
      this.hasGreeted = true;
      return responses.greeting;
    }

    if (this.discussionRounds < 2) {
      this.discussionRounds++;
      return responses.analysis;
    }

    if (this.discussionRounds < 4) {
      this.discussionRounds++;
      return Math.random() > 0.5 ? responses.agreement : responses.challenge;
    }

    if (this.discussionRounds < 5) {
      this.discussionRounds++;
      return responses.summary;
    }

    return responses.plan;
  }

  getAnalysisInsight() {
    const insights = {
      Claude: 'we should consider scalability and maintainability from the start',
      Codex: 'the implementation should be straightforward and testable',
      Gemini: 'there might be some innovative patterns we could explore here'
    };
    return insights[this.agentName] || 'this needs careful consideration';
  }

  getImplementationDetail() {
    const details = {
      Claude: 'proper error handling and edge cases are critical',
      Codex: 'we should use well-tested libraries where possible',
      Gemini: 'we could experiment with a novel approach here'
    };
    return details[this.agentName] || 'attention to detail matters';
  }

  getChallengePoint() {
    const points = {
      Claude: 'the long-term maintenance implications',
      Codex: 'performance under load',
      Gemini: 'alternative architectures that might be more elegant'
    };
    return points[this.agentName] || 'potential issues down the road';
  }

  getSummary(chatContent) {
    return `We've discussed the challenge and covered ${this.personality.focus}. The consensus seems to be forming around a solid approach.`;
  }

  async writePlan() {
    const plan = `# Final Implementation Plan

## Challenge
${this.challenge || 'Multi-agent collaboration challenge'}

## Solution Overview
Based on our collaborative discussion, here's our recommended approach:

### 1. Architecture
- **Design Pattern**: Modular, scalable architecture
- **Key Components**:
  - Core logic layer
  - Data access layer
  - API/Interface layer
- **Rationale**: Ensures maintainability and testability

### 2. Implementation Strategy
- **Phase 1**: Set up core infrastructure and data models
- **Phase 2**: Implement business logic with proper error handling
- **Phase 3**: Build API layer with comprehensive validation
- **Phase 4**: Add monitoring, logging, and optimization

### 3. Technical Considerations
- **Performance**: Implement caching and optimize critical paths
- **Scalability**: Design for horizontal scaling from the start
- **Security**: Follow best practices for data validation and access control
- **Testing**: Comprehensive unit, integration, and end-to-end tests

### 4. Key Decisions
- Use proven, well-maintained libraries
- Prioritize code clarity and maintainability
- Implement proper logging and monitoring
- Plan for graceful degradation and error recovery

### 5. Next Steps
1. Set up development environment
2. Create project structure
3. Implement core functionality
4. Add tests and documentation
5. Deploy and monitor

## Conclusion
This plan represents the collective thinking of all agents, balancing ${PERSONALITIES.Claude.focus}, ${PERSONALITIES.Codex.focus}, and ${PERSONALITIES.Gemini.focus}.

---
*Generated by ${this.agentName} based on multi-agent collaboration*
`;

    try {
      await fs.writeFile(this.planFile, plan);
      this.log('Final plan written successfully');
    } catch (error) {
      this.log(`Error writing plan: ${error.message}`);
    }
  }

  async run() {
    await this.initialize();

    this.log('Starting main loop...');

    // Main loop
    while (true) {
      await this.sleep(3000); // Wait 3 seconds between checks

      try {
        const chatContent = await this.readChat();
        const analysis = this.analyzeChat(chatContent);

        this.log(`Analysis: ${analysis.totalMessages} messages, ${analysis.myMessages} mine`);

        // Decide whether to respond
        if (this.discussionRounds >= 5 && this.agentName === 'Claude') {
          // Claude writes the final plan
          await this.appendToChat('I\'ll write the final plan now based on our discussion.');
          await this.sleep(2000);
          await this.writePlan();
          this.log('Plan written, exiting...');
          break;
        } else if (analysis.shouldRespond && this.discussionRounds < 6) {
          // Generate and send response
          await this.sleep(1000 + Math.random() * 2000); // Random delay for realism
          const response = this.generateResponse(chatContent, analysis);
          await this.appendToChat(response);
        }
      } catch (error) {
        this.log(`Error in main loop: ${error.message}`);
      }
    }

    this.log('Agent finished');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run the agent
const agent = new MockAgent();
agent.run().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
