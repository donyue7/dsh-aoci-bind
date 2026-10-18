import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { planRepair } from '../lib/binding.js';
import { applyPlan } from '../lib/patchfiles.js';
import { buildSnapshot } from '../lib/state.js';
import { boundPatch, configFor, makePlainDir, makeRepo, makeTemp, readText, writeRegistry } from './helpers.mjs';

/** Home + two indexed repositories, one already bound. */
async function scenario() {
  const home = await makeTemp();
  const repos = path.join(home, 'repos');
  const gys = await makeRepo(repos, 'Gys');
  const store = await makeRepo(repos, 'StoreProject');
  await writeRegistry(home, [
    { id: 'w1', path: gys, title: 'Gys' },
    { id: 'w2', path: store, title: 'StoreProject' },
  ]);
  const patch = path.join(home, 'cordis.patch.yml');
  await fs.writeFile(patch, boundPatch({ repo: gys }), 'utf8');
  return { home, repos, gys, store, patch, config: configFor(home) };
}

/** Repair once and return the applied result plus the fresh snapshot. */
async function repair(config) {
  const snapshot = await buildSnapshot(config);
  const plan = planRepair({ diagnosis: snapshot.diagnosis, rows: snapshot.rows, config });
  const applied = await applyPlan(plan, config, {});
  const after = await buildSnapshot(config);
  return { snapshot, plan, applied, after };
}

test('a workspace with an index but no MCP row is reported unbound (StoreProject case)', async () => {
  const { store, config } = await scenario();
  const snapshot = await buildSnapshot(config);
  const storeState = snapshot.diagnosis.workspaces.find((workspace) => workspace.path === store);
  assert.equal(storeState.state, 'unbound');
  assert.equal(storeState.hasIndex, true);
  assert.match(storeState.detail, /没有任何 AOCI MCP 行/);
  const gysState = snapshot.diagnosis.workspaces.find((workspace) => workspace.hasIndex && workspace.path !== store);
  assert.equal(gysState.state, 'bound');
});

test('repair binds it, and running repair again changes nothing', async () => {
  const { patch, store, config } = await scenario();
  const first = await repair(config);
  assert.equal(first.applied.ok, true);
  assert.equal(first.applied.changes.length, 1);
  const bound = first.after.diagnosis.workspaces.find((workspace) => workspace.path === store);
  assert.equal(bound.state, 'bound');
  assert.equal(bound.serverName, 'aoci-storeproject');

  const textAfterFirst = await readText(patch);
  const second = await repair(config);
  assert.equal(second.plan.changes.length, 0, 'second repair must be a no-op');
  assert.equal(await readText(patch), textAfterFirst, 'file must be byte-identical');
});

test('two workspaces with the same directory name get distinct serverNames', async () => {
  const home = await makeTemp();
  const repos = path.join(home, 'repos');
  const left = await makeRepo(path.join(repos, 'left'), 'twin');
  const right = await makeRepo(path.join(repos, 'right'), 'twin');
  await writeRegistry(home, [
    { id: 'w1', path: left, title: 'left-twin' },
    { id: 'w2', path: right, title: 'right-twin' },
  ]);
  const config = configFor(home);
  const first = await repair(config);
  assert.equal(first.applied.ok, true);
  const names = first.after.rows.map((row) => row.serverName).sort();
  assert.deepEqual(names, ['aoci-twin', 'aoci-twin-2']);
  assert.equal(new Set(first.after.rows.map((row) => row.id)).size, 2);
  assert.equal(first.after.diagnosis.duplicates.length, 0);
});

test('a row pointing at another repository is repaired in place', async () => {
  const home = await makeTemp();
  const repos = path.join(home, 'repos');
  const store = await makeRepo(repos, 'StoreProject');
  await writeRegistry(home, [{ id: 'w1', path: store, title: 'StoreProject' }]);
  const patch = path.join(home, 'cordis.patch.yml');
  await fs.writeFile(patch, boundPatch({ id: 'aoci-storeproject', serverName: 'aoci-storeproject', repo: path.join(home, 'gone', 'StoreProject') }), 'utf8');
  const config = configFor(home);

  const before = await buildSnapshot(config);
  const state = before.diagnosis.workspaces.find((workspace) => workspace.path === store);
  assert.equal(state.state, 'wrong_repo');
  assert.equal(state.rowId, 'aoci-storeproject');

  const first = await repair(config);
  assert.equal(first.applied.ok, true);
  assert.equal(first.applied.changes[0].action, 'replace');
  const after = first.after.diagnosis.workspaces.find((workspace) => workspace.path === store);
  assert.equal(after.state, 'bound');
  const text = await readText(patch);
  assert.match(text, /StoreProject/);
  assert.equal((text.match(/aoci-storeproject/g) ?? []).length >= 1, true);
});

test('a corrupt patch file is refused and left untouched', async () => {
  const { home, store, config } = await scenario();
  const patch = path.join(home, 'cordis.patch.yml');
  const corrupt = '- insert:\n\t- id: aoci-broken\n';
  await fs.writeFile(patch, corrupt, 'utf8');
  const snapshot = await buildSnapshot(config);
  assert.equal(snapshot.files.find((file) => file.role === 'home').parsed.ok, false);
  const plan = planRepair({ diagnosis: snapshot.diagnosis, rows: snapshot.rows, config });
  const applied = await applyPlan(plan, config, {});
  assert.equal(applied.ok, false);
  assert.match(applied.errors.join(' '), /不是合法 YAML/);
  assert.equal(await readText(patch), corrupt, 'corrupt file must not be modified');
  assert.equal(snapshot.diagnosis.workspaces.find((workspace) => workspace.path === store).state, 'unbound');
});

test('a binding that lives only in the legacy home is inert, and repair adds an active one', async () => {
  const home = await makeTemp();
  const repos = path.join(home, 'repos');
  const gys = await makeRepo(repos, 'Gys');
  await writeRegistry(home, [{ id: 'w1', path: gys, title: 'Gys' }]);
  const legacy = path.join(home, '.dsh', 'cordis.patch.yml');
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(legacy, boundPatch({ repo: gys }), 'utf8');
  const config = configFor(home, { legacyHome: 'on' });
  assert.ok(config.patchFiles.some((entry) => entry.role === 'legacy'));
  const snapshot = await buildSnapshot(config);
  const state = snapshot.diagnosis.workspaces.find((workspace) => workspace.path === gys);
  // The legacy patch is a compatibility shadow: the Host does not read it, so a
  // legacy-only binding is still "unbound" from a Session's point of view.
  assert.equal(state.state, 'unbound');
  assert.equal(state.legacyShadow, true);
  assert.match(state.detail, /旧 home/);

  const legacyBefore = await readText(legacy);
  const first = await repair(config);
  assert.equal(first.applied.ok, true);
  assert.equal(first.applied.changes[0].file, config.patchFiles[0].file, 'the active home must be written');
  assert.equal(await readText(legacy), legacyBefore, 'the legacy shadow must not be rewritten');
  const after = first.after.diagnosis.workspaces.find((workspace) => workspace.path === gys);
  assert.equal(after.state, 'bound');
  assert.equal(after.role, 'home');
});

test('a plugin mount row that merely shares the aoci- id prefix is not an AOCI server', async () => {
  const home = await makeTemp();
  const repos = path.join(home, 'repos');
  const gys = await makeRepo(repos, 'Gys');
  await writeRegistry(home, [{ id: 'w1', path: gys, title: 'Gys' }]);
  const patch = path.join(home, 'cordis.patch.yml');
  await fs.writeFile(
    patch,
    [
      '# >>> dsh-aoci-bind (managed by scripts/install.ps1) >>>',
      '- insert:',
      '    - id: aoci-bind',
      "      name: 'dsh-aoci-bind'",
      '# <<< dsh-aoci-bind (managed by scripts/install.ps1) <<<',
      '',
      boundPatch({ repo: gys }),
    ].join('\n'),
    'utf8',
  );
  const config = configFor(home);
  const snapshot = await buildSnapshot(config);
  // `aoci-bind` has no serverName and no aoci command, so it is not a server row.
  assert.equal(snapshot.rows.some((row) => row.id === 'aoci-bind'), false);
  assert.equal(snapshot.diagnosis.orphans.length, 0, 'the plugin row must not be an orphan');
  assert.equal(snapshot.diagnosis.workspaces.find((workspace) => workspace.path === gys).state, 'bound');
});

test('a repository without an index is a warning, not a failure', async () => {
  const home = await makeTemp();
  const repos = path.join(home, 'repos');
  const gys = await makeRepo(repos, 'Gys');
  await writeRegistry(home, [{ id: 'w1', path: gys, title: 'Gys' }]);
  const config = configFor(home);
  await applyPlan(
    planRepair({ diagnosis: (await buildSnapshot(config)).diagnosis, rows: [], config }),
    config,
    {},
  );
  const snapshot = await buildSnapshot(config);
  const gysState = snapshot.diagnosis.workspaces.find((workspace) => workspace.path === gys);
  assert.equal(gysState.state, 'bound');
  const empty = await makePlainDir(repos, 'Empty');
  await writeRegistry(home, [
    { id: 'w1', path: gys, title: 'Gys' },
    { id: 'w2', path: empty, title: 'Empty' },
  ]);
  const withEmpty = await buildSnapshot(config);
  assert.equal(withEmpty.diagnosis.workspaces.find((workspace) => workspace.path === empty).state, 'no_index');
  assert.equal(withEmpty.diagnosis.ok, true, 'no_index is a warning, not an error');
});

test('other MCP servers (zxy, omnisockit) are not mistaken for AOCI rows', async () => {
  const home = await makeTemp();
  const repos = path.join(home, 'repos');
  const gys = await makeRepo(repos, 'Gys');
  await writeRegistry(home, [{ id: 'w1', path: gys, title: 'Gys' }]);
  const dbRow = [
    '- insert:',
    '    - id: DB',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    "        serverName: zxy",
    '        transport: stdio',
    '        command: npx',
    '        args:',
    "          - '-y'",
    "          - '@benborla29/mcp-server-mysql'",
    '',
  ].join('\n');
  await fs.writeFile(path.join(home, 'cordis.patch.yml'), dbRow, 'utf8');
  const config = configFor(home);
  const snapshot = await buildSnapshot(config);
  assert.equal(snapshot.rows.length, 0, 'a non-AOCI MCP server is not a binding');
  assert.equal(snapshot.diagnosis.orphans.length, 0);
  assert.equal(snapshot.diagnosis.workspaces.find((workspace) => workspace.path === gys).state, 'unbound');
});

test('orphan rows are reported, and pruned only when asked', async () => {
  const { home, gys, config } = await scenario();
  const patch = path.join(home, 'cordis.patch.yml');
  const text = await readText(patch);
  await fs.writeFile(patch, `${text}${boundPatch({ id: 'aoci-ghost', serverName: 'aoci-ghost', repo: path.join(home, 'nowhere') })}`, 'utf8');
  const snapshot = await buildSnapshot(config);
  assert.equal(snapshot.diagnosis.orphans.length, 1);
  assert.equal(snapshot.diagnosis.orphans[0].id, 'aoci-ghost');

  const kept = await repair(config);
  assert.ok(
    kept.plan.changes.every((change) => change.id !== 'aoci-ghost'),
    'orphans stay unless pruned',
  );
  assert.ok(kept.after.diagnosis.orphans.some((orphan) => orphan.id === 'aoci-ghost'));
  const pruned = await applyPlan(
    planRepair({ diagnosis: kept.after.diagnosis, rows: kept.after.rows, config, pruneOrphans: true }),
    config,
    {},
  );
  assert.equal(pruned.ok, true);
  assert.ok(pruned.changes.some((change) => change.id === 'aoci-ghost' && change.action === 'remove'));
  const after = await buildSnapshot(config);
  assert.equal(after.diagnosis.orphans.length, 0);
  assert.equal(after.diagnosis.workspaces.find((workspace) => workspace.path === gys).state, 'bound');
});
