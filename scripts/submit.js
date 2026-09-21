#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Run a heavy command inside the machine's slot pool (lib/slots.js).
 *
 *   node scripts/submit.js [--label=NAME] -- node some/script.js --its=flags
 *   node scripts/submit.js --list
 *
 * It waits for a free slot, runs the command with this terminal's stdio, and
 * frees the slot when the command ends, however it ends. run-batch and
 * battery-arms start their children through it, and so should anything run
 * by hand that plays more than a few fights: the cap only holds if the easy
 * way to start a job is also the counted way.
 *
 * The slot is held under THIS process's pid, not the child's, so a child at
 * another revision (a pinned worktree) needs to know nothing about slots.
 * SIGTERM and SIGINT are passed on, so stopping the wrapper stops the job.
 */

const childProcess = require('node:child_process');
const slots = require('../lib/slots.js');

function parse(argv) {
	const cut = argv.indexOf('--');
	const own = cut === -1 ? argv : argv.slice(0, cut);
	const label = (own.find(arg => arg.startsWith('--label=')) || '--label=').slice(8);
	return {list: own.includes('--list'), label, command: cut === -1 ? [] : argv.slice(cut + 1)};
}

function listing() {
	const rows = slots.held();
	const used = rows.filter(row => row.pid).length;
	return [used + ' of ' + rows.length + ' slots held (' + slots.slotsDir() + ')']
		.concat(rows.filter(row => row.pid).map(row => '  ' + row.slot + '  pid ' + row.pid + '  ' +
			Math.round((Date.now() - row.at) / 60000) + ' min  ' + (row.label || '')));
}

async function main() {
	const todo = parse(process.argv.slice(2));
	if (todo.list) {
		process.stdout.write(listing().join('\n') + '\n');
		return;
	}
	if (!todo.command.length) {
		process.stderr.write('usage: node scripts/submit.js [--label=NAME] -- COMMAND [ARGS...]\n       node scripts/submit.js --list\n');
		process.exit(2);
	}
	const label = todo.label || todo.command.slice(0, 3).join(' ').slice(0, 80);
	const slot = await slots.acquire({label}, {onWait: rows =>
		process.stderr.write('submit: all ' + rows.length + ' slots held, waiting for one\n')});
	const child = childProcess.spawn(todo.command[0], todo.command.slice(1), {stdio: 'inherit'});
	for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
	child.on('error', error => {
		slot.release();
		process.stderr.write('submit: ' + error.message + '\n');
		process.exit(127);
	});
	child.on('exit', (code, signal) => {
		slot.release();
		process.exit(signal ? 1 : code);
	});
}

if (require.main === module) main();

module.exports = {parse, listing};
