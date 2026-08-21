import {getPokemon, isRainWeather, isSunWeather, sideForPokemon} from './actions';
import {ALWAYS_CRIT_MOVES, HIGH_CRIT_MOVES} from './calc-adapter';
import {hasPureAbilityEffect, PURE_ABILITY_MOVE_IDS} from './ability-legality';
import {hasMoveCopyEffect, PURE_MOVE_COPY_IDS} from './copy-legality';
import {hasCallMoveEffect, PURE_CALL_MOVE_IDS} from './call-legality';
import {hasPureTypeEffect, PURE_TYPE_MOVE_IDS} from './type-legality';
import {hasInstructEffect} from './instruct-legality';
import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {deriveEndTurnResolution} from './end-turn';
import {
  canApplyMajorStatus,
  canApplyVolatile,
  getEffectiveTypes,
  ignoresTargetAbility,
  isGrounded,
  isPriorityBlocked,
} from './eligibility';
import {isItemEffectActive, preventsAbilityChange} from './items';
import {hasPureItemTransferEffect, PURE_ITEM_TRANSFER_MOVE_IDS} from './item-legality';
import {CURSE_MOVE_MIN_GENERATION, getMoveMetadata, PROTECTION_MOVE_MIN_GENERATION} from './move-metadata';
import {ActionEvaluation, BattleState, PokemonState, StatBoosts} from './model';
import {normalizeGenerationFacts} from './facts';
import {getActionOrderFacts} from './order';
import {canRequestMoveSwitch, fieldSetterNoOpReason} from './move-engine';
import {hasSelfStageEffect, PURE_SELF_STAGE_MOVE_IDS} from './setup-legality';
import {PURE_STATUS_MOVE_IDS} from './status-legality';
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
import {PURE_CONFUSION_MOVE_IDS} from './volatile-legality';
import {hasPureStatTransferEffect, PURE_STAT_TRANSFER_MOVE_IDS} from './stat-transfer-legality';
import {hasPurePPEffect, PURE_PP_MOVE_IDS} from './pp-legality';

const STATUS_BY_MOVE: Record<string, 'slp' | 'psn' | 'brn' | 'par' | 'tox'> = {
  darkvoid: 'slp', grasswhistle: 'slp', hypnosis: 'slp', lovelykiss: 'slp',
  sing: 'slp', sleeppowder: 'slp', spore: 'slp',
  poisonpowder: 'psn', poisongas: 'psn', toxic: 'tox', toxicthread: 'psn', willowisp: 'brn', thunderwave: 'par',
  glare: 'par', nuzzle: 'par', stunspore: 'par',
};
const POISONING_MOVES = new Set(['poisonpowder', 'poisongas', 'toxic', 'toxicthread']);
const SETUP_MOVES = new Set([
  'acidarmor', 'agility', 'amnesia', 'autotomize', 'barrier', 'bellydrum', 'bulkup', 'calmmind',
  'chargebeam', 'clangoroussoul', 'coil', 'cosmicpower', 'cottonguard', 'dragondance', 'filletaway', 'growth',
  'charge', 'defensecurl', 'doubleteam', 'harden', 'honeclaws', 'irondefense', 'minimize', 'nastyplot', 'noretreat', 'quiverdance',
  'howl', 'meditate', 'poweruppunch', 'rockpolish', 'shellsmash', 'shiftgear',
  'sharpen', 'stockpile', 'stuffcheeks', 'swordsdance', 'tailglow', 'victorydance', 'withdraw', 'workup', 'curse', 'shelter', 'takeheart', 'defendorder', 'extremeevoboost', 'geomancy',
]);
const SETUP_WHEN_THREATENED = new Set(['bellydrum', 'howl', 'poweruppunch', 'shellsmash', 'swordsdance']);
const UNAWARE_SETUP_EXCEPTIONS = new Set(['howl', 'poweruppunch', 'swordsdance']);
const OFFENSIVE_SETUP_MOVES = new Set([
  'dragondance', 'howl', 'honeclaws', 'meditate', 'nastyplot', 'poweruppunch',
  'rockpolish', 'sharpen', 'shiftgear', 'tailglow', 'workup', 'swordsdance',
]);
const DEFENSIVE_SETUP_MOVES = new Set([
  'acidarmor', 'amnesia', 'barrier', 'cosmicpower', 'cottonguard', 'defensecurl', 'harden', 'irondefense', 'withdraw',
  'stockpile', 'shelter', 'defendorder', 'extremeevoboost', 'geomancy',
]);
const PHYSICAL_DUAL_SETUP_MOVES = new Set(['bulkup', 'coil', 'noretreat']);
const SPECIAL_DUAL_SETUP_MOVES = new Set(['calmmind', 'quiverdance']);
const RECOVERY_MOVES = new Set([
  'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'rest', 'roost',
  'shoreup', 'slackoff', 'softboiled', 'strengthsap', 'swallow', 'synthesis',
]);
const WEATHER_RECOVERY_MOVES = new Set(['moonlight', 'morningsun', 'synthesis']);
const ALLY_HEALING_MOVES = new Set(['floralhealing', 'healpulse', 'pollenpuff']);
const ALLY_TEAM_HEALING_MOVES = new Set(['junglehealing', 'lifedew']);
const ALLY_TEAM_CLEANSE_MOVES = new Set(['aromatherapy', 'healbell']);
// THE list, imported rather than mirrored. This was a second hand-kept copy
// that "mirrors calc-adapter's set", and two hand-kept copies of the same
// answer is how they drifted apart the first time — the old one carried
// strangesteam, a confusion move, and missed seven others. Corrupting one
// copy could not be seen from the other.
//
// It also folded in the four ALWAYS-crit moves, which made this policy
// believe Focus Energy helps a Wicked Blow. It does not: a move that always
// crits gains nothing from a crit-stage boost, so only the HIGH-crit set
// belongs in the question below.
const CRIT_SETUP_ABILITIES = new Set(['superluck', 'sniper']);
const CRIT_BLOCKING_ABILITIES = new Set(['battlearmor', 'shellarmor', 'magmaarmor']);
const ROLE_PLAY_ABILITIES = new Set(['hugepower', 'purepower', 'protean', 'toughclaws']);
const SPEED_BOOST_ITEMS = new Set(['salacberry']);
const HARMFUL_TRICK_ITEMS = new Set(['toxicorb', 'flameorb', 'blacksludge']);
const DISRUPTIVE_TRICK_ITEMS = new Set(['ironball', 'laggingtail', 'stickybarb']);
const PROTECTIVE_POLICY_MOVES = new Set([
  'protect', 'detect', 'kingsshield', 'banefulbunker', 'spikyshield', 'silktrap', 'obstruct',
  'burningbulwark', 'maxguard',
]);

function moveId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function activeAbility(state: BattleState, pokemon: PokemonState | undefined): string | undefined {
  return pokemon && isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, getEffectiveAbility(pokemon))
    ? getEffectiveAbility(pokemon) : undefined;
}

function hasMove(moves: string[] | undefined, wanted: string): boolean {
  return !!moves?.some(move => moveId(move) === wanted);
}

function hasProtectContext(pokemon: PokemonState | undefined): boolean {
  return !!pokemon && (!!pokemon.status || !!pokemon.volatile?.curse ||
    !!pokemon.volatile?.infatuated || !!pokemon.volatile?.perishSong ||
    !!pokemon.volatile?.leechSeed || !!pokemon.volatile?.yawn);
}

function defenderIsIncapacitated(
  state: BattleState,
  evaluation: ActionEvaluation,
): boolean {
  const factsIncapacitated = evaluation.facts.defenderIncapacitated === true ||
    evaluation.facts.defenderStatus === 'slp' || evaluation.facts.defenderStatus === 'frz';
  if (evaluation.action.kind !== 'move') return factsIncapacitated;
  const actorSide = sideForPokemon(state, evaluation.action.actorId);
  const target = evaluation.action.targetIds
    .map(targetId => getPokemon(state, targetId))
    .find(candidate => candidate && sideForPokemon(state, candidate.id) !== actorSide) ||
    state.sides[actorSide === 'ai' ? 'player' : 'ai'].activeIds
      .map(targetId => getPokemon(state, targetId))
      .find(candidate => !!candidate && candidate.hp.current > 0);
  return factsIncapacitated || !!target?.volatile?.recharge || !!target?.volatile?.truant ||
    target?.status === 'slp' || target?.status === 'frz';
}

function activePartner(state: BattleState, actorId: string) {
  const sideId = sideForPokemon(state, actorId);
  const partnerId = state.sides[sideId].activeIds.find(id => id !== actorId);
  const partner = partnerId ? getPokemon(state, partnerId) : undefined;
  return partner && partner.hp.current > 0 ? partner : undefined;
}

function noOpReason(state: BattleState, evaluation: ActionEvaluation): string | undefined {
  const action = evaluation.action;
  if (action.kind !== 'move') return undefined;

  const actorSide = sideForPokemon(state, action.actorId);
  const targetSide = actorSide === 'ai' ? 'player' : 'ai';
  const ownEffects = state.sides[actorSide].effects || {};
  const targetEffects = state.sides[targetSide].effects || {};
  const actor = getPokemon(state, action.actorId);
  const target = action.targetIds.length ? getPokemon(state, action.targetIds[0]) : undefined;
  const id = moveId(action.moveName);

  if (id === 'revivalblessing' && (!actor || state.generation < 9 || !target ||
    target.id === actor.id || target.hp.current > 0 ||
    sideForPokemon(state, target.id) !== actorSide)) {
    return 'Revival Blessing requires a fainted ally';
  }

  if (PURE_ITEM_TRANSFER_MOVE_IDS.has(id) && (!actor || !hasPureItemTransferEffect(
    state, actor, target, id,
  ))) {
    return 'the held-item transfer was not possible';
  }
  if (PURE_ABILITY_MOVE_IDS.has(id) && (!actor || !hasPureAbilityEffect(state, actor, target, id))) {
    return 'it would not change an ability';
  }
  if (PURE_PP_MOVE_IDS.has(id) && !hasPurePPEffect(state, target, id)) {
    return 'the target had no tracked PP to reduce';
  }
  if (PURE_STAT_TRANSFER_MOVE_IDS.has(id) && (!actor || !hasPureStatTransferEffect(state, actor, target, id))) {
    return 'it would not change the modeled stats';
  }
  if (id === 'instruct' && !hasInstructEffect(state, target)) {
    return 'the target had no callable last move';
  }
  if (PURE_MOVE_COPY_IDS.has(id) && (!actor || !hasMoveCopyEffect(state, actor, target, id))) {
    return 'no legal move was available to copy';
  }
  if (PURE_CALL_MOVE_IDS.has(id) && (!actor || !hasCallMoveEffect(state, actor, target, id))) {
    return 'no legal candidate move was available';
  }
  if (PURE_TYPE_MOVE_IDS.has(id) && (!actor || !hasPureTypeEffect(
    state, actor, target, id, pokemonId => getEffectiveTypes(state, pokemonId),
  ))) {
    return 'the type change would have no effect';
  }
  if (PURE_CONFUSION_MOVE_IDS.has(id) && action.targetIds.length > 0 &&
    !action.targetIds.some(targetId => canApplyVolatile(
      state, targetId, 'confusion', action.actorId, true,
    ))) {
    return 'no target was eligible for confusion';
  }
  if (PURE_TARGET_STAGE_RESET_MOVE_IDS.has(id) && action.targetIds.length > 0 &&
    !action.targetIds.some(targetId => hasTargetStageResetEffect(getPokemon(state, targetId)?.boosts, id))) {
    return 'no target had stages to reset';
  }
  if (MIXED_TARGET_STAGE_MOVE_IDS.has(id) && action.targetIds.length > 0 &&
    !action.targetIds.some(targetId => hasMixedTargetStageEffect(getPokemon(state, targetId)?.boosts, id))) {
    return 'the target had no affected stage to change';
  }
  if (PURE_TARGET_STAGE_BOOST_IDS.has(id) && action.targetIds.length > 0 &&
    !action.targetIds.some(targetId => hasTargetStageBoostEffect(getPokemon(state, targetId)?.boosts, id))) {
    return 'the target could not gain another affected stage';
  }
  if (id === 'lunarblessing' && action.targetIds.length > 0 &&
    !action.targetIds.some(targetId => {
      const candidate = getPokemon(state, targetId);
      return !!candidate && sideForPokemon(state, candidate.id) === actorSide &&
        (candidate.hp.current < candidate.hp.max || !!candidate.status || !!candidate.toxicCounter);
    })) {
    return 'Lunar Blessing has no ally who needs healing or status cleansing';
  }
  if (id === 'takeheart' && actor && !actor.status && !hasSelfStageEffect(actor.boosts, id)) {
    return 'Take Heart would have no effect';
  }

  if ((id === 'healingwish' || id === 'lunardance') && state.generation >= 4 && actor &&
    !state.sides[actorSide].party.some(pokemon =>
      pokemon.id !== actor.id && pokemon.hp.current > 0 &&
      !state.sides[actorSide].activeIds.includes(pokemon.id))) {
    return `${action.moveName} requires a legal replacement`;
  }
  if (id === 'shedtail' && state.generation >= 9 && actor) {
    const cost = Math.floor(actor.hp.max / 2);
    if (actor.hp.current <= cost) return `${action.moveName} requires more than half HP`;
    if ((actor.substituteHp || 0) > 0) return `${action.moveName} cannot be used behind a Substitute`;
    if (!canRequestMoveSwitch(state, actor)) return `${action.moveName} requires a legal replacement`;
  }

  if (id === 'perishsong' && action.targetIds.length > 0 &&
    !action.targetIds.some(targetId => canApplyVolatile(
      state, targetId, 'perishSong', action.actorId, true, 'Status',
    ))) {
    return 'Perish Song has no eligible target';
  }
  if ((id === 'foresight' || id === 'odorsleuth') && action.targetIds.length > 0 &&
    action.targetIds.every(targetId => getPokemon(state, targetId)?.volatile?.foresight)) {
    return 'Foresight has no eligible target';
  }
  const noEligibleTargetVolatile = (volatile: Parameters<typeof canApplyVolatile>[2]) =>
    action.targetIds.length > 0 && !action.targetIds.some(targetId =>
      canApplyVolatile(state, targetId, volatile, action.actorId, true, 'Status'));
  if (id === 'leechseed' && noEligibleTargetVolatile('leechSeed')) {
    return 'Leech Seed has no eligible target';
  }
  if (id === 'attract' && noEligibleTargetVolatile('infatuated')) {
    return 'Attract has no eligible target';
  }
  if (id === 'torment' && noEligibleTargetVolatile('torment')) {
    return 'Torment has no eligible target';
  }
  if (id === 'disable' && noEligibleTargetVolatile('disable')) {
    return 'Disable has no eligible target';
  }
  if (id === 'yawn' && action.targetIds.length > 0 && !action.targetIds.some(targetId => {
    const target = getPokemon(state, targetId);
    return !!target && !target.volatile?.yawn && canApplyMajorStatus(
      state, action.actorId, targetId, 'slp', evaluation.facts.moveType, true,
    );
  })) {
    return 'Yawn has no eligible target';
  }
  if (id === 'aquaring' && actor && !canApplyVolatile(state, actor.id, 'aquaRing', actor.id)) {
    return 'Aqua Ring is already active';
  }
  if (id === 'ingrain' && actor && !canApplyVolatile(state, actor.id, 'ingrain', actor.id)) {
    return 'Ingrain is already active';
  }
  if (id === 'magnetrise' && actor && !canApplyVolatile(state, actor.id, 'magnetRise', actor.id)) {
    return 'Magnet Rise is already active';
  }
  if (id === 'telekinesis' && ((state.generation >= 5 && state.field.gravity) ||
    noEligibleTargetVolatile('telekinesis'))) {
    return 'Telekinesis has no eligible target';
  }

  const fieldSetterFailure = fieldSetterNoOpReason(state, action.moveName);
  if (fieldSetterFailure) return fieldSetterFailure;

  if (PROTECTIVE_POLICY_MOVES.has(id) && actor) {
    const residual = deriveEndTurnResolution(state).hpDeltaByPokemon?.[actor.id] || 0;
    if (actor.hp.current + residual <= 0) return 'Protect would leave the user fainted to residual damage';
  }
  if (PROTECTIVE_POLICY_MOVES.has(id) && actor?.volatile?.protected) {
    return `${action.moveName} is already active`;
  }

  if (id === 'helpinghand' || id === 'followme') {
    const partner = activePartner(state, action.actorId);
    if (state.mode !== 'Doubles' || !partner) {
      return `${action.moveName} requires an active ally in Doubles`;
    }
    const partnerIntent = partner ? state.selectedMoveByPokemon?.[partner.id] : undefined;
    if (partnerIntent && (moveId(partnerIntent.moveName) === id ||
      getMoveMetadata(partnerIntent.moveName, state.generation).category === 'Status')) {
      return 'the partner is using a status/support move this turn';
    }
  }

  const sameStages = (left: NonNullable<typeof actor>, right: NonNullable<typeof actor>, stats: string[]) =>
    stats.every(stat => (left.boosts?.[stat as keyof StatBoosts] || 0) ===
      (right.boosts?.[stat as keyof StatBoosts] || 0));

  if (id === 'tarshot' && target && !hasTargetStageEffect(target.boosts, id) &&
    !canApplyVolatile(state, target.id, 'tarShot', action.actorId, true, 'Status')) {
    return 'Tar Shot has no eligible target effect';
  }

  if (PURE_TARGET_STAGE_DROP_IDS.has(id) && id !== 'tarshot' && target && (!hasTargetStageEffect(target.boosts, id) ||
    (id === 'captivate' && actor?.gender && actor.gender !== 'N' && target.gender && target.gender !== 'N' && actor.gender === target.gender))) {
    return 'the target could not lose another affected stage';
  }

  if (id === 'stealthrock' && targetEffects.stealthRock) return 'Stealth Rock is already active';
  if (id === 'spikes' && (targetEffects.spikes || 0) >= 3) return 'three layers of Spikes are already active';
  if (id === 'toxicspikes' && (targetEffects.toxicSpikes || 0) >= 2) {
    return 'two layers of Toxic Spikes are already active';
  }
  if (id === 'stickyweb' && targetEffects.stickyWeb) return 'Sticky Web is already active';
  if (id === 'courtchange') {
    const hasPersistentSideCondition = (effects: NonNullable<BattleState['sides']['ai']['effects']>) =>
      !!effects.stealthRock || !!effects.spikes || !!effects.toxicSpikes || !!effects.stickyWeb ||
      !!effects.reflect || !!effects.lightScreen || !!effects.auroraVeil || !!effects.safeguard ||
      !!effects.mist || !!effects.luckyChant || !!effects.craftyShield || !!effects.tailwind;
    if (!hasPersistentSideCondition(ownEffects) && !hasPersistentSideCondition(targetEffects)) {
      return 'there are no side conditions to swap';
    }
  }
  if (id === 'defog') {
    const targetedSide = target
      ? sideForPokemon(state, target.id)
      : targetSide;
    const targetedEffects = state.sides[targetedSide].effects || {};
    const ownHazards = !!ownEffects.stealthRock || !!ownEffects.stickyWeb ||
      !!ownEffects.spikes || !!ownEffects.toxicSpikes;
    const opposingHazards = !!targetEffects.stealthRock || !!targetEffects.stickyWeb ||
      !!targetEffects.spikes || !!targetEffects.toxicSpikes;
    const targetScreens = !!targetedEffects.reflect || !!targetedEffects.lightScreen ||
      !!targetedEffects.auroraVeil || !!targetedEffects.safeguard;
    if (!ownHazards && !opposingHazards && !targetScreens) return 'there are no hazards or target-side screens';
  }
  if (id === 'steelroller' && !state.field.terrain) return 'Steel Roller requires active Terrain';
  if (id === 'reflect' && ownEffects.reflect) return 'Reflect is already active';
  if (id === 'lightscreen' && ownEffects.lightScreen) return 'Light Screen is already active';
  if (id === 'auroraveil' && ownEffects.auroraVeil) return 'Aurora Veil is already active';
  if (id === 'auroraveil' && state.field.weather !== 'Hail' && state.field.weather !== 'Snow') {
    return 'Aurora Veil requires hail or snow';
  }
  if (id === 'tailwind' && ownEffects.tailwind) return 'Tailwind is already active';
  if (id === 'mist' && ownEffects.mist) return 'Mist is already active';
  if (id === 'luckychant' && ownEffects.luckyChant) return 'Lucky Chant is already active';
  if (id === 'craftyshield' && ownEffects.craftyShield) return 'Crafty Shield is already active';
  if (evaluation.facts.moveCategory === 'Status' && action.targetIds.some(targetId =>
    sideForPokemon(state, targetId) !== actorSide &&
    state.sides[sideForPokemon(state, targetId)].effects?.craftyShield)) {
    return 'Crafty Shield blocks opposing status moves';
  }
  if (id === 'fairylock' && state.field.fairyLock) return 'Fairy Lock is already active';
  if (id === 'watersport' && ((state.generation <= 5 && actor?.volatile?.waterSport) ||
    (state.generation >= 6 && state.generation <= 7 && state.field.waterSport))) {
    return 'Water Sport is already active';
  }
  if (id === 'mudsport' && ((state.generation <= 5 && actor?.volatile?.mudSport) ||
    (state.generation >= 6 && state.generation <= 7 && state.field.mudSport))) {
    return 'Mud Sport is already active';
  }
  if (id === 'iondeluge' && state.field.ionDeluge) return 'Ion Deluge is already active';
  if (id === 'psychoshift' && actor && !actor.status) return 'Psycho Shift requires the user to have a major status';
  if (id === 'magiccoat' && actor?.volatile?.magicCoat) return 'Magic Coat is already active';
  if (id === 'snatch' && actor?.volatile?.snatch) return 'Snatch is already active';
  if (id === 'nightmare' && (state.generation < 2 || state.generation >= 8)) {
    return 'Nightmare is unavailable in this generation';
  }
  if (id === 'curse' && state.generation < CURSE_MOVE_MIN_GENERATION) {
    return 'Curse is unavailable before Generation II';
  }
  if (id === 'nightmare' && target && target.status !== 'slp') {
    return 'Nightmare requires a sleeping target';
  }
  if (id === 'nightmare' && target?.volatile?.nightmare) {
    return 'the target is already suffering Nightmare';
  }
  if (id === 'electrify' && state.generation < 6) {
    return 'Electrify is unavailable before Generation VI';
  }
  if (id === 'electrify' && target?.volatile?.electrified) {
    return 'the target is already Electrified';
  }
  if (id === 'octolock' && state.generation < 8) {
    return 'Octolock is unavailable before Generation VIII';
  }
  if (id === 'octolock' && target && (target.volatile?.octolock || target.volatile?.trapped)) {
    return 'the target is already trapped';
  }
  if (id === 'miracleeye' && state.generation < 4) {
    return 'Miracle Eye is unavailable before Generation IV';
  }
  if (PROTECTION_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < PROTECTION_MOVE_MIN_GENERATION[id]) {
    return `${action.moveName} is unavailable in this generation`;
  }
  if (id === 'miracleeye' && target?.volatile?.miracleEye) {
    return 'the target already has Miracle Eye';
  }
  if (id === 'gastroacid' && target && preventsAbilityChange(state, target)) {
    return 'the target ability was protected by Ability Shield';
  }
  if (id === 'gastroacid' && target?.abilitySuppressed) return 'the target ability is already suppressed';
  if (id === 'embargo' && target?.volatile?.embargo) return 'the target is already under Embargo';
  if (id === 'healblock' && target?.volatile?.healBlock) return 'the target is already under Heal Block';
  if (id === 'noretreat' && actor?.volatile?.trapped) return 'the user is already trapped';
  if (id === 'clangoroussoul' && actor && actor.hp.current <= Math.floor(actor.hp.max / 3)) {
    return 'Clangorous Soul requires more than one-third HP';
  }
  if (id === 'filletaway' && actor && actor.hp.current <= Math.floor(actor.hp.max / 2)) {
    return 'Fillet Away requires more than half HP';
  }
  if (actor?.volatile?.healBlock && new Set([
    'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'rest', 'roost',
    'shoreup', 'slackoff', 'softboiled', 'strengthsap', 'swallow', 'synthesis',
  ]).has(id)) return 'Heal Block prevents recovery moves';
  if ((id === 'block' || id === 'meanlook' || id === 'spiderweb') && target?.volatile?.trapped) {
    return 'the target is already trapped';
  }
  if (id === 'painsplit' && actor && target && actor.hp.current === target.hp.current) {
    return 'Pain Split would not change either HP total';
  }
  if (id === 'flowershield') {
    if (state.generation < 6 || state.generation > 8) return 'Flower Shield is unavailable in this generation';
    const eligible = action.targetIds.some(targetId => {
      const pokemon = getPokemon(state, targetId);
      return !!pokemon && pokemon.hp.current > 0 &&
        getEffectiveTypes(state, targetId).some(type => moveId(type) === 'grass') &&
        (pokemon.boosts?.def || 0) < 6;
    });
    if (!eligible) return 'no active Grass-type Pokémon can gain Defense';
  }
  if (id === 'rototiller') {
    if (state.generation < 6 || state.generation > 7) return 'Rototiller is unavailable in this generation';
    const eligible = action.targetIds.some(targetId => {
      const pokemon = getPokemon(state, targetId);
      return !!pokemon && pokemon.hp.current > 0 && isGrounded(state, targetId) &&
        getEffectiveTypes(state, targetId).some(type => moveId(type) === 'grass') &&
        ((pokemon.boosts?.atk || 0) < 6 || (pokemon.boosts?.spa || 0) < 6);
    });
    if (!eligible) return 'no grounded Grass-type Pokémon can gain Attack and Special Attack';
  }
  if (id === 'teatime') {
    if (state.generation !== 8) return 'Teatime is unavailable in this generation';
    const eligible = action.targetIds.some(targetId => {
      const pokemon = getPokemon(state, targetId);
      return !!pokemon && pokemon.hp.current > 0 && moveId(pokemon.item || '').endsWith('berry');
    });
    if (!eligible) return 'no active Pokémon is holding a Berry';
  }
  if (PROTECTIVE_POLICY_MOVES.has(id) && ownEffects.protected) return `${action.moveName} is already active`;
  const stockpileCount = actor?.volatile?.stockpile?.stacks || 0;
  if (id === 'stockpile' && stockpileCount >= 3) return 'Stockpile is already full';
  if ((id === 'swallow' || id === 'spitup') && stockpileCount === 0) {
    return `${action.moveName} requires Stockpile energy`;
  }
  if (id === 'acupressure' && target && ['atk', 'def', 'spa', 'spd', 'spe'].every(stat =>
    (target.boosts?.[stat as keyof StatBoosts] || 0) >= 6)) {
    return 'all Acupressure stats are already maxed';
  }
  if (id === 'psychup' && actor && target && sameStages(actor, target, ['atk', 'def', 'spa', 'spd', 'spe'])) {
    return 'Psych Up would not change the user\'s stat stages';
  }
  if ((id === 'guardswap' || id === 'powerswap') && actor && target) {
    const stats = id === 'guardswap' ? ['def', 'spd'] : ['atk', 'spa'];
    if (sameStages(actor, target, stats)) return `${action.moveName} would not change either Pokémon's stages`;
  }
  if (ALLY_HEALING_MOVES.has(id) && target && sideForPokemon(state, target.id) === actorSide &&
    target.hp.current >= target.hp.max) {
    return 'the ally is already at full HP';
  }
  if (ALLY_TEAM_HEALING_MOVES.has(id)) {
    const allies = action.targetIds
      .map(targetId => getPokemon(state, targetId))
      .filter((pokemon): pokemon is NonNullable<ReturnType<typeof getPokemon>> =>
        !!pokemon && sideForPokemon(state, pokemon.id) === actorSide);
    const useful = allies.some(pokemon => pokemon.hp.current < pokemon.hp.max ||
      (id === 'junglehealing' && (!!pokemon.status || !!pokemon.toxicCounter)));
    if (!useful) return 'all allies are already healed';
  }
  if (id === 'refresh' && actor && !actor.status && !actor.toxicCounter) {
    return 'the user has no major status';
  }
  if (id === 'purify' && target && !target.status && !target.toxicCounter) {
    return 'the target has no major status';
  }
  if (ALLY_TEAM_CLEANSE_MOVES.has(id)) {
    const useful = action.targetIds
      .map(targetId => getPokemon(state, targetId))
      .some(pokemon => !!pokemon && sideForPokemon(state, pokemon.id) === actorSide &&
        (!!pokemon.status || !!pokemon.toxicCounter));
    if (!useful) return 'all allies have no major status';
  }
  if (PURE_STATUS_MOVE_IDS.has(id) && target && (target.status || target.toxicCounter)) {
    return 'the target already has a major status';
  }
  const effectivePriority = evaluation.facts.priority ?? getActionOrderFacts(state, action).priority;
  const moveCategory = evaluation.facts.moveCategory || getMoveMetadata(action.moveName, state.generation).category || 'Status';
  const opposingTargetIds = action.targetIds.filter(targetId => {
    const target = getPokemon(state, targetId);
    return !!target && sideForPokemon(state, target.id) !== actorSide;
  });
  if (opposingTargetIds.length && opposingTargetIds.every(targetId =>
    isPriorityBlocked(state, action.actorId, targetId, effectivePriority, moveCategory))) {
    return 'priority is blocked for every opposing target';
  }
  if (id === 'rest' && actor && (actor.hp.current >= actor.hp.max || !canApplyMajorStatus(
    state,
    actor.id,
    actor.id,
    'slp',
    undefined,
    false,
    true,
  ))) return actor.hp.current >= actor.hp.max ? 'the user is already at full HP' : 'Rest is blocked by sleep eligibility';
  const status = STATUS_BY_MOVE[id] || (id === 'yawn' ? 'slp' : undefined);
  if (status && target && !canApplyMajorStatus(
    state,
    action.actorId,
    target.id,
    status,
    evaluation.facts.moveType,
    true,
  )) return 'the target is immune to this status';
  if (id === 'encore' && target && !state.lastMoveByPokemon?.[target.id]) {
    return 'the target has not used a move yet';
  }
  if (id === 'encore' && target && state.firstTurnOutIds?.includes(target.id)) {
    return 'the target is on its first turn out';
  }
  if (id === 'encore' && target?.volatile?.encore) return 'the target is already Encored';
  if (id === 'taunt' && target?.volatile?.taunt) return 'the target is already Taunted';
  if (['darkvoid', 'grasswhistle', 'hypnosis', 'lovelykiss', 'sing', 'sleeppowder', 'spore', 'yawn'].includes(id) &&
    target && isAbilityActive(target, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(target)) &&
    ['insomnia', 'vitalspirit', 'sweetveil'].includes(moveId(target ? getEffectiveAbility(target) || '' : '')) &&
    !ignoresTargetAbility(state, action.actorId, target.id)) {
    return 'sleep is blocked by the target ability';
  }
  const opponentId = state.sides[targetSide].activeIds.find(activeId =>
    getPokemon(state, activeId)?.hp.current && activeId !== action.actorId);
  const factTarget = action.targetIds.length ? getPokemon(state, action.targetIds[0]) : undefined;
  const factTargetIsOpponent = !!factTarget && sideForPokemon(state, factTarget.id) !== actorSide;
  const opponentAbility = factTargetIsOpponent
    ? evaluation.facts.defenderAbility || (opponentId ? (() => {
      const opponent = getPokemon(state, opponentId);
      return activeAbility(state, opponent);
    })() : undefined)
    : (opponentId ? (() => {
      const opponent = getPokemon(state, opponentId);
      return activeAbility(state, opponent);
    })() : undefined) || evaluation.facts.defenderAbility;
  if ((id === 'focusenergy' || id === 'laserfocus') &&
    CRIT_BLOCKING_ABILITIES.has(moveId(opponentAbility || ''))) {
    return 'critical hits are blocked by the target ability';
  }
  if (SETUP_MOVES.has(id)) {
    if (actor && PURE_SELF_STAGE_MOVE_IDS.has(id) && !hasSelfStageEffect(actor.boosts, id) &&
      !(id === 'takeheart' && actor.status)) {
      return 'the setup stats are already maxed';
    }
    if (opponentAbility && moveId(opponentAbility) === 'unaware' && !UNAWARE_SETUP_EXCEPTIONS.has(id)) {
      return 'the target has Unaware';
    }
    if (evaluation.facts.opponentCanKO && !SETUP_WHEN_THREATENED.has(id) &&
      !hasSetupSurvivalLine(state, actor, evaluation.facts)) {
      return 'the opponent can KO before setup pays off';
    }
  }

  const recoveryMoves = new Set([
    'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'roost', 'shoreup',
    'slackoff', 'softboiled', 'strengthsap', 'swallow', 'synthesis',
  ]);
  if (recoveryMoves.has(id) && actor && actor.hp.current >= actor.hp.max) {
    return 'the user is already at full HP';
  }
  if (recoveryMoves.has(id) && actor && actor.hp.current / actor.hp.max >= 0.85) {
    return 'recovery is discouraged above 85% HP';
  }

  return undefined;
}

function hazardScore(
  id: string,
  evaluation: ActionEvaluation,
  targetEffects: NonNullable<BattleState['sides']['ai']['effects']>,
): {outcomes: ActionEvaluation['outcomes']; adjustment: number} | undefined {
  const firstTurn = !!evaluation.facts.isFirstTurnOut;
  if (id === 'stealthrock') {
    return {
      outcomes: firstTurn
        ? [{score: 8, probability: 0.25}, {score: 9, probability: 0.75}]
        : [{score: 6, probability: 0.25}, {score: 7, probability: 0.75}],
      adjustment: 0,
    };
  }
  if (id === 'spikes' || id === 'toxicspikes') {
    const layers = id === 'spikes' ? (targetEffects.spikes || 0) : (targetEffects.toxicSpikes || 0);
    return {
      outcomes: firstTurn
        ? [{score: 8, probability: 0.25}, {score: 9, probability: 0.75}]
        : [{score: 6, probability: 0.25}, {score: 7, probability: 0.75}],
      adjustment: layers ? -1 : 0,
    };
  }
  if (id === 'stickyweb') {
    return {
      outcomes: firstTurn
        ? [{score: 9, probability: 0.25}, {score: 12, probability: 0.75}]
        : [{score: 6, probability: 0.25}, {score: 9, probability: 0.75}],
      adjustment: 0,
    };
  }
  return undefined;
}

function mementoScore(evaluation: ActionEvaluation): ActionEvaluation['outcomes'] | undefined {
  if (evaluation.action.kind !== 'move' || moveId(evaluation.action.moveName) !== 'memento') return undefined;
  if ((evaluation.facts.attackerPartyAliveCount || 0) <= 1) return [{score: -20, probability: 1}];
  const hp = evaluation.facts.attackerHpPercent === undefined ? 100 : evaluation.facts.attackerHpPercent;
  if (hp < 10) return [{score: 16, probability: 1}];
  if (hp < 33) return [{score: 14, probability: 0.7}, {score: 6, probability: 0.3}];
  if (hp < 66) return [{score: 13, probability: 0.5}, {score: 6, probability: 0.5}];
  return [{score: 13, probability: 0.05}, {score: 6, probability: 0.95}];
}

function setupScore(
  state: BattleState,
  evaluation: ActionEvaluation,
  id: string,
): ActionEvaluation['outcomes'] | undefined {
  if (!SETUP_MOVES.has(id)) return undefined;
  if (id === 'agility' || id === 'autotomize' || id === 'rockpolish') return undefined;
  const facts = evaluation.facts;
  const actor = evaluation.action.kind === 'move'
    ? getPokemon(state, evaluation.action.actorId)
    : undefined;
  const incapacitated = defenderIsIncapacitated(state, evaluation);
  const slower = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
    facts.attackerSpeed < facts.defenderSpeed;

  if (id === 'bellydrum') {
    if (incapacitated) return [{score: 9, probability: 1}];
    const item = moveId(facts.attackerItem || (actor && isItemEffectActive(state, actor) ? actor.item : '') || '');
    const sitrusActive = item === 'sitrusberry' &&
      (!actor || (isItemEffectActive(state, actor) && !actor.volatile?.healBlock));
    const postDrumHp = actor
      ? Math.floor(actor.hp.max / 2) + (sitrusActive ? Math.floor(actor.hp.max / 4) : 0)
      : undefined;
    const survives = postDrumHp !== undefined && facts.opponentMaxDamage !== undefined
      ? facts.opponentMaxDamage < postDrumHp
      : !facts.opponentCanKO;
    return [{score: survives ? 8 : 4, probability: 1}];
  }
  if (id === 'shellsmash') {
    const attackerBoosts = facts.attackerBoosts || {};
    if ((attackerBoosts.atk || 0) >= 1 || (attackerBoosts.atk || 0) >= 6 || (attackerBoosts.spa || 0) >= 6) {
      return [{score: -20, probability: 1}];
    }
    const survives = facts.opponentMaxDamage !== undefined && facts.attackerHp !== undefined
      ? facts.opponentMaxDamage < facts.attackerHp
      : !facts.opponentCanKO;
    return [{score: 6 + (incapacitated ? 3 : 0) + (survives ? 2 : -2), probability: 1}];
  }

  let defensive = DEFENSIVE_SETUP_MOVES.has(id);
  if (PHYSICAL_DUAL_SETUP_MOVES.has(id)) {
    defensive = !!facts.defenderHasPhysicalMove && !facts.defenderHasSpecialMove;
  } else if (SPECIAL_DUAL_SETUP_MOVES.has(id)) {
    defensive = !!facts.defenderHasSpecialMove && !facts.defenderHasPhysicalMove;
  }

  if (!defensive && (id === 'tailglow' || id === 'nastyplot' || id === 'workup')) {
    let score = 6 + (incapacitated ? 3 : 0);
    const attackerHp = facts.attackerHp ?? actor?.hp.current;
    const cannotThreeHKO = facts.opponentMaxDamage !== undefined && attackerHp !== undefined
      ? facts.opponentMaxDamage * 3 < attackerHp
      : !facts.opponentCan2HKO;
    if (!incapacitated && cannotThreeHKO) {
      score += 1;
      if (!slower) score += 1;
    }
    if (slower && facts.opponentCan2HKO) score -= 5;
    if ((facts.attackerBoosts?.spa || actor?.boosts?.spa || 0) >= 2) score -= 1;
    return [{score, probability: 1}];
  }

  if (!defensive && OFFENSIVE_SETUP_MOVES.has(id)) {
    let score = 6 + (incapacitated ? 3 : 0);
    if (!slower && !facts.opponentCanKO) score += 3;
    if (slower && facts.opponentCan2HKO) score -= 5;
    return [{score, probability: 1}];
  }

  if (defensive) {
    let score = 6;
    if (!slower && !facts.opponentCanKO) score += 3;
    if (slower && facts.opponentCan2HKO) score -= 5;
    const boosts = facts.attackerBoosts || {};
    if ((id === 'cosmicpower' || id === 'stockpile') &&
      ((boosts.def || 0) < 2 || (boosts.spd || 0) < 2)) score += 2;
    const outcomes: ActionEvaluation['outcomes'] = [{score, probability: 1}];
    return incapacitated ? chanceBonus(outcomes, 2, 0.95) : outcomes;
  }

  return [{score: 6, probability: 1}];
}

function chanceBonus(
  outcomes: ActionEvaluation['outcomes'],
  bonus: number,
  probability: number,
): ActionEvaluation['outcomes'] {
  return outcomes.flatMap(outcome => [
    {score: outcome.score, probability: outcome.probability * (1 - probability)},
    {score: outcome.score + bonus, probability: outcome.probability * probability},
  ]);
}

function restSleepCureAvailable(
  state: BattleState,
  facts: ActionEvaluation['facts'],
): boolean {
  const item = moveId(facts.attackerItem || '');
  const ability = moveId(facts.attackerAbility || '');
  return ['lumberry', 'chestoberry'].includes(item) ||
    hasMove(facts.attackerMoves, 'sleeptalk') || hasMove(facts.attackerMoves, 'snore') ||
    ['shedskin', 'earlybird'].includes(ability) ||
    (ability === 'hydration' && isRainWeather(state.field.weather));
}

function hasSetupSurvivalLine(
  state: BattleState,
  actor: ReturnType<typeof getPokemon>,
  facts: ActionEvaluation['facts'],
): boolean {
  if (!actor || actor.hp.current < actor.hp.max) return false;
  const ability = moveId(facts.attackerAbility || activeAbility(state, actor) || '');
  const item = moveId(facts.attackerItem || (isItemEffectActive(state, actor) ? actor.item : '') || '');
  return (ability === 'sturdy' && isAbilityActive(actor, state)) ||
    (item === 'focussash' && !actor.itemLost);
}

function restScore(
  state: BattleState,
  evaluation: ActionEvaluation,
): ActionEvaluation['outcomes'] | undefined {
  if (evaluation.action.kind !== 'move' || moveId(evaluation.action.moveName) !== 'rest') return undefined;
  const facts = evaluation.facts;
  const actor = getPokemon(state, evaluation.action.actorId);
  if (!actor) return undefined;
  const hpPercent = facts.attackerHpPercent ?? (actor.hp.current / actor.hp.max * 100);
  const currentHp = facts.attackerHp ?? actor.hp.current;
  const maximumHp = hpPercent > 0 ? currentHp * 100 / hpPercent : actor.hp.max;
  const healAmount = Math.max(0, maximumHp - currentHp);
  const opponentMaxDamage = facts.opponentMaxDamage ?? (facts.opponentCanKO ? currentHp : 0);
  const cureAvailable = restSleepCureAvailable(state, {
    ...facts,
    attackerItem: facts.attackerItem ?? (isItemEffectActive(state, actor) ? actor.item : undefined),
    attackerAbility: facts.attackerAbility ?? activeAbility(state, actor),
    attackerMoves: facts.attackerMoves ?? actor.moves.map(move => move.name),
  });
  if (facts.attackerStatus === 'tox' || actor.status === 'tox') return [{score: 5, probability: 1}];
  if (opponentMaxDamage >= healAmount) return [{score: 5, probability: 1}];

  const opponentFastest = Math.max(...(facts.opponentSpeeds || []), -Infinity);
  const actsBeforeOpponent = facts.attackerSpeed === undefined ||
    facts.attackerSpeed >= opponentFastest;
  let recoverOutcomes: Array<{recover: boolean; probability: number}>;
  if (actsBeforeOpponent) {
    if (facts.opponentCanKO && opponentMaxDamage < maximumHp) {
      recoverOutcomes = [{recover: true, probability: 1}];
    } else if (!facts.opponentCanKO && hpPercent < 40) {
      recoverOutcomes = [{recover: true, probability: 1}];
    } else if (!facts.opponentCanKO && hpPercent < 66) {
      recoverOutcomes = [{recover: true, probability: 0.5}, {recover: false, probability: 0.5}];
    } else {
      recoverOutcomes = [{recover: false, probability: 1}];
    }
  } else if (hpPercent < 50) {
    recoverOutcomes = [{recover: true, probability: 1}];
  } else if (hpPercent < 70) {
    recoverOutcomes = [{recover: true, probability: 0.75}, {recover: false, probability: 0.25}];
  } else {
    recoverOutcomes = [{recover: false, probability: 1}];
  }
  return recoverOutcomes.map(outcome => ({
    score: outcome.recover ? (cureAvailable ? 8 : 7) : 5,
    probability: outcome.probability,
  }));
}

function recoveryDecision(
  state: BattleState,
  evaluation: ActionEvaluation,
  healingFraction: number,
): Array<{recover: boolean; probability: number}> {
  const facts = evaluation.facts;
  const actor = evaluation.action.kind === 'move'
    ? getPokemon(state, evaluation.action.actorId)
    : undefined;
  const currentHp = facts.attackerHp ?? actor?.hp.current;
  const maximumHp = actor?.hp.max ?? (facts.attackerHpPercent && currentHp
    ? currentHp * 100 / facts.attackerHpPercent
    : undefined);
  if (currentHp === undefined || maximumHp === undefined) {
    return [{recover: false, probability: 1}];
  }
  const hpPercent = facts.attackerHpPercent ?? (currentHp / maximumHp * 100);
  const healAmount = maximumHp * healingFraction;
  const opponentMaxDamage = facts.opponentMaxDamage ?? (facts.opponentCanKO ? currentHp : 0);
  if (opponentMaxDamage >= healAmount) return [{recover: false, probability: 1}];

  const opponentFastest = Math.max(...(facts.opponentSpeeds || []), -Infinity);
  const actsBeforeOpponent = facts.attackerSpeed === undefined ||
    facts.attackerSpeed >= opponentFastest;
  if (actsBeforeOpponent) {
    if (facts.opponentCanKO && opponentMaxDamage < maximumHp) {
      return [{recover: true, probability: 1}];
    }
    if (!facts.opponentCanKO && hpPercent < 40) {
      return [{recover: true, probability: 1}];
    }
    if (!facts.opponentCanKO && hpPercent < 66) {
      return [{recover: true, probability: 0.5}, {recover: false, probability: 0.5}];
    }
    return [{recover: false, probability: 1}];
  }
  if (hpPercent < 50) return [{recover: true, probability: 1}];
  if (hpPercent < 70) return [{recover: true, probability: 0.75}, {recover: false, probability: 0.25}];
  return [{recover: false, probability: 1}];
}

function recoveryScore(
  state: BattleState,
  evaluation: ActionEvaluation,
  id: string,
): ActionEvaluation['outcomes'] {
  const actor = evaluation.action.kind === 'move'
    ? getPokemon(state, evaluation.action.actorId)
    : undefined;
  const stockpileStacks = actor?.volatile?.stockpile?.stacks || 0;
  const swallowFraction = stockpileStacks >= 3 ? 1 : stockpileStacks === 2 ? 1 / 2 : 1 / 4;
  const sunRecovery = WEATHER_RECOVERY_MOVES.has(id) && isSunWeather(state.field.weather);
  const healingFraction = id === 'swallow'
    ? swallowFraction
    : sunRecovery ? 2 / 3 : 1 / 2;
  const decisions = recoveryDecision(state, evaluation, healingFraction);
  if (!sunRecovery) {
    return decisions.map(outcome => ({score: outcome.recover ? 7 : 5, probability: outcome.probability}));
  }
  return decisions.flatMap(outcome => {
    if (outcome.recover) return [{score: 7, probability: outcome.probability}];
    const fallback = recoveryDecision(state, evaluation, 1 / 2);
    return fallback.map(fallbackOutcome => ({
      score: fallbackOutcome.recover ? 7 : 5,
      probability: outcome.probability * fallbackOutcome.probability,
    }));
  });
}

function statusBaseScore(
  state: BattleState,
  evaluation: ActionEvaluation,
): ActionEvaluation['outcomes'] {
  if (evaluation.action.kind !== 'move') return [{score: 0, probability: 1}];
  const id = moveId(evaluation.action.moveName);
  const actor = getPokemon(state, evaluation.action.actorId);
  const targetSide = sideForPokemon(state, evaluation.action.actorId) === 'ai' ? 'player' : 'ai';
  const targetEffects = state.sides[targetSide].effects || {};
  const hazard = hazardScore(id, evaluation, targetEffects);
  if (hazard) return hazard.outcomes.map(outcome => ({...outcome, score: outcome.score + hazard.adjustment}));
  const memento = mementoScore(evaluation);
  if (memento) return memento;
  const rest = restScore(state, evaluation);
  if (rest) return rest;
  const setup = setupScore(state, evaluation, id);
  if (setup) return setup;
  if (id === 'fling') {
    if (SPEED_BOOST_ITEMS.has(moveId(evaluation.facts.attackerItem || ''))) {
      const partner = activePartner(state, evaluation.action.actorId);
      const partnerHasWeaknessPolicy = !!partner && isItemEffectActive(state, partner) &&
        moveId(partner.item || '') === 'weaknesspolicy';
      return [{score: partnerHasWeaknessPolicy && evaluation.facts.isSuperEffective ? 12 : 9, probability: 1}];
    }
    return [{score: 6, probability: 1}];
  }
  if (id === 'roleplay') {
    const partner = activePartner(state, evaluation.action.actorId);
    const partnerAbility = moveId(activeAbility(state, partner) || '');
    const ownAbility = moveId(evaluation.facts.attackerAbility || '');
    return [{
      score: state.mode === 'Doubles' && ROLE_PLAY_ABILITIES.has(partnerAbility) &&
        !ROLE_PLAY_ABILITIES.has(ownAbility) ? 9 : -20,
      probability: 1,
    }];
  }
  if (id === 'coaching') {
    const partner = activePartner(state, evaluation.action.actorId);
    if (state.mode !== 'Doubles' || !partner || moveId(activeAbility(state, partner) || '') === 'contrary') {
      return [{score: -20, probability: 1}];
    }
    let score = 6;
    const atk = partner.boosts?.atk || 0;
    const def = partner.boosts?.def || 0;
    if (atk < 2) score += 1 - atk;
    if (def < 2) score += 1 - def;
    return chanceBonus([{score, probability: 1}], 1, 0.8);
  }
  if (id === 'trick' || id === 'switcheroo') {
    const item = moveId(evaluation.facts.attackerItem || '');
    if (HARMFUL_TRICK_ITEMS.has(item)) return [{score: 6, probability: 0.5}, {score: 7, probability: 0.5}];
    if (DISRUPTIVE_TRICK_ITEMS.has(item)) return [{score: 7, probability: 1}];
    return [{score: 5, probability: 1}];
  }
  if (id === 'focusenergy' || id === 'laserfocus') {
    const hasCritSetup = CRIT_SETUP_ABILITIES.has(moveId(evaluation.facts.attackerAbility || '')) ||
      moveId(evaluation.facts.attackerItem || '') === 'scopelens' ||
      (evaluation.facts.attackerMoves || []).some(move =>
        HIGH_CRIT_MOVES.has(moveId(move)) && !ALWAYS_CRIT_MOVES.has(moveId(move)));
    return [{score: hasCritSetup ? 7 : 6, probability: 1}];
  }
  if (id === 'encore') {
    if (evaluation.facts.defenderLastMoveIsStatus === undefined) return [{score: 6, probability: 1}];
    const faster = evaluation.facts.attackerSpeed !== undefined && evaluation.facts.defenderSpeed !== undefined &&
      evaluation.facts.attackerSpeed >= evaluation.facts.defenderSpeed;
    return faster
      ? [{score: evaluation.facts.defenderLastMoveIsStatus ? 7 : 6, probability: 1}]
      : [{score: 6, probability: 0.5}, {score: 5, probability: 0.5}];
  }
  if (id === 'counter' || id === 'mirrorcoat') {
    const physical = id === 'counter';
    const onlyMatchingMoves = physical
      ? !!evaluation.facts.defenderHasPhysicalMove && !evaluation.facts.defenderHasSpecialMove
      : !!evaluation.facts.defenderHasSpecialMove && !evaluation.facts.defenderHasPhysicalMove;
    const sturdyOrSash = moveId(evaluation.facts.attackerAbility || '') === 'sturdy' ||
      moveId(evaluation.facts.attackerItem || '') === 'focussash';
    const hasSturdyCounterLine = sturdyOrSash && evaluation.facts.attackerHpPercent === 100 && onlyMatchingMoves;
    if (evaluation.facts.opponentCanKO && !hasSturdyCounterLine) return [{score: -14, probability: 1}];
    let outcomes: ActionEvaluation['outcomes'] = [{score: hasSturdyCounterLine ? 8 : 6, probability: 1}];
    if (!evaluation.facts.opponentCanKO && onlyMatchingMoves) outcomes = chanceBonus(outcomes, 2, 0.8);
    const faster = evaluation.facts.attackerSpeed !== undefined && evaluation.facts.defenderSpeed !== undefined &&
      evaluation.facts.attackerSpeed >= evaluation.facts.defenderSpeed;
    if (faster) outcomes = chanceBonus(outcomes, -1, 0.25);
    if (evaluation.facts.defenderHasStatusMove) outcomes = chanceBonus(outcomes, -1, 0.25);
    return outcomes;
  }
  if (id === 'reflect' || id === 'lightscreen') {
    const matchingMove = id === 'reflect'
      ? evaluation.facts.defenderHasPhysicalMove
      : evaluation.facts.defenderHasSpecialMove;
    if (!matchingMove) return [{score: 6, probability: 1}];
    const lightClay = moveId(evaluation.facts.attackerItem || '') === 'lightclay';
    return chanceBonus([{score: 6 + (lightClay ? 1 : 0), probability: 1}], 1, 0.5);
  }
  if (id === 'substitute') {
    if ((actor?.substituteHp || 0) > 0) return [{score: -20, probability: 1}];
    if ((evaluation.facts.attackerHpPercent || 0) <= 50 ||
      moveId(evaluation.facts.defenderAbility || '') === 'infiltrator') {
      return [{score: -20, probability: 1}];
    }
    let outcomes: ActionEvaluation['outcomes'] = [{score: 6, probability: 1}];
    if (evaluation.facts.defenderStatus === 'slp') outcomes = outcomes.map(outcome => ({...outcome, score: outcome.score + 2}));
    const faster = evaluation.facts.attackerSpeed !== undefined && evaluation.facts.defenderSpeed !== undefined &&
      evaluation.facts.attackerSpeed > evaluation.facts.defenderSpeed;
    if (evaluation.facts.defenderSeeded && faster) {
      outcomes = outcomes.map(outcome => ({...outcome, score: outcome.score + 2}));
    }
    if (evaluation.facts.defenderHasSoundMove) {
      outcomes = outcomes.map(outcome => ({...outcome, score: outcome.score - 8}));
    }
    return chanceBonus(outcomes, -1, 0.5);
  }
  if (id === 'willowisp') {
    const bonus = (evaluation.facts.defenderHasPhysicalMove ? 1 : 0) +
      (hasMove([
        ...(evaluation.facts.attackerMoves || []),
        ...(evaluation.facts.attackerPartnerMoves || []),
      ], 'hex') ? 1 : 0);
    return bonus
      ? [{score: 6, probability: 0.63}, {score: 6 + bonus, probability: 0.37}]
      : [{score: 6, probability: 1}];
  }
  if (id === 'thunderwave' || id === 'glare' || id === 'nuzzle' || id === 'stunspore' || id === 'zapcannon') {
    const attackerSpeed = evaluation.facts.attackerSpeed;
    const defenderSpeed = evaluation.facts.defenderSpeed;
    const speedUseful = attackerSpeed !== undefined && defenderSpeed !== undefined &&
      defenderSpeed > attackerSpeed && defenderSpeed * 0.25 < attackerSpeed;
    const allAttackerMoves = [
      ...(evaluation.facts.attackerMoves || []),
      ...(evaluation.facts.attackerPartnerMoves || []),
    ];
    const moveSynergy = hasMove(allAttackerMoves, 'hex') || evaluation.facts.attackerHasFlinchMove === true;
    const targetSynergy = evaluation.facts.defenderConfused === true ||
      evaluation.facts.defenderInfatuated === true;
    const useful = speedUseful || moveSynergy || targetSynergy;
    return chanceBonus([{score: useful ? 8 : 7, probability: 1}], -1, 0.5);
  }
  if (id === 'darkvoid' || id === 'grasswhistle' || id === 'hypnosis' || id === 'lovelykiss' ||
    id === 'sing' || id === 'sleeppowder' || id === 'spore' || id === 'yawn') {
    const sleepBlocked = ['insomnia', 'vitalspirit', 'sweetveil'].includes(
      moveId(evaluation.facts.defenderAbility || ''));
    if (sleepBlocked && !ignoresTargetAbility(state, evaluation.action.actorId, evaluation.action.targetIds[0])) {
      return [{score: 6, probability: 1}];
    }
    if (evaluation.facts.opponentCanKO) return [{score: 6, probability: 1}];
    const allAttackerMoves = [
      ...(evaluation.facts.attackerMoves || []),
      ...(evaluation.facts.attackerPartnerMoves || []),
    ];
    const targetSleepCure = hasMove(evaluation.facts.defenderMoves, 'sleeptalk') ||
      hasMove(evaluation.facts.defenderMoves, 'snore');
    const bonus = (hasMove(allAttackerMoves, 'dreameater') ||
      hasMove(allAttackerMoves, 'nightmare')) && !targetSleepCure ? 1 : 0;
    const hexBonus = hasMove(allAttackerMoves, 'hex') ? 1 : 0;
    return [{score: 6, probability: 0.75}, {score: 7 + bonus + hexBonus, probability: 0.25}];
  }
  if (POISONING_MOVES.has(id)) {
    const synergy = hasMove(evaluation.facts.attackerMoves, 'hex') ||
      hasMove(evaluation.facts.attackerMoves, 'venomdrench') ||
      hasMove(evaluation.facts.attackerMoves, 'venoshock') ||
      moveId(evaluation.facts.attackerAbility || '') === 'merciless';
    const targetCanSupportToxic = !evaluation.facts.opponentCanKO &&
      (evaluation.facts.defenderHpPercent === undefined || evaluation.facts.defenderHpPercent > 20);
    const targetHasNoDamagingMoves = evaluation.facts.defenderHasPhysicalMove === false &&
      evaluation.facts.defenderHasSpecialMove === false;
    const bonus = targetCanSupportToxic && synergy && targetHasNoDamagingMoves ? 2 : 0;
    return bonus
      ? [{score: 6, probability: 0.62}, {score: 6 + bonus, probability: 0.38}]
      : [{score: 6, probability: 1}];
  }
  if (RECOVERY_MOVES.has(id)) {
    return recoveryScore(state, evaluation, id);
  }
  if (id === 'taunt') {
    const faster = evaluation.facts.attackerSpeed !== undefined && evaluation.facts.defenderSpeed !== undefined &&
      evaluation.facts.attackerSpeed >= evaluation.facts.defenderSpeed;
    const targetHasInactiveTrickRoom = evaluation.facts.defenderMoves?.some(move =>
      moveId(move) === 'trickroom' && !state.field.trickRoom);
    const targetHasDefogWithAuroraVeil = !!targetEffects.auroraVeil &&
      evaluation.facts.defenderMoves?.some(move => moveId(move) === 'defog');
    const encouragesTaunt = !!targetHasInactiveTrickRoom || (faster && !!targetHasDefogWithAuroraVeil);
    return [{score: encouragesTaunt ? 9 : 5, probability: 1}];
  }
  if (id === 'imprison') {
    const attackerMoves = new Set((evaluation.facts.attackerMoves || []).map(moveId));
    const sharesMove = (evaluation.facts.defenderMoves || []).some(move => attackerMoves.has(moveId(move)));
    return [{score: sharesMove ? 9 : -20, probability: 1}];
  }
  if (id === 'destinybond') {
    const faster = evaluation.facts.attackerSpeed !== undefined && evaluation.facts.defenderSpeed !== undefined &&
      evaluation.facts.attackerSpeed >= evaluation.facts.defenderSpeed;
    if (faster && evaluation.facts.opponentCanKO) {
      return [
        {score: 7, probability: 0.81},
        {score: 6, probability: 0.19},
      ];
    }
    return !faster
      ? [{score: 5, probability: 0.5}, {score: 6, probability: 0.5}]
      : [{score: 6, probability: 1}];
  }
  if (id === 'batonpass') {
    const hasBoost = Object.values(evaluation.facts.attackerBoosts || {}).some(boost => (boost || 0) > 0);
    if ((evaluation.facts.attackerPartyAliveCount || 0) <= 1) return [{score: -20, probability: 1}];
    return [{score: hasBoost || evaluation.facts.attackerSubstitute ? 14 : 0, probability: 1}];
  }
  if (id === 'agility' || id === 'autotomize' || id === 'rockpolish') {
    const slower = evaluation.facts.attackerSpeed !== undefined && evaluation.facts.defenderSpeed !== undefined &&
      evaluation.facts.attackerSpeed < evaluation.facts.defenderSpeed;
    return [{score: slower ? 7 : -20, probability: 1}];
  }
  if (id === 'electricterrain' || id === 'grassyterrain' || id === 'mistyterrain' || id === 'psychicterrain') {
    return [{score: moveId(evaluation.facts.attackerItem || '') === 'terrainextender' ? 9 : 8, probability: 1}];
  }
  if (id === 'fakeout' && evaluation.facts.isFirstTurnOut) return [{score: 9, probability: 1}];
  return [{score: 6, probability: 1}];
}

export function scoreStatusAction(
  state: BattleState,
  evaluation: ActionEvaluation,
): ActionEvaluation {
  evaluation = {...evaluation, facts: normalizeGenerationFacts(state, evaluation.facts)};
  const reason = noOpReason(state, evaluation);
  const discouragedRecovery = reason === 'recovery is discouraged above 85% HP';
  const action = evaluation.action;
  const actor = action.kind === 'move' ? getPokemon(state, action.actorId) : undefined;
  const protect = action.kind === 'move' && PROTECTIVE_POLICY_MOVES.has(moveId(action.moveName));
  const opposingSide = action.kind === 'move'
    ? sideForPokemon(state, action.actorId) === 'ai' ? 'player' : 'ai'
    : undefined;
  const opponentHasProtectContext = opposingSide
    ? state.sides[opposingSide].activeIds.some(id => {
      const pokemon = getPokemon(state, id);
      return !!pokemon && pokemon.hp.current > 0 && hasProtectContext(pokemon);
    })
    : false;
  const protectAdjustment = protect
    ? (hasProtectContext(actor) ? -2 : 0) + (opponentHasProtectContext ? 1 : 0) +
      (state.mode === 'Singles' && state.firstTurnOutIds?.includes(action.actorId) ? -1 : 0)
    : 0;
  const baseScore = 6 + protectAdjustment;
  const fieldSetup = action.kind === 'move' &&
    (moveId(action.moveName) === 'tailwind' || moveId(action.moveName) === 'trickroom');
  const fieldSetupId = action.kind === 'move' ? moveId(action.moveName) : '';
  const activeSpeeds = [
    evaluation.facts.attackerSpeed,
    ...(evaluation.facts.battleMode === 'Doubles'
      ? [evaluation.facts.attackerPartnerSpeed]
      : []),
  ].filter((speed): speed is number => speed !== undefined);
  const anyAllySlower = evaluation.facts.opponentSpeeds?.some(opponentSpeed =>
    activeSpeeds.some(allySpeed => allySpeed < opponentSpeed)) === true;
  const fieldSetupScore = fieldSetup
    ? fieldSetupId === 'trickroom' && state.field.trickRoom
      ? -20
      : (anyAllySlower
        ? fieldSetupId === 'trickroom' ? 10 : 9
        : 5)
    : baseScore;
  const usedProtectLastTurn = protect &&
    state.lastMoveByPokemon?.[action.actorId] !== undefined &&
    PROTECTIVE_POLICY_MOVES.has(moveId(state.lastMoveByPokemon[action.actorId]));
  const repeatedProtect = protect && state.moveStreakByPokemon?.[action.actorId]?.moveName !== undefined &&
    PROTECTIVE_POLICY_MOVES.has(moveId(state.moveStreakByPokemon[action.actorId].moveName)) &&
    state.moveStreakByPokemon[action.actorId].count >= 2;
  const baseOutcomes = statusBaseScore(state, evaluation).map(outcome => ({
    ...outcome,
    score: outcome.score + (protect ? protectAdjustment : 0),
  }));
  return {
    ...evaluation,
    outcomes: reason
      ? [{score: discouragedRecovery ? -6 : -20, probability: 1}]
      : repeatedProtect
        ? [{score: -20, probability: 1}]
        : usedProtectLastTurn
        ? [{score: -20, probability: 0.5}, {score: baseScore, probability: 0.5}]
        : fieldSetup
          ? [{score: fieldSetupScore, probability: 1}]
          : baseOutcomes,
    reasons: reason
      ? [reason]
      : [
        protect ? 'Protect scoring rule' : fieldSetup ? 'field-speed setup rule' : 'default non-damaging move score',
        ...(protectAdjustment ? ['Protect context adjustment'] : []),
        ...(usedProtectLastTurn ? ['50% repeat-Protect penalty'] : []),
      ],
  };
}
