/**
 * note.js -- A short free-text note per shortcut, shown in the selector's detail pane.
 * Usage: upex note <name>            show it
 *        upex note <name> <text...>  set it
 *        upex note <name> --clear    remove it
 */

import { loadLinks, setLink } from '../store.js';
import { exactShortcut } from './remove.js';
import { oneLine } from '../interactive.js';
import * as ui from '../ui.js';

export function registerNote(program) {
  program
    .command('note <name> [text...]')
    .description('Show, set or clear a short note on a shortcut (shown in the detail pane)')
    .summary('Short note on a shortcut')
    .option('--clear', 'Remove the note')
    .action((name, words, options) => {
      const links = loadLinks();
      const owner = exactShortcut(name, links, 'note');
      if (!owner) process.exit(1);
      const entry = links[owner];
      const text = oneLine(words.join(' '));
      if (!options.clear && !text) {
        ui.info(entry.note ? `${owner}: ${entry.note}` : `${owner} has no note. Add one: upex note ${owner} "..."`);
        return;
      }
      const { note, ...rest } = entry;
      setLink(owner, options.clear ? rest : { ...rest, note: text });
      ui.success(options.clear ? `${owner}: note removed` : `${owner}: ${text}`);
    });
}
