---
name: upex
description: Use whenever Jenny names one of her projects or folders and you need its path, asks to open a project/folder/app (in Explorer, VS Code, cmd, Claude, WebStorm, ...), or wants upex shortcuts added, renamed, tagged, aliased, archived, checked or removed. upex is her shortcut launcher CLI; `upex go <name>` is the fastest way to find any project path.
---

# upex

Jenny's CLI for named shortcuts to folders, apps, command lines and URLs. Data: `~/.upex/links.json` + `config.json`. Source: `E:\Downloads\Projects\Assets\upex`. If `upex` is not on PATH, use `node E:/Downloads/Projects/Assets/upex/bin/upex.js`.

## Rules

- Never run bare `upex` (interactive selector, takes over stdin and by default the whole terminal with mouse support: click a row to select, click it again or double-click to open, click tabs / openers / settings options, wheel moves the selection; Settings > Full screen Off draws it inline without mouse; Esc clears a typed filter, then quits; ^a/^e/^r/^d add, edit path, rename, delete with a green confirmation; ^e/^r start filled with the current path/name, ^u clears the line, an empty path = cwd; with Terminals = Tabs in Windows Terminal, opening a terminal (or a command-line shortcut) keeps the selector open and opens the tab beside it; Enter on a shortcut whose folder is missing stays open with "path missing, ^e to fix"; long names clip with …; ^z undoes the last delete of the session unless the name was taken since; ^u in browse mode starts `upex ui` inside the selector, opens the browser and shows "upex ui running <link>"; ^u again or closing the selector stops it) or `upex ui` (starts a server, opens a browser). Use a name or sub-command.
- Find a project path: `upex go <name>` prints only the raw path (exit 1 if unknown). `upex go web/src` resolves a subpath. `upex ls` shows the full live table, `upex ls <tag>` filters. Fuzzy matching and aliases apply; trust the printed path.
- Opening things spawns windows on her desktop: do it only when she asks. If the target is unambiguous (one plausible match, or the current repo), just run it, don't ask.
- Names can contain spaces (e.g. `"Led start"`): quote them.
- Prefer `rm --archive` over a hard delete unless she says delete.
- `upex stale` without `--yes` only lists when not in a TTY (safe to run); `--yes` archives every listed shortcut, so only use it when she asks.
- `--ttl` shortcuts are archived automatically once expired (by the next command other than `go` and the hidden ones, notice on stderr; `go` already refuses them); `upex restore` brings one back permanently.
- Never edit `~/.upex/*.json` by hand; use the commands below.
- To change a setting (terminalLayout, sort, defaultOpener, ...) use `upex config set <setting> <value>`, never edit config.json by hand; `upex config get <setting>` prints just the value.
- "What do I use most?" questions: `upex stats` (read-only, safe to run). Every open is logged with its opener (`cd` for go, `app`, `url`, `web`, or the opener key); counting started when the log was added, so older use shows only in the all-time column.

## Commands

| Command | Does |
|---|---|
| `upex <name> [app] [count]` | Open a shortcut. app: `explorer` (default, or the shortcut's own opener), `vscode`, `cmd`, `claude`, `webstorm`, or a custom opener |
| `upex go <name>` | Print path |
| `upex ls [tag] [--git] [--archived]` | List shortcuts |
| `upex add <name> [target] [--app\|--cmd\|--url] [--tag a,b] [--opener <app>] [--alias a,b] [--ttl 7d]` | Register a folder (default cwd), app, command line or URL; `--ttl` (`30m`/`12h`/`7d`/`2w`) makes it temporary |
| `upex edit <name> [target] [--opener <app>\|--no-opener]` / `rename <old> <new>` | Change, rename |
| `upex rm <name> [--archive]` / `restore <name>` | Delete, or archive (hidden, restorable) |
| `upex tag [name] [tags...] [--remove] [--clear]` | Manage tags; `upex open <tag>` opens all tagged |
| `upex alias [name] [aliases...] [--remove] [--clear]` | Extra names for a shortcut |
| `upex cmd <name> [count] [start...]` | Open N terminals there, optionally running a command |
| `upex run <name> [script]` | Run a package.json script in a terminal |
| `upex web <name>` | Open the project's git remote page (GitHub etc.) |
| `upex ws ...` | Workspaces (`ws add`, `ws rm`, `ws <name>`) |
| `upex app [alias] [command] [--remove]` | Custom openers |
| `upex stats [--days N] [--all]` | Most used shortcuts and openers (default last 30 days) plus opens per week, from `~/.upex/history.jsonl` |
| `upex config` / `config get <setting>` / `config set <setting> <value>` | List settings with their options, print one, or change one (same as the Settings tabs) |
| `upex stale [days] [--yes]` | Shortcuts not opened in N days (default 60), never-opened first; offers to archive each |
| `upex check [--prune]` / `doctor` | Report (or prune) broken paths / check store, openers, shell setup |
| `upex copy <name>` / `last` / `export [file]` / `import <file> [--replace]` | Misc |

`upex help` and `upex <command> --help` are authoritative if this table drifts.
