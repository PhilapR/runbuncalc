import {actionKey} from './actions';
import {isDamagingFacts, scoringDamageFacts} from './facts';
import {ActionEvaluation, ActionFacts, ScoreOutcome} from './model';

/**
 * Run & Bun AI decision constants.
 *
 * Exported so `profiles/run-and-bun/policy.js` can declare them and
 * `runbun_policy.test.js` can assert the declaration still matches the engine.
 * These are game-specific tuning, not general battle mechanics: a different
 * game profile would carry different values.
 */
export const HIGH_SCORE_PROBABILITY = 0.2;
export const LOW_SCORE_PROBABILITY = 0.8;
export const CRIT_BONUS_PROBABILITY = 0.5;

/** Baseline score a setup move starts from before situational modifiers. */
export const SETUP_BASE_SCORE = 6;

/** Added to the baseline when the defender cannot act (asleep, frozen, etc.). */
export const SETUP_INCAPACITATED_BONUS = 3;
const KO_BOOST_ABILITIES = new Set(['moxie', 'beastboost', 'chillingneigh', 'grimneigh']);
const TRAPPING_MOVES = new Set([
  'bind', 'clamp', 'firespin', 'infestation', 'magmastorm', 'sandtomb',
  'snaptrap', 'thundercage', 'whirlpool', 'wrap',
]);
const SPEED_DROP_MOVES = new Set(['electroweb', 'icywind', 'lowsweep', 'mudshot', 'rocktomb']);
const SPEED_DROP_BLOCKERS = new Set(['clearbody', 'contrary', 'whitesmoke']);
const GUARANTEED_STAT_DROP_SPLITS: Record<string, 'Physical' | 'Special'> = {
  breakingswipe: 'Physical',
  lunge: 'Physical',
  mysticalfire: 'Special',
  nobleroar: 'Physical',
  snarl: 'Special',
  skittersmack: 'Special',
  spiritbreak: 'Special',
  strugglebug: 'Special',
  tropkick: 'Physical',
};
const ACID_SPRAY = 'acidspray';
const NON_HIGHEST_DAMAGE_MOVES = new Set([
  'explosion', 'finalgambit', 'futuresight', 'meteorbeam', 'relicsong', 'rollout',
  'selfdestruct', 'mistyexplosion',
]);
TRAPPING_MOVES.forEach(move => NON_HIGHEST_DAMAGE_MOVES.add(move));
const NO_KO_BONUS_MOVES = new Set([
  'explosion', 'finalgambit', 'rollout', 'selfdestruct', 'mistyexplosion',
]);
const SPEED_BOOST_ITEMS = new Set(['salacberry']);
const PARTNER_PRIORITY_MOVES = new Set(['aquajet', 'iceshard', 'shadowsneak']);
const ALLY_HARMFUL_GROUND_TYPES = new Set(['fire', 'poison', 'electric', 'rock']);
const CONTRARY_SETUP_MOVES = new Set(['leafstorm', 'overheat', 'superpower']);
const DAMAGING_SETUP_MOVES = new Set(['chargebeam', 'poweruppunch']);

const MOVE_ID_CACHE = new Map<string, string>();
function moveId(name: string): string {
  let id = MOVE_ID_CACHE.get(name);
  if (id === undefined) {
    id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    MOVE_ID_CACHE.set(name, id);
  }
  return id;
}

function weightedBaseScore(score: number): ScoreOutcome[] {
  return [
    {score, probability: LOW_SCORE_PROBABILITY},
    {score: score + 2, probability: HIGH_SCORE_PROBABILITY},
  ];
}

function addBonus(outcomes: ScoreOutcome[], bonus: number): ScoreOutcome[] {
  return outcomes.map(outcome => ({...outcome, score: outcome.score + bonus}));
}

function addChanceBonus(
  outcomes: ScoreOutcome[],
  bonus: number,
  probability: number,
): ScoreOutcome[] {
  return outcomes.flatMap(outcome => [
    {score: outcome.score, probability: outcome.probability * (1 - probability)},
    {score: outcome.score + bonus, probability: outcome.probability * probability},
  ]);
}

function killBonus(facts: ActionFacts, action?: ActionEvaluation['action']): number {
  if (!scoringDamageFacts(facts)?.possibleKO) return 0;
  if (action?.kind === 'move' && NO_KO_BONUS_MOVES.has(moveId(action.moveName))) return 0;
  const actsBeforeTarget = (facts.priority || 0) > 0 ||
    (facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
      facts.attackerSpeed >= facts.defenderSpeed);
  const speedBonus = actsBeforeTarget ? 6 : 3;
  const abilityBonus = facts.attackerAbility &&
    KO_BOOST_ABILITIES.has(facts.attackerAbility.toLowerCase().replace(/[^a-z]/g, '')) ? 1 : 0;
  return speedBonus + abilityBonus;
}

function specialBaseScore(
  facts: ActionFacts,
  moveName: string,
): ScoreOutcome[] | undefined {
  if (moveName === 'fling') {
    if (!facts.attackerItem) return [{score: -20, probability: 1}];
    if (SPEED_BOOST_ITEMS.has(moveId(facts.attackerItem || ''))) {
      return [{
        score: moveId(facts.attackerPartnerItem || '') === 'weaknesspolicy' && facts.isSuperEffective ? 12 : 9,
        probability: 1,
      }];
    }
    return [{score: 6, probability: 1}];
  }
  if (PARTNER_PRIORITY_MOVES.has(moveName) && facts.battleMode === 'Doubles' &&
    moveId(facts.attackerPartnerItem || '') === 'weaknesspolicy' && facts.isSuperEffective) {
    return [{score: 12, probability: 1}];
  }
  if (moveName === 'counter' || moveName === 'mirrorcoat') {
    const physical = moveName === 'counter';
    const onlyMatchingMoves = physical
      ? !!facts.defenderHasPhysicalMove && !facts.defenderHasSpecialMove
      : !!facts.defenderHasSpecialMove && !facts.defenderHasPhysicalMove;
    const sturdyOrSash = moveId(facts.attackerAbility || '') === 'sturdy' ||
      moveId(facts.attackerItem || '') === 'focussash';
    const hasSturdyCounterLine = sturdyOrSash && facts.attackerHpPercent === 100 && onlyMatchingMoves;
    if (facts.opponentCanKO && !hasSturdyCounterLine) return [{score: -14, probability: 1}];
    let outcomes: ScoreOutcome[] = [{score: hasSturdyCounterLine ? 8 : 6, probability: 1}];
    if (!facts.opponentCanKO && onlyMatchingMoves) outcomes = addChanceBonus(outcomes, 2, 0.8);
    const faster = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
      facts.attackerSpeed >= facts.defenderSpeed;
    if (faster) outcomes = addChanceBonus(outcomes, -1, 0.25);
    if (facts.defenderHasStatusMove) outcomes = addChanceBonus(outcomes, -1, 0.25);
    return outcomes;
  }
  if (moveName === 'finalgambit') {
    const faster = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
      facts.attackerSpeed >= facts.defenderSpeed;
    const targetHasMoreHp = scoringDamageFacts(facts)!.targetHp < (facts.attackerHp || 0);
    return [{score: faster && targetHasMoreHp ? 8 : faster && facts.opponentCanKO ? 7 : 6, probability: 1}];
  }
  if (moveName === 'futuresight') {
    const faster = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
      facts.attackerSpeed >= facts.defenderSpeed;
    return [{score: faster && facts.opponentCanKO ? 8 : 6, probability: 1}];
  }
  if (moveName === 'fakeout' && facts.isFirstTurnOut &&
    !['shielddust', 'innerfocus'].includes(moveId(facts.defenderAbility || ''))) {
    return [{score: 9, probability: 1}];
  }
  if (moveName === 'meteorbeam') {
    return [{score: moveId(facts.attackerItem || '') === 'powerherb' ? 9 : -20, probability: 1}];
  }
  if (moveName === 'relicsong') {
    return [{score: moveId(facts.attackerSpecies || '') === 'meloettapirouette' ? -20 : 10, probability: 1}];
  }
  if (moveName === 'rollout') return [{score: 7, probability: 1}];
  if (moveName === 'fellstinger' && scoringDamageFacts(facts)?.possibleKO &&
    (facts.attackerBoosts?.atk || 0) < 6) {
    const faster = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
      facts.attackerSpeed >= facts.defenderSpeed;
    return weightedBaseScore(faster ? 21 : 15);
  }
  if (moveName === 'explosion' || moveName === 'selfdestruct' || moveName === 'mistyexplosion') {
    if (facts.isImmune || ((facts.attackerPartyAliveCount || 0) <= 1 &&
      (facts.defenderPartyAliveCount || 0) > 1)) return [{score: -20, probability: 1}];
    const hp = facts.attackerHpPercent === undefined ? 100 : facts.attackerHpPercent;
    const outcomes = hp < 10
      ? [{score: 10, probability: 1}]
      : hp < 33
        ? [{score: 8, probability: 0.7}, {score: 0, probability: 0.3}]
        : hp < 66
          ? [{score: 7, probability: 0.5}, {score: 0, probability: 0.5}]
          : [{score: 7, probability: 0.05}, {score: 0, probability: 0.95}];
    return facts.attackerPartyAliveCount === 1 && facts.defenderPartyAliveCount === 1
      ? outcomes.map(outcome => ({...outcome, score: outcome.score - 1}))
      : outcomes;
  }
  return undefined;
}

function statDropBonus(
  facts: ActionFacts,
  moveName: string,
  isHighestDamage: boolean,
): number {
  if (moveName === ACID_SPRAY && !facts.isImmune) return 6;
  if (isHighestDamage || facts.isImmune) return 0;
  const split = GUARANTEED_STAT_DROP_SPLITS[moveName];
  if (split) {
    const blocked = facts.defenderAbility && SPEED_DROP_BLOCKERS.has(moveId(facts.defenderAbility));
    const hasMatchingMove = split === 'Physical'
      ? facts.defenderHasPhysicalMove
      : facts.defenderHasSpecialMove;
    const spreadBonus = facts.battleMode === 'Doubles' &&
      !!facts.damageByTarget && Object.keys(facts.damageByTarget).length > 1 ? 1 : 0;
    return (blocked || !hasMatchingMove ? 5 : 6) + spreadBonus;
  }
  return 0;
}

function pursuitBonus(facts: ActionFacts): ScoreOutcome[] {
  const damage = scoringDamageFacts(facts);
  const canKO = !!damage?.possibleKO;
  if (canKO || (facts.defenderHpPercent !== undefined && facts.defenderHpPercent < 20)) {
    return [{score: 10, probability: 1}];
  }
  if (facts.defenderHpPercent !== undefined && facts.defenderHpPercent < 40) {
    return [{score: 0, probability: 0.5}, {score: 8, probability: 0.5}];
  }
  return [{score: 0, probability: 1}];
}

function allyGroundMoveAdjustment(facts: ActionFacts, moveName: string): number {
  if ((moveName !== 'earthquake' && moveName !== 'magnitude') || facts.battleMode !== 'Doubles' ||
    facts.attackerPartnerGroundImmune === undefined || facts.attackerPartnerGroundImmune) return 0;
  const magnetRiseSafe = facts.attackerPartnerHasMagnetRise &&
    facts.attackerPartnerSpeed !== undefined && facts.attackerSpeed !== undefined &&
    facts.attackerPartnerSpeed > facts.attackerSpeed;
  if (magnetRiseSafe) return 2;
  const partnerTypes = (facts.attackerPartnerTypes || []).map(type => type.toLowerCase());
  return partnerTypes.some(type => ALLY_HARMFUL_GROUND_TYPES.has(type)) ? -10 : -3;
}

function contrarySetupScore(
  facts: ActionFacts,
  moveName: string,
  incapacitated = facts.defenderIncapacitated === true ||
    facts.defenderStatus === 'slp' || facts.defenderStatus === 'frz',
): ScoreOutcome[] {
  const slower = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
    facts.attackerSpeed < facts.defenderSpeed;
  let score = SETUP_BASE_SCORE + (incapacitated ? SETUP_INCAPACITATED_BONUS : 0);

  if (moveName === 'superpower') {
    if (!slower && !facts.opponentCanKO) score += 3;
    if (slower && facts.opponentCan2HKO) score -= 5;
    return [{score, probability: 1}];
  }

  const attackerHp = facts.attackerHp;
  const cannotThreeHKO = facts.opponentMaxDamage !== undefined && attackerHp !== undefined
    ? facts.opponentMaxDamage * 3 < attackerHp
    : !facts.opponentCan2HKO;
  if (!incapacitated && cannotThreeHKO) {
    score += 1;
    if (!slower) score += 1;
  }
  if ((facts.attackerBoosts?.spa || 0) >= 2) score -= 1;
  return [{score, probability: 1}];
}

function damagingSetupScore(
  facts: ActionFacts,
  moveName: string,
  isHighestDamage: boolean,
): ScoreOutcome[] | undefined {
  if (!DAMAGING_SETUP_MOVES.has(moveName) || isHighestDamage) return undefined;

  const hasSetupSurvivalLine = facts.attackerHpPercent === 100 &&
    (moveId(facts.attackerAbility || '') === 'sturdy' ||
      moveId(facts.attackerItem || '') === 'focussash');
  if (facts.opponentCanKO && !hasSetupSurvivalLine) return [{score: -20, probability: 1}];

  // Unaware blocks Charge Beam's setup value, but Power-Up Punch is an
  // explicit Run & Bun exception and remains eligible for its attack effect.
  if (moveName === 'chargebeam' && moveId(facts.defenderAbility || '') === 'unaware') {
    return [{score: -20, probability: 1}];
  }

  // Charge Beam is part of the general setup bucket. Power-Up Punch follows
  // the documented offensive-setup checks used by the status scorer.
  if (moveName === 'chargebeam') return [{score: 6, probability: 1}];

  const incapacitated = facts.defenderIncapacitated === true ||
    facts.defenderStatus === 'slp' || facts.defenderStatus === 'frz';
  const slower = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
    facts.attackerSpeed < facts.defenderSpeed;
  let score = SETUP_BASE_SCORE + (incapacitated ? SETUP_INCAPACITATED_BONUS : 0);
  if (!slower && !facts.opponentCanKO) score += 3;
  if (slower && facts.opponentCan2HKO) score -= 5;
  return [{score, probability: 1}];
}

export function scoreDamagingAction(
  facts: ActionFacts,
  isHighestDamage: boolean,
  action?: ActionEvaluation['action'],
): ScoreOutcome[] {
  const damageFacts = scoringDamageFacts(facts);
  if (!damageFacts) return [{score: 0, probability: 1}];
  if (damageFacts.max <= 0) return [{score: -20, probability: 1}];

  const moveName = action?.kind === 'move' ? moveId(action.moveName) : '';
  if (moveName === 'steelroller' && !facts.fieldTerrain) {
    return [{score: -20, probability: 1}];
  }
  const contrarySetup = CONTRARY_SETUP_MOVES.has(moveName) &&
    moveId(facts.attackerAbility || '') === 'contrary' && !isHighestDamage &&
    !scoringDamageFacts(facts)!.possibleKO;
  const specialBase = contrarySetup
    ? contrarySetupScore(facts, moveName)
    : specialBaseScore(facts, moveName);
  const setupBase = damagingSetupScore(facts, moveName, isHighestDamage);
  if (specialBase?.some(outcome => outcome.score === -20)) return specialBase;
  if (setupBase?.some(outcome => outcome.score === -20)) return setupBase;
  if (moveName === 'fellstinger' && specialBase) return specialBase;
  const isTrapping = TRAPPING_MOVES.has(moveName);
  const isSpeedDrop = SPEED_DROP_MOVES.has(moveName);
  let base: ScoreOutcome[];
  if (specialBase) {
    base = specialBase;
  } else if (isHighestDamage || isTrapping) {
    base = weightedBaseScore(6);
  } else if (isSpeedDrop) {
    const blocked = facts.defenderAbility &&
      SPEED_DROP_BLOCKERS.has(moveId(facts.defenderAbility));
    const slower = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
      facts.attackerSpeed < facts.defenderSpeed;
    const doubleBonus = facts.battleMode === 'Doubles' &&
      (moveName === 'icywind' || moveName === 'electroweb') ? 1 : 0;
    base = [{score: !blocked && slower ? 6 + doubleBonus : 5 + doubleBonus, probability: 1}];
  } else if (setupBase) {
    base = setupBase;
  } else {
    base = [{score: 0, probability: 1}];
  }
  const doublesMultiHitBonus = facts.battleMode === 'Doubles' && facts.isMultiHit ? 1 : 0;
  const withKill = addBonus(base, killBonus(facts, action) + doublesMultiHitBonus);
  let withPriority = facts.opponentCanKO &&
    (facts.attackerSpeed === undefined || facts.defenderSpeed === undefined ||
      facts.attackerSpeed < facts.defenderSpeed) &&
    (facts.priority || 0) > 0
    ? addBonus(withKill, 11)
    : withKill;
  if (moveName === 'pursuit') {
    const pursuit = pursuitBonus(facts);
    if (pursuit.length === 2) {
      withPriority = withPriority.flatMap(outcome => pursuit.map(bonus => ({
        score: outcome.score + bonus.score,
        probability: outcome.probability * bonus.probability,
      })));
    } else if (pursuit[0].score) {
      withPriority = addBonus(withPriority, pursuit[0].score);
    }
    const faster = facts.attackerSpeed !== undefined && facts.defenderSpeed !== undefined &&
      facts.attackerSpeed >= facts.defenderSpeed;
    if (faster) withPriority = addBonus(withPriority, 3);
  }
  const statDrop = statDropBonus(facts, moveName, isHighestDamage);
  if (statDrop) withPriority = addBonus(withPriority, statDrop);
  if (moveName === 'suckerpunch' && moveId(facts.lastMoveUsed || '') === 'suckerpunch') {
    withPriority = addChanceBonus(withPriority, -20, 0.5);
  }
  const allyGroundAdjustment = allyGroundMoveAdjustment(facts, moveName);
  if (allyGroundAdjustment) withPriority = addBonus(withPriority, allyGroundAdjustment);
  return facts.isHighCrit && facts.isSuperEffective
    ? addChanceBonus(withPriority, 1, CRIT_BONUS_PROBABILITY)
    : withPriority;
}

export function scoreDamagingActions(
  evaluations: Array<{action: ActionEvaluation['action']; facts: ActionFacts}>,
): ActionEvaluation[] {
  const damaging = evaluations.filter(evaluation => isDamagingFacts(evaluation.facts));
  const highestCandidates = damaging.filter(evaluation =>
    evaluation.action.kind !== 'move' || !NON_HIGHEST_DAMAGE_MOVES.has(moveId(evaluation.action.moveName)));
  const possibleKOs = highestCandidates.filter(evaluation => scoringDamageFacts(evaluation.facts)!.possibleKO);
  const highestDamage = possibleKOs.length
    ? new Set(possibleKOs.map(evaluation => actionKey(evaluation.action)))
    : new Set([
      ...highestCandidates
        .filter(evaluation => scoringDamageFacts(evaluation.facts)!.max === Math.max(
          ...highestCandidates.map(candidate => scoringDamageFacts(candidate.facts)!.max)
        ))
        .map(evaluation => actionKey(evaluation.action)),
    ]);

  return damaging.map(evaluation => ({
    action: evaluation.action,
    facts: evaluation.facts,
    outcomes: scoreDamagingAction(
      evaluation.facts,
      highestDamage.has(actionKey(evaluation.action)),
      evaluation.action,
    ),
    reasons: [
      highestDamage.has(actionKey(evaluation.action))
        ? 'highest damaging move or a move that can KO'
        : 'not the highest damaging move',
      ...(scoringDamageFacts(evaluation.facts)?.possibleKO ? ['can KO the target'] : []),
      ...(scoringDamageFacts(evaluation.facts)?.max === 0 ? ['target is immune'] : []),
      ...(evaluation.facts.attackerAbility &&
        KO_BOOST_ABILITIES.has(evaluation.facts.attackerAbility.toLowerCase().replace(/[^a-z]/g, '')) &&
        scoringDamageFacts(evaluation.facts)?.possibleKO ? ['KO ability bonus'] : []),
      ...(evaluation.facts.opponentCanKO && (evaluation.facts.priority || 0) > 0 &&
        evaluation.facts.attackerSpeed !== undefined && evaluation.facts.defenderSpeed !== undefined &&
        evaluation.facts.attackerSpeed < evaluation.facts.defenderSpeed
        ? ['priority survival bonus'] : []),
      ...(evaluation.facts.isHighCrit && evaluation.facts.isSuperEffective
        ? ['high-crit super-effective chance'] : []),
      ...(evaluation.action.kind === 'move' && TRAPPING_MOVES.has(moveId(evaluation.action.moveName))
        ? ['trapping move base score'] : []),
      ...(evaluation.action.kind === 'move' && SPEED_DROP_MOVES.has(moveId(evaluation.action.moveName))
        ? ['speed-drop move rule'] : []),
      ...(evaluation.action.kind === 'move' &&
        (GUARANTEED_STAT_DROP_SPLITS[moveId(evaluation.action.moveName)] ||
          moveId(evaluation.action.moveName) === ACID_SPRAY)
        ? ['guaranteed stat-drop move rule'] : []),
      ...(evaluation.action.kind === 'move' && moveId(evaluation.action.moveName) === 'pursuit'
        ? ['Pursuit conditional bonus'] : []),
      ...(evaluation.action.kind === 'move' && PARTNER_PRIORITY_MOVES.has(moveId(evaluation.action.moveName)) &&
        evaluation.facts.battleMode === 'Doubles' && moveId(evaluation.facts.attackerPartnerItem || '') === 'weaknesspolicy' &&
        evaluation.facts.isSuperEffective ? ['partner Weakness Policy priority rule'] : []),
      ...(evaluation.action.kind === 'move' &&
        (moveId(evaluation.action.moveName) === 'earthquake' || moveId(evaluation.action.moveName) === 'magnitude') &&
        allyGroundMoveAdjustment(evaluation.facts, moveId(evaluation.action.moveName))
        ? ['ally Ground-move safety rule'] : []),
      ...(evaluation.action.kind === 'move' && moveId(evaluation.action.moveName) === 'suckerpunch' &&
        moveId(evaluation.facts.lastMoveUsed || '') === 'suckerpunch'
        ? ['repeat Sucker Punch penalty'] : []),
      ...(evaluation.action.kind === 'move' && specialBaseScore(evaluation.facts, moveId(evaluation.action.moveName))
        ? ['special damaging-move rule'] : []),
      ...(evaluation.action.kind === 'move' && CONTRARY_SETUP_MOVES.has(moveId(evaluation.action.moveName)) &&
        moveId(evaluation.facts.attackerAbility || '') === 'contrary' &&
        !highestDamage.has(actionKey(evaluation.action)) &&
        !scoringDamageFacts(evaluation.facts)!.possibleKO
        ? ['Contrary setup rule'] : []),
    ],
  }));
}
