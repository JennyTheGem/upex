/**
 * last.js -- Reopen the most recently used shortcut.
 * Usage: upex last   (or the shorthand: upex -)
 */

import { lastUsedName } from '../store.js';
import { handleOpen } from './open.js';
import * as ui from '../ui.js';

export function registerLast(program) {
  program
    .command('last')
    .description('Reopen the most recently used shortcut')
    .action(() => {
      const name = lastUsedName();
      if (!name) {
        ui.warn('No shortcut has been used yet.');
        process.exit(1);
      }
      return handleOpen(name);
    });
}
