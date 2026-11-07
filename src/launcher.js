/**
 * launcher.js -- Opens folders in supported apps
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from './store.js';

const platform = os.platform(); // 'win32' | 'darwin' | 'linux'

/**
 * Map of app aliases to their launch commands per platform.
 * Each entry: { cmd, displayName, installHint }
 */
const APP_MAP = {
  vscode: {
    cmd: () => 'code',
    displayName: 'VS Code',
    installHint: 'Install VS Code and add "code" to your PATH.\nhttps://code.visualstudio.com/',
  },
  code: {
    cmd: () => 'code',
    displayName: 'VS Code',
    installHint: 'Install VS Code and add "code" to your PATH.\nhttps://code.visualstudio.com/',
  },
  webstorm: {
    cmd: () => {
      if (platform === 'darwin') return 'open -na "WebStorm" --args';
      return 'webstorm';
    },
    displayName: 'WebStorm',
    installHint: 'Install WebStorm and ensure the CLI launcher is in your PATH.\nhttps://www.jetbrains.com/webstorm/',
  },
  finder: {
    cmd: () => {
      if (platform === 'darwin') return 'open';
      if (platform === 'win32') return 'explorer';
      return 'xdg-open';
    },
    displayName: platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'File Manager',
    installHint: 'This is a system app and should be available by default.',
  },
  explorer: {
    cmd: () => {
      if (platform === 'win32') return 'explorer';
      if (platform === 'darwin') return 'open';
      return 'xdg-open';
    },
    displayName: platform === 'win32' ? 'Explorer' : platform === 'darwin' ? 'Finder' : 'File Manager',
    installHint: 'This is a system app and should be available by default.',
  },
  copy: {
    cmd: () => 'copy',
    displayName: 'Copy path',
    installHint: 'This is a built-in action and should always be available.',
  },
  open: {
    cmd: () => {
      if (platform === 'win32') return 'start';
      if (platform === 'darwin') return 'open';
      return 'xdg-open';
    },
    displayName: 'Default App',
    installHint: 'System default handler; always available.',
  },
  cmd: {
    cmd: () => {
      if (platform === 'win32') return 'cmd';
      if (platform === 'darwin') return 'open -a Terminal';
      return 'x-terminal-emulator';
    },
    displayName: 'Terminal',
    installHint: 'This is a system app and should be available by default.',
  },
  claude: {
    cmd: () => 'claude',
    displayName: 'Claude',
    installHint: 'Install Claude Code and make sure "claude" is on your PATH.\nhttps://claude.com/claude-code',
  },
};

const INTERACTIVE_APP_KEYS = [
  'explorer',
  'vscode',
  'webstorm',
  'cmd',
  'claude',
];

// Openers that open terminal windows (and so take a window count).
export const isTerminalApp = key => key === 'cmd' || key === 'claude';

// Settings in config.json; the first value is the default. Start view, views, sort and pinned are shared by the selector and upex ui; fullScreen, keyHints, maxRows, recentStrip and enter are selector only.
// Layout: separate windows, or tabs/panes in one Windows Terminal window. Shell 'profile' = wt default profile.
export const SETTINGS = {
  // last = the tab (and opener) the selector or upex ui was left on.
  startView: ['shortcuts', 'apps', 'workspaces', 'last'],
  // recent = most used, opened = last opened, added = recently added.
  sort: ['recent', 'name', 'opened', 'added'],
  // The last 3 opened above the list, whatever the sort.
  recentStrip: ['off', 'on'],
  // Tabs shown (selector, upex ui); Shortcuts always is.
  views: ['all', 'no-workspaces', 'no-apps', 'shortcuts'],
  // Selector Enter: open and quit, or open and keep the selector.
  enter: ['quit', 'stay'],
  terminalLayout: ['windows', 'tabs', 'panes'],
  paneSplit: ['auto', 'vertical', 'horizontal'],
  terminalShell: ['cmd', 'powershell', 'pwsh', 'profile'],
  fullScreen: ['on', 'off'],
  // Appearance: theme is upex ui only, the rest also the selector (paths: also upex ls / stale).
  theme: ['system', 'dark', 'light'],
  accent: ['default', 'green', 'blue', 'purple', 'orange'],
  density: ['comfortable', 'compact'],
  paths: ['dim', 'full', 'hidden'],
  // Selector footer: both key rows, one row, or none. Settings always keeps its keys.
  keyHints: ['full', 'short', 'off'],
  // Selector list height; auto = fill in full screen, 8 inline. A dropped 'fill' reads as auto.
  maxRows: ['auto', '8', '12', '16'],
  // Right side of a row (selector, ls, upex ui): #tags, badges (pinned, app, missing), both or none.
  rowDetails: ['both', 'tags', 'badges', 'none'],
  // Pinned shortcuts first, or first under their own Pinned heading (selector, upex ui).
  pinned: ['top', 'section'],
};
// Accent also takes a hex color, stored as #rrggbb.
export const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const valid = (key, v) => SETTINGS[key].includes(v) || (key === 'accent' && isHex(v));
export const setting = (key, config = loadConfig()) => (valid(key, config[key]) ? config[key] : SETTINGS[key][0]);
// Every setting name, defaultOpener included.
export const SETTING_KEYS = [...Object.keys(SETTINGS), 'defaultOpener'];
// Config without these settings (all when none given), so they fall back to their defaults.
export function resetSettings(config, keys = SETTING_KEYS) {
  const out = { ...config };
  for (const k of keys) delete out[k];
  return out;
}
// Tabs the views setting shows, in order.
export const shownTabs = (views = 'all') => ['shortcuts', 'apps', 'workspaces'].filter(t => t === 'shortcuts' || (views !== 'shortcuts' && views !== `no-${t}`));
// Tab to open on: startView, or for 'last' the one saved in lastView (Shortcuts when none or hidden).
export function startTab(config = loadConfig()) {
  const v = setting('startView', config);
  const t = v !== 'last' ? v : config.lastView !== 'last' && SETTINGS.startView.includes(config.lastView) ? config.lastView : 'shortcuts';
  return shownTabs(setting('views', config)).includes(t) ? t : 'shortcuts';
}
// Is wt on PATH? null off Windows, where these settings don't apply.
export const hasWindowsTerminal = () => (platform === 'win32' ? commandExists('wt') : null);

// Quote one wt argument (CommandLineToArgvW rules: \" for inner quotes, double backslashes before a quote).
const wtQuote = s => (/[\s"]/.test(s) || !s ? `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"` : s);

/**
 * Command line for one terminal shell. `quote` wraps a cmd start command for its context.
 * PowerShell gets the command base64-encoded, so no quoting can break it.
 * '' = no command, so wt opens its default profile; with a start command that runs in cmd.
 */
export function shellCommand(shell, runCmd, quote) {
  if (shell === 'powershell' || shell === 'pwsh') {
    return runCmd ? `${shell} -NoExit -EncodedCommand ${Buffer.from(runCmd, 'utf16le').toString('base64')}` : shell;
  }
  if (!runCmd) return shell === 'profile' ? '' : 'cmd';
  return `cmd /s /k ${quote(runCmd)}`;
}

const SPLIT_FLAG = { auto: '', vertical: ' -V', horizontal: ' -H' };

/**
 * Raw wt.exe command line opening `n` shells at `cwd` as tabs or panes in the current
 * (most recent) Windows Terminal window, or in a new window for the 'windows' layout.
 * wt splits sub-commands on `;`, so the user's own `;` is escaped. The start command goes
 * in as one argument: wt re-wraps it in quotes and `cmd /s /k` strips them, so it runs as typed.
 */
export function wtCommandLine(cwd, runCmd, n, layout, shell = 'cmd', split = 'auto') {
  const cmdLine = shellCommand(shell, runCmd, s => wtQuote(s.replace(/;/g, '\\;')));
  const sub = layout === 'panes' ? `split-pane${SPLIT_FLAG[split] || ''}` : 'new-tab';
  const dir = wtQuote(cwd.replace(/;/g, '\\;'));
  const parts = Array.from({ length: n }, (_, i) => `${i ? sub : 'new-tab'} -d ${dir}${cmdLine && ` ${cmdLine}`}`);
  return `-w ${layout === 'windows' ? 'new' : '0'} ${parts.join(' ; ')}`;
}

// config.json `apps` ({ "cursor": "cursor" }) as an object, {} when missing or malformed.
export const configApps = (config = loadConfig()) =>
  (config.apps && typeof config.apps === 'object' && !Array.isArray(config.apps) ? config.apps : {});

// User-defined openers from ~/.upex/config.json.
function customApps() {
  const out = {};
  for (const [name, command] of Object.entries(configApps())) {
    if (typeof command === 'string' && command.trim()) {
      out[name.toLowerCase()] = {
        cmd: () => command,
        displayName: name,
        installHint: `Custom app "${name}" from ~/.upex/config.json (command: ${command}).`,
      };
    }
  }
  return out;
}

// Built-in apps plus any user-defined ones (custom wins on name clash).
function getAppMap() {
  return { ...APP_MAP, ...customApps() };
}

/**
 * Check if a command exists on the system.
 */
function commandExists(cmd) {
  // `where` rejects absolute paths.
  if (path.isAbsolute(cmd)) return fileExists(cmd);
  try {
    const check = platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

// Copy text to the system clipboard via the native platform utility.
export function copyToClipboard(text) {
  const cmd = platform === 'win32' ? 'clip'
    : platform === 'darwin' ? 'pbcopy'
    : process.env.WAYLAND_DISPLAY && commandExists('wl-copy') ? 'wl-copy' : 'xclip -selection clipboard';
  // Keep non-ASCII paths intact: clip reads UTF-16LE whatever the code page, pbcopy needs a UTF-8 locale.
  const input = platform === 'win32' ? Buffer.from(text, 'utf16le') : text;
  const env = platform === 'darwin' ? { ...process.env, LC_CTYPE: 'UTF-8' } : process.env;
  execSync(cmd, { input, env, stdio: ['pipe', 'ignore', 'ignore'], shell: true });
}

// Caret-escape cmd.exe metacharacters the outer shell sees unquoted. `line` starts inside quotes.
export function caretEscape(line) {
  let quoted = true;
  let out = '';
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && '&|<>^'.includes(ch)) out += '^';
    out += ch;
  }
  return out;
}

function quoteIfNeeded(cmd) {
  if (cmd.includes(' ') && !cmd.startsWith('"')) {
    return `"${cmd}"`;
  }
  return cmd;
}

function findFirstExistingFile(paths) {
  return paths.find(fileExists) || null;
}

// Immediate subdirectories of `dir`, newest-named first. Optional name-prefix filter.
function versionDirs(dir, prefix = '') {
  try {
    return fs.readdirSync(dir)
      .filter(name => !prefix || name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(name => path.join(dir, name))
      .filter(p => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

// First bin/webstorm(64).exe found across the given version directories.
function webStormBinIn(dirs) {
  for (const dir of dirs) {
    const found = findFirstExistingFile([
      path.join(dir, 'bin', 'webstorm64.exe'),
      path.join(dir, 'bin', 'webstorm.exe'),
    ]);
    if (found) return found;
  }
  return null;
}

// Find WebStorm binary inside JetBrains Toolbox versioned directories.
function findToolboxWebStormExe(localAppData) {
  const toolboxRoot = path.join(localAppData, 'JetBrains', 'Toolbox', 'apps', 'WebStorm');
  for (const channel of ['ch-0', 'ch-1']) {
    const found = webStormBinIn(versionDirs(path.join(toolboxRoot, channel)));
    if (found) return found;
  }
  return null;
}

// Find WebStorm inside versioned JetBrains install folders (e.g. "WebStorm 2026.1.3").
function findInstalledWebStormExe(roots) {
  for (const root of roots) {
    const found = webStormBinIn(versionDirs(path.join(root, 'JetBrains'), 'WebStorm'));
    if (found) return found;
  }
  return null;
}

// Resolve WebStorm command on Windows even when no `webstorm` CLI launcher exists.
function resolveWindowsWebStormCommand() {
  const pathCandidates = ['webstorm', 'webstorm64.exe', 'webstorm.exe'];
  for (const candidate of pathCandidates) {
    if (commandExists(candidate)) return candidate;
  }

  const config = loadConfig();
  if (config.webstormPath && fileExists(config.webstormPath)) {
    return quoteIfNeeded(config.webstormPath);
  }

  if (process.env.WEBSTORM_PATH && fileExists(process.env.WEBSTORM_PATH)) {
    return quoteIfNeeded(process.env.WEBSTORM_PATH);
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const toolboxExe = localAppData ? findToolboxWebStormExe(localAppData) : null;
  if (toolboxExe) return quoteIfNeeded(toolboxExe);

  // Standard installer puts it in a versioned folder like "JetBrains\WebStorm 2026.1.3".
  const installedExe = findInstalledWebStormExe([programFiles, programFilesX86]);
  if (installedExe) return quoteIfNeeded(installedExe);

  const diskCandidates = [
    path.join(localAppData, 'JetBrains', 'Toolbox', 'scripts', 'webstorm.cmd'),
    path.join(localAppData, 'Programs', 'WebStorm', 'bin', 'webstorm64.exe'),
    path.join(localAppData, 'Programs', 'WebStorm', 'bin', 'webstorm.exe'),
    path.join(programFiles, 'JetBrains', 'WebStorm', 'bin', 'webstorm64.exe'),
    path.join(programFiles, 'JetBrains', 'WebStorm', 'bin', 'webstorm.exe'),
    path.join(programFilesX86, 'JetBrains', 'WebStorm', 'bin', 'webstorm64.exe'),
    path.join(programFilesX86, 'JetBrains', 'WebStorm', 'bin', 'webstorm.exe'),
  ].filter(Boolean);

  const found = findFirstExistingFile(diskCandidates);
  return found ? quoteIfNeeded(found) : null;
}

// The command an opener runs, or { error } when it isn't installed.
function resolveOpener(key, app) {
  let cmdBase = app.cmd();
  // `start` is a cmd.exe builtin, not a resolvable executable.
  let skipCommandCheck = platform === 'win32' && key === 'open';

  if (platform === 'win32' && key === 'webstorm') {
    const resolved = resolveWindowsWebStormCommand();
    if (!resolved) {
      return {
        error: `WebStorm not found. Set "webstormPath" in ~/.upex/config.json or WEBSTORM_PATH env.\n` +
          app.installHint,
      };
    }
    cmdBase = resolved;
    skipCommandCheck = true;
  }

  // For multi-word commands like "open -na ..." we only check the first word
  const cmdBin = cmdBase.startsWith('"')
    ? cmdBase.slice(1).split('"')[0]
    : cmdBase.split(' ')[0];

  if (!skipCommandCheck && !commandExists(cmdBin)) {
    return { error: `Command "${cmdBin}" not found.\n${app.installHint}` };
  }
  return { cmdBase, cmdBin };
}

// Lowercased opener key, or null when no such opener exists.
// Aliases (code, finder) map to the selector's key so it can preselect them.
export function openerKey(name) {
  const key = String(name).toLowerCase();
  const map = getAppMap();
  if (!Object.hasOwn(map, key)) return null;
  const same = (k) => map[k] && map[k].displayName === map[key].displayName && map[k].cmd() === map[key].cmd();
  return INTERACTIVE_APP_KEYS.find(same) || key;
}

// Opener for folder shortcuts without their own: config.defaultOpener, else Explorer. Copy opens nothing.
export function defaultOpener(config = loadConfig()) {
  const key = typeof config.defaultOpener === 'string' && openerKey(config.defaultOpener);
  return key && key !== 'copy' ? key : 'explorer';
}

// Every setting with its current value (defaults filled in), for the Settings tabs.
export function readSettings(config = loadConfig()) {
  const out = Object.fromEntries(Object.keys(SETTINGS).map(k => [k, setting(k, config)]));
  return { ...out, defaultOpener: defaultOpener(config) };
}

// Check a subset of settings. Returns { next } (opener keys normalized) or { error }; for upex ui and upex config.
export function checkSettings(values) {
  const next = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === 'defaultOpener') {
      next[k] = typeof v === 'string' && openerKey(v);
      if (!next[k] || next[k] === 'copy') return { error: `Unknown opener "${v}".` };
    } else if (Object.hasOwn(SETTINGS, k)) {
      // A hex accent may skip the #, which shells read as a comment.
      const hex = k === 'accent' && typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v) && `#${v.replace('#', '').toLowerCase()}`;
      if (!hex && !SETTINGS[k].includes(v)) return { error: `${k} must be one of: ${SETTINGS[k].join(', ')}${k === 'accent' ? ', or a hex color like #ff66aa' : ''}.` };
      next[k] = hex || v;
    } else return { error: `Unknown setting "${k}". Settings: ${SETTING_KEYS.join(', ')}.` };
  }
  return { next };
}

// Is this opener usable here? For `upex doctor`. Copy needs no command.
export function checkOpener(key) {
  const app = getAppMap()[key];
  if (!app) return { ok: false, message: `Unknown opener "${key}".` };
  if (key === 'copy') return { ok: true, command: '(built-in)' };
  const r = resolveOpener(key, app);
  return r.error ? { ok: false, message: r.error } : { ok: true, command: r.cmdBase };
}

/**
 * Launch a folder in the specified app.
 * @param {number} [count] - how many windows to open (only honored for the terminal opener)
 * @returns {{ ok: boolean, message?: string }}
 */
export function launchApp(appName, folderPath, count = 1, startCmd = '') {
  const key = appName.toLowerCase();
  const appMap = getAppMap();
  const app = Object.hasOwn(appMap, key) && appMap[key];

  if (!app) {
    const supported = [...new Set(Object.keys(appMap))].join(', ');
    return {
      ok: false,
      message: `Unknown app "${appName}". Supported: ${supported}`,
    };
  }

  const targetIsFile = fileExists(folderPath) && (() => {
    try { return fs.statSync(folderPath).isFile(); } catch { return false; }
  })();

  // Copy action: put the path on the clipboard instead of launching an app.
  if (key === 'copy') {
    try {
      copyToClipboard(folderPath);
      return { ok: true, displayName: app.displayName, message: `Copied --> ${folderPath}` };
    } catch (err) {
      return { ok: false, message: `Failed to copy path: ${err.message}` };
    }
  }

  const resolvedCmd = resolveOpener(key, app);
  if (resolvedCmd.error) return { ok: false, message: resolvedCmd.error };
  let { cmdBase } = resolvedCmd;
  const { cmdBin } = resolvedCmd;

  // Claude runs inside a terminal window.
  if (key === 'claude') cmdBase = APP_MAP.cmd.cmd();
  const runCmd = key === 'claude' ? `claude ${startCmd}`.trim() : startCmd;

  // Some apps (e.g. explorer.exe on Windows) return non-zero exit codes
  // even on success. We need special handling for system file managers.
  const isSystemFileManager = key !== 'open' && (['explorer', 'finder'].includes(key) ||
    (cmdBin === 'explorer' || cmdBin === 'open' || cmdBin === 'xdg-open'));

  const isTerminal = isTerminalApp(key);
  const repeat = isTerminal ? Math.min(9, Math.max(1, Math.floor(count) || 1)) : 1;
  // A terminal at a file means "sit in that file's folder".
  const terminalCwd = targetIsFile ? path.dirname(folderPath) : folderPath;

  // Windows terminal settings. The default profile needs wt; without it, cmd.
  let win;
  if (platform === 'win32' && isTerminal) {
    const config = loadConfig();
    const layout = setting('terminalLayout', config);
    let shell = setting('terminalShell', config);
    const wt = (layout !== 'windows' || shell === 'profile') && hasWindowsTerminal();
    if (shell === 'profile' && !wt) shell = 'cmd';
    if (shell !== 'cmd' && shell !== 'profile' && !commandExists(shell)) {
      return { ok: false, message: `Shell "${shell}" not found. Pick another one on the Settings tab (upex ui, or Shift+Tab in upex).` };
    }
    win = { layout, shell, wt, split: setting('paneSplit', config) };
  }

  try {
    if (win?.wt) {
      // One wt call per window. Verbatim: wt parses its own command line; no shell in between.
      const calls = win.layout === 'windows' ? Array(repeat).fill(1) : [repeat];
      for (const n of calls) {
        const r = spawnSync('wt', [wtCommandLine(terminalCwd, runCmd, n, win.layout, win.shell, win.split)],
          { stdio: 'ignore', windowsVerbatimArguments: true });
        if (r.error) throw r.error;
      }
    } else if (win) {
      // Open N independent console windows at the target path.
      // `start` gives each its own console and returns immediately, so the
      // window outlives upex. Run it synchronously (no `detached`) to avoid
      // CREATE_NEW_PROCESS_GROUP, which would disable Ctrl+C inside the window.
      // `cmd /k <start>` runs the start command and keeps the window open.
      // Quoted with /s so && and | run in the new window, not in this shell;
      // carets cover the parts the user quoted themselves ("a & b").
      const inner = shellCommand(win.shell, runCmd, s => `"${caretEscape(s)}"`);
      for (let i = 0; i < repeat; i++) {
        execSync(`start "" ${inner}`, { cwd: terminalCwd, stdio: 'ignore' });
      }
    } else if (isTerminal && platform === 'darwin') {
      // Open Terminal.app at the dir, optionally run a command, keep it open.
      const script = runCmd
        ? `cd ${JSON.stringify(terminalCwd)} && ${runCmd}`
        : `cd ${JSON.stringify(terminalCwd)}`;
      for (let i = 0; i < repeat; i++) {
        spawnSync('osascript', [
          '-e', 'tell application "Terminal" to do script ' + JSON.stringify(script),
          '-e', 'tell application "Terminal" to activate',
        ], { stdio: 'ignore' });
      }
    } else if (isTerminal) {
      // Linux: cd into the dir, run the command, keep the shell open.
      const inner = `cd ${JSON.stringify(terminalCwd)}; ${runCmd ? runCmd + '; ' : ''}exec "\${SHELL:-bash}"`;
      for (let i = 0; i < repeat; i++) {
        const r = spawnSync(cmdBase, ['-e', 'sh', '-c', inner], { stdio: 'ignore' });
        if (r.error) throw r.error;
      }
    } else if (key === 'open') {
      // Open the path in the OS default handler (default app for a file).
      if (platform === 'win32') {
        execSync('start "" ' + `"${folderPath}"`, { stdio: 'ignore' });
      } else {
        execSync(`${cmdBase} "${folderPath}"`, { stdio: 'ignore' });
      }
    } else if (platform === 'win32' && key === 'webstorm') {
      // Run WebStorm detached on Windows (works for PATH command or absolute exe/cmd path).
      spawn(cmdBase, [folderPath], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      }).unref();
    } else if (isSystemFileManager) {
      // Reveal the file in its folder, or just open a folder directly.
      if (platform === 'win32') {
        const args = targetIsFile ? ['/select,', folderPath] : [folderPath];
        spawn('explorer', args, { detached: true, stdio: 'ignore', shell: false }).unref();
      } else if (platform === 'darwin') {
        execSync(`${cmdBase} ${targetIsFile ? '-R ' : ''}"${folderPath}"`, { stdio: 'ignore' });
      } else {
        const target = targetIsFile ? path.dirname(folderPath) : folderPath;
        execSync(`${cmdBase} "${target}"`, { stdio: 'ignore' });
      }
    } else {
      const fullCmd = `${cmdBase} "${folderPath}"`;
      for (let i = 0; i < repeat; i++) execSync(fullCmd, { stdio: 'ignore' });
    }
    return {
      ok: true,
      displayName: app.displayName,
      message: `${app.displayName}${repeat > 1 ? ` x${repeat}` : ''}${startCmd ? ` (${startCmd})` : ''} --> ${folderPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to open with ${app.displayName}: ${err.message}`,
    };
  }
}

// Prefix a bare host with https:// so "github.com" is a valid URL.
export function normalizeUrl(url) {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Open a URL in the system default browser.
 */
export function launchUrl(url) {
  const target = normalizeUrl(url);
  try {
    if (platform === 'win32') execSync(`start "" "${target}"`, { stdio: 'ignore' });
    else if (platform === 'darwin') execSync(`open "${target}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${target}"`, { stdio: 'ignore' });
    return { ok: true, displayName: 'Browser', url: target };
  } catch (err) {
    return { ok: false, message: `Failed to open URL: ${err.message}` };
  }
}

export function getInteractiveAppChoices() {
  const appMap = getAppMap();
  const keys = [...INTERACTIVE_APP_KEYS, ...Object.keys(customApps())];
  return keys
    .filter(key => appMap[key])
    .map(key => ({ key, label: appMap[key].displayName }));
}

export { APP_MAP, getAppMap };

/**
 * Launch an arbitrary executable (for app shortcuts).
 * @param {string} exePath - command name or absolute path to the executable
 * @returns {{ ok: boolean, displayName: string, message?: string }}
 */
export function launchExecutable(exePath) {
  try {
    let child;

    if (platform === 'win32' && /\.(bat|cmd)$/i.test(exePath)) {
      // .bat/.cmd files must run via cmd.exe with cwd set to the batch file's
      // own directory so that relative paths inside the script resolve correctly.
      // windowsHide suppresses the intermediate cmd.exe console window.
      child = spawn('cmd.exe', ['/c', exePath], {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
        cwd: path.dirname(exePath),
      });
    } else {
      // Quote only a real file path with spaces; anything else is a command line with args.
      const cmd = exePath.includes(' ') && !exePath.startsWith('"') && fileExists(exePath) ? `"${exePath}"` : exePath;
      child = spawn(cmd, [], {
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: true,
      });
    }

    child.unref();

    const displayName = path.basename(exePath).replace(/\.[^.]+$/, '');
    return { ok: true, displayName };
  } catch (err) {
    return { ok: false, displayName: exePath, message: `FAIL launch: ${err.message}` };
  }
}

