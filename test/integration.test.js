import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/index.js';

const cliEntry = fileURLToPath(new URL('../src/lash.js', import.meta.url));

function promisifyExecFile() {
  return (file, args, options) => new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({
        code: error ? error.code ?? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

async function makeIntegrationRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lash-integration-'));
  return {
    root,
    workspace: path.join(root, 'workspace'),
    home: path.join(root, 'home'),
    codexHome: path.join(root, 'home', '.codex'),
    claudeConfig: path.join(root, 'home', '.claude'),
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('integrated CLI commands cover configuration, execution, and sessions', async () => {
  const { root, workspace, home, codexHome, claudeConfig } = await makeIntegrationRoot();
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
  };
  const runCliProcess = promisifyExecFile();
  const run = async (args) => runCliProcess(process.execPath, [cliEntry, ...args], {
    cwd: workspace,
    env,
  });

  try {
    const projectConfig = path.join(workspace, '.lash', 'agents.json');
    const userConfig = path.join(home, '.lash', 'agents.json');
    const agentOutput = path.join(workspace, 'agent-output.json');
    const agentScript = path.join(workspace, 'fake-agent.mjs');
    await fs.writeFile(agentScript, [
      "import { writeFile } from 'node:fs/promises';",
      `await writeFile(${JSON.stringify(agentOutput)}, JSON.stringify(process.argv.slice(2), null, 2) + "\\n");`,
      '',
    ].join('\n'));
    const readAgentOutput = async () => readJson(agentOutput);

    // help and version, including the implicit no-argument form
    for (const args of [[], ['-h'], ['--help']]) {
      const help = await run(args);
      assert.equal(help.code, 0);
      assert.match(help.stdout, /lash run <agent>/);
      assert.match(help.stdout, /lash resume <agent>/);
    }
    for (const args of [['-v'], ['--version']]) {
      const version = await run(args);
      assert.equal(version.code, 0);
      assert.equal(version.stdout.trim(), VERSION);
    }

    // project and user config paths and initialization
    assert.equal((await run(['path'])).stdout.trim(), projectConfig);
    assert.equal((await run(['path', '--user'])).stdout.trim(), userConfig);

    const init = await run(['init']);
    assert.equal(init.code, 0);
    assert.match(init.stdout, /created .*agents\.json/);
    assert.deepEqual(await readJson(projectConfig), { agents: {} });
    assert.match((await run(['init'])).stdout, /already exists/);

    const userInit = await run(['init', '--user']);
    assert.equal(userInit.code, 0);
    assert.match(userInit.stdout, /created .*agents\.json/);
    assert.match((await run(['init', '--user'])).stdout, /already exists/);

    // user configuration can be added, listed, and removed
    const addUser = await run(['add', 'user-tool', '--user', '--', process.execPath, agentScript]);
    assert.equal(addUser.code, 0);
    assert.match(addUser.stdout, new RegExp(`added user-tool to .*${path.basename(userConfig)}`));
    assert.equal((await readJson(userConfig)).agents['user-tool'].command, process.execPath);
    assert.ok(JSON.parse((await run(['list', '--json'])).stdout).some((agent) => (
      agent.name === 'user-tool' && agent.source === 'user'
    )));
    const removeUser = await run(['remove', 'user-tool', '--user']);
    assert.equal(removeUser.code, 0);
    assert.match(removeUser.stdout, /removed user-tool/);

    // add a project agent, then add execution/session metadata through the public config format
    const add = await run(['add', 'fake', '--', process.execPath, agentScript]);
    assert.equal(add.code, 0);
    assert.match(add.stdout, /added fake to .*agents\.json/);

    const config = await readJson(projectConfig);
    config.agents.fake.interactiveArgs = [agentScript];
    config.agents['codex-fake'] = {
      command: process.execPath,
      args: [],
      interactiveArgs: [agentScript],
      session: {
        provider: 'codex',
        pickerArgs: [agentScript, 'picker'],
        resumeArgs: [agentScript, 'interactive-resume', '{sessionId}'],
        execResumeArgs: [agentScript, 'exec-resume', '{sessionId}'],
      },
    };
    config.agents['claude-fake'] = {
      command: process.execPath,
      args: [],
      interactiveArgs: [agentScript],
      session: {
        provider: 'claude',
        pickerArgs: [agentScript, 'picker'],
        resumeArgs: [agentScript, 'resume', '{sessionId}'],
      },
    };
    config.agents.manual = {
      command: process.execPath,
      args: [],
      interactiveArgs: [agentScript],
      session: {
        provider: 'manual',
        pickerArgs: [agentScript, 'picker'],
        resumeArgs: [agentScript, 'manual-resume', '{sessionId}'],
      },
    };
    await fs.writeFile(projectConfig, `${JSON.stringify(config, null, 2)}\n`);

    // list and show expose both built-ins and resolved project agents
    const listedHuman = await run(['list']);
    assert.equal(listedHuman.code, 0);
    assert.match(listedHuman.stdout, /codex\s+built-in/);
    assert.match(listedHuman.stdout, /claude\s+built-in/);
    assert.match(listedHuman.stdout, /codex-fake\s+project/);

    const listed = JSON.parse((await run(['list', '--json'])).stdout);
    assert.ok(listed.some((agent) => agent.name === 'codex' && agent.source === 'built-in'));
    assert.ok(listed.some((agent) => agent.name === 'claude' && agent.source === 'built-in'));
    assert.ok(listed.some((agent) => agent.name === 'fake' && agent.source === 'project'));
    assert.ok(listed.some((agent) => agent.name === 'manual' && agent.source === 'project'));

    const shownCodex = JSON.parse((await run(['show', 'codex'])).stdout);
    assert.equal(shownCodex.command, 'codex');
    assert.deepEqual(shownCodex.args, ['exec', '--skip-git-repo-check', '--color', 'never']);
    const shownFake = JSON.parse((await run(['show', 'fake'])).stdout);
    assert.equal(shownFake.command, process.execPath);

    // run executes one-shot mode and interactive mode with the configured arg sets
    const launched = await run(['run', 'fake', 'hello', 'world']);
    assert.equal(launched.code, 0);
    assert.deepEqual(await readAgentOutput(), ['hello', 'world']);

    const interactive = await run(['run', 'fake']);
    assert.equal(interactive.code, 0);
    assert.deepEqual(await readAgentOutput(), []);

    // create native Codex and Claude Code session stores without contacting either service
    const currentCodexId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherCodexId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const archivedCodexId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const claudeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const codexIndex = [
      { id: currentCodexId, thread_name: 'codex integration task', updated_at: '2026-09-21T04:01:00Z' },
      { id: otherCodexId, thread_name: 'codex other directory', updated_at: '2026-09-21T05:00:00Z' },
      { id: archivedCodexId, thread_name: 'codex archived task', updated_at: '2026-09-21T02:00:00Z' },
    ].map((record) => JSON.stringify(record)).join('\n');

    async function writeCodexSession({ id, cwd, timestamp, source, archived = false }) {
      const directory = path.join(
        codexHome,
        archived ? 'archived_sessions' : 'sessions',
        '2026',
        '09',
        '21',
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `rollout-codex-${id}.jsonl`), [
        JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp, source } }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'native codex prompt' }],
          },
        }),
        '',
      ].join('\n'));
    }

    await writeCodexSession({
      id: currentCodexId,
      cwd: workspace,
      timestamp: '2026-09-21T04:00:00Z',
      source: 'exec',
    });
    await writeCodexSession({
      id: otherCodexId,
      cwd: `${workspace}-other`,
      timestamp: '2026-09-21T05:00:00Z',
      source: 'interactive',
    });
    await writeCodexSession({
      id: archivedCodexId,
      cwd: workspace,
      timestamp: '2026-09-21T02:00:00Z',
      source: 'interactive',
      archived: true,
    });
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), `${codexIndex}\n`);

    const claudeProjectDir = path.join(claudeConfig, 'projects', 'workspace');
    await fs.mkdir(claudeProjectDir, { recursive: true });
    const claudeFile = path.join(claudeProjectDir, `${claudeId}.jsonl`);
    await fs.writeFile(claudeFile, `${JSON.stringify({
      type: 'user',
      isSidechain: false,
      sessionId: claudeId,
      cwd: workspace,
      timestamp: '2026-09-21T03:00:00Z',
      entrypoint: 'claude-cli',
      message: { content: [{ type: 'text', text: 'claude integration task' }] },
    })}\n`);
    const claudeTime = new Date('2026-09-21T03:30:00Z');
    await fs.utimes(claudeFile, claudeTime, claudeTime);

    // sessions combine providers, filter by cwd, and support all documented filters
    const defaultSessions = JSON.parse((await run(['sessions', '--json'])).stdout);
    assert.equal(defaultSessions.length, 2);
    assert.equal(defaultSessions[0].id, currentCodexId);
    assert.equal(defaultSessions[0].title, 'codex integration task');
    assert.equal(defaultSessions[0].kind, 'exec');
    assert.equal(defaultSessions[1].id, claudeId);
    assert.equal(defaultSessions[1].title, 'claude integration task');

    const codexSessions = JSON.parse((await run(['sessions', 'codex-fake', '--json'])).stdout);
    assert.equal(codexSessions.length, 1);
    assert.equal(codexSessions[0].id, currentCodexId);

    const allSessions = JSON.parse((await run(['sessions', '--all', '--json'])).stdout);
    assert.deepEqual(allSessions.map((session) => session.id), [
      otherCodexId,
      currentCodexId,
      claudeId,
    ]);

    const archivedSessions = JSON.parse((await run(['sessions', '--archived', '--json'])).stdout);
    assert.deepEqual(archivedSessions.map((session) => session.id), [
      currentCodexId,
      claudeId,
      archivedCodexId,
    ]);

    const limited = await run(['sessions', '--limit', '1']);
    assert.equal(limited.code, 0);
    assert.match(limited.stdout, /codex integration task/);
    assert.doesNotMatch(limited.stdout, /claude integration task/);

    const last = JSON.parse((await run(['last', '--json'])).stdout);
    assert.equal(last.id, currentCodexId);
    const lastClaude = JSON.parse((await run(['last', 'claude-fake', '--json'])).stdout);
    assert.equal(lastClaude.id, claudeId);
    const lastAll = JSON.parse((await run(['last', 'codex-fake', '--all', '--json'])).stdout);
    assert.equal(lastAll.id, otherCodexId);

    // picker, explicit references, and the fixed --last-with-prompt form
    const picker = await run(['resume', 'manual']);
    assert.equal(picker.code, 0);
    assert.deepEqual(await readAgentOutput(), ['picker']);

    const manualResume = await run(['resume', 'manual', currentCodexId, 'continue', 'manually']);
    assert.equal(manualResume.code, 0);
    assert.deepEqual(await readAgentOutput(), ['manual-resume', currentCodexId, 'continue', 'manually']);

    const lastWithPrompt = await run(['resume', 'codex-fake', '--last', '现在很不错']);
    assert.equal(lastWithPrompt.code, 0);
    assert.deepEqual(await readAgentOutput(), ['exec-resume', currentCodexId, '现在很不错']);

    const titleResume = await run(['resume', 'codex-fake', 'codex integration task', 'continue by title']);
    assert.equal(titleResume.code, 0);
    assert.deepEqual(await readAgentOutput(), ['exec-resume', currentCodexId, 'continue by title']);

    const indexResume = await run(['resume', 'codex-fake', '#1', 'continue by index']);
    assert.equal(indexResume.code, 0);
    assert.deepEqual(await readAgentOutput(), ['exec-resume', currentCodexId, 'continue by index']);

    const otherDirectoryResume = await run(['resume', 'codex-fake', '--all', otherCodexId, 'continue other directory']);
    assert.equal(otherDirectoryResume.code, 0);
    assert.deepEqual(await readAgentOutput(), ['interactive-resume', otherCodexId, 'continue other directory']);

    const archivedResume = await run(['resume', 'codex-fake', '--archived', archivedCodexId, 'continue archived']);
    assert.equal(archivedResume.code, 0);
    assert.deepEqual(await readAgentOutput(), ['interactive-resume', archivedCodexId, 'continue archived']);

    const claudeResume = await run(['resume', 'claude-fake', claudeId, 'continue claude']);
    assert.equal(claudeResume.code, 0);
    assert.deepEqual(await readAgentOutput(), ['resume', claudeId, 'continue claude']);

    // remove only affects the selected project/user scope
    const remove = await run(['remove', 'fake']);
    assert.equal(remove.code, 0);
    assert.match(remove.stdout, /removed fake/);
    const afterRemove = JSON.parse((await run(['list', '--json'])).stdout);
    assert.ok(!afterRemove.some((agent) => agent.name === 'fake'));
    assert.ok(afterRemove.some((agent) => agent.name === 'manual'));

    // handled CLI failures have stable exit codes and useful diagnostics
    const unknownCommand = await run(['does-not-exist']);
    assert.equal(unknownCommand.code, 2);
    assert.match(unknownCommand.stderr, /unknown command/);

    const unknownAgent = await run(['run', 'does-not-exist']);
    assert.equal(unknownAgent.code, 1);
    assert.match(unknownAgent.stderr, /unknown agent/);

    const missingRunAgent = await run(['run']);
    assert.equal(missingRunAgent.code, 2);
    assert.match(missingRunAgent.stderr, /lash run requires an agent name/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
