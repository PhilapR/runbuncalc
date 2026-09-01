#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * The human-readable boss report: every boss-tier leader's kit tech and its
 * threat structure against the FULL period sample, with a named key box.
 *
 * All machinery lives in lib/dossier.js — one implementation shared with
 * scripts/build-fight-dossiers.js, because two copies of one truth drifting
 * apart by hand was the id-scale audit's costliest finding. The conclusions
 * drawn from this output live in docs/LEADER-KEYS.md.
 *
 *   node scripts/leader-dossier.js                 # every boss leader
 *   node scripts/leader-dossier.js --only=Wattson  # substring filter
 */

const fs = require('node:fs');
const planner = require('../lib/planner');
const dossier = require('../lib/dossier');

const only = (() => {
	const hit = process.argv.find(arg => arg.startsWith('--only='));
	return hit ? hit.split('=').slice(1).join('=') : '';
})();

const fights = planner.loadRunMap('run-and-bun')
	.filter(fight => /^Leader |^Elite Four |^Champion /.test(fight.trainer))
	.filter(fight => !only || fight.trainer.includes(only));

const out = [];
for (const fight of fights) {
	const built = dossier.buildSample(fight.order);
	const entry = dossier.dossierFor(fight, built.cap, built.sample, true);
	out.push(entry);
	console.log('=== ' + entry.trainer + ' (order ' + entry.order + ', cap ' +
		entry.cap + ', sample ' + entry.sampleSize + ' species' +
		(entry.isDouble ? ', DOUBLES' : '') + ') ===');
	for (const line of entry.tech) console.log('  tech  ' + line);
	for (const mon of entry.mons) {
		console.log('  ' + (mon.species + ' L' + mon.level).padEnd(22) +
			'outsped-by ' + String(mon.outspedBySample + '%').padEnd(5) +
			' hit ' + String(mon.meanBestHit + '%').padEnd(5) +
			' ohko ' + String(mon.ohkoRate + '%').padEnd(5) +
			' answered-by ' + String(mon.answerRate + '%').padEnd(5) +
			(mon.topAnswers.length ? ' best: ' + mon.topAnswers.join(', ') : ''));
	}
	console.log('  key box: ' + entry.keyBox.join(', '));
}
fs.writeFileSync('ui-playthrough-out/leader-dossiers.json',
	JSON.stringify(out, null, '\t'));
console.log('\nwrote ui-playthrough-out/leader-dossiers.json');
