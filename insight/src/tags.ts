/**
 * What kind of turn was that?
 *
 * A fight is won by control — the operator's correction to a report that read
 * it as one-on-ones — so a turn is read for what it DID to the fight, not only
 * for its damage. Every tag here is a way of taking or losing control that a
 * player would name out loud. They are read off the turn as it was logged:
 * the choice, what the screen offered, what the search scored, what happened.
 */
import type {Turn} from './schema.js';

export type Tag =
	| 'speed-control' | 'status' | 'set-up' | 'screen' | 'hazard' | 'protect' | 'disrupt'
	| 'pivot' | 'pivot-move' | 'sack' | 'forced' | 'priority' | 'recovery'
	| 'we-ko' | 'we-fall' | 'crit-ours' | 'crit-theirs' | 'miss-ours' | 'miss-theirs'
	| 'search-overrode' | 'lost-race' | 'foe-set-up' | 'foe-recovered'
	| 'we-move-first' | 'they-move-first' | 'coin-flip' | 'clear-choice'
	| 'self-ko' | 'sacrifice-forced' | 'sacrifice-chosen' | 'sacrifice-unforced';

const moves = (list: string): RegExp => new RegExp('^(' + list + ')$');

const SPEED = moves('Tailwind|Thunder Wave|Icy Wind|Bulldoze|Electroweb|Rock Tomb|Glare|Stun Spore|Nuzzle|Trick Room|Sticky Web|String Shot|Scary Face|Cotton Spore|Low Sweep|Mud Shot');
const STATUS = moves('Will-O-Wisp|Toxic|Spore|Sleep Powder|Hypnosis|Yawn|Poison Powder|Sing|Lovely Kiss|Dark Void|Confuse Ray|Supersonic|Swagger|Leech Seed');
const SETUP = moves('Swords Dance|Dragon Dance|Calm Mind|Nasty Plot|Bulk Up|Quiver Dance|Shell Smash|Work Up|Coil|Agility|Rock Polish|Growth|Curse|Belly Drum|Shift Gear|Tail Glow|Hone Claws|Iron Defense|Amnesia|Cosmic Power|Power-Up Punch|Meteor Beam');
const SCREEN = moves('Reflect|Light Screen|Aurora Veil|Safeguard|Mist');
const HAZARD = moves('Stealth Rock|Spikes|Toxic Spikes|Sticky Web');
const PROTECT = moves('Protect|Detect|Substitute|King\'s Shield|Spiky Shield|Baneful Bunker|Endure');
const DISRUPT = moves('Fake Out|Taunt|Encore|Disable|Knock Off|Roar|Whirlwind|Dragon Tail|Circle Throw|Haze|Clear Smog|Trick|Switcheroo|Parting Shot|Charm|Growl|Baby-Doll Eyes|Play Nice|Feather Dance|Memento');
const PIVOT_MOVE = moves('U-turn|Volt Switch|Flip Turn|Baton Pass|Parting Shot|Teleport');
const PRIORITY = moves('Quick Attack|Mach Punch|Bullet Punch|Ice Shard|Aqua Jet|Sucker Punch|Shadow Sneak|Extreme Speed|Vacuum Wave|Accelerock|Water Shuriken|First Impression|Fake Out|Feint');
const SELF_KO = moves('Self-Destruct|Explosion|Misty Explosion|Memento|Final Gambit|Healing Wish|Lunar Dance');
const RECOVERY = moves('Recover|Roost|Soft-Boiled|Slack Off|Synthesis|Moonlight|Morning Sun|Milk Drink|Shore Up|Rest|Wish|Heal Order|Strength Sap|Life Dew|Drain Punch|Giga Drain|Leech Life|Draining Kiss|Horn Leech');

/** Search values closer than this are one decision's noise; further apart than CLEAR, a real preference. */
export const COIN_FLIP = 0.02;
export const CLEAR = 0.1;

/** The species part of a view name such as "Luxray L65 · par". */
export const speciesOf = (shown: string): string => shown.replace(/\s+L\d+.*$/, '').trim();

/** The floor of a forecast such as "83%+ up to 100%", or 0 when there is none. */
const floorOf = (damage: string | null): number => {
	const hit = damage === null ? null : /(\d+)%/.exec(damage);
	return hit && hit[1] !== undefined ? Number(hit[1]) : 0;
};

/** What a move is, as control: the tags a player would give it wherever it is played. */
export function moveTags(move: string): ReadonlyArray<Tag> {
	const tags: Tag[] = [];
	if (SPEED.test(move)) tags.push('speed-control');
	if (STATUS.test(move)) tags.push('status');
	if (SETUP.test(move)) tags.push('set-up');
	if (SCREEN.test(move)) tags.push('screen');
	if (HAZARD.test(move)) tags.push('hazard');
	if (PROTECT.test(move)) tags.push('protect');
	if (DISRUPT.test(move)) tags.push('disrupt');
	if (PIVOT_MOVE.test(move)) tags.push('pivot-move');
	if (PRIORITY.test(move)) tags.push('priority');
	if (RECOVERY.test(move)) tags.push('recovery');
	return tags;
}

/** A Mega or regional suffix off a tape name, so it matches the six. */
const baseOf = (species: string): string => species.replace(/-Mega(-[XY])?$/, '');

export interface DoublesLine {
	readonly turn: number | null;
	readonly side: 'ours' | 'theirs';
	readonly actor: string;
	readonly move: string | null;
	readonly targets: ReadonlyArray<string>;
	/**
	 * The targets the line shows damage on (" -N%"; the driver writes it only
	 * when HP was lost, so -0% is a rounded scratch): a miss, a Protect or a
	 * status move carries no mark and is no hit.
	 */
	readonly hit: ReadonlyArray<string>;
	readonly fainted: boolean;
	readonly tags: ReadonlyArray<Tag>;
}

/**
 * One line of a double's tape, read. A double has no one-active view, so
 * there is no turn to tag the way tagsOf does; each line is tagged instead.
 * Whose line it was comes from `side` when the tape has it (2026-09-22 on),
 * and otherwise from the six — which cannot tell a mirror apart.
 */
export function readDoublesLine(event: {readonly turn?: number | null | undefined; readonly text: string;
	readonly side?: 'ours' | 'theirs' | undefined}, ours: ReadonlySet<string>): DoublesLine | null {
	const fell = /^(.+?) fainted!/.exec(event.text);
	const used = /^(.+?) used (.+?)(?: → (.*?))?((?: \([a-z]+\))*)$/.exec(event.text);
	const actor = fell?.[1] ?? used?.[1];
	if (actor === undefined) return null;
	const side = event.side ?? (ours.has(baseOf(actor)) ? 'ours' : 'theirs');
	const turn = event.turn ?? null;
	if (fell) return {turn, side, actor, move: null, targets: [], hit: [], fainted: true, tags: [side === 'ours' ? 'we-fall' : 'we-ko']};
	const move = used?.[2] ?? '';
	const marks = used?.[4] ?? '';
	const aimed = (used?.[3] ?? '').split(', ').filter(Boolean);
	const targets = aimed.map(hit => hit.replace(/ -\d+%$/, ''));
	const hit = aimed.filter(target => / -\d+%$/.test(target)).map(target => target.replace(/ -\d+%$/, ''));
	const tags: Tag[] = [];
	const failed = /\((sleep|flinch|freeze|paralysis|confusion|infatuation|protect|truant)\)/.test(marks);
	if (side === 'ours') tags.push(...moveTags(move));
	else {
		if (SETUP.test(move)) tags.push('foe-set-up');
		if (RECOVERY.test(move)) tags.push('foe-recovered');
	}
	if (/\(missed\)/.test(marks)) tags.push(side === 'ours' ? 'miss-ours' : 'miss-theirs');
	if (/\(crit\)/.test(marks)) tags.push(side === 'ours' ? 'crit-ours' : 'crit-theirs');
	return {turn, side, actor, move: failed ? null : move, targets, hit, fainted: false, tags};
}

export function tagsOf(turn: Turn): ReadonlyArray<Tag> {
	const tags = new Set<Tag>();
	const chose = turn.chose;
	const switching = chose.startsWith('switch to ');
	const forced = turn.why === 'forced replacement' || turn.phase === 'replace';
	const mine = speciesOf(turn.us);
	const theirs = speciesOf(turn.foe);

	if (forced) tags.add('forced');
	else if (switching) tags.add('pivot');
	if (SPEED.test(chose)) tags.add('speed-control');
	if (STATUS.test(chose)) tags.add('status');
	if (SETUP.test(chose)) tags.add('set-up');
	if (SCREEN.test(chose)) tags.add('screen');
	if (HAZARD.test(chose)) tags.add('hazard');
	if (PROTECT.test(chose)) tags.add('protect');
	if (DISRUPT.test(chose)) tags.add('disrupt');
	if (PIVOT_MOVE.test(chose)) tags.add('pivot-move');
	if (PRIORITY.test(chose)) tags.add('priority');
	if (RECOVERY.test(chose)) tags.add('recovery');
	if (/YOU LOSE THIS RACE|cannot win this race/.test(turn.threat ?? '')) tags.add('lost-race');

	for (const text of turn.events) {
		const foes = text.startsWith('Foe ');
		if (/critical hit/i.test(text)) tags.add(foes ? 'crit-theirs' : 'crit-ours');
		if (/missed|avoided the attack/i.test(text)) tags.add(foes ? 'miss-theirs' : 'miss-ours');
		const used = /^Foe (.+?) used (.+?)\./.exec(text);
		if (used && used[2] !== undefined) {
			if (SETUP.test(used[2])) tags.add('foe-set-up');
			if (RECOVERY.test(used[2])) tags.add('foe-recovered');
		}
		const fell = /^(.+?) fainted!/.exec(text);
		if (fell && fell[1] !== undefined) {
			if (fell[1] === theirs) tags.add('we-ko');
			else tags.add('we-fall');
		}
	}
	// A voluntary switch whose incoming body falls the same turn was a sack:
	// a body spent to bring the next one in clean.
	if (switching && !forced) {
		const incoming = chose.slice('switch to '.length);
		if (turn.events.some(text => text.startsWith(incoming + ' fainted'))) tags.add('sack');
	}
	// The search played something other than the biggest forecast on the
	// screen: a line, not a number. These are the turns worth reading.
	const offered = turn.options?.moves ?? [];
	if (!forced && offered.length > 1 && (turn.why ?? '').startsWith('search')) {
		const best = [...offered].sort((a, b) => floorOf(b.damage) - floorOf(a.damage))[0];
		if (best !== undefined && floorOf(best.damage) > 0 && best.move !== chose) tags.add('search-overrode');
	}
	// Who acted first, read off the order things happened in. Speed is what we
	// keep losing on, and this is where it shows: a turn where they move first
	// is a turn our hit may never land.
	const acted = turn.events.map(text => /^(Foe )?(.+?) used /.exec(text)).filter(hit => hit !== null);
	const first = acted[0];
	if (!forced && !switching && first !== undefined && acted.length > 1) {
		tags.add(first[1] === undefined ? 'we-move-first' : 'they-move-first');
	}
	// How sure the search was. Its values are means of a handful of rollouts;
	// when the best two are within COIN_FLIP of each other the "choice" is
	// noise, and when the best is far clear it is a real preference. On
	// Brawly's winning attempt turn one chose Stun Spore over Air Cutter at
	// 0.283 against 0.281.
	const scores = [...(turn.scores ?? [])].sort((a, b) => b.value - a.value);
	const top = scores[0];
	const second = scores[1];
	if (top !== undefined && second !== undefined) {
		if (top.value - second.value < COIN_FLIP) tags.add('coin-flip');
		else if (top.value - second.value >= CLEAR) tags.add('clear-choice');
	}
	// Was giving up a body FORCED? A sacrifice is not a mistake — sometimes it
	// is the only line — so the question a turn must answer is whether there
	// was another. Three readings, from what was on the screen:
	//   forced    the body was dead this turn anyway (they need one turn), so
	//             it bought something with a life already lost;
	//   chosen    it was not doomed, and the search clearly preferred giving
	//             it up over every option that kept it;
	//   unforced  an option that kept the body scored within noise — nothing
	//             on the screen says this body had to go.
	if (SELF_KO.test(chose)) tags.add('self-ko');
	if (tags.has('self-ko') || tags.has('sack')) {
		const doomed = /they need 1\b/.test(turn.threat ?? '');
		const givesUp = (choice: string): boolean => SELF_KO.test(choice) ||
			(tags.has('sack') && choice === chose);
		const mineScore = (turn.scores ?? []).find(entry => entry.choice === chose);
		const keeping = (turn.scores ?? []).filter(entry => !givesUp(entry.choice) && !entry.choice.startsWith('switch'));
		const bestKeeping = keeping.reduce((top, entry) => Math.max(top, entry.value), -Infinity);
		if (doomed) tags.add('sacrifice-forced');
		else if (mineScore !== undefined && keeping.length > 0 && mineScore.value - bestKeeping >= CLEAR) tags.add('sacrifice-chosen');
		else tags.add('sacrifice-unforced');
	}
	void mine;
	return [...tags];
}
