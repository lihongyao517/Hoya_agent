import { createAgentSessionRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

// Map pi-coding-agent events to the UI's WireEvent format
function mapEventToWireEvent(e) {
  switch (e.type) {
    case 'message_start':
      if (e.message.role === 'assistant') {
        return { kind: 'status', detail: 'Thinking...' };
      }
      break;
    case 'message_update':
      if (e.content) {
        return { kind: 'text', text: e.content };
      }
      if (e.reasoning) {
        return { kind: 'reasoning', reasoning: e.reasoning };
      }
      break;
    case 'tool_execution_start':
      return { kind: 'tool_dispatch', tool: { id: e.toolName, name: e.toolName, input: JSON.stringify(e.input) } };
    case 'tool_result':
      return { kind: 'tool_result', tool: { id: e.toolName, name: e.toolName, result: e.result?.text || 'Done' } };
    case 'session_shutdown':
    case 'agent_settled':
    case 'agent_end':
      return { kind: 'turn_done' };
    default:
      break;
  }
  return null;
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let runtime = null;

async function initRuntime(cwd) {
  if (runtime) return runtime;
  
  // Use C:\Users\Administrator\.hoya or ~/.hoya
  const agentDir = path.join(os.homedir(), '.hoya');
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  // Claude skill sharing
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const hoyaSkillsDir = path.join(agentDir, 'skills');
  if (fs.existsSync(claudeSkillsDir) && !fs.existsSync(hoyaSkillsDir)) {
    try {
      fs.symlinkSync(claudeSkillsDir, hoyaSkillsDir, 'junction');
    } catch (e) {
      console.error('Failed to link claude skills:', e);
    }
  }

  const sessionManager = SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.create(cwd, agentDir);

  runtime = await createAgentSessionRuntime(async (options) => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    return createAgentSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionManager: options.sessionManager,
    });
  }, { cwd, agentDir, sessionManager });

  // Hook up event translation
  runtime.session.extensionRunner.on('*', (e) => {
    const wireEvent = mapEventToWireEvent(e);
    if (wireEvent) {
      process.send({ type: 'agent:event', payload: wireEvent });
    }
  });

  return runtime;
}

let currentAbortController = null;

process.on('message', async (msg) => {
  try {
    if (msg.type === 'Submit' || msg.type === 'Chat') {
      if (currentAbortController) {
        currentAbortController.abort();
      }
      currentAbortController = new AbortController();

      const r = await initRuntime(msg.cwd || process.cwd());
      
      // Load user memory / global constraints from agent.md
      let promptInput = msg.input;
      const agentMdPath = path.join(os.homedir(), '.hoya', 'agent.md');
      if (fs.existsSync(agentMdPath)) {
        const memory = fs.readFileSync(agentMdPath, 'utf8');
        promptInput = `<Global Constraints>\n${memory}\n</Global Constraints>\n\n${promptInput}`;
      }

      // Inform UI we're starting
      process.send({ type: 'agent:event', payload: { kind: 'status', detail: 'Starting...' } });
      
      // Execute prompt
      try {
        await r.session.prompt(promptInput, { streamingBehavior: 'steer', signal: currentAbortController.signal });
      } catch (err) {
        if (err.name === 'AbortError' || err.message?.includes('aborted')) {
          process.send({ type: 'agent:event', payload: { kind: 'status', detail: 'Cancelled' } });
        } else {
          throw err;
        }
      }
      
      // Inform UI we're done
      process.send({ type: 'agent:event', payload: { kind: 'turn_done' } });
    } else if (msg.type === 'ClearSession') {
      if (currentAbortController) currentAbortController.abort();
      runtime = null;
      process.send({ type: 'agent:event', payload: { kind: 'turn_done' } });
    } else if (msg.type === 'Cancel') {
      if (currentAbortController) {
        currentAbortController.abort();
      }
    }
  } catch (err) {
    process.send({ type: 'agent:event', payload: { kind: 'error', err: String(err) } });
  }
});
