/* eslint-env node, es6 */
'use strict';

/**
 * Estimate an unlock order for the locations availability.json cannot date.
 *
 * availability.json anchors a location to its FIRST TRAINER, so anywhere
 * without one — Oldale Town, the Safari Zone, Fiery Path, Sky Pillar — has no
 * date, and d2a77a9 reports those as unknown rather than dropping them. This
 * script asks whether the gap can be CLOSED from evidence already in the repo,
 * using two signals Philip proposed:
 *
 *   1. Wild level. A location whose walk table tops out at L7 is early; one
 *      that tops out at L90 is late. Measured on the 83 dated locations,
 *      max and median level rank-correlate with unlock order at 0.87.
 *      (Minimum level does NOT — 0.57 — because Kaizo-style tables put a
 *      low slot almost everywhere. Using it would have looked reasonable
 *      and been wrong.)
 *
 *   2. Route number. Route 116 sits between Route 115 and Route 117 in the
 *      journey as well as the name, so an undated RouteNNN can be
 *      interpolated from its dated numeric neighbours. This does NOT extend
 *      to named places: nothing in the repo says where Fiery Path is.
 *
 * NOTHING here is written to availability.json. The script reports estimates
 * WITH their measured error so the decision to adopt them stays a human one,
 * and any adoption must carry provenance 'derived', never 'transcribed'.
 *
 *   node scripts/estimate-availability.js            # cross-validate, then estimate
 *   node scripts/estimate-availability.js --json     # machine-readable
 *   node scripts/estimate-availability.js --timeline # dated and undated, in run order,
 *                                                    # anchored to the boss fights
 */

const path = require('path');

const root = path.join(__dirname, '..');
const availability = require(path.join(root, 'profiles/run-and-bun/oracle/availability.json'));
const profiles = require(path.join(root, 'profiles'));

const profile = profiles.getProfile('run-and-bun');
const maps = profile.oracle.maps();
/**
 * Ground truth is the TRANSCRIBED entries only.
 *
 * Once scripts/adopt-availability.js writes derived dates back into this
 * file, including them here would mean validating the estimator against its
 * own output — the cross-validation would score itself and report
 * beautifully. An entry with a provenance field was placed by this script;
 * it can never be evidence for it.
 */
const dateOf = new Map(availability.entries
	.filter(entry => !entry.provenance && entry.opensAt !== null && entry.opensAt !== undefined)
	.map(entry => [entry.map, entry.opensAt]));

/** Walk-table level summary, or null when a location has no walk table. */
function walkLevels(map) {
	const walk = (map.tables || []).find(table => table.method === 'walk');
	if (!walk || !walk.mons.length) return null;
	const levels = walk.mons.flatMap(mon => [mon.minLevel, mon.maxLevel]).sort((a, b) => a - b);
	return {
		max: levels[levels.length - 1],
		median: levels[Math.floor(levels.length / 2)],
	};
}

function routeNumber(name) {
	const match = /^Route(\d+)$/.exec(name);
	return match ? Number(match[1]) : null;
}

/**
 * Predict an order from wild level, by nearest neighbours in level space
 * among the dated locations. A local median rather than a fitted line: the
 * relationship is monotone but not linear, and a line would extrapolate
 * confidently past the ends of the data.
 */
function predictFromLevel(target, trainingRows, k = 5) {
	if (!target) return null;
	const scored = trainingRows
		.map(row => ({
			order: row.order,
			distance: Math.abs(row.levels.max - target.max) +
				Math.abs(row.levels.median - target.median),
		}))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, k);
	if (!scored.length) return null;
	const orders = scored.map(row => row.order).sort((a, b) => a - b);
	return orders[Math.floor(orders.length / 2)];
}

/**
 * How much the neighbours DISAGREE. The aggregate error hides the thing that
 * matters: the method is excellent typically (median 6 orders) and off by a
 * thousand roughly one time in eight. Those failures are not random — they
 * are locations whose neighbours in level space disagree wildly about when
 * they open, and that disagreement is visible BEFORE the answer is used.
 * Reporting a spread per row turns an unusable average into a per-location
 * decision.
 */
function neighbourSpread(target, trainingRows, k = 5) {
	if (!target) return null;
	const scored = trainingRows
		.map(row => ({
			order: row.order,
			distance: Math.abs(row.levels.max - target.max) +
				Math.abs(row.levels.median - target.median),
		}))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, k)
		.map(row => row.order)
		.sort((a, b) => a - b);
	return scored.length ? scored[scored.length - 1] - scored[0] : null;
}

const tracker = require(path.join(root, 'profiles/run-and-bun/oracle/tracker-order.json'));

function normalizeName(name) {
	return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tracker position for each oracle location, via the sheet's own grouped
 * names ("Sky Pillar 1F and 3F" covers two of ours) and a normalised match
 * for the rest.
 */
const trackerPosition = new Map();
tracker.order.forEach((name, position) => {
	const members = tracker.groups[name] || [name];
	for (const member of members) trackerPosition.set(normalizeName(member), position);
});

/**
 * Predict an order from the TRACKER's progression order — the strongest
 * signal available, and the one Philip pointed at.
 *
 * The tracker lists the map in the order a player walks it, including every
 * trainerless place availability.json cannot see. It carries no fight orders
 * of its own, so a position only means something once it is interpolated
 * against the dated locations either side of it.
 *
 * Rank-correlation against the 64 dated locations it covers is 0.85 — very
 * slightly BELOW the wild-level signal's 0.87, not above it. (An exact-name
 * subset shows 0.96, but that subset excludes Meteor Falls, which is exactly
 * where the two orderings disagree, so quoting it would be quoting the
 * flattering half of the measurement.)
 *
 * It still outranks level, for reasons the correlation does not show:
 *   - it COVERS places no other signal reaches. Littleroot, Mossdeep,
 *     Pacifidlog and the Underwater routes have no walk table at all.
 *   - it separates what level collapses. All four Mirage Tower floors
 *     landed on one number under the level signal; the tracker orders them.
 *   - it is a STATED order rather than an inference from a proxy, so a human
 *     can check it against the game.
 */
function predictFromTracker(name, excludeName) {
	const position = trackerPosition.get(normalizeName(name));
	if (position === undefined) return null;
	const anchors = [];
	for (const map of maps) {
		if (!dateOf.has(map.map) || map.name === excludeName) continue;
		const at = trackerPosition.get(normalizeName(map.name));
		if (at !== undefined) anchors.push({at, order: dateOf.get(map.map)});
	}
	if (!anchors.length) return null;
	// A LOCAL MEDIAN of the nearest anchors in tracker space, not a straight
	// line between the two immediate neighbours. The first version did the
	// latter and scored WORSE than the weaker level signal — median 9 against
	// 6 — because the two orderings, correlated at 0.967, are not perfectly
	// monotone with each other. One local inversion sends a linear
	// interpolation a thousand orders wrong: Route 112 predicted 1526 against
	// an actual 496. A median over a small window absorbs the inversion
	// instead of amplifying it.
	const near = anchors
		.map(row => ({order: row.order, distance: Math.abs(row.at - position)}))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, 5)
		.map(row => row.order)
		.sort((a, b) => a - b);
	return near[Math.floor(near.length / 2)];
}

/** Interpolate a numbered route from its dated numeric neighbours. */
function predictFromRouteNumber(name) {
	const number = routeNumber(name);
	if (number === null) return null;
	const dated = maps
		.filter(map => dateOf.has(map.map) && routeNumber(map.name) !== null)
		.map(map => ({number: routeNumber(map.name), order: dateOf.get(map.map)}))
		.sort((a, b) => a.number - b.number);
	const before = dated.filter(row => row.number < number).pop();
	const after = dated.find(row => row.number > number);
	if (!before || !after) return null;
	// Routes are not guaranteed monotone in the hack's order; only interpolate
	// when the two neighbours actually bracket, otherwise say nothing.
	if (after.order <= before.order) return null;
	const span = after.number - before.number;
	const fraction = (number - before.number) / span;
	return Math.round(before.order + fraction * (after.order - before.order));
}

const trainingRows = maps
	.filter(map => dateOf.has(map.map))
	.map(map => ({name: map.name, order: dateOf.get(map.map), levels: walkLevels(map)}))
	.filter(row => row.levels);

/** Leave-one-out: predict each dated location from the others, measure error. */
function crossValidate() {
	const errors = [];
	for (const row of trainingRows) {
		const others = trainingRows.filter(other => other.name !== row.name);
		const predicted = predictFromLevel(row.levels, others);
		if (predicted === null) continue;
		errors.push({name: row.name, actual: row.order, predicted, error: Math.abs(predicted - row.order)});
	}
	errors.sort((a, b) => a.error - b.error);
	const median = errors[Math.floor(errors.length / 2)].error;
	const within = threshold => errors.filter(row => row.error <= threshold).length / errors.length;
	return {errors, median, within, n: errors.length};
}

/**
 * The whole map in run order, anchored to the fights a player recognises.
 * Raw order numbers mean nothing to a human; "between Roxanne and Wattson"
 * means everything, and placing an undated location is a judgement only
 * someone who has played the hack can make.
 */
function timeline(estimates) {
	const run = require(path.join(root, 'lib/run.js'));
	const milestones = run.milestones(
		run.createRun({name: 'timeline', now: 't0', permadeath: true}))
		.filter(stone => stone.tier === 'boss')
		.sort((a, b) => a.order - b.order);

	const placed = [];
	for (const map of maps) {
		if (dateOf.has(map.map)) {
			placed.push({name: map.name, order: dateOf.get(map.map), known: true});
		}
	}
	for (const row of estimates) {
		if (row.estimate === null || row.estimate === undefined) continue;
		let confidence = 'SCATTERED';
		if (row.basis === 'tracker') confidence = 'tracker order';
		else if (row.basis === 'route-number') confidence = 'route number';
		else if (row.spread === null) confidence = 'no signal';
		else if (row.spread <= 100) confidence = 'level: tight';
		else if (row.spread <= 400) confidence = 'level: loose';
		else confidence = 'level: scattered';
		placed.push({name: row.name, order: row.estimate, known: false, confidence});
	}
	placed.sort((a, b) => a.order - b.order || (a.known ? -1 : 1));

	// Locations with nothing to go on at all still have to be shown, or the
	// person placing them will not know they exist.
	const homeless = estimates.filter(row => row.estimate === null || row.estimate === undefined);

	let index = 0;
	for (const stone of [...milestones, {trainer: '(end of the run)', order: Infinity}]) {
		const before = [];
		while (index < placed.length && placed[index].order < stone.order) {
			before.push(placed[index]);
			index += 1;
		}
		for (const row of before) {
			const order = String(row.order).padStart(4);
			console.log(row.known ?
				`      ${order}  ${row.name}` :
				`  ??  ${order}  ${row.name.padEnd(34)} <- GUESS (${row.confidence})`);
		}
		if (stone.order !== Infinity) {
			console.log(`--- ${String(stone.order).padStart(4)}  ${stone.trainer} ` +
				'-'.repeat(Math.max(0, 46 - stone.trainer.length)));
		}
	}
	if (homeless.length) {
		console.log('');
		console.log('NO SIGNAL AT ALL (no walk table, so no level to read):');
		homeless.forEach(row => console.log(`      ????  ${row.name}`));
	}
}

/** Leave-one-out for the tracker signal, on every dated location it covers. */
function crossValidateTracker() {
	const errors = [];
	for (const map of maps) {
		if (!dateOf.has(map.map)) continue;
		if (trackerPosition.get(normalizeName(map.name)) === undefined) continue;
		const predicted = predictFromTracker(map.name, map.name);
		if (predicted === null) continue;
		errors.push({
			name: map.name, actual: dateOf.get(map.map), predicted,
			error: Math.abs(predicted - dateOf.get(map.map)),
		});
	}
	errors.sort((a, b) => a.error - b.error);
	const within = threshold => errors.filter(row => row.error <= threshold).length / errors.length;
	return {errors, median: errors[Math.floor(errors.length / 2)].error, within, n: errors.length};
}

/** First non-null, in order of how much the evidence is worth. */
function pick(candidates) {
	for (const value of candidates) if (value !== null && value !== undefined) return value;
	return null;
}

/**
 * Every real fight order, so an estimate can be snapped to one.
 *
 * `order` counts the enemy Pokemon faced before a fight, so only the values
 * a fight actually starts on are reachable — 362 of the 1626. Interpolating
 * between two of them can land on a number the run can never be in:
 * predictFromRouteNumber produced 17 for Route 105, where the fights either
 * side sit at 16 and 19. An opensAt of 17 is not early or late, it is not a
 * state.
 *
 * Snapping goes UP, to the next fight at or after the estimate. That follows
 * availability.json's own rule — "late-biased, never early" — and it is the
 * safe direction here: too late merely hides a catch you could have made,
 * too early sends you somewhere you cannot reach yet.
 */
let fightOrdersCache;
function fightOrders() {
	if (!fightOrdersCache) {
		const run = require(path.join(root, 'lib/run.js'));
		const blank = run.createRun({name: 'estimate', now: 't0', permadeath: true});
		const upcoming = run.upcoming(blank, 4000);
		const fights = Array.isArray(upcoming) ? upcoming : upcoming.fights || [];
		fightOrdersCache = fights.map(fight => fight.order).sort((a, b) => a - b);
	}
	return fightOrdersCache;
}

function snapToFight(order) {
	if (order === null || order === undefined) return null;
	const orders = fightOrders();
	const at = orders.find(value => value >= order);
	return at === undefined ? orders[orders.length - 1] : at;
}

function main() {
	const asJson = process.argv.includes('--json');
	const validation = crossValidate();
	const undated = maps.filter(map => !dateOf.has(map.map));

	const estimates = undated.map(map => {
		const levels = walkLevels(map);
		const fromLevel = predictFromLevel(levels, trainingRows);
		const fromRoute = predictFromRouteNumber(map.name);
		const fromTracker = predictFromTracker(map.name);
		return {
			map: map.map,
			name: map.name,
			hasWalkTable: !!levels,
			maxLevel: levels ? levels.max : null,
			fromLevel,
			fromRoute,
			fromTracker,
			// The tracker states where a location sits in the playthrough, so
			// it outranks both inferences. A route number is next — direct
			// geographic evidence. Wild level is the last resort.
			estimate: snapToFight(pick([fromTracker, fromRoute, fromLevel])),
			basis: fromTracker !== null ? 'tracker' :
				fromRoute !== null ? 'route-number' :
					fromLevel !== null ? 'wild-level' : 'none',
			spread: neighbourSpread(levels, trainingRows),
		};
	});

	if (process.argv.includes('--timeline')) {
		timeline(estimates);
		return;
	}
	if (asJson) {
		console.log(JSON.stringify({validation: {
			n: validation.n, medianError: validation.median,
			within100: validation.within(100), within200: validation.within(200),
		}, estimates}, null, 2));
		return;
	}

	console.log('CROSS-VALIDATION of the wild-level signal');
	console.log(`  leave-one-out over ${validation.n} dated locations with a walk table`);
	console.log(`  median absolute error: ${validation.median} orders`);
	console.log(`  within 100 orders: ${(validation.within(100) * 100).toFixed(0)}%`);
	console.log(`  within 200 orders: ${(validation.within(200) * 100).toFixed(0)}%`);
	console.log(`  worst: ${validation.errors.slice(-3).map(row =>
		`${row.name} predicted ${row.predicted}, actually ${row.actual}`).join('; ')}`);
	console.log('');
	console.log('ESTIMATES for the undated');
	for (const row of estimates.sort((a, b) => (a.estimate ?? 1e9) - (b.estimate ?? 1e9))) {
		let confidence = 'SCATTERED';
		if (row.spread === null) confidence = '?';
		else if (row.spread <= 100) confidence = 'TIGHT';
		else if (row.spread <= 400) confidence = 'loose';
		console.log(`  ${String(row.estimate ?? '—').padStart(5)}  ${row.name.padEnd(32)} ` +
			`${row.basis.padEnd(13)} ${(row.maxLevel !== null ? 'maxL' + row.maxLevel : 'no walk').padEnd(8)} ` +
			`${confidence}${row.spread !== null ? ' (neighbours span ' + row.spread + ')' : ''}`);
	}
}

if (require.main === module) main();

module.exports = {crossValidate, crossValidateTracker, predictFromLevel, predictFromTracker, predictFromRouteNumber, walkLevels, neighbourSpread, timeline, trackerPosition, normalizeName, snapToFight, fightOrders};
