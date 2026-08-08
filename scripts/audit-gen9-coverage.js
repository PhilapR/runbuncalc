/* eslint-env node, es6 */
'use strict';

/**
 * Gen 9 port coverage audit.
 *
 * Run & Bun runs on a Gen 8 base with selected Gen 9 elements ported in. The
 * fork defaults `state.generation` to 8, so any Gen 9 element is handled by
 * three independent layers that can disagree:
 *
 *   1. `calc/` data      — gen-indexed MOVES/ABILITIES/ITEMS tables. An element
 *                          absent from index 8 is invisible to the Gen 8 calc.
 *   2. `ai/move-metadata` — reads `@pkmn/dex` without gen-filtering, so it can
 *                          resolve an element the calc tables lack.
 *   3. `ai/` effect engine — `state.generation >= 9` gates. A gated effect is a
 *                          silent no-op at generation 8.
 *
 * The dangerous cell is "calc data missing OR effect gated, but metadata
 * resolves": the move is usable and deals damage while its defining behavior
 * silently does nothing.
 *
 * This script reports what the fork currently does. It deliberately does NOT
 * decide what Run & Bun actually ports — that column stays `?` until the R&B
 * source docs (MECHANICS.MD / MOVE_CHANGES.MD) are vendored into the repo.
 *
 * Usage:
 *   node scripts/audit-gen9-coverage.js            # write GEN9_AUDIT.md
 *   node scripts/audit-gen9-coverage.js --stdout   # print, do not write
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const MOVES = require('../calc/dist/data/moves.js').MOVES;
const ABILITIES = require('../calc/dist/data/abilities.js').ABILITIES;
const ITEMS = require('../calc/dist/data/items.js').ITEMS;
const moveMetadata = require('../ai/dist/move-metadata.js');

const BASE_GEN = 8;
const PORT_GEN = 9;

const toId = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Source files in `ai/src` that can carry generation gates. */
function aiSources() {
	const dir = path.join(root, 'ai', 'src');
	return fs.readdirSync(dir)
		.filter(f => f.endsWith('.ts'))
		.map(f => ({file: f, text: fs.readFileSync(path.join(dir, f), 'utf8')}));
}

const AI_SOURCES = aiSources();

/**
 * Find `generation >= 9` gates that name this id, e.g.
 *   `id === 'saltcure' && state.generation >= 9`
 * in either operand order.
 */
function generationGates(id) {
	const gates = [];
	const quoted = `'${id}'`;
	for (const entry of AI_SOURCES) {
		const lines = entry.text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line.includes(quoted)) continue;
			if (!/generation\s*>=\s*9/.test(line)) continue;
			gates.push(`${entry.file}:${i + 1}`);
		}
	}
	return gates;
}

/** Any mention at all of the id in `ai/src`, gated or not. */
function aiMentions(id) {
	const quoted = `'${id}'`;
	let count = 0;
	for (const entry of AI_SOURCES) {
		const parts = entry.text.split(quoted);
		count += parts.length - 1;
	}
	return count;
}

/** PS encodes never-miss accuracy as `true`; render that as "always". */
function showAccuracy(accuracy) {
	if (accuracy === undefined) return '—';
	if (accuracy === true) return 'always';
	return String(accuracy);
}

function metadataAtBaseGen(name) {
	try {
		const meta = moveMetadata.getMoveMetadata(name, BASE_GEN);
		return {source: meta.source, basePower: meta.basePower, accuracy: meta.accuracy};
	} catch (err) {
		return {source: `ERROR: ${err.message}`, basePower: undefined, accuracy: undefined};
	}
}

function auditMoves() {
	const names = Object.keys(MOVES[PORT_GEN]).filter(n => !MOVES[BASE_GEN][n]);
	return names.sort().map(name => {
		const id = toId(name);
		const gates = generationGates(id);
		const meta = metadataAtBaseGen(name);
		const resolves = meta.source === 'canonical' || meta.source === 'run-and-bun';
		// Usable at gen 8 (metadata resolves it) but its effect is gated off, or the
		// calc has no gen-8 data for it. Damage happens; behavior silently does not.
		const silent = resolves && gates.length > 0;
		return {name, id, gates, meta, resolves, silent, aiRefs: aiMentions(id)};
	});
}

function auditList(table, label) {
	const base = new Set(table[BASE_GEN]);
	return table[PORT_GEN].filter(n => !base.has(n)).sort().map(name => {
		const id = toId(name);
		return {name, id, label, aiRefs: aiMentions(id), gates: generationGates(id)};
	});
}

function mdTable(header, rows) {
	const head = `| ${header.join(' | ')} |`;
	const rule = `| ${header.map(() => '---').join(' | ')} |`;
	return [head, rule, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

function render() {
	const moves = auditMoves();
	const abilities = auditList(ABILITIES, 'ability');
	const items = auditList(ITEMS, 'item');

	const silent = moves.filter(m => m.silent);
	const unmodelled = moves.filter(m => !m.silent && m.gates.length === 0 && m.aiRefs === 0);

	const out = [];
	out.push('# Gen 9 Port Coverage Audit');
	out.push('');
	out.push('**Generated** — do not hand-edit. Regenerate with:');
	out.push('');
	out.push('```sh');
	out.push('npm run build && node scripts/audit-gen9-coverage.js');
	out.push('```');
	out.push('');
	out.push(`Baseline generation: **${BASE_GEN}** (the fork default). Ported-from`);
	out.push(`generation: **${PORT_GEN}**.`);
	out.push('');
	out.push('## Why this exists');
	out.push('');
	out.push('Run & Bun is a Gen 8-mechanics game with selected Gen 9 elements ported in.');
	out.push('This fork represents that as `state.generation = 8`, which means every Gen 9');
	out.push('element depends on three layers agreeing:');
	out.push('');
	out.push('| Layer | Behavior at generation 8 |');
	out.push('| --- | --- |');
	out.push('| `calc/` gen-indexed data | Gen 9-only entries are **absent** — invisible to the Gen 8 calc |');
	out.push('| `ai/src/move-metadata.ts` | Reads `@pkmn/dex` **without** gen-filtering — resolves them anyway |');
	out.push('| `ai/` effect engine | `generation >= 9` gates make the effect a **silent no-op** |');
	out.push('');
	out.push('The `R&B?` column is intentionally unresolved. Nothing here asserts what');
	out.push('Run & Bun actually ports; that requires the R&B source docs');
	out.push('(`MECHANICS.MD` / `MOVE_CHANGES.MD`), which are cited by `README.md` and');
	out.push('`ai/src/move-metadata.ts` but are **not in this repository**. Fill the column');
	out.push('if a future Run & Bun version ports Gen 9 content, then triage those rows.');
	out.push('');
	out.push('## Why GEN9-02 is Parked');
	out.push('');
	out.push('Current evidence says Run & Bun is a Gen 8 game with no Gen 9 ports, so the');
	out.push('rows below are dormant engine capability rather than active bugs:');
	out.push('');
	out.push(`- **Zero** of the ${moves.length} Gen 9-only moves appear anywhere in the fork's`);
	out.push('  Run & Bun move overlay (`CUSTOM_ACCURACY` / `CUSTOM_BASE_POWER` /');
	out.push('  `CUSTOM_MAX_PP` / `CUSTOM_TYPE` in `ai/src/move-metadata.ts`), which is the');
	out.push('  transcription of the Run & Bun move-change documentation.');
	out.push('- The Run & Bun community calculators carry ability and item data byte-identical');
	out.push(`  to upstream, with no Gen ${PORT_GEN} additions at gen ${BASE_GEN}.`);
	out.push(`- Those calculators default to generation ${BASE_GEN}, same as this fork.`);
	out.push('');
	out.push('This audit is kept as the check that stays honest if that ever changes:');
	out.push('regenerate it against a newer Run & Bun release and the dormant rows become a');
	out.push('work list. Reopen GEN9-02 on evidence, not on suspicion.');
	out.push('');
	out.push('## Summary');
	out.push('');
	out.push(mdTable(['Category', `In gen ${PORT_GEN} but not gen ${BASE_GEN}`, 'Notes'], [
		['Moves', String(moves.length), `${silent.length} resolve at gen ${BASE_GEN} but have gated effects`],
		['Abilities', String(abilities.length), `${abilities.filter(a => a.aiRefs > 0).length} referenced in \`ai/src\``],
		['Items', String(items.length), `${items.filter(i => i.aiRefs > 0).length} referenced in \`ai/src\``],
	]));
	out.push('');
	out.push('## Priority 1 — silent no-ops');
	out.push('');
	out.push(`These moves **resolve** through \`ai/src/move-metadata.ts\` at generation`);
	out.push(`${BASE_GEN} (so they are selectable and deal damage) while their defining`);
	out.push('effect sits behind a `generation >= 9` gate (so it never fires). If Run & Bun');
	out.push('ports any of these, the fork is silently wrong — no error, just bad numbers.');
	out.push('');
	out.push(mdTable(
		['R&B?', 'Move', `BP @gen${BASE_GEN}`, `Acc @gen${BASE_GEN}`, 'Metadata source', 'Gated at'],
		silent.map(m => [
			'?',
			m.name,
			m.meta.basePower === undefined ? '—' : String(m.meta.basePower),
			showAccuracy(m.meta.accuracy),
			m.meta.source,
			m.gates.map(g => `\`${g}\``).join('<br>'),
		])
	));
	out.push('');
	out.push('## Priority 2 — moves with no AI model at all');
	out.push('');
	out.push(`Absent from the gen ${BASE_GEN} calc tables and never mentioned in \`ai/src\`.`);
	out.push('If R&B ports one of these, it needs to be modelled from scratch.');
	out.push('');
	out.push(mdTable(
		['R&B?', 'Move', `Resolves @gen${BASE_GEN}?`, `BP @gen${BASE_GEN}`, 'Metadata source'],
		unmodelled.map(m => [
			'?',
			m.name,
			m.resolves ? 'yes' : 'no',
			m.meta.basePower === undefined ? '—' : String(m.meta.basePower),
			m.meta.source,
		])
	));
	out.push('');
	out.push('## Full move inventory');
	out.push('');
	out.push(mdTable(
		['R&B?', 'Move', `Resolves @gen${BASE_GEN}?`, 'Metadata source', '`ai/src` refs', 'Gen 9 gates'],
		moves.map(m => [
			'?',
			m.name,
			m.resolves ? 'yes' : 'no',
			m.meta.source,
			String(m.aiRefs),
			m.gates.length ? String(m.gates.length) : '—',
		])
	));
	out.push('');
	out.push('## Abilities');
	out.push('');
	out.push(`Present in \`ABILITIES[${PORT_GEN}]\` but not \`ABILITIES[${BASE_GEN}]\`. The`);
	out.push(`\`ai/src\` reference count is a coarse proxy for whether the fork models the`);
	out.push('ability at all — zero means certainly not.');
	out.push('');
	out.push(mdTable(['R&B?', 'Ability', '`ai/src` refs', 'Gen 9 gates'], abilities.map(a => [
		'?', a.name, String(a.aiRefs), a.gates.length ? String(a.gates.length) : '—',
	])));
	out.push('');
	out.push('## Items');
	out.push('');
	out.push(`Present in \`ITEMS[${PORT_GEN}]\` but not \`ITEMS[${BASE_GEN}]\`.`);
	out.push('');
	out.push(mdTable(['R&B?', 'Item', '`ai/src` refs', 'Gen 9 gates'], items.map(i => [
		'?', i.name, String(i.aiRefs), i.gates.length ? String(i.gates.length) : '—',
	])));
	out.push('');
	return out.join('\n');
}

const report = render();

if (process.argv.includes('--stdout')) {
	process.stdout.write(report);
} else {
	const target = path.join(root, 'GEN9_AUDIT.md');
	fs.writeFileSync(target, report);
	process.stdout.write(`Wrote ${path.relative(root, target)}\n`);
}
