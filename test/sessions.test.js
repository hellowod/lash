import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUILTIN_AGENTS } from '../src/agents.js';
import { launchTarget } from '../src/cli.js';
import {
  isSessionId,
  latestSession,
  listAgentSessions,
  resolveSessionRef,
} from '../src/sessions.js';

async function temporaryHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lash-sessions-'));
}

function withEnvironment(overrides, callback) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return Promise.resolve(callback()).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('codex session provider lists exec and interactive sessions by cwd', async () => {
  const home = await temporaryHome();
  const cwd = path.join(path.sep, 'workspace', 'project');
  const codexHome = path.join(home, '.codex');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '09', '21');
  await fs.mkdir(sessionDir, { recursive: true });

  const interactiveId = '11111111-1111-4111-8111-111111111111';
  const execId = '22222222-2222-4222-8222-222222222222';
  await fs.writeFile(path.join(sessionDir, `rollout-interactive-${interactiveId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: interactiveId, cwd, timestamp: '2026-09-21T01:00:00Z', source: 'vscode' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'interactive task' }] } }),
    '',
  ].join('\n'));
  await fs.writeFile(path.join(sessionDir, `rollout-exec-${execId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: execId, cwd, timestamp: '2026-09-21T02:00:00Z', source: 'exec' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'one-shot task' }] } }),
    '',
  ].join('\n'));

  await withEnvironment({ CODEX_HOME: codexHome }, async () => {
    const sessions = await listAgentSessions(BUILTIN_AGENTS.codex, { cwd });
    assert.deepEqual(sessions.map((session) => session.id).sort(), [interactiveId, execId].sort());
    assert.equal(sessions.find((session) => session.id === interactiveId).kind, 'interactive');
    assert.equal(sessions.find((session) => session.id === execId).kind, 'exec');
    assert.equal(sessions.find((session) => session.id === execId).title, 'one-shot task');
    assert.equal(resolveSessionRef(sessions, '#1').id, execId);
    assert.equal(resolveSessionRef(sessions, 'interactive task').id, interactiveId);
  });
});

test('claude session provider reads project jsonl sessions', async () => {
  const home = await temporaryHome();
  const cwd = path.join(path.sep, 'workspace', 'claude-project');
  const configDir = path.join(home, '.claude');
  const projectDir = path.join(configDir, 'projects', 'encoded-project');
  await fs.mkdir(projectDir, { recursive: true });
  const id = '33333333-3333-4333-8333-333333333333';
  await fs.writeFile(path.join(projectDir, `${id}.jsonl`), [
    JSON.stringify({ type: 'queue-operation', sessionId: id }),
    JSON.stringify({
      type: 'user',
      isSidechain: false,
      sessionId: id,
      cwd,
      timestamp: '2026-09-21T03:00:00Z',
      entrypoint: 'claude-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'claude task' }] },
    }),
    '',
  ].join('\n'));

  await withEnvironment({ CLAUDE_CONFIG_DIR: configDir }, async () => {
    const sessions = await listAgentSessions(BUILTIN_AGENTS.claude, { cwd });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, id);
    assert.equal(sessions[0].title, 'claude task');
    assert.equal(sessions[0].kind, 'cli');
    assert.equal(latestSession(sessions).id, id);
  });
});

test('manual session providers list no sessions but accept UUID resume ids', async () => {
  const agent = {
    name: 'custom',
    command: 'custom',
    args: [],
    interactiveArgs: [],
    env: {},
    session: { provider: 'manual', resumeArgs: ['--resume', '{sessionId}'] },
  };
  assert.deepEqual(await listAgentSessions(agent, { cwd: process.cwd() }), []);
  assert.equal(isSessionId('11111111-1111-4111-8111-111111111111'), true);
  assert.deepEqual(
    launchTarget(agent, ['continue'], 'session', { id: '11111111-1111-4111-8111-111111111111', kind: 'interactive' }),
    { command: 'custom', args: ['--resume', '11111111-1111-4111-8111-111111111111', 'continue'] },
  );
});

test('codex resume uses exec resume args for exec sessions', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const target = launchTarget(
    BUILTIN_AGENTS.codex,
    ['continue'],
    'session',
    { id, kind: 'exec' },
  );
  assert.deepEqual(target.args, [
    'exec',
    '--skip-git-repo-check',
    '--color',
    'never',
    'resume',
    id,
    'continue',
  ]);
});
