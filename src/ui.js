/**
 * ui.js -- Shared output helpers for consistent terminal formatting.
 *
 * Visual hierarchy (matches the selector):
 *   heading()    -- "upex   <title>" over a dim full-width rule
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

// Row width after the 2-space indent, like the selector (last column kept free, at most 100 wide).
export const cols = () => Math.min(Math.max((process.stdout.columns || 80) - 1, 20), 100) - 2;

export function heading(text) {
  console.log();
  console.log(`  ${chalk.bold('upex')}   ${chalk.bold(text)}`);
  separator();
}

// Folder part dim, last part through `last`.
export function dimParent(p, last = s => s) {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1;
  return chalk.dim(p.slice(0, cut)) + last(p.slice(cut));
}

// Heading plus dim "key   value" lines; empty values skipped.
export function card(title, pairs) {
  heading(title);
  for (const [k, v] of pairs) if (v) console.log(`  ${chalk.dim(k.padEnd(6))} ${v}`);
  blank();
}

export function dim(msg) {
  console.log(chalk.dim(`  ${msg}`));
}

/**
 * Print a nicely aligned table from an array of [col1, col2, ...] rows.
 * When header=true, the first row is a dim lowercase label row.
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

  for (let r = 0; r < rows.length; r++) {
    const row = header && r === 0 ? rows[0].map(c => chalk.dim(stripAnsi(String(c)).toLowerCase())) : rows[r];
    let line = ' '.repeat(indent);
    for (let i = 0; i < colCount; i++) {
      const cell = String(row[i]);
      const stripped = stripAnsi(cell);
      const pad = widths[i] - stripped.length + gap;
      line += cell + (i < colCount - 1 ? ' '.repeat(Math.max(pad, 1)) : '');
    }
    console.log(line);
  }
}

/**
 * Minimal ANSI strip (for column width calculation).
 */
export function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

// Built on first use: it costs ~12ms, and every command imports this file.
let segmenter;
// Emoji and CJK take two terminal columns.
const WIDE = /\p{Emoji_Presentation}|\uFE0F|[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
// One column each, never joined: ASCII, Latin, punctuation, arrows, box drawing and shapes the UI uses.
const NARROW = /^[\x20-\x7e\u00a0-\u02ff\u2010-\u2027\u2030-\u205e\u2190-\u21ff\u2500-\u25fc]*$/;

/** Characters as { segment, index (UTF-16), w (columns) }. */
export const graphemes = s => (NARROW.test(s)
  ? Array.from(s, (segment, index) => ({ segment, index, w: 1 }))
  : Array.from((segmenter ??= new Intl.Segmenter()).segment(s), g => ({ ...g, w: WIDE.test(g.segment) ? 2 : 1 })));

/** Visible terminal columns of a styled string. */
export const width = s => {
  const t = stripAnsi(s);
  return NARROW.test(t) ? t.length : graphemes(t).reduce((n, g) => n + g.w, 0);
};

/** Longest start (or end) of a plain string that fits in `n` columns, never splitting a character. */
export function fit(s, n, fromEnd = false) {
  const gs = graphemes(s);
  if (fromEnd) gs.reverse();
  let used = 0;
  let k = 0;
  while (k < gs.length && used + gs[k].w <= n) used += gs[k++].w;
  const kept = gs.slice(0, k).map(g => g.segment);
  return (fromEnd ? kept.reverse() : kept).join('');
}

/**
 * Clip a styled string to `cols` visible columns, keeping ANSI codes intact.
 */
export function truncate(str, cols) {
  if (cols <= 0) return '';
  if (width(str) <= cols) return str;

  let out = '';
  let budget = cols - 1; // one column reserved for the ellipsis
  // eslint-disable-next-line no-control-regex
  for (const part of str.split(/(\x1B\[[0-9;]*m)/)) {
    if (part.startsWith('\x1B')) { out += part; continue; }
    const kept = fit(part, budget);
    out += kept;
    budget -= width(kept);
    if (kept.length < part.length) break;
  }
  return out + '…\x1B[0m';
}

export function separator(length = cols()) {
  console.log(chalk.dim('  ' + '─'.repeat(length)));
}

export function blank() {
  console.log();
}

// Compact length of time: "45m", "12h", "3d". Time left passes Math.ceil.
export function span(ms, round = Math.floor) {
  const m = Math.max(0, round(ms / 60000));
  if (m < 60) return `${m}m`;
  if (m < 2880) return `${round(m / 60)}h`;
  return `${round(m / 1440)}d`;
}
