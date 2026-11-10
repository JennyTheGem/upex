import { home, cli } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMAND_NAMES, isPathArg } from '../src/fast.js';
import { createProgram } from '../src/index.js';
import { resolveTarget, resolveName, suggestNames } from '../src/fuzzy.js';
import { pruneBroken, lastUsedName, nameError, takenError, checkAliases, aliasClashes } from '../src/store.js';

test('__resolve never shadows a real subcommand', async () => {
  const r = spawnSync(process.execPath, [cli, '__resolve', 'list'], { encoding: 'utf-8' });
  assert.equal(r.status, 1, '__resolve refuses subcommand names');
  assert.equal(r.stdout, '', 'no path printed for subcommand names');
  const fastUrl = new URL('../src/fast.js', import.meta.url).href;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', `import { fastPath } from '${fastUrl}'; fastPath(['__resolve', 'list']); process.exit(7);`]).status, 1, 'fast path refuses subcommand names itself');
  // a lone `upex --help` through a wrapper must fall through, not cd into help text
  const h = spawnSync(process.execPath, [cli, '__resolve', '--help'], { encoding: 'utf-8' });
  assert.equal(h.status, 1, '__resolve refuses --help');
  assert.deepEqual([...COMMAND_NAMES].sort(), (await createProgram()).commands.flatMap(c => [c.name(), ...c.aliases()]).sort(), 'fast path knows every command name');
  assert.equal(h.stdout, '', 'no help text printed for the wrapper to cd into');
  for (const p of ['.', '..', './x', '..\\x', '~', '~/x', path.resolve('x')]) assert.ok(isPathArg(p), `path arg: ${p}`);
  for (const n of ['web', '.dotfiles', '..x', '~x', 'web/src']) assert.ok(!isPathArg(n), `shortcut name: ${n}`);
});

test('lazy commands: each name loads its own command; `upex list` loads neither the selector nor the web UI', async () => {
  for (const n of COMMAND_NAMES) assert.ok((await createProgram(['node', 'upex', n])).commands.some(c => c.name() === n || c.aliases().includes(n)), `${n} loads its command`);
  // registerHooks needs Node 22.15.
  if ((await import('node:module')).registerHooks) {
    const hook = 'data:text/javascript,' + encodeURIComponent(`import { registerHooks } from 'node:module';
const seen = [];
registerHooks({ load: (url, ctx, next) => (seen.push(url), next(url, ctx)) });
process.on('exit', () => process.stderr.write('\\nloaded ' + seen.join(' ')));`);
    const r = spawnSync(process.execPath, ['--import', hook, cli, 'list'], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: home, HOME: home } });
    const loaded = r.stderr.split('\nloaded ').at(-1);
    assert.ok(r.status === 0 && loaded.includes('/commands/list.js') && !/interactive\.js|commands\/(web|add)\.js/.test(loaded), 'upex list loads only its own command');
  }
});

test('resolveTarget: exact, subpath, fuzzy head, slash-named shortcut wins', () => {
  const rl = { web: {}, api: {}, 'a/b': {} };
  assert.deepEqual(resolveTarget('web', rl), { name: 'web', exact: true, sub: '' }, 'exact name');
  assert.deepEqual(resolveTarget('web/src/x', rl), { name: 'web', exact: true, sub: 'src/x' }, 'subpath split');
  assert.deepEqual(resolveTarget('web\\src', rl), { name: 'web', exact: true, sub: 'src' }, 'backslash subpath');
  assert.equal(resolveTarget('wbe/src', rl).name, 'web', 'fuzzy head keeps the subpath');
  assert.deepEqual(resolveTarget('a/b', rl), { name: 'a/b', exact: true, sub: '' }, 'full name with a slash wins');
  assert.deepEqual(resolveTarget('a/b/c', rl), { name: 'a/b', exact: true, sub: 'c' }, 'slash-named shortcut takes a subpath');
  assert.equal(resolveTarget('zzzzzz', rl), null, 'no match -> null');
});

test('aliases + archive in resolution and name checks', () => {
  const al = { velora: { aliases: ['vd'] }, vdx: {}, old: { archived: true, aliases: ['o'] } };
  assert.deepEqual(resolveName('vd', al), { name: 'velora', exact: true }, 'alias resolves exactly');
  assert.deepEqual(resolveTarget('vd/src', al), { name: 'velora', exact: true, sub: 'src' }, 'alias takes a subpath');
  assert.equal(resolveName('old', al), null, 'archived hidden from resolve');
  assert.deepEqual(resolveName('o', al, true), { name: 'old', exact: true }, 'archived-only search finds it by alias');
  assert.equal(takenError(al, 'vd'), '"vd" is an alias of velora.', 'alias blocks a new name');
  assert.match(takenError(al, 'old'), /archived/, 'archived name blocks with a restore hint');
  assert.equal(takenError(al, 'vd', 'velora'), null, 'own alias is not taken');
  assert.deepEqual(checkAliases(al, 'vdx', ['a', 'a', 'vdx']), { aliases: ['a'] }, 'dupes and own name dropped');
  assert.match(checkAliases(al, 'vdx', ['vd']).error, /alias of velora/, 'alias of another rejected');
  assert.deepEqual(aliasClashes({ a: { aliases: ['b'] }, b: {}, c: { aliases: ['x'] }, d: { aliases: ['x'] } }), ['b: b, a', 'x: c, d'], 'clashes found');
  assert.equal(lastUsedName({ x: { lastUsed: 9, archived: true }, y: { lastUsed: 1 } }), 'y', 'last skips archived');
  assert.deepEqual(aliasClashes({ x: { aliases: ['x', 'y', 'y'] } }), [], 'self alias and repeats are no clash');
  const pa = { proj: { path: '/p', archived: true }, proj2: { path: '/p2' } };
  assert.equal(resolveName('proj', pa), null, 'archived exact name does not fuzzy-match a neighbour');
  assert.equal(resolveTarget('proj/src', pa), null, 'archived exact head does not fuzzy-match a neighbour');
  assert.equal(resolveName('proj2', pa, true), null, 'restore of a live name finds nothing');
  assert.deepEqual(Object.keys(pruneBroken(pa, () => false).kept), ['proj'], 'prune keeps archived shortcuts');
});

test('names: one rule for CLI, selector and web', () => {
  assert.equal(nameError('dev'), null, 'plain name ok');
  assert.ok(nameError('') && nameError('a b') && nameError('__proto__'), 'empty, spaced and __proto__ rejected');
  assert.deepEqual(suggestNames('webap', ['webapp', 'notes']), ['webapp'], 'close name suggested');
});
