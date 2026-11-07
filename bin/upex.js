#!/usr/bin/env node

import { fastPath } from '../src/fast.js';

// Shorthand: `upex -` reopens the most recently used shortcut.
const argv = process.argv.slice();
if (argv[2] === '-') argv[2] = 'last';

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
