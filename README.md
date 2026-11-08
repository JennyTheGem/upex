# ⚡ upex: Personal File Shortcut Manager

A professional Node.js CLI tool that lets you register named aliases for folder paths and instantly open them in the file explorer or a specified IDE/app.

## Installation

```bash
npm i -g @uplift-beyond/upex
```

From source:

```bash
npm install

# Link globally so you can use "upex" anywhere
npm link
```

## Commands

| Command | Description |
|---|---|
| `upex add <name> [path]` | Register a folder shortcut (defaults to current directory) |
| `upex add` / `upex add . [path]` | Register the current folder (or `path`) under its own folder name |
| `upex add <name> <app> --app` | Register an app shortcut (the path is the executable) |
| `upex add <name> "<command>" --cmd` | Register a command line (runs in a terminal window) |
| `upex add <name> <url> --url` | Register a URL shortcut (opens in the browser) |
| `upex add <name> [path] --tag a,b` | Attach tags while registering |
| `upex add <name> [path] --ttl 7d` | Temporary shortcut: archived automatically after `30m`, `12h`, `7d`, `2w` (`upex restore` brings it back) |
| `upex` | Open the interactive shortcut selector and choose shortcut/app |
| `upex --app <app>` | Open the interactive selector with a preselected app |
| `upex <name>` | Open shortcut in Explorer / default app (or launch stored app/URL) |
| `upex <name> <app>` | Open in a specific app (vscode, cmd, open, or a custom app) |
| `upex <name>/<sub>` | Open (or `cd` via the wrapper) a folder inside a shortcut, e.g. `upex web/src` |
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
| `upex undo` | Undo the last change to your shortcuts (run again to step further back, up to 10; no redo) |
| `upex pin <name>` / `upex unpin <name>` | Pin a shortcut to the top of the selector and web UI (`upex pin` lists pinned) |
| `upex rename <old> <new>` | Rename a shortcut |
| `upex edit <name> [path]` | Update a shortcut's path (defaults to cwd) |
| `upex edit <name> --opener <app>` | Open this shortcut in `<app>` by default (`--no-opener` clears; also on `add`) |
| `upex copy <name>` | Copy shortcut path to clipboard |
| `upex app [alias] [command]` | Manage custom openers (list / add / `--remove`) |
| `upex check [--prune]` | Report broken paths (`--prune` removes them) |
| `upex stale [days] [--yes]` | List shortcuts not opened in N days (default: the `staleAfter` setting, 60), offer to archive each (`--yes` archives all) |
| `upex doctor` | Check the store, openers, shell wrapper and completion |
| `upex stats [--days N] [--all]` | Most used shortcuts and openers (default last 30 days) and opens per week |
| `upex ui [--port <n>] [--no-open]` | Manage shortcuts and workspaces in the browser |
| `upex config` / `config get <setting>` / `config set <setting> <value>` / `config reset [setting]` | Show, print, change or reset a setting (see Settings below) |
| `upex completion [shell]` | Print a shell completion script (bash/zsh/fish/powershell) |
| `upex setup [bash\|zsh\|fish\|cmd]` | Shell integration; `setup bash`/`zsh`/`fish` adds the cd function to your shell, `setup cmd` installs the cmd.exe wrapper |
| `upex help` | Commands by section plus current settings, wrapped to the window width |

## Supported Apps

| Alias | App |
|---|---|
| `vscode` / `code` | VS Code |
| `webstorm` | WebStorm |
| `cmd` | Terminal (cmd, PowerShell or a WT profile on Windows, see `terminalShell`; on Linux `$TERMINAL`, the desktop's own, `x-terminal-emulator`, then gnome-terminal, konsole, xterm, kitty, ...) |
| `claude` | Terminal running Claude Code (`claude`) |
| `finder` / `explorer` | System File Manager (reveals a file shortcut) |
| `open` | OS default handler (opens a file in its default app) |
| `copy` | Copy the path to the clipboard (`upex <name> copy`; in the selector use `Ctrl+Y`) |

Openers that aren't installed are left out of the selector's opener row and `upex ui`; custom openers always show. On Linux WebStorm is also found in JetBrains Toolbox (`~/.local/share/JetBrains/Toolbox`) and tarballs in `/opt` or your home.

Add your own openers with `upex app`:

```bash
upex app cursor cursor          # register "cursor" -> the cursor command
upex webapp cursor              # open a shortcut in Cursor
upex app                        # list custom apps
upex app cursor --remove        # remove one
```

## Examples

```bash
# Save current directory as "myproject"
upex add myproject

# Save a specific path
upex add webapp /Users/me/projects/webapp

# Open in file explorer
upex webapp

# Open in VS Code
upex webapp vscode

# Open in Command Prompt (Windows, cwd set to path)
upex webapp cmd

# Fuzzy matching works: "webap" resolves to "webapp"
upex webap vscode

# Register an app shortcut (the path is the executable, --app is a flag)
upex add chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --app
upex chrome          # launches Chrome

# Register a command line; it runs in a new terminal window (starts in your home folder)
upex add dev "cd /d E:\projects\app && npm run dev" --cmd
upex dev

# Save a file (opens in its default app; "explorer" reveals it in its folder)
upex add notes "E:\docs\notes.md"
upex notes           # opens notes.md
upex notes explorer  # reveals it in Explorer

# Open a shortcut in 3 terminal windows
upex cmd webapp 3

# Open a terminal at webapp and run "claude" in it (window stays open)
upex cmd webapp claude

# Two terminals, each running "dir"
upex cmd webapp 2 dir

# cd into a shortcut (with the shell wrapper from `upex setup`)
upex go webapp

# cd into a shortcut and run a command there
upex go webapp npm run dev

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
upex add webapp --tag work,web     # tag while adding
upex tag webapp ci                 # add a tag later
upex tag webapp -r web             # remove a tag (--clear drops all)
upex tag                           # list every tag with counts
upex list work                     # only #work shortcuts
upex open work                     # open every #work shortcut in its default opener
```

## Workspaces

A workspace is a named set of shortcut+app pairs opened together, e.g. code + a terminal + a browser tab.

```bash
upex ws add dev webapp vscode      # webapp in VS Code
upex ws add dev webapp cmd         # ...and a terminal
upex ws add dev docs open          # ...and a URL/file shortcut in its default opener
upex ws                            # list workspaces
upex ws dev                        # open the whole workspace
upex ws rm dev webapp              # drop one entry (omit the shortcut to delete the workspace)
```

A `cmd` entry accepts the same `[count] [start...]` tail as `upex cmd`, so a workspace can boot a terminal straight into a command (flags pass through):

```bash
upex ws add dev webapp cmd claude --model sonnet   # terminal running claude
upex ws add dev webapp cmd 2 npm run dev           # two terminals running "npm run dev"
```

## URL Shortcuts, run & last

```bash
upex add gh github.com --url       # bare hosts get https:// automatically
upex gh                            # opens in the browser

upex run webapp                    # list package.json scripts (npm/pnpm/yarn/bun auto-detected)
upex run webapp dev                # open a terminal running "<pm> run dev" at webapp

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

Run `upex` with no arguments to open the interactive selector. Pinned shortcuts (`upex pin`) come first, then the rest by frecency (most-used and most-recent first), or A to Z, last opened or recently added with the `sort` setting. It opens on the `startView` tab (Shortcuts with `--app`, or with no shortcuts yet, so `Ctrl+A` adds the first).

- `Up` / `Down` -- move through shortcuts
- `PgUp` / `PgDn` -- move a screen of rows, `Home` / `End` -- first / last row (every tab, Settings too)
- `Left` / `Right` -- change the selected app (starts on the shortcut's default opener)
- `Shift+Up` / `Shift+Down` (or `Ctrl`) -- terminal count when a terminal opener (cmd, claude) is selected
- `Tab` -- cycle the Shortcuts (folders), Apps (app + URL shortcuts) and Workspaces views (Enter opens the whole workspace, `Ctrl+D` deletes it (`Ctrl+Z` undoes), `Ctrl+A` puts the marked shortcuts into a new or existing one, `Ctrl+E` edits one: its name, and per entry the opener (Left/Right), start command (Enter) or `Ctrl+D` to remove it). The `views` setting hides Apps and/or Workspaces
- `Shift+Tab` -- jump to Settings (Left/Right changes a setting, saved right away), again to go back. Settings are grouped General, Search, Terminals, Opening, List, Rows, Look and Detail pane; a dim tag right of each row says where it applies (`tui` this selector, `web` upex ui, `cli` commands, `all`). Typing filters the rows by label, option and note (also the openers, maintenance and archived rows), Esc clears it. Below the settings: Openers (custom ones, Enter edits the command, `Ctrl+D` removes, "+ add opener"), Maintenance (prune broken paths, archive stale shortcuts, `Ctrl+Z` undoes; stats, doctor, export, import) and Archived (Enter restores one, `Ctrl+D` deletes one for good after `y`, `Ctrl+Z` brings it back still archived)
- `Enter` -- open the selected shortcut in the selected app, then quit (or stay open with the `enter` setting on `stay`)
- `Space` -- mark or unmark the selected shortcut (Shortcuts and Apps tabs) and move down; `Enter` then opens every marked one (folders in the picked opener, else their own) and `Ctrl+X` archives them all (one `Ctrl+Z` or `upex undo` brings them back)
- Type -- fuzzy-filter the list (Space marks instead of typing); `#vel` keeps shortcuts with a tag starting with vel, `#vel#web` needs both tags, `api#vel` also searches api fuzzy; `@vs` keeps folders whose default opener starts with vs (vscode), `is:pinned`, `is:missing`, `is:stale` (not opened in the `staleAfter` days, 60 by default) and `is:app` (any prefix, `is:p`) chain the same way. The `upex ui` search takes the same tokens
- `Ctrl+A` -- add a shortcut for the current directory, then edit it in the form below
- `Ctrl+E` -- edit the selected shortcut in a form (in the detail pane when it shows): name, target, type (folder, app, command or URL), opener, tags (Tab completes one), aliases, note and expiry. Up/Down picks a row, Enter edits a text row and Enter saves it, Left/Right changes a choice row and saves it, `Ctrl+Z` undoes the form's last save, Esc closes it
- `Ctrl+R` -- rename the selected shortcut (starts filled in)
- `Ctrl+P` -- pin or unpin the selected shortcut; `Alt+Up` / `Alt+Down` moves a pinned one among the pinned (saved, `upex ui` uses the same order)
- `Ctrl+X` -- archive the selected shortcut, or all marked ones (confirm with `y`, `Ctrl+Z` undoes it, `upex restore <name>` later); a click on the detail pane's stale row archives the selected one. The selector never deletes a shortcut from its tab: delete an archived one in Settings > Archived
- `Ctrl+Y` -- copy the selected shortcut's path (or app / URL) to the clipboard
- `Ctrl+Z` -- step back one change to your shortcuts, like `upex undo` (again to go further back, up to 10); a flash says what came back. Workspaces deleted in this session come back first, newest first
- `Ctrl+S` -- list the selected folder's package.json scripts (in the detail pane when it shows, else in place of the list); Enter runs one in a terminal (like `upex run`), Esc or Left goes back
- While typing a path or name: `Left` / `Right` move the cursor, `Ctrl+Left` / `Ctrl+Right` jump a word, `Home` / `End`, `Ctrl+Backspace` (or `Ctrl+W`) deletes a word, `Del` deletes forward. `Ctrl+Backspace` also works in the filter
- `Ctrl+K` -- show every key over the list (handy with `keyHints` short), any key or a click closes it
- `Ctrl+U` -- start `upex ui` and open it in the browser; the selector stays open and shows the link. `Ctrl+U` again stops it, so does closing the selector
- `Esc` -- clear the filter, then the marks, then close a detail pane opened with Shift+→ (see `narrowPane`), then quit
- Mouse (full screen) -- click a tab, opener or setting; click a row to select it, again or double-click to open; right-click a row for a menu (open in each opener, edit, pin, copy path, archive; workspaces: open all, edit, delete), click an item or use ↑↓ Enter, any other click or key closes it; the wheel moves the selection; in the detail pane a click on a goal copies it

## Web UI

Run `upex ui` to open a local page (default `http://127.0.0.1:4545`, a free port if that one is busy) where you can add, edit, rename, tag, delete, copy and open shortcuts, set a default opener, add or edit custom openers (Settings tab), open terminals with a window count and start command, build, reorder and rename workspaces, and remove missing paths. Lists sort by most used (or A to Z, last opened, recently added), pinned shortcuts first (pin icon on each row) and re-check paths when you come back to the page. Folders, apps (app, command and URL shortcuts) and workspaces each get their own tab (the `views` setting can hide Apps or Workspaces). Press `/` to search, `n` for a new shortcut or app. Stop it with `Ctrl+C`.

It only listens on 127.0.0.1 and every request needs a token that is new each run, so other sites can't use it. With `--no-open`, open the link it prints (it carries the token).

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

`upex setup bash` (or `zsh`) adds this for you, in a marked block that a rerun updates. `upex setup fish` writes the fish one.

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

Installs an `upex.bat` wrapper next to the npm shim. `.bat` beats `.cmd` in PATHEXT resolution, and a `cd` inside a batch file persists in the parent shell, so `upex go <name>` and bare `upex <name>` cd directly. `upex go <name> <command...>` cds and then runs the command in that folder (e.g. `upex go webapp npm run dev`). Works immediately, no profile or restart needed.

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

Shortcuts are stored in `~/.upex/links.json` and created automatically on first use. Every edit (not the usage stats an open records) first copies the old file to `~/.upex/backups/` (newest 10 kept). `upex undo` restores the newest one (again to step further back), keeping usage stats; or copy a backup over `links.json` yourself.

Each entry is an object with optional fields:

```json
{
  "webapp": { "path": "E:\\projects\\webapp", "opener": "vscode", "uses": 12, "lastUsed": 1752710400000 },
  "chrome": { "app": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
}
```

`opener` is the default opener for `upex <name>` (set with `--opener`). `uses` / `lastUsed` are written automatically and drive the interactive selector's frecency ordering. Each open is also appended to `~/.upex/history.jsonl` (`{ ts, name, opener }` per line), which `upex stats` reads. `added` (set on add, drives `upex stale` for never-opened shortcuts) and `expires` (from `--ttl`) are timestamps too. `pinned: true` (from `upex pin`) keeps a shortcut at the top; `pinOrder` (from `Alt+Up` / `Alt+Down` in the selector) is its place among the pinned.

Legacy string entries (`"name": "/path"`) are auto-migrated on read.

Config is stored in `~/.upex/config.json`, including custom openers under `apps`:

```json
{
  "apps": { "cursor": "cursor", "sublime": "C:\\...\\sublime_text.exe" }
}
```

Settings, also on the Settings tab of `upex ui` and the selector (`Shift+Tab`), and from the command line with `upex config set terminalLayout tabs` (`upex config` lists them all, `upex config get sort` prints one value, `upex config reset [setting]` puts one or all back to the default, like the Reset button on each `upex ui` Settings section):

- `"startView"`: the tab the selector and `upex ui` open on. `"shortcuts"` (default), `"apps"`, `"workspaces"` or `"last"` (the tab you left the selector or `upex ui` on, plus the opener you picked in the selector).
- `"sort"`: shortcut order in the selector and `upex ui`. `"recent"` (default, most used first), `"name"` (A to Z), `"opened"` (last opened first) or `"added"` (recently added first).
- `"views"`: the tabs the selector and `upex ui` show. `"all"` (default), `"no-workspaces"`, `"no-apps"` or `"shortcuts"` (Shortcuts only). A hidden start view opens Shortcuts.
- `"enter"` (selector only): what Enter does. `"quit"` (default, open and close the selector) or `"stay"` (open in place, the selector stays open; also for workspaces, scripts and marked rows).
- `"recentStrip"` (selector only): `"off"` (default), `"3"` or `"5"` (the last 3 or 5 opened again above the list under a Recent heading, whatever the sort; not while searching). An old `"on"` reads as `"3"`.
- `"staleAfter"`: days not opened (or added, if never opened) before a shortcut counts as stale, for `is:stale` (selector and `upex ui`), Settings > Maintenance > Stale and the default of `upex stale`. `"30"`, `"60"` (default), `"90"` or `"180"`.
- `"fuzzy"`: how close a typed name must be, in the selector filter and for names (`upex <name>`, `go`, ...). `"normal"` (default), `"exact"` (the typed letters in a row, anywhere in the name, no typos) or `"loose"` (more typos).
- `"searchIn"`: what the selector filter and the `upex ui` search look at. `"all"` (default, names, aliases, paths and tags) or `"names"` (names and aliases). `#tag`, `@opener` and `is:pinned|missing|stale|app` filter either way, in the selector and `upex ui`.
- `"terminalLayout"`: where terminal openers run. `"here"` (default): one terminal runs in the terminal upex is in, upex quits and a shell starts at the folder (with the start command, like claude), `exit` comes back; several at once, workspaces and `upex ui` get separate windows. `"windows"` (separate windows), and on Windows `"tabs"` or `"panes"` (added to your current Windows Terminal window). Falls back to windows when `wt` is missing. With tabs, a terminal opened from the selector leaves the selector open.
- `"paneSplit"` (Windows, panes layout): `"auto"` (default), `"vertical"` (side by side) or `"horizontal"` (stacked).
- `"terminalShell"` (Windows): the shell terminal openers start. `"cmd"` (default), `"powershell"`, `"pwsh"`, or `"profile"` (your Windows Terminal default profile; a start command like `claude` then runs in cmd, and without `wt` it falls back to cmd).
- `"defaultOpener"`: opener for folder shortcuts without their own `opener`, e.g. `"vscode"`. Default `"explorer"`. Files still open in their default app.
- `"fullScreen"` (selector only): `"on"` (default, the whole terminal, restored on exit) or `"off"` (drawn inline, no mouse).
- `"mouse"` (selector only, full screen): `"on"` (default, clicks, right-click menu and the wheel) or `"off"` (the terminal selects text as usual).

Appearance:

- `"theme"` (`upex ui` only): `"system"` (default, follows the OS), `"dark"` or `"light"`.
- `"accent"`: `"default"` (green in `upex ui`, uncolored in the selector), `"green"`, `"blue"`, `"purple"`, `"orange"`, or any hex color like `"#ff66aa"` (`upex config set accent ff66aa`, the `#` is optional; truecolor in the selector, nearest color on terminals with fewer colors). The `upex ui` accent and the selector's `›` pointer and picked option.
- `"density"`: `"comfortable"` (default) or `"compact"` (no spacer lines in the selector, tighter rows in `upex ui`).
- `"keyHints"` (selector only): the key rows under the list. `"full"` (default, keys that don't fit wrap onto more rows, ^s scripts and ^g last after a `|`), `"short"` (one row of the main keys, without ↑↓, Tab and Esc; ^k shows every key over the list, any key closes it) or `"off"` (none, the list gets the rows). The Settings tab always shows its keys.
- `"flash"` (selector only): how long a green success message stays. `"3"` (default, seconds), `"6"` or `"key"` (until the next key). Warnings always stay until the next key.
- `"updateCheck"`: `"on"` (default) or `"off"`. Once a day upex asks the npm registry in the background (cached in `~/.upex/update.json`) and, when a newer version is out, prints one dim line after a command: `update available x -> y, run npm i -g @uplift-beyond/upex@latest`. Never for `go`, the cd wrappers, completion or the selector, never in non-terminal output, and offline it stays quiet. The selector shows the installed version, dim, at the right end of its bottom rule: always on the Settings tab, elsewhere from 100 columns wide (a message covers it while it shows).
- `"glyphs"` (selector only): `"unicode"` (default) or `"ascii"`, for terminals or fonts that show boxes: `‹ ›` become `< >`, `▏ ▎ │` become `|`, `─` becomes `-`, `…` becomes `.`, arrows become `^ v < >`, `● ★` become `*`, and the key rows spell out `enter`, `up/down`, `left/right` and `bs`.
- `"maxRows"` (selector only): list rows, `"auto"` (default: the whole screen in full screen, 8 inline), `"8"`, `"12"` or `"16"`. Inline, Settings shows Auto as its "8" option. In full screen the key rows sit at the bottom of the terminal, and a terminal 140+ columns wide gets a detail pane right of the list (the name with times opened, last opened and opener beside it, a line with type, tags, aliases, added and expiry, then other shortcuts on the same path, a stale hint when not opened in 30+ days that a click archives after a y / n, and the note; a workspace lists its entries).
- `"paths"`: `"dim"` (default, parent folders dimmed), `"full"` or `"hidden"` (no paths, commands or URLs) in the selector, `upex ls`, `upex stale` and `upex ui`. Piped output always shows paths.
- `"rowDetails"`: what shows on the right of a row in the selector, `upex ls` and `upex ui`. `"both"` (default), `"tags"` (#tags), `"badges"` (★ pinned, app, cmd, url, missing) or `"none"`. Piped `upex ls` always shows both.
- `"pinned"`: `"top"` (default, pinned shortcuts first) or `"section"` (first, under a Pinned heading, the rest under All) in the selector and `upex ui`. A search in the selector sorts by match, so it drops the headings.
- `"groups"`: `"off"` (default) or `"tags"` (pinned ones under Pinned on top, then a #tag heading with its count per tag in the selector and `upex ui`, in the sort order, a shortcut with two tags under both, untagged ones last). Not while searching or filtering by a tag.

Detail pane (selector only, full screen, 140+ columns, or narrower with `narrowPane`):

- `"narrowPane"`: `"toggle"` (default) or `"always"`. Under 140 columns, Shift+→ opens the pane anyway (the list gets narrower) and Shift+← or Esc closes it; `"always"` shows it there without asking. Never under 60 columns. Shift+↑↓ still sets the terminal count.
- `"paneWidth"`: `"normal"` (default, about 38% of the screen), `"narrow"` (about 28%, more room for the list) or `"wide"` (half the screen).
- `"goals"`: `"off"` (default), `"3"`, `"5"` or `"10"`. A folder shortcut with an [upgo](https://github.com/JennyTheGem/upgo) `goals.json` shows a progress bar and done/total of its goals (dropped ones left out) and up to that many open goals, soonest phase first. Shift+→ picks one in the pane (↑↓ or the wheel move, Enter copies `id: title` and its body, Esc or ← goes back). A click on a goal copies it too.
- `"git"`: `"off"` (default) or `"on"`. A folder shortcut inside a git repo shows its branch, ahead/behind, changed file count and last commit (age and message), looked up in the background and cached per folder for a few seconds, so scrolling stays fast. With an `origin` remote it also shows the repo's web page: Ctrl+G or a click opens it in the browser.

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

MIT, see [LICENSE](LICENSE).
