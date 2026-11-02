# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@goals.md

Goals live in goals.json, managed by upgo; goals.md is generated and auto-loaded. Use the upgo CLI (see the upgo skill), never edit either file.

## Commands

- `npm test`: run the smoke asserts (`node test/smoke.mjs`). Covers the non-trivial pure logic plus CLI round-trips against a temp home. There is no build or lint step.
- `npm link` then `upex ...`: install globally and exercise the CLI end-to-end. This is the primary way to verify behavior.
- `node bin/upex.js <args>`: run without linking.

Do not start the interactive selector (`upex` with no args) in an automated context; it takes over stdin/stdout with raw readline. Jenny verifies the TUI herself.

## Architecture

ESM Node CLI (`"type": "module"`) built on `commander`. Entry is `bin/upex.js` → `createProgram()` in `src/index.js`.

**Command registration.** Every file in `src/commands/` exports a `registerX(program)` that attaches one sub-command. `index.js` imports and calls each in order, then defines a catch-all default action. Commander has no clean "default positional command", so the default action manually checks whether the first positional matches a known sub-command name/alias; if not, it treats it as a shortcut name and calls `handleOpen`. New sub-commands only need adding to that registration list: `upex help` and the completion scripts read `program.commands`. Give a long `.description()` a short `.summary()` so the help table stays narrow.

**Storage (`src/store.js`).** Two JSON files under `~/.upex/`: `links.json` (shortcuts) and `config.json` (custom openers, `webstormPath`). `ensureStore()` lazily creates them. An unreadable file throws `StoreError` (printed by `bin/upex.js`), never `{}`, so a later save can't wipe it; saves go through a per-process temp file + rename. Entries are `{ path?, app?, uses?, lastUsed? }`. Legacy string entries (`"name": "/path"`) are normalized to `{ path }` on every read, so always go through `loadLinks`/`normalizeEntry` rather than parsing the file directly. `recordUse` bumps `uses`/`lastUsed`; `frecency` combines usage count with a day-decaying recency bonus to drive selector ordering. `pruneBroken` takes an injectable `exists` fn (for testing) and, when a path dies but an app remains, keeps the app and drops only the dead path.

**Two kinds of shortcut.** A *folder shortcut* has `path` and opens in an opener (Explorer, VS Code, ...). An *app shortcut* has `app` (an executable/command) and launches directly. `handleOpen` in `src/commands/open.js` branches on which is present; a bare `upex <file>` opens a file in its default app while a folder opens Explorer.

**Launching (`src/launcher.js`).** `APP_MAP` holds built-in openers, each with a per-platform `cmd()` (`win32`/`darwin`/`linux`), display name, and install hint. `getAppMap()` merges user openers from `config.json.apps` (custom wins on name clash). `launchApp` handles the platform quirks, the hard part of this codebase:
- Windows `explorer.exe` returns non-zero even on success, so system file managers get special-cased and are spawned detached rather than checked via exit code.
- `start` is a `cmd.exe` builtin, not a resolvable binary, so its command-existence check is skipped.
- Terminals (`cmd`) open N detached windows via `start "" cmd`; `cmd /k <startCmd>` keeps the window open running a command.
- WebStorm on Windows is resolved through `resolveWindowsWebStormCommand` (PATH → `config.webstormPath` → `WEBSTORM_PATH` → JetBrains Toolbox versioned dirs → common install paths).
`launchExecutable` handles app shortcuts (detached spawn; `.bat`/`.cmd` run via `cmd.exe /c` with cwd at the script's dir).

**Fuzzy resolution (`src/fuzzy.js`).** `resolveName` tries exact match first, then `fuse.js` (threshold 0.4). Callers report inexact matches to the user (`matched "x" --> "y"`).

**Shell integration.** A Node process can't change the parent shell's cwd, so `cd` support relies on wrapper functions (see `upex setup`) that call the hidden `__resolve` command, which prints the raw path to stdout and exits non-zero on failure. `go` is the public equivalent. Completion uses the hidden `__names` command.

**Web UI (`src/commands/web.js` + `src/web/index.html`).** `upex ui` serves one static page from a `node:http` server bound to 127.0.0.1. Per-run token (needed as `?t=` to get the page, baked into it, sent as `x-upex-token`) plus a Host-header check guard the JSON API. Edits go through the pure `applyShortcut`/`cleanEntries`, then the normal store functions; opening reuses `handleOpen` in batch mode, which returns `true`/`false`. The page builds DOM with text nodes only (no `innerHTML` with data).

**Output (`src/ui.js`).** All terminal formatting goes through these helpers (`heading`, `table`, `success`/`warn`/`error`, `dim`, box frames). Keep to the three color roles: green=success, yellow=warning, red=error. Match this style rather than calling `chalk`/`console.log` ad hoc in commands.

## Conventions

- Cross-platform is a hard requirement: any launch/path logic must branch on `os.platform()` and be considered for all three platforms.
- Preserve backward compatibility of the on-disk format (the legacy-string migration exists for this reason).
- Non-trivial pure logic that could regress belongs in `test/smoke.mjs` as a plain `assert` (no framework).
