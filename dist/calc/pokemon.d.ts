import * as I from './data/interface';
import { State } from './state';
export declare class Pokemon implements State.Pokemon {
    gen: I.Generation;
    name: I.SpeciesName;
    species: I.Specie;
    types: [I.TypeName] | [I.TypeName, I.TypeName];
    weightkg: number;
    level: number;
    gender?: I.GenderName;
    ability?: I.AbilityName;
    abilityOn?: boolean;
    disguiseBroken: boolean;
    isDynamaxed?: boolean;
    isSaltCure?: boolean;
    isGrounded?: boolean;
    alliesFainted?: number;
    item?: I.ItemName;
    heldItem?: I.ItemName;
    itemSuppressed?: boolean;
    teraType?: I.TypeName;
    nature: I.NatureName;
    ivs: I.StatsTable;
    evs: I.StatsTable;
    boosts: I.StatsTable;
    statOverrides?: Partial<I.StatsTable>;
    rawStats: I.StatsTable;
    stats: I.StatsTable;
    originalCurHP: number;
    status: I.StatusName | '';
    toxicCounter: number;
    moves: I.MoveName[];
    constructor(gen: I.Generation, name: string, options?: Partial<State.Pokemon> & {
        curHP?: number;
        ivs?: Partial<I.StatsTable> & {
            spc?: number;
        };
        evs?: Partial<I.StatsTable> & {
            spc?: number;
        };
        boosts?: Partial<I.StatsTable> & {
            spc?: number;
        };
        soulDewApplied?: boolean;
    });
    maxHP(original?: boolean): number;
    curHP(original?: boolean): number;
    hasAbility(...abilities: string[]): boolean;
    hasItem(...items: string[]): boolean;
    hasStatus(...statuses: I.StatusName[]): boolean;
    hasType(...types: I.TypeName[]): boolean;
    hasOriginalType(...types: I.TypeName[]): boolean;
    named(...names: string[]): boolean;
    clone(): Pokemon;
    private calcStat;
    static getForme(gen: I.Generation, speciesName: string, item?: I.ItemName, moveName?: I.MoveName): string;
    private static withDefault;
}
