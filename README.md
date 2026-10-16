# ⚡ upex — Personal File Shortcut Manager

A professional Node.js CLI tool that lets you register named aliases for folder paths and instantly open them in the file explorer or a specified IDE/app.

## Installation

```bash
# Clone and install
npm install

# Link globally so you can use "upex" anywhere
npm link
```

## Commands

| Command | Description |
|---|---|
| `upex add <name> [path]` | Register a folder shortcut (defaults to current directory) |
| `upex add <name> <app> --app` | Register an app shortcut (the path is the executable) |
| `upex add <name> <url> --url` | Register a URL shortcut (opens in the browser) |
| `upex add <name> [path] --tag a,b` | Attach tags while registering |
| `upex` | Open the interactive shortcut selector and choose shortcut/app |
| `upex --app <app>` | Open the interactive selector with a preselected app |
| `upex <name>` | Open shortcut in Explorer / default app (or launch stored app/URL) |
| `upex <name> <app>` | Open in a specific app (vscode, cmd, open, or a custom app) |
| `upex -` / `upex last` | Reopen the most recently used shortcut |
| `upex go <name> [start...]` | Print the path (cd via shell wrapper); extra args run as a command in the folder |
| `upex cmd <name> [count] [start]` | Open N terminals, optionally running a start command |
| `upex run <name> [script]` | Run a package.json script in a terminal (lists scripts if none given) |
| `upex tag <name> [tags...]` | List all tags, show/add tags, or remove with `-r` / `--clear` |
| `upex open <tag>` | Open every shortcut carrying a tag |
| `upex ws [name\|add\|rm] ...` | Open or manage workspaces (sets of shortcut+app pairs) |
| `upex export [file]` | Export shortcuts + config as a JSON bundle (stdout if no file) |
| `upex import <file> [--replace]` | Import a bundle (merge by default) |
| `upex list [tag] [--git]` | Show all saved shortcuts (filter by tag; `--git` adds a branch column) |
| `upex remove <name>` | Delete a saved shortcut |
| `upex rename <old> <new>` | Rename a shortcut |
| `upex edit <name> [path]` | Update a shortcut's path (defaults to cwd) |
| `upex copy <name>` | Copy shortcut path to clipboard |
| `upex app [alias] [command]` | Manage custom openers (list / add / `--remove`) |
| `upex check [--prune]` | Report broken paths (`--prune` removes them) |
| `upex completion [shell]` | Print a shell completion script (bash/zsh/fish/powershell) |
| `upex setup [cmd]` | Shell integration; `setup cmd` installs the cmd.exe wrapper |
| `upex help` | Show all available commands |

## Supported Apps

| Alias | App |
|---|---|
| `vscode` / `code` | VS Code |
| `webstorm` | WebStorm |
| `cmd` | Command Prompt (Windows) / Terminal |
| `claude` | Terminal running Claude Code (`claude`) |
| `finder` / `explorer` | System File Manager (reveals a file shortcut) |
| `open` | OS default handler (opens a file in its default app) |
| `copy` | Copy the path to the clipboard |

Add your own openers with `upex app`:

```bash
upex app cursor cursor          # register "cursor" -> the cursor command
upex velora cursor              # open a shortcut in Cursor
upex app                        # list custom apps
upex app cursor --remove        # remove one
```

## Examples

```bash
# Save current directory as "myproject"
upex add myproject

# Save a specific path
upex add velora /Users/me/projects/velora

# Open in file explorer
upex velora

# Open in VS Code
upex velora vscode

# Open in Command Prompt (Windows — cwd set to path)
upex velora cmd

# Fuzzy matching works — "velor" resolves to "velora"
upex velor vscode

# Register an app shortcut (the path is the executable, --app is a flag)
upex add chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --app
upex chrome          # launches Chrome

# Save a file (opens in its default app; "explorer" reveals it in its folder)
upex add notes "E:\docs\notes.md"
upex notes           # opens notes.md
upex notes explorer  # reveals it in Explorer

# Open a shortcut in 3 terminal windows
upex cmd velora 3

# Open a terminal at velora and run "claude" in it (window stays open)
upex cmd velora claude

# Two terminals, each running "dir"
upex cmd velora 2 dir

# cd into a shortcut (with the shell wrapper from `upex setup`)
upex go velora

# cd into a shortcut and run a command there
upex go velora npm run dev

# Open the interactive selector
upex

# List all shortcuts
upex list

# Check for broken paths
upex check
```

## Tags & Groups

Attach tags to organize shortcuts, filter the list, and open a whole group at once.

```bash
upex add velora --tag work,web     # tag while adding
upex tag velora ci                 # add a tag later
upex tag velora -r web             # remove a tag (--clear drops all)
upex tag                           # list every tag with counts
upex list work                     # only #work shortcuts
upex open work                     # open every #work shortcut in its default opener
```

## Workspaces

A workspace is a named set of shortcut+app pairs opened together, e.g. code + a terminal + a browser tab.

```bash
upex ws add dev velora vscode      # velora in VS Code
upex ws add dev velora cmd         # ...and a terminal
upex ws add dev docs open          # ...and a URL/file shortcut in its default opener
upex ws                            # list workspaces
upex ws dev                        # open the whole workspace
upex ws rm dev velora              # drop one entry (omit the shortcut to delete the workspace)
```

A `cmd` entry accepts the same `[count] [start...]` tail as `upex cmd`, so a workspace can boot a terminal straight into a command (flags pass through):

```bash
upex ws add dev velora cmd claude --model sonnet   # terminal running claude
upex ws add dev velora cmd 2 npm run dev           # two terminals running "npm run dev"
```

## URL Shortcuts, run & last

```bash
upex add gh github.com --url       # bare hosts get https:// automatically
upex gh                            # opens in the browser

upex run velora                    # list package.json scripts (npm/pnpm/yarn/bun auto-detected)
upex run velora dev                # open a terminal running "<pm> run dev" at velora

upex -                             # reopen the most recently used shortcut (alias: upex last)
```

## Backup & Sync

`export` writes a JSON bundle of your shortcuts and config; `import` merges it back (or `--replace`).

```bash
upex export ~/upex-backup.json     # or omit the file to print to stdout
upex import ~/upex-backup.json     # merge (incoming wins on name clash)
upex import backup.json --replace  # replace everything
```

`upex list --git` adds a column with each folder's current git branch (yellow `branch*` when the working tree is dirty, `--` when it isn't a repo). It's off by default.

## Interactive Mode

Run `upex` with no arguments to open the interactive selector. Shortcuts are ordered by frecency (most-used and most-recent first).

- `Up` / `Down` -- move through shortcuts
- `Left` / `Right` -- change the selected app
- `Tab` -- switch focus between the list and the app row
- `Enter` -- open the selected shortcut in the selected app
- Type -- fuzzy-filter the list
- `Ctrl+A` -- add a shortcut for the current directory
- `Ctrl+E` -- edit the selected shortcut's path
- `Ctrl+R` -- rename the selected shortcut
- `Ctrl+D` -- delete the selected shortcut (confirm with `y`)
- `Esc` -- cancel

## Shell Completion

Enable tab-completion of command and shortcut names:

```bash
# bash / zsh (add to ~/.bashrc or ~/.zshrc)
eval "$(upex completion bash)"

# PowerShell (add to $PROFILE)
upex completion powershell | Out-String | Invoke-Expression
```

## Shell Integration (cd support)

Because a Node.js process can't change your shell's directory, add this wrapper function for instant `cd` behavior:

### Bash / Zsh (`~/.bashrc` or `~/.zshrc`)

```bash
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
}
```

### Command Prompt (cmd.exe)

```cmd
upex setup cmd
```

Installs an `upex.bat` wrapper next to the npm shim. `.bat` beats `.cmd` in PATHEXT resolution, and a `cd` inside a batch file persists in the parent shell, so `upex go <name>` and bare `upex <name>` cd directly. `upex go <name> <command...>` cds and then runs the command in that folder (e.g. `upex go velora npm run dev`). Works immediately, no profile or restart needed.

### PowerShell (`$PROFILE`)

```powershell
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
}
```

## Storage

Shortcuts are stored in `~/.upex/links.json` and created automatically on first use.

Each entry is an object with optional fields:

```json
{
  "velora": { "path": "E:\\projects\\velora", "uses": 12, "lastUsed": 1752710400000 },
  "chrome": { "app": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
}
```

`uses` / `lastUsed` are written automatically and drive the interactive selector's frecency ordering.

Legacy string entries (`"name": "/path"`) are auto-migrated on read.

Config is stored in `~/.upex/config.json`, including custom openers under `apps`:

```json
{
  "apps": { "cursor": "cursor", "sublime": "C:\\...\\sublime_text.exe" }
}
```

### WebStorm on Windows (without `setx`)

If `upex <name> webstorm` does not find WebStorm, add this file:

```json
{
  "webstormPath": "C:\\Program Files\\JetBrains\\WebStorm\\bin\\webstorm64.exe"
}
```

Then run:

```bash
upex <name> webstorm
```

`setx` is only a Windows command for writing environment variables permanently; it is optional now.

## License

MIT
