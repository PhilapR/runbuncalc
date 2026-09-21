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
	assert.deepEqual(listed.result.tools.map(entry => entry.name), ['run_strategy', 'list_walls', 'compare_attempts', 'get_attempt', 'get_turns',
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
		auditOk: true, plans: 1, reprobes: 0, scouted: {probe: 12, repick: 36, plan: 168}, ledger, doc: {position: 80, party: ['mon-1', 'mon-2'], box}});
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
