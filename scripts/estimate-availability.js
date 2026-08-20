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
 */

const path = require('path');

const root = path.join(__dirname, '..');
const availability = require(path.join(root, 'profiles/run-and-bun/oracle/availability.json'));
const profiles = require(path.join(root, 'profiles'));

const profile = profiles.getProfile('run-and-bun');
const maps = profile.oracle.maps();
const dateOf = new Map(availability.entries.map(entry => [entry.map, entry.opensAt]));

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

function main() {
	const asJson = process.argv.includes('--json');
	const validation = crossValidate();
	const undated = maps.filter(map => !dateOf.has(map.map));

	const estimates = undated.map(map => {
		const levels = walkLevels(map);
		const fromLevel = predictFromLevel(levels, trainingRows);
		const fromRoute = predictFromRouteNumber(map.name);
		return {
			map: map.map,
			name: map.name,
			hasWalkTable: !!levels,
			maxLevel: levels ? levels.max : null,
			fromLevel,
			fromRoute,
			// A route number is direct geographic evidence and outranks a
			// level lookalike; level is the fallback; neither means no answer.
			estimate: fromRoute !== null ? fromRoute : fromLevel,
			basis: fromRoute !== null ? 'route-number' : (fromLevel !== null ? 'wild-level' : 'none'),
			spread: neighbourSpread(levels, trainingRows),
		};
	});

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

module.exports = {crossValidate, predictFromLevel, predictFromRouteNumber, walkLevels, neighbourSpread};
