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
import {wallView, type WallView} from './analyse.js';
import {currentOf, describeFailure, loadRunWithFights, sidecarOf} from './cli.js';
import {Turn, type RunRecord} from './schema.js';
import {readDoublesLine, tagsOf} from './tags.js';
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

export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Run</title><style>${STYLE}
main{display:block;height:auto;max-width:1180px;margin:0 auto;padding:12px 16px}#overview{width:100%;margin:0 0 10px}#overview tr{cursor:pointer}#overview tr[aria-current=true] td{font-weight:600}#overview{display:block;overflow-x:auto}#overview td,#overview th{padding:3px 12px 3px 0;text-align:left;white-space:nowrap}#overview th{font-weight:400;color:var(--mute);font-size:12px}#overview tr.over td{color:var(--mute)}#overview tr.fold td{color:var(--mute);font-size:12px;padding-top:8px}#overview .warn{color:var(--warn,#b7791f)}#overview .acts button{font:inherit;font-size:12px;padding:1px 8px;margin-right:4px;border:1px solid var(--line,#8884);border-radius:4px;background:transparent;color:inherit;cursor:pointer}#overview .acts button:hover{background:var(--line,#8882)}#machine{margin:0 0 8px}
.facts{margin:6px 0 12px;line-height:1.7}.facts b{font-weight:600}.facts span{color:var(--mute);margin-right:14px}
table.dense{border-collapse:collapse;margin:0 0 18px;width:auto;max-width:100%}table.dense td{white-space:nowrap}table.dense th{font-weight:400;color:var(--mute);font-size:12px;text-align:left;padding:2px 12px 4px 0;white-space:nowrap}table.dense td{padding:3px 12px 3px 0;vertical-align:baseline;border-top:1px solid var(--line)}table.dense td.wrap{white-space:normal;color:var(--mute);font-size:12px}table.dense tr.out td{color:var(--mute)}table.dense tr.six td:first-child{font-weight:600}
h2.part{font-size:12px;font-weight:400;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 4px}
.pair .ko{fill:var(--fg)}.pair .fall{fill:var(--loss)}.pair .axis{stroke:var(--line)}.pair .wall{fill:var(--hot)}.bars .bar1{fill:var(--mute)}.bars .bar1.lost{fill:var(--loss)}.bars .tick{stroke:var(--line);stroke-width:1}
#views{position:sticky;top:0;z-index:2;background:var(--bg);padding:6px 0;margin:0 0 6px;border-bottom:1px solid var(--line)}
table.dense thead th{position:sticky;top:34px;background:var(--bg);cursor:pointer;user-select:none}table.dense th[aria-sort=ascending]::after{content:' ▲'}table.dense th[aria-sort=descending]::after{content:' ▼'}table.dense th:focus-visible,table.dense tr.go:focus-visible{outline:2px solid var(--hot);outline-offset:-2px}table.dense tr.go{cursor:pointer}table.dense tr.go:hover td{background:var(--tag)}table.dense tr.seed td{font-weight:600;border-top:1px solid var(--mute);padding-top:8px}table.dense tr.leg td:first-child{padding-left:16px;font-weight:400}
.jump{margin:0 0 4px;font-size:12px}.jump a{color:var(--mute);margin-right:14px}h2.part{scroll-margin-top:44px}
body{font-variant-numeric:tabular-nums}.num{text-align:right!important;font-variant-numeric:tabular-nums}
.road .ahead{stroke:var(--line);stroke-width:1}.road .behind{stroke:var(--mute);stroke-width:1}.road .wall{stroke:var(--fg);stroke-width:1.6}.road .wall.lost{stroke:var(--loss);stroke-width:2}.road .here{fill:var(--mute)}.road .here.live{fill:var(--win)}
.turn{background:none;border:0;border-top:1px solid var(--line);border-radius:0;padding:8px 0;margin:0}.tag{background:none;padding:0;margin:2px 10px 0 0;color:var(--mute)}.tag.hot{color:var(--hot)}.tag.warn{color:var(--loss)}
.weighed{margin:6px 0 0}.weighed .opt{display:flex;gap:10px;align-items:center;color:var(--mute);font-size:12px}.weighed .opt.chosen{color:var(--fg)}.weighed .name{flex:0 0 190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.weighed .num{flex:0 0 44px}.weighed .axis{stroke:var(--line)}.weighed .other{fill:var(--line)}.weighed .dot{fill:none;stroke:var(--mute);stroke-width:1.2}.weighed .dot.chosen{fill:var(--fg);stroke:var(--fg)}.compact .events,.compact .turn table{display:none}.runs button{margin:0 6px 6px 0}.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--win);margin-right:6px;animation:p 1s infinite}.done .pulse,.lost .pulse{background:var(--mute);animation:none}@keyframes p{50%{opacity:.25}}
.dots .axis{stroke:var(--line)}.dots .loss{fill:var(--mute)}.dots .win{fill:var(--fg)}.tries rect{fill:var(--loss)}.tries rect.ko{fill:var(--fg)}table.dense tr[aria-current=true] td{font-weight:600}.tries rect.untaped{fill:var(--line)}.tries rect.won{fill:var(--win)}.tries rect.at{fill:var(--hot)}.tries rect{cursor:pointer}.tries rect:focus-visible{outline:none;stroke:var(--hot);stroke-width:1.5}.tries rect.none{fill:transparent;stroke:var(--line);stroke-width:1}.tries rect.none.won{stroke:var(--win)}.tries rect.none.at{stroke:var(--hot)}#sub button{font:inherit;font-size:12px;padding:0 8px;margin-left:6px;border:1px solid var(--line);border-radius:4px;background:transparent;color:inherit;cursor:pointer}#sub button[disabled]{opacity:.35;cursor:default}
@media (prefers-reduced-motion:reduce){.pulse{animation:none}}</style></head><body>
<header><h1 id="title">Live run</h1><p id="sub">waiting for a fight…</p></header>
<main><p class="sub" id="machine"></p><table id="overview"></table><div class="filters" id="views"></div><div id="fightView"><div class="filters" id="controls"></div><div class="filters" id="tagbar"></div><div class="speed" id="six"></div><div id="turns"></div></div><div id="runView" hidden></div><div id="fleetView" hidden></div></main>
<script>
const HOT = new Set(['speed-control','status','set-up','sack','pivot','search-overrode','screen','hazard','disrupt','priority','sacrifice-forced','sacrifice-chosen']);
const WARN = new Set(['they-move-first','coin-flip','we-fall','foe-set-up','foe-recovered','crit-theirs','sacrifice-unforced']);
let current = null, seen = -1, attempt = null, said = false, wallOpen = null, pinned = null;
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
// ONE RULE FOR EVERY BAR ON THE PAGE, so nothing has to be re-read from view to view:
//   attempts  — always 0 to ATTEMPT_CAP (the retries a wall gets), linear, a tick every ten: the road strip, a run's
//               walls and the walls across runs all use it, so a bar is the same length wherever it appears;
//   a count   — knockouts right of a centred axis, falls left, ONE unit for both sides (a knockout and a fall are
//               the same length), full width = the largest count in that table, which the table's heading states.
const ATTEMPT_CAP = 40, BAR_W = 120, PAIR_W = 200;
function pair(kos, falls, wallKos, full) {
  const mid = PAIR_W / 2, unit = (mid - 2) / Math.max(1, full);
  const g = svg('svg', {width: PAIR_W, height: 10, viewBox: '0 0 ' + PAIR_W + ' 10', class: 'pair', role: 'img', 'aria-label': kos + ' knockouts, ' + falls + ' falls'});
  g.appendChild(svg('rect', {x: mid, y: 2, width: Math.max(0, kos * unit), height: 6, class: 'ko'}));
  if (wallKos) g.appendChild(svg('rect', {x: mid, y: 2, width: wallKos * unit, height: 6, class: 'wall'}, [tip(wallKos + ' of them in a fight that cleared a wall')]));
  g.appendChild(svg('rect', {x: mid - falls * unit, y: 2, width: Math.max(0, falls * unit), height: 6, class: 'fall'}));
  g.appendChild(svg('line', {x1: mid, x2: mid, y1: 0, y2: 10, class: 'axis'}));
  return g;
}
const fullOf = rows => { const most = Math.max(1, ...rows.map(m => Math.max(m.knockouts, m.falls))); const step = Math.pow(10, Math.floor(Math.log10(most))); return Math.ceil(most / step) * step; };
function attemptsBar(n, cleared) {
  const g = svg('svg', {width: BAR_W, height: 10, viewBox: '0 0 ' + BAR_W + ' 10', class: 'bars', role: 'img', 'aria-label': n + ' attempts of ' + ATTEMPT_CAP});
  for (let t = 0; t <= ATTEMPT_CAP; t += 10) g.appendChild(svg('line', {x1: t / ATTEMPT_CAP * (BAR_W - 1) + 0.5, x2: t / ATTEMPT_CAP * (BAR_W - 1) + 0.5, y1: 0, y2: 10, class: 'tick'}));
  g.appendChild(svg('rect', {x: 0, y: 2, width: Math.max(1.5, Math.min(1, n / ATTEMPT_CAP) * (BAR_W - 1)), height: 6, class: 'bar1' + (cleared ? '' : ' lost')}));
  return g;
}
const list = pairs => pairs.map(p => p[0] + (p[1] > 1 ? ' ×' + p[1] : '')).join(', ');
// Every table sorts by any column: click its heading (again to reverse). What was chosen is remembered per table.
function dense(heads, rows, id) {
  const t = el('table', {class: 'dense'}), body = document.createElement('tbody'), head = el('tr', {});
  const order = (col, dir) => { const num = rows.every(r => r.children[col] && r.children[col].getAttribute('data-v') !== '' && !isNaN(Number(r.children[col].getAttribute('data-v'))));
    rows.slice().sort((a, b) => { const x = a.children[col].getAttribute('data-v'), y = b.children[col].getAttribute('data-v'); return dir * (num ? Number(x) - Number(y) : String(x).localeCompare(String(y))); }).forEach(r => body.appendChild(r));
    [...head.children].forEach((th, i) => th.setAttribute('aria-sort', i === col ? (dir > 0 ? 'ascending' : 'descending') : 'none')); };
  heads.forEach((h, col) => head.appendChild(el('th', {text: h, tabindex: h ? '0' : '-1', on: {click: () => { if (!h) return; const was = (prefs.sort || {})[id]; const dir = was && was[0] === col ? -was[1] : (col === 0 ? 1 : -1); prefs.sort = Object.assign({}, prefs.sort, {[id]: [col, dir]}); keep(); order(col, dir); }, keydown: e => { if (e.key === 'Enter') e.target.click(); }}})));
  const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead); rows.forEach(r => body.appendChild(r)); t.appendChild(body);
  const kept = id && (prefs.sort || {})[id]; if (kept) order(kept[0], kept[1]);
  return t;
}
const cell = (v, cls, by) => { const key = by !== undefined ? by : (typeof v === 'number' ? v : v instanceof Node ? '' : String(v === null || v === undefined ? '' : v)); return v instanceof Node ? el('td', {class: cls || '', 'data-v': key}, [v]) : el('td', {class: cls || '', 'data-v': key, text: v === null || v === undefined ? '' : String(v)}); };
const part = (text, id) => el('h2', {class: 'part', id: id || '', text});
const jump = links => el('p', {class: 'jump'}, links.map(l => el('a', {href: '#' + l[0], text: l[1], on: {click: e => { e.preventDefault(); const n = document.getElementById(l[0]); if (n) n.scrollIntoView({block: 'start'}); }}})));
function factsOf(s) {
  const f = el('p', {class: 'facts'}); const add = (k, v) => { f.appendChild(el('b', {text: v + ' '})); f.appendChild(el('span', {text: k})); };
  add('position', s.position); add('trainers beaten', s.trainersBeaten); add('attempts', s.attempts);
  if (s.attemptsPerTrainer !== null) add('attempts a trainer', s.attemptsPerTrainer);
  add('beaten first try', s.trainersBeaten ? Math.round(100 * s.firstTry / s.trainersBeaten) + '%' : '—');
  if (s.bodiesLostPerWallWin !== null) add('bodies lost per wall cleared', s.bodiesLostPerWallWin);
  if (s.minutes !== null) add('minutes', s.minutes);
  if (s.scoutedFights !== null) { f.appendChild(el('b', {text: s.scoutedFights + ' '})); f.appendChild(el('span', {title: 'An attempt is a fight played for keeps: the run\u2019s own dice, one ledger row, counted against the retry cap. These were played in the run\u2019s head, on other dice, to choose a six or a plan: ' + Object.entries(s.scouted).map(e => e[1] + ' ' + e[0]).join(', '), text: 'scouting fights (not attempts)'})); }
  add('plans', s.plans); add('in the box', s.boxSize);
  if (s.gifted && s.gifted.length) add('gifts claimed (' + s.gifted.map(g => g.species).join(', ') + ')', s.gifted.length);
  // A wall at one Elite Four format hands the run the member's other: without this line a leg that moved from Sidney to SidneyDouble reads as a skip.
  if (s.formatsSwitched && s.formatsSwitched.length) add('formats switched (' + s.formatsSwitched.map(x => x.from.replace('Elite Four ', '') + ' \u2192 ' + x.to.replace('Elite Four ', '') + ' after ' + x.after).join(', ') + ')', s.formatsSwitched.length);
  add('', s.state === 'playing' ? 'still playing' : s.state === 'finished' ? 'FINISHED' : 'ended: ' + String(s.stopped || '').split(':')[0]);
  if (s.auditOk !== null) add('', s.auditOk ? 'audit valid' : 'audit FAILS');
  return f;
}
// Two redraws can be asked for at once (a key and the half-minute refresh): only the latest one draws.
let drawing = 0;
async function drawRun() {
  const box = document.getElementById('runView'); if (!current) return;
  const mine = ++drawing; const s = await (await fetch('/summary?run=' + encodeURIComponent(current))).json(); if (mine !== drawing) return; box.replaceChildren();
  if (!s) { box.appendChild(el('p', {class: 'sub', text: 'This run has neither a record nor a checkpoint to read: it was started before run control and is still playing. Its fights are on the fight tab.'})); return; }
  box.appendChild(factsOf(s));
  box.appendChild(jump([['run-hands', 'played by'], ['run-walls', 'walls (' + s.walls.length + ')'], ['run-box', 'the box (' + s.roster.length + ')']]));
  box.appendChild(part('played by', 'run-hands'));
  box.appendChild(dense(['hand', 'attempts', 'won', 'rate'], s.byHand.map(h => el('tr', {}, [cell(h.hand), cell(h.attempts, 'num'), cell(h.wins, 'num'), cell(Math.round(100 * h.wins / Math.max(1, h.attempts)) + '%', 'num', h.wins / Math.max(1, h.attempts))])), 'hands'));
  box.appendChild(part('walls — fights that took 5 attempts or more · bar: 0 to ' + ATTEMPT_CAP + ' attempts, a tick every ten · click one to read it per foe', 'run-walls'));
  const pick = w => { wallOpen = wallOpen === w.trainer ? null : w.trainer; address(); drawRun().catch(() => {}); };
  box.appendChild(s.walls.length ? dense(['trainer', 'attempts', '0 — ' + ATTEMPT_CAP, 'outcome', 'won by', 'bodies lost in the win'], s.walls.map(w => el('tr', {class: 'go' + (w.cleared ? '' : ' out'), tabindex: '0', 'aria-current': String(wallOpen === w.trainer), on: {click: () => pick(w), keydown: e => { if (e.key === 'Enter') pick(w); }}}, [cell(w.trainer, '', w.order), cell(w.attempts, 'num'), cell(attemptsBar(w.attempts, w.cleared), '', w.attempts), cell(w.cleared ? 'cleared' : 'NOT cleared', w.cleared ? '' : 'loss'), cell(w.wonBy), cell(w.bodiesLostInWin, 'num')])), 'walls') : el('p', {class: 'sub', text: 'none yet'}));
  const wv = el('div', {id: 'wallView'}); box.appendChild(wv); if (wallOpen) await drawWall(wv, mine);
  const full = fullOf(s.roster), six = s.roster.filter(m => m.inParty).length;
  box.appendChild(part('the box — falls ◀ | ▶ knockouts, one unit for both · full half-width = ' + full + ' · amber: knockouts in a fight that cleared a wall', 'run-box'));
  const only = el('button', {'aria-pressed': String(!!prefs.sixOnly), text: 'the six only (' + six + ')', on: {click: () => { prefs.sixOnly = !prefs.sixOnly; keep(); drawRun(); }}});
  box.appendChild(el('div', {class: 'filters'}, [only]));
  box.appendChild(dense(['', 'level', 'falls', 'falls | KOs', 'KOs', 'in wall clears', 'kills with', 'knocked out', 'fell to', 'holds · nature · ability', 'moves', 'caught'], s.roster.filter(m => !prefs.sixOnly || m.inParty).map(m => el('tr', {class: (m.inParty ? 'six' : '') + (m.alive ? '' : ' out')}, [
    cell(m.name + (m.name === m.species ? '' : ' the ' + m.species)), cell('L' + m.level, 'num', m.level), cell(m.falls, 'num'), cell(pair(m.knockouts, m.falls, m.wallKnockouts, full), '', m.knockouts - m.falls), cell(m.knockouts, 'num'), cell(m.wallKnockouts || '', 'num', m.wallKnockouts),
    cell(list(m.bestMoves), 'wrap'), cell(list(m.victims), 'wrap'), cell(list(m.fellTo), 'wrap'), cell([m.item, m.nature, m.ability].filter(Boolean).join(' · ') + (m.ivTotal === null ? '' : ' · IVs ' + m.ivTotal), 'wrap'), cell(m.moves.join(' / '), 'wrap'), cell(m.caught, 'wrap')])), 'box'));
}
// A WALL, one row a foe of theirs: what it costs us each time we meet it, how often it falls, how long it stays,
// what it kills with. Each column is ONE scale down every row, so the foes compare at a glance: the losses' mean
// is a grey dot, the win a black one, and the numbers sit beside them.
// Rounded to twelve figures: 3 × 0.1 is 0.30000000000000004 in floating point, and the caption printed it.
const nice = v => { if (v <= 0) return 1; const step = Math.pow(10, Math.floor(Math.log10(v))); return Number((Math.ceil(v / step) * step).toPrecision(12)); };
function dots(max, loss, win, label) {
  const W = 120, x = v => 4 + Math.max(0, Math.min(1, v / max)) * (W - 8);
  const g = svg('svg', {width: W, height: 12, viewBox: '0 0 ' + W + ' 12', class: 'dots', role: 'img', 'aria-label': label});
  g.appendChild(svg('line', {x1: 4, x2: W - 4, y1: 6, y2: 6, class: 'axis'}));
  if (loss !== null && loss !== undefined) g.appendChild(svg('circle', {cx: x(loss), cy: 6, r: 3, class: 'loss'}));
  if (win !== null && win !== undefined) g.appendChild(svg('circle', {cx: x(win), cy: 6, r: 3, class: 'win'}));
  return g;
}
async function drawWall(box, mine) {
  const w = await (await fetch('/wall?run=' + encodeURIComponent(current) + '&trainer=' + encodeURIComponent(wallOpen))).json(); if (mine !== drawing) return;
  if (w && w.error) { box.appendChild(el('p', {class: 'sub', text: 'cannot read this run for ' + wallOpen + ': ' + w.error})); return; }
  if (!w) { box.appendChild(el('p', {class: 'sub', text: 'this run never fought ' + wallOpen})); return; }
  box.appendChild(part(w.trainer + ' — ' + w.attempts + ' attempts, ' + (w.wonOn ? 'won on attempt ' + w.wonOn : 'never won') + ' · ' + w.logged + ' taped · per foe, most costly first', 'run-wall'));
  const won = w.wonOn !== null;
  const bodies = n => n + ' bod' + (n === 1 ? 'y' : 'ies');
  const maxB = nice(Math.max(0, ...w.foes.map(f => Math.max(f.losses.bodiesPerFacing || 0, f.win ? f.win.bodiesLost : 0))));
  const maxT = nice(Math.max(0, ...w.foes.map(f => Math.max(f.losses.turnsPerFacing || 0, f.win && f.win.turns !== null ? f.win.turns : 0))));
  box.appendChild(el('p', {class: 'sub', text: (won ? 'Grey dot: the mean over the losses that met that foe, which “losses met” counts; black dot: the win. ' : 'Every dot is the mean over the losses that met that foe, which “losses met” counts: there is no win to set beside them. ') +
    'One scale down each column — bodies of ours lost a facing 0 to ' + maxB + ', fell 0 to 100% of facings, turns it stayed 0 to ' + maxT + '. ' +
    'A body is charged to the foe that was acting when it fell: ' + bodies(w.foes.reduce((sum, f) => sum + f.bodiesLost, 0)) + ' here' +
    (w.unattributed + w.hazards + w.selfInflicted ? ', and ' + (w.unattributed + w.hazards + w.selfInflicted) + ' more charged to no foe (below)' : '') + '.'}));
  const num = v => v === null || v === undefined ? '—' : String(v);
  const pct = v => v === null || v === undefined ? '—' : Math.round(100 * v) + '%';
  const key = v => v === null || v === undefined ? -1 : v;
  box.appendChild(dense(['their', 'met', 'losses met', 'bodies a facing', '', 'fell', '', 'turns a facing', '', 'kills with', 'kills'], w.foes.map(f => el('tr', {}, [
    cell(f.foe), cell(f.facedIn, 'num'), cell(f.losses.facedIn, 'num'),
    cell(dots(maxB, f.losses.bodiesPerFacing, f.win && f.win.bodiesLost, f.foe + ': ' + num(f.losses.bodiesPerFacing) + ' bodies a losing facing'), '', key(f.losses.bodiesPerFacing)),
    cell(num(f.losses.bodiesPerFacing) + (f.win ? ' · win ' + f.win.bodiesLost : ''), 'num', key(f.losses.bodiesPerFacing)),
    cell(dots(1, f.losses.fellShare, f.win && (f.win.fell ? 1 : 0), f.foe + ' fell in ' + pct(f.losses.fellShare) + ' of losing facings'), '', key(f.losses.fellShare)),
    cell(pct(f.losses.fellShare) + (f.win ? (f.win.fell ? ' · fell in the win' : ' · stood in the win') : ''), 'num', key(f.losses.fellShare)),
    cell(dots(maxT, f.losses.turnsPerFacing, f.win && f.win.turns, f.foe + ' stayed ' + num(f.losses.turnsPerFacing) + ' turns a losing facing'), '', key(f.losses.turnsPerFacing)),
    cell(num(f.losses.turnsPerFacing) + (f.win && f.win.turns !== null ? ' · win ' + f.win.turns : ''), 'num', key(f.losses.turnsPerFacing)),
    cell(list(f.killers.slice(0, 3)), 'wrap'), cell(list(f.victims.slice(0, 3)), 'wrap')])), 'wallfoes'));
  const apart = [w.unattributed ? bodies(w.unattributed) + ' fell with no actor recorded (end-of-turn damage: weather, status, seeds)' : '',
    w.hazards ? bodies(w.hazards) + ' fell on our own switch (hazards on the way in)' : '',
    w.selfInflicted ? bodies(w.selfInflicted) + ' fell on our own move (recoil, Self-Destruct)' : ''].filter(Boolean);
  if (apart.length) box.appendChild(el('p', {class: 'sub', text: 'Charged to no foe: ' + apart.join('; ') + '.'}));
  if (w.approximate) box.appendChild(el('p', {class: 'sub', text: 'Approximate: this record predates the ledger naming whose side a killer was on, so ours are told from theirs by species — a mirror can be misread.'}));
  // Every attempt, in the order played: above the axis the bodies of theirs it knocked out, below it ours lost, one
  // unit for both — how close each came. Click one to read it on the fight tab.
  const most = Math.max(6, ...w.runs.map(r => Math.max(r.bodiesLost, r.knockouts || 0))), half = 14, step = 6, W = Math.max(40, w.runs.length * step + 2), H = 2 * half + 1;
  const g = svg('svg', {width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'tries', role: 'group', 'aria-label': 'every attempt, in order'});
  g.appendChild(svg('line', {x1: 0, x2: W, y1: half + 0.5, y2: half + 0.5, stroke: 'var(--line)'}));
  w.runs.forEach((r, i) => {
    const up = ((r.knockouts || 0) / most) * (half - 1), down = (r.bodiesLost / most) * (half - 1);
    if (up > 0) { const top = svg('rect', {x: 1 + i * step, y: half - up, width: step - 2, height: up, class: 'ko' + (r.result === 'win' ? ' won' : '')}); top.addEventListener('click', () => openAttempt(r.n)); g.appendChild(top); }
    // No bodies lost draws no bar — a 1.5px one read as a loss — but an outline the height of the lane, to click.
    const bar = svg('rect', {x: 1 + i * step, y: half + 1, width: step - 2, height: down > 0 ? down : half - 1, tabindex: '0',
      class: (r.result === 'win' ? 'won' : r.hasLog ? '' : 'untaped') + (down > 0 ? '' : ' none') + (pinned === r.n ? ' at' : '')},
      [tip('attempt ' + (i + 1) + ' · ' + r.result + ' · ' + r.policy + ' · ' + (r.knockouts === null ? '' : r.knockouts + ' of theirs down · ') + r.bodiesLost + ' of ours lost' + (r.foeLeft === null ? '' : ' · ' + r.foeLeft + ' of theirs left') + (r.hasLog ? '' : ' · no tape'))]);
    bar.addEventListener('click', () => openAttempt(r.n)); bar.addEventListener('keydown', e => { if (e.key === 'Enter') openAttempt(r.n); });
    g.appendChild(bar);
  });
  box.appendChild(part('every attempt, in order — above: theirs knocked out · below: ours lost · 0 to ' + most + ' each way' + (won ? ' · green: the win' : '') + ' · click one to read it on the fight tab', 'run-tries'));
  box.appendChild(g);
  if (won) {
    const lift = w.tagLift.filter(t => HOT.has(t.tag) || WARN.has(t.tag)).slice().sort((a, b) => Math.abs(b.win - b.lossMean) - Math.abs(a.win - a.lossMean)).slice(0, 10);
    const maxL = nice(Math.max(0, ...lift.map(t => Math.max(t.win, t.lossMean))));
    box.appendChild(part('what the win did — turns of each kind, the win (black) beside the losses’ mean (grey), 0 to ' + maxL, 'run-lift'));
    box.appendChild(dense(['kind of turn', '', 'win', 'losses'], lift.map(t => el('tr', {}, [cell(t.tag, HOT.has(t.tag) ? '' : 'loss'), cell(dots(maxL, t.lossMean, t.win, t.tag + ': ' + t.win + ' in the win, ' + t.lossMean + ' a loss'), '', t.win - t.lossMean), cell(t.win, 'num'), cell(t.lossMean, 'num')])), 'walllift'));
  }
}
// A past attempt, on the fight tab: the live file holds only the one being played, the run's sidecar every other.
function openAttempt(n) { pinned = n; view = 'fight'; address(); views(); }
async function showPast() {
  const want = pinned; const a = await (await fetch('/attempt?run=' + encodeURIComponent(current) + '&n=' + want)).json(); if (want !== pinned) return;
  const sub = document.getElementById('sub');
  if (a && a.error) { sub.textContent = 'cannot read attempt ' + want + ': ' + a.error; return; }
  if (!a) { sub.textContent = 'attempt ' + want + ' is not in this run’s record'; return; }
  attempt = 'past:' + a.n; seen = -1; held = [];
  document.body.className = 'done';
  document.getElementById('title').textContent = a.trainer + ' — attempt ' + a.attempt + ' of ' + a.of;
  const go = (label, n) => el('button', Object.assign({text: label, on: {click: () => { if (n !== null) openAttempt(n); }}}, n === null ? {disabled: ''} : {}));
  sub.replaceChildren(document.createTextNode('a past attempt · fight ' + a.n + ' of the run · played by ' + a.policy + ' · ' + a.result.toUpperCase() + ' · ' + a.killers.length + ' of ours lost '),
    go('◀ earlier', a.prev), go('later ▶', a.next), el('button', {text: 'back to the live fight', on: {click: () => { pinned = null; attempt = null; shown = []; address(); redraw(); tick(); }}}));
  document.getElementById('six').textContent = 'Our six: ' + a.six.map(m => m.name + ' the ' + m.species + (m.item ? ' @ ' + m.item : '')).join(' · ');
  if (a.events) {
    // A faint carries no turn on the tape: it belongs to the turn just played.
    const turns = []; for (const e of a.events) { let t = turns[turns.length - 1]; if (!t || (e.turn !== null && t.turn !== e.turn)) { t = {turn: e.turn, double: true, events: [], tags: []}; turns.push(t); } t.events.push(e.text); for (const tag of e.tags) if (!t.tags.includes(tag)) t.tags.push(tag); }
    shown = turns;
  } else shown = a.turns;
  if (!shown.length) document.getElementById('turns').replaceChildren(el('p', {class: 'sub', text: 'this attempt kept no tape'}));
  else redraw();
}
async function drawFleet() {
  const box = document.getElementById('fleetView'); const mine = ++drawing; const f = await (await fetch('/fleet')).json(); if (mine !== drawing) return; box.replaceChildren();
  if (!f) { box.appendChild(el('p', {class: 'sub', text: 'no run here has a record or a checkpoint yet'})); return; }
  box.appendChild(jump([['fleet-runs', 'seeds (' + f.seeds.length + ')'], ['fleet-walls', 'walls (' + f.walls.length + ')'], ['fleet-species', 'species (' + f.species.length + ')']]));
  // One seed is one journey, however many directories it was played in. Its legs sit under it, in the order they
  // began; a leg in grey began where another of the seed began and got less far (a measurement arm), and is not counted.
  box.appendChild(part('seeds — one row a journey, its legs beneath · click a leg to open it', 'fleet-runs'));
  const t = el('table', {class: 'dense'}); t.appendChild(el('thead', {}, [el('tr', {}, ['seed / leg', 'state', 'from', 'reached', 'trainers', 'attempts', 'a trainer', 'first try', 'stopped at', 'min'].map(h => el('th', {text: h})))]));
  const body = document.createElement('tbody'); t.appendChild(body);
  for (const seed of f.seeds) {
    body.appendChild(el('tr', {class: 'seed'}, [cell('seed ' + seed.seed + (seed.starter ? ' · ' + seed.starter : '')), cell(seed.finished ? 'FINISHED' : seed.playing ? 'playing' : 'stopped', seed.finished ? 'win' : ''), cell(''), cell(seed.position, 'num'), cell(''), cell(seed.attempts, 'num'), cell(''), cell(''), cell(seed.stoppedAt.map(w => w.replace(/^(Leader|Trainer) /, '')).join(', '), 'wrap' + (seed.stoppedAt.length ? ' loss' : '')), cell('')]));
    for (const leg of seed.legs) { const r = leg.summary; body.appendChild(el('tr', {class: 'go leg' + (leg.counted ? '' : ' out'), tabindex: '0', title: leg.counted ? '' : 'began where another leg of this seed began and got less far: not counted in the tables below', on: {click: () => open(leg.run, 'run'), keydown: e => { if (e.key === 'Enter') open(leg.run, 'run'); }}},
      [cell(leg.run), cell(r.state === 'playing' ? 'playing' : r.state === 'finished' ? 'FINISHED' : 'ended'), cell(r.startedAt, 'num'), cell(r.position, 'num'), cell(r.trainersBeaten, 'num'), cell(r.attempts, 'num'), cell(r.attemptsPerTrainer, 'num'), cell(r.trainersBeaten ? Math.round(100 * r.firstTry / r.trainersBeaten) + '%' : '', 'num'), cell(r.walls.filter(w => !w.cleared).map(w => w.trainer.replace(/^(Leader|Trainer) /, '')).join(', '), 'wrap'), cell(r.minutes, 'num')])); }
  }
  box.appendChild(t);
  box.appendChild(part('walls across runs — bar: median attempts, 0 to ' + ATTEMPT_CAP + ', the same scale as the walls of one run', 'fleet-walls'));
  box.appendChild(dense(['trainer', 'seeds that hit it', 'cleared', 'median attempts', '0 — ' + ATTEMPT_CAP, 'attempts in all'], f.walls.map(w => el('tr', {}, [cell(w.trainer, '', w.order), cell(w.runsMet, 'num'), cell(w.runsCleared + ' of ' + w.runsMet, w.runsCleared < w.runsMet ? 'loss' : '', w.runsCleared / Math.max(1, w.runsMet)), cell(w.medianAttempts, 'num'), cell(attemptsBar(w.medianAttempts, w.runsCleared === w.runsMet), '', w.medianAttempts), cell(w.attempts, 'num')])), 'fwalls'));
  const full = fullOf(f.species);
  box.appendChild(part('species across runs — falls ◀ | ▶ knockouts, one unit for both · full half-width = ' + full, 'fleet-species'));
  box.appendChild(dense(['species', 'seeds', 'falls', 'falls | KOs', 'KOs', 'in wall clears', 'KOs a fall'], f.species.map(m => el('tr', {}, [cell(m.species), cell(m.runs, 'num'), cell(m.falls, 'num'), cell(pair(m.knockouts, m.falls, m.wallKnockouts, full), '', m.knockouts - m.falls), cell(m.knockouts, 'num'), cell(m.wallKnockouts, 'num'), cell(m.falls ? (m.knockouts / m.falls).toFixed(1) : '—', 'num', m.falls ? m.knockouts / m.falls : 999)])), 'species'));
}
let view = 'fight';
// The page's state is its address: #run=LABEL/run-SEED&view=run. A view can be linked, reloaded and gone Back to.
function address() { const want = '#' + (current ? 'run=' + encodeURIComponent(current) + '&' : '') + 'view=' + view + (wallOpen ? '&wall=' + encodeURIComponent(wallOpen) : '') + (pinned !== null ? '&n=' + pinned : ''); if (location.hash !== want) history.pushState(null, '', want); }
function fromAddress() { const q = new URLSearchParams(location.hash.slice(1)); const v = q.get('view'); if (v === 'fight' || v === 'run' || v === 'fleet') view = v; wallOpen = q.get('wall') || null; pinned = q.get('n') ? Number(q.get('n')) : null; if (pinned === null && String(attempt).startsWith('past:')) { attempt = null; shown = []; redraw(); } const r = q.get('run'); if (r && r !== current) { current = r; seen = -1; attempt = null; shown = []; held = []; lastOverview = ''; redraw(); } }
function open(run, to) { if (run && run !== current) { current = run; seen = -1; attempt = null; shown = []; held = []; wallOpen = null; pinned = null; redraw(); } if (to) view = to; lastOverview = ''; address(); views(); runs(); }
function views() {
  const box = document.getElementById('views'); box.replaceChildren();
  [['fight', 'the fight', '1'], ['run', 'this run', '2'], ['fleet', 'all runs', '3']].forEach(v => box.appendChild(el('button', {'aria-pressed': String(view === v[0]), title: 'key ' + v[2], text: v[1], on: {click: () => { prefs.view = v[0]; keep(); open(null, v[0]); }}})));
  box.appendChild(el('span', {class: 'sub', text: current ? '  ' + current : ''}));
  document.getElementById('fightView').hidden = view !== 'fight'; document.getElementById('runView').hidden = view !== 'run'; document.getElementById('fleetView').hidden = view !== 'fleet';
  if (view === 'run') drawRun().catch(() => {}); if (view === 'fleet') drawFleet().catch(() => {}); if (view === 'fight' && pinned !== null) showPast().catch(() => {});
}
// 1 2 3 change the view; [ and ] step through the runs in the table above.
document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const to = {'1': 'fight', '2': 'run', '3': 'fleet'}[e.key]; if (to) { open(null, to); return; }
  if (e.key === '[' || e.key === ']') { const names = [...document.querySelectorAll('#overview tr[data-run]')].map(r => r.getAttribute('data-run')); if (!names.length) return; const at = names.indexOf(current); open(names[(at + (e.key === ']' ? 1 : names.length - 1) + names.length) % names.length], null); }
});
window.addEventListener('popstate', () => { fromAddress(); views(); runs(); });
function card(t) {
  const c = el('div', {class: 'turn'});
  if (t.double) {
    c.appendChild(el('div', {class: 'head'}, [el('b', {text: t.turn === null ? '—' : 'T' + t.turn})]));
    const tags = el('div'); for (const tag of t.tags) tags.appendChild(el('span', {class: 'tag' + (HOT.has(tag) ? ' hot' : WARN.has(tag) ? ' warn' : ''), text: tag})); c.appendChild(tags);
    const ev = el('ul', {class: 'events'}); for (const e of t.events) ev.appendChild(el('li', {text: e})); c.appendChild(ev);
    return c;
  }
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
  for (const w of r.walls) { const h = Math.max(2, Math.min(1, w.attempts / ATTEMPT_CAP) * (H - 3)); g.appendChild(svg('line', {x1: x(w.road), x2: x(w.road), y1: H - 2, y2: H - 2 - h, class: w.won ? 'wall' : 'wall lost'}, [tip('#' + w.road + ' ' + w.trainer + ': ' + w.attempts + ' attempts, ' + (w.won ? 'won' : 'never won'))])); }
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
  const line = r => table.appendChild(el('tr', {class: r.live ? '' : 'over', 'data-run': r.run, 'aria-current': String(r.run === current), on: {click: () => open(r.run, null)}}, [
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
  if (!current || pinned !== null) return;
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
view = prefs.view || 'fight'; fromAddress(); controls(); views(); quiet(runs)(); setInterval(quiet(runs), 3000); setInterval(quiet(tick), 1000);
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

/** A run that could not be read, and why: the watch page shows `said`, never "it kept nothing". */
export class Unreadable extends Error {
	constructor(readonly said: string) { super(said); }
}

/**
 * A run with every fight it kept: its record or newer checkpoint, and its
 * sidecar. Megabytes to decode, so it is kept until either file changes.
 *
 * A record that does not decode REJECTS with the reason. It used to read as
 * null, and the page said "this run kept nothing to read" of clear1's 104770,
 * which kept 358 fights and failed on one null in a race.
 */
const fought = new Map<string, {at: string; run: RunRecord}>();
export const loadFought = async (dir: string, run: string): Promise<RunRecord> => {
	const report = path.join(dir, run + '.json');
	const file = await currentOf(report);
	const stamps = await Promise.all([file, sidecarOf(report)].map(name => fs.stat(name).then(stat => String(stat.mtimeMs), () => '-')));
	const at = file + ':' + stamps.join(':');
	const kept = fought.get(report);
	if (kept !== undefined && kept.at === at) return kept.run;
	const loaded = await Effect.runPromise(Effect.either(loadRunWithFights(report)));
	if (loaded._tag === 'Left') throw new Unreadable(describeFailure(loaded.left));
	fought.set(report, {at, run: loaded.right});
	return loaded.right;
};

/** One wall of a run, per foe (analyse.ts wallView); null when the run never fought that trainer. */
export const loadWall = async (dir: string, run: string, trainer: string): Promise<WallView | null> =>
	wallView(await loadFought(dir, run), trainer);

/**
 * Any attempt the run kept, as the fight tab draws it: a single's turns,
 * tagged as a live turn is, or a double's tape, each line read. The live
 * file holds only the attempt being played; this is every other one.
 */
export const loadAttempt = async (dir: string, run: string, n: number) => {
	const record = await loadFought(dir, run);
	const attempt = record.ledger.find(entry => entry.n === n);
	if (attempt === undefined) return null;
	const same = record.ledger.filter(entry => entry.order === attempt.order && entry.trainer === attempt.trainer);
	const ours = new Set((attempt.six ?? []).map(member => member.species));
	const log = attempt.log ?? [];
	const at = same.indexOf(attempt);
	return {n: attempt.n, trainer: attempt.trainer, order: attempt.order, attempt: at + 1, of: same.length,
		prev: same[at - 1]?.n ?? null, next: same[at + 1]?.n ?? null,
		result: attempt.result, policy: attempt.policy ?? 'decide', seed: attempt.seed, six: attempt.six ?? [],
		killers: attempt.killers ?? [], kos: attempt.kos ?? [],
		turns: log.map(turn => ({...turn, tags: tagsOf(turn)})),
		events: log.length === 0 && attempt.events !== undefined ?
			attempt.events.map(event => ({turn: event.turn ?? null, text: event.text, tags: readDoublesLine(event, ours)?.tags ?? []})) : null};
};

const RUN_NAME = /^([A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/;

/**
 * A run is named LABEL/run-SEED (or run-SEED); anything else is refused, so a
 * name can never walk out of the directory being watched. One rule for every
 * route that takes a run: it was written out five times.
 */
export const guardRun = (run: string): boolean => RUN_NAME.test(run) && !run.includes('..');

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
	const send = (res: http.ServerResponse, type: string, body: string, status = 200): void => {
		res.writeHead(status, {'content-type': type, 'cache-control': 'no-store'});
		res.end(body);
	};
	// A run that cannot be read says why, with a status that is not 200.
	const failed = (res: http.ServerResponse) => (error: unknown): void =>
		send(res, 'application/json', JSON.stringify({error: error instanceof Unreadable ? error.said : String(error)}), 500);
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
			if (!guardRun(run)) { res.writeHead(400); res.end('bad run name'); return; }
			void loadSummary(dir, run).then(summary => send(res, 'application/json', JSON.stringify(summary)));
			return;
		}
		if (url.pathname === '/wall') {
			const run = url.searchParams.get('run') ?? '';
			if (!guardRun(run)) { res.writeHead(400); res.end('bad run name'); return; }
			void loadWall(dir, run, url.searchParams.get('trainer') ?? '').then(view => send(res, 'application/json', JSON.stringify(view)),
				failed(res));
			return;
		}
		if (url.pathname === '/attempt') {
			const run = url.searchParams.get('run') ?? '';
			if (!guardRun(run)) { res.writeHead(400); res.end('bad run name'); return; }
			void loadAttempt(dir, run, Number(url.searchParams.get('n'))).then(found => send(res, 'application/json', JSON.stringify(found)),
				failed(res));
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
			if (req.method !== 'POST' || req.headers['x-insight'] !== '1' || !guardRun(run) ||
				!/^(stop|pause|cont)$/.test(action)) { res.writeHead(400); res.end('refused'); return; }
			void control(dir, run, action as 'stop' | 'pause' | 'cont').then(said => send(res, 'application/json', JSON.stringify(said)));
			return;
		}
		if (url.pathname === '/state') {
			const run = url.searchParams.get('run') ?? '';
			if (!guardRun(run)) { res.writeHead(400); res.end('bad run name'); return; }
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
