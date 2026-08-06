import {hasPureAbilityEffect, PURE_ABILITY_MOVE_IDS} from './ability-legality';
import {getPokemon, sideForPokemon} from './actions';
import {hasCallMoveEffect, PURE_CALL_MOVE_IDS} from './call-legality';
import {hasMoveCopyEffect, PURE_MOVE_COPY_IDS} from './copy-legality';
import {canApplyMajorStatus, canApplyVolatile, getEffectiveTypes, isGrounded} from './eligibility';
import {hasInstructEffect} from './instruct-legality';
import {canRemoveHeldItem, hasPureItemTransferEffect, PURE_ITEM_TRANSFER_MOVE_IDS} from './item-legality';
import {preventsAbilityChange} from './items';
import {hasPurePPEffect, PURE_PP_MOVE_IDS} from './pp-legality';
import {hasSelfStageEffect} from './setup-legality';
import {
  hasMixedTargetStageEffect,
  hasTargetStageBoostEffect,
  hasTargetStageEffect,
  hasTargetStageResetEffect,
  MIXED_TARGET_STAGE_MOVE_IDS,
  PURE_TARGET_STAGE_BOOST_IDS,
  PURE_TARGET_STAGE_DROP_IDS,
  PURE_TARGET_STAGE_RESET_MOVE_IDS,
} from './stage-legality';
import {hasPureStatTransferEffect, PURE_STAT_TRANSFER_MOVE_IDS} from './stat-transfer-legality';
import {PURE_STATUS_EFFECTS} from './status-legality';
import {hasPureTypeEffect, PURE_TYPE_MOVE_IDS} from './type-legality';
import {PURE_CONFUSION_MOVE_IDS} from './volatile-legality';
import {hasSubstitute, isBerry, moveId} from './move-engine-utils';
import {BattleState, PokemonState, SideEffects} from './model';

/**
 * Move-failure reasons.
 *
 * Each helper answers "why can this move not resolve?" for one boundary --
 * the actor's item, the actor itself, a specific target, or the field -- and
 * returns an explicit human-readable reason string, or undefined when the move
 * may proceed. These are checks only: they never write to a resolution.
 */

export function itemMoveFailure(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
): string | undefined {
  if (id === 'trick' || id === 'switcheroo') {
    if (!target) return `${id} requires a target`;
    if (!actor.item && !target.item) return `${id} failed because neither Pokémon is holding an item`;
    if (hasSubstitute(state, target.id)) return `${id} failed because the target is behind a Substitute`;
    if (!canRemoveHeldItem(state, target) && target.item) {
      return `${id} failed because Sticky Hold protected the target item`;
    }
  }
  if (id === 'bestow') {
    if (!target || !actor.item || target.item) return 'Bestow failed because the item transfer was not possible';
  }
  if (id === 'thief' || id === 'covet') {
    if (!target || actor.item || !target.item || !canRemoveHeldItem(state, target)) {
      return `${id} failed because the target item could not be stolen`;
    }
  }
  if (PURE_ITEM_TRANSFER_MOVE_IDS.has(id) && !hasPureItemTransferEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because the held-item transfer was not possible`;
  }
  if (id === 'recycle' && (state.generation < 3 || actor.item || !actor.lastConsumedItem)) {
    return 'Recycle failed because no consumed item can be restored';
  }
  if (id === 'belch' && (state.generation < 6 || !isBerry(actor.lastConsumedItem))) {
    return 'Belch failed because the actor has not consumed a Berry';
  }
  if (id === 'stuffcheeks' && (state.generation < 8 || !isBerry(actor.item) ||
    actor.itemCorroded || actor.volatile?.embargo)) {
    return 'Stuff Cheeks failed because the actor has no usable held Berry';
  }
  if (id === 'lastresort' && (actor.moves.length <= 1 || actor.moves.some(move =>
    moveId(move.name) !== 'lastresort' && (move.timesUsed || 0) < 1))) {
    return 'Last Resort failed because not all other moves have been used';
  }
  return undefined;
}

export function selfMoveFailure(
  state: BattleState,
  actor: PokemonState,
  id: string,
): string | undefined {
  const stockpileCount = actor.volatile?.stockpile?.stacks || 0;
  if (id === 'stockpile' && stockpileCount >= 3) return 'Stockpile failed because its stack limit was reached';
  if ((id === 'swallow' || id === 'spitup') && stockpileCount === 0) {
    return `${id === 'swallow' ? 'Swallow' : 'Spit Up'} failed because no Stockpile energy was available`;
  }
  if (id === 'swallow' && actor.hp.current >= actor.hp.max) return 'Swallow failed because the actor was at full HP';
  if (id === 'rest' && actor.hp.current >= actor.hp.max) return 'Rest failed because the actor was at full HP';
  if (id === 'rest' && !canApplyMajorStatus(state, actor.id, actor.id, 'slp', undefined, false, true)) {
    return 'Rest failed because sleep was blocked';
  }
  if (id === 'bellydrum' && actor.hp.current <= Math.floor(actor.hp.max / 2)) {
    return 'Belly Drum failed because the actor lacked more than half HP';
  }
  if (id === 'clangoroussoul' && state.generation >= 8 && actor.hp.current <= Math.floor(actor.hp.max / 3)) {
    return 'Clangorous Soul failed because the actor lacked more than one-third HP';
  }
  if (id === 'filletaway' && state.generation >= 9 && actor.hp.current <= Math.floor(actor.hp.max / 2)) {
    return 'Fillet Away failed because the actor lacked more than half HP';
  }
  if (id === 'substitute' && (actor.substituteHp || 0) > 0) return 'Substitute failed because one was already active';
  if (id === 'substitute' && actor.hp.current <= Math.floor(actor.hp.max / 4)) {
    return 'Substitute failed because the actor lacked enough HP';
  }
  if (id === 'noretreat' && actor.volatile?.trapped) return 'No Retreat failed because the actor was already trapped';
  if (id === 'aquaring' && actor.volatile?.aquaRing) return 'Aqua Ring failed because it was already active';
  if (id === 'ingrain' && actor.volatile?.ingrain) return 'Ingrain failed because it was already active';
  if (id === 'magnetrise' && actor.volatile?.magnetRise) return 'Magnet Rise failed because it was already active';
  if (id === 'psychoshift' && !actor.status) return 'Psycho Shift failed because the actor had no major status';
  if (id === 'magiccoat' && state.generation >= 4 && state.generation < 8 && actor.volatile?.magicCoat) {
    return 'Magic Coat failed because it was already active';
  }
  if (id === 'snatch' && state.generation >= 3 && state.generation < 8 && actor.volatile?.snatch) {
    return 'Snatch failed because it was already active';
  }
  if (id === 'grudge' && state.generation >= 3 && actor.volatile?.grudge) {
    return 'Grudge failed because it was already active';
  }
  if (id === 'grudge' && state.generation < 3) return 'Grudge failed because it is unavailable in this generation';
  if (id === 'gigatonhammer' && moveId(state.lastMoveUsedByPokemon?.[actor.id]) === id) {
    return 'Gigaton Hammer failed because it cannot be used twice in a row';
  }
  if (id === 'burnup' && !getEffectiveTypes(state, actor.id).some(type => moveId(type) === 'fire')) {
    return 'Burn Up failed because the actor was not Fire-type';
  }
  if (id === 'doubleshock' && !getEffectiveTypes(state, actor.id).some(type => moveId(type) === 'electric')) {
    return 'Double Shock failed because the actor was not Electric-type';
  }
  if (id === 'geomancy' && moveId(actor.volatile?.charge?.moveName) === id) return undefined;
  if (id === 'takeheart' && !actor.status && !hasSelfStageEffect(actor.boosts, id)) {
    return 'Take Heart failed because it would have no effect';
  }
  if (id !== 'takeheart' && !hasSelfStageEffect(actor.boosts, id)) {
    return `${actionNameForId(id)} failed because its affected stages were already maxed`;
  }
  if (new Set([
    'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'rest', 'roost',
    'shoreup', 'slackoff', 'softboiled', 'synthesis',
  ]).has(id) && actor.hp.current >= actor.hp.max) {
    return `${actionNameForId(id)} failed because the actor was at full HP`;
  }
  return undefined;
}

export function actionNameForId(id: string): string {
  return id.replace(/(^|[a-z])([a-z])/g, (match, prefix: string, letter: string) =>
    `${prefix ? `${prefix} ` : ''}${letter.toUpperCase()}`).trim();
}

export function targetMoveFailure(
  state: BattleState,
  actor: PokemonState,
  id: string,
  targetIds: string[],
): string | undefined {
  if (id === 'revivalblessing') {
    const targetId = targetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (state.generation < 9 || !target || target.id === actor.id || target.hp.current > 0 ||
      sideForPokemon(state, target.id) !== sideForPokemon(state, actor.id)) {
      return 'Revival Blessing failed because it did not target a fainted ally';
    }
    return undefined;
  }
  const targets = targetIds
    .map(targetId => getPokemon(state, targetId))
    .filter((target): target is PokemonState => !!target && target.hp.current > 0);
  if (id === 'teatime' && (state.generation !== 8 || !targets.some(target => isBerry(target.item)))) {
    return 'Teatime failed because no active target held a Berry';
  }
  if (id === 'flowershield' && (state.generation < 6 || state.generation > 8 || !targets.some(target =>
    getEffectiveTypes(state, target.id).some(type => moveId(type) === 'grass') && (target.boosts?.def || 0) < 6))) {
    return 'Flower Shield failed because no Grass target could gain Defense';
  }
  if (id === 'rototiller' && (state.generation < 6 || state.generation > 7 || !targets.some(target =>
    isGrounded(state, target.id) && getEffectiveTypes(state, target.id).some(type => moveId(type) === 'grass') &&
    ((target.boosts?.atk || 0) < 6 || (target.boosts?.spa || 0) < 6)))) {
    return 'Rototiller failed because no grounded Grass target could gain stages';
  }
  if (id === 'lunarblessing' && targets.every(target => target.hp.current >= target.hp.max &&
    !target.status && !target.toxicCounter)) {
    return 'Lunar Blessing failed because all allies were already healed';
  }
  if (MIXED_TARGET_STAGE_MOVE_IDS.has(id) && targets.every(target =>
    !hasMixedTargetStageEffect(target.boosts, id))) {
    return `${actionNameForId(id)} failed because the target had no affected stage to change`;
  }
  if (id === 'tarshot' && targets.length && targets.every(target =>
    !hasTargetStageEffect(target.boosts, id) &&
    !canApplyVolatile(state, target.id, 'tarShot', actor.id, true, 'Status'))) {
    return 'Tar Shot failed because no target could gain its effects';
  }
  if (PURE_TARGET_STAGE_BOOST_IDS.has(id) && targets.every(target =>
    !hasTargetStageBoostEffect(target.boosts, id))) {
    return `${actionNameForId(id)} failed because the target could not gain another affected stage`;
  }
  const pureStatus = PURE_STATUS_EFFECTS[id];
  if (pureStatus && targets.length && targets.every(target => !canApplyMajorStatus(
    state, actor.id, target.id, pureStatus.status, pureStatus.moveType, true,
  ))) {
    return `${actionNameForId(id)} failed because no target was eligible for its status`;
  }
  const target = targets[0];
  if (!target) return undefined;
  if (PURE_ITEM_TRANSFER_MOVE_IDS.has(id) && !hasPureItemTransferEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because the held-item transfer was not possible`;
  }
  if (PURE_ABILITY_MOVE_IDS.has(id) && !hasPureAbilityEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because it would not change an ability`;
  }
  if (PURE_PP_MOVE_IDS.has(id) && !hasPurePPEffect(state, target, id)) {
    return `${actionNameForId(id)} failed because the target had no tracked PP to reduce`;
  }
  if (PURE_STAT_TRANSFER_MOVE_IDS.has(id) && !hasPureStatTransferEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because it would not change the modeled stats`;
  }
  if (id === 'instruct' && !hasInstructEffect(state, target)) {
    return 'Instruct failed because the target had no callable last move';
  }
  if (PURE_MOVE_COPY_IDS.has(id) && !hasMoveCopyEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because no legal move was available to copy`;
  }
  if (PURE_CALL_MOVE_IDS.has(id) && !hasCallMoveEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because no legal candidate move was available`;
  }
  if (PURE_TYPE_MOVE_IDS.has(id) && !hasPureTypeEffect(
    state, actor, target, id, pokemonId => getEffectiveTypes(state, pokemonId),
  )) {
    return `${actionNameForId(id)} failed because the type change had no effect`;
  }
  if (PURE_CONFUSION_MOVE_IDS.has(id) && targets.every(candidate =>
    !canApplyVolatile(state, candidate.id, 'confusion', actor.id, true))) {
    return `${actionNameForId(id)} failed because no target was eligible for confusion`;
  }
  if (PURE_TARGET_STAGE_RESET_MOVE_IDS.has(id) && targets.every(candidate =>
    !hasTargetStageResetEffect(candidate.boosts, id))) {
    return `${actionNameForId(id)} failed because no target had stages to reset`;
  }
  if (PURE_TARGET_STAGE_DROP_IDS.has(id) && id !== 'tarshot' && (!hasTargetStageEffect(target.boosts, id) ||
    (id === 'captivate' && actor.gender && actor.gender !== 'N' && target.gender && target.gender !== 'N' && actor.gender === target.gender))) {
    return `${actionNameForId(id)} failed because the target could not lose another affected stage`;
  }
  if (id === 'attract' && (target.volatile?.infatuated ||
    !canApplyVolatile(state, target.id, 'infatuated', actor.id, true, 'Status'))) {
    return 'Attract failed because the target was not eligible';
  }
  if (id === 'yawn' && (target.volatile?.yawn || !canApplyMajorStatus(state, actor.id, target.id, 'slp', undefined, true))) {
    return 'Yawn failed because the target was not eligible for sleep';
  }
  if (id === 'leechseed' && !canApplyVolatile(state, target.id, 'leechSeed', actor.id, true, 'Status')) {
    return 'Leech Seed failed because the target was not eligible';
  }
  if (id === 'telekinesis' && (state.field.gravity ||
    !canApplyVolatile(state, target.id, 'telekinesis', actor.id, true, 'Status'))) {
    return 'Telekinesis failed because the target was not eligible';
  }
  if (id === 'nightmare' && !canApplyVolatile(state, target.id, 'nightmare', actor.id, true, 'Status')) {
    return 'Nightmare failed because the target was not eligible';
  }
  if (id === 'acupressure' && ['atk', 'def', 'spa', 'spd', 'spe'].every(stat =>
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) >= 6)) {
    return 'Acupressure failed because all target stats were already maxed';
  }
  if (id === 'psychup' && ['atk', 'def', 'spa', 'spd', 'spe'].every(stat =>
    (actor.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) ===
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0))) {
    return 'Psych Up failed because it would not change the user\'s stat stages';
  }
  const swapStats = id === 'guardswap' ? ['def', 'spd'] : id === 'powerswap' ? ['atk', 'spa'] : [];
  if (swapStats.length && swapStats.every(stat =>
    (actor.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) ===
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0))) {
    return `${id === 'guardswap' ? 'Guard Swap' : 'Power Swap'} failed because the stages were already equal`;
  }
  if (id === 'encore' && (!state.lastMoveByPokemon?.[target.id] ||
    state.firstTurnOutIds?.includes(target.id) || target.volatile?.encore)) {
    return 'Encore failed because the target had no eligible move history';
  }
  if (id === 'disable' && (!state.lastMoveByPokemon?.[target.id] || target.volatile?.disable)) {
    return 'Disable failed because the target had no eligible move';
  }
  if (id === 'taunt' && target.volatile?.taunt) return 'Taunt failed because the target was already Taunted';
  if (id === 'torment' && target.volatile?.torment) return 'Torment failed because the target was already Tormented';
  if (id === 'leechseed' && target.volatile?.leechSeed) return 'Leech Seed failed because the target was already seeded';
  if (id === 'perishsong' && targets.length && targets.every(candidate => candidate.volatile?.perishSong)) {
    return 'Perish Song failed because every target was already under Perish Song';
  }
  if ((id === 'foresight' || id === 'odorsleuth') && target.volatile?.foresight) {
    return `${actionNameForId(id)} failed because the target was already identified`;
  }
  if (id === 'electrify' && target.volatile?.electrified) return 'Electrify failed because the target was already Electrified';
  if (id === 'octolock' && (target.volatile?.octolock || target.volatile?.trapped)) {
    return 'Octolock failed because the target was already trapped';
  }
  if (id === 'miracleeye' && target.volatile?.miracleEye) return 'Miracle Eye failed because it was already active';
  if (id === 'gastroacid' && preventsAbilityChange(state, target)) {
    return 'Gastro Acid failed because the target ability was protected by Ability Shield';
  }
  if (id === 'gastroacid' && target.abilitySuppressed) return 'Gastro Acid failed because the target ability was already suppressed';
  if (id === 'embargo' && target.volatile?.embargo) return 'Embargo failed because the target was already under Embargo';
  if (id === 'healblock' && target.volatile?.healBlock) return 'Heal Block failed because it was already active';
  if (['block', 'meanlook', 'spiderweb'].includes(id) && target.volatile?.trapped) {
    return `${id === 'block' ? 'Block' : id === 'meanlook' ? 'Mean Look' : 'Spider Web'} failed because the target was already trapped`;
  }
  if (id === 'refresh' && !actor.status && !actor.toxicCounter) return 'Refresh failed because the actor had no major status';
  if (id === 'purify' && !target.status && !target.toxicCounter) return 'Purify failed because the target had no major status';
  if (id === 'painsplit' && actor.hp.current === target.hp.current) {
    return 'Pain Split failed because both HP totals were equal';
  }
  if (['floralhealing', 'healpulse', 'pollenpuff'].includes(id) &&
    sideForPokemon(state, target.id) === sideForPokemon(state, actor.id) && target.hp.current >= target.hp.max) {
    return `${actionNameForId(id)} failed because the ally was at full HP`;
  }
  if (id === 'lifedew' && targets.every(candidate => candidate.hp.current >= candidate.hp.max)) {
    return 'Life Dew failed because all allies were at full HP';
  }
  if ((id === 'junglehealing' || id === 'lunarblessing') && targets.every(candidate => candidate.hp.current >= candidate.hp.max &&
    !candidate.status && !candidate.toxicCounter)) {
    return 'Jungle Healing failed because all allies were already healed';
  }
  if ((id === 'aromatherapy' || id === 'healbell') && targets.every(candidate =>
    sideForPokemon(state, candidate.id) !== sideForPokemon(state, actor.id) ||
    (!candidate.status && !candidate.toxicCounter))) {
    return `${actionNameForId(id)} failed because no ally had a major status`;
  }
  return undefined;
}

export function fieldMoveFailure(state: BattleState, actor: PokemonState, id: string): string | undefined {
  const sideId = sideForPokemon(state, actor.id);
  const ownEffects = state.sides[sideId].effects || {};
  const foeEffects = state.sides[sideId === 'ai' ? 'player' : 'ai'].effects || {};
  const fail = (move: string, reason: string) => `${move} failed because ${reason}`;
  if (id === 'stealthrock' && foeEffects.stealthRock) return fail('Stealth Rock', 'it was already active');
  if (id === 'spikes' && (foeEffects.spikes || 0) >= 3) return fail('Spikes', 'three layers were already active');
  if (id === 'toxicspikes' && (foeEffects.toxicSpikes || 0) >= 2) return fail('Toxic Spikes', 'two layers were already active');
  if (id === 'stickyweb' && foeEffects.stickyWeb) return fail('Sticky Web', 'it was already active');
  const sideMoveEffects: Record<string, keyof SideEffects> = {
    reflect: 'reflect', lightscreen: 'lightScreen', auroraveil: 'auroraVeil', tailwind: 'tailwind',
    mist: 'mist', luckychant: 'luckyChant', craftyshield: 'craftyShield',
  };
  const sideEffect = sideMoveEffects[id];
  if (sideEffect && ownEffects[sideEffect]) return fail(actionNameForId(id), 'it was already active');
  if (id === 'auroraveil' && state.field.weather !== 'Hail' && state.field.weather !== 'Snow') {
    return fail('Aurora Veil', 'hail or snow was not active');
  }
  if (id === 'fairylock' && state.field.fairyLock) return fail('Fairy Lock', 'it was already active');
  if (id === 'watersport') {
    if (state.generation < 3 || state.generation >= 8) return fail('Water Sport', 'it had no effect in this generation');
    if (state.generation <= 5 ? actor.volatile?.waterSport : state.field.waterSport) {
      return fail('Water Sport', 'it was already active');
    }
  }
  if (id === 'mudsport') {
    if (state.generation < 3 || state.generation >= 8) return fail('Mud Sport', 'it had no effect in this generation');
    if (state.generation <= 5 ? actor.volatile?.mudSport : state.field.mudSport) {
      return fail('Mud Sport', 'it was already active');
    }
  }
  if (id === 'iondeluge') {
    if (state.generation < 6 || state.generation > 7) return fail('Ion Deluge', 'it had no effect in this generation');
    if (state.field.ionDeluge) return fail('Ion Deluge', 'it was already active');
  }
  const hasHazards = (effects: SideEffects) => !!effects.stealthRock || !!effects.spikes ||
    !!effects.toxicSpikes || !!effects.stickyWeb;
  const hasScreens = (effects: SideEffects) => !!effects.reflect || !!effects.lightScreen ||
    !!effects.auroraVeil || !!effects.safeguard;
  if (id === 'defog' && (!hasHazards(state.sides.ai.effects || {}) && !hasHazards(state.sides.player.effects || {}) &&
    !hasScreens(state.sides[sideId === 'ai' ? 'player' : 'ai'].effects || {}))) {
    return 'Defog failed because there were no hazards or target-side screens';
  }
  if (id === 'courtchange') {
    const hasPersistentSideEffect = (effects: SideEffects) => hasHazards(effects) || hasScreens(effects) ||
      !!effects.mist || !!effects.luckyChant || !!effects.craftyShield || !!effects.tailwind;
    if (!hasPersistentSideEffect(state.sides.ai.effects || {}) && !hasPersistentSideEffect(state.sides.player.effects || {})) {
      return 'Court Change failed because there were no side conditions to swap';
    }
  }
  if (id === 'steelroller' && !state.field.terrain) return 'Steel Roller failed because no Terrain was active';
  return undefined;
}
