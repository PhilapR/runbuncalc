import * as I from './data/interface';

export namespace State {
  export interface Pokemon {
    name: I.SpeciesName;
    level?: number;
    ability?: I.AbilityName;
    abilityOn?: boolean;
    /** Set false to model an intact Disguise; omitted preserves calculator compatibility. */
    disguiseBroken?: boolean;
    isDynamaxed?: boolean;
    isSaltCure?: boolean;
    /** Explicit grounding override for battle-engine volatiles such as Magnet Rise or Roost. */
    isGrounded?: boolean;
    alliesFainted?: number;
    item?: I.ItemName;
    /** Preserve held-item identity for presence moves while suppressing effects. */
    itemSuppressed?: boolean;
    gender?: I.GenderName;
    nature?: I.NatureName;
    ivs?: Partial<I.StatsTable>;
    evs?: Partial<I.StatsTable>;
    boosts?: Partial<I.StatsTable>;
    /** Explicit raw battle-stat inputs used by stateful stat-transform moves. */
    statOverrides?: Partial<I.StatsTable>;
    originalCurHP?: number;
    status?: I.StatusName | '';
    teraType?: I.TypeName;
    toxicCounter?: number;
    moves?: I.MoveName[];
    overrides?: Partial<I.Specie>;
  }

  export interface Move {
    name: I.MoveName;
    /** Treat a combined Pledge move as receiving ordinary STAB. */
    forceSTAB?: boolean;
    useZ?: boolean;
    useMax?: boolean;
    isCrit?: boolean;
    hits?: number;
    timesUsed?: number;
    timesUsedWithMetronome?: number;
    overrides?: Partial<I.Move>;
  }

  export interface Field {
    gameType: I.GameType;
    weather?: I.Weather;
    terrain?: I.Terrain;
    isMagicRoom?: boolean;
    isWonderRoom?: boolean;
    isGravity?: boolean;
    isWaterSport?: boolean;
    isMudSport?: boolean;
    isIonDeluge?: boolean;
    isAuraBreak?: boolean;
    isFairyAura?: boolean;
    isDarkAura?: boolean;
    isBeadsOfRuin?: boolean;
    isSwordOfRuin?: boolean;
    isTabletsOfRuin?: boolean;
    isVesselOfRuin?: boolean;
    attackerSide: Side;
    defenderSide: Side;
  }

  export interface Side {
    spikes?: number;
    steelsurge?: boolean;
    vinelash?: boolean;
    wildfire?: boolean;
    cannonade?: boolean;
    volcalith?: boolean;
    isSR?: boolean;
    isReflect?: boolean;
    isLightScreen?: boolean;
    isProtected?: boolean;
    isSeeded?: boolean;
    isForesight?: boolean;
    isMiracleEye?: boolean;
    isTailwind?: boolean;
    isHelpingHand?: boolean;
    isFlowerGift?: boolean;
    isFriendGuard?: boolean;
    isAuroraVeil?: boolean;
    isLuckyChant?: boolean;
    isBattery?: boolean;
    isPowerSpot?: boolean;
    /** The opposing side is affected by the Grass+Water Pledge swamp. */
    isPledgeSwamp?: boolean;
    isSwitching?: 'out' | 'in';
  }
}
