export type GenerationNum = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type SideId = 'ai' | 'player';
export type BattleMode = 'Singles' | 'Doubles';
export type GenderName = 'M' | 'F' | 'N';
export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type BoostStatID = StatID | 'acc' | 'eva';

/** Run & Bun removes EVs; keep an explicit zero map for every calculator generation. */
export const RUN_AND_BUN_EVS: Readonly<Record<StatID, number>> = Object.freeze({
  hp: 0,
  atk: 0,
  def: 0,
  spa: 0,
  spd: 0,
  spe: 0,
});

export type StatusName = 'slp' | 'psn' | 'brn' | 'frz' | 'par' | 'tox';
export type Terrain = 'Electric' | 'Grassy' | 'Psychic' | 'Misty';
export type Weather =
  | 'Sand' | 'Sun' | 'Rain' | 'Hail' | 'Snow' | 'Harsh Sunshine' | 'Heavy Rain' | 'Strong Winds';
export type TypeName = string;
export type MoveCategory = 'Physical' | 'Special' | 'Status';
export type ActionFailure =
  'flinch' | 'paralysis' | 'sleep' | 'freeze' | 'confusion' | 'infatuation' | 'protect' | 'truant';
export type MoveTarget =
  | 'adjacentAlly' | 'adjacentAllyOrSelf' | 'adjacentFoe' | 'all'
  | 'allAdjacent' | 'allAdjacentFoes' | 'allies' | 'allySide' | 'allyTeam'
  | 'any' | 'foeSide' | 'normal' | 'randomNormal' | 'scripted' | 'self';
export type StatBoosts = Partial<Record<BoostStatID, number>>;
export type VolatileStatusName =
  | 'confusion' | 'taunt' | 'encore' | 'imprison' | 'disable' | 'torment' | 'yawn' | 'leechSeed' | 'perishSong'
  | 'nightmare' | 'electrified' | 'octolock' | 'miracleEye'
  | 'destinyBond' | 'focusEnergy' | 'laserFocus' | 'helpingHand' | 'foresight' | 'protected' | 'flinch' | 'curse'
  | 'stockpile' | 'infatuated' | 'endure' | 'aquaRing' | 'ingrain' | 'magnetRise' | 'roost' | 'telekinesis' | 'landed' | 'flashFire'
  | 'waterSport' | 'mudSport' | 'trapped' | 'partiallyTrapped' | 'embargo' | 'healBlock' | 'followMe' | 'ragePowder' | 'spotlight' | 'magicCoat' | 'snatch' | 'grudge' | 'bide' | 'rollout' | 'rampage' | 'recharge' | 'charge' | 'charged' | 'uproar' | 'lockOn' | 'shellTrap' | 'protosynthesis' | 'quarkDrive'
  | 'cudChew' | 'micleBerry' | 'glaiveRush' | 'tarShot' | 'throatChop' | 'furyCutter' | 'commanding' | 'commanded' | 'truant' | 'slowStart';
export type TimedSideEffectName =
  | 'reflect' | 'lightScreen' | 'auroraVeil' | 'tailwind' | 'safeguard' | 'mist' | 'luckyChant' | 'craftyShield' | 'helpingHand' | 'protected' | 'wideGuard' | 'quickGuard' | 'matBlock' | 'pledgeRainbow' | 'pledgeSwamp' | 'pledgeSeaOfFire'
  | 'steelsurge' | 'vinelash' | 'wildfire' | 'cannonade' | 'volcalith';
export type TimedFieldName = 'weather' | 'terrain' | 'trickRoom' | 'gravity' | 'magicRoom' | 'wonderRoom' | 'fairyLock'
  | 'waterSport' | 'mudSport' | 'ionDeluge';

export interface VolatileState {
  turns?: number;
  /** Berry retained by Cud Chew until its delayed re-eat. */
  item?: string;
  stacks?: number;
  /** Accumulated direct HP damage stored by Bide. */
  damage?: number;
  moveName?: string;
  /** Locked targets retained between the charge and release turns. */
  targetIds?: string[];
  /** The target whose next move is made sure-hit by Lock-On/Mind Reader. */
  targetId?: string;
  moveNames?: string[];
  sourceId?: string;
}

export type VolatileStates = Partial<Record<VolatileStatusName, VolatileState>>;

export interface SecondaryEffect {
  chance: number;
  target?: 'self' | 'target';
  status?: StatusName;
  /** Mutually exclusive status outcomes sampled after the secondary procs. */
  statusChoices?: StatusName[];
  boosts?: StatBoosts;
  volatile?: {name: VolatileStatusName; turns?: number; moveName?: string};
}

export interface HpState {
  current: number;
  max: number;
}

export interface MoveState {
  name: string;
  /** Optional battle-specific base-power override for custom move data. */
  basePower?: number;
  /** Optional battle-specific type override for custom move data. */
  type?: TypeName;
  /** Optional battle-specific category override for custom move data. */
  category?: MoveCategory;
  /** Optional battle-specific priority override for custom move data. */
  priority?: number;
  accuracy?: number | true;
  secondaryEffects?: SecondaryEffect[];
  target?: MoveTarget;
  /** Optional battle-specific move-flag overrides for custom move data. */
  contact?: boolean;
  heal?: boolean;
  punch?: boolean;
  bite?: boolean;
  pulse?: boolean;
  slicing?: boolean;
  bullet?: boolean;
  snatchable?: boolean;
  sound?: boolean;
  wind?: boolean;
  dance?: boolean;
  reflectable?: boolean;
  pp?: number;
  maxPP?: number;
  disabled?: boolean;
  useZ?: boolean;
  useMax?: boolean;
  hits?: number;
  timesUsed?: number;
  timesUsedWithMetronome?: number;
}

/** A current-turn move intent that has been selected but not executed yet. */
export interface SelectedMoveState {
  moveName: string;
  useZ?: boolean;
  useMax?: boolean;
}

/** A first Pledge move waiting for its same-side partner to complete Swamp. */
export interface PendingPledgeState {
  actorId: string;
  moveName: string;
  targetIds: string[];
  useZ?: boolean;
  useMax?: boolean;
}

/** The most recent direct damage taken by a current battle appearance. */
export interface LastDamageTaken {
  damage: number;
  category: MoveCategory;
  sourceId: string;
  moveName: string;
  /** Battle turn on which the damage was received. */
  turn: number;
}

export interface PokemonState {
  id: string;
  species: string;
  level: number;
  hp: HpState;
  moves: MoveState[];
  /** Original move set retained while a move-copy effect is active; cleared on switch. */
  originalMoves?: MoveState[];
  ability?: string;
  abilityOn?: boolean;
  /** Current move-induced ability replacement; null explicitly represents No Ability and is cleared on switch. */
  abilityOverride?: string | null;
  /** Temporary move-induced suppression; cleared on switch. */
  abilitySuppressed?: boolean;
  /** Temporary effective species copied by Transform; cleared on switch. */
  speciesOverride?: string;
  /** Whether the Run & Bun Disguise effect has already been broken. */
  disguiseBroken?: boolean;
  /** Whether the holder has already triggered its one-time Supersweet Syrup entry effect. */
  syrupTriggered?: boolean;
  /** Whether the holder has already triggered Intrepid Sword this battle. */
  intrepidSwordTriggered?: boolean;
  /** Whether the holder has already triggered Dauntless Shield this battle. */
  dauntlessShieldTriggered?: boolean;
  /** Whether Palafin has left the field and unlocked Zero to Hero this battle. */
  zeroToHeroTriggered?: boolean;
  item?: string;
  /** True after this Pokémon loses a held item; resets on switch for Unburden. */
  itemLost?: boolean;
  /** True when Corrosive Gas has rendered the current held item unusable; persists through switching. */
  itemCorroded?: boolean;
  /** Last held item consumed by this Pokémon; supports generation-specific recovery abilities. */
  lastConsumedItem?: string;
  nature?: string;
  gender?: GenderName;
  /** Current battle type override; an empty array represents a typeless state; cleared on switch. */
  typeOverride?: TypeName[];
  /** Whether Generation IX Protean/Libero has already changed this appearance's type. */
  typeChangeUsed?: boolean;
  /** Current move-induced base-stat override; cleared on switch. */
  baseStatsOverride?: Partial<Record<StatID, number>>;
  /** Current raw battle-stat inputs for stat-transform moves; cleared on switch. */
  statOverrides?: Partial<Record<StatID, number>>;
  ivs?: Partial<Record<StatID, number>>;
  evs?: Partial<Record<StatID, number>>;
  boosts?: StatBoosts;
  status?: StatusName | '';
  /** Remaining sleep turns, including the current unresolved turn boundary. */
  statusTurns?: number;
  toxicCounter?: number;
  volatile?: VolatileStates;
  /** Remaining HP of this Pokémon's Substitute, when one is active. */
  substituteHp?: number;
  teraType?: TypeName;
  isDynamaxed?: boolean;
  isSaltCure?: boolean;
  alliesFainted?: number;
  /** Number of successful incoming attack hits during this active appearance; used by Rage Fist. */
  rageFistHits?: number;
}

export interface SideEffects {
  spikes?: number;
  toxicSpikes?: number;
  stickyWeb?: boolean;
  stealthRock?: boolean;
  steelsurge?: boolean;
  vinelash?: boolean;
  wildfire?: boolean;
  cannonade?: boolean;
  volcalith?: boolean;
  reflect?: boolean;
  lightScreen?: boolean;
  auroraVeil?: boolean;
  safeguard?: boolean;
  mist?: boolean;
  luckyChant?: boolean;
  craftyShield?: boolean;
  tailwind?: boolean;
  helpingHand?: boolean;
  friendGuard?: boolean;
  battery?: boolean;
  powerSpot?: boolean;
  seeded?: boolean;
  foresight?: boolean;
  protected?: boolean;
  /** One-turn side protection from moves that can target multiple Pokémon. */
  wideGuard?: boolean;
  /** One-turn side protection from increased-priority moves. */
  quickGuard?: boolean;
  /** One-turn side protection from damaging moves during the user's first turn out. */
  matBlock?: boolean;
  /** Generation V+ opposing-side quarter-Speed field from a Grass+Water Pledge combo. */
  pledgeSwamp?: boolean;
  /** Generation V+ same-side secondary-chance field from a Fire+Water Pledge combo. */
  pledgeRainbow?: boolean;
  /** Generation V+ opposing-side residual field from a Fire+Grass Pledge combo. */
  pledgeSeaOfFire?: boolean;
}

export interface SideState {
  activeIds: string[];
  party: PokemonState[];
  effects?: SideEffects;
  effectDurations?: Partial<Record<TimedSideEffectName, number>>;
  /** One-shot full healing for the next replacement, set by Healing Wish/Lunar Dance. */
  pendingFullHealOnSwitch?: boolean;
}

export interface BattlefieldState {
  weather?: Weather;
  terrain?: Terrain;
  trickRoom?: boolean;
  gravity?: boolean;
  magicRoom?: boolean;
  wonderRoom?: boolean;
  fairyLock?: boolean;
  waterSport?: boolean;
  mudSport?: boolean;
  ionDeluge?: boolean;
  auraBreak?: boolean;
  darkAura?: boolean;
  fairyAura?: boolean;
  beadsOfRuin?: boolean;
  swordOfRuin?: boolean;
  tabletsOfRuin?: boolean;
  vesselOfRuin?: boolean;
  durations?: Partial<Record<TimedFieldName, number>>;
}

export interface BattleState {
  generation: GenerationNum;
  mode: BattleMode;
  turn: number;
  sides: Record<SideId, SideState>;
  field: BattlefieldState;
  /** Most recently selected move across the battle, for Copycat-style moves. */
  lastMoveUsed?: string;
  lastMoveByPokemon?: Record<string, string>;
  /** Most recent move used by each current active appearance; cleared on switch. */
  lastMoveUsedByPokemon?: Record<string, string>;
  /** Targets selected by each current active appearance's most recent move. */
  lastMoveTargetIdsByPokemon?: Record<string, string[]>;
  /** Most recent successful move that targeted each Pokémon, for Mirror Move. */
  lastMoveTargetedByPokemon?: Record<string, string>;
  /** Most recent damaging move that hit each Pokémon, for legacy Conversion 2. */
  lastDamagingMoveByPokemon?: Record<string, string>;
  /** Most recent non-Substitute direct damage, for Counter-family moves. */
  lastDamageTakenByPokemon?: Record<string, LastDamageTaken>;
  /** Current-turn intents consumed as each action executes. */
  selectedMoveByPokemon?: Record<string, SelectedMoveState>;
  /** Same-turn Grass+Water Pledge move awaiting its partner's resolution. */
  pendingPledgeBySide?: Partial<Record<SideId, PendingPledgeState>>;
  /** Positive stat-stage changes observed during the current turn. */
  statBoostsThisTurnByPokemon?: Record<string, StatBoosts>;
  moveStreakByPokemon?: Record<string, {moveName: string; count: number}>;
  /** Active Choice-item locks; switching clears the outgoing Pokémon's lock. */
  choiceLockByPokemon?: Record<string, string>;
  lastResolution?: ResolutionTrace;
  firstTurnOutIds?: string[];
  /** Damage that has been resolved now but is scheduled for a later turn boundary. */
  delayedMoves?: DelayedMoveState[];
  /** Active Pokémon that must choose a replacement before acting again. */
  pendingForcedSwitchIds?: string[];
  /** Active Pokémon awaiting a Baton Pass replacement. */
  pendingBatonPassIds?: string[];
  pendingSubstitutePassIds?: string[];
}

export interface MoveAction {
  kind: 'move';
  actorId: string;
  moveName: string;
  targetIds: string[];
  useZ?: boolean;
  useMax?: boolean;
}

export interface DelayedMoveState {
  /** Stable within this battle so a due effect can be removed atomically. */
  id: string;
  moveName: string;
  sourceId: string;
  targetIds: string[];
  /** Remaining turn boundaries before the delayed move resolves. */
  turns: number;
  /** Original target IDs mapped to their active-side slot at cast time. */
  targetSlotsByTarget?: Record<string, number>;
  /** Damage was sampled at move selection and is applied at the due boundary. */
  damageByTarget: Record<string, number>;
  /** Healing fractions applied to the active occupant of each target slot at the due boundary. */
  healingByTarget?: Record<string, {numerator: number; denominator: number}>;
}

export interface SwitchAction {
  kind: 'switch';
  actorId: string;
  replacementId: string;
  /** True when the active Pokémon has fainted and the battle requires replacement. */
  forced?: boolean;
  /** Preserve the outgoing Pokémon's modeled boosts and Substitute on entry. */
  batonPass?: boolean;
  preserveSubstitute?: boolean;
}

export type Action = MoveAction | SwitchAction;

export type ResolutionSource = 'battle-engine' | 'calculator' | 'test';

export interface ResolutionTrace {
  source: ResolutionSource;
  hit?: boolean;
  actionFailure?: ActionFailure;
  accuracyBase?: number | true;
  accuracyRoll?: number;
  accuracyThreshold?: number;
  accuracyMultiplier?: number;
  accuracyModifiers?: string[];
  accuracyRollsByTarget?: Record<string, number>;
  accuracyThresholdsByTarget?: Record<string, number>;
  damageRollsByTarget?: Record<string, number>;
  /** Individual sampled hit rolls for calculator-backed multi-hit actions. */
  hitDamageRollsByTarget?: Record<string, number[]>;
  /** Sampled secondary rolls keyed by `pokemonId:effectIndex` or `pokemonId:effectIndex:hitN`. */
  secondaryRolls?: Record<string, number>;
  notes?: string[];
}

export interface MoveResolution {
  hit?: boolean;
  /** The actor failed to execute the selected move for this turn. */
  actionFailure?: ActionFailure;
  damageByTarget?: Record<string, number>;
  /** Sequential damage rolls; their sum equals damageByTarget for that target. */
  hitDamageByTarget?: Record<string, number[]>;
  hpDeltaByPokemon?: Record<string, number>;
  /** Explicit held-item changes; null removes the item permanently from battle state. */
  itemByPokemon?: Record<string, string | null>;
  /** Successful Ally Switch requests the actor's active slot to swap with its live ally. */
  allySwitchByPokemon?: Record<string, boolean>;
  /** Persistent held-item suppression caused by Corrosive Gas. */
  itemCorrodedByPokemon?: Record<string, boolean | null>;
  /** Explicit item-consumption facts, distinct from theft or forced item removal. */
  consumedItemByPokemon?: Record<string, string | null>;
  substituteHpByPokemon?: Record<string, number | null>;
  statusByPokemon?: Record<string, StatusName | ''>;
  statusTurnsByPokemon?: Record<string, number | null>;
  disguiseBrokenByPokemon?: Record<string, boolean>;
  isSaltCureByPokemon?: Record<string, boolean | null>;
  toxicCounterByPokemon?: Record<string, number>;
  boostsByPokemon?: Record<string, StatBoosts>;
  /** Explicitly reset stat stages before applying any same-resolution boosts. */
  resetBoostsByPokemon?: Record<string, boolean>;
  /** Set the supplied stat stages to absolute values before additive boosts. */
  setBoostsByPokemon?: Record<string, StatBoosts>;
  volatileByPokemon?: Record<string, Partial<Record<VolatileStatusName, VolatileState | null>>>;
  /** Current battle type override; an empty array represents typeless; null restores species-derived types. */
  typeOverrideByPokemon?: Record<string, TypeName[] | null>;
  /** Whether a once-per-appearance Protean/Libero type change has been consumed. */
  typeChangeUsedByPokemon?: Record<string, boolean | null>;
  /** Current move-induced ability replacement; null restores the base ability. */
  abilityOverrideByPokemon?: Record<string, string | null>;
  /** Explicitly projects No Ability; distinct from a null ability override, which restores the base ability. */
  noAbilityByPokemon?: Record<string, boolean>;
  /** Temporary ability suppression; null clears suppression. */
  abilitySuppressedByPokemon?: Record<string, boolean | null>;
  /** Temporary effective species; null restores the original species. */
  speciesOverrideByPokemon?: Record<string, string | null>;
  /** Current move-induced base-stat override; null restores species base stats. */
  baseStatsOverrideByPokemon?: Record<string, Partial<Record<StatID, number>> | null>;
  /** Current raw battle-stat inputs; null restores calculator-derived stats. */
  statOverridesByPokemon?: Record<string, Partial<Record<StatID, number>> | null>;
  /** Current move set replacement; null restores the pre-copy move set. */
  movesByPokemon?: Record<string, MoveState[] | null>;
  /** Move selected by a copy move for the caller to execute immediately. */
  copyMoveByPokemon?: Record<string, string | null>;
  /** Move selected by Metronome or Sleep Talk for the caller to execute immediately. */
  calledMoveByPokemon?: Record<string, string | null>;
  /** Modifiers for the called move, separate from the wrapper move's facts. */
  calledMoveModifiersByPokemon?: Record<string, {powerMultiplier?: number; bypassAccuracy?: boolean}>;
  /** Target slots to preserve when a called move repeats another Pokémon's move. */
  calledMoveTargetIdsByPokemon?: Record<string, string[]>;
  /** Called move must be executed as an external move, as with Dancer. */
  calledMoveExternalByPokemon?: Record<string, boolean>;
  /** Active targets that must choose a replacement after this move resolves. */
  forcedSwitchByPokemon?: Record<string, boolean>;
  /** Forced-switch requests that preserve the outgoing boosts and Substitute. */
  batonPassByPokemon?: Record<string, boolean>;
  substitutePassByPokemon?: Record<string, boolean>;
  sideEffectsBySide?: Partial<Record<SideId, Partial<SideEffects>>>;
  sideEffectDurationsBySide?: Partial<Record<SideId, Partial<Record<TimedSideEffectName, number | null>>>>;
  field?: Partial<BattlefieldState>;
  fieldDurations?: Partial<Record<TimedFieldName, number | null>>;
  pendingFullHealBySide?: Partial<Record<SideId, boolean>>;
  /** Set or clear the same-turn Pledge pairing state for a side. */
  pendingPledgeBySide?: Partial<Record<SideId, PendingPledgeState | null>>;
  delayedMoves?: DelayedMoveState[];
  trace?: ResolutionTrace;
}

export interface EndTurnResolution {
  hpDeltaByPokemon?: Record<string, number>;
  /** Active holders that must choose a replacement after crossing the emergency threshold. */
  forcedSwitchByPokemon?: Record<string, boolean>;
  itemByPokemon?: Record<string, string | null>;
  consumedItemByPokemon?: Record<string, string | null>;
  /** Temporary form restoration, such as Ice Face returning in hail/snow. */
  speciesOverrideByPokemon?: Record<string, string | null>;
  boostsByPokemon?: Record<string, StatBoosts>;
  /** Delayed Berry re-eating move-set update, such as Cud Chew restoring PP. */
  movesByPokemon?: Record<string, MoveState[] | null>;
  substituteHpByPokemon?: Record<string, number | null>;
  statusByPokemon?: Record<string, StatusName | ''>;
  statusTurnsByPokemon?: Record<string, number | null>;
  disguiseBrokenByPokemon?: Record<string, boolean>;
  toxicCounterByPokemon?: Record<string, number>;
  volatileByPokemon?: Record<string, Partial<Record<VolatileStatusName, VolatileState | null>>>;
  removeDelayedMoveIds?: string[];
  trace?: ResolutionTrace;
}

export interface SwitchEntryResolution {
  hpDeltaByPokemon?: Record<string, number>;
  itemByPokemon?: Record<string, string | null>;
  consumedItemByPokemon?: Record<string, string | null>;
  /** Entry-time ability replacement, including Trace and Imposter copies. */
  abilityOverrideByPokemon?: Record<string, string | null>;
  /** Entry-time explicit No Ability projection for copy effects. */
  noAbilityByPokemon?: Record<string, boolean>;
  statusByPokemon?: Record<string, StatusName | ''>;
  toxicCounterByPokemon?: Record<string, number>;
  boostsByPokemon?: Record<string, StatBoosts>;
  /** Absolute entry boost state, used by partner-copy abilities such as Costar. */
  setBoostsByPokemon?: Record<string, StatBoosts>;
  /** Entry-time type state for effects such as Mimicry. */
  typeOverrideByPokemon?: Record<string, TypeName[] | null>;
  /** Entry-time species state for form abilities such as Zero to Hero. */
  speciesOverrideByPokemon?: Record<string, string | null>;
  /** Entry-time raw battle stats copied by Imposter. */
  statOverridesByPokemon?: Record<string, Partial<Record<StatID, number>> | null>;
  /** Entry-time move-set replacement copied by Imposter. */
  movesByPokemon?: Record<string, MoveState[] | null>;
  /** Persistent one-time entry ability markers, such as Supersweet Syrup. */
  syrupTriggeredByPokemon?: Record<string, boolean>;
  intrepidSwordTriggeredByPokemon?: Record<string, boolean>;
  dauntlessShieldTriggeredByPokemon?: Record<string, boolean>;
  volatileByPokemon?: Record<string, Partial<Record<VolatileStatusName, VolatileState | null>>>;
  /** Entry-time side-effect changes, including Screen Cleaner clearing both sides. */
  sideEffectsBySide?: Partial<Record<SideId, Partial<SideEffects>>>;
  field?: Partial<BattlefieldState>;
  fieldDurations?: Partial<Record<TimedFieldName, number | null>>;
  clearToxicSpikesBySide?: Partial<Record<SideId, boolean>>;
  trace?: ResolutionTrace;
}

export interface DamageFacts {
  rolls: number[];
  /** Number of sequential hits represented by the per-hit rolls. */
  hits?: number;
  /** Independent per-hit roll distributions, used by calculator split-hit effects such as Parental Bond. */
  hitRolls?: number[][];
  min: number;
  max: number;
  targetHp: number;
  possibleKO: boolean;
  guaranteedKO: boolean;
}

export interface ActionFacts {
  damage?: DamageFacts;
  damageByTarget?: Record<string, DamageFacts>;
  /** Calculator-backed self-hit damage when the acting Pokémon is confused. */
  confusionDamage?: DamageFacts;
  moveCategory?: MoveCategory;
  moveType?: TypeName;
  fieldTerrain?: Terrain;
  moveAccuracy?: number | true;
  /** True when the calculator resolved the selected move as a multi-hit move. */
  isMultiHit?: boolean;
  secondaryEffects?: SecondaryEffect[];
  battleMode?: BattleMode;
  priority?: number;
  attackerSpeed?: number;
  /** Critical-hit stage before the battle engine rolls the current move. */
  attackerCriticalHitStage?: number;
  /** True only when the current move is guaranteed to crit, such as Laser Focus. */
  criticalHitGuaranteed?: boolean;
  /** True when the current move's sampled or guaranteed outcome is a critical hit. */
  criticalHit?: boolean;
  attackerHp?: number;
  attackerHpPercent?: number;
  defenderSpeed?: number;
  opponentSpeeds?: number[];
  attackerAbility?: string;
  attackerPartnerAbility?: string;
  attackerPartnerItem?: string;
  attackerPartnerTypes?: string[];
  attackerPartnerMoves?: string[];
  attackerPartnerSpeed?: number;
  attackerPartnerGroundImmune?: boolean;
  attackerPartnerHasMagnetRise?: boolean;
  defenderAbility?: string;
  defenderTypes?: string[];
  attackerSpecies?: string;
  defenderSpecies?: string;
  attackerItem?: string;
  defenderItem?: string;
  attackerStatus?: StatusName | '';
  defenderStatus?: StatusName | '';
  /** Whether the evaluated defender is currently unable to take an action. */
  defenderIncapacitated?: boolean;
  defenderConfused?: boolean;
  defenderInfatuated?: boolean;
  attackerBoosts?: StatBoosts;
  defenderBoosts?: StatBoosts;
  attackerMoves?: string[];
  defenderMoves?: string[];
  attackerHasPhysicalMove?: boolean;
  attackerHasSpecialMove?: boolean;
  attackerHasFlinchMove?: boolean;
  defenderHasPhysicalMove?: boolean;
  defenderHasSpecialMove?: boolean;
  defenderHasStatusMove?: boolean;
  defenderHasSoundMove?: boolean;
  defenderSeeded?: boolean;
  attackerSubstitute?: boolean;
  attackerHelpingHand?: boolean;
  defenderSubstitute?: boolean;
  lastMoveUsed?: string;
  attackerPartyAliveCount?: number;
  defenderPartyAliveCount?: number;
  defenderHpPercent?: number;
  defenderLastMoveUsed?: string;
  defenderLastMoveIsStatus?: boolean;
  isFirstTurnOut?: boolean;
  opponentCanKO?: boolean;
  opponentCan2HKO?: boolean;
  /** Maximum modeled damage from any currently active opposing move. */
  opponentMaxDamage?: number;
  isSuperEffective?: boolean;
  isHighCrit?: boolean;
  isImmune?: boolean;
}

export interface ScoreOutcome {
  score: number;
  probability: number;
}

export interface ActionEvaluation {
  action: Action;
  facts: ActionFacts;
  outcomes: ScoreOutcome[];
  reasons: string[];
}

export interface Decision {
  action: Action;
  evaluations: ActionEvaluation[];
  selectedScore?: number;
}
