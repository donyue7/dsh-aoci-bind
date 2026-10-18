/**
 * Apply (or preview) the binding repair against the real DSH home.
 *
 * This is the same code path the Host tool uses: it mounts the plugin on a
 * minimal context and calls `aoci_bind_repair`. Nothing else is touched.
 *
 * Usage:
 *   node scripts/apply.mjs --dry-run   # show the planned edits only
 *   node scripts/apply.mjs             # write the edits (with backups)
 */

import { apply } from '../lib/index.js';

const dryRun = process.argv.includes('--dry-run');
const tools = new Map();
const ctx = {
  logger: { info() {}, warn() {} },
  tools: { register: (definition) => tools.set(definition.name, definition) },
  inject() {},
};
apply(ctx, {});

const definition = tools.get('aoci_bind_repair');
if (definition === undefined) throw new Error('aoci_bind_repair was not registered');

const args = { dry_run: dryRun };
const value = await definition.execute(args, {});
console.log(definition.output.render(args, value).map((block) => block.text).join('\n'));
console.log('\n--- machine readable ---');
console.log(JSON.stringify(value, null, 2));
if (!value.ok) process.exitCode = 1;
