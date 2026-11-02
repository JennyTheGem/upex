---
name: upex
description: Use whenever Jenny names one of her projects or folders and you need its path, asks to open a project/folder/app (in Explorer, VS Code, cmd, Claude, WebStorm, ...), or wants upex shortcuts added, renamed, tagged, checked or removed. upex is her shortcut launcher CLI; `upex go <name>` is the fastest way to find any project path.
---

# upex

Jenny's CLI for named shortcuts to folders, apps and URLs. Data: `~/.upex/links.json` + `config.json`. Source: `E:\Downloads\Projects\Assets\upex`. If `upex` is not on PATH, use `node E:/Downloads/Projects/Assets/upex/bin/upex.js`.

## Rules

- Never run bare `upex` (interactive selector, takes over stdin). Use a name or sub-command.
- Find a project path: `upex go <name>` prints only the raw path (exit 1 if unknown). `upex ls` shows the full live table, `upex ls <tag>` filters. Fuzzy matching applies; trust the printed path.
- Opening things spawns windows on her desktop: do it only when she asks. If the target is unambiguous (one plausible match, or the current repo), just run it, don't ask.
- Names can contain spaces (e.g. `"Led start"`): quote them.
- Never edit `~/.upex/*.json` by hand; use the commands below.

## Commands

| Command | Does |
|---|---|
| `upex <name> [app] [count]` | Open a shortcut. app: `explorer` (default), `vscode`, `cmd`, `claude`, `webstorm`, or a custom opener |
| `upex go <name>` | Print path |
| `upex ls [tag] [--git]` | List shortcuts |
| `upex add <name> [target] [--app] [--url] [--tag a,b]` | Register a folder (default cwd), app command, or URL |
| `upex edit <name> [target]` / `rename <old> <new>` / `rm <name>` | Change, rename, delete |
| `upex tag [name] [tags...] [--remove] [--clear]` | Manage tags; `upex open <tag>` opens all tagged |
| `upex cmd <name> [count] [start...]` | Open N terminals there, optionally running a command |
| `upex run <name> [script]` | Run a package.json script in a terminal |
| `upex ws ...` | Workspaces (`ws add`, `ws rm`, `ws <name>`) |
| `upex app [alias] [command] [--remove]` | Custom openers |
| `upex check [--prune]` | Report (or prune) broken paths |
| `upex copy <name>` / `last` / `export [file]` / `import <file> [--replace]` | Misc |

`upex help` and `upex <command> --help` are authoritative if this table drifts.
