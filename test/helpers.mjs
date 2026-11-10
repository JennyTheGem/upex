// Imported first by every test file, so its process gets a temp home before src/ loads
// (store.js and rows.js read the home at import). No test touches the real ~/.upex.
// Not a test file: npm test lists the *.test.mjs files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-test-'));
process.env.HOME = process.env.USERPROFILE = home;
// node --test sets FORCE_COLOR in a terminal; CLI output under test stays plain, as in CI.
delete process.env.FORCE_COLOR;
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

export const cli = fileURLToPath(new URL('../bin/upex.js', import.meta.url));
// Runs the CLI; it inherits the temp home through process.env.
export const run = (args, opts) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', ...opts });
