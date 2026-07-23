import { createAgentSessionRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

// Map pi-coding-agent events to the UI's WireEvent format
function mapEventToWireEvent(e) {
  switch (e.type) {
    case 'turn_start':
      return { kind: 'turn_started' };
    case 'message_update': {
      const ae = e.assistantMessageEvent;
      if (!ae) break;
      if (ae.type === 'text_delta') {
        return { kind: 'text', text: ae.delta };
      }
      if (ae.type === 'thinking_delta') {
        return { kind: 'reasoning', reasoning: ae.delta, reasoningSource: 'piagent', reasoningEvent: ae.type };
      }
      break;
    }
    case 'tool_execution_start':
      return { kind: 'tool_dispatch', tool: { id: e.toolCallId, name: e.toolName, args: JSON.stringify(e.args) } };
    case 'tool_execution_end':
      return { kind: 'tool_result', tool: { id: e.toolCallId, name: e.toolName, output: JSON.stringify(e.result), err: e.isError ? String(e.result) : undefined } };
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

  runtime = await createAgentSessionRuntime(async (options) => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    return createAgentSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      projectTrustContext: options.projectTrustContext,
    });
  }, { cwd, agentDir, sessionManager });

  // Hook up event translation
  runtime.session.subscribe((e) => {
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
    console.log("Worker received message:", msg.type);
    if (msg.type === 'Submit' || msg.type === 'Chat') {
      if (currentAbortController) {
        currentAbortController.abort();
      }
      currentAbortController = new AbortController();

      console.log("Initializing runtime...");
      const r = await initRuntime(msg.cwd || process.cwd());
      console.log("Runtime initialized.");
      
      // Load user memory / global constraints from agent.md
      let promptInput = msg.input;
      const agentMdPath = path.join(os.homedir(), '.hoya', 'agent.md');
      if (fs.existsSync(agentMdPath)) {
        const memory = fs.readFileSync(agentMdPath, 'utf8');
        promptInput = `<Global Constraints>\n${memory}\n</Global Constraints>\n\n${promptInput}`;
      }

      // Inform UI we're starting
      process.send({ type: 'agent:event', payload: { kind: 'notice', level: 'info', text: 'PiAgent runtime started. Streaming pi-coding-agent events...' } });
      
      // Execute prompt
      try {
        console.log("Prompting session with:", promptInput);
        await r.session.prompt(promptInput, { streamingBehavior: 'steer', signal: currentAbortController.signal });
        console.log("Prompt finished.");
      } catch (err) {
        if (err.name === 'AbortError' || err.message?.includes('aborted')) {
          process.send({ type: 'agent:event', payload: { kind: 'notice', level: 'info', text: 'Cancelled' } });
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
    process.send({ type: 'agent:event', payload: { kind: 'turn_done', err: String(err?.message || err) } });
  }
});
