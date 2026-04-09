/**
 * setup.js -- Show shell integration instructions.
 * Usage: upex setup
 */

import chalk from 'chalk';
import os from 'node:os';
import * as ui from '../ui.js';

const BASH_ZSH_FUNCTION = `# ~/.bashrc or ~/.zshrc
upex() {
  if [ "$1" != "" ] && [ "$2" = "" ] && result=$(command upex __resolve "$1" 2>/dev/null); then
    cd "$result"
  else
    command upex "$@"
  fi
}`;

const POWERSHELL_FUNCTION = `# PowerShell profile ($PROFILE)
function upex {
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
  if test (count $argv) -eq 1
    set result (command upex __resolve $argv[1] 2>/dev/null)
    if test $status -eq 0 -and test -n "$result"
      cd $result
      return
    end
  end
  command upex $argv
end`;

export function registerSetup(program) {
  program
    .command('setup')
    .description('Show shell integration instructions for cd support')
    .action(() => {
      const platform = os.platform();

      ui.heading('Shell Integration');

      ui.dim('A wrapper function is required for cd behavior.');
      ui.dim('Node.js cannot change the parent shell directory directly.');
      ui.blank();

      if (platform === 'win32') {
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
