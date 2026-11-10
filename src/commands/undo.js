/**
 * undo.js -- Roll shortcuts or workspaces back to before the last change (add, edit, rm, prune, ws rm, ...).
 * Usage: upex undo   (again to step further back, up to 10 changes)
 */

import { undoLast } from '../store.js';
import * as ui from '../ui.js';

export function registerUndo(program) {
  program
    .command('undo')
    .description('Undo the last change to your shortcuts or workspaces (run again to step further back)')
    .summary('Undo the last shortcut or workspace change')
    .action(() => {
      const r = undoLast();
      if (!r) {
        ui.info('Nothing to undo.');
        return;
      }
      ui.success(`Undid the ${r.workspaces ? 'workspace ' : ''}change from ${ui.span(Date.now() - r.at)} ago`);
      for (const [label, names] of [['removed', r.removed], ['brought back', r.added], ['reverted', r.changed]]) {
        if (names.length) ui.dim(`${label}: ${names.join(', ')}`);
      }
      if (r.left) ui.dim(`${r.left} older step${r.left === 1 ? '' : 's'} left (upex undo)`);
    });
}
