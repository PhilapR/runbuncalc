/* eslint-env node, es6 */
'use strict';

/**
 * Browser gate for the My Run panel.
 *
 * `run.test.js` covers the rules and `play.test.js` covers the save file. What
 * is only checkable here is the thing a player actually does: start a run, look
 * at a route, catch something off it, set a party, and plan the next fight —
 * with the whole run living in private browser storage and the server holding
 * nothing. IndexedDB owns the durable revision; localStorage is a compatibility
 * mirror and cross-tab signal.
 *
 * These properties are specific to this layer and cannot be tested below it:
 *
 *   - a refusal must not corrupt the save. The panel writes only what the
 *     server accepted, so a rejected catch has to leave `localStorage` byte for
 *     byte as it was — and a pasted run is a refusal like any other, which is
 *     why it has to be validated by the server BEFORE it is adopted.
 *   - the run must survive a reload. A playthrough that evaporates on refresh is
 *     not a playthrough, and the legacy Team/Box grid on this same page has had
 *     exactly that bug for its whole life.
 *   - one change at a time. Every call posts the whole run and adopts what comes
 *     back, so two in flight share one base run and the later reply drops the
 *     earlier command without a word.
 *
 * This file keeps exactly those three properties. The rest of the panel is in
 * the browser_run_{setup,panel,fight}.test.js shards, split out so Node can
 * run them in parallel, and the harness they share is
 * tests/helpers/browser-run.js.
 *
 * Skips rather than fails without Chromium, so the suite still runs headless.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const browserRun = require('./helpers/browser-run.js');

const skip = browserRun.skip;
const harness = browserRun.harness;
const open = browserRun.open;
const openAllSections = browserRun.openAllSections;
const sentWithin = browserRun.sentWithin;
const savedRun = browserRun.savedRun;
const durableHead = browserRun.durableHead;
const selectManualMap = browserRun.selectManualMap;

browserRun.useBrowser();

test('a new run cannot outrun durable bootstrap', {skip}, async () => {
	const context = await harness.browser.newContext();
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	let releaseMaps;
	const mapsReleased = new Promise(resolve => { releaseMaps = resolve; });
	await context.route('**/run/maps', async route => {
		await mapsReleased;
		await route.continue();
	});
	const page = await context.newPage();
	await page.goto(`${harness.baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await page.waitForFunction(() => {
		const button = document.querySelector('#runbun-run-new');
		const events = button && window.jQuery && window.jQuery._data(button, 'events');
		return events && events.click;
	});

	await page.click('.runbun-run-starter[data-species="Piplup"]');
	assert.equal(await page.isDisabled('#runbun-run-new'), true,
		'the selected starter must not bypass unfinished durable bootstrap');
	assert.equal(await page.getAttribute('#runbun-run-new', 'title'),
		'Loading the run panel…', 'a disabled start button must say why');
	assert.equal(await page.getAttribute('.runbun-run-setup-form', 'aria-busy'), 'true');
	await page.evaluate(() => document.querySelector('#runbun-run-new').click());
	assert.equal(await savedRun(page), null, 'a programmatic early click must not create a fallback save');

	releaseMaps();
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});
	await page.waitForFunction(() => !document.querySelector('#runbun-run-new').disabled);
	assert.equal(await page.getAttribute('.runbun-run-setup-form', 'aria-busy'), 'false');
	await page.click('#runbun-run-new');
	await page.waitForFunction(() => /Started My run/.test(
		document.querySelector('#runbun-run-status').textContent), null, {timeout: 15000});
	const head = await durableHead(page);
	assert.equal(head.revision, 1);
	assert.equal(head.run.name, 'My run');
	await context.close();
});

test('IndexedDB is authoritative and exports a checked replay archive', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Durable run');
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.waitForFunction(async () => {
		const head = await window.RunBunAttemptStore.getDefault().loadActive();
		return head && head.revision === 1 && head.run.name === 'Durable run';
	}, null, {timeout: 15000});

	const before = await durableHead(page);
	assert.equal(before.revision, 1);
	const inspected = await page.evaluate(id =>
		window.RunBunAttemptStore.getDefault().inspectAttempt(id), before.attemptId);
	assert.equal(inspected.events.length, 1);
	assert.equal(inspected.events[0].kind, 'run.started');
	assert.equal(inspected.events[0].schemaVersion, '2.0.0');
	assert.equal(inspected.events[0].source.providerId, 'runbun-browser');
	assert.equal(inspected.events[0].source.kind, 'manual');
	assert.match(inspected.events[0].eventHash, /^[a-f0-9]{64}$/);
	assert.deepEqual(await page.evaluate(async () => {
		const request = indexedDB.open(window.RunBunAttemptStore.DB_NAME);
		const db = await new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const tx = db.transaction(['events', 'snapshots', 'idempotency', 'evidence'], 'readonly');
		const result = {
			databaseVersion: db.version,
			events: Array.from(tx.objectStore('events').indexNames),
			snapshots: Array.from(tx.objectStore('snapshots').indexNames),
			idempotency: Array.from(tx.objectStore('idempotency').indexNames),
			evidence: Array.from(tx.objectStore('evidence').indexNames),
		};
		db.close();
		return result;
	}), {
		databaseVersion: 3,
		events: ['byAttempt', 'byAttemptRevision'],
		snapshots: ['byAttempt', 'byAttemptRevision'],
		idempotency: ['byAttempt'],
		evidence: ['byAttempt'],
	});

	// Delete only the compatibility mirror. Reload must recover the IndexedDB
	// head and repopulate that mirror, proving localStorage is not authoritative.
	await page.evaluate(() => window.localStorage.removeItem('runbun.run.v1'));
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 15000});
	assert.equal(await page.textContent('#runbun-run-name'), 'Durable run');
	assert.equal((await savedRun(page)).name, 'Durable run');
	assert.match(await page.textContent('#runbun-run-status'), /durable browser storage/);

	await page.click('.runbun-run-transfer summary');
	await page.click('#runbun-run-export');
	await page.waitForFunction(
		() => /"format": "rabrun\.archive"/.test(
			document.querySelector('#runbun-run-transfer').value),
		null, {timeout: 10000});
	assert.equal(await page.evaluate(async () => {
		const bundle = JSON.parse(document.querySelector('#runbun-run-transfer').value);
		return window.RunBunAttemptStore.validateBundle(bundle);
	}), true);
	await page.click('#runbun-run-import');
	await page.waitForFunction(() => /Imported checked attempt archive/.test(
		document.querySelector('#runbun-run-status').textContent), null, {timeout: 10000});
	assert.equal((await durableHead(page)).revision, 1, 'duplicate import preserves the durable head');

	assert.deepEqual(session.errors, [], `page raised errors: ${session.errors.join('; ')}`);
	await session.context.close();
});

test('a v1 browser database upgrades in place before the next command', {skip}, async () => {
	const session = await open();
	const page = session.page;
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	const head = await durableHead(page);

	await page.evaluate(async oldHead => {
		const name = window.RunBunAttemptStore.DB_NAME;
		await new Promise((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = resolve;
			request.onerror = () => reject(request.error);
			request.onblocked = () => reject(new Error('legacy database deletion was blocked'));
		});
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.onupgradeneeded = () => {
				const created = request.result;
				created.createObjectStore('heads', {keyPath: 'attemptId'});
				created.createObjectStore('events', {keyPath: 'id'});
				created.createObjectStore('snapshots', {keyPath: 'id'});
				created.createObjectStore('idempotency', {keyPath: 'id'});
				created.createObjectStore('archives', {keyPath: 'archiveId'});
				created.createObjectStore('meta', {keyPath: 'key'});
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await new Promise((resolve, reject) => {
			const tx = db.transaction(['heads', 'events', 'snapshots', 'idempotency', 'meta'], 'readwrite');
			const id = oldHead.attemptId;
			const legacyEvent = {id: id + ':1', attemptId: id, revision: 1,
				commandId: 'legacy-start', kind: 'run.started', payload: {run: oldHead.run},
				observedAt: oldHead.run.createdAt, previousStateHash: null,
				stateHash: oldHead.stateHash};
			tx.objectStore('heads').put({attemptId: id, revision: 1,
				run: oldHead.run, stateHash: oldHead.stateHash});
			tx.objectStore('events').put(legacyEvent);
			tx.objectStore('snapshots').put({id: id + ':1', attemptId: id,
				revision: 1, run: oldHead.run, stateHash: oldHead.stateHash});
			tx.objectStore('idempotency').put({id: id + '::legacy-start', attemptId: id,
				commandId: 'legacy-start', fingerprint: 'legacy', revision: 1,
				run: oldHead.run, event: legacyEvent, stateHash: oldHead.stateHash});
			tx.objectStore('meta').put({key: 'activeAttemptId', value: id});
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, head);

	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 15000});
	await openAllSections(page);
	await page.fill('#runbun-run-acquire-item', 'Potion');
	await page.click('#runbun-run-acquire');
	await page.waitForFunction(async () => {
		const active = await window.RunBunAttemptStore.getDefault().loadActive();
		return active && active.revision === 2;
	}, null, {timeout: 15000});
	const upgraded = await page.evaluate(async () => {
		const store = window.RunBunAttemptStore.getDefault();
		const bundle = await store.exportActive();
		return {bundle, valid: await store.validateBundle(bundle)};
	});
	assert.equal(upgraded.valid, true);
	assert.equal(upgraded.bundle.modelVersion, '2.0.0');
	assert.equal(upgraded.bundle.events[0].source.kind, 'migration');
	assert.equal(upgraded.bundle.events[1].source.kind, 'manual');
	assert.equal(upgraded.bundle.events[1].previousEventHash,
		upgraded.bundle.events[0].eventHash);
	assert.deepEqual(session.errors, []);
	await session.context.close();
});

test('a catch that could not have happened is refused and changes nothing', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});

	const before = JSON.stringify(await savedRun(page));

	await page.fill('#runbun-run-catch-species', 'Ralts');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => /does not appear on/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});

	// The refusal is the feature: it names the route's real roster.
	const message = await page.textContent('#runbun-run-status');
	assert.match(message, /Ralts does not appear on Route 101; it holds: Lillipup/);
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');
	assert.equal(await page.$$eval('#runbun-run-box .runbun-run-mon', els => els.length), 1,
		'only the starter stands');
	// And the save is untouched, not rolled back after the fact.
	assert.equal(JSON.stringify(await savedRun(page)), before, 'a refusal wrote to the save');

	await session.context.close();
});

test('the run survives a reload, because a playthrough that does not is not one', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Persisted');
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});

	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 15000});
	assert.equal(await page.textContent('#runbun-run-name'), 'Persisted');
	assert.match(await page.textContent('.runbun-run-mon[data-id="mon-2"] .runbun-run-mon-name'), /Poochyena/);

	await session.context.close();
});

test('undo rewinds the saved run one command', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});

	// Export first. That text is the run WITH the catch in it, so leaving it in
	// the box after an undo leaves a silent redo one click away.
	await page.click('.runbun-run-transfer summary');
	await page.click('#runbun-run-export');
	await page.waitForFunction(
		() => /Poochyena/.test(document.querySelector('#runbun-run-transfer').value),
		null, {timeout: 10000});
	assert.match(await page.inputValue('#runbun-run-transfer'), /Poochyena/);

	await page.click('#runbun-run-undo');
	// The undo pops the catch; the starter (the run's first command) stands.
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	const state = await savedRun(page);
	assert.equal(state.box.length, 1);
	assert.equal(state.log.length, 1);
	assert.equal(await page.inputValue('#runbun-run-transfer'), '',
		'the export that still holds the undone catch outlived the undo');

	await session.context.close();
});

test('a pasted run the server cannot read is refused, and the save survives it', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Keeper');
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	// The first status render is what finishes the save; compare only after it.
	await page.waitForFunction(
		() => /Keeper/.test(document.querySelector('#runbun-run-name').textContent),
		null, {timeout: 15000});
	const before = await page.evaluate(() => window.localStorage.getItem('runbun.run.v1'));

	await page.click('.runbun-run-transfer summary');
	// This clears every check the panel could make on its own — it parses, it is
	// an object, it carries a version — and it is still not a run. Only the
	// server can tell the difference, so only the server gets to decide.
	await page.fill('#runbun-run-transfer', '{"version":1}');
	await page.click('#runbun-run-import');
	await page.waitForFunction(
		() => /^Could not import:/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');

	// Byte for byte. A paste the server refused is a refusal like any other, and
	// this one used to overwrite the save permanently — reload included.
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), before,
		'a refused import wrote to the save');
	assert.equal(await page.textContent('#runbun-run-name'), 'Keeper');
	assert.equal(await page.isVisible('#runbun-run-empty'), false,
		'the refused import should not have taken the run off screen');

	// And the panel is still a panel: the run it holds is the one it always
	// held, and the in-flight guard released when the import failed.
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	assert.equal((await savedRun(page)).name, 'Keeper');

	assert.deepEqual(session.errors, [], `page raised errors: ${session.errors.join('; ')}`);
	await session.context.close();
});

test('a damaged save is handed back for repair, not quietly replaced', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// A write that was cut off half way — quota, a closed tab. The panel used to
	// swallow the parse error and treat the browser as empty, and the next
	// "Start a run" wrote over the only copy the player had.
	const damaged = '{"version":1,"name":"Half a run","box":[{"id":"mon-1","spec';
	await page.evaluate(raw => window.localStorage.setItem('runbun.run.v1', raw), damaged);
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForFunction(
		() => /damaged/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 15000});
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');
	// Handed back verbatim, in an open box: recovery by hand is the only recovery
	// there is, and it needs the text.
	assert.equal(await page.inputValue('#runbun-run-transfer'), damaged);

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForFunction(
		() => /starting a run would write over it/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), damaged,
		'starting a run wrote over a save the player had not dealt with');

	// Clearing the box IS dealing with it, and then a run starts as usual.
	// (The starter is still pressed from the blocked attempt — pressing it
	// again would clear the pick.)
	await page.fill('#runbun-run-transfer', '');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.waitForFunction(
		() => /"box"/.test(window.localStorage.getItem('runbun.run.v1') || ''),
		null, {timeout: 15000});

	await session.context.close();
});

test('a turn that resolves after its fight is gone is dropped, not thrown', {skip}, async () => {
	const session = await open();
	const page = session.page;
	await page.waitForFunction(() => {
		const button = document.querySelector('#runbun-run-new');
		const events = button && window.jQuery && window.jQuery._data(button, 'events');
		return events && events.click;
	});
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.click('#runbun-run-box .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(() =>
		/takes the lead/.test(document.querySelector('#runbun-run-status').textContent));
	// Slow the turn down so the abandon lands while it is in flight, and COUNT
	// the turns. The staging check below used to be `!!cleared` — that the
	// abandon button exists in the DOM — which is true whether or not a turn
	// was ever sent. Guarding the move click with an early return, so no
	// request is issued at all and the race is physically impossible, left
	// this test green.
	let actRequests = 0;
	let turnIsInFlight;
	const inFlight = new Promise(resolve => { turnIsInFlight = resolve; });
	await page.route('**/run/battle/act', async route => {
		actRequests += 1;
		turnIsInFlight();
		await new Promise(resolve => setTimeout(resolve, 1200));
		await route.continue();
	});
	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])');
	await page.waitForSelector('.runbun-run-battle-move');
	// Fire the turn and abandon it in the SAME task, so the abandon lands
	// while the act request is still in flight — the exact sequence that
	// used to surface a raw TypeError when the reply came back.
	await page.evaluate(() => {
		document.querySelector('.runbun-run-battle-move').click();
		document.querySelector('#runbun-run-battle-abandon').click();
	});
	// The turn really went out, and the fight really was abandoned under it.
	// Both halves have to be true or there is no race to survive.
	await sentWithin(inFlight, 'no turn was ever sent — nothing is being raced');
	assert.equal(actRequests, 1,
		'a turn must actually have been in flight — otherwise nothing is being raced');
	await page.waitForFunction(
		() => document.querySelector('#runbun-run-battle').hidden,
		null, {timeout: 5000});

	await page.waitForTimeout(3000);

	// POSITIVE outcome, not the absence of three hardcoded V8 phrases. The old
	// check missed anything worded differently — "x is not a function" walks
	// straight past /Cannot set properties|Cannot read propert|undefined is not/.
	// session.errors collects every uncaught pageerror, so this catches the
	// whole class rather than three spellings of it.
	assert.deepEqual(session.errors, [],
		'a late turn must not surface any JavaScript error to the player');
	// And the panel is genuinely back to the run, not wedged mid-fight.
	assert.equal(await page.isHidden('#runbun-run-battle'), true,
		'the abandoned fight stays closed when its late reply lands');
	assert.ok(await page.isVisible('#runbun-run-live'),
		'and the run is answerable again');

	// The reply must be dropped SILENTLY. Two guards drop it — one on the
	// success path, one on the failure path — and they fail differently, so
	// both surfaces have to be checked or one mutation hides behind the other:
	//
	//   success guard gone   battle is non-null, the stale reply repaints and
	//                        re-opens the panel — the isHidden check above
	//   BOTH guards gone     battle is null, the assignment throws, and the
	//                        catch writes the failure to the result and status
	//                        lines. Nothing is thrown to the page and the panel
	//                        stays shut, so only THIS check sees it.
	assert.notEqual(await page.getAttribute('#runbun-run-battle-result', 'data-kind'), 'error',
		'a dropped turn must not report itself as a failed one');
	assert.doesNotMatch(await page.textContent('#runbun-run-battle-result'),
		/did not resolve/,
		'the player never asked for this turn any more — it must not be mentioned');
	await session.context.close();
});

test('a late turn never lands on the fight that replaced it', {skip}, async () => {
	// The success-path guard, isolated.
	//
	// The abandon-race test above cannot see it: there the reply arrives with
	// no fight at all, so `battle` is null, the assignment throws, and the
	// CATCH guard drops it. Either guard alone suffices, which is why removing
	// either one alone left that test green — the auditor's exact finding.
	//
	// `battle.bundle !== actedOn` is not really about null. It is about the
	// reply belonging to a DIFFERENT fight, and that only happens when a new
	// one has started underneath it. Then the success path runs to completion
	// and writes another battle's state over the live one.
	const session = await open();
	const page = session.page;
	await page.waitForFunction(() => {
		const button = document.querySelector('#runbun-run-new');
		const events = button && window.jQuery && window.jQuery._data(button, 'events');
		return events && events.click;
	});
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.click('#runbun-run-box .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(() =>
		/takes the lead/.test(document.querySelector('#runbun-run-status').textContent));

	// Only the FIRST turn is slowed, so the second fight is live and settled
	// by the time the first one's reply comes back.
	let acts = 0;
	await page.route('**/run/battle/act', async route => {
		acts += 1;
		if (acts === 1) await new Promise(resolve => setTimeout(resolve, 1500));
		await route.continue();
	});

	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])');
	await page.waitForSelector('.runbun-run-battle-move');
	const firstFoe = await page.textContent('#runbun-run-battle-foe-name');

	// Fire the slow turn, abandon, and immediately open a NEW fight.
	await page.evaluate(() => {
		document.querySelector('.runbun-run-battle-move').click();
		document.querySelector('#runbun-run-battle-abandon').click();
	});
	await page.waitForFunction(() => document.querySelector('#runbun-run-battle').hidden);
	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])');
	await page.waitForSelector('.runbun-run-battle-move');
	assert.equal(acts, 1, 'exactly one turn is in flight, and it belongs to the old fight');

	const secondFoe = await page.textContent('#runbun-run-battle-foe-name');
	// The LOG is the discriminator, not the opponent's name: both fights are
	// the same trainer, so the name is identical either way and asserting on
	// it proves nothing. The new fight is fresh and has no turns in it; the
	// stale reply carries the old fight's events, and paintBattle APPENDS
	// them, so a repaint shows up here and nowhere else.
	const freshLog = await page.$$eval('#runbun-run-battle-log li', rows => rows.length);
	await page.waitForTimeout(3000);

	// The old fight's reply has landed by now. It must have changed nothing.
	assert.deepEqual(session.errors, [], 'a stale reply must not throw');
	assert.ok(await page.isVisible('#runbun-run-battle'),
		'the NEW fight is still open — the stale reply did not close it');
	assert.equal(await page.$$eval('#runbun-run-battle-log li', rows => rows.length), freshLog,
		'the abandoned fight\'s turn must not be written into the fight that replaced it');
	assert.equal(await page.textContent('#runbun-run-battle-foe-name'), secondFoe,
		'and the new fight still shows its own opponent');
	assert.notEqual(await page.getAttribute('#runbun-run-battle-result', 'data-kind'), 'error',
		'nor report the abandoned turn as a failure');
	void firstFoe;
	await session.context.close();
});

test('a turn that FAILS after its fight is gone is dropped too', {skip}, async () => {
	// The catch-path guard, isolated.
	//
	// The two tests above cannot see it. In both, the request succeeds, so the
	// success path runs and its own guard is enough to drop the reply — remove
	// only the catch guard and nothing changes. The catch path only runs when
	// the turn genuinely fails, and then its guard is the ONLY thing standing
	// between a dead fight and an error message about it.
	const session = await open();
	const page = session.page;
	await page.waitForFunction(() => {
		const button = document.querySelector('#runbun-run-new');
		const events = button && window.jQuery && window.jQuery._data(button, 'events');
		return events && events.click;
	});
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.click('#runbun-run-box .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(() =>
		/takes the lead/.test(document.querySelector('#runbun-run-status').textContent));

	// The turn goes out and then FAILS, slowly enough to be abandoned first.
	let attempted = 0;
	let turnIsInFlight;
	const inFlight = new Promise(resolve => { turnIsInFlight = resolve; });
	await page.route('**/run/battle/act', async route => {
		attempted += 1;
		turnIsInFlight();
		await new Promise(resolve => setTimeout(resolve, 1200));
		await route.abort('failed');
	});

	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])');
	await page.waitForSelector('.runbun-run-battle-move');
	await page.evaluate(() => {
		document.querySelector('.runbun-run-battle-move').click();
		document.querySelector('#runbun-run-battle-abandon').click();
	});
	await sentWithin(inFlight, 'no turn was ever sent — the catch path is untested');
	assert.equal(attempted, 1, 'a turn must actually have been in flight');
	await page.waitForFunction(() => document.querySelector('#runbun-run-battle').hidden);
	await page.waitForTimeout(3000);

	// The failure belongs to a fight the player already walked away from.
	// Telling them about it is the bug.
	assert.notEqual(await page.getAttribute('#runbun-run-battle-result', 'data-kind'), 'error',
		'an abandoned fight must not report its dead turn as a failure');
	assert.doesNotMatch(await page.textContent('#runbun-run-battle-result'), /did not resolve/,
		'nor put the failure text on screen');
	assert.doesNotMatch(await page.textContent('#runbun-run-status'), /did not resolve|failed/i,
		'nor in the run status line');
	assert.ok(await page.isVisible('#runbun-run-live'), 'the run is answerable again');
	await session.context.close();
});

test('a change asked for while another is in flight is refused, not merged', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});

	// Held open long enough that a second click lands while the first call is
	// still out. Both would post the same base run, and whichever replied last
	// would be persisted over the other — losing a command the player was told
	// had happened.
	await page.route('**/run/apply', async route => {
		await new Promise(resolve => setTimeout(resolve, 1500));
		await route.continue();
	});

	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	// Deterministic mid-flight click, immune to machine speed on both
	// sides: wait for the synchronous 'Working…' marker so the flight has
	// begun, then click programmatically — page.click's actionability wait
	// would idle on the busy-disabled button until the flight ends.
	await page.waitForFunction(
		() => /Working/.test(document.querySelector('#runbun-run-status').textContent));
	await page.evaluate(() => document.querySelector('#runbun-run-undo').click());
	// Refused out loud: a button that quietly does nothing reads as broken.
	assert.match(await page.textContent('#runbun-run-status'), /One change at a time/);
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');

	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 15000});
	const saved = await savedRun(page);
	assert.equal(saved.box.length, 2, 'the catch that was in flight still has to land');
	assert.equal(saved.log.length, 2, 'the refused undo must not have run behind it');

	await session.context.close();
});

test('two tabs are one run: a catch in one appears in the other', {skip}, async () => {
	// The save lives in localStorage, so a phone next to the emulator and a
	// desktop tab were ALWAYS the same run — but each tab only read it at load,
	// and the staler one would overwrite the other's catches on its next
	// command. The storage event is the missing half.
	const session = await open();
	const first = session.page;
	const second = await session.context.newPage();
	await second.goto(`${harness.baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await second.waitForSelector('#runbun-run');

	await first.click('.runbun-run-starter[data-species="Turtwig"]');
	await first.click('#runbun-run-new');
	await first.waitForSelector('#runbun-run-live:not([hidden])');
	// The other tab hears the write and shows the run without a reload.
	await second.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 10000});

	await first.click('.rb-disclose[data-section="catch"] .rb-disclose-btn');
	await first.waitForSelector('#runbun-run-roll', {state: 'visible', timeout: 5000});
	await selectManualMap(first, 'Route101');
	await first.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await first.fill('#runbun-run-catch-species', 'Poochyena');
	await first.fill('#runbun-run-catch-level', '3');
	await first.click('#runbun-run-catch');

	await second.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	assert.match(await second.textContent('#runbun-run-status'), /Synced/,
		'the second tab should say where the change came from');

	await session.context.close();
});
