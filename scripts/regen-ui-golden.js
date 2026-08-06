/* eslint-env node, es6 */
'use strict';

/**
 * Regenerate a UI golden evaluate snapshot deliberately (FIX-03).
 *
 * Usage:
 *   node scripts/regen-ui-golden.js [fixtureId]
 *   node scripts/regen-ui-golden.js sample
 *
 * Default fixtureId: sample
 */

const fs = require('fs');
const path = require('path');
const ai = require('../ai');
const toSnapshot = require('../fixtures/ui/golden_eval').toSnapshot;

const root = path.resolve(__dirname, '..');
const uiDir = path.join(root, 'fixtures', 'ui');
const manifest = JSON.parse(fs.readFileSync(path.join(uiDir, 'manifest.json'), 'utf8'));
const fixtureId = process.argv[2] || manifest.defaultId || 'sample';
const scenario = (manifest.scenarios || []).find(entry => entry.id === fixtureId);

if (!scenario) {
	console.error('Unknown fixture id:', fixtureId);
	console.error('Known:', (manifest.scenarios || []).map(entry => entry.id).join(', '));
	process.exit(1);
}
if (!scenario.golden) {
	console.error('Scenario', fixtureId, 'has no golden path in manifest.');
	process.exit(1);
}

const state = JSON.parse(fs.readFileSync(path.join(uiDir, scenario.file), 'utf8'));
ai.validateBattleState(state);
const options = scenario.defaultOptions || {sideId: 'ai', includeSwitches: false};
const sideId = options.sideId === 'player' ? 'player' : 'ai';
const evaluations = ai.evaluateActions(state, ai.calculateActionFacts, sideId, {
	includeSwitches: !!options.includeSwitches,
});
const snapshot = toSnapshot(evaluations, {fixtureId: fixtureId, options: options});
const outPath = path.join(uiDir, scenario.golden);
fs.mkdirSync(path.dirname(outPath), {recursive: true});
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
console.log('Wrote', path.relative(root, outPath), '(' + snapshot.evaluations.length + ' actions)');
