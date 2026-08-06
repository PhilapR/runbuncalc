import {applySwitchAction} from './transition';
import {enumerateMoveActions, enumerateSwitchActions, getPokemon} from './actions';
import {ActionFacts, BattleState, MoveAction, SideId} from './model';
import {getEffectivePokemonSpeed} from './order';

export interface ReplacementViability {
  faster: boolean;
  notOHKOd: boolean;
  not2HKOd: boolean;
}

export type MoveFactProvider = (state: BattleState, action: MoveAction) => ActionFacts;

function opposingSide(sideId: SideId): SideId {
  return sideId === 'ai' ? 'player' : 'ai';
}

/**
 * Derive only the switch-policy signals documented by the AI model. This
 * applies each legal switch in memory so entry hazards, grounding, and entry
 * abilities are included, then evaluates the opposing side's legal moves.
 * It deliberately does not invent a replacement matchup score.
 */
export function deriveReplacementViability(
  state: BattleState,
  sideId: SideId,
  factsFor: MoveFactProvider,
): Record<string, ReplacementViability> {
  if (state.mode !== 'Singles') return {};
  const opponentSide = opposingSide(sideId);
  const opponentId = state.sides[opponentSide].activeIds[0];
  if (!opponentId || !getPokemon(state, opponentId)) return {};

  const viability: Record<string, ReplacementViability> = {};
  for (const action of enumerateSwitchActions(state, sideId)) {
    const switched = applySwitchAction(state, action);
    const replacement = getPokemon(switched, action.replacementId);
    if (!replacement) continue;

    const opponentSpeed = getEffectivePokemonSpeed(switched, opponentId);
    const replacementSpeed = getEffectivePokemonSpeed(switched, replacement.id);
    const opponentActions = enumerateMoveActions(switched, opponentSide)
      .filter(candidate => candidate.targetIds.includes(replacement.id));
    const damageFacts = opponentActions
      .map(candidate => factsFor(switched, candidate).damage)
      .filter((damage): damage is NonNullable<typeof damage> => !!damage);
    const survivesEntry = replacement.hp.current > 0;

    viability[action.replacementId] = {
      // The Run & Bun policy treats a speed tie as acting before the target.
      // Keep this boundary aligned with the ordinary KO scoring rule, which
      // also uses >= for ties.
      faster: replacementSpeed >= opponentSpeed,
      notOHKOd: survivesEntry && !damageFacts.some(damage => damage.possibleKO),
      not2HKOd: survivesEntry && !damageFacts.some(damage =>
        damage.max * 2 >= replacement.hp.current),
    };
  }
  return viability;
}
