import { Generation, TypeName, StatID } from './data/interface';
export declare const SEED_BOOSTED_STAT: {
    [item: string]: StatID;
};
export declare function getItemBoostType(item: string | undefined): "Bug" | "Dark" | "Dragon" | "Electric" | "Fairy" | "Fighting" | "Fire" | "Flying" | "Ghost" | "Grass" | "Ground" | "Ice" | "Normal" | "Poison" | "Psychic" | "Rock" | "Steel" | "Water" | undefined;
export declare function getBerryResistType(berry: string | undefined): "Bug" | "Dark" | "Dragon" | "Electric" | "Fairy" | "Fighting" | "Fire" | "Flying" | "Ghost" | "Grass" | "Ground" | "Ice" | "Normal" | "Poison" | "Psychic" | "Rock" | "Steel" | "Water" | undefined;
export declare function getFlingPower(item?: string): 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 85 | 90 | 95 | 100 | 110 | 130;
export declare function getNaturalGift(gen: Generation, item: string): {
    t: TypeName;
    p: number;
};
export declare function getTechnoBlast(item: string): "Electric" | "Fire" | "Ice" | "Water" | undefined;
export declare function getMultiAttack(item: string): TypeName | undefined;
