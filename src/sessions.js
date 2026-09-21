import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export class SessionError extends Error {}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function isSessionId(value) {
  return typeof value === 'string' && new RegExp(`^${UUID_PATTERN.source}$`, 'i').test(value);
}

function codexHome(home) {
  if (home !== undefined) return path.join(home, '.codex');
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function claudeConfigDir(home) {
  if (home !== undefined) return path.join(home, '.claude');
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
}

function piSessionRoot(home) {
  if (home !== undefined) return path.join(home, '.pi', 'agent', 'sessions');
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    return path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR);
  }
  if (process.env.PI_CODING_AGENT_DIR) {
    return path.join(path.resolve(process.env.PI_CODING_AGENT_DIR), 'sessions');
  }
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

function walkFiles(root) {
  const files = [];

  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
    }
  }

  visit(root);
  return files;
}

function readJsonLines(filePath) {
  const lines = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Native session files can contain partially written final lines.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return lines;
}

async function readSessionHead(filePath, maximumLines = 120) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const records = [];
  try {
    for await (const line of reader) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines; native CLIs append JSONL incrementally.
      }
      if (records.length >= maximumLines) break;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return records;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((item) => item && typeof item === 'object' && (item.type === 'text' || item.type === 'input_text') && typeof item.text === 'string')
    .map((item) => item.text);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isInternalCodexUserText(value) {
  return typeof value !== 'string'
    || value.startsWith('<environment_context>')
    || value.startsWith('<user_instructions>')
    || value.startsWith('<codex_internal_context>');
}
function normalizeTitle(value) {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact === '' ? undefined : compact;
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function listCodexSessions({ cwd, all, archived, home }) {
  const root = codexHome(home);
  const indexed = new Map();
  const indexPath = path.join(root, 'session_index.jsonl');
  for (const record of readJsonLines(indexPath)) {
    if (!record?.id) continue;
    indexed.set(record.id, record);
  }

  const sessionFiles = [
    ...walkFiles(path.join(root, 'sessions')),
    ...(archived ? walkFiles(path.join(root, 'archived_sessions')) : []),
  ];
  const sessions = [];

  for (const filePath of sessionFiles) {
    const match = path.basename(filePath).match(UUID_PATTERN);
    if (!match) continue;
    const id = match[0].toLowerCase();
    const records = await readSessionHead(filePath);
    const meta = records.find((record) => record?.type === 'session_meta')?.payload;
    if (!meta?.cwd && !indexed.has(id)) continue;

    const firstUser = records.find((record) => (
      record?.type === 'response_item'
      && record?.payload?.type === 'message'
      && record?.payload?.role === 'user'
      && !isInternalCodexUserText(messageText(record.payload.content))
    ))?.payload;
    const index = indexed.get(id);
    const stat = fs.statSync(filePath);
    const updatedAt = index?.updated_at ?? stat.mtime.toISOString();

    sessions.push({
      id,
      agent: 'codex',
      provider: 'codex',
      title: normalizeTitle(index?.thread_name ?? messageText(firstUser?.content)),
      cwd: meta?.cwd,
      createdAt: meta?.timestamp ?? stat.birthtime.toISOString(),
      updatedAt,
      kind: meta?.source === 'exec' ? 'exec' : 'interactive',
      archived: filePath.includes(`${path.sep}archived_sessions${path.sep}`),
      source: filePath,
    });
  }

  return sessions.filter((session) => (all || samePath(session.cwd ?? '', cwd)));
}

async function listClaudeSessions({ cwd, all, home }) {
  const root = claudeConfigDir(home);
  const projectsRoot = path.join(root, 'projects');
  const sessions = [];

  for (const filePath of walkFiles(projectsRoot)) {
    if (path.basename(path.dirname(filePath)) === 'subagents') continue;
    const match = path.basename(filePath).match(UUID_PATTERN);
    if (!match) continue;

    const records = await readSessionHead(filePath);
    const userRecord = records.find((record) => (
      record?.type === 'user'
      && record?.isSidechain !== true
      && (record?.cwd || record?.sessionId)
    ));
    if (!userRecord?.sessionId) continue;

    const stat = fs.statSync(filePath);
    sessions.push({
      id: userRecord.sessionId.toLowerCase(),
      agent: 'claude',
      provider: 'claude',
      title: normalizeTitle(messageText(userRecord.message?.content)),
      cwd: userRecord.cwd,
      createdAt: userRecord.timestamp ?? stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      kind: userRecord.entrypoint === 'claude-cli' ? 'cli' : 'interactive',
      archived: false,
      source: filePath,
    });
  }

  return sessions.filter((session) => (all || samePath(session.cwd ?? '', cwd)));
}

async function listPiSessions({ cwd, all, home }) {
  const sessions = [];

  for (const filePath of walkFiles(piSessionRoot(home))) {
    const records = await readSessionHead(filePath);
    const header = records.find((record) => record?.type === 'session');
    if (typeof header?.id !== 'string' || header.id === '') continue;

    const name = records
      .filter((record) => record?.type === 'session_info' && typeof record.name === 'string')
      .at(-1)?.name;
    const firstUser = records.find((record) => (
      record?.type === 'message'
      && record?.message?.role === 'user'
    ))?.message;
    const stat = fs.statSync(filePath);

    sessions.push({
      id: header.id.toLowerCase(),
      agent: 'pi',
      provider: 'pi',
      title: normalizeTitle(name ?? messageText(firstUser?.content)),
      cwd: header.cwd,
      createdAt: header.timestamp ?? stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      kind: 'interactive',
      archived: false,
      source: filePath,
    });
  }

  return sessions.filter((session) => (all || samePath(session.cwd ?? '', cwd)));
}

export async function listAgentSessions(agent, {
  cwd = process.cwd(),
  all = false,
  archived = false,
  home = undefined,
} = {}) {
  const provider = agent?.session?.provider;
  if (provider === 'codex') return listCodexSessions({ cwd, all, archived, home });
  if (provider === 'claude') return listClaudeSessions({ cwd, all, home });
  if (provider === 'pi') return listPiSessions({ cwd, all, home });
  if (provider === 'manual') return [];
  throw new SessionError(
    `agent "${agent?.name ?? 'unknown'}" does not define session.provider; `
    + 'set it to codex, claude, pi, or manual in its config',
  );
}

export function sortSessions(sessions) {
  return [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function resolveSessionRef(sessions, reference) {
  if (reference.startsWith('#') || /^\d+$/.test(reference)) {
    const index = Number(reference.replace(/^#/, ''));
    if (!Number.isInteger(index) || index < 1) {
      throw new SessionError(`invalid session index "${reference}"`);
    }
    const session = sortSessions(sessions)[index - 1];
    if (!session) throw new SessionError(`session ${reference} was not found`);
    return session;
  }

  const normalized = reference.trim();
  const exact = sessions.filter((session) => session.id.toLowerCase() === normalized.toLowerCase());
  if (exact.length === 1) return exact[0];

  const title = sessions.filter((session) => session.title?.toLowerCase() === normalized.toLowerCase());
  if (title.length === 1) return title[0];

  const prefix = sessions.filter((session) => session.id.toLowerCase().startsWith(normalized.toLowerCase()));
  if (prefix.length === 1) return prefix[0];

  throw new SessionError(
    `session "${reference}" was not found; use an ID, title, #index, or run "lash sessions"`,
  );
}

export function latestSession(sessions) {
  return sortSessions(sessions)[0];
}
