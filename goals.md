# upex — Roadmap

Purpose: a personal CLI to register named aliases for folder/app paths and instantly open them in Explorer, an IDE, a terminal, or a custom app.

Last updated: 2026-07-17

Status legend: ✅ Implemented · 🚧 Partial · 📋 Planned
Finished items move to `goals-completed.md`.

## 1. Shortcut management
- ✅ Add / remove / rename / edit folder shortcuts (`add`, `remove`, `rename`, `edit`)
- ✅ App shortcuts (`add <name> <exe> --app`) launched directly
- ✅ `list` table, `copy` path to clipboard, `check [--prune]` for broken paths
- ✅ Legacy string-entry auto-migration on read

## 2. Opening
- ✅ Open in Explorer / default app / VS Code / WebStorm / terminal
- ✅ Custom openers via `app` command + `config.json.apps`
- ✅ Multi-terminal open with optional start command (`cmd <name> [count] [start]`)
- ✅ File vs folder awareness (reveal file in Explorer, open file in default app)

## 3. Resolution & UX
- ✅ Exact-then-fuzzy name resolution (fuse.js)
- ✅ Interactive frecency-ordered selector (arrows, fuzzy filter, in-selector add/edit/rename/delete)
- ✅ Frecency ordering (usage + recency decay)

## 4. Shell integration
- ✅ `cd` support via wrapper + hidden `__resolve` / public `go`
- ✅ Shell completion (bash/zsh/fish/powershell) + hidden `__names`
- ✅ `setup` integration instructions

## 5. Platform support
- ✅ Windows / macOS / Linux launch paths
- ✅ Windows WebStorm resolution (PATH, config, env, Toolbox, install dirs)

## 6. Quality
- ✅ Smoke asserts for `frecency` + `pruneBroken`
- 📋 Broader test coverage (fuzzy resolution, launcher branching per platform)
