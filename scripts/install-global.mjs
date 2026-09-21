#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dependencyMarker = path.join(root, 'node_modules', 'cross-spawn', 'package.json');

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env },
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env },
      });

  if (result.error) {
    throw new Error(`cannot run npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

if (!fs.existsSync(dependencyMarker)) {
  runNpm(['install', '--no-audit', '--no-fund']);
}

runNpm(['link', '--force']);

console.log('lash is installed globally. Try:');
console.log();
console.log('  lash --version');
console.log('  lash list');



