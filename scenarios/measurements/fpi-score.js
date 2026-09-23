// node fpi-score.js — --plan-items on the frontier singles, scored against planitems-bar.md (written before the run).
const fs = require('fs');
const path = require('path');
const ROOT = '/Users/philip/Projects/runbuncalc-rescue';
const pairing = require(ROOT + '/scripts/battery-pair.js');
const battery = require(ROOT + '/scripts/scenario-battery.js');
const arms = path.join(ROOT, 'ui-playthrough-out', 'arms');
const joined = prefix => {
	const parts = [0, 1, 2].map(i => JSON.parse(fs.readFileSync(path.join(arms, prefix + '-s' + i + '.json'), 'utf8')));
	return Object.assign({}, parts[0], {results: parts.flatMap(part => part.results)});
};
const ctl = joined('fpi-ctl');
const trt = joined('fpi-items');
const rows = pairing.pair(ctl, trt);
const t = pairing.total(rows);
const miss = pairing.unmatched(ctl, trt);
const net = t.gained - t.lost;
console.log('wins ' + t.control + '/' + t.seeds + ' -> ' + t.treatment + '/' + t.seeds + '   gained ' + t.gained +
	', lost ' + t.lost + ', net ' + net + ', McNemar p=' + t.p.toExponential(2));
if (miss.control.length || miss.treatment.length) console.log('UNMATCHED control ' + miss.control.length + ', treatment ' + miss.treatment.length);
const held = trt.results.reduce((sum, row) => sum + ((row.counters || {}).itemsHeld || 0), 0);
console.log('gate: itemsHeld in ' + held + ' of ' + trt.results.length + ' scenarios' + (held ? '' : '  -> INERT, no verdict'));
const perRow = rows.map(row => Object.assign({}, row, {net: row.gained.length - row.lost.length}));
const vetoed = perRow.filter(row => row.net <= -5);
console.log('veto (net <= -5): ' + (vetoed.length ? vetoed.map(row => row.name + ' ' + row.net).join('; ') : 'none'));
const byTrainer = new Map();
for (const row of perRow) {
	const trainer = row.name.replace(/ @\d+ .*$/, '');
	byTrainer.set(trainer, (byTrainer.get(trainer) || 0) + row.net);
}
const largest = [...byTrainer].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
const without = largest ? net - largest[1] : net;
console.log('largest contributor ' + (largest ? largest[0] + ' (' + largest[1] + ')' : '-') + '; net without it ' + without +
	(Math.sign(without) === Math.sign(net) && net !== 0 ? ' (sign holds)' : ' (SIGN DOES NOT HOLD)'));
const pass = held > 0 && net > 0 && t.p < 0.05 && !vetoed.length && Math.sign(without) === Math.sign(net);
console.log('VERDICT: ' + (held ? (pass ? 'PASSES the bar' : 'does not pass the bar') : 'inert'));
console.log('\nreported, not in the verdict:');
const late = perRow.filter(row => Number((row.name.match(/ @(\d+) /) || [])[1]) > 342);
console.log('  late (order > 342): net ' + late.reduce((sum, row) => sum + row.net, 0) + ' over ' + late.length + ' scenarios');
const items = {};
for (const row of trt.results) for (const label of ((row.plan || {}).held || [])) items[label.split('@')[1]] = (items[label.split('@')[1]] || 0) + 1;
console.log('  items taken: ' + JSON.stringify(items));
for (const row of perRow.filter(row => row.net).sort((a, b) => b.net - a.net)) {
	console.log('  ' + (row.net > 0 ? '+' : '') + row.net + '  ' + row.name + '  ' + row.control + '/' + row.seeds + ' -> ' + row.treatment + '/' + row.seeds);
}
void battery;
