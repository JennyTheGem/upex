/**
 * launcher.js — Opens folders in supported apps
 */

import { execSync, spawn } from 'node:child_process';
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
  cursor: {
    cmd: () => 'cursor',
    displayName: 'Cursor',
    installHint: 'Install Cursor and add it to your PATH.\nhttps://cursor.sh/',
  },
  zed: {
    cmd: () => 'zed',
    displayName: 'Zed',
    installHint: 'Install Zed editor.\nhttps://zed.dev/',
  },
  sublime: {
    cmd: () => 'subl',
    displayName: 'Sublime Text',
    installHint: 'Install Sublime Text and add "subl" to your PATH.\nhttps://www.sublimetext.com/',
  },
  subl: {
    cmd: () => 'subl',
    displayName: 'Sublime Text',
    installHint: 'Install Sublime Text and add "subl" to your PATH.\nhttps://www.sublimetext.com/',
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
  nautilus: {
    cmd: () => 'nautilus',
    displayName: 'Nautilus',
    installHint: 'Install Nautilus (GNOME Files): sudo apt install nautilus',
  },
  cmd: {
    cmd: () => {
      if (platform === 'win32') return 'cmd';
      if (platform === 'darwin') return 'open -a Terminal';
      return 'x-terminal-emulator';
    },
    displayName: platform === 'win32' ? 'Command Prompt' : 'Terminal',
    installHint: 'This is a system app and should be available by default.',
  },
};

const INTERACTIVE_APP_KEYS = [
  'explorer',
  'vscode',
  'webstorm',
  'cursor',
  'zed',
  'sublime',
  'cmd',
  'nautilus',
];

/**
 * Check if a command exists on the system.
 */
function commandExists(cmd) {
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

function quoteIfNeeded(cmd) {
  if (cmd.includes(' ') && !cmd.startsWith('"')) {
    return `"${cmd}"`;
  }
  return cmd;
}

function findFirstExistingFile(paths) {
  return paths.find(fileExists) || null;
}

// Find WebStorm binary inside JetBrains Toolbox versioned directories.
function findToolboxWebStormExe(localAppData) {
  const toolboxRoot = path.join(localAppData, 'JetBrains', 'Toolbox', 'apps', 'WebStorm');
  if (!fileExists(toolboxRoot)) return null;

  const channelDirs = ['ch-0', 'ch-1'];
  for (const channel of channelDirs) {
    const channelPath = path.join(toolboxRoot, channel);
    if (!fileExists(channelPath)) continue;

    let versions = [];
    try {
      versions = fs.readdirSync(channelPath)
        .map(name => path.join(channelPath, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.localeCompare(a));
    } catch {
      versions = [];
    }

    for (const versionDir of versions) {
      const candidates = [
        path.join(versionDir, 'bin', 'webstorm64.exe'),
        path.join(versionDir, 'bin', 'webstorm.exe'),
      ];
      const found = findFirstExistingFile(candidates);
      if (found) return found;
    }
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

/**
 * Launch a folder in the specified app.
 * @returns {{ ok: boolean, message?: string }}
 */
export function launchApp(appName, folderPath) {
  const key = appName.toLowerCase();
  const app = APP_MAP[key];

  if (!app) {
    const supported = [...new Set(Object.keys(APP_MAP))].join(', ');
    return {
      ok: false,
      message: `Unknown app "${appName}". Supported: ${supported}`,
    };
  }

  let cmdBase = app.cmd();
  let skipCommandCheck = false;

  if (platform === 'win32' && key === 'webstorm') {
    const resolved = resolveWindowsWebStormCommand();
    if (!resolved) {
      return {
        ok: false,
        message:
          `WebStorm not found. Set "webstormPath" in ~/.upex/config.json or WEBSTORM_PATH env.\n` +
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
    return {
      ok: false,
      message: `Command "${cmdBin}" not found.\n${app.installHint}`,
    };
  }

  // Some apps (e.g. explorer.exe on Windows) return non-zero exit codes
  // even on success. We need special handling for system file managers.
  const isSystemFileManager = ['explorer', 'finder'].includes(key) ||
    (cmdBin === 'explorer' || cmdBin === 'open' || cmdBin === 'xdg-open');

  const isTerminal = key === 'cmd';

  try {
    if (platform === 'win32' && isTerminal) {
      // Open a new Command Prompt window with cwd set to the target path.
      // Using cwd option avoids all path-escaping issues.
      spawn('cmd.exe', ['/c', 'start', '""', 'cmd'], {
        cwd: folderPath,
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (platform === 'win32' && key === 'webstorm') {
      // Run WebStorm detached on Windows (works for PATH command or absolute exe/cmd path).
      spawn(cmdBase, [folderPath], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      }).unref();
    } else if (isSystemFileManager) {
      // Use spawn with detached so the file manager opens independently
      // and we don't care about the exit code
      if (platform === 'win32') {
        spawn('explorer', [folderPath], {
          detached: true,
          stdio: 'ignore',
          shell: false,
        }).unref();
      } else {
        const fullCmd = `${cmdBase} "${folderPath}"`;
        execSync(fullCmd, { stdio: 'ignore' });
      }
    } else {
      const fullCmd = `${cmdBase} "${folderPath}"`;
      execSync(fullCmd, { stdio: 'ignore' });
    }
    return {
      ok: true,
      displayName: app.displayName,
      message: `${app.displayName} --> ${folderPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to open with ${app.displayName}: ${err.message}`,
    };
  }
}

export function getSupportedApps() {
  return [...new Set(Object.entries(APP_MAP).map(([, v]) => v.displayName))];
}

export function getInteractiveAppChoices() {
  return INTERACTIVE_APP_KEYS
    .filter(key => APP_MAP[key])
    .map(key => ({
      key,
      label: APP_MAP[key].displayName,
    }));
}

export { APP_MAP };

/**
 * Launch an arbitrary executable (for app shortcuts).
 * @param {string} exePath - command name or absolute path to the executable
 * @returns {{ ok: boolean, displayName: string, message?: string }}
 */
export function launchExecutable(exePath) {
  try {
    const cmd = exePath.includes(' ') && !exePath.startsWith('"') ? `"${exePath}"` : exePath;
    spawn(cmd, [], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    }).unref();

    const displayName = path.basename(exePath).replace(/\.[^.]+$/, '');
    return { ok: true, displayName };
  } catch (err) {
    return { ok: false, displayName: exePath, message: `FAIL launch: ${err.message}` };
  }
}

