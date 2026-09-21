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
 * Beside the fight it shows each run's own status file (pid, pace, memory:
 * scripts/run-one.js) and the machine's slot pool (lib/slots.js). It has three
 * verbs and no more, the ones scripts/runs.js has: STOP writes the run's
 * control file, which the run reads between fights, checkpoints and exits;
 * PAUSE and CONTINUE signal the pid the status file names. It never starts a
 * process and never finds one by pattern. It listens on 127.0.0.1 only, and a
 * control request must carry a header no cross-site form can send.
 */
import {Effect, Schema} from 'effect';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {decodeEnded, decodePlaying, fleetOf, fromEnded, fromPlaying, summariseRun, type RunSummary} from './profile.js';
import {Turn} from './schema.js';
import {tagsOf} from './tags.js';
import {STYLE} from './viewer.js';

const Header = Schema.Struct({kind: Schema.Literal('attempt'), at: Schema.Number, n: Schema.Number,
	trainer: Schema.String, order: Schema.Number, attempt: Schema.Number, position: Schema.Number,
	hand: Schema.String, runSeed: Schema.optional(Schema.Number),
	road: Schema.optional(Schema.NullOr(Schema.Number)), roadOf: Schema.optional(Schema.NullOr(Schema.Number)),
	six: Schema.Array(Schema.Struct({name: Schema.String, species: Schema.String, level: Schema.Number,
		item: Schema.NullOr(Schema.String)}))});
const TurnLine = Schema.extend(Schema.Struct({kind: Schema.Literal('turn')}), Turn);
const End = Schema.Struct({kind: Schema.Literal('end'), at: Schema.Number, result: Schema.String});
const Line = Schema.Union(Header, TurnLine, End);
const decodeLine = Schema.decodeUnknown(Line);

const Status = Schema.Struct({pid: Schema.Number, seed: Schema.Number, state: Schema.String,
	position: Schema.NullOr(Schema.Number), fights: Schema.Number, attempts: Schema.optional(Schema.Number),
	startedAt: Schema.Number, updatedAt: Schema.Number, spec: Schema.optional(Schema.String),
	secondsPerFight: Schema.NullOr(Schema.Number), rssMb: Schema.Number});
export type Status = typeof Status.Type;
const decodeStatus = Schema.decodeUnknown(Status);

const alive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** A run's status, with what its process is doing NOW: running over a dead pid is a run that was killed. */
export const readStatus = (file: string): Effect.Effect<Status | null, never> =>
	Effect.tryPromise(() => fs.readFile(file, 'utf8')).pipe(
		Effect.flatMap(text => Effect.try(() => JSON.parse(text) as unknown)),
		Effect.flatMap(decodeStatus),
		Effect.map(status => /^(running|stopping|paused)$/.test(status.state) && !alive(status.pid) ? {...status, state: 'dead'} : status),
		Effect.orElseSucceed(() => null));

/** The machine's slot pool, read as lib/slots.js writes it. */
export const readMachine = async (): Promise<{slots: number; held: ReadonlyArray<{slot: number; pid: number; label: string}>; load: number; cores: number}> => {
	const dir = process.env['RUNBUN_SLOTS_DIR'] ?? path.join(os.homedir(), '.cache', 'runbuncalc', 'slots');
	const slots = Math.max(1, Number(process.env['RUNBUN_SLOTS']) || os.cpus().length - 2);
	const held: Array<{slot: number; pid: number; label: string}> = [];
	for (let slot = 0; slot < slots; slot++) {
		try {
			const lock = JSON.parse(await fs.readFile(path.join(dir, slot + '.lock'), 'utf8')) as {pid?: unknown; label?: unknown};
			if (typeof lock.pid === 'number' && alive(lock.pid)) held.push({slot, pid: lock.pid, label: String(lock.label ?? '')});
		} catch { /* free */ }
	}
	return {slots, held, load: Number((os.loadavg()[0] ?? 0).toFixed(1)), cores: os.cpus().length};
};

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
main{display:block;height:auto;max-width:1180px;margin:0 auto;padding:12px 16px}#overview{width:100%;margin:0 0 10px}#overview tr{cursor:pointer}#overview tr[aria-current=true] td{font-weight:600}#overview{display:block;overflow-x:auto}#overview td,#overview th{padding:3px 12px 3px 0;text-align:left;white-space:nowrap}#overview th{font-weight:400;color:var(--mute);font-size:12px}#overview tr.over td{color:var(--mute)}#overview tr.fold td{color:var(--mute);font-size:12px;padding-top:8px}#overview .warn{color:var(--warn,#b7791f)}#overview .acts button{font:inherit;font-size:12px;padding:1px 8px;margin-right:4px;border:1px solid var(--line,#8884);border-radius:4px;background:transparent;color:inherit;cursor:pointer}#overview .acts button:hover{background:var(--line,#8882)}#machine{margin:0 0 8px}
.facts{margin:6px 0 12px;line-height:1.7}.facts b{font-weight:600}.facts span{color:var(--mute);margin-right:14px}
table.dense{border-collapse:collapse;margin:0 0 18px;width:auto;max-width:100%}table.dense td{white-space:nowrap}table.dense th{font-weight:400;color:var(--mute);font-size:12px;text-align:left;padding:2px 12px 4px 0;white-space:nowrap}table.dense td{padding:3px 12px 3px 0;vertical-align:baseline;border-top:1px solid var(--line)}table.dense td.wrap{white-space:normal;color:var(--mute);font-size:12px}table.dense tr.out td{color:var(--mute)}table.dense tr.six td:first-child{font-weight:600}
h2.part{font-size:12px;font-weight:400;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 4px}
.pair .ko{fill:var(--fg)}.pair .fall{fill:var(--loss)}.pair .axis{stroke:var(--line)}.pair .wall{fill:var(--hot)}.bars .bar1{fill:var(--mute)}.bars .bar1.lost{fill:var(--loss)}
body{font-variant-numeric:tabular-nums}.num{text-align:right!important;font-variant-numeric:tabular-nums}
.road .ahead{stroke:var(--line);stroke-width:1}.road .behind{stroke:var(--mute);stroke-width:1}.road .wall{stroke:var(--fg);stroke-width:1.6}.road .wall.lost{stroke:var(--loss);stroke-width:2}.road .here{fill:var(--mute)}.road .here.live{fill:var(--win)}
.turn{background:none;border:0;border-top:1px solid var(--line);border-radius:0;padding:8px 0;margin:0}.tag{background:none;padding:0;margin:2px 10px 0 0;color:var(--mute)}.tag.hot{color:var(--hot)}.tag.warn{color:var(--loss)}
.weighed{margin:6px 0 0}.weighed .opt{display:flex;gap:10px;align-items:center;color:var(--mute);font-size:12px}.weighed .opt.chosen{color:var(--fg)}.weighed .name{flex:0 0 190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.weighed .num{flex:0 0 44px}.weighed .axis{stroke:var(--line)}.weighed .other{fill:var(--line)}.weighed .dot{fill:none;stroke:var(--mute);stroke-width:1.2}.weighed .dot.chosen{fill:var(--fg);stroke:var(--fg)}.compact .events,.compact .turn table{display:none}.runs button{margin:0 6px 6px 0}.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--win);margin-right:6px;animation:p 1s infinite}.done .pulse,.lost .pulse{background:var(--mute);animation:none}@keyframes p{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.pulse{animation:none}}</style></head><body>
<header><h1 id="title">Live run</h1><p id="sub">waiting for a fight…</p></header>
<main><p class="sub" id="machine"></p><table id="overview"></table><div class="filters" id="views"></div><div id="fightView"><div class="filters" id="controls"></div><div class="filters" id="tagbar"></div><div class="speed" id="six"></div><div id="turns"></div></div><div id="runView" hidden></div><div id="fleetView" hidden></div></main>
<script>
const HOT = new Set(['speed-control','status','set-up','sack','pivot','search-overrode','screen','hazard','disrupt','priority','sacrifice-forced','sacrifice-chosen']);
const WARN = new Set(['they-move-first','coin-flip','we-fall','foe-set-up','foe-recovered','crit-theirs','sacrifice-unforced']);
let current = null, seen = -1, attempt = null, said = false;
const el = (tag, attrs, kids) => { const n = document.createElement(tag); for (const k in (attrs||{})) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'on') for (const e in attrs.on) n.addEventListener(e, attrs.on[e]); else n.setAttribute(k, attrs[k]); } for (const kid of (kids||[])) n.appendChild(kid); return n; };
const bar = (pct, foe) => el('span', {class: 'bar' + (foe ? ' foe' : '')}, [el('i', {style: 'width:' + Math.max(0, Math.min(100, pct)) + '%'})]);
// What the search weighed, on ONE axis from 0 to 1: a dot an option, the chosen one filled. Two dots that touch
// are a coin flip and look like one — which two numbers in a table (0.204, 0.205) never did. The numbers stay,
// beside the option, for whoever wants them.
function weighed(scores, chose) {
  const W = 220, x = v => 4 + Math.max(0, Math.min(1, v)) * (W - 8), box = el('div', {class: 'weighed'});
  for (const s of scores) {
    const g = svg('svg', {width: W, height: 12, viewBox: '0 0 ' + W + ' 12', role: 'img', 'aria-label': s.choice + ' valued ' + s.value});
    g.appendChild(svg('line', {x1: 4, x2: W - 4, y1: 6, y2: 6, class: 'axis'}));
    for (const o of scores) if (o !== s) g.appendChild(svg('circle', {cx: x(o.value), cy: 6, r: 2, class: 'other'}));
    g.appendChild(svg('circle', {cx: x(s.value), cy: 6, r: 3.2, class: s.choice === chose ? 'dot chosen' : 'dot'}));
    box.appendChild(el('div', {class: 'opt' + (s.choice === chose ? ' chosen' : '')}, [el('span', {class: 'name', text: s.choice}), g,
      el('span', {class: 'num', text: s.value.toFixed(3)}),
      el('span', {class: 'sub', text: (s.wins === undefined ? s.runs + ' playouts' : s.wins + '/' + s.runs + ' won') + (s.removed === undefined ? '' : ' · ' + Math.round(s.removed * 100) + '% of theirs removed') + (s.oursAlive === undefined ? '' : ' · ' + s.oursAlive + ' of ours standing') + (s.lead === undefined ? '' : ' · lead ' + (s.lead > 0 ? '+' : '') + s.lead)})]));
  }
  return box;
}
// Two quantities on ONE scale shared by every row, so the rows compare: knockouts to the right of the
// axis, falls to the left, and inside the knockouts the part scored in a fight that cleared a wall.
function pair(kos, falls, wallKos, scale) {
  const W = 160, mid = 60, unit = Math.min((W - mid - 2) / Math.max(1, scale.kos), (mid - 2) / Math.max(1, scale.falls));
  const g = svg('svg', {width: W, height: 10, viewBox: '0 0 ' + W + ' 10', class: 'pair', role: 'img', 'aria-label': kos + ' knockouts, ' + falls + ' falls'});
  g.appendChild(svg('rect', {x: mid, y: 2, width: Math.max(0, kos * unit), height: 6, class: 'ko'}));
  if (wallKos) g.appendChild(svg('rect', {x: mid, y: 2, width: wallKos * unit, height: 6, class: 'wall'}, [tip(wallKos + ' of them in a fight that cleared a wall')]));
  g.appendChild(svg('rect', {x: mid - falls * unit, y: 2, width: Math.max(0, falls * unit), height: 6, class: 'fall'}));
  g.appendChild(svg('line', {x1: mid, x2: mid, y1: 0, y2: 10, class: 'axis'}));
  return g;
}
const attemptsBar = (n, cleared, most) => { const W = 120, g = svg('svg', {width: W, height: 8, viewBox: '0 0 ' + W + ' 8', class: 'bars', role: 'img', 'aria-label': n + ' attempts'}); g.appendChild(svg('rect', {x: 0, y: 1, width: Math.max(2, W * Math.log2(1 + n) / Math.log2(1 + most)), height: 6, class: 'bar1' + (cleared ? '' : ' lost')})); return g; };
const list = pairs => pairs.map(p => p[0] + (p[1] > 1 ? ' ×' + p[1] : '')).join(', ');
const dense = (heads, rows) => { const t = el('table', {class: 'dense'}); t.appendChild(el('tr', {}, heads.map(h => el('th', {text: h})))); rows.forEach(r => t.appendChild(r)); return t; };
const cell = (v, cls) => (v instanceof Node ? el('td', {class: cls || ''}, [v]) : el('td', {class: cls || '', text: v === null || v === undefined ? '' : String(v)}));
const part = text => el('h2', {class: 'part', text});
function factsOf(s) {
  const f = el('p', {class: 'facts'}); const add = (k, v) => { f.appendChild(el('b', {text: v + ' '})); f.appendChild(el('span', {text: k})); };
  add('position', s.position); add('trainers beaten', s.trainersBeaten); add('attempts', s.attempts);
  if (s.attemptsPerTrainer !== null) add('attempts a trainer', s.attemptsPerTrainer);
  add('beaten first try', s.trainersBeaten ? Math.round(100 * s.firstTry / s.trainersBeaten) + '%' : '—');
  if (s.bodiesLostPerWallWin !== null) add('bodies lost per wall cleared', s.bodiesLostPerWallWin);
  if (s.minutes !== null) add('minutes', s.minutes);
  add('plans', s.plans); add('in the box', s.boxSize);
  add('', s.state === 'playing' ? 'still playing' : s.state === 'finished' ? 'FINISHED' : 'ended: ' + String(s.stopped || '').split(':')[0]);
  if (s.auditOk !== null) add('', s.auditOk ? 'audit valid' : 'audit FAILS');
  return f;
}
async function drawRun() {
  const box = document.getElementById('runView'); if (!current) return;
  const s = await (await fetch('/summary?run=' + encodeURIComponent(current))).json(); box.replaceChildren();
  if (!s) { box.appendChild(el('p', {class: 'sub', text: 'This run has neither a record nor a checkpoint to read: it was started before run control and is still playing. Its fights are on the fight tab.'})); return; }
  box.appendChild(factsOf(s));
  box.appendChild(part('played by'));
  box.appendChild(dense(['hand', 'attempts', 'won', ''], s.byHand.map(h => el('tr', {}, [cell(h.hand), cell(h.attempts, 'num'), cell(h.wins, 'num'), cell(Math.round(100 * h.wins / Math.max(1, h.attempts)) + '%', 'num')]))));
  const most = Math.max(1, ...s.walls.map(w => w.attempts));
  box.appendChild(part('walls — fights that took ' + 5 + ' attempts or more'));
  box.appendChild(s.walls.length ? dense(['trainer', 'attempts', '', '', 'won by', 'bodies lost in the win'], s.walls.map(w => el('tr', {class: w.cleared ? '' : 'out'}, [cell(w.trainer), cell(w.attempts, 'num'), cell(attemptsBar(w.attempts, w.cleared, most)), cell(w.cleared ? 'cleared' : 'NOT cleared', w.cleared ? '' : 'loss'), cell(w.wonBy), cell(w.bodiesLostInWin, 'num')]))) : el('p', {class: 'sub', text: 'none yet'}));
  const scale = {kos: Math.max(1, ...s.roster.map(m => m.knockouts)), falls: Math.max(1, ...s.roster.map(m => m.falls))};
  box.appendChild(part('the box — falls ◀ ▶ knockouts, one scale; amber is knockouts in a fight that cleared a wall'));
  box.appendChild(dense(['', '', 'falls', '', 'KOs', 'with', 'knocked out', 'fell to', 'holds · nature · ability', 'moves', 'caught'], s.roster.map(m => el('tr', {class: (m.inParty ? 'six' : '') + (m.alive ? '' : ' out')}, [
    cell(m.name + (m.name === m.species ? '' : ' the ' + m.species)), cell('L' + m.level, 'num'), cell(m.falls, 'num'), cell(pair(m.knockouts, m.falls, m.wallKnockouts, scale)), cell(m.knockouts, 'num'),
    cell(list(m.bestMoves), 'wrap'), cell(list(m.victims), 'wrap'), cell(list(m.fellTo), 'wrap'), cell([m.item, m.nature, m.ability].filter(Boolean).join(' · ') + (m.ivTotal === null ? '' : ' · IVs ' + m.ivTotal), 'wrap'), cell(m.moves.join(' / '), 'wrap'), cell(m.caught, 'wrap')]))));
}
async function drawFleet() {
  const box = document.getElementById('fleetView'); const f = await (await fetch('/fleet')).json(); box.replaceChildren();
  if (!f) { box.appendChild(el('p', {class: 'sub', text: 'no run here has a record or a checkpoint yet'})); return; }
  box.appendChild(part('runs'));
  box.appendChild(dense(['run', '', 'position', 'trainers', 'attempts', 'a trainer', 'first try', 'walls not cleared', 'min'], f.runs.map(r => el('tr', {class: r.summary.state === 'playing' ? '' : 'out', on: {click: () => { current = r.run; view = 'run'; lastOverview = ''; views(); runs(); }}}, [cell(r.run), cell(r.summary.state === 'playing' ? 'playing' : r.summary.state === 'finished' ? 'FINISHED' : 'ended'), cell(r.summary.position, 'num'), cell(r.summary.trainersBeaten, 'num'), cell(r.summary.attempts, 'num'), cell(r.summary.attemptsPerTrainer, 'num'), cell(r.summary.trainersBeaten ? Math.round(100 * r.summary.firstTry / r.summary.trainersBeaten) + '%' : '', 'num'), cell(r.summary.walls.filter(w => !w.cleared).map(w => w.trainer.replace(/^(Leader|Trainer) /, '')).join(', '), 'wrap'), cell(r.summary.minutes, 'num')]))));
  const most = Math.max(1, ...f.walls.map(w => w.medianAttempts));
  box.appendChild(part('walls across runs — where runs bleed, and where they stop'));
  box.appendChild(dense(['trainer', 'runs that hit it', 'cleared', 'median attempts', '', 'attempts in all'], f.walls.map(w => el('tr', {}, [cell(w.trainer), cell(w.runsMet, 'num'), cell(w.runsCleared + ' of ' + w.runsMet, w.runsCleared < w.runsMet ? 'loss' : ''), cell(w.medianAttempts, 'num'), cell(attemptsBar(w.medianAttempts, w.runsCleared === w.runsMet, most)), cell(w.attempts, 'num')]))));
  const scale = {kos: Math.max(1, ...f.species.map(m => m.knockouts)), falls: Math.max(1, ...f.species.map(m => m.falls))};
  box.appendChild(part('species across runs — sorted by knockouts in fights that cleared a wall'));
  box.appendChild(dense(['species', 'runs', 'falls', '', 'KOs', 'in wall clears', 'KOs a fall'], f.species.map(m => el('tr', {}, [cell(m.species), cell(m.runs, 'num'), cell(m.falls, 'num'), cell(pair(m.knockouts, m.falls, m.wallKnockouts, scale)), cell(m.knockouts, 'num'), cell(m.wallKnockouts, 'num'), cell(m.falls ? (m.knockouts / m.falls).toFixed(1) : '—', 'num')]))));
}
let view = 'fight';
function views() {
  const box = document.getElementById('views'); box.replaceChildren();
  for (const [key, label] of [['fight', 'the fight'], ['run', 'this run'], ['fleet', 'all runs']]) box.appendChild(el('button', {'aria-pressed': String(view === key), text: label, on: {click: () => { view = key; prefs.view = key; keep(); views(); }}}));
  document.getElementById('fightView').hidden = view !== 'fight'; document.getElementById('runView').hidden = view !== 'run'; document.getElementById('fleetView').hidden = view !== 'fleet';
  if (view === 'run') drawRun().catch(() => {}); if (view === 'fleet') drawFleet().catch(() => {});
}
function card(t) {
  const c = el('div', {class: 'turn'});
  c.appendChild(el('div', {class: 'head'}, [el('b', {text: 'T' + t.turn}), el('span', {}, [document.createTextNode(t.us + ' '), bar(t.usHp), document.createTextNode(' ' + t.usHp + '%')]), el('span', {class: 'sub', text: 'vs'}), el('span', {}, [document.createTextNode(t.foe + ' '), bar(t.foeHp, true), document.createTextNode(' ' + t.foeHp + '%')]), el('span', {class: 'chosen', text: '→ ' + t.chose}), el('span', {class: 'sub', text: t.why || ''})]));
  const tags = el('div'); for (const tag of t.tags) tags.appendChild(el('span', {class: 'tag' + (HOT.has(tag) ? ' hot' : WARN.has(tag) ? ' warn' : ''), text: tag})); c.appendChild(tags);
  const ev = el('ul', {class: 'events'}); for (const e of t.events) ev.appendChild(el('li', {text: e})); c.appendChild(ev);
  const scores = (t.scores || []).slice().sort((a, b) => b.value - a.value);
  if (scores.length) c.appendChild(weighed(scores, t.chose));
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
let lastOverview = '';
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, kids) => { const n = document.createElementNS(SVG, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); for (const kid of (kids || [])) n.appendChild(kid); return n; };
const tip = text => { const t = document.createElementNS(SVG, 'title'); t.textContent = text; return t; };
// The road, word-sized and on ONE scale for every run, so the rows compare: how far each has come, and where it
// bled attempts. A bar is a fight that took more than one try; its height is how many (log scale); red is one that
// never fell. Everything else about the run is a number beside it.
function roadStrip(r) {
  const W = 220, H = 18, of = r.roadOf || 358, x = n => 1 + (n / of) * (W - 2);
  const g = svg('svg', {width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'road', role: 'img', 'aria-label': 'trainer ' + (r.road || 0) + ' of ' + of + ', ' + r.walls.length + ' fights took more than one attempt'});
  g.appendChild(svg('line', {x1: 1, x2: W - 1, y1: H - 1.5, y2: H - 1.5, class: 'ahead'}));
  if (r.road) g.appendChild(svg('line', {x1: 1, x2: x(r.road), y1: H - 1.5, y2: H - 1.5, class: 'behind'}));
  for (const w of r.walls) { const h = Math.min(H - 3, 2 + 2.6 * Math.log2(w.attempts)); g.appendChild(svg('line', {x1: x(w.road), x2: x(w.road), y1: H - 2, y2: H - 2 - h, class: w.won ? 'wall' : 'wall lost'}, [tip('#' + w.road + ' ' + w.trainer + ': ' + w.attempts + ' attempts, ' + (w.won ? 'won' : 'never won'))])); }
  if (r.road) g.appendChild(svg('circle', {cx: x(r.road), cy: H - 1.5, r: 2.2, class: r.live ? 'here live' : 'here'}));
  return g;
}
async function runs() {
  let rows, m;
  try { rows = await (await fetch('/overview')).json(); m = await (await fetch('/machine')).json(); }
  catch (e) { document.getElementById('machine').textContent = 'the watch server is not answering'; lastOverview = ''; return; }
  // Drawn again only when something changed: a table rebuilt every second cannot be hovered, read or clicked.
  const now = JSON.stringify([rows.map(r => [r.run, r.trainer, r.attempt, r.hand, r.ended, r.state, r.fight, r.pace, r.rssMb, r.road, r.walls.length, r.walls.reduce((n, w) => n + w.attempts, 0), Math.floor((r.age || 0) / 60)]), m.held.length, current, !!prefs.ended]);
  if (!said) document.getElementById('machine').textContent = m.held.length + ' of ' + m.slots + ' slots held · load ' + m.load + ' on ' + m.cores + ' cores' + (m.load > m.cores ? ' — over-subscribed' : '');
  if (now === lastOverview) return; lastOverview = now;
  const table = document.getElementById('overview'); table.replaceChildren();
  // A run from before run control has no status file: its fight file's age is all that says whether it still plays.
  for (const r of rows) { r.live = r.state ? /^(running|paused|stopping)$/.test(r.state) : r.age !== null && r.age < 600; r.shown = r.state || (r.live ? 'running' : 'ended'); r.handled = !!r.state; }
  const live = rows.filter(r => r.live), over = rows.filter(r => !r.live);
  const say = async (run, action) => { const r = await (await fetch('/control?run=' + encodeURIComponent(run) + '&action=' + action, {method: 'POST', headers: {'x-insight': '1'}})).json(); said = true; document.getElementById('machine').textContent = r.said; lastOverview = ''; setTimeout(() => { said = false; runs(); }, 2500); };
  const button = (label, run, action) => el('button', {text: label, on: {click: e => { e.stopPropagation(); say(run, action); }}});
  const ago = s => s === null ? '' : s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h';
  table.appendChild(el('tr', {}, ['run', 'state', 'the road, and where it cost attempts', '', 'facing', 'attempt', 'played by', 'last fight', 'pace', 'memory', ''].map(h => el('th', {text: h}))));
  const line = r => table.appendChild(el('tr', {class: r.live ? '' : 'over', 'aria-current': String(r.run === current), on: {click: () => { current = r.run; seen = -1; attempt = null; shown = []; held = []; lastOverview = ''; redraw(); runs(); if (view === 'run') drawRun().catch(() => {}); }}}, [
    el('td', {text: r.run}),
    el('td', {class: r.shown === 'dead' ? 'loss' : r.shown === 'paused' || r.shown === 'stopping' ? 'warn' : r.live ? 'win' : 'sub', text: r.shown + (r.handled ? '' : ' ·'), title: r.handled ? (r.spec || '') : 'started before run control: no status file, so it cannot be paused or stopped from here'}),
    el('td', {}, [roadStrip(r)]),
    el('td', {class: 'num', text: r.road ? r.road + ' / ' + r.roadOf : '—', title: r.fight === null ? '' : 'fight ' + r.fight + ' of this run · position ' + r.position}),
    el('td', {text: r.trainer || 'not started'}),
    el('td', {class: 'num' + (r.attempt >= 10 ? ' warn' : ''), text: r.attempt === null ? '' : String(r.attempt), title: r.attempt >= 10 ? 'a wall: ' + r.attempt + ' attempts' : ''}),
    el('td', {text: r.hand || ''}),
    el('td', {class: 'sub', text: r.ended ? r.ended + (r.live ? '' : ' · ' + ago(r.age) + ' ago') : 'turn ' + r.turn}),
    el('td', {class: 'num', text: r.pace === null ? '' : r.pace + ' s/fight'}), el('td', {class: 'num', text: r.rssMb === null || !r.live ? '' : r.rssMb + ' MB'}),
    el('td', {class: 'acts'}, r.state === 'running' ? [button('pause', r.run, 'pause'), button('stop', r.run, 'stop')] : r.state === 'paused' ? [button('continue', r.run, 'cont')] : [])]));
  live.forEach(line);
  if (over.length) table.appendChild(el('tr', {class: 'fold', on: {click: () => { prefs.ended = !prefs.ended; keep(); lastOverview = ''; runs(); }}}, [el('td', {colspan: '11', text: (prefs.ended ? '▾ ' : '▸ ') + over.length + ' run' + (over.length === 1 ? '' : 's') + ' no longer playing'})]));
  if (prefs.ended) over.forEach(line);
  if (!current && rows.length) { current = (live[0] || rows[0]).run; lastOverview = ''; runs(); }
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
view = prefs.view || 'fight'; controls(); views(); quiet(runs)(); setInterval(quiet(runs), 3000); setInterval(quiet(tick), 1000);
setInterval(() => { if (view === 'run') drawRun().catch(() => {}); if (view === 'fleet') drawFleet().catch(() => {}); }, 30000);
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

export interface Road {
	/** The furthest trainer reached, as the Nth on the road. */
	readonly road: number | null;
	/** Every fight that took more than one attempt: where, how many, and whether it fell. */
	readonly walls: ReadonlyArray<{readonly road: number; readonly trainer: string; readonly attempts: number; readonly won: boolean}>;
}

/**
 * Where a run has been, off its plain log (`12 #32 Twins Gina And Mia loss
 * (joint-4)`: attempt number, the trainer's place on the road, name, result).
 * The log is written by every run there has ever been, live or ended, so the
 * road strip needs nothing new from the harness.
 */
export const readRoad = (file: string): Promise<Road> =>
	fs.readFile(file, 'utf8').then(text => {
		const fights = new Map<number, {trainer: string; attempts: number; won: boolean}>();
		let road: number | null = null;
		for (const line of text.split('\n')) {
			const hit = /^\d+ #(\d+) (.+?) (win|loss)\b/.exec(line);
			if (hit === null) continue;
			const at = Number(hit[1]);
			const row = fights.get(at) ?? {trainer: hit[2] ?? '', attempts: 0, won: false};
			row.attempts += 1;
			if (hit[3] === 'win') row.won = true;
			fights.set(at, row);
			road = Math.max(road ?? 0, at);
		}
		return {road, walls: [...fights.entries()].filter(entry => entry[1].attempts > 1)
			.map(entry => ({road: entry[0], ...entry[1]}))};
	}, () => ({road: null, walls: []}));

/** One run at a glance: the fight it is in, its own status, and how long since it last wrote a turn. */
export const overviewRow = async (dir: string, name: string) => {
	const live = await Effect.runPromise(readLive(path.join(dir, name + '.live.ndjson')));
	const status = await Effect.runPromise(readStatus(path.join(dir, name + '.status.json')));
	// The fight file's age is all that says whether a run from before run
	// control (no status file) is still playing.
	const age = await fs.stat(path.join(dir, name + '.live.ndjson')).then(stat => Math.round((Date.now() - stat.mtimeMs) / 1000), () => null);
	const header = live.header;
	const been = await readRoad(path.join(dir, name + '.log'));
	return {run: name, trainer: header?.trainer ?? null, fight: header?.n ?? null, attempt: header?.attempt ?? null,
		position: header?.position ?? null, hand: header?.hand ?? null, road: header?.road ?? been.road, roadOf: header?.roadOf ?? ROAD_LENGTH,
		walls: been.walls,
		turn: live.turns.length ? live.turns[live.turns.length - 1]?.turn ?? 0 : 0, ended: live.ended,
		state: status?.state ?? null, fights: status?.fights ?? null, pace: status?.secondsPerFight ?? null,
		rssMb: status?.rssMb ?? null, spec: status?.spec ?? null, age};
};

/** The road's length when a run is too old to say (its live header predates `roadOf`). */
const ROAD_LENGTH = 358;
/**
 * A run's aggregates and profiles: from its record when it has ended, from its
 * checkpoint while it plays. A record is megabytes and a page polls, so the
 * answer is kept until the file it came from changes.
 */
const summaries = new Map<string, {at: number; summary: RunSummary}>();
export const loadSummary = async (dir: string, run: string): Promise<RunSummary | null> => {
	for (const [suffix, kind] of [['.json', 'ended'], ['.checkpoint.json', 'playing']] as const) {
		const file = path.join(dir, run + suffix);
		const stat = await fs.stat(file).catch(() => null);
		if (stat === null) continue;
		const kept = summaries.get(file);
		if (kept !== undefined && kept.at === stat.mtimeMs) return kept.summary;
		const json: unknown = await fs.readFile(file, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null);
		if (json === null) continue;
		const source = kind === 'ended' ?
			await Effect.runPromise(decodeEnded(json).pipe(Effect.map(fromEnded), Effect.orElseSucceed(() => null))) :
			await Effect.runPromise(decodePlaying(json).pipe(Effect.map(fromPlaying), Effect.orElseSucceed(() => null)));
		if (source === null) continue;
		// A run carried on has BOTH: the record of its last leg's end and a newer checkpoint. The newer file wins.
		if (kind === 'ended') {
			const newer = await fs.stat(path.join(dir, run + '.checkpoint.json')).catch(() => null);
			if (newer !== null && newer.mtimeMs > stat.mtimeMs + 60000) continue;
		}
		let summary = summariseRun(source);
		// A checkpoint says "playing" for ever. The run's own status file, and
		// whether its process is there, say whether that is still true: five
		// measurement arms died with a checkpoint each and read as playing.
		if (kind === 'playing') {
			const status = await Effect.runPromise(readStatus(path.join(dir, run + '.status.json')));
			if (status === null || !/^(running|paused|stopping)$/.test(status.state)) {
				summary = {...summary, state: 'ended', stopped: status === null ? 'no status file' : status.state === 'dead' ?
					'its process died: no record was written, this is its last checkpoint' : status.state};
			}
			return summary;
		}
		summaries.set(file, {at: stat.mtimeMs, summary});
		return summary;
	}
	return null;
};

const RUN_NAME = /^([A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/;

/** Stop, pause or continue one run — by its own status file's pid, as scripts/runs.js does. */
export const control = async (dir: string, run: string, action: 'stop' | 'pause' | 'cont'): Promise<{ok: boolean; said: string}> => {
	const base = path.join(dir, run);
	const status = await Effect.runPromise(readStatus(base + '.status.json'));
	if (status === null || !alive(status.pid) || status.state === 'dead') return {ok: false, said: run + ' is not running'};
	if (action === 'stop') {
		await fs.writeFile(base + '.control.json', JSON.stringify({action: 'stop', at: Date.now()}));
		return {ok: true, said: run + ' will checkpoint and stop after the fight it is in'};
	}
	process.kill(status.pid, action === 'pause' ? 'SIGSTOP' : 'SIGCONT');
	await fs.writeFile(base + '.status.json', JSON.stringify({...status, state: action === 'pause' ? 'paused' : 'running', updatedAt: Date.now()}));
	return {ok: true, said: run + (action === 'pause' ? ' paused' : ' continued')};
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
			void listRuns(dir).then(names => Promise.all(names.map(name => overviewRow(dir, name))))
				.then(rows => send(res, 'application/json', JSON.stringify(rows)), () => send(res, 'application/json', '[]'));
			return;
		}
		if (url.pathname === '/summary') {
			const run = url.searchParams.get('run') ?? '';
			if (!RUN_NAME.test(run) || run.includes('..')) { res.writeHead(400); res.end('bad run name'); return; }
			void loadSummary(dir, run).then(summary => send(res, 'application/json', JSON.stringify(summary)));
			return;
		}
		if (url.pathname === '/fleet') {
			void listRuns(dir).then(names => Promise.all(names.map(name => loadSummary(dir, name).then(summary => ({run: name, summary})))))
				.then(all => send(res, 'application/json', JSON.stringify(fleetOf(all.filter((entry): entry is {run: string; summary: RunSummary} => entry.summary !== null)))),
					() => send(res, 'application/json', 'null'));
			return;
		}
		if (url.pathname === '/machine') {
			void readMachine().then(machine => send(res, 'application/json', JSON.stringify(machine)));
			return;
		}
		if (url.pathname === '/control') {
			const run = url.searchParams.get('run') ?? '';
			const action = url.searchParams.get('action') ?? '';
			if (req.method !== 'POST' || req.headers['x-insight'] !== '1' || !RUN_NAME.test(run) || run.includes('..') ||
				!/^(stop|pause|cont)$/.test(action)) { res.writeHead(400); res.end('refused'); return; }
			void control(dir, run, action as 'stop' | 'pause' | 'cont').then(said => send(res, 'application/json', JSON.stringify(said)));
			return;
		}
		if (url.pathname === '/state') {
			// A run is named LABEL/run-SEED (or run-SEED); anything else is refused,
			// so the name can never walk out of the directory being watched.
			const run = url.searchParams.get('run') ?? '';
			if (!RUN_NAME.test(run) || run.includes('..')) { res.writeHead(400); res.end('bad run name'); return; }
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
