/**
 * ui.js -- Shared output helpers for consistent terminal formatting.
 *
 * Visual hierarchy:
 *   heading()    -- bold text inside a dim box-drawn frame
 *   separator()  -- dim horizontal rule
 *   info()       -- plain indented text
 *   dim()        -- subdued supplemental text
 *
 * Color roles (max 3):
 *   green  -- success
 *   yellow -- warning
 *   red    -- error
 */

import chalk from 'chalk';

// Fixed-width status tags (6 chars each)
export const tag = {
  ok:   chalk.green('[ OK ]'),
  warn: chalk.yellow('[WARN]'),
  fail: chalk.red('[FAIL]'),
  skip: chalk.dim('[SKIP]'),
};

export function success(msg) {
  console.log(chalk.green(`  ${msg}`));
}

export function error(msg) {
  console.error(chalk.red(`  ${msg}`));
}

export function warn(msg) {
  console.log(chalk.yellow(`  ${msg}`));
}

export function info(msg) {
  console.log(`  ${msg}`);
}

export function heading(text) {
  const w = text.length + 4;
  console.log();
  console.log(chalk.dim(`  ┌${'─'.repeat(w)}┐`));
  console.log(`  ${chalk.dim('│')}  ${chalk.bold(text)}  ${chalk.dim('│')}`);
  console.log(chalk.dim(`  └${'─'.repeat(w)}┘`));
  console.log();
}

export function dim(msg) {
  console.log(chalk.dim(`  ${msg}`));
}

/**
 * Print a nicely aligned table from an array of [col1, col2, ...] rows.
 * When header=true, a separator line is drawn after the first row.
 */
export function table(rows, { indent = 2, gap = 2, header = false } = {}) {
  if (!rows.length) return;

  const colCount = rows[0].length;
  const widths = Array.from({ length: colCount }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const len = stripAnsi(String(row[i])).length;
      if (len > widths[i]) widths[i] = len;
    }
  }

  const totalWidth = widths.reduce((a, b) => a + b, 0) + (colCount - 1) * gap;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let line = ' '.repeat(indent);
    for (let i = 0; i < colCount; i++) {
      const cell = String(row[i]);
      const stripped = stripAnsi(cell);
      const pad = widths[i] - stripped.length + gap;
      line += cell + (i < colCount - 1 ? ' '.repeat(Math.max(pad, 1)) : '');
    }
    console.log(line);

    if (header && r === 0) {
      console.log(chalk.dim(' '.repeat(indent) + '─'.repeat(totalWidth)));
    }
  }
}

/**
 * Minimal ANSI strip (for column width calculation).
 */
export function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * Clip a styled string to `width` visible columns, keeping ANSI codes intact.
 */
export function truncate(str, width) {
  if (width <= 0) return '';
  if (stripAnsi(str).length <= width) return str;

  let out = '';
  let budget = width - 1; // one column reserved for the ellipsis
  // eslint-disable-next-line no-control-regex
  for (const part of str.split(/(\x1B\[[0-9;]*m)/)) {
    if (part.startsWith('\x1B')) { out += part; continue; }
    if (part.length <= budget) {
      out += part;
      budget -= part.length;
      continue;
    }
    out += part.slice(0, budget);
    break;
  }
  return out + '…\x1B[0m';
}

export function separator(length = 60) {
  console.log(chalk.dim('  ' + '─'.repeat(length)));
}

export function blank() {
  console.log();
}
