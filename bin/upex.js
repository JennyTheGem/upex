#!/usr/bin/env node

import { createProgram } from '../src/index.js';

// Shorthand: `upex -` reopens the most recently used shortcut.
const argv = process.argv.slice();
if (argv[2] === '-') argv[2] = 'last';

const program = createProgram();
program.parseAsync(argv);
