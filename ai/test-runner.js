const {readdirSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const testDirectory = path.join(__dirname, 'dist', 'test');
const testFiles = readdirSync(testDirectory)
  .filter(file => file.endsWith('.test.js'))
  .sort();

if (!testFiles.length) throw new Error(`No compiled AI fixtures found in ${testDirectory}`);

// Each fixture is an isolated child process; nothing orders them, so run a
// bounded pool sized to the machine. Output is buffered per child and replayed
// whole, so a failure stays attributable instead of interleaving.
const concurrency = Math.max(1, Math.min(os.availableParallelism(), testFiles.length));

function runOne(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(testDirectory, file)]);
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.on('error', error => resolve({file, status: 1, output: String(error)}));
    child.on('close', status => resolve({file, status, output: Buffer.concat(chunks).toString()}));
  });
}

(async () => {
  const queue = testFiles.slice();
  const results = [];
  await Promise.all(Array.from({length: concurrency}, async () => {
    let file;
    while ((file = queue.shift()) !== undefined) results.push(await runOne(file));
  }));
  let failed = 0;
  for (const result of results.sort((a, b) => a.file.localeCompare(b.file))) {
    if (result.output) process.stdout.write(result.output);
    if (result.status !== 0) {
      failed++;
      process.stderr.write(`FAIL ${result.file} (exit ${result.status})\n`);
    }
  }
  if (failed) process.exit(1);
})();
