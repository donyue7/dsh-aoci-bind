/**
 * Read-only demo: mount dsh-aoci-bind on a fake Host context and run the three
 * read-only tools against the *real* DSH home, then show what `aoci_bind_repair`
 * would plan without writing anything.
 *
 * Nothing here writes: status and doctor are read-only by construction, and the
 * repair call uses `dry_run: true`.
 *
 * Usage:
 *   node scripts/status.mjs
 */

import { apply } from '../lib/index.js';

const tools = new Map();
const ctx = {
  logger: { info() {}, warn() {} },
  tools: { register: (definition) => tools.set(definition.name, definition) },
  inject() {},
};

apply(ctx, {});

const call = async (name, args = {}) => {
  const definition = tools.get(name);
  if (definition === undefined) throw new Error(`tool ${name} was not registered`);
  const value = await definition.execute(args, {});
  const rendered = definition.output.render(args, value);
  return { value, text: rendered.map((block) => block.text).join('\n') };
};

const status = await call('aoci_bind_status');
console.log('===== aoci_bind_status =====');
console.log(status.text);

const doctor = await call('aoci_doctor');
console.log('\n===== aoci_doctor =====');
console.log(doctor.text);

const dry = await call('aoci_bind_repair', { dry_run: true });
console.log('\n===== aoci_bind_repair (dry run) =====');
console.log(dry.text);

console.log('\n===== 机器可读摘要 =====');
console.log(JSON.stringify({ status: status.value.summary, doctor: { ok: doctor.value.ok, summary: doctor.value.summary }, planned: dry.value.changes }, null, 2));
