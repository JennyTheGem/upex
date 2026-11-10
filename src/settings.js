/**
 * settings.js -- The settings table in config.json and its readers
 */

import os from 'node:os';
import { loadConfig } from './store.js';

const platform = os.platform();

// Settings in config.json; the first value is the default unless DEFAULTS says. Start view, views, sort, searchIn, staleAfter, pinned, groups, usage and goals are shared by the selector and upex ui; fullScreen, mouse, keyHints, maxRows, recentStrip, enter, numberKeys, confirmMany, flash, narrowPane, paneWidth, git, size and glyphs are selector only.
// Layout: separate windows, or tabs/panes in one Windows Terminal window. Shell 'profile' = wt default profile.
export const SETTINGS = {
  // last = the tab (and opener) the selector or upex ui was left on.
  startView: ['shortcuts', 'apps', 'workspaces', 'last'],
  // recent = most used, opened = last opened, added = recently added.
  sort: ['recent', 'name', 'opened', 'added'],
  // The last 3 or 5 opened above the list, whatever the sort. A dropped 'on' reads as 3.
  recentStrip: ['off', '3', '5'],
  // Days not opened before a shortcut counts as stale: is:stale, Settings > Maintenance, upex stale. Default 60.
  staleAfter: ['30', '60', '90', '180'],
  // Tabs shown (selector, upex ui); Shortcuts always is.
  views: ['all', 'no-workspaces', 'no-apps', 'shortcuts'],
  // Selector Enter: open and quit, or open and keep the selector.
  enter: ['quit', 'stay'],
  // Selector: 1 to 9 opens the Nth visible row, numbered in the pointer column.
  numberKeys: ['off', 'on'],
  // Selector: Enter on marked rows or a workspace that opens more windows than this asks first.
  confirmMany: ['off', '3', '5', '10'],
  // Fuzzy matching of the selector filter and of names (upex <name>, go). Exact: the typed letters in a row, no typos.
  fuzzy: ['normal', 'exact', 'loose'],
  // What the filter searches (selector, upex ui): names, aliases, paths and tags, or names and aliases only.
  searchIn: ['all', 'names'],
  // Selector success message: fades after 3 or 6 seconds, or stays until the next key.
  flash: ['3', '6', 'key'],
  // Daily npm check, one dim line after commands when a newer upex is out.
  updateCheck: ['on', 'off'],
  // here = the shell runs in this terminal once upex quits. Tabs and panes need Windows Terminal.
  terminalLayout: ['here', 'windows', 'tabs', 'panes'],
  paneSplit: ['auto', 'vertical', 'horizontal'],
  terminalShell: ['cmd', 'powershell', 'pwsh', 'profile'],
  fullScreen: ['on', 'off'],
  // Mouse in full screen; off leaves text selection to the terminal.
  mouse: ['on', 'off'],
  // Theme is upex ui only, the rest also the selector (paths: also upex ls / stale).
  theme: ['system', 'dark', 'light'],
  accent: ['default', 'green', 'blue', 'purple', 'orange'],
  density: ['comfortable', 'compact'],
  paths: ['dim', 'full', 'hidden'],
  // Selector footer: every key, one row of the keys for now (default), or none. Settings always keeps its keys.
  keyHints: ['full', 'short', 'off'],
  // Selector list height; auto = fill in full screen, 8 inline. A dropped 'fill' reads as auto.
  maxRows: ['auto', '8', '12', '16'],
  // Right side of a row (selector, ls, upex ui): #tags, badges (pinned, app, missing), both or none.
  rowDetails: ['both', 'tags', 'badges', 'none'],
  // Right edge of a row (selector, upex ui): last opened ("3d ago"), open count, or nothing.
  usage: ['ago', 'opens', 'off'],
  // Pinned shortcuts first, or first under their own Pinned heading (selector, upex ui).
  pinned: ['top', 'section'],
  // Shortcuts under a #tag heading per tag, untagged last (selector, upex ui).
  groups: ['off', 'tags'],
  // Detail pane (selector) under 140 columns: Shift+Right opens it, Shift+Left closes it, or it always shows.
  narrowPane: ['toggle', 'always'],
  // Detail pane (selector) width: share of the screen.
  paneWidth: ['normal', 'narrow', 'wide'],
  // Detail pane (selector) and upex ui rows: off, or how many open upgo goals of a folder with a goals.json.
  goals: ['off', '3', '5', '10'],
  // Detail pane (selector): git status of a folder in a repo.
  git: ['off', 'on'],
  // Detail pane (selector): size and file count of a folder.
  size: ['on', 'off'],
  // Selector glyphs: unicode, or plain ASCII for fonts that show boxes.
  glyphs: ['unicode', 'ascii'],
};
// Values a setting offers on this system: tabs and panes are Windows Terminal only.
export const settingValues = key => (key === 'terminalLayout' && platform !== 'win32' ? ['here', 'windows'] : SETTINGS[key]);
// Settings that only do something on Windows, hidden elsewhere.
const WINDOWS_ONLY = ['paneSplit', 'terminalShell'];
export const settingShown = key => platform === 'win32' || !WINDOWS_ONLY.includes(key);
// Accent also takes a hex color, stored as #rrggbb.
export const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const valid = (key, v) => SETTINGS[key].includes(v) || (key === 'accent' && isHex(v));
// Defaults that aren't the first value, so options keep their natural order.
const DEFAULTS = { staleAfter: '60', confirmMany: '5', usage: 'off', keyHints: 'short' };
// Dropped values that still read as a current one.
const LEGACY = { recentStrip: { on: '3' } };
export const setting = (key, config = loadConfig()) => {
  const v = LEGACY[key]?.[config[key]] ?? config[key];
  return valid(key, v) ? v : DEFAULTS[key] ?? SETTINGS[key][0];
};
// Every setting name, defaultOpener included.
export const SETTING_KEYS = [...Object.keys(SETTINGS), 'defaultOpener'];
// Config without these settings (all when none given), so they fall back to their defaults.
export function resetSettings(config, keys = SETTING_KEYS) {
  const out = { ...config };
  for (const k of keys) delete out[k];
  return out;
}
// Tabs the views setting shows, in order.
export const shownTabs = (views = 'all') => ['shortcuts', 'apps', 'workspaces'].filter(t => t === 'shortcuts' || (views !== 'shortcuts' && views !== `no-${t}`));
// Tab to open on: startView, or for 'last' the one saved in lastView (Shortcuts when none or hidden).
export function startTab(config = loadConfig()) {
  const v = setting('startView', config);
  const t = v !== 'last' ? v : config.lastView !== 'last' && SETTINGS.startView.includes(config.lastView) ? config.lastView : 'shortcuts';
  return shownTabs(setting('views', config)).includes(t) ? t : 'shortcuts';
}
