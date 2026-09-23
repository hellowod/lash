import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import spawn from 'cross-spawn';
import { AgentRegistry, defaultProjectPath, defaultUserPath } from './agents.js';
import { isSessionId, latestSession, listAgentSessions, resolveSessionRef, sortSessions } from './sessions.js';

export const HELP = `lash - launch any coding agent

Usage:
  lash run <agent> [args...]       Run a one-shot task; with no args, launch interactively.
  lash chat <agent> [args...]      Start a continuous interactive chat; args are initial input.
  lash list [--json]               List available agents.
  lash sessions [agent] [--json] [--all] [--archived] [--limit N]
                                    List native agent sessions for the current directory.
  lash last [agent] [--json] [--all]
                                    Show the most recent session.
  lash resume <agent> [--last] [session|title|#index] [args...]
                                    Resume an interactive session.
  lash show <agent>                Show a resolved agent definition.
  lash add <name> [--user] -- <command> [args...]
                                    Add an agent (project config by default).
  lash remove <name> [--user]     Remove a custom agent override.
  lash init [--user]               Create an empty agent config.
  lash path [--user]               Print an agent config path.
  lash --version                   Print the version.

Built-in agents:
  codex                            codex exec --skip-git-repo-check --color never [args...] / interactive codex --no-alt-screen
  claude                           claude [args...]
  pi                               pi --print [args...] / interactive pi

Config precedence: built-in < user < project.
Project config: .lash/agents.json
User config: ~/.lash/agents.json

Example:
  lash run codex "Refactor this function"
  lash run claude
  lash chat codex "Start with this question"
  lash run pi "Explain this repository"
  lash add qwen -- qwen
  lash run qwen "Explain this repository"

Session examples:
  lash sessions codex
  lash resume codex --last "Continue this task"
  lash resume codex 1 "Continue this task"
  lash resume claude <session-id> "Continue"
`;

function packageVersion() {
  try {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = packageVersion();

class UsageError extends Error {}

export function parseArgv(argv) {
  if (argv.length === 0) return { command: 'help' };
  if (argv[0] === '-h' || argv[0] === '--help') return { command: 'help' };
  if (argv[0] === '-v' || argv[0] === '--version') return { command: 'version' };

  const command = argv[0];
  if (command === 'run' || command === 'chat') {
    if (argv.length < 2) throw new UsageError(`lash ${command} requires an agent name`);
    const taskArgs = argv.slice(2);
    return { command, name: argv[1], taskArgs: taskArgs[0] === '--' ? taskArgs.slice(1) : taskArgs };
  }

  if (command === 'list') {
    return { command, json: argv.includes('--json') };
  }

  if (command === 'sessions' || command === 'last') {
    const options = parseSessionOptions(argv.slice(1), command);
    return { command, ...options };
  }

  if (command === 'resume') {
    if (argv.length < 2) throw new UsageError('lash resume requires an agent name');
    const options = parseResumeOptions(argv.slice(2));
    return { command, name: argv[1], ...options };
  }

  if (command === 'show' || command === 'remove') {
    if (argv.length < 2) throw new UsageError(`lash ${command} requires an agent name`);
    return { command, name: argv[1], scope: parseScope(argv.slice(2)) };
  }

  if (command === 'init' || command === 'path') {
    return { command, scope: parseScope(argv.slice(1)) };
  }

  if (command === 'add') {
    let scope = 'project';
    let name;
    let commandParts = [];
    let afterDelimiter = false;

    for (let index = 1; index < argv.length; index += 1) {
      const value = argv[index];
      if (name === undefined && !afterDelimiter) {
        if (value === '--user') {
          scope = 'user';
          continue;
        }
        if (value === '--project') {
          scope = 'project';
          continue;
        }
        if (value === '--') {
          afterDelimiter = true;
          continue;
        }
        name = value;
        continue;
      }
      if (!afterDelimiter && (value === '--user' || value === '--project')) {
        scope = value.slice(2);
        continue;
      }
      if (!afterDelimiter && value === '--') {
        afterDelimiter = true;
        continue;
      }
      commandParts.push(value);
    }

    if (name === undefined) throw new UsageError('lash add requires an agent name');
    if (commandParts.length === 0) throw new UsageError('lash add requires a command after --');
    return { command, name, scope, commandParts };
  }

  throw new UsageError(`unknown command "${command}"`, 'help');
}

function parseSessionOptions(values, command) {
  const options = {
    name: undefined,
    json: false,
    all: false,
    archived: false,
    limit: undefined,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--json') {
      options.json = true;
      continue;
    }
    if (value === '--all') {
      options.all = true;
      continue;
    }
    if (value === '--archived') {
      options.archived = true;
      continue;
    }
    if (value === '--limit' || value.startsWith('--limit=')) {
      const raw = value === '--limit'
        ? values[++index]
        : value.slice('--limit='.length);
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
      options.limit = limit;
      continue;
    }
    if (value.startsWith('--')) throw new UsageError(`unknown ${command} option "${value}"`);
    if (options.name !== undefined) throw new UsageError(`${command} accepts at most one agent name`);
    options.name = value;
  }

  if (options.limit === undefined && values.includes('--limit')) {
    throw new UsageError('--limit requires a positive integer');
  }
  return options;
}

function parseResumeOptions(values) {
  const options = {
    last: false,
    all: false,
    archived: false,
    reference: undefined,
    taskArgs: [],
  };
  const positional = [];
  const afterDelimiterArgs = [];
  let afterDelimiter = false;

  for (const value of values) {
    if (!afterDelimiter && value === '--') {
      afterDelimiter = true;
      continue;
    }
    if (!afterDelimiter && value === '--last') {
      options.last = true;
      continue;
    }
    if (!afterDelimiter && value === '--all') {
      options.all = true;
      continue;
    }
    if (!afterDelimiter && value === '--archived') {
      options.archived = true;
      continue;
    }
    if (!afterDelimiter && value.startsWith('--')) {
      throw new UsageError(`unknown resume option "${value}"`);
    }
    if (afterDelimiter) afterDelimiterArgs.push(value);
    else positional.push(value);
  }

  if (options.last) {
    options.taskArgs = [...positional, ...afterDelimiterArgs];
  } else if (positional.length > 0) {
    [options.reference] = positional;
    options.taskArgs = [...positional.slice(1), ...afterDelimiterArgs];
  } else {
    options.taskArgs = afterDelimiterArgs;
  }
  return options;
}
function parseScope(values) {
  const scopes = values.filter((value) => value === '--user' || value === '--project');
  if (scopes.length > 1) throw new UsageError('choose only one of --user or --project');
  return scopes[0]?.slice(2) ?? 'project';
}

function configPath(scope, registry) {
  return scope === 'user' ? registry.userPath : registry.projectPath;
}

function readConfigForWrite(filePath) {
  let config = { agents: {} };
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.agents !== 'object') {
        throw new Error('expected an object with an agents object');
      }
      config = parsed;
    } catch (error) {
      throw new Error(`cannot update ${filePath}: ${error.message}`);
    }
  }
  if (config.agents === undefined) config.agents = {};
  return config;
}

function writeConfig(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function shellQuote(value) {
  return /[\s"^]/.test(value) ? JSON.stringify(value) : value;
}

function formatCommand(command, args) {
  return [command, ...args, '[task args...]'].map(shellQuote).join(' ');
}

function sessionAgents(registry, name) {
  if (name !== undefined) return [registry.resolve(name)];
  return registry.names()
    .map((agentName) => registry.resolve(agentName))
    .filter((agent) => agent.session?.provider === 'codex'
      || agent.session?.provider === 'claude'
      || agent.session?.provider === 'pi');
}

async function loadSessions(registry, options) {
  const groups = await Promise.all(sessionAgents(registry, options.name).map(async (agent) => (
    listAgentSessions(agent, {
      cwd: process.cwd(),
      all: options.all,
      archived: options.archived,
    })
  )));
  const unique = new Map();
  for (const session of groups.flat()) {
    unique.set(`${session.provider}:${session.id}`, session);
  }
  return sortSessions([...unique.values()]);
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function clip(value, maximum) {
  const text = String(value ?? '');
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function printSessions(sessions, outputs) {
  if (sessions.length === 0) {
    outputs.log('No sessions found. Use --all to search every directory.');
    return;
  }
  outputs.log('#   AGENT    UPDATED               ID                                   TITLE / CWD');
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    outputs.log(
      `${String(index + 1).padStart(2)}  ${session.agent.padEnd(8)} `
      + `${clip(formatTime(session.updatedAt), 19).padEnd(20)} `
      + `${session.id.padEnd(36)} `
      + `${clip(session.title ?? session.cwd ?? '', 44)}`,
    );
  }
}

export function launchTarget(agent, taskArgs, launchMode = 'run', session) {
  const sessionConfig = agent.session ?? {};
  let args;
  if (launchMode === 'picker') {
    args = sessionConfig.pickerArgs;
  } else if (launchMode === 'last') {
    args = sessionConfig.lastArgs;
  } else if (launchMode === 'session') {
    const template = session?.kind === 'exec' && sessionConfig.execResumeArgs !== undefined
      ? sessionConfig.execResumeArgs
      : sessionConfig.resumeArgs;
    args = template?.map((value) => (
      value.replaceAll('{sessionId}', session?.id ?? '')
        .replaceAll('{id}', session?.id ?? '')
    ));
  } else if (launchMode === 'interactive') {
    args = agent.interactiveArgs;
  } else {
    args = taskArgs.length === 0 ? agent.interactiveArgs : agent.args;
  }

  if (!Array.isArray(args)) {
    throw new Error(`agent "${agent.name}" cannot be launched: missing arguments for ${launchMode} mode`);
  }

  const directLaunch = launchMode === 'run' || launchMode === 'interactive';
  const appendTaskArgs = directLaunch || launchMode === 'session';
  return {
    command: directLaunch ? agent.command : sessionConfig.command ?? agent.command,
    args: [...args, ...(appendTaskArgs ? taskArgs : [])],
  };
}

function normalizeMsysPath(value) {
  const drivePath = /^\/([a-z])\/(.*)$/i.exec(value);
  if (drivePath !== null) return `${drivePath[1].toUpperCase()}:/${drivePath[2]}`;
  return value;
}

function resolveWindowsExecutable(command, extensions) {
  const normalizedCommand = normalizeMsysPath(command);
  const hasDirectory = /[\\/]/.test(normalizedCommand);
  const base = hasDirectory ? path.resolve(normalizedCommand) : normalizedCommand;
  const explicitExtension = path.extname(base).toLowerCase();
  const candidates = ['.exe', '.cmd', '.bat'].includes(explicitExtension)
    ? [base]
    : extensions.map((extension) => base + extension);

  const searchPath = process.env.PATH ?? '';
  const delimiter = searchPath.includes(';') ? ';' : ':';
  for (const rawDirectory of searchPath.split(delimiter)) {
    if (rawDirectory === '') continue;
    const directory = normalizeMsysPath(rawDirectory);
    for (const candidate of candidates) {
      const resolved = hasDirectory ? candidate : path.join(directory, candidate);
      try {
        if (fs.statSync(resolved).isFile()) return resolved;
      } catch {
        // Try the next PATH entry or extension.
      }
    }
  }
  return undefined;
}

function isMinttyPty() {
  // mintty attaches a named pipe rather than a Windows console, so Node reports
  // stdout.isTTY === false even while a person watches an interactive terminal.
  // TERM_PROGRAM is mintty's own marker; TERM alone is too weak because CI shells
  // and piped Git Bash runs also export xterm and would make winpty abort.
  return process.env.TERM_PROGRAM === 'mintty';
}

function isRedirectedFile(stdout) {
  const fd = stdout?.fd;
  if (fd === undefined) return false;
  try {
    return fs.fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

export function inheritedMsysWinpty(agent, target, stdio, stdout = process.stdout) {
  if (
    process.platform !== 'win32'
    || stdio !== 'inherit'
    || process.env.MSYSTEM === undefined
    || process.env.LASH_NO_WINPTY === '1'
  ) return undefined;

  // Pi is the known casualty; LASH_WINPTY=1 opts any agent into the bridge.
  // A genuine console needs none of this, and winpty flattens some UTF-8 output.
  if (process.env.LASH_WINPTY !== '1') {
    if (agent.session?.provider !== 'pi') return undefined;
    if (stdout?.isTTY === true) return undefined;
    if (!isMinttyPty()) return undefined;
    if (isRedirectedFile(stdout)) return undefined;
  }

  const winpty = resolveWindowsExecutable('winpty', ['.exe']);
  const command = resolveWindowsExecutable(target.command, ['.exe', '.cmd', '.bat']);
  if (winpty === undefined || command === undefined) return undefined;
  return { command: winpty, args: [command, ...target.args] };
}

function inheritedMsysShell(stdio) {
  if (process.platform !== 'win32' || stdio !== 'inherit' || process.env.MSYSTEM === undefined) return undefined;

  const shell = process.env.SHELL;
  if (typeof shell !== 'string' || shell === '') return undefined;
  try {
    return fs.statSync(shell).isFile() ? shell : undefined;
  } catch {
    return undefined;
  }
}

export function runAgent(agent, taskArgs, { cwd = process.cwd(), stdio = 'inherit', launchMode = 'run', session } = {}) {
  const target = launchTarget(agent, taskArgs, launchMode, session);
  const winpty = inheritedMsysWinpty(agent, target, stdio);
  const msysShell = winpty === undefined ? inheritedMsysShell(stdio) : undefined;

  // Pi blocks on console setup when it inherits mintty's pipe, so bridge it with
  // winpty. Other agents keep using npm's Unix launcher through inherited bash.
  const launch = winpty ?? (msysShell !== undefined
    ? {
      command: msysShell,
      args: ['-lc', 'exec "$@"', '--', target.command, ...target.args],
    }
    : { command: target.command, args: [...target.args] });
  const child = spawn(launch.command, launch.args, {
    cwd: agent.cwd ?? cwd,
    env: { ...process.env, ...agent.env },
    stdio,
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== null) resolve(code);
      else if (signal === 'SIGINT') resolve(130);
      else resolve(1);
    });
  });
}

async function execute(parsed, outputs) {
  const registry = new AgentRegistry();

  switch (parsed.command) {
    case 'help':
      outputs.log(HELP);
      return 0;
    case 'version':
      outputs.log(VERSION);
      return 0;
    case 'list': {
      const agents = registry.names().map((name) => {
        const agent = registry.resolve(name);
        return {
          name,
          source: agent.source,
          description: agent.description,
          command: agent.command,
          args: agent.args,
          interactiveArgs: agent.interactiveArgs,
        };
      });
      if (parsed.json) {
        outputs.log(JSON.stringify(agents, null, 2));
        return 0;
      }
      outputs.log('AGENT    SOURCE   COMMAND');
      for (const agent of agents) {
        const description = agent.description ? ` # ${agent.description}` : '';
        outputs.log(`${agent.name.padEnd(8)} ${agent.source.padEnd(8)} ${formatCommand(agent.command, agent.args)}${description}`);
      }
      return 0;
    }
    case 'sessions': {
      let sessions = await loadSessions(registry, parsed);
      if (parsed.limit !== undefined) sessions = sessions.slice(0, parsed.limit);
      if (parsed.json) {
        outputs.log(JSON.stringify(sessions, null, 2));
        return 0;
      }
      printSessions(sessions, outputs);
      return 0;
    }
    case 'last': {
      const sessions = await loadSessions(registry, parsed);
      const session = latestSession(sessions);
      if (!session) {
        if (parsed.json) outputs.log('null');
        else outputs.log('No sessions found. Use --all to search every directory.');
        return 0;
      }
      outputs.log(parsed.json ? JSON.stringify(session, null, 2) : [
        `agent:     ${session.agent}`,
        `id:        ${session.id}`,
        `title:     ${session.title ?? ''}`,
        `updated:   ${formatTime(session.updatedAt)}`,
        `cwd:       ${session.cwd ?? ''}`,
        `kind:      ${session.kind}`,
      ].join('\n'));
      return 0;
    }
    case 'resume': {
      const agent = registry.resolve(parsed.name);
      if (agent.session === undefined) {
        throw new Error(
          `agent "${agent.name}" has no session config; add session.provider and resumeArgs `
          + 'to .lash/agents.json',
        );
      }

      let session;
      let launchMode = 'picker';
      if (parsed.last) {
        const sessions = await listAgentSessions(agent, {
          cwd: process.cwd(),
          all: parsed.all,
          archived: parsed.archived,
        });
        session = latestSession(sessions);
        if (!session) throw new Error('no matching session found; try --all');
        launchMode = 'session';
      } else if (parsed.reference !== undefined) {
        if (agent.session.provider === 'manual') {
          if (!isSessionId(parsed.reference)) {
            throw new Error('manual session agents require a UUID session id');
          }
          session = { id: parsed.reference.toLowerCase(), kind: 'interactive' };
        } else {
          const sessions = await listAgentSessions(agent, {
            cwd: process.cwd(),
            all: parsed.all,
            archived: parsed.archived,
          });
          session = resolveSessionRef(sessions, parsed.reference);
        }
        launchMode = 'session';
      }

      return await runAgent(agent, parsed.taskArgs, { launchMode, session });
    }    case 'show':
      outputs.log(JSON.stringify(registry.resolve(parsed.name), null, 2));
      return 0;
    case 'add': {
      const filePath = configPath(parsed.scope, registry);
      const config = readConfigForWrite(filePath);
      config.agents[parsed.name] = {
        command: parsed.commandParts[0],
        ...(parsed.commandParts.length > 1 ? { args: parsed.commandParts.slice(1) } : {}),
      };
      writeConfig(filePath, config);
      outputs.log(`added ${parsed.name} to ${filePath}`);
      return 0;
    }
    case 'remove': {
      const filePath = configPath(parsed.scope, registry);
      const config = readConfigForWrite(filePath);
      if (config.agents[parsed.name] === undefined) {
        if (registry.has(parsed.name)) {
          outputs.log(`no custom ${parsed.name} agent in ${filePath}; built-in/inherited agent remains available`);
          return 0;
        }
        throw new Error(`unknown agent "${parsed.name}"`);
      }
      delete config.agents[parsed.name];
      writeConfig(filePath, config);
      outputs.log(`removed ${parsed.name} from ${filePath}`);
      return 0;
    }
    case 'init': {
      const filePath = configPath(parsed.scope, registry);
      if (fs.existsSync(filePath)) {
        outputs.log(`${filePath} already exists`);
        return 0;
      }
      writeConfig(filePath, { agents: {} });
      outputs.log(`created ${filePath}`);
      return 0;
    }
    case 'path':
      outputs.log(configPath(parsed.scope, registry));
      return 0;
    case 'run': {
      const agent = registry.resolve(parsed.name);
      return await runAgent(agent, parsed.taskArgs);
    }
    case 'chat': {
      const agent = registry.resolve(parsed.name);
      return await runAgent(agent, parsed.taskArgs, { launchMode: 'interactive' });
    }
    default:
      throw new Error(`unknown command ${parsed.command}`);
  }
}

export async function runCli(argv, outputs = { log: console.log, error: console.error }) {
  try {
    return await execute(parseArgv(argv), outputs);
  } catch (error) {
    if (error instanceof UsageError) {
      outputs.error(`lash: ${error.message}\n`);
      outputs.log(HELP);
      return 2;
    }
    const message = error?.code === 'ENOENT'
      ? `agent command not found: ${error.path ?? error.message}`
      : `lash: ${error?.message ?? error}`;
    outputs.error(message);
    return 1;
  }
}

export async function main(argv) {
  process.exitCode = await runCli(argv);
}

export { AgentRegistry, defaultProjectPath, defaultUserPath };
