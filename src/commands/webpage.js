/**
 * webpage.js -- Open a folder shortcut's git remote (GitHub, GitLab, ...) in the browser.
 * Usage: upex web <name>
 */

import path from 'node:path';
import chalk from 'chalk';
import { loadLinks, recordUse } from '../store.js';
import { resolveName, didYouMean } from '../fuzzy.js';
import { gitRemote, remoteWebUrl } from '../git.js';
import { launchUrl } from '../launcher.js';
import { isFile } from './open.js';
import * as ui from '../ui.js';

export function registerWebPage(program) {
  program
    .command('web <name>')
    .description('Open the web page (GitHub etc.) of a folder shortcut\'s git remote "origin"')
    .summary('Open a project\'s GitHub page')
    .action((name) => {
      const fail = (msg, hint) => {
        ui.error(msg);
        if (hint) ui.dim(hint);
        process.exit(1);
      };
      const links = loadLinks();
      const resolved = resolveName(name, links);
      if (!resolved) fail(`Shortcut not found: ${name}`, didYouMean(name, links));

      const entry = links[resolved.name];
      if (!entry.path) fail(`"${resolved.name}" has no folder, so it has no git remote.`);
      const dir = isFile(entry.path) ? path.dirname(entry.path) : entry.path;
      const remote = gitRemote(dir);
      if (!remote) fail(`No git remote "origin" in ${dir}`);
      const url = remoteWebUrl(remote);
      if (!url) fail(`Can't turn the remote into a web page: ${remote}`);

      const result = launchUrl(url);
      if (!result.ok) fail(result.message);
      recordUse(resolved.name, 'web');

      if (!resolved.exact) ui.dim(`matched "${name}" --> "${resolved.name}"`);
      ui.card(resolved.name, [['url', chalk.bold(url)]]);
    });
}
