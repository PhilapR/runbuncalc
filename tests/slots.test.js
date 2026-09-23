/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const SUBMIT = path.join(__dirname, '..', 'scripts', 'submit.js');

function pool(count) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-'));
	process.env.RUNBUN_SLOTS_DIR = dir;
	process.env.RUNBUN_SLOTS = String(count);
	return dir;
}

test('the pool hands out its slots and no more, and a released one comes back', () => {
	pool(2);
	const slots = require('../lib/slots.js');
	const a = slots.tryAcquire({label: 'a'});
	const b = slots.tryAcquire({label: 'b'});
	assert.ok(a && b && a.slot !== b.slot);
	assert.equal(slots.tryAcquire({label: 'c'}), null, 'a third job waits: the cap is the point');
	assert.deepEqual(slots.held().map(row => row.label), ['a', 'b']);
	a.release();
	const c = slots.tryAcquire({label: 'c'});
	assert.ok(c, 'a released slot is taken again');
	assert.equal(c.slot, a.slot);
	b.release();
	c.release();
	assert.equal(slots.held().filter(row => row.pid).length, 0);
});

test('a slot whose owner died is reaped, so a killed job never leaks one', () => {
	const dir = pool(1);
	const slots = require('../lib/slots.js');
	// A pid that has certainly exited: a child that already ended.
	const gone = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
	fs.writeFileSync(path.join(dir, '0.lock'), JSON.stringify({pid: Number(gone.stdout), label: 'killed', at: Date.now()}));
	assert.equal(slots.held()[0].pid, null, 'a dead owner reads as free');
	const got = slots.tryAcquire({label: 'next'});
	assert.ok(got, 'and its slot is taken over');
	got.release();
	// A LIVING owner is never reaped.
	fs.writeFileSync(path.join(dir, '0.lock'), JSON.stringify({pid: process.ppid, label: 'living', at: Date.now()}));
	assert.equal(slots.tryAcquire({label: 'thief'}), null);
	fs.unlinkSync(path.join(dir, '0.lock'));
});

test('submit runs commands one at a time through a pool of one, and passes the exit code on', async () => {
	const dir = pool(1);
	const stamps = path.join(dir, 'stamps.txt');
	const job = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(stamps)},'start\\n');` +
		`setTimeout(()=>{fs.appendFileSync(${JSON.stringify(stamps)},'end\\n')},300)`;
	const run = () => new Promise(resolve => childProcess.spawn(process.execPath,
		[SUBMIT, '--label=gate', '--', process.execPath, '-e', job], {stdio: 'ignore', env: process.env})
		.on('exit', resolve));
	const codes = await Promise.all([run(), run(), run()]);
	assert.deepEqual(codes, [0, 0, 0]);
	assert.deepEqual(fs.readFileSync(stamps, 'utf8').trim().split('\n'),
		['start', 'end', 'start', 'end', 'start', 'end'], 'no two jobs ever overlapped');
	assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.lock')).length, 0, 'every slot was given back');
	const failed = childProcess.spawnSync(process.execPath, [SUBMIT, '--', process.execPath, '-e', 'process.exit(7)'], {env: process.env});
	assert.equal(failed.status, 7);
});
