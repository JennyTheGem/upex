/**
 * fuzzy.js -- Fuzzy matching utility for shortcut names
 */

import { createRequire } from 'node:module';
import { activeLinks, aliasesOf, nameOwner } from './store.js';

// Loaded on first fuzzy search: exact hits (the cd hot path) never pay for it.
const require = createRequire(import.meta.url);
const Fuse = (...args) => new (require('fuse.js'))(...args);

/**
 * Find the best fuzzy match for `query` in a list of shortcut names.
 * Returns { match, score } or null.
 */
export function fuzzyMatch(query, names) {
  if (!names.length) return null;

  const fuse = Fuse(names.map(n => ({ name: n })), {
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

// Up to `n` close names for a "did you mean" hint; looser than resolving.
export function suggestNames(query, names, n = 3) {
  return Fuse(names, { threshold: 0.6 }).search(query, { limit: n }).map(r => r.item);
}

// One-line hint for a name that didn't resolve, or null.
export function didYouMean(query, links) {
  const owner = nameOwner(links, query);
  if (owner && links[owner].archived) return `"${owner}" is archived. Restore it with: upex restore ${owner}`;
  const names = Object.keys(activeLinks(links));
  const s = suggestNames(query, names);
  return s.length ? `Did you mean: ${s.join(', ')}?` : names.length ? 'See all with: upex list' : null;
}

/**
 * Resolve a shortcut name or alias: exact match first, then fuzzy.
 * Archived shortcuts are skipped (or the only ones searched, with archived = true).
 * Returns { name, exact } or null.
 */
export function resolveName(query, links, archived = false) {
  // Fuse matches anything for a blank query.
  if (!query?.trim()) return null;
  const live = activeLinks(links, archived);

  const owner = nameOwner(live, query);
  if (owner) return { name: owner, exact: true };
  // An exact name on the other side (e.g. archived) must not fuzzy-match a different shortcut.
  if (nameOwner(links, query)) return null;

  // Fuzzy over names and aliases, mapped back to the shortcut.
  const byName = new Map();
  for (const n of Object.keys(live)) {
    byName.set(n, n);
    for (const a of aliasesOf(live[n])) if (!byName.has(a)) byName.set(a, n);
  }
  const result = fuzzyMatch(query, [...byName.keys()]);
  return result ? { name: byName.get(result.match), exact: false } : null;
}

/**
 * resolveName plus subpaths: "web/src" -> { name: "web", exact, sub: "src" }.
 * The longest exact name wins, so names containing "/" still work.
 */
export function resolveTarget(query, links) {
  const live = activeLinks(links);
  const cuts = [...query.matchAll(/[/\\]+/g)].reverse().map(c => [query.slice(0, c.index), query.slice(c.index + c[0].length)]);
  for (const [head, sub] of [[query, ''], ...cuts]) {
    const name = nameOwner(live, head);
    if (name) return { name, exact: true, sub };
    // An archived exact name stops here instead of fuzzy-matching another shortcut.
    if (nameOwner(links, head)) return null;
  }
  const m = query.match(/^([^/\\]+)[/\\]+(.+)$/);
  const head = m && resolveName(m[1], links);
  if (head) return { ...head, sub: m[2] };
  const r = resolveName(query, links);
  return r && { ...r, sub: '' };
}
