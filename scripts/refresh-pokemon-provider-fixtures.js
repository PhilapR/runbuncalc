/* eslint-env node, es6 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const contract = path.join(root, 'contracts', 'ecosystem', 'v1');
const provenance = JSON.parse(fs.readFileSync(
	path.join(root, 'vendor', 'pokemon-run-runtime', 'PROVENANCE.json'), 'utf8'));

/**
 * The era shelf and the valve. Refreshing a seeded receipt in place made
 * silent drift cost zero honest lines: the corpus's whole point (old
 * receipts stay replayable against new engines) died in the overwrite.
 * Now every refresh that CHANGES a receipt (1) copies the outgoing receipt
 * to fixtures/receipt-eras/<name>.<provider-rev8>.json — eras are append-
 * only and never overwritten — and (2) refuses to proceed unless
 * --expect-divergence names why, which lands in the era manifest beside
 * the copy. A byte-identical refresh stays free.
 */
const eras = path.join(root, 'fixtures', 'receipt-eras');
const MANIFEST = path.join(eras, 'MANIFEST.json');

function expectDivergenceReason() {
	const flag = process.argv.indexOf('--expect-divergence');
	return flag !== -1 ? process.argv[flag + 1] : null;
}

function shelve(receiptName, oldText, reason) {
	fs.mkdirSync(eras, {recursive: true});
	const era = receiptName.replace(/\.json$/, '') + '.' + provenance.revision.slice(0, 8) + '.json';
	const target = path.join(eras, era);
	if (fs.existsSync(target)) {
		throw new Error('era shelf already holds ' + era + ' — eras are append-only; ' +
			'a second divergence within one provider pin needs a manual era name');
	}
	fs.writeFileSync(target, oldText);
	const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {eras: []};
	manifest.eras.push({file: era, providerRevision: provenance.revision,
		reason, shelvedBy: 'refresh-pokemon-provider-fixtures'});
	fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, '\t') + '\n');
	console.log('Shelved the outgoing receipt as fixtures/receipt-eras/' + era);
}

async function main() {
	const providerModule = await import('@philapr/pokemon-run-runtime');
	const provider = providerModule.createRabRunRuntimeProvider({
		providerRevision: provenance.revision,
		engineVersion: '0.2.0',
	});

	async function refresh(requestName, receiptName, method) {
		const request = JSON.parse(fs.readFileSync(path.join(contract, requestName), 'utf8'));
		const receipt = await provider[method](request);
		const nextText = JSON.stringify(receipt, null, 2) + '\n';
		const target = path.join(contract, receiptName);
		const oldText = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
		if (oldText === nextText) {
			console.log(`${receiptName} is unchanged.`);
			return;
		}
		if (oldText !== null) {
			const reason = expectDivergenceReason();
			if (!reason) {
				throw new Error(`${receiptName} would CHANGE. A receipt refresh that ` +
					'diverges is an engine-behavior claim: rerun with ' +
					'--expect-divergence "<why the receipts legitimately changed>" ' +
					'to shelve the outgoing era and proceed.');
			}
			shelve(receiptName, oldText, reason);
		}
		fs.writeFileSync(target, nextText);
		console.log(`Refreshed ${receiptName} from pokemon-mono ${provenance.revision}.`);
	}

	await refresh('planning-request.json', 'seeded-provider-receipt.json', 'plan');
	await refresh('attribution-request.json', 'seeded-provider-attribution-receipt.json', 'attribute');
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
