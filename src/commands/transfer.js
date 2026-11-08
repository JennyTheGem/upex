/**
 * transfer.js -- Export/import shortcuts (and config) for backup or sync.
 * Usage: upex export [file]        -- write a JSON bundle (stdout if no file)
 *        upex import <file>        -- merge a bundle into the store
 *        upex import <file> --replace  -- replace the store entirely
 */

import fs from 'node:fs';
import {
  loadLinks, saveLinks, loadConfig, saveConfig, mergeLinks, aliasClashes,
} from '../store.js';
import * as ui from '../ui.js';

export const bundleOf = () => ({ upex: 'bundle', version: 1, links: loadLinks(), config: loadConfig() });

/**
 * Merge a bundle (or a bare links map) into the store; `replace` swaps it in instead.
 * Returns { added, updated, clashes }, or { error } when nothing in it is importable.
 */
export function importBundle(bundle, replace = false) {
  // Accept a full bundle or a bare links map.
  const incoming = bundle?.links && typeof bundle.links === 'object' ? bundle.links : bundle;
  if (!incoming || typeof incoming !== 'object') return { error: 'Nothing importable in that file.' };

  const hasConfig = bundle.config && typeof bundle.config === 'object';
  // Read config before saving links, so a corrupt config.json aborts without a partial import.
  const current = hasConfig ? loadConfig() : null;
  const { merged, added, updated } = mergeLinks(loadLinks(), incoming, { replace });
  saveLinks(merged);

  // Merge config (apps + workspaces) without clobbering unless replacing.
  if (hasConfig) {
    const inc = bundle.config;
    saveConfig(replace ? inc : {
      ...current,
      ...inc,
      apps: { ...(current.apps || {}), ...(inc.apps || {}) },
      workspaces: { ...(current.workspaces || {}), ...(inc.workspaces || {}) },
    });
  }
  return { added, updated, clashes: aliasClashes(merged) };
}

export function registerExport(program) {
  program
    .command('export [file]')
    .description('Export shortcuts + config as a JSON bundle (stdout if no file)')
    .summary('Export shortcuts + config as JSON')
    .action((file) => {
      const bundle = bundleOf();
      const json = JSON.stringify(bundle, null, 2);
      if (!file) {
        process.stdout.write(json + '\n');
        return;
      }
      fs.writeFileSync(file, json, 'utf-8');
      ui.success(`Exported ${Object.keys(bundle.links).length} shortcuts --> ${file}`);
    });
}

export function registerImport(program) {
  program
    .command('import <file>')
    .description('Import a bundle (merge by default, --replace to overwrite)')
    .summary('Import a bundle (merge, or --replace)')
    .option('--replace', 'Replace all existing shortcuts instead of merging')
    .action((file, options) => {
      let bundle;
      try {
        bundle = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch (err) {
        ui.error(`Cannot read ${file}: ${err.message}`);
        process.exit(1);
      }

      const { added, updated, clashes, error } = importBundle(bundle, options.replace);
      if (error) {
        ui.error(error);
        process.exit(1);
      }
      ui.success(`Imported: ${added.length} added, ${updated.length} updated.`);
      if (added.length) ui.dim(`Added: ${added.join(', ')}`);
      if (updated.length) ui.dim(`Updated: ${updated.join(', ')}`);
      if (clashes.length) ui.warn(`Names used twice: ${clashes.join('; ')}. Fix with: upex alias <name> -r <alias>`);
    });
}
