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
main{display:block;height:auto;max-width:980px;margin:0 auto;padding:12px 16px}#overview{width:100%;margin:0 0 10px}#overview tr{cursor:pointer}#overview tr[aria-current=true] td{font-weight:600}#overview td,#overview th{padding:3px 10px 3px 0}.compact .events,.compact .turn table{display:none}.runs button{margin:0 6px 6px 0}.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--win);margin-right:6px;animation:p 1s infinite}.done .pulse,.lost .pulse{background:var(--mute);animation:none}@keyframes p{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.pulse{animation:none}}</style></head><body>
<header><h1 id="title">Live run</h1><p id="sub">waiting for a fight…</p></header>
<main><table id="overview"></table><div class="filters" id="controls"></div><div class="filters" id="tagbar"></div><div class="speed" id="six"></div><div id="turns"></div></main>
<script>
const HOT = new Set(['speed-control','status','set-up','sack','pivot','search-overrode','screen','hazard','disrupt','priority','sacrifice-forced','sacrifice-chosen']);
const WARN = new Set(['they-move-first','coin-flip','we-fall','foe-set-up','foe-recovered','crit-theirs','sacrifice-unforced']);
let current = null, seen = -1, attempt = null;
const el = (tag, attrs, kids) => { const n = document.createElement(tag); for (const k in (attrs||{})) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'on') for (const e in attrs.on) n.addEventListener(e, attrs.on[e]); else n.setAttribute(k, attrs[k]); } for (const kid of (kids||[])) n.appendChild(kid); return n; };
const bar = (pct, foe) => el('span', {class: 'bar' + (foe ? ' foe' : '')}, [el('i', {style: 'width:' + Math.max(0, Math.min(100, pct)) + '%'})]);
function card(t) {
  const c = el('div', {class: 'turn'});
  c.appendChild(el('div', {class: 'head'}, [el('b', {text: 'T' + t.turn}), el('span', {}, [document.createTextNode(t.us + ' '), bar(t.usHp), document.createTextNode(' ' + t.usHp + '%')]), el('span', {class: 'sub', text: 'vs'}), el('span', {}, [document.createTextNode(t.foe + ' '), bar(t.foeHp, true), document.createTextNode(' ' + t.foeHp + '%')]), el('span', {class: 'chosen', text: '→ ' + t.chose}), el('span', {class: 'sub', text: t.why || ''})]));
  const tags = el('div'); for (const tag of t.tags) tags.appendChild(el('span', {class: 'tag' + (HOT.has(tag) ? ' hot' : WARN.has(tag) ? ' warn' : ''), text: tag})); c.appendChild(tags);
  const ev = el('ul', {class: 'events'}); for (const e of t.events) ev.appendChild(el('li', {text: e})); c.appendChild(ev);
  const scores = (t.scores || []).slice().sort((a, b) => b.value - a.value);
  if (scores.length) { const tbl = el('table'); tbl.appendChild(el('tr', {}, ['the search weighed', 'value', 'playouts won', 'their HP removed', 'ours left standing', 'material lead'].map(h => el('th', {text: h})))); for (const s of scores) tbl.appendChild(el('tr', {class: s.choice === t.chose ? 'chosen' : ''}, [s.choice, String(s.value), s.wins === undefined ? String(s.runs) + ' run' : s.wins + ' of ' + s.runs, s.removed === undefined ? '' : Math.round(s.removed * 100) + '%', s.oursAlive === undefined ? '' : String(s.oursAlive), s.lead === undefined ? '' : (s.lead > 0 ? '+' : '') + s.lead].map(v => el('td', {text: v})))); c.appendChild(tbl); }
  return c;
}
const prefs = (() => { try { return JSON.parse(localStorage.getItem('live-prefs') || '{}'); } catch (e) { return {}; } })();
const keep = () => { try { localStorage.setItem('live-prefs', JSON.stringify(prefs)); } catch (e) { /* a page that cannot remember still works */ } };
let following = prefs.following !== false, tagFilter = prefs.tag || null, held = [];
function controls() {
  const box = document.getElementById('controls'); box.replaceChildren();
  const toggle = (label, on, flip) => box.appendChild(el('button', {'aria-pressed': String(on), text: label, on: {click: () => { flip(); keep(); controls(); }}}));
  toggle(following ? 'following the fight' : 'paused — ' + held.length + ' new turn' + (held.length === 1 ? '' : 's') + ' waiting', following, () => { following = !following; prefs.following = following; if (following) flush(); });
  toggle('compact', !!prefs.compact, () => { prefs.compact = !prefs.compact; document.body.classList.toggle('compact', !!prefs.compact); });
  document.body.classList.toggle('compact', !!prefs.compact);
}
function tagbar(tags) {
  const box = document.getElementById('tagbar'); box.replaceChildren();
  for (const tag of tags) box.appendChild(el('button', {'aria-pressed': String(tagFilter === tag), text: tag, on: {click: () => { tagFilter = tagFilter === tag ? null : tag; prefs.tag = tagFilter; keep(); redraw(); }}}));
}
let shown = [];
function redraw() { const box = document.getElementById('turns'); box.replaceChildren(); for (const t of shown) if (!tagFilter || t.tags.includes(tagFilter)) box.prepend(card(t)); tagbar([...new Set(shown.flatMap(t => t.tags))].sort()); }
function flush() { shown = shown.concat(held); held = []; redraw(); }
async function runs() {
  const rows = await (await fetch('/overview')).json(); const table = document.getElementById('overview'); table.replaceChildren();
  table.appendChild(el('tr', {}, ['run', 'fight', 'facing', 'attempt', 'played by', 'turn', ''].map(h => el('th', {text: h}))));
  for (const r of rows) table.appendChild(el('tr', {'aria-current': String(r.run === current), on: {click: () => { current = r.run; seen = -1; attempt = null; shown = []; held = []; redraw(); runs(); }}},
    [r.run, r.fight === null ? '—' : '#' + r.fight + ' @' + r.position, r.trainer || 'not started', r.attempt === null ? '' : String(r.attempt), r.hand || '', String(r.turn), r.ended ? r.ended : 'playing'].map((v, i) => el('td', {class: i === 6 ? (r.ended === 'win' ? 'win' : r.ended ? 'loss' : 'sub') : '', text: v}))));
  if (!current && rows.length) { current = rows[0].run; runs(); }
}
async function tick() {
  if (!current) return;
  const s = await (await fetch('/state?run=' + encodeURIComponent(current))).json();
  if (!s.header) return;
  const key = s.header.n + ':' + s.header.attempt;
  if (key !== attempt) { attempt = key; seen = -1; shown = []; held = []; redraw(); }
  document.body.className = s.ended ? 'done' : '';
  document.getElementById('title').replaceChildren(el('span', {class: 'pulse'}), document.createTextNode(s.header.trainer + ' — attempt ' + s.header.attempt));
  document.getElementById('sub').textContent = 'fight ' + s.header.n + ' of the run · position ' + s.header.position + ' · played by ' + s.header.hand + (s.ended ? ' · ' + s.ended.toUpperCase() : ' · turn ' + (s.turns.length ? s.turns[s.turns.length - 1].turn : 0));
  document.getElementById('six').textContent = 'Our six: ' + s.header.six.map(m => m.name + ' the ' + m.species + (m.item ? ' @ ' + m.item : '')).join(' · ');
  const fresh = s.turns.slice(seen + 1);
  seen = s.turns.length - 1;
  if (fresh.length) { if (following) { shown = shown.concat(fresh); redraw(); } else { held = held.concat(fresh); controls(); } }
}
// A server that is down is a state to show, not an error to throw every second.
const quiet = fn => () => fn().then(() => { document.body.classList.remove('lost'); }, () => { document.body.classList.add('lost'); document.getElementById('sub').textContent = 'the watcher is not answering — is it still running?'; });
controls(); quiet(runs)(); setInterval(quiet(runs), 3000); setInterval(quiet(tick), 1000);
</script></body></html>`;

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
	const hit = argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? undefined : hit.slice(name.length + 3);
};

/**
 * Every run being written under `dir`: its own, and one level down, so the
 * watcher can be pointed at `ui-playthrough-out/runs` and follow every batch.
 * Most recently written first — the fight worth watching is the live one.
 */
export const listRuns = async (dir: string): Promise<ReadonlyArray<string>> => {
	const found: Array<{name: string; at: number}> = [];
	const scan = async (folder: string, prefix: string, deeper: boolean): Promise<void> => {
		for (const entry of await fs.readdir(folder, {withFileTypes: true})) {
			if (entry.isDirectory() && deeper && !entry.name.startsWith('.')) await scan(path.join(folder, entry.name), entry.name + '/', false);
			else if (entry.isFile() && entry.name.endsWith('.live.ndjson')) {
				const stat = await fs.stat(path.join(folder, entry.name));
				found.push({name: prefix + entry.name.replace(/\.live\.ndjson$/, ''), at: stat.mtimeMs});
			}
		}
	};
	await scan(dir, '', true);
	return found.sort((a, b) => b.at - a.at).map(entry => entry.name);
};

export const serve = (dir: string, port: number): http.Server => {
	const send = (res: http.ServerResponse, type: string, body: string): void => {
		res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'});
		res.end(body);
	};
	return http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === '/runs') {
			void listRuns(dir).then(names => send(res, 'application/json', JSON.stringify(names)),
				() => send(res, 'application/json', '[]'));
			return;
		}
		if (url.pathname === '/overview') {
			// Every run's current fight in one answer, so six runs can be read at a glance.
			void listRuns(dir).then(names => Promise.all(names.map(name =>
				Effect.runPromise(readLive(path.join(dir, name + '.live.ndjson'))).then(state => ({run: name,
					trainer: state.header?.trainer ?? null, fight: state.header?.n ?? null, attempt: state.header?.attempt ?? null,
					position: state.header?.position ?? null, hand: state.header?.hand ?? null,
					turn: state.turns.length ? state.turns[state.turns.length - 1]?.turn ?? 0 : 0, ended: state.ended})))))
				.then(rows => send(res, 'application/json', JSON.stringify(rows)), () => send(res, 'application/json', '[]'));
			return;
		}
		if (url.pathname === '/state') {
			// A run is named LABEL/run-SEED (or run-SEED); anything else is refused,
			// so the name can never walk out of the directory being watched.
			const run = url.searchParams.get('run') ?? '';
			if (!/^([A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(run) || run.includes('..')) { res.writeHead(400); res.end('bad run name'); return; }
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
