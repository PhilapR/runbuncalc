/**
 * insight reads run records; these hold what it must never get wrong.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Effect, Either} from 'effect';
import {decodeRun, type Turn} from '../src/schema.js';
import {tagsOf} from '../src/tags.js';
import {walls} from '../src/analyse.js';
import {renderPage} from '../src/viewer.js';

const turn = (over: Partial<Turn>): Turn => ({turn: 1, us: 'Bewear L65', usHp: 100, foe: 'Mienshao L65',
	foeHp: 100, chose: 'Superpower', events: [], ...over});

test('a turn is read for the control it took, not only its damage', () => {
	assert.deepEqual([...tagsOf(turn({chose: 'Tailwind'}))], ['speed-control']);
	assert.ok(tagsOf(turn({chose: 'Swords Dance'})).includes('set-up'));
	assert.ok(tagsOf(turn({chose: 'Accelerock'})).includes('priority'));
	// A forced replacement is not a pivot; a voluntary switch is.
	assert.deepEqual([...tagsOf(turn({chose: 'switch to Luxray', why: 'forced replacement'}))], ['forced']);
	assert.ok(tagsOf(turn({chose: 'switch to Luxray', why: 'search-8'})).includes('pivot'));
	// The Shelly line: a 28% Luxray sent in to die so Lycanroc enters clean.
	const sack = tagsOf(turn({chose: 'switch to Luxray', why: 'search-8', foe: 'Dragonite L64',
		events: ['Luxray was sent out.', 'Foe Dragonite used Fire Punch. (16% to Luxray)', 'Luxray fainted!']}));
	assert.ok(sack.includes('sack') && sack.includes('we-fall'), sack.join(','));
	const ko = tagsOf(turn({events: ['Bewear used Superpower. (100% to Mienshao)', 'Mienshao fainted!']}));
	assert.ok(ko.includes('we-ko') && !ko.includes('we-fall'));
	assert.ok(tagsOf(turn({events: ['Foe Mienshao used Close Combat. A critical hit! (95% to Bewear)']})).includes('crit-theirs'));
	assert.ok(tagsOf(turn({events: ['Foe Porygon2 used Recover.']})).includes('foe-recovered'));
});

test('the search playing something other than the biggest number is marked', () => {
	const options = {moves: [{move: 'Air Cutter', damage: '83%+ up to 100%'}, {move: 'Stun Spore', damage: null}],
		switches: [], bench: []};
	assert.ok(tagsOf(turn({chose: 'Stun Spore', why: 'search-4', options})).includes('search-overrode'));
	assert.ok(!tagsOf(turn({chose: 'Air Cutter', why: 'search-4', options})).includes('search-overrode'));
	assert.ok(!tagsOf(turn({chose: 'Stun Spore', why: 'highest floor', options})).includes('search-overrode'),
		'only a searched turn can override');
});

test('a record that has drifted is refused with the field that moved', async () => {
	const bad = {seed: 1, position: 3, fights: 1, ledger: [{n: 1, order: 2, trainer: 'Leader Brawly', seed: '7', result: 'win'}]};
	const outcome = await Effect.runPromise(Effect.either(decodeRun(bad)));
	assert.ok(Either.isLeft(outcome), 'a string seed is not a run record');
	assert.match(String(outcome.left), /seed/);
	const good = await Effect.runPromise(decodeRun({...bad, ledger: [{...bad.ledger[0], seed: 7, extra: 'fields are fine'}]}));
	assert.equal(good.ledger[0]?.trainer, 'Leader Brawly');
});

test('a race with no damaging answer decodes: turnsToKill and turnsToDie may be null', async () => {
	const {decodeFightLine} = await import('../src/schema.js');
	// Unknown, as off disk: the decoder is what is on trial here, not the compiler.
	const line: unknown = {n: 1, trainer: 'Leader Brawly', log: [{...turn({}), options: {moves: [], bench: [], switches: [
		{label: 'Shedinja', race: 'cannot win', raceDetail: {turnsToKill: null, turnsToDie: 3, faster: true}},
		{label: 'Chansey', race: 'stall', raceDetail: {turnsToKill: 9, turnsToDie: null, faster: false}}]}}]};
	const decoded = await Effect.runPromise(Effect.either(decodeFightLine(line)));
	assert.ok(Either.isRight(decoded), 'clear1/run-104770 held 133 of these and did not decode');
});

test('a wall sets its win beside its losses', async () => {
	const log = (chose: string): Turn[] => [turn({chose, why: 'search-8'})];
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 90, fights: 3, ledger: [
		{n: 1, order: 80, trainer: 'Leader Brawly', seed: 5, result: 'loss', foeLeft: 2, log: log('Superpower')},
		{n: 2, order: 80, trainer: 'Leader Brawly', seed: 6, result: 'loss', foeLeft: 3, log: log('Superpower')},
		{n: 3, order: 80, trainer: 'Leader Brawly', seed: 7, result: 'win', foeLeft: 0, log: log('Tailwind')},
	]}));
	const [wall] = walls(run);
	assert.ok(wall !== undefined);
	assert.equal(wall.wonOn, 3);
	assert.equal(wall.attempts, 3);
	assert.deepEqual(wall.tagLift.find(entry => entry.tag === 'speed-control'), {tag: 'speed-control', win: 1, lossMean: 0});
	const page = renderPage(run, 'a <title>');
	assert.match(page, /<title>Fight Log<\/title>/);
	assert.doesNotMatch(page, /a <title>/, 'text from a record never reaches the page as markup');
	assert.ok(!page.includes('</script><script>alert'), 'and embedded JSON cannot close its own script tag');
});

test('the agent face shows the signature it enforces', async () => {
	const {handle} = await import('../src/mcp.js');
	const listed = await Effect.runPromise(handle({id: 1, method: 'tools/list'})) as
		{result: {tools: Array<{name: string; inputSchema: {required?: string[]; properties: Record<string, unknown>}}>}};
	assert.deepEqual(listed.result.tools.map(entry => entry.name), ['run_strategy', 'list_walls', 'compare_attempts', 'wall_view', 'get_attempt', 'get_turns',
		'list_live_runs', 'control_run']);
	const turns = listed.result.tools.find(entry => entry.name === 'get_turns');
	assert.deepEqual(turns?.inputSchema.required, ['report', 'n'], 'the schema an agent is shown names what is required');

	const call = async (name: string, args: unknown): Promise<{isError?: boolean; content: Array<{text: string}>}> =>
		(await Effect.runPromise(handle({id: 2, method: 'tools/call', params: {name, arguments: args}})) as
			{result: {isError?: boolean; content: Array<{text: string}>}}).result;
	const bad = await call('get_turns', {report: 'x.json', n: 'seven'});
	assert.equal(bad.isError, true);
	assert.match(bad.content[0]?.text ?? '', /\["n"\][\s\S]*Expected number, actual "seven"/, 'and the same schema refuses, naming the field');
	const missing = await call('list_walls', {report: '/nonexistent/run.json'});
	assert.equal(missing.isError, true, 'a missing file is an answer, not a crash');
	assert.match(missing.content[0]?.text ?? '', /cannot read/);
	assert.equal((await call('no_such_tool', {})).isError, true);
});

test('a run\'s streamed fights are put back on its attempts, torn sidecar or not', async () => {
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const pathOf = await import('node:path');
	const zlib = await import('node:zlib');
	const {loadRunWithFights, sidecarOf} = await import('../src/cli.js');
	const dir = await fs.mkdtemp(pathOf.join(os.tmpdir(), 'insight-'));
	const report = pathOf.join(dir, 'run.json');
	await fs.writeFile(report, JSON.stringify({seed: 1, position: 90, fights: 2, ledger: [
		{n: 1, order: 80, trainer: 'Leader Brawly', seed: 5, result: 'loss', logLine: 0},
		{n: 2, order: 80, trainer: 'Leader Brawly', seed: 6, result: 'win', logLine: 1}]}));
	const member = (value: unknown): Buffer => zlib.gzipSync(JSON.stringify(value) + '\n');
	const first = member({n: 1, trainer: 'Leader Brawly', log: [turn({chose: 'Superpower'})]});
	const second = member({n: 2, trainer: 'Leader Brawly', log: [turn({chose: 'Tailwind'})]});
	assert.equal(sidecarOf(report), pathOf.join(dir, 'run.fights.ndjson.gz'));

	await fs.writeFile(sidecarOf(report), Buffer.concat([first, second]));
	const whole = await Effect.runPromise(loadRunWithFights(report));
	assert.deepEqual(whole.ledger.map(attempt => attempt.log?.[0]?.chose), ['Superpower', 'Tailwind']);

	// Killed while the second attempt was being written: the first survives.
	await fs.writeFile(sidecarOf(report), Buffer.concat([first, second.subarray(0, 12)]));
	const torn = await Effect.runPromise(loadRunWithFights(report));
	assert.deepEqual(torn.ledger.map(attempt => attempt.log?.[0]?.chose), ['Superpower', undefined]);

	// No sidecar at all is a run played inline, not an error.
	await fs.rm(sidecarOf(report));
	assert.equal((await Effect.runPromise(loadRunWithFights(report))).ledger.length, 2);
});

test('a run is read for what its wins had that its losses lacked', async () => {
	const {strategyOf} = await import('../src/analyse.js');
	const fall = turn({chose: 'switch to Luxray', why: 'forced replacement'});
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 90, fights: 4, ledger: [
		{n: 1, order: 80, trainer: 'Leader Brawly', seed: 5, result: 'loss', deaths: 6, log: [turn({chose: 'Superpower'}), fall]},
		{n: 2, order: 80, trainer: 'Leader Brawly', seed: 6, result: 'win', deaths: 5, log: [turn({chose: 'Tailwind'}), turn({chose: 'Tailwind'})]},
		{n: 3, order: 142, trainer: 'Leader Roxanne', seed: 7, result: 'loss', deaths: 6, log: [turn({chose: 'Superpower'})]},
		{n: 4, order: 142, trainer: 'Leader Roxanne', seed: 8, result: 'win', deaths: 0, log: [turn({chose: 'Swords Dance'})]},
	]}));
	const read = strategyOf(run);
	assert.deepEqual([read.wallsFought, read.wallsWon, read.attempts], [2, 2, 4]);
	assert.equal(read.bodiesLostPerWin, 2.5, 'what a win costs');
	assert.equal(read.cleanWins, 1);
	assert.deepEqual(read.control.find(entry => entry.tag === 'speed-control'), {tag: 'speed-control', perWin: 1, perLoss: 0});
	assert.deepEqual(read.control.find(entry => entry.tag === 'set-up'), {tag: 'set-up', perWin: 0.5, perLoss: 0});
	assert.deepEqual(read.leads[0], {lead: 'Bewear', wins: 2, attempts: 4});
});

test('a turn says who moved first, and whether the search was guessing', () => {
	const they = tagsOf(turn({events: ['Foe Mienshao used Close Combat. (85% to Bewear)', 'Bewear used Superpower. (59% to Mienshao)']}));
	assert.ok(they.includes('they-move-first') && !they.includes('we-move-first'));
	const we = tagsOf(turn({events: ['Bewear used Superpower. (59% to Mienshao)', 'Foe Mienshao used Close Combat. (85% to Bewear)']}));
	assert.ok(we.includes('we-move-first'));
	assert.ok(!tagsOf(turn({events: ['Bewear used Superpower. (100% to Mienshao)', 'Mienshao fainted!']})).includes('we-move-first'),
		'one action is not an order');
	// Brawly's winning attempt, turn one: Stun Spore 0.283 over Air Cutter 0.281.
	const guess = tagsOf(turn({chose: 'Stun Spore', why: 'search-4', scores: [
		{choice: 'Air Cutter', value: 0.281, runs: 4}, {choice: 'Stun Spore', value: 0.283, runs: 4}]}));
	assert.ok(guess.includes('coin-flip') && !guess.includes('clear-choice'));
	const sure = tagsOf(turn({why: 'search-8', scores: [{choice: 'Superpower', value: 0.71, runs: 8}, {choice: 'Thrash', value: 0.4, runs: 8}]}));
	assert.ok(sure.includes('clear-choice') && !sure.includes('coin-flip'));
});

test('a fight can be watched: the live file is read whole, torn line or not', async () => {
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const pathOf = await import('node:path');
	const {readLive} = await import('../src/serve.js');
	const file = pathOf.join(await fs.mkdtemp(pathOf.join(os.tmpdir(), 'live-')), 'run-1.live.ndjson');
	assert.deepEqual(await Effect.runPromise(readLive(file)), {header: null, turns: [], ended: null}, 'no file yet is a run that has not started');

	const header = {kind: 'attempt', at: 1, n: 12, trainer: 'Leader Brawly', order: 80, attempt: 3, position: 76,
		hand: 'search-8', six: [{name: 'Tuck', species: 'Monferno', level: 21, item: 'Oran Berry'}]};
	const line = (value: unknown): string => JSON.stringify(value) + '\n';
	await fs.writeFile(file, line(header) + line({kind: 'turn', ...turn({chose: 'Tailwind', why: 'search-8'})}) +
		'{"kind":"turn","turn":2,"us":"Bew');
	const mid = await Effect.runPromise(readLive(file));
	assert.equal(mid.header?.trainer, 'Leader Brawly');
	assert.equal(mid.turns.length, 1, 'the line being written right now is skipped, not fatal');
	assert.ok(mid.turns[0]?.tags.includes('speed-control'), 'and a watched turn is tagged like a kept one');
	assert.equal(mid.ended, null);

	await fs.appendFile(file, '\n' + line({kind: 'end', at: 2, result: 'win'}));
	assert.equal((await Effect.runPromise(readLive(file))).ended, 'win');
});

test('a body given up is read as forced, chosen or unforced — never simply as a mistake', () => {
	// Operator: "sometimes we might need to use a sacrifice or a Self-Destruct —
	// we just need a way to understand if we are forced to sacrifice."
	const boom = (threat: string, scores: Array<{choice: string; value: number; runs: number}>) =>
		tagsOf(turn({us: 'Gigalith L42', foe: 'Porygon2 L41', chose: 'Self-Destruct', why: 'search-8', threat, scores}));
	const doomed = boom('Their hardest hit: Ice Beam 120% · you need 1 turn to KO, they need 1 — YOU LOSE THIS RACE · they act first',
		[{choice: 'Self-Destruct', value: 0.21, runs: 8}, {choice: 'Sand Tomb', value: 0.2, runs: 8}]);
	assert.ok(doomed.includes('self-ko') && doomed.includes('sacrifice-forced'), doomed.join(','));

	const safe = 'Their hardest hit: Tri Attack 38% · you need 1 turn to KO, they need 3 — you win it';
	const chosen = boom(safe, [{choice: 'Self-Destruct', value: 0.62, runs: 8}, {choice: 'Sand Tomb', value: 0.3, runs: 8}]);
	assert.ok(chosen.includes('sacrifice-chosen') && !chosen.includes('sacrifice-forced'), chosen.join(','));

	// Norman, turn one: 0.206 over Sand Tomb's 0.204 with three turns to live.
	const unforced = boom(safe, [{choice: 'Self-Destruct', value: 0.206, runs: 8}, {choice: 'Sand Tomb', value: 0.204, runs: 8}]);
	assert.ok(unforced.includes('sacrifice-unforced'), unforced.join(','));
	assert.ok(!tagsOf(turn({chose: 'Sand Tomb'})).some(tag => tag.startsWith('sacrifice')), 'a turn that gives nothing up carries none of them');
});

test('a run is handled by the pid its own status file names, and a killed one reads as dead', async () => {
	const {control, readStatus} = await import('../src/serve.js');
	const {spawn, spawnSync} = await import('node:child_process');
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insight-control-'));
	const status = (pid: number, state: string): string => JSON.stringify({pid, seed: 7, state, position: 12, fights: 30,
		startedAt: 1, updatedAt: 2, secondsPerFight: 3.5, rssMb: 400, spec: 'budget=40'});

	// A pid that has certainly gone.
	const gone = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'}).stdout);
	await fs.writeFile(path.join(dir, 'run-1.status.json'), status(gone, 'running'));
	assert.equal((await Effect.runPromise(readStatus(path.join(dir, 'run-1.status.json'))))?.state, 'dead');
	assert.deepEqual(await control(dir, 'run-1', 'stop'), {ok: false, said: 'run-1 is not running'});
	assert.equal(await Effect.runPromise(readStatus(path.join(dir, 'nothing.status.json'))), null);

	// A living one: stop only ASKS (the run reads the file between fights); pause and continue signal it.
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
	try {
		await fs.writeFile(path.join(dir, 'run-2.status.json'), status(child.pid ?? -1, 'running'));
		assert.equal((await control(dir, 'run-2', 'pause')).ok, true);
		assert.equal((await Effect.runPromise(readStatus(path.join(dir, 'run-2.status.json'))))?.state, 'paused');
		assert.match(spawnSync('ps', ['-o', 'state=', '-p', String(child.pid)], {encoding: 'utf8'}).stdout, /T/, 'the process is really stopped');
		assert.equal((await control(dir, 'run-2', 'cont')).ok, true);
		assert.doesNotMatch(spawnSync('ps', ['-o', 'state=', '-p', String(child.pid)], {encoding: 'utf8'}).stdout, /T/);
		assert.equal((await control(dir, 'run-2', 'stop')).ok, true);
		assert.equal((JSON.parse(await fs.readFile(path.join(dir, 'run-2.control.json'), 'utf8')) as {action: string}).action, 'stop');
		assert.equal(child.exitCode, null, 'a stop is a request: the run ends itself, checkpointed');
	} finally {
		child.kill('SIGKILL');
	}
});

test('the road strip is read off the run\'s own log: how far, and which fights cost attempts', async () => {
	const {readRoad} = await import('../src/serve.js');
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insight-road-'));
	await fs.writeFile(path.join(dir, 'run-1.log'), ['1 #1 Trainer Rival Route 103 Blaziken win', '2 #27 Leader Brawly loss',
		'3 #27 Leader Brawly loss (search-8)', '4 #27 Leader Brawly win', '5 #32 Twins Gina And Mia loss (joint-4)',
		'6 #32 Twins Gina And Mia loss (joint-4)', 'CARRIED ON from position 80, fight 6', '7 #28 Bug Catcher Lyle win',
		'DONE position 80 fights 7 finished false stopped '].join('\n'));
	assert.deepEqual(await readRoad(path.join(dir, 'run-1.log')), {road: 32, walls: [
		{road: 27, trainer: 'Leader Brawly', attempts: 3, won: true},
		{road: 32, trainer: 'Twins Gina And Mia', attempts: 2, won: false}]});
	assert.deepEqual(await readRoad(path.join(dir, 'none.log')), {road: null, walls: []}, 'a run with no log has no road yet');
});

test('a run is read for its aggregates and a profile of every body, and runs roll up together', async () => {
	const {summariseRun, fleetOf} = await import('../src/profile.js');
	const row = (n: number, trainer: string, order: number, result: string, extra: object = {}) =>
		({n, order, trainer, result, policy: 'decide', ...extra});
	const ledger = [
		row(1, 'Youngster Calvin', 2, 'win', {kos: [{foe: 'Poochyena', by: 'Ember', monId: 'mon-1'}]}),
		// A wall: five attempts, cleared on the fifth by search, two bodies lost in the win.
		...[2, 3, 4, 5].map(n => row(n, 'Leader Brawly', 80, 'loss', {policy: n > 3 ? 'search-8' : 'decide',
			killers: [{monId: 'mon-1', species: 'Monferno', by: 'Drain Punch', of: 'Hariyama'}]})),
		row(6, 'Leader Brawly', 80, 'win', {policy: 'search-8', deaths: 2,
			kos: [{foe: 'Hariyama', by: 'Pluck', monId: 'mon-2'}, {foe: 'Medicham', by: 'Pluck', monId: 'mon-2'}]}),
		// And one that was never cleared.
		...[7, 8, 9, 10, 11].map(n => row(n, 'Leader Norman', 342, 'loss')),
	];
	const box = [{id: 'mon-1', species: 'Monferno', nickname: 'Tuck', level: 21, moves: ['Ember'], ivs: {hp: 10, atk: 20}, status: 'party'},
		{id: 'mon-2', species: 'Corvisquire', nickname: 'Moss', level: 21, moves: ['Pluck'], status: 'party', origin: {mapName: 'Route102'}},
		{id: 'mon-3', species: 'Wurmple', level: 5, status: 'dead'}];
	const summary = summariseRun({seed: 7, starter: 'Chimchar', position: 80, seconds: 600, state: 'ended', stopped: 'Leader Norman: skip',
		auditOk: true, plans: 1, reprobes: 0, scouted: {probe: 12, repick: 36, plan: 168}, ledger, doc: {position: 80, party: ['mon-1', 'mon-2'], box},
		formatsSwitched: [{from: 'Elite Four Sidney', to: 'Elite Four SidneyDouble', after: 40}],
		gifted: [{species: 'Kubfu', where: 'Route 110', at: 1573}]});
	assert.deepEqual(summary.formatsSwitched.map(x => x.to), ['Elite Four SidneyDouble'], 'a format switch reaches the page, not a skip');
	assert.deepEqual(summary.gifted.map(g => g.species), ['Kubfu']);
	assert.equal(summary.attempts, 11);
	assert.equal(summary.scoutedFights, 216, 'and beside the attempts, the fights played in the run\'s head: never attempts, never free');
	assert.equal(summary.trainersBeaten, 2);
	assert.equal(summary.firstTry, 1, 'Calvin fell first try, Brawly did not');
	assert.deepEqual(summary.byHand, [{hand: 'decide', attempts: 8, wins: 1}, {hand: 'search', attempts: 3, wins: 1}], 'search-8 and search-4 are one hand');
	assert.deepEqual(summary.walls.map(wall => [wall.trainer, wall.attempts, wall.cleared, wall.wonBy]),
		[['Leader Brawly', 5, true, 'search'], ['Leader Norman', 5, false, null]]);
	assert.equal(summary.bodiesLostPerWallWin, 2);
	const moss = summary.roster[0];
	assert.deepEqual([moss?.name, moss?.knockouts, moss?.wallKnockouts, moss?.falls, moss?.caught], ['Moss', 2, 2, 0, 'Route102'],
		'the body that cleared the wall leads the box, and its knockouts there are counted apart');
	const tuck = summary.roster[1];
	assert.deepEqual([tuck?.knockouts, tuck?.wallKnockouts, tuck?.falls, tuck?.ivTotal], [1, 0, 4, 30]);
	assert.deepEqual(tuck?.fellTo, [['Hariyama · Drain Punch', 4]]);
	assert.equal(summary.roster[2]?.alive, false);

	// One seed is one journey, however many directories it was played in. Seed 7
	// here is the run above, a measurement ARM restarted from the same place
	// that got less far, and a leg carried on from Norman that cleared him.
	const arm = {...summary, position: 60, attempts: 4};
	const onward = {...summary, startedAt: 337, position: 400, attempts: 9, roster: [],
		walls: [{trainer: 'Leader Norman', order: 342, attempts: 9, cleared: true, wonBy: 'decide', bodiesLostInWin: 3}]};
	const other = {...summary, seed: 8};
	const fleet = fleetOf([{run: 'a/run-7', summary}, {run: 'arm/run-7', summary: arm}, {run: 'on/run-7', summary: onward}, {run: 'b/run-8', summary: other}]);
	assert.deepEqual(fleet.seeds.map(entry => [entry.seed, entry.position, entry.legs.length]), [[7, 400, 3], [8, 80, 1]]);
	const seven = fleet.seeds[0];
	assert.deepEqual(seven?.legs.map(leg => [leg.run, leg.counted]), [['a/run-7', true], ['arm/run-7', false], ['on/run-7', true]],
		'of the legs that began at one place only the one that got furthest is counted');
	assert.deepEqual(seven?.stoppedAt, [], 'the leg carried on cleared Norman, so this seed is stopped nowhere');
	assert.deepEqual(fleet.seeds[1]?.stoppedAt, ['Leader Norman']);
	assert.deepEqual(fleet.walls.map(wall => [wall.trainer, wall.runsMet, wall.runsCleared, wall.medianAttempts]),
		[['Leader Brawly', 2, 2, 5], ['Leader Norman', 2, 1, 5]], 'a wall is counted once per SEED: cleared if any leg cleared it, at the most any one leg spent');
	assert.deepEqual(fleet.species[0], {species: 'Corvisquire', runs: 2, knockouts: 4, falls: 0, wallKnockouts: 4},
		'and the arm\'s copy of the same fights is not tallied again');
	assert.ok(!('roster' in (seven?.legs[0]?.summary ?? {})), 'the fleet carries each leg\'s aggregates, not forty rosters');
});

test('the page the watcher serves is a script that parses', async () => {
	// The page is one template literal; a stray apostrophe in a heading once
	// broke the whole script and every view with it, and nothing but a browser
	// would have said so.
	const {serve} = await import('../src/serve.js');
	const os = await import('node:os');
	const server = serve(os.tmpdir(), 0);
	try {
		await new Promise(resolve => server.once('listening', resolve));
		const address = server.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const html = await (await fetch('http://127.0.0.1:' + port + '/')).text();
		const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
		assert.ok(script.length > 1000, 'the page carries its script');
		assert.doesNotThrow(() => new Function(script), 'and the script parses');
	} finally {
		server.close();
	}
});

test('a double is read from its tape: who acted, what it cost, which foe took our bodies', async () => {
	// Every double was hasLog: false here — its tape is events, not turns — so
	// Sidney's double, won on attempt 17, had none of its 17 tapes read.
	const member = (species: string) => ({name: species, species, level: 99, item: null, ability: null, nature: null, moves: []});
	const six = [member('Octillery'), member('Lopunny'), member('Urshifu')];
	const tape = (hypnosis: string, sided: boolean) => [
		{turn: 1, text: 'Incineroar used Fake Out → Octillery -15%', side: 'theirs'},
		{turn: 1, text: 'Articuno-Galar used Hypnosis → Octillery' + hypnosis, side: 'theirs'},
		{turn: 1, text: 'Octillery used Icy Wind → Incineroar, Articuno-Galar (crit)', side: 'ours'},
		// A mirror: their Urshifu. Only `side` can tell it from ours.
		{turn: 2, text: 'Urshifu used Wicked Blow → Lopunny-Mega -100%', side: 'theirs'},
		{text: 'Lopunny-Mega fainted!', side: 'ours'},
		{turn: 2, text: 'Octillery used Water Spout → Incineroar -100%', side: 'ours'},
		{text: 'Incineroar fainted!', side: 'theirs'},
	].map(event => sided ? event : {turn: event.turn, text: event.text});
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 1600, fights: 2, ledger: [
		{n: 1, order: 1583, trainer: 'Elite Four SidneyDouble', seed: 5, result: 'loss', events: tape('', true), six},
		{n: 2, order: 1583, trainer: 'Elite Four SidneyDouble', seed: 6, result: 'win', events: tape(' (missed)', true), six},
	]}));
	const [wall] = walls(run);
	assert.ok(wall !== undefined);
	assert.equal(wall.logged, 2, 'both doubles count as logged');
	const win = wall.summaries[1];
	assert.ok(win !== undefined);
	assert.equal(win.lead, 'Octillery', 'the lead is ours, in the order we acted');
	assert.equal(win.turns, 2);
	assert.equal(win.bodiesLost, 1);
	assert.equal(win.tagCounts['speed-control'], 1);
	assert.equal(win.tagCounts['crit-ours'], 1);
	assert.equal(win.tagCounts['we-ko'], 1);
	assert.deepEqual(wall.tagLift.find(entry => entry.tag === 'miss-theirs'), {tag: 'miss-theirs', win: 1, lossMean: 0});
	const urshifu = win.foeCosts.find(cost => cost.foe === 'Urshifu');
	assert.deepEqual(urshifu, {foe: 'Urshifu', faced: 1, bodiesLost: 1, turns: 1, fell: false},
		'their Urshifu is theirs, and Lopunny is charged to it');
	// Without `side` (tapes before 2026-09-22) the six decides — and a mirror reads as ours.
	const [old] = walls(await Effect.runPromise(decodeRun({seed: 1, position: 1600, fights: 1, ledger: [
		{n: 1, order: 1583, trainer: 'Elite Four SidneyDouble', seed: 5, result: 'loss', events: tape('', false), six}]})));
	assert.ok(old?.summaries[0]?.order.includes('Urshifu'), 'the fallback cannot see a mirror');
	assert.equal(old?.summaries[0]?.tagCounts['we-fall'], 1, 'Lopunny-Mega is matched to Lopunny in the six');
});

test('a carried-on run is read from its newer checkpoint, not its last leg\'s stale record', async () => {
	// 418957 played Sidney's double, Phoebe, Glacia and Drake while RUN.json
	// still said it had stopped at Sidney; every agent tool read RUN.json.
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const path = await import('node:path');
	const {loadRun} = await import('../src/cli.js');
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insight-carry-'));
	const row = (n: number, trainer: string) => ({n, order: 1577, trainer, seed: n, result: 'loss'});
	const record = path.join(dir, 'run-1.json');
	await fs.writeFile(record, JSON.stringify({seed: 1, position: 1573, fights: 1, ledger: [row(1, 'Elite Four Sidney')]}));
	await fs.writeFile(path.join(dir, 'run-1.checkpoint.json'), JSON.stringify({seed: 1, position: 1583,
		state: {tally: {fights: 2, ledger: [row(1, 'Elite Four Sidney'), row(2, 'Elite Four SidneyDouble')]}}}));
	await fs.utimes(record, new Date(1000), new Date(1000));
	const now = await Effect.runPromise(loadRun(record));
	assert.equal(now.ledger.length, 2, 'the newer checkpoint wins');
	assert.equal(now.position, 1583);
	// A record written after the checkpoint (the leg ended) is the one read.
	await fs.utimes(record, new Date(), new Date(Date.now() + 60000));
	assert.equal((await Effect.runPromise(loadRun(record))).ledger.length, 1);
	await fs.rm(dir, {recursive: true});
});

// A wall read per foe, composed from decoded records: the table the operator
// kept building by hand at Champion Wallace.
const fallen = (species: string, by: string, of: string) => ({monId: 'mon-' + species, species, by, of});
const singlesWall = () => decodeRun({seed: 1, position: 1700, fights: 3, ledger: [
	// Loss 1: Kyogre takes three with Origin Pulse, Goodra two; Lopunny dies to its own Double-Edge.
	{n: 10, order: 1625, trainer: 'Champion Wallace', seed: 5, result: 'loss', deaths: 6, policy: 'search-8',
		killers: [fallen('Dhelmise', 'Origin Pulse', 'Kyogre-Primal'), fallen('Walrein', 'Origin Pulse', 'Kyogre-Primal'),
			fallen('Florges', 'Thunder', 'Kyogre-Primal'), fallen('Eldegoss', 'Heavy Slam', 'Goodra-Hisui'),
			fallen('Togekiss', 'Heavy Slam', 'Goodra-Hisui'), fallen('Lopunny-Mega', 'Double-Edge', 'Lopunny-Mega')],
		kos: [{foe: 'Kyogre-Primal', by: 'Power Whip', monId: 'mon-Dhelmise'}],
		log: [turn({us: 'Dhelmise L99', foe: 'Kyogre-Primal L100', chose: 'Power Whip'}),
			turn({us: 'Walrein L99', foe: 'Goodra-Hisui L100', chose: 'Super Fang'}),
			turn({us: 'Walrein L99', foe: 'Goodra-Hisui L100', chose: 'Super Fang'})]},
	// Loss 2: no tape; Kyogre takes one, Goodra five.
	{n: 11, order: 1625, trainer: 'Champion Wallace', seed: 6, result: 'loss', deaths: 6,
		killers: [fallen('Dhelmise', 'Ice Beam', 'Kyogre-Primal'), ...['Walrein', 'Florges', 'Eldegoss', 'Togekiss', 'Lopunny-Mega']
			.map(species => fallen(species, 'Heavy Slam', 'Goodra-Hisui'))], kos: []},
	// The win: Goodra takes one, both fall.
	{n: 12, order: 1625, trainer: 'Champion Wallace', seed: 7, result: 'win', deaths: 1,
		killers: [fallen('Walrein', 'Aqua Tail', 'Goodra-Hisui')],
		kos: [{foe: 'Kyogre-Primal', by: 'Power Whip', monId: 'mon-Dhelmise'}, {foe: 'Goodra-Hisui', by: 'Moonblast', monId: 'mon-Florges'}],
		log: [turn({us: 'Dhelmise L99', foe: 'Kyogre-Primal L100', chose: 'Power Whip', events: ['Kyogre-Primal fainted!']}),
			turn({us: 'Florges L99', foe: 'Goodra-Hisui L100', chose: 'Moonblast'})]},
]});

test('a wall is read per foe: what each costs a facing, how often it falls, what it kills with, the win beside the losses', async () => {
	const {wallView} = await import('../src/analyse.js');
	const run = await Effect.runPromise(singlesWall());
	assert.equal(wallView(run, 'Leader Nobody'), null);
	const view = wallView(run, 'Champion Wallace');
	assert.ok(view !== null);
	assert.deepEqual([view.attempts, view.wonOn, view.winN, view.logged], [3, 3, 12, 2]);
	assert.deepEqual(view.foes.map(foe => foe.foe), ['Goodra-Hisui', 'Kyogre-Primal'], 'most costly a facing first');
	const [goodra, kyogre] = view.foes;
	assert.ok(goodra !== undefined && kyogre !== undefined);
	// Goodra: met in all three (on the tape in 10 and 12, named by the ledger in 11), 2 + 5 + 1 bodies.
	assert.deepEqual([goodra.facedIn, goodra.bodiesLost, goodra.bodiesPerFacing, goodra.fell, goodra.fellShare],
		[3, 8, 2.67, 1, 0.33]);
	assert.deepEqual(goodra.killers, [['Heavy Slam', 7], ['Aqua Tail', 1]], 'what kills us, by move, most first');
	assert.deepEqual(goodra.win, {bodiesLost: 1, fell: true, turns: 1});
	assert.deepEqual(goodra.losses, {facedIn: 2, bodiesPerFacing: 3.5, fellShare: 0, turnsPerFacing: 2},
		'turns are counted over taped facings only: 2 in attempt 10, attempt 11 had no tape');
	assert.deepEqual([kyogre.facedIn, kyogre.bodiesLost, kyogre.bodiesPerFacing, kyogre.fell], [3, 4, 1.33, 2]);
	assert.deepEqual(kyogre.killers, [['Origin Pulse', 2], ['Ice Beam', 1], ['Thunder', 1]]);
	assert.equal(view.selfInflicted, 1, 'Lopunny\'s own Double-Edge is charged to no foe');
	assert.ok(!view.foes.some(foe => foe.foe === 'Lopunny-Mega'));
	assert.deepEqual(view.runs.map(entry => [entry.n, entry.result, entry.knockouts]), [[10, 'loss', 1], [11, 'loss', 0], [12, 'win', 2]]);
});

test('a doubles wall is read per foe too, and a mirror is charged to their side, not to our recoil', async () => {
	const {wallView} = await import('../src/analyse.js');
	const member = (species: string) => ({name: species, species, level: 99, item: null, ability: null, nature: null, moves: []});
	const six = [member('Octillery'), member('Urshifu')];
	const tape = [
		{turn: 1, text: 'Articuno-Galar used Hurricane → Octillery -100%', side: 'theirs'},
		{text: 'Octillery fainted!', side: 'ours'},
		{turn: 2, text: 'Urshifu used Wicked Blow → Urshifu -100%', side: 'theirs'},
		{text: 'Urshifu fainted!', side: 'ours'},
	];
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 1600, fights: 2, ledger: [
		// The ledger names the killers: their Urshifu killed ours — a mirror the tape sees on their side.
		{n: 1, order: 1583, trainer: 'Elite Four SidneyDouble', seed: 5, result: 'loss', events: tape, six,
			killers: [fallen('Octillery', 'Hurricane', 'Articuno-Galar'), fallen('Urshifu', 'Wicked Blow', 'Urshifu')]},
		// No killers on the row: the tape's own charge (the foe that last hit) stands in.
		{n: 2, order: 1583, trainer: 'Elite Four SidneyDouble', seed: 6, result: 'win', events: tape, six},
	]}));
	const view = wallView(run, 'Elite Four SidneyDouble');
	assert.ok(view !== null);
	assert.equal(view.selfInflicted, 0, 'their Urshifu killing ours is not our recoil');
	const urshifu = view.foes.find(foe => foe.foe === 'Urshifu');
	const articuno = view.foes.find(foe => foe.foe === 'Articuno-Galar');
	assert.deepEqual([urshifu?.facedIn, urshifu?.bodiesLost, urshifu?.killers], [2, 2, [['Wicked Blow', 1]]]);
	assert.deepEqual(urshifu?.win, {bodiesLost: 1, fell: false, turns: 1}, 'the win, read off the tape alone');
	assert.deepEqual([articuno?.bodiesLost, articuno?.turnsPerFacing], [2, 1]);
});

test('a wall charges a body to a foe only when the actor was on their side', async () => {
	const {wallView} = await import('../src/analyse.js');
	const member = (species: string) => ({name: species, species, level: 99, item: null, ability: null, nature: null, moves: []});
	const six = ['Florges', 'Houndoom', 'Lopunny', 'Pinsir'].map(member);
	const side = (ofSide: 'ours' | 'theirs') => <T extends object>(fall: T) => ({...fall, ofSide});
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 1600, fights: 2, ledger: [
		// sidney1 attempt 3, as written before ofSide: Florges switched in for Houndoom and died to Spikes.
		{n: 1, order: 1580, trainer: 'Elite Four Sidney', seed: 5, result: 'loss', six, killers: [
			{monId: 'mon-Florges', species: 'Florges', by: null, of: 'Houndoom'},
			fallen('Houndoom', 'Dark Pulse', 'Yveltal'),
			fallen('Lopunny-Mega', 'Double-Edge', 'Lopunny-Mega'),
			{monId: 'mon-Araquanid', species: 'Araquanid', by: null, of: null}]},
		// A new ledger says the side: hazards on our switch, and a mirror Lopunny-Mega of theirs.
		{n: 2, order: 1580, trainer: 'Elite Four Sidney', seed: 6, result: 'loss', six, killers: [
			side('ours')({monId: 'mon-Pinsir', species: 'Pinsir', by: null, of: 'Lopunny-Mega'}),
			side('theirs')(fallen('Lopunny-Mega', 'Double-Edge', 'Lopunny-Mega')),
			side('theirs')(fallen('Houndoom', 'Oblivion Wing', 'Yveltal'))]},
	]}));
	const view = wallView(run, 'Elite Four Sidney');
	assert.ok(view !== null);
	assert.deepEqual(view.foes.map(foe => [foe.foe, foe.bodiesLost]).sort(), [['Lopunny-Mega', 1], ['Yveltal', 2]],
		'Houndoom and Pinsir are ours: no foe row, and the Lopunny-Mega row is their mirror alone');
	assert.equal(view.hazards, 2, 'Florges and Pinsir fell to hazards on our own switch');
	assert.equal(view.selfInflicted, 1, 'our Lopunny-Mega\'s own Double-Edge, on the old ledger');
	assert.equal(view.approximate, true, 'attempt 1 has no ofSide, so the page must say it is approximate');
	assert.equal(view.unattributed, 1, 'Araquanid fell with no actor named: counted, not dropped');
	const fresh = wallView(await Effect.runPromise(decodeRun({seed: 1, position: 1600, fights: 1,
		ledger: [run.ledger[1]]})), 'Elite Four Sidney');
	assert.equal(fresh?.approximate, false);
});

/**
 * The watch page's own script, run against a stub document: what the wall
 * view DRAWS, as text and as SVG shapes. The startup line (polls, timers) is
 * cut; `fetch` answers from `reply`.
 */
class Stub {
	readonly children: Stub[] = [];
	readonly attrs: Record<string, string> = {};
	textContent = '';
	constructor(readonly tag: string) {}
	appendChild(kid: Stub) { this.children.push(kid); return kid; }
	replaceChildren(...kids: Stub[]) { this.children.splice(0, this.children.length, ...kids); }
	setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
	getAttribute(key: string) { return this.attrs[key] ?? null; }
	addEventListener() { /* nothing is clicked here */ }
	get text(): string { return [this.textContent, ...this.children.map(kid => kid.text)].filter(Boolean).join(' '); }
	all(tag: string): Stub[] { return [...(this.tag === tag ? [this] : []), ...this.children.flatMap(kid => kid.all(tag))]; }
}
const pageScript = async (reply: (url: string) => {status: number; body: string}) => {
	const {PAGE} = await import('../src/serve.js');
	const script = (/<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? '').replace(/^view = prefs\.view[\s\S]*$/m, '');
	const document = {createElement: (tag: string) => new Stub(tag), createElementNS: (_ns: string, tag: string) => new Stub(tag),
		createTextNode: (text: string) => Object.assign(new Stub('#text'), {textContent: text}),
		getElementById: () => new Stub('div'), addEventListener() {}, body: new Stub('body')};
	const fetch = async (url: string) => { const {status, body} = reply(url);
		return {ok: status < 400, status, json: async () => JSON.parse(body), text: async () => body}; };
	const localStorage = {getItem: () => null, setItem() {}};
	const make = new Function('document', 'window', 'localStorage', 'fetch', 'Node', 'location', 'history',
		script + '\n;return {drawWall, nice, open: (run, trainer) => { current = run; wallOpen = trainer; return drawing; }};');
	return make(document, {addEventListener() {}}, localStorage, fetch, Stub, {search: '', hash: ''}, {replaceState() {}}) as
		{drawWall: (box: Stub, mine: number) => Promise<void>; nice: (value: number) => number; open: (run: string, trainer: string) => number};
};
const drawnWall = async (view: unknown, status = 200) => {
	const page = await pageScript(() => ({status, body: JSON.stringify(view)}));
	const box = new Stub('div');
	await page.drawWall(box, page.open('run-1', 'Elite Four Sidney'));
	return box;
};

test('the wall page says what is charged to a foe and what is not', async () => {
	const {wallView} = await import('../src/analyse.js');
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 1600, fights: 1, ledger: [
		{n: 1, order: 1580, trainer: 'Elite Four Sidney', seed: 5, result: 'loss', killers: [
			{...fallen('Houndoom', 'Dark Pulse', 'Yveltal'), ofSide: 'theirs'},
			{monId: 'mon-Araquanid', species: 'Araquanid', by: null, of: null},
			{monId: 'mon-Florges', species: 'Florges', by: null, of: 'Houndoom', ofSide: 'ours'}]}]}));
	const view = wallView(run, 'Elite Four Sidney');
	assert.equal(view?.unattributed, 1, 'a body with no actor is counted, not dropped');
	const text = (await drawnWall(view)).text;
	assert.ok(!text.includes('dealt its last hit'), 'the caption no longer claims every body is charged');
	assert.match(text, /1 body here, and 2 more charged to no foe/);
	assert.match(text, /1 body fell with no actor recorded/);
	assert.match(text, /1 body fell on our own switch/);
});

test('a foe met only in the win has no loss reading, not a loss reading of 0', async () => {
	const {wallView} = await import('../src/analyse.js');
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 1700, fights: 2, ledger: [
		{n: 1, order: 1625, trainer: 'Champion Wallace', seed: 5, result: 'loss',
			killers: [{...fallen('Walrein', 'Origin Pulse', 'Kyogre-Primal'), ofSide: 'theirs'}], kos: []},
		// Only the win got as far as Milotic.
		{n: 2, order: 1625, trainer: 'Champion Wallace', seed: 6, result: 'win',
			killers: [{...fallen('Florges', 'Scald', 'Milotic'), ofSide: 'theirs'}],
			kos: [{foe: 'Kyogre-Primal', by: 'Power Whip'}, {foe: 'Milotic', by: 'Moonblast'}]},
	]}));
	const view = wallView(run, 'Champion Wallace');
	const milotic = view?.foes.find(foe => foe.foe === 'Milotic');
	assert.deepEqual(milotic?.losses, {facedIn: 0, bodiesPerFacing: null, fellShare: null, turnsPerFacing: null});
	assert.deepEqual(milotic?.win, {bodiesLost: 1, fell: true, turns: null});
	const box = await drawnWall(view);
	const row = box.all('tr').find(tr => tr.text.startsWith('Milotic'));
	assert.ok(row !== undefined);
	assert.ok(!/\b0%/.test(row.text), 'no "0%" fell for losses that never met it: ' + row.text);
	assert.equal(row.all('circle').filter(dot => dot.attrs.class === 'loss').length, 0, 'and no grey loss dot at 0');
	// The grey dot is a mean over the losses that MET the foe: one for Kyogre, none for Milotic — not "the 1 losses".
	const heads = box.all('th').map(th => th.text);
	const met = heads.indexOf('losses met');
	assert.ok(met > 0, 'the table counts the losses each mean is over');
	assert.deepEqual(box.all('tr').filter(tr => tr.all('td').length > 0).map(tr => [tr.all('td')[0]?.text, tr.all('td')[met]?.text]).sort(),
		[['Kyogre-Primal', '1'], ['Milotic', '0']]);
	assert.ok(!/mean of the \d+ losses/.test(box.text), 'the caption no longer counts every loss');
});

test('a run that does not decode says why on the wall and the attempt, never that it kept nothing', async () => {
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const pathOf = await import('node:path');
	const {loadWall, serve} = await import('../src/serve.js');
	const dir = await fs.mkdtemp(pathOf.join(os.tmpdir(), 'insight-bad-'));
	await fs.writeFile(pathOf.join(dir, 'run-1.json'), JSON.stringify({seed: 1, position: 3, fights: 1,
		ledger: [{n: 1, order: 2, trainer: 'Leader Brawly', seed: '7', result: 'win'}]}));
	await assert.rejects(loadWall(dir, 'run-1', 'Leader Brawly'), /ledger\.0\.seed/, 'the reason names the field that moved');
	const server = serve(dir, 0);
	try {
		await new Promise(resolve => server.once('listening', resolve));
		const address = server.address();
		const base = 'http://127.0.0.1:' + (typeof address === 'object' && address !== null ? address.port : 0);
		for (const route of ['/wall?run=run-1&trainer=Leader%20Brawly', '/attempt?run=run-1&n=1']) {
			const got = await fetch(base + route);
			assert.equal(got.status, 500, route + ' is not a 200 with null');
			assert.match(((await got.json()) as {error: string}).error, /is not a run record: ledger\.0\.seed/);
		}
	} finally {
		server.close();
		await fs.rm(dir, {recursive: true});
	}
	const text = (await drawnWall({error: 'run-1.json is not a run record: ledger.0.seed: Expected number'}, 500)).text;
	assert.match(text, /cannot read this run for Elite Four Sidney: run-1\.json is not a run record/);
	assert.ok(!text.includes('kept nothing'));
});

test('a wall is ordered by the losses\' mean it plots, not by the mean over every attempt', async () => {
	const {wallView} = await import('../src/analyse.js');
	const theirs = (species: string, of: string) => ({...fallen(species, 'Tackle', of), ofSide: 'theirs' as const});
	const run = await Effect.runPromise(decodeRun({seed: 1, position: 1700, fights: 2, ledger: [
		// In the loss Gyarados takes two, Milotic one; in the win Milotic takes five. Over all: Milotic 3, Gyarados 1.
		{n: 1, order: 1625, trainer: 'Champion Wallace', seed: 5, result: 'loss',
			killers: [theirs('Walrein', 'Gyarados'), theirs('Florges', 'Gyarados'), theirs('Dhelmise', 'Milotic')]},
		{n: 2, order: 1625, trainer: 'Champion Wallace', seed: 6, result: 'win',
			killers: ['Walrein', 'Florges', 'Dhelmise', 'Togekiss', 'Eldegoss'].map(species => theirs(species, 'Milotic')),
			kos: [{foe: 'Gyarados', by: 'Thunder'}]},
	]}));
	const view = wallView(run, 'Champion Wallace');
	assert.deepEqual(view?.foes.map(foe => [foe.foe, foe.losses.bodiesPerFacing, foe.bodiesPerFacing]),
		[['Gyarados', 2, 1], ['Milotic', 1, 3]]);
});

test('an agent gets the wall per foe as JSON, and the watch page opens any past attempt', async () => {
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const pathOf = await import('node:path');
	const zlib = await import('node:zlib');
	const {handle} = await import('../src/mcp.js');
	const {loadAttempt, loadWall, serve} = await import('../src/serve.js');
	const dir = await fs.mkdtemp(pathOf.join(os.tmpdir(), 'insight-wall-'));
	const run = await Effect.runPromise(singlesWall());
	// The ledger row keeps no tape; the sidecar has it, by ledger number.
	await fs.writeFile(pathOf.join(dir, 'run-1.json'), JSON.stringify({...run, ledger: run.ledger.map(({log: _log, ...row}) => row)}));
	await fs.writeFile(pathOf.join(dir, 'run-1.fights.ndjson.gz'), Buffer.concat(run.ledger.filter(row => row.log !== undefined)
		.map(row => zlib.gzipSync(JSON.stringify({n: row.n, trainer: row.trainer, log: row.log}) + '\n'))));
	const call = async (args: unknown) => (await Effect.runPromise(handle({id: 1, method: 'tools/call',
		params: {name: 'wall_view', arguments: args}})) as {result: {isError?: boolean; content: Array<{text: string}>}}).result;
	const one = await call({report: pathOf.join(dir, 'run-1.json'), trainer: 'Champion Wallace'});
	const read = JSON.parse(one.content[0]?.text ?? 'null') as {foes: Array<{foe: string; bodiesPerFacing: number; turnsPerFacing: number}>};
	assert.deepEqual(read.foes.map(foe => [foe.foe, foe.bodiesPerFacing, foe.turnsPerFacing]), [['Goodra-Hisui', 2.67, 1.5], ['Kyogre-Primal', 1.33, 1]],
		'the tapes come back off the sidecar');
	assert.equal((JSON.parse((await call({report: pathOf.join(dir, 'run-1.json')})).content[0]?.text ?? '[]') as unknown[]).length, 0,
		'three attempts is not a wall by default');
	assert.equal((JSON.parse((await call({report: pathOf.join(dir, 'run-1.json'), minAttempts: 3})).content[0]?.text ?? '[]') as unknown[]).length, 1);
	assert.equal((await call({report: pathOf.join(dir, 'run-1.json'), trainer: 'Leader Nobody'})).isError, true);

	assert.equal((await loadWall(dir, 'run-1', 'Champion Wallace'))?.foes.length, 2);
	const past = await loadAttempt(dir, 'run-1', 10);
	assert.deepEqual([past?.attempt, past?.of, past?.prev, past?.next, past?.turns.length, past?.events], [1, 3, null, 11, 3, null]);
	assert.ok((await loadAttempt(dir, 'run-1', 12))?.turns[0]?.tags.includes('we-ko'), 'a past turn is tagged as a live one is');
	assert.equal(await loadAttempt(dir, 'run-1', 99), null);
	const server = serve(dir, 0);
	try {
		await new Promise(resolve => server.once('listening', resolve));
		const address = server.address();
		const base = 'http://127.0.0.1:' + (typeof address === 'object' && address !== null ? address.port : 0);
		const got = await (await fetch(base + '/attempt?run=run-1&n=12')).json() as {result: string; prev: number};
		assert.deepEqual([got.result, got.prev], ['win', 11]);
		assert.equal((await fetch(base + '/attempt?run=../etc&n=1')).status, 400, 'a run name cannot walk out of the directory');
		assert.equal((await fetch(base + '/wall?run=../etc&trainer=x')).status, 400);
	} finally {
		server.close();
		await fs.rm(dir, {recursive: true});
	}
});
