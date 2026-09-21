import assert from 'node:assert/strict';
import test from 'node:test';
import { VERSION, runCli } from '../src/index.js';

test('public package API exposes the current version', async () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  const lines = [];
  const code = await runCli(['--version'], { log: (value) => lines.push(value), error: () => {} });
  assert.equal(code, 0);
  assert.equal(lines[0], VERSION);
});
