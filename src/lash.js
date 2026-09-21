#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(`lash: ${error?.message ?? error}`);
  process.exitCode = 1;
});


