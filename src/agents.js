import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class AgentError extends Error {}

export const BUILTIN_AGENTS = Object.freeze({
  codex: Object.freeze({
    command: 'codex',
    args: ['exec', '--skip-git-repo-check', '--color', 'never'],
    interactiveArgs: [],
    env: { NO_COLOR: '1' },
    description: 'OpenAI Codex CLI (one-shot task mode)',
    session: Object.freeze({
      provider: 'codex',
      pickerArgs: ['resume'],
      lastArgs: ['resume', '--last'],
      resumeArgs: ['resume', '{sessionId}'],
      execResumeArgs: [
        'exec',
        '--skip-git-repo-check',
        '--color',
        'never',
        'resume',
        '{sessionId}',
      ],
    }),
  }),
  claude: Object.freeze({
    command: 'claude',
    args: [],
    interactiveArgs: [],
    description: 'Claude Code CLI',
    session: Object.freeze({
      provider: 'claude',
      pickerArgs: ['--resume'],
      lastArgs: ['--continue'],
      resumeArgs: ['--resume', '{sessionId}'],
    }),
  }),
});

const AGENT_KEYS = new Set([
  'extends',
  'command',
  'args',
  'interactiveArgs',
  'appendArgs',
  'appendInteractiveArgs',
  'env',
  'cwd',
  'description',
  'session',
]);

const SESSION_KEYS = new Set([
  'provider',
  'command',
  'pickerArgs',
  'lastArgs',
  'resumeArgs',
  'execResumeArgs',
]);

const SESSION_PROVIDERS = new Set(['codex', 'claude', 'manual']);

function readJson(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new AgentError(`cannot read ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new AgentError(`invalid JSON in ${filePath}: ${error.message}`);
  }
}

function assertStringArray(value, source, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AgentError(`${source}: agents.${field} must be an array of strings`);
  }
}

function validateSession(session, source, name) {
  if (session === null || typeof session !== 'object' || Array.isArray(session)) {
    throw new AgentError(`${source}: agents.${name}.session must be an object`);
  }

  const unknown = Object.keys(session).filter((key) => !SESSION_KEYS.has(key));
  if (unknown.length > 0) {
    throw new AgentError(`${source}: agents.${name}.session has unknown field ${unknown.join(', ')}`);
  }

  if (session.provider !== undefined) {
    if (typeof session.provider !== 'string' || !SESSION_PROVIDERS.has(session.provider)) {
      throw new AgentError(
        `${source}: agents.${name}.session.provider must be one of ${[...SESSION_PROVIDERS].join(', ')}`,
      );
    }
  }
  if (session.command !== undefined && (typeof session.command !== 'string' || session.command === '')) {
    throw new AgentError(`${source}: agents.${name}.session.command must be a non-empty string`);
  }
  for (const field of ['pickerArgs', 'lastArgs', 'resumeArgs', 'execResumeArgs']) {
    if (session[field] !== undefined) {
      assertStringArray(session[field], source, `${name}.session.${field}`);
    }
  }
}

export function validateConfig(config, source) {
  if (config === undefined) return { agents: {} };
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new AgentError(`${source}: config must be a JSON object`);
  }

  const unknownTopLevel = Object.keys(config).filter((key) => key !== 'agents');
  if (unknownTopLevel.length > 0) {
    throw new AgentError(`${source}: unknown top-level field ${unknownTopLevel.join(', ')}`);
  }

  const { agents } = config;
  if (agents === undefined) return { agents: {} };
  if (agents === null || typeof agents !== 'object' || Array.isArray(agents)) {
    throw new AgentError(`${source}: agents must be an object`);
  }

  for (const [name, agent] of Object.entries(agents)) {
    if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) {
      throw new AgentError(`${source}: agents.${name} must be an object`);
    }

    const unknown = Object.keys(agent).filter((key) => !AGENT_KEYS.has(key));
    if (unknown.length > 0) {
      throw new AgentError(`${source}: agents.${name} has unknown field ${unknown.join(', ')}`);
    }

    if (agent.extends !== undefined && typeof agent.extends !== 'string') {
      throw new AgentError(`${source}: agents.${name}.extends must be a string`);
    }
    if (agent.command !== undefined && (typeof agent.command !== 'string' || agent.command === '')) {
      throw new AgentError(`${source}: agents.${name}.command must be a non-empty string`);
    }
    for (const field of ['args', 'interactiveArgs', 'appendArgs', 'appendInteractiveArgs']) {
      if (agent[field] !== undefined) assertStringArray(agent[field], source, `${name}.${field}`);
    }
    if (agent.env !== undefined) {
      if (agent.env === null || typeof agent.env !== 'object' || Array.isArray(agent.env)) {
        throw new AgentError(`${source}: agents.${name}.env must be an object`);
      }
      for (const [key, value] of Object.entries(agent.env)) {
        if (typeof value !== 'string') {
          throw new AgentError(`${source}: agents.${name}.env.${key} must be a string`);
        }
      }
    }
    if (agent.cwd !== undefined && typeof agent.cwd !== 'string') {
      throw new AgentError(`${source}: agents.${name}.cwd must be a string`);
    }
    if (agent.description !== undefined && typeof agent.description !== 'string') {
      throw new AgentError(`${source}: agents.${name}.description must be a string`);
    }
    if (agent.session !== undefined) validateSession(agent.session, source, name);
  }

  return { agents };
}

export class AgentRegistry {
  constructor({ projectPath, userPath } = {}) {
    this.projectPath = projectPath ?? defaultProjectPath();
    this.userPath = userPath ?? defaultUserPath();
    this.entries = new Map();

    for (const [name, definition] of Object.entries(BUILTIN_AGENTS)) {
      this.entries.set(name, { source: 'built-in', definition });
    }

    this.userConfig = validateConfig(readJson(this.userPath), this.userPath);
    for (const [name, definition] of Object.entries(this.userConfig.agents)) {
      this.entries.set(name, { source: 'user', definition });
    }

    this.projectConfig = validateConfig(readJson(this.projectPath), this.projectPath);
    for (const [name, definition] of Object.entries(this.projectConfig.agents)) {
      this.entries.set(name, { source: 'project', definition });
    }
  }

  has(name) {
    return this.entries.has(name);
  }

  names() {
    return [...this.entries.keys()].sort((a, b) => a.localeCompare(b));
  }

  resolve(name) {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new AgentError(`unknown agent "${name}"; run "lash list" or add it with "lash add"`);
    }
    return this.#resolveDefinition(name, entry, new Set());
  }

  #resolveDefinition(name, entry, visiting) {
    if (visiting.has(name)) {
      throw new AgentError(`inheritance cycle detected at "${name}"`);
    }
    visiting.add(name);

    try {
      const definition = entry.definition;
      let base = { args: [], interactiveArgs: [], env: {} };
      if (definition.extends !== undefined) {
        const parentEntry = this.entries.get(definition.extends);
        if (!parentEntry) {
          throw new AgentError(`agent "${name}" extends unknown agent "${definition.extends}"`);
        }
        base = this.#resolveDefinition(definition.extends, parentEntry, visiting);
      }

      const args = definition.args ?? [...base.args, ...(definition.appendArgs ?? [])];
      const interactiveArgs = definition.interactiveArgs
        ?? [...base.interactiveArgs, ...(definition.appendInteractiveArgs ?? [])];
      const command = definition.command ?? base.command;
      if (command === undefined) {
        throw new AgentError(`agent "${name}" needs a command`);
      }

      const session = definition.session !== undefined || base.session !== undefined
        ? {
          ...(base.session ?? {}),
          ...(definition.session ?? {}),
        }
        : undefined;

      return {
        name,
        source: entry.source,
        description: definition.description ?? base.description,
        command,
        args,
        interactiveArgs,
        env: { ...base.env, ...definition.env },
        ...(session !== undefined ? { session } : {}),
        ...(definition.cwd !== undefined || base.cwd !== undefined
          ? { cwd: definition.cwd ?? base.cwd }
          : {}),
      };
    } finally {
      visiting.delete(name);
    }
  }
}

export function defaultProjectPath(cwd = process.cwd()) {
  return path.join(cwd, '.lash', 'agents.json');
}

export function defaultUserPath(home = os.homedir()) {
  return path.join(home, '.lash', 'agents.json');
}
