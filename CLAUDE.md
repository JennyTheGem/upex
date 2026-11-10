# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@goals.md

Goals live in goals.json, managed by upgo; goals.md is generated and auto-loaded. Use the upgo CLI (see the upgo skill), never edit either file.

## Commands

- `npm test`: run the smoke asserts (`node test/smoke.mjs`, the non-trivial pure logic plus CLI round-trips against a temp home) and `test/edges.mjs` (fuzzy edge cases, launcher command building per platform with `os.platform` and `child_process` stubbed, in its own process). There is no build or lint step.
- `npm link` then `upex ...`: install globally and exercise the CLI end-to-end. This is the primary way to verify behavior.
- `node bin/upex.js <args>`: run without linking.

Do not start the interactive selector (`upex` with no args) in an automated context; it takes over stdin/stdout with raw readline. Jenny verifies the TUI herself.

## Release

After every push of a version-bumped commit, also publish it to npm as `@uplift-beyond/upex`: `npm publish`. It needs Jenny's security key in the browser, so ask her to run `! npm publish` herself.

## Architecture

ESM Node CLI (`"type": "module"`) built on `commander`. Entry is `bin/upex.js` → `createProgram()` in `src/index.js`.

**Command registration.** Every file in `src/commands/` exports a `registerX(program)` that attaches one sub-command. The `COMMANDS` table in `src/fast.js` lists them in registration order as `[names and aliases, file, register function]`. `createProgram(argv)` in `index.js` (async) loads lazily: `upex <command>` imports only that command's file, a shortcut name or a lone `--version` none, and help, completion, the selector (no args), a leading option or no `argv` all of them. It then defines a catch-all default action. Commander has no clean "default positional command", so the default action manually checks whether the first positional matches a known sub-command name/alias; if not, it treats it as a shortcut name and calls `handleOpen`. The selector, launcher and open code are imported inside the action and hooks, never at the top of `index.js`. New sub-commands only need a row in `COMMANDS`: `upex help` and the completion scripts read `program.commands`. Plain commands must not import `interactive.js` (it loads the whole selector); shared row and text helpers live in `src/rows.js`. Give a long `.description()` a short `.summary()` so the help table stays narrow.

**Storage (`src/store.js`).** Two JSON files under `~/.upex/`: `links.json` (shortcuts) and `config.json` (custom openers, `webstormPath`). `ensureStore()` lazily creates them. An unreadable file throws `StoreError` (printed by `bin/upex.js`), never `{}`, so a later save can't wipe it; saves go through a per-process temp file + rename. Entries are `{ path?, app?, url?, tags?, opener?, uses?, lastUsed?, added?, expires?, archived?, pinned?, pinOrder?, color? }` (`opener` = default opener for a folder shortcut; `expires` from `add --ttl`, archived by `sweepExpired` in the `preAction` hook in `index.js`, skipped for `go`, `undo` and `__*`). Every save except `recordUse` (unless it rewrites coerced fields) first copies links.json to `backups/` (10 kept); `undoLast` restores the newest backup that changes something (current usage kept) and deletes it, so `upex undo` steps back with no redo. Legacy string entries (`"name": "/path"`) are normalized to `{ path }` on every read, so always go through `loadLinks` rather than parsing the file directly. `checkEntry` type-checks each field (`FIELDS`): wrong types are coerced or dropped, an entry with no path/app/url is skipped; skipped raw entries are written back by `saveLinks`/`undoLast` (not by `import --replace`, the backup keeps them) so a bad hand edit is never lost, only the first `loadLinks` of a process warns on stderr, and `linkIssues()` feeds `upex doctor`. `recordUse` bumps `uses`/`lastUsed`; `frecency` combines usage count with a day-decaying recency bonus to drive selector ordering. A third file, `visits.json`, holds folders learned from `upex cd <path>` (`{ path: { uses, lastUsed, hidden? } }`, written by `recordVisit` from the fast path): `learnedFolders` ranks them by `frecency` for `upex learned` and the `upex cd <name>` fallback, and with `suggest` gives the ones the selector and `upex ui` offer as a shortcut (`SUGGEST_AFTER` visits, not `hidden`). It is disposable: unreadable reads as empty and a failed write is ignored, so it can never break a cd. `pruneBroken` takes an injectable `exists` fn (for testing) and, when a path dies but an app remains, keeps the app and drops only the dead path.

**Two kinds of shortcut.** A *folder shortcut* has `path` and opens in an opener (Explorer, VS Code, ...). An *app shortcut* has `app` (an executable/command) and launches directly. `handleOpen` in `src/commands/open.js` branches on which is present; a bare `upex <file>` opens a file in its default app while a folder opens Explorer.

**Launching (`src/launcher.js`).** `APP_MAP` holds built-in openers, each with a per-platform `cmd()` (`win32`/`darwin`/`linux`), display name, and install hint. `getAppMap()` merges user openers from `config.json.apps` (custom wins on name clash). `launchApp` handles the platform quirks, the hard part of this codebase:
- Windows `explorer.exe` returns non-zero even on success, so system file managers get special-cased and are spawned detached rather than checked via exit code. Explorer splits a bare argument on commas, so `launchExplorer` passes the path verbatim, quoted when it has a comma or space.
- The `open` opener (a file's default app) is not a file manager: it runs `explorer <path>` on Windows and `xdg-open` on Linux detached with no shell (so a `%` in the path stays text), `open` on macOS.
- Other openers (IDEs, custom ones) run `<command> <path>` detached through a shell, so upex never waits for them; `quotePath` quotes the path (`winQuote` on Windows keeps `%VAR%` as text, `shQuote` elsewhere). `code` and `finder` are `ALIASES` of `vscode` and `explorer`; `openerKey` maps them back.
- `launchUrl` treats a URL as untrusted: parsed with `new URL`, then one argument with no shell (`rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` on Linux).
- Terminals (`cmd`, and `claude` inside one) open N windows via `start "" cmd`, run synchronously rather than detached so Ctrl+C still works in the window, or tabs/panes through `wt` per the `terminalLayout` setting; `cmd /s /k <startCmd>` keeps the window open running a command.
- WebStorm on Windows and Linux is resolved through `resolveWebStormCommand` (PATH → `config.webstormPath` → `WEBSTORM_PATH` → JetBrains Toolbox dirs → versioned and common install paths).
`launchExecutable` handles app shortcuts (detached spawn; `.bat`/`.cmd` run via `cmd.exe /c` with cwd at the script's dir).

**Fuzzy resolution (`src/fuzzy.js`).** `resolveName` tries exact match first, then `fuse.js` (threshold 0.4). Callers report inexact matches to the user (`matched "x" --> "y"`). `resolveTarget` adds subpaths (`web/src` -> shortcut `web` + `src`), used by open/go/__resolve.

**Shell integration.** A Node process can't change the parent shell's cwd, so `cd` support relies on wrapper functions (see `upex setup`) that call the hidden `__resolve` command, which prints the raw path to stdout and exits non-zero on failure. `go` is the public equivalent. Both are answered by `fastPath` in `src/fast.js` before `bin/upex.js` loads commander and the commands (fuse.js loads only on a fuzzy search); anything it can't answer falls through to the full CLI. Its `COMMAND_NAMES` (from `COMMANDS`) must match the registered commands (smoke asserts check it and that each name loads its command). Completion uses the hidden `__names` command.

**Web UI (`src/commands/web.js` + `src/web/index.html`).** `upex ui` serves one static page from a `node:http` server bound to 127.0.0.1. Per-run token (needed as `?t=` to get the page, baked into it, sent as `x-upex-token`) plus a Host-header check guard the JSON API. Edits go through the pure `applyShortcut`/`cleanEntries`, then the normal store functions; opening reuses `handleOpen` in batch mode, which returns `true`/`false`. Custom openers (`config.json` `apps`) are edited through `applyOpener` (add or change the command, no rename). The page builds DOM with text nodes only (no `innerHTML` with data).

**Output (`src/ui.js`).** All terminal formatting goes through these helpers (`heading` = "upex   title" over a full-width rule, `card`, `table`, `dimParent`, `success`/`warn`/`error`, `dim`); list screens use the selector rows via `printRows` from `rows.js`. Keep to the three color roles: green=success, yellow=warning, red=error. Match this style rather than calling `chalk`/`console.log` ad hoc in commands.

## Conventions

- Cross-platform is a hard requirement: any launch/path logic must branch on `os.platform()` and be considered for all three platforms.
- Preserve backward compatibility of the on-disk format (the legacy-string migration exists for this reason).
- Non-trivial pure logic that could regress belongs in `test/smoke.mjs` as a plain `assert` (no framework).
- Keep the upex skill (`skill/SKILL.md`, linked into `~/.claude/skills/upex`) in sync: any added, renamed or removed command, option or behavior updates its Rules and Commands table in the same change.
