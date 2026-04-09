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
| `upex add <name> --app <exe>` | Register an app shortcut (launches executable) |
| `upex add <name> [path] --app <exe>` | Register a folder shortcut with a default app |
| `upex` | Open the interactive shortcut selector and choose shortcut/app |
| `upex --app <app>` | Open the interactive selector with a preselected app |
| `upex <name>` | Open shortcut folder in Explorer (or launch stored app) |
| `upex <name> <app>` | Open the folder in a specific app (vscode, cmd, ...) |
| `upex list` | Show all saved shortcuts in a formatted table |
| `upex remove <name>` | Delete a saved shortcut |
| `upex rename <old> <new>` | Rename a shortcut |
| `upex edit <name> [path]` | Update a shortcut's path (defaults to cwd) |
| `upex copy <name>` | Copy shortcut path to clipboard |
| `upex check` | Scan all shortcuts and report broken paths |
| `upex setup` | Show shell integration instructions |
| `upex help` | Show all available commands |

## Supported Apps

| Alias | App |
|---|---|
| `vscode` / `code` | VS Code |
| `webstorm` | WebStorm |
| `cursor` | Cursor |
| `zed` | Zed |
| `sublime` / `subl` | Sublime Text |
| `cmd` | Command Prompt (Windows) / Terminal |
| `finder` / `explorer` | System File Manager |
| `nautilus` | Nautilus (Linux) |

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

# Register an app shortcut (launches the executable directly)
upex add chrome --app "C:\Program Files\Google\Chrome\Application\chrome.exe"
upex chrome          # launches Chrome

# Register a folder with a default app
upex add myproj /projects/myproj --app "C:\...\webstorm64.exe"
upex myproj          # launches WebStorm
upex myproj explorer # override: open in Explorer instead

# Open the interactive selector
upex

# List all shortcuts
upex list

# Check for broken paths
upex check
```
## Interactive Mode

Run `upex` with no arguments to open the interactive selector.

- `Up` / `Down` -- move through shortcuts
- `Left` / `Right` -- change the selected app
- `Enter` -- open the selected shortcut in the selected app
- `Esc` -- cancel

## Shell Integration (cd support)

Because a Node.js process can't change your shell's directory, add this wrapper function for instant `cd` behavior:

### Bash / Zsh (`~/.bashrc` or `~/.zshrc`)

```bash
upex() {
  if [ "$1" != "" ] && [ "$2" = "" ] && result=$(command upex __resolve "$1" 2>/dev/null); then
    cd "$result"
  else
    command upex "$@"
  fi
}
```

### PowerShell (`$PROFILE`)

```powershell
function upex {
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
  "velora": { "path": "E:\\projects\\velora" },
  "chrome": { "app": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  "myproj": { "path": "E:\\projects\\myproj", "app": "C:\\...\\webstorm64.exe" }
}
```

Legacy string entries (`"name": "/path"`) are auto-migrated on read.

Optional app config is stored in `~/.upex/config.json`.

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
