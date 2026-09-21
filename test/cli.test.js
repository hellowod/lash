import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry, validateConfig } from '../src/agents.js';
import { parseArgv, runAgent, runCli } from '../src/cli.js';

async function temporaryFiles() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lash-test-'));
  return {
    directory,
    project: path.join(directory, '.lash', 'agents.json'),
    user: path.join(directory, '.lash-user', 'agents.json'),
  };
}

test('built-in agents resolve to codex exec and claude', () => {
  const registry = new AgentRegistry({
    projectPath: path.join('missing-project', 'agents.json'),
    userPath: path.join('missing-user', 'agents.json'),
  });

  assert.deepEqual(registry.resolve('codex').args, ['exec', '--skip-git-repo-check', '--color', 'never']);
  assert.deepEqual(registry.resolve('claude').args, []);
});

test('project agents override user agents and can inherit built-ins', async () => {
  const files = await temporaryFiles();
  await fs.mkdir(path.dirname(files.user), { recursive: true });
  await fs.mkdir(path.dirname(files.project), { recursive: true });
  await fs.writeFile(files.user, JSON.stringify({
    agents: {
      qwen: { command: 'user-qwen' },
    },
  }));
  await fs.writeFile(files.project, JSON.stringify({
    agents: {
      qwen: { command: 'project-qwen', args: ['--old'] },
      'codex-safe': {
        extends: 'codex',
        appendArgs: ['--sandbox', 'workspace-write'],
      },
    },
  }));

  const registry = new AgentRegistry({ projectPath: files.project, userPath: files.user });
  assert.equal(registry.resolve('qwen').command, 'project-qwen');
  assert.deepEqual(
    registry.resolve('codex-safe').args,
    ['exec', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'workspace-write'],
  );
});

test('inheritance cycles are rejected', async () => {
  const files = await temporaryFiles();
  await fs.mkdir(path.dirname(files.project), { recursive: true });
  await fs.writeFile(files.project, JSON.stringify({
    agents: {
      a: { extends: 'b', command: 'x' },
      b: { extends: 'a', command: 'x' },
    },
  }));
  const registry = new AgentRegistry({ projectPath: files.project, userPath: files.user });
  assert.throws(() => registry.resolve('a'), /inheritance cycle detected/);
});

test('config validation reports unknown fields', () => {
  assert.throws(
    () => validateConfig({ agents: { x: { comand: 'x' } } }, 'test.json'),
    /unknown field comand/,
  );
});

test('run parser preserves task arguments', () => {
  assert.deepEqual(parseArgv(['run', 'codex', 'Refactor', 'this function']), {
    command: 'run',
    name: 'codex',
    taskArgs: ['Refactor', 'this function'],
  });
  assert.deepEqual(parseArgv(['run', 'my', '--', '--flag']), {
    command: 'run',
    name: 'my',
    taskArgs: ['--flag'],
  });
});

test('session command parser accepts filtering options', () => {
  assert.deepEqual(parseArgv(['sessions', 'codex', '--all', '--archived', '--limit', '5', '--json']), {
    command: 'sessions',
    name: 'codex',
    json: true,
    all: true,
    archived: true,
    limit: 5,
  });
});

test('resume command parser separates session reference from task args', () => {
  assert.deepEqual(parseArgv(['resume', 'codex', '--all', '01a0c2fc', '--', '--verbose', 'continue']), {
    command: 'resume',
    name: 'codex',
    last: false,
    all: true,
    archived: false,
    reference: '01a0c2fc',
    taskArgs: ['--verbose', 'continue'],
  });
  assert.deepEqual(parseArgv(['resume', 'codex', '--last']), {
    command: 'resume',
    name: 'codex',
    last: true,
    all: false,
    archived: false,
    reference: undefined,
    taskArgs: [],
  });
  assert.deepEqual(parseArgv(['resume', 'codex', '--last', '现在很不错']), {
    command: 'resume',
    name: 'codex',
    last: true,
    all: false,
    archived: false,
    reference: undefined,
    taskArgs: ['现在很不错'],
  });
});
test('add parser supports agent arguments and user scope', () => {
  assert.deepEqual(parseArgv(['add', 'qwen', '--user', '--', 'qwen', '--profile', 'coding']), {
    command: 'add',
    name: 'qwen',
    scope: 'user',
    commandParts: ['qwen', '--profile', 'coding'],
  });
});

test('runAgent launches a configured command and returns its exit code', async () => {
  const code = await runAgent({
    command: process.execPath,
    args: ['-e'],
    interactiveArgs: [],
    env: {},
  }, ['process.stdout.write("ok")'], { stdio: 'pipe' });
  assert.equal(code, 0);
});

test('CLI list emits valid JSON', async () => {
  const lines = [];
  await runCli(['list', '--json'], { log: (value) => lines.push(value), error: () => {} });
  const parsed = JSON.parse(lines.join('\n'));
  assert.ok(parsed.some((agent) => agent.name === 'codex'));
});






