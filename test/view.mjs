// Shared selector fixtures. Not a test file (npm test lists the *.test.mjs files).
import './helpers.mjs';
import os from 'node:os';
import { renderInteractiveView, hitTest } from '../src/interactive.js';

export const strip = (s) => s.replace(/\x1B\[[0-9;]*m/g, '');
export const viewArgs = { query: '', choices: [{ name: 's', path: 'P', exists: true }], selectedIndex: 0, appChoices: [{ key: 'explorer', label: 'Explorer' }], selectedAppIndex: 0, cmdCount: 1 };
export const setArgs = { ...viewArgs, view: 'settings', settings: { startView: 'apps', sort: 'name', terminalLayout: 'tabs', paneSplit: 'auto', terminalShell: 'pwsh', defaultOpener: 'explorer' }, settingIndex: 8, wt: false, height: 40 };
// The Shell row shows on Windows only, so later rows sit one lower elsewhere.
export const win = os.platform() === 'win32' ? 1 : 0;
export const rowsOf = a => strip(renderInteractiveView(a)).split('\n');
export const at = (args, x, y) => { const targets = []; renderInteractiveView({ ...args, targets }); return hitTest(targets, x, y); };
export const v = (a) => strip(renderInteractiveView({ ...viewArgs, ...a }));
