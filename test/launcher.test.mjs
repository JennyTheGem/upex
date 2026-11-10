import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { installCmdWrapper } from '../src/commands/setup.js';
import { normalizeUrl, caretEscape, wtCommandLine, shellCommand, defaultOpener } from '../src/launcher.js';
import { setting } from '../src/settings.js';

test('cmd wrapper: batch file that cds via go/__resolve', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-'));
  const bat = installCmdWrapper(dir);
  const body = fs.readFileSync(bat, 'utf-8');
  assert.ok(body.startsWith('@echo off'), 'wrapper is a batch script');
  assert.ok(body.includes('__resolve') && body.includes('cd /d'), 'wrapper cds through resolve');
  assert.ok(body.includes('goto :cd'), 'wrapper handles upex cd');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeUrl: bare host gets https, real scheme kept', () => {
  assert.equal(normalizeUrl('github.com'), 'https://github.com', 'bare host gets https');
  assert.equal(normalizeUrl('http://x.dev'), 'http://x.dev', 'existing scheme preserved');
});

test('caretEscape: cmd.exe metachars inside the user\'s own quotes survive the outer shell', () => {
  assert.equal(caretEscape('cd x && echo "a & b|c"'), 'cd x && echo "a ^& b^|c"', 'only user-quoted metachars escaped');
  if (process.platform === 'win32') {
    // Same quote layout as `start "" cmd /s /k "<line>"`, but /c so no window opens.
    const line = 'echo "a & b" && echo two';
    const out = execSync(`cmd /s /c "${caretEscape(line)}"`, { encoding: 'utf-8' }).split(/\r?\n/).map(s => s.trim());
    assert.deepEqual(out.slice(0, 2), ['"a & b"', 'two'], 'cmd.exe runs the line as typed');
  }
});

test('wt: N shells in one wt call; trailing backslash, user `;` and quotes survive wt\'s parser', () => {
  assert.equal(wtCommandLine('C:\\a b\\', '', 2, 'tabs'), String.raw`-w 0 new-tab -d "C:\a b\\" cmd ; new-tab -d "C:\a b\\" cmd`, 'tabs, quoted dir');
  assert.equal(wtCommandLine(String.raw`C:\x`, 'a; b', 2, 'panes'), String.raw`-w 0 new-tab -d C:\x cmd /s /k "a\; b" ; split-pane -d C:\x cmd /s /k "a\; b"`, 'panes, escaped ;');
  assert.equal(wtCommandLine(String.raw`C:\x`, String.raw`code "C:\a b\" && x`, 1, 'tabs'), String.raw`-w 0 new-tab -d C:\x cmd /s /k "code \"C:\a b\\\" && x"`, 'start cmd is one arg, inner quotes escaped');
  assert.equal(wtCommandLine(String.raw`C:\x`, 'claude', 1, 'tabs'), String.raw`-w 0 new-tab -d C:\x cmd /s /k claude`, 'plain start cmd unquoted');
  assert.equal(wtCommandLine(String.raw`C:\x`, '', 2, 'panes', 'cmd', 'vertical'), String.raw`-w 0 new-tab -d C:\x cmd ; split-pane -V -d C:\x cmd`, 'pane split direction');
  assert.equal(wtCommandLine(String.raw`C:\x`, '', 1, 'windows', 'profile'), String.raw`-w new new-tab -d C:\x`, 'default profile: no command, own window');
  assert.equal(wtCommandLine(String.raw`C:\x`, 'claude', 1, 'tabs', 'profile'), String.raw`-w 0 new-tab -d C:\x cmd /s /k claude`, 'default profile + start command runs in cmd');
  const ps = shellCommand('pwsh', 'echo "a; b" & x', s => s);
  assert.equal(Buffer.from(ps.split(' ').pop(), 'base64').toString('utf16le'), 'echo "a; b" & x', 'powershell start command round-trips');
  assert.ok(ps.startsWith('pwsh -NoExit -EncodedCommand ') && !/[\s;"]/.test(ps.split(' ').pop()), 'encoded command has nothing to quote');
  assert.equal(shellCommand('powershell', '', s => s), 'powershell', 'plain powershell');
  assert.equal(setting('terminalLayout', { terminalLayout: 'bogus' }), 'here', 'unknown layout falls back to here');
  assert.equal(setting('terminalShell', {}), 'cmd', 'shell defaults to cmd');
  assert.equal(setting('startView', { startView: 'nope' }), 'shortcuts', 'start view defaults to shortcuts');
});

test('default opener: alias normalized, unknown and copy fall back to explorer', () => {
  assert.equal(defaultOpener({ defaultOpener: 'Code' }), 'vscode', 'default opener alias normalized');
  assert.equal(defaultOpener({ defaultOpener: 'nope' }), 'explorer', 'unknown default opener falls back to explorer');
  assert.equal(defaultOpener({ defaultOpener: 'copy' }), 'explorer', 'copy is no default opener');
});
