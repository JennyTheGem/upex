/**
 * setup.js -- Show shell integration instructions.
 * Usage: upex setup
 */

import chalk from 'chalk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as ui from '../ui.js';

const BASH_ZSH_FUNCTION = `# ~/.bashrc or ~/.zshrc
upex() {
  if [ "$1" = "go" ] && [ -n "$2" ]; then
    if result=$(command upex go "$2" 2>/dev/null) && cd "$result"; then
      shift 2
      [ $# -eq 0 ] || "$@"
      return
    fi
  fi
  if [ "$1" != "" ] && [ "$2" = "" ] && result=$(command upex __resolve "$1" 2>/dev/null); then
    cd "$result"
  else
    command upex "$@"
  fi
}`;

const POWERSHELL_FUNCTION = `# PowerShell profile ($PROFILE)
function upex {
  if ($args.Count -ge 2 -and $args[0] -eq 'go') {
    $result = & upex.ps1 go $args[1] 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) {
      Set-Location $result
      $rest = @($args | Select-Object -Skip 2)
      if ($rest.Count) { Invoke-Expression ($rest -join ' ') }
      return
    }
  }
  if ($args.Count -eq 1) {
    $result = & upex.ps1 __resolve $args[0] 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) {
      Set-Location $result
      return
    }
  }
  & upex.ps1 @args
}`;

const FISH_FUNCTION = `# ~/.config/fish/functions/upex.fish
function upex
  if test (count $argv) -ge 2; and test "$argv[1]" = "go"
    set result (command upex go $argv[2] 2>/dev/null)
    if test $status -eq 0; and test -n "$result"
      cd $result
      if test (count $argv) -gt 2
        $argv[3..-1]
      end
      return
    end
  end
  if test (count $argv) -eq 1
    set result (command upex __resolve $argv[1] 2>/dev/null)
    if test $status -eq 0; and test -n "$result"
      cd $result
      return
    end
  end
  command upex $argv
end`;

// cmd.exe has no profile functions. Instead, an upex.bat placed next to the
// npm upex.cmd shim wins PATH resolution (.bat before .cmd in PATHEXT), and a
// cd inside a batch file persists in the parent shell.
const CMD_WRAPPER = [
  '@echo off',
  'rem upex cmd.exe wrapper (installed by "upex setup cmd").',
  'if /i "%~1"=="go" if not "%~2"=="" goto :go',
  'if not "%~1"=="" if "%~2"=="" goto :single',
  'goto :pass',
  '',
  ':go',
  'for /f "usebackq delims=" %%D in (`call "%~dp0upex.cmd" go "%~2" 2^>nul`) do cd /d "%%D" & goto :gorun',
  'call "%~dp0upex.cmd" go "%~2"',
  'exit /b',
  '',
  ':gorun',
  'rem any args after the name run as a command here (upex go vel npm run dev)',
  'shift',
  'shift',
  'if "%~1"=="" exit /b',
  'set "UPEX_RUN=%1"',
  ':gocollect',
  'shift',
  'if not "%~1"=="" set "UPEX_RUN=%UPEX_RUN% %1" & goto :gocollect',
  'call %UPEX_RUN%',
  'set "UPEX_RUN="',
  'exit /b',
  '',
  ':single',
  'for /f "usebackq delims=" %%D in (`call "%~dp0upex.cmd" __resolve "%~1" 2^>nul`) do cd /d "%%D" & exit /b',
  ':pass',
  'call "%~dp0upex.cmd" %*',
  '',
].join('\r\n');

export function installCmdWrapper(dir) {
  const target = path.join(dir, 'upex.bat');
  fs.writeFileSync(target, CMD_WRAPPER);
  return target;
}

function findShimDir() {
  try {
    const out = execSync('where upex.cmd', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    return first ? path.dirname(first) : null;
  } catch {
    return null;
  }
}

export function registerSetup(program) {
  program
    .command('setup [shell]')
    .description('Shell integration for cd support ("setup cmd" installs the cmd.exe wrapper)')
    .summary('Shell integration ("setup cmd": cmd.exe wrapper)')
    .action((shell) => {
      const platform = os.platform();

      if (shell === 'cmd') {
        if (platform !== 'win32') {
          ui.error('The cmd.exe wrapper is Windows-only.');
          process.exit(1);
        }
        const shimDir = findShimDir();
        if (!shimDir) {
          ui.error('upex.cmd not found on PATH. Install upex globally first (npm i -g upex).');
          process.exit(1);
        }
        const target = installCmdWrapper(shimDir);
        ui.success(`Installed ${target}`);
        ui.dim('"upex go <name>" and "upex <name>" now cd in cmd.exe (current session too).');
        return;
      }

      ui.heading('Shell Integration');

      ui.dim('A wrapper function is required for cd behavior.');
      ui.dim('Node.js cannot change the parent shell directory directly.');
      ui.blank();

      if (platform === 'win32') {
        console.log(chalk.bold('  Command Prompt (cmd.exe):'));
        ui.separator(40);
        ui.info('run: upex setup cmd');
        ui.dim('installs an upex.bat wrapper next to the npm shim, no profile needed');
        ui.blank();
        console.log(chalk.bold('  PowerShell:'));
        ui.separator(40);
        console.log(POWERSHELL_FUNCTION.split('\n').map(l => '    ' + l).join('\n'));
      } else {
        console.log(chalk.bold('  Bash / Zsh:'));
        ui.separator(40);
        console.log(BASH_ZSH_FUNCTION.split('\n').map(l => '    ' + l).join('\n'));
      }

      ui.blank();
      console.log(chalk.bold('  Fish:'));
      ui.separator(40);
      console.log(FISH_FUNCTION.split('\n').map(l => '    ' + l).join('\n'));

      ui.blank();
      ui.separator();
      ui.dim('Restart your shell after adding the function.');
      ui.blank();
    });
}
