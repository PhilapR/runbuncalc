/**
 * Watch a run while it plays.
 *
 *   node dist/src/serve.js --dir=ui-playthrough-out/runs/LABEL [--port=4173]
 *
 * scripts/run-one.js writes `run-SEED.live.ndjson` beside each run: the CURRENT
 * attempt only — a header line, then one line a turn the moment it is decided,
 * then an end line (lib/fight-log.js liveTape). This serves a page that polls
 * it once a second and shows the fight growing: who faces whom, what was
 * chosen, every option that was on the screen, and what the rollout search
 * thought of each — which is the search being watched, not reported on.
 *
 * It reads files and serves them. It cannot start, stop or steer a run.
 */
import {Effect, Schema} from 'effect';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import {Turn} from './schema.js';
import {tagsOf} from './tags.js';
import {STYLE} from './viewer.js';

const Header = Schema.Struct({kind: Schema.Literal('attempt'), at: Schema.Number, n: Schema.Number,
	trainer: Schema.String, order: Schema.Number, attempt: Schema.Number, position: Schema.Number,
	hand: Schema.String, runSeed: Schema.optional(Schema.Number),
	six: Schema.Array(Schema.Struct({name: Schema.String, species: Schema.String, level: Schema.Number,
		item: Schema.NullOr(Schema.String)}))});
const TurnLine = Schema.extend(Schema.Struct({kind: Schema.Literal('turn')}), Turn);
const End = Schema.Struct({kind: Schema.Literal('end'), at: Schema.Number, result: Schema.String});
const Line = Schema.Union(Header, TurnLine, End);
const decodeLine = Schema.decodeUnknown(Line);

export interface LiveState {
	readonly header: typeof Header.Type | null;
	readonly turns: ReadonlyArray<typeof Turn.Type & {readonly tags: ReadonlyArray<string>}>;
	readonly ended: string | null;
}

/** The current attempt, off its live file. A line torn mid-write is skipped: the next poll has it whole. */
export const readLive = (file: string): Effect.Effect<LiveState, never> =>
	Effect.gen(function* () {
		const text = yield* Effect.tryPromise(() => fs.readFile(file, 'utf8')).pipe(Effect.orElseSucceed(() => ''));
		let header: typeof Header.Type | null = null;
		let ended: string | null = null;
		const turns: Array<typeof Turn.Type & {readonly tags: ReadonlyArray<string>}> = [];
		for (const raw of text.split('\n')) {
			if (raw === '') continue;
			const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown).pipe(Effect.option);
			if (parsed._tag === 'None') continue;
			const line = yield* decodeLine(parsed.value).pipe(Effect.option);
			if (line._tag === 'None') continue;
			if (line.value.kind === 'attempt') header = line.value;
			else if (line.value.kind === 'end') ended = line.value.result;
			else turns.push({...line.value, tags: tagsOf(line.value)});
		}
		return {header, turns, ended};
	});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Run</title><style>${STYLE}
main{display:block;height:auto;max-width:980px;margin:0 auto;padding:12px 16px}.runs button{margin:0 6px 6px 0}.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--win);margin-right:6px;animation:p 1s infinite}.done .pulse{background:var(--mute);animation:none}@keyframes p{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.pulse{animation:none}}</style></head><body>
<header><h1 id="title">Live run</h1><p id="sub">waiting for a fight…</p></header>
<main><div class="runs filters" id="runs"></div><div class="speed" id="six"></div><div id="turns"></div></main>
<script>
const HOT = new Set(['speed-control','status','set-up','sack','pivot','search-overrode','screen','hazard','disrupt','priority']);
const WARN = new Set(['they-move-first','coin-flip','we-fall','foe-set-up','foe-recovered','crit-theirs']);
let current = null, seen = -1, attempt = null;
const el = (tag, attrs, kids) => { const n = document.createElement(tag); for (const k in (attrs||{})) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'on') for (const e in attrs.on) n.addEventListener(e, attrs.on[e]); else n.setAttribute(k, attrs[k]); } for (const kid of (kids||[])) n.appendChild(kid); return n; };
const bar = (pct, foe) => el('span', {class: 'bar' + (foe ? ' foe' : '')}, [el('i', {style: 'width:' + Math.max(0, Math.min(100, pct)) + '%'})]);
function card(t) {
  const c = el('div', {class: 'turn'});
  c.appendChild(el('div', {class: 'head'}, [el('b', {text: 'T' + t.turn}), el('span', {}, [document.createTextNode(t.us + ' '), bar(t.usHp), document.createTextNode(' ' + t.usHp + '%')]), el('span', {class: 'sub', text: 'vs'}), el('span', {}, [document.createTextNode(t.foe + ' '), bar(t.foeHp, true), document.createTextNode(' ' + t.foeHp + '%')]), el('span', {class: 'chosen', text: '→ ' + t.chose}), el('span', {class: 'sub', text: t.why || ''})]));
  const tags = el('div'); for (const tag of t.tags) tags.appendChild(el('span', {class: 'tag' + (HOT.has(tag) ? ' hot' : WARN.has(tag) ? ' warn' : ''), text: tag})); c.appendChild(tags);
  const ev = el('ul', {class: 'events'}); for (const e of t.events) ev.appendChild(el('li', {text: e})); c.appendChild(ev);
  const scores = (t.scores || []).slice().sort((a, b) => b.value - a.value);
  if (scores.length) { const tbl = el('table'); tbl.appendChild(el('tr', {}, ['the search weighed', 'value', 'rollouts'].map(h => el('th', {text: h})))); for (const s of scores) tbl.appendChild(el('tr', {class: s.choice === t.chose ? 'chosen' : ''}, [s.choice, String(s.value), String(s.runs)].map(v => el('td', {text: v})))); c.appendChild(tbl); }
  return c;
}
async function runs() {
  const list = await (await fetch('/runs')).json(); const box = document.getElementById('runs'); box.replaceChildren();
  for (const name of list) box.appendChild(el('button', {'aria-pressed': String(name === current), text: name, on: {click: () => { current = name; seen = -1; attempt = null; document.getElementById('turns').replaceChildren(); runs(); }}}));
  if (!current && list.length) { current = list[0]; runs(); }
}
async function tick() {
  if (!current) return;
  const s = await (await fetch('/state?run=' + encodeURIComponent(current))).json();
  if (!s.header) return;
  const key = s.header.n + ':' + s.header.attempt;
  if (key !== attempt) { attempt = key; seen = -1; document.getElementById('turns').replaceChildren(); }
  document.body.className = s.ended ? 'done' : '';
  document.getElementById('title').replaceChildren(el('span', {class: 'pulse'}), document.createTextNode(s.header.trainer + ' — attempt ' + s.header.attempt));
  document.getElementById('sub').textContent = 'fight ' + s.header.n + ' of the run · position ' + s.header.position + ' · played by ' + s.header.hand + (s.ended ? ' · ' + s.ended.toUpperCase() : ' · turn ' + (s.turns.length ? s.turns[s.turns.length - 1].turn : 0));
  document.getElementById('six').textContent = 'Our six: ' + s.header.six.map(m => m.name + ' the ' + m.species + (m.item ? ' @ ' + m.item : '')).join(' · ');
  const box = document.getElementById('turns');
  for (let i = seen + 1; i < s.turns.length; i++) box.prepend(card(s.turns[i]));
  seen = s.turns.length - 1;
}
runs(); setInterval(runs, 5000); setInterval(() => tick().catch(() => {}), 1000);
</script></body></html>`;

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
	const hit = argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? undefined : hit.slice(name.length + 3);
};

export const serve = (dir: string, port: number): http.Server => {
	const send = (res: http.ServerResponse, type: string, body: string): void => {
		res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'});
		res.end(body);
	};
	return http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === '/runs') {
			void fs.readdir(dir).then(names => send(res, 'application/json', JSON.stringify(
				names.filter(name => name.endsWith('.live.ndjson')).map(name => name.replace(/\.live\.ndjson$/, '')).sort())),
			() => send(res, 'application/json', '[]'));
			return;
		}
		if (url.pathname === '/state') {
			// A run is named by the file it writes; anything that is not a bare name is refused.
			const run = url.searchParams.get('run') ?? '';
			if (!/^[A-Za-z0-9_.-]+$/.test(run)) { res.writeHead(400); res.end('bad run name'); return; }
			void Effect.runPromise(readLive(path.join(dir, run + '.live.ndjson')))
				.then(state => send(res, 'application/json', JSON.stringify(state)));
			return;
		}
		send(res, 'text/html; charset=utf-8', PAGE);
	}).listen(port, '127.0.0.1');
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	const dir = flag(process.argv, 'dir');
	if (dir === undefined) {
		process.stderr.write('usage: node dist/src/serve.js --dir=ui-playthrough-out/runs/LABEL [--port=4173]\n');
		process.exitCode = 2;
	} else {
		const port = Number(flag(process.argv, 'port') ?? '4173');
		serve(path.resolve(dir), port);
		process.stdout.write('watching ' + path.resolve(dir) + ' at http://127.0.0.1:' + port + '\n');
	}
}
