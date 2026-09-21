/**
 * One self-contained page: the road, the attempts at a fight, the fight.
 *
 * Deliberately small. No framework, no server, no build step for the page —
 * the data is embedded and the page is a file. Earlier UI work in this project
 * was effort the game never saw, so this does one job: let a person dig from
 * "which walls cost us" to "what happened on turn nine, what else was on
 * offer, and what did the search think of it".
 */
import type {RunRecord} from './schema.js';
import {walls, type WallSummary} from './analyse.js';
import {tagsOf} from './tags.js';

interface PageData {
	readonly title: string;
	readonly walls: ReadonlyArray<WallSummary>;
	readonly fights: Readonly<Record<string, unknown>>;
}

const escapeForScript = (json: string): string => json.replace(/</g, '\\u003c');

export function pageData(run: RunRecord, title: string): PageData {
	const fights: Record<string, unknown> = {};
	for (const attempt of run.ledger) {
		if (attempt.log === undefined || attempt.log.length === 0) continue;
		fights[String(attempt.n)] = {
			six: attempt.six ?? [],
			killers: attempt.killers ?? [],
			kos: attempt.kos ?? [],
			probe: attempt.probe ?? null,
			turns: attempt.log.map(turn => ({...turn, tags: tagsOf(turn)})),
		};
	}
	return {title, walls: walls(run), fights};
}

const STYLE = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--mute:#6f6b63;--line:#e2ded5;--card:#fff;--win:#1f7a4d;--loss:#a3342b;--tag:#ece7dc;--hot:#b4690e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161513;--fg:#ece8df;--mute:#9a958a;--line:#2e2c28;--card:#1e1d1a;--win:#5fc48f;--loss:#e5766c;--tag:#2a2824;--hot:#e0a04a}}
:root[data-theme=dark]{--bg:#161513;--fg:#ece8df;--mute:#9a958a;--line:#2e2c28;--card:#1e1d1a;--win:#5fc48f;--loss:#e5766c;--tag:#2a2824;--hot:#e0a04a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}
header{padding:12px 16px;border-bottom:1px solid var(--line)}h1{font-size:16px;margin:0}header p{margin:2px 0 0;color:var(--mute)}
main{display:grid;grid-template-columns:260px 300px 1fr;height:calc(100vh - 58px)}
@media (max-width:900px){main{grid-template-columns:1fr;height:auto}section{max-height:none!important}}
section{overflow:auto;border-right:1px solid var(--line);padding:8px}
h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:6px 8px}
button.row{display:block;width:100%;text-align:left;background:none;border:0;border-radius:6px;padding:6px 8px;color:inherit;font:inherit;cursor:pointer}
button.row:hover{background:var(--tag)}button.row[aria-current=true]{background:var(--card);box-shadow:inset 0 0 0 1px var(--line)}
.sub{color:var(--mute);font-size:12px}.win{color:var(--win)}.loss{color:var(--loss)}
.bar{display:inline-block;height:6px;border-radius:3px;background:var(--line);width:70px;vertical-align:middle;overflow:hidden}.bar i{display:block;height:100%;background:var(--win)}.bar.foe i{background:var(--loss)}
.turn{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0 0 8px}
.turn .head{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}.turn b{font-weight:600}
.tag{display:inline-block;background:var(--tag);border-radius:10px;padding:0 7px;font-size:11px;margin:2px 3px 0 0}.tag.hot{color:var(--hot)}
.events{margin:6px 0 0;padding-left:16px;color:var(--mute)}details{margin-top:6px}summary{cursor:pointer;color:var(--mute);font-size:12px}
table{border-collapse:collapse;font-size:12px;margin-top:4px}td,th{padding:2px 8px 2px 0;text-align:left}th{color:var(--mute);font-weight:500}
.chosen{font-weight:600}.lift{font-size:12px;margin:4px 8px 10px}.lift span{margin-right:10px;white-space:nowrap}
.filters{margin:0 0 8px}.filters button{font:inherit;font-size:12px;border:1px solid var(--line);background:none;color:inherit;border-radius:10px;padding:1px 8px;margin:0 4px 4px 0;cursor:pointer}.filters button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
`;

const SCRIPT = `
const DATA = JSON.parse(document.getElementById('data').textContent);
const HOT = new Set(['speed-control','status','set-up','sack','pivot','search-overrode','screen','hazard','disrupt','priority']);
let wall = null, attempt = null, filter = null;
const el = (tag, attrs, kids) => { const n = document.createElement(tag); for (const k in (attrs||{})) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'on') for (const e in attrs.on) n.addEventListener(e, attrs.on[e]); else n.setAttribute(k, attrs[k]); } for (const kid of (kids||[])) n.appendChild(kid); return n; };
const bar = (pct, foe) => el('span', {class: 'bar' + (foe ? ' foe' : '')}, [el('i', {style: 'width:' + Math.max(0, Math.min(100, pct)) + '%'})]);
function drawWalls() {
  const box = document.getElementById('walls'); box.replaceChildren(el('h2', {text: 'The road — fights that took more than one attempt, or were logged'}));
  for (const w of DATA.walls.filter(w => w.attempts > 1 || w.logged > 0)) {
    box.appendChild(el('button', {class: 'row', 'aria-current': String(wall === w), on: {click: () => { wall = w; attempt = null; filter = null; draw(); }}}, [
      el('div', {text: w.trainer}),
      el('div', {class: 'sub ' + (w.wonOn ? 'win' : 'loss'), text: (w.wonOn ? 'won on attempt ' + w.wonOn : 'never won') + ' of ' + w.attempts + ' · ' + w.logged + ' logged'})]));
  }
}
function drawAttempts() {
  const box = document.getElementById('attempts'); box.replaceChildren(el('h2', {text: wall ? wall.trainer : 'Pick a fight'}));
  if (!wall) return;
  const lift = el('div', {class: 'lift'}, [el('div', {class: 'sub', text: 'turns per attempt — in the win vs the losses'})]);
  for (const t of wall.tagLift.filter(t => HOT.has(t.tag)).slice(0, 8)) lift.appendChild(el('span', {text: t.tag + ' ' + t.win + ' vs ' + t.lossMean}));
  box.appendChild(lift);
  for (const s of wall.summaries) {
    box.appendChild(el('button', {class: 'row', 'aria-current': String(attempt === s), on: {click: () => { attempt = s; filter = null; draw(); }}}, [
      el('div', {}, [el('span', {class: s.result === 'win' ? 'win' : 'loss', text: '#' + (wall.summaries.indexOf(s) + 1) + ' ' + s.result}), el('span', {class: 'sub', text: '  ' + s.policy + (s.turns ? ' · ' + s.turns + ' turns' : '')})]),
      el('div', {class: 'sub', text: (s.foeLeft === null ? '' : s.foeLeft + ' of theirs left · ') + s.bodiesLost + ' of ours lost' + (s.lead ? ' · led ' + s.lead : '') + (s.hasLog ? '' : ' · no log')})]));
  }
}
function drawFight() {
  const box = document.getElementById('fight'); box.replaceChildren();
  if (!attempt) { box.appendChild(el('h2', {text: 'Pick an attempt'})); return; }
  const f = DATA.fights[String(attempt.n)];
  box.appendChild(el('h2', {text: 'Attempt ' + (wall.summaries.indexOf(attempt) + 1) + ' — seed ' + attempt.seed + ' — ' + attempt.order.join(' → ')}));
  if (!f) { box.appendChild(el('p', {class: 'sub', text: 'This attempt was played before fight logs were kept. Replay it with scripts/how-it-won.js.'})); return; }
  const six = el('details', {}, [el('summary', {text: 'Our six, and what each of theirs cost'})]);
  const t1 = el('table'); t1.appendChild(el('tr', {}, ['name','item','ability','nature','moves'].map(h => el('th', {text: h}))));
  for (const m of f.six) t1.appendChild(el('tr', {}, [m.name + ' (' + m.species + ' L' + m.level + ')', m.item || '—', m.ability || '—', m.nature || '—', m.moves.join(', ')].map(v => el('td', {text: v}))));
  const t2 = el('table'); t2.appendChild(el('tr', {}, ['their Pokémon','turns','ours lost to it','fell?'].map(h => el('th', {text: h}))));
  for (const c of attempt.foeCosts) t2.appendChild(el('tr', {}, [c.foe, c.turns, c.bodiesLost, c.fell ? 'yes' : 'no'].map(v => el('td', {text: String(v)}))));
  six.appendChild(t1); six.appendChild(t2); box.appendChild(six);
  const present = [...new Set(f.turns.flatMap(t => t.tags))];
  const filters = el('div', {class: 'filters'});
  for (const tag of present) filters.appendChild(el('button', {'aria-pressed': String(filter === tag), text: tag, on: {click: () => { filter = filter === tag ? null : tag; drawFight(); }}}));
  box.appendChild(filters);
  for (const t of f.turns.filter(t => !filter || t.tags.includes(filter))) {
    const card = el('div', {class: 'turn'});
    card.appendChild(el('div', {class: 'head'}, [el('b', {text: 'T' + t.turn}), el('span', {}, [document.createTextNode(t.us + ' '), bar(t.usHp), document.createTextNode(' ' + t.usHp + '%')]), el('span', {class: 'sub', text: 'vs'}), el('span', {}, [document.createTextNode(t.foe + ' '), bar(t.foeHp, true), document.createTextNode(' ' + t.foeHp + '%')]), el('span', {class: 'chosen', text: '→ ' + t.chose}), el('span', {class: 'sub', text: t.why || ''})]));
    const tags = el('div'); for (const tag of t.tags) tags.appendChild(el('span', {class: 'tag' + (HOT.has(tag) ? ' hot' : ''), text: tag})); card.appendChild(tags);
    const ev = el('ul', {class: 'events'}); for (const e of t.events) ev.appendChild(el('li', {text: e})); card.appendChild(ev);
    const more = el('details', {}, [el('summary', {text: 'what was on offer' + (t.scores && t.scores.length ? ', and what the search thought' : '')})]);
    if (t.threat) more.appendChild(el('div', {class: 'sub', text: t.threat}));
    const tbl = el('table'); tbl.appendChild(el('tr', {}, ['option','forecast / race','search value (rollouts)'].map(h => el('th', {text: h}))));
    const score = name => (t.scores || []).find(s => s.choice === name);
    for (const m of (t.options ? t.options.moves : [])) { const s = score(m.move); tbl.appendChild(el('tr', {class: m.move === t.chose ? 'chosen' : ''}, [m.move, m.damage || 'no damage', s ? s.value + ' (' + s.runs + ')' : ''].map(v => el('td', {text: v})))); }
    for (const w of (t.options ? t.options.switches : [])) { const name = 'switch to ' + w.label.replace(/\\s+\\d+%$/, ''); const s = score(name); const d = w.raceDetail; tbl.appendChild(el('tr', {class: name === t.chose ? 'chosen' : ''}, [name + ' (' + w.label.replace(/^.*\\s/, '') + ')', (w.race || '—') + (d ? ' — need ' + d.turnsToKill + ', they need ' + d.turnsToDie : ''), s ? s.value + ' (' + s.runs + ')' : ''].map(v => el('td', {text: v})))); }
    more.appendChild(tbl); card.appendChild(more); box.appendChild(card);
  }
}
function draw() { drawWalls(); drawAttempts(); drawFight(); }
draw();
`;

export function renderPage(run: RunRecord, title: string): string {
	const data = pageData(run, title);
	const played = run.ledger.length;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fight Log</title><style>${STYLE}</style></head><body>
<header><h1>${title.replace(/[<&]/g, '')}</h1><p>${played} attempts · reached position ${run.position} · ${run.finished === true ? 'finished' : String(run.stopped ?? 'in progress').replace(/[<&]/g, '').slice(0, 90)}</p></header>
<main><section id="walls"></section><section id="attempts"></section><section id="fight" style="border-right:0"></section></main>
<script type="application/json" id="data">${escapeForScript(JSON.stringify(data))}</script><script>${SCRIPT}</script></body></html>`;
}
