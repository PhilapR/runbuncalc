/* eslint-env node, es6 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const contract = path.join(root, 'contracts', 'ecosystem', 'v1');
const provenance = JSON.parse(fs.readFileSync(
	path.join(root, 'vendor', 'pokemon-run-runtime', 'PROVENANCE.json'), 'utf8'));

async function main() {
	const providerModule = await import('@philapr/pokemon-run-runtime');
	const provider = providerModule.createRabRunRuntimeProvider({
		providerRevision: provenance.revision,
		engineVersion: '0.2.0',
	});

	async function refresh(requestName, receiptName, method) {
		const request = JSON.parse(fs.readFileSync(path.join(contract, requestName), 'utf8'));
		const receipt = await provider[method](request);
		fs.writeFileSync(path.join(contract, receiptName), JSON.stringify(receipt, null, 2) + '\n');
		console.log(`Refreshed ${receiptName} from pokemon-mono ${provenance.revision}.`);
	}

	await refresh('planning-request.json', 'seeded-provider-receipt.json', 'plan');
	await refresh('attribution-request.json', 'seeded-provider-attribution-receipt.json', 'attribute');
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
