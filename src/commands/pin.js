/**
 * pin.js -- Pin shortcuts to the top of the selector and upex ui.
 * Usage: upex pin            list pinned shortcuts
 *        upex pin <name>     pin it
 *        upex unpin <name>   unpin it
 */

import { loadLinks, setLink, activeLinks } from '../store.js';
import { exactShortcut } from './remove.js';
import * as ui from '../ui.js';

function setPinned(name, on) {
  const links = loadLinks();
  const owner = exactShortcut(name, links, on ? 'pin' : 'unpin');
  if (!owner) process.exit(1);
  if (!!links[owner].pinned === on) {
    ui.info(`${owner} is ${on ? 'already' : 'not'} pinned.`);
    return;
  }
  const { pinned: _old, ...entry } = links[owner];
  setLink(owner, on ? { ...entry, pinned: true } : entry);
  ui.success(`${on ? 'Pinned' : 'Unpinned'}: ${owner}`);
}

export function registerPin(program) {
  program
    .command('pin [name]')
    .description('Pin a shortcut to the top of the selector and upex ui, or list pinned ones')
    .summary('Pin a shortcut to the top (no name: list pinned)')
    .action((name) => {
      if (name) return setPinned(name, true);
      const pinned = Object.entries(activeLinks(loadLinks())).filter(([, e]) => e.pinned).map(([n]) => n);
      if (!pinned.length) ui.info('Nothing pinned. Pin one: upex pin <name>');
      else ui.info(`Pinned: ${pinned.join(', ')}`);
    });

  program
    .command('unpin <name>')
    .description('Unpin a shortcut')
    .action((name) => setPinned(name, false));
}
