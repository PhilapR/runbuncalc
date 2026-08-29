#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * New-strategy probes over the AVAILABLE pool — the approaches nobody has
 * played yet, each built as a battery scenario:
 *
 *  intimidate  six Intimidate carriers vs the all-physical Brawly: the
 *              policy's own lethal-switch rule re-triggers the drop, so
 *              cycling is free — if it works, the mechanism check is the
 *              switch count, not a new decide() rule.
 *  giantkiller Staravia's cap-level Endeavor plus priority finishers and a
 *              Sturdy front. Endeavor's engine price is dynamic — near
 *              zero from full health, enormous once hurt — so the policy
 *              may press it unprompted; the probe measures whether the
 *              threshold weapon that beats US transfers to our side.
 *  developed   the choice team, DEVELOPED: advisor-greedy teaches, scale
 *              spends and item gives against the wall until no row clears
 *              zero, with a bag stocked from the period's dated pickups.
 *              This is the experiment the choice1 memory demands — never
 *              grade composition with synthetic level-up boxes again.
 *
 *   node scripts/strategy-probes.js && \
 *     node scripts/scenario-battery.js --manifest=scenarios/strategies.json --label=strat1
 */

const fs = require('node:fs');
const run = require('../lib/run.js');
const dossier = require('../lib/dossier');
const planner = require('../lib/planner');
const calc = require('../calc');

const gen = calc.Generations.get(8);
const IVS = {hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15};

function mon(id, species, cap, ability) {
	const found = gen.species.get(calc.toID(species));
	return {id, species, nickname: null, level: cap, nature: 'Bashful',
		ability: ability || (found && found.abilities ?
			Object.values(found.abilities)[0] : null),
		item: null, moves: dossier.lastFourMoves(species, cap),
		ivs: Object.assign({}, IVS), status: 'party',
		origin: {kind: 'counterfactual'}};
}

function boxDoc(sourceFile, names, cap, abilities) {
	const doc = structuredClone(JSON.parse(fs.readFileSync(sourceFile, 'utf8')).run);
	doc.box = names.map((species, index) =>
		mon('probe-' + (index + 1), species, cap, (abilities || {})[species]));
	doc.party = doc.box.map(entry => entry.id);
	return doc;
}

/** Advisor-greedy development: apply the top row of any kind until dry. */
function develop(doc, boss, order) {
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	doc.bag = Object.assign({}, doc.bag, {'Heart Scale': 30});
	for (const pickup of oracle.itemsObtainableBy(order)) {
		if (planner.holdableItem(pickup.name)) {
			doc.bag[pickup.name] = (doc.bag[pickup.name] || 0) + 1;
		}
	}
	const STATS = {HP: 'hp', Attack: 'atk', Defense: 'def',
		'Sp. Atk': 'spa', 'Sp. Def': 'spd', Speed: 'spe'};
	const applied = {teach: 0, heartScale: 0, give: 0};
	// One unappliable row must not end development: remember it and move on.
	const refused = new Set();
	for (let round = 0; round < 80; round++) {
		let advice;
		try {
			advice = run.adviseUpgrades(doc, boss);
		} catch (error) { break; }
		const row = advice.upgrades.find(entry =>
			['teach', 'heartScale', 'give'].includes(entry.kind) &&
			!refused.has(entry.kind + '|' + entry.id + '|' + entry.detail) &&
			(entry.delta.koGained - entry.delta.koConceded > 0 || entry.delta.damage > 0));
		if (!row) break;
		refused.add(row.kind + '|' + row.id + '|' + row.detail);
		try {
			if (row.kind === 'teach') {
				// detail reads "Water Spout over Bubble Beam (one Heart Scale)".
				const pair = /^(.+?) over (.+?)(?: \(|$)/.exec(row.detail || '');
				if (!pair) break;
				doc = run.apply(doc, {kind: 'teach', id: row.id,
					move: pair[1].trim(), replace: pair[2].trim()});
			} else if (row.kind === 'heartScale') {
				const stat = /^(HP|Attack|Defense|Sp\. Atk|Sp\. Def|Speed) IV/.exec(row.detail);
				doc = run.apply(doc, {kind: 'heartScale', id: row.id, stat: STATS[stat[1]]});
			} else {
				doc = run.apply(doc, {kind: 'give', id: row.id, item: row.item ||
					(/give (.+?)( to|$)/.exec(row.detail) || [])[1]});
			}
			applied[row.kind] += 1;
		} catch (error) { /* refused rows stay in the set and the loop moves on */ }
	}
	return {doc, applied};
}

function main() {
	const fights = planner.loadRunMap('run-and-bun');
	const manifest = [];
	const CAPS = {'Leader Brawly': 21, 'Leader Roxanne': 25, 'Leader Wattson': 35};

	// S1: Intimidate cycle vs the all-physical wall.
	const intimidate = boxDoc('ui-playthrough-out/counterfactual-brawly-baseline.json',
		['Herdier', 'Staravia', 'Mightyena', 'Luxio', 'Growlithe', 'Qwilfish'], 21,
		{Herdier: 'Intimidate', Staravia: 'Intimidate', Mightyena: 'Intimidate',
			Luxio: 'Intimidate', Growlithe: 'Intimidate', Qwilfish: 'Intimidate'});
	fs.writeFileSync('ui-playthrough-out/strat-intimidate.json',
		JSON.stringify({run: intimidate}, null, '\t'));
	manifest.push({name: 'Leader Brawly · intimidate-cycle',
		report: 'ui-playthrough-out/strat-intimidate.json',
		trainer: 'Leader Brawly', seeds: 30});

	// S2: the giant-killer line, per wall.
	const KILLERS = {
		'Leader Brawly': ['Staravia', 'Dwebble', 'Hitmonchan', 'Buizel', 'Growlithe', 'Kadabra'],
		'Leader Roxanne': ['Staravia', 'Donphan', 'Hitmonchan', 'Hariyama', 'Buizel', 'Kadabra'],
		'Leader Wattson': ['Staraptor', 'Donphan', 'Crustle', 'Bewear', 'Floatzel', 'Kadabra'],
	};
	for (const [boss, team] of Object.entries(KILLERS)) {
		const gym = boss.split(' ')[1].toLowerCase();
		const doc = boxDoc('ui-playthrough-out/counterfactual-' + gym + '-baseline.json',
			team, CAPS[boss], {Dwebble: 'Sturdy', Donphan: 'Sturdy', Crustle: 'Sturdy'});
		const out = 'ui-playthrough-out/strat-giantkiller-' + gym + '.json';
		fs.writeFileSync(out, JSON.stringify({run: doc}, null, '\t'));
		manifest.push({name: boss + ' · giant-killer', report: out,
			trainer: boss, seeds: 30});
	}

	// S3: the developed choice team, per wall.
	const choiceTeams = {
		'Leader Brawly': ['Hitmonchan', 'Vespiquen', 'Gligar', 'Salandit', 'Kadabra', 'Herdier'],
		'Leader Roxanne': ['Hariyama', 'Hitmonchan', 'Palpitoad', 'Sneasel', 'Sandshrew-Alola', 'Octillery'],
		'Leader Wattson': ['Excadrill', 'Bewear', 'Rhydon', 'Krookodile', 'Mudsdale', 'Piloswine'],
	};
	for (const [boss, team] of Object.entries(choiceTeams)) {
		const gym = boss.split(' ')[1].toLowerCase();
		const fight = fights.find(entry => entry.trainer === boss);
		let doc = boxDoc('ui-playthrough-out/counterfactual-' + gym + '-baseline.json',
			team, CAPS[boss]);
		const grown = develop(doc, boss, fight.order);
		console.log(boss + ' developed:', JSON.stringify(grown.applied));
		const out = 'ui-playthrough-out/strat-developed-' + gym + '.json';
		fs.writeFileSync(out, JSON.stringify({run: grown.doc}, null, '\t'));
		manifest.push({name: boss + ' · developed-choice', report: out,
			trainer: boss, seeds: 30});
	}

	// Stone evolutions: all eight basic stones open at order 209, twenty
	// fights before Wattson. No stone form enters his ANSWER lists (his
	// answers are level-evolving Ground bodies), but stone forms are raw
	// quality — and the developed stone box measured 16/30, the best wall
	// result ever recorded, beating the real deep-run box at max IVs. The
	// full chain is catch the pre-evolution, learn its moves, stone late,
	// then develop against the wall.
	const STONE_PRE = {Arcanine: 'Growlithe', Starmie: 'Staryu', Ludicolo: 'Lombre',
		Kingdra: 'Seadra', Weavile: 'Sneasel', Gliscor: 'Gligar'};
	let stoneDoc = boxDoc('ui-playthrough-out/counterfactual-wattson-baseline.json',
		Object.keys(STONE_PRE), 35);
	for (const entry of stoneDoc.box) {
		entry.moves = dossier.lastFourMoves(STONE_PRE[entry.species], 35);
	}
	fs.writeFileSync('ui-playthrough-out/strat-stones-wattson.json',
		JSON.stringify({run: stoneDoc}, null, '	'));
	manifest.push({name: 'Leader Wattson · stone-box',
		report: 'ui-playthrough-out/strat-stones-wattson.json',
		trainer: 'Leader Wattson', seeds: 30});
	const stoned = develop(structuredClone(stoneDoc), 'Leader Wattson',
		fights.find(entry => entry.trainer === 'Leader Wattson').order);
	console.log('Leader Wattson stone-developed:', JSON.stringify(stoned.applied));
	fs.writeFileSync('ui-playthrough-out/strat-stones-dev-wattson.json',
		JSON.stringify({run: stoned.doc}, null, '	'));
	manifest.push({name: 'Leader Wattson · stone-box-developed',
		report: 'ui-playthrough-out/strat-stones-dev-wattson.json',
		trainer: 'Leader Wattson', seeds: 30});

	fs.writeFileSync('scenarios/strategies.json', JSON.stringify({
		comment: 'New-strategy probes: intimidate cycling, the giant-killer ' +
			'Endeavor line, and the developed-choice ceiling. From ' +
			'scripts/strategy-probes.js.',
		scenarios: manifest,
	}, null, '\t') + '\n');
	console.log('wrote scenarios/strategies.json (' + manifest.length + ' probes)');
}

main();
