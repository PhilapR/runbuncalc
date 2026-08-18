/* eslint-env node, es6 */
'use strict';

/**
 * Load one authored browser setdex into Node's global realm.
 *
 * The source stays a classic script because the calculator UI consumes it
 * directly. Node can evaluate that authored source at startup; the Worker
 * build replaces this module with a build-time materialized data module, so
 * no dynamic code generation crosses the Cloudflare runtime boundary.
 */

const fs = require('node:fs');
const vm = require('node:vm');

function loadSetdex(sourcePath, globalName) {
	if (global[globalName]) return global[globalName];
	const source = fs.readFileSync(sourcePath, 'utf8');
	vm.runInThisContext(source, {filename: sourcePath});
	const setdex = global[globalName];
	if (!setdex || typeof setdex !== 'object') {
		throw new Error(`${sourcePath} did not define ${globalName}`);
	}
	return setdex;
}

module.exports = {loadSetdex};
