#!/usr/bin/env node

import { createProgram } from '../src/index.js';
import { StoreError } from '../src/store.js';
import * as ui from '../src/ui.js';

// Shorthand: `upex -` reopens the most recently used shortcut.
const argv = process.argv.slice();
if (argv[2] === '-') argv[2] = 'last';

const program = createProgram();
program.parseAsync(argv).catch((err) => {
  if (!(err instanceof StoreError)) throw err;
  ui.error(err.message);
  process.exit(1);
});
