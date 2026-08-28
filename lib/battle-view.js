'use strict';

/**
 * The driver's battle view, built from an engine reply instead of the DOM.
 *
 * The playthrough driver decides every turn from what readBattle scrapes off
 * the panel — text the panel renders from the engine's reply. That makes the
 * browser the only place a policy can be exercised, so nothing past the
 * corridor a live run reaches (fight ~25, Brawly's door) is ever evaluated.
 * This module renders the SAME text from the same reply, so decide() can run
 * headless against any banked run document at any depth.
 *
 * Parity is the whole contract. Every string here mirrors a line in
 * src/js/run_panel.js (paintBattle), and the gates in
 * tests/battle_view.test.js pin both directions: the text must match the
 * panel's format literally, and it must satisfy the driver's parsers
 * (raceOf, scoreMove, the Pursuit and act-first markers). A change to the
 * panel's wording that forgets this file will fail those gates, not silently
 * split the two surfaces.
 */

/** The threat sentence, exactly as the panel writes it. */
function threatText(threat) {
	if (!threat || !threat.move) return '';
	const race = threat.race;
	return 'Their hardest hit: ' + threat.move + ' ' + threat.max + '%' +
		(threat.crit > threat.max ? ' — ' + threat.crit + '% on a crit' : '') +
		' · ' + (!threat.survivesCrit ? 'a crit KOs you' :
			!threat.survivesTwoCrits ? 'survives one crit, not two' :
				'survives a crit') +
		(!race ? '' : race.outcome === 'cannot-win' ?
			' · NOTHING HERE DAMAGES IT — you cannot win this race' :
			' · you need ' + race.turnsToKill + ' turn' +
				(race.turnsToKill === 1 ? '' : 's') + ' to KO, they need ' +
				race.turnsToDie + ' — ' +
				(race.outcome === 'lose' ? 'YOU LOSE THIS RACE' : 'you win it') +
				(race.faster === false ? ' · they act first' : '')) +
		(threat.pursuit && threat.pursuit.kills ?
			' · Pursuit KOs anything that switches out' : '');
}

/** The data-risk verdict, exactly as the panel sets it. */
function riskOf(threat) {
	if (!threat || !threat.move) return null;
	const race = threat.race;
	const losing = race && (race.outcome === 'lose' || race.outcome === 'cannot-win');
	return losing ? 'lethal' : threat.survivesCrit ?
		(threat.survivesTwoCrits ? 'safe' : 'thin') : 'lethal';
}

/** The move button's damage text, exactly as the panel writes it. */
function moveDamageText(damage) {
	if (!damage || damage.max === 0) return '';
	return damage.min + '%+' +
		(damage.floorKO ? ' · KOs on any roll' :
			damage.guaranteedKO ? ' · KO' :
				' up to ' + damage.max + '%');
}

/** The move button's title, exactly as the panel writes it. */
function moveTitle(entry) {
	if (!entry.damage) return entry.move;
	return entry.move + ' ' + entry.damage.min + '–' + entry.damage.max + '%' +
		(entry.damage.crit ? ' · ' + entry.damage.crit + '% on a crit' : '') +
		(entry.damage.floorKO ? ' · KOs even on its worst roll' : '');
}

function pct(mon) {
	return mon.hp.max ? Math.round(Math.max(0, mon.hp.current) / mon.hp.max * 100) : 0;
}

function nameOf(card) {
	const shown = (card.volatiles || []);
	return card.species + ' L' + card.level +
		(card.status ? ' · ' + card.status : '') +
		(shown.length ? ' · ' + shown.join(' · ') : '');
}

/**
 * The whole view the driver reads, from one engine reply.
 *
 * The at-cap suffix on the player's name is deliberately absent: it needs
 * the run document's owned level, and no decide() rule reads it.
 */
function viewOf(reply) {
	const vs = reply.viewState;
	const threat = reply.threat;
	return {
		open: true,
		prompt: reply.phase === 'replace' ? 'Choose the next Pokemon.' :
			reply.result ? '' : 'What will ' + vs.player.active.species + ' do?',
		threat: threatText(threat),
		risk: riskOf(threat),
		us: nameOf(vs.player.active),
		usHp: pct(vs.player.active),
		foe: nameOf(vs.foe.active),
		foeHp: pct(vs.foe.active),
		result: reply.result || '',
		moves: (reply.actions || []).filter(entry => entry.kind === 'move')
			.map(entry => ({
				move: entry.move,
				ball: null,
				title: moveTitle(entry),
				damage: moveDamageText(entry.damage),
				label: entry.move,
			})),
		switches: (reply.actions || []).filter(entry => entry.kind === 'switch')
			.map(entry => ({
				id: entry.action.replacementId,
				label: entry.species + ' ' + pct(entry) + '%',
				race: entry.race ? entry.race.outcome : null,
			})),
		bench: vs.player.bench.map(card => card.species + ' ' + pct(card) + '%'),
	};
}

module.exports = {viewOf, threatText, riskOf, moveDamageText, moveTitle};
