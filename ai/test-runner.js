const {readdirSync} = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const testDirectory = path.join(__dirname, 'dist', 'test');
const testFiles = readdirSync(testDirectory)
  .filter(file => file.endsWith('.test.js'))
  .sort();

if (!testFiles.length) throw new Error(`No compiled AI fixtures found in ${testDirectory}`);

for (const file of testFiles) {
  const result = spawnSync(process.execPath, [path.join(testDirectory, file)], {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);
}
