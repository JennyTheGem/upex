/**
 * fuzzy.js -- Fuzzy matching utility for shortcut names
 */

import Fuse from 'fuse.js';

/**
 * Find the best fuzzy match for `query` in a list of shortcut names.
 * Returns { match, score } or null.
 */
export function fuzzyMatch(query, names) {
  if (!names.length) return null;

  const fuse = new Fuse(names.map(n => ({ name: n })), {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true,
  });

  const results = fuse.search(query);
  if (results.length === 0) return null;

  return {
    match: results[0].item.name,
    score: results[0].score,
  };
}

/**
 * Resolve a shortcut name: exact match first, then fuzzy.
 * Returns { name, exact } or null.
 */
export function resolveName(query, links) {
  const names = Object.keys(links);

  // Exact match
  if (Object.hasOwn(links, query)) {
    return { name: query, exact: true };
  }

  // Fuzzy match
  const result = fuzzyMatch(query, names);
  if (result) {
    return { name: result.match, exact: false };
  }

  return null;
}

/**
 * resolveName plus subpaths: "web/src" -> { name: "web", exact, sub: "src" }.
 * The longest exact name wins, so names containing "/" still work.
 */
export function resolveTarget(query, links) {
  if (Object.hasOwn(links, query)) return { name: query, exact: true, sub: '' };
  for (const cut of [...query.matchAll(/[/\\]+/g)].reverse()) {
    const name = query.slice(0, cut.index);
    if (Object.hasOwn(links, name)) return { name, exact: true, sub: query.slice(cut.index + cut[0].length) };
  }
  const m = query.match(/^([^/\\]+)[/\\]+(.+)$/);
  const head = m && resolveName(m[1], links);
  if (head) return { ...head, sub: m[2] };
  const r = resolveName(query, links);
  return r && { ...r, sub: '' };
}

