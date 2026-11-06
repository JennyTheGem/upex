/**
 * completion.js -- Shell completion scripts + the hidden __names helper.
 * Usage: upex completion [bash|zsh|fish|powershell]
 *   e.g. eval "$(upex completion bash)"   (bash/zsh)
 *        upex completion powershell | Out-String | Invoke-Expression
 */

import os from 'node:os';
import { loadLinks, activeLinks, aliasesOf } from '../store.js';
import * as ui from '../ui.js';

// SUBCOMMANDS comes from the registered commands, so new ones complete with no manual list.
const scripts = (SUBCOMMANDS) => ({
  bash: `_upex() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS} $(upex __names)" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$(upex __names)" -- "$cur") )
  fi
}
complete -F _upex upex`,

  zsh: `_upex() {
  local -a cmds names
  cmds=(${SUBCOMMANDS})
  names=(\${(f)"$(upex __names)"})
  compadd -- $cmds $names
}
compdef _upex upex`,

  fish: `complete -c upex -f -a "(upex __names)"
complete -c upex -n "__fish_use_subcommand" -a "${SUBCOMMANDS}"`,

  powershell: `Register-ArgumentCompleter -Native -CommandName upex -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @('${SUBCOMMANDS.split(' ').join("','")}')
  $names = @(upex __names)
  ($cmds + $names) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}`,
});

function detectShell() {
  if (os.platform() === 'win32') return 'powershell';
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('fish')) return 'fish';
  return 'bash';
}

export function registerCompletion(program) {
  program
    .command('__names', { hidden: true })
    .description('(internal) Print all shortcut names for completion')
    .action(() => {
      const links = activeLinks(loadLinks());
      process.stdout.write(Object.entries(links).flatMap(([n, e]) => [n, ...aliasesOf(e)]).join('\n'));
    });

  program
    .command('completion [shell]')
    .description('Print a shell completion script (bash|zsh|fish|powershell)')
    .summary('Print a shell completion script')
    .action((shell) => {
      const key = (shell || detectShell()).toLowerCase();
      const names = program.createHelp().visibleCommands(program).flatMap(c => [c.name(), ...c.aliases()]);
      const script = scripts(names.join(' '))[key === 'pwsh' ? 'powershell' : key];
      if (!script) {
        ui.error(`No completion for "${shell}". Supported: bash, zsh, fish, powershell`);
        process.exit(1);
      }
      process.stdout.write(script + '\n');
    });
}
