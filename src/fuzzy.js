/**
 * fuzzy.js — Fuzzy matching utility for shortcut names
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
 * Resolve a shortcut name — exact match first, then fuzzy.
 * Returns { name, exact } or null.
 */
export function resolveName(query, links) {
  const names = Object.keys(links);

  // Exact match
  if (query in links) {
    return { name: query, exact: true };
  }

  // Fuzzy match
  const result = fuzzyMatch(query, names);
  if (result) {
    return { name: result.match, exact: false };
  }

  return null;
}

