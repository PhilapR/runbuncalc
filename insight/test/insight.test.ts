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
	assert.deepEqual(listed.result.tools.map(entry => entry.name), ['run_strategy', 'list_walls', 'compare_attempts', 'get_attempt', 'get_turns']);
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
