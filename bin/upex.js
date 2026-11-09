#!/usr/bin/env node

import { fastPath } from '../src/fast.js';
import { setDryRun } from '../src/store.js';

// Shorthand: `upex -` reopens the most recently used shortcut.
const argv = process.argv.slice();
if (argv[2] === '-') argv[2] = 'last';

// --dry-run anywhere (not in go, whose args are a command): print what would launch, run nothing.
const dryAt = argv[2] === 'go' ? -1 : argv.indexOf('--dry-run', 2);
if (dryAt > 0) {
  argv.splice(dryAt, 1);
  setDryRun();
  const { default: chalk } = await import('chalk');
  // stderr: stdout stays clean for --json and the cd wrappers.
  process.on('exit', () => console.error(chalk.dim('  dry run, nothing ran')));
}

// cd via the wrappers skips loading commander and every command.
if (!fastPath(argv.slice(2))) {
  const [{ createProgram }, { StoreError }, ui] = await Promise.all([
    import('../src/index.js'), import('../src/store.js'), import('../src/ui.js'),
  ]);
  createProgram().parseAsync(argv).catch((err) => {
    if (!(err instanceof StoreError)) throw err;
    ui.error(err.message);
    process.exit(1);
  });
}
