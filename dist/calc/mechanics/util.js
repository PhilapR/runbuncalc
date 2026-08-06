(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isGrounded = isGrounded;
exports.getModifiedStat = getModifiedStat;
exports.computeFinalStats = computeFinalStats;
exports.getFinalSpeed = getFinalSpeed;
exports.getMoveEffectiveness = getMoveEffectiveness;
exports.checkAirLock = checkAirLock;
exports.checkForecast = checkForecast;
exports.checkItem = checkItem;
exports.checkWonderRoom = checkWonderRoom;
exports.checkIntimidate = checkIntimidate;
exports.checkDownload = checkDownload;
exports.checkIntrepidSword = checkIntrepidSword;
exports.checkDauntlessShield = checkDauntlessShield;
exports.checkInfiltrator = checkInfiltrator;
exports.checkSeedBoost = checkSeedBoost;
exports.checkMultihitBoost = checkMultihitBoost;
exports.chainMods = chainMods;
exports.getBaseDamage = getBaseDamage;
exports.getMostProficientStat = getMostProficientStat;
exports.getFinalDamage = getFinalDamage;
exports.getShellSideArmCategory = getShellSideArmCategory;
exports.getWeightFactor = getWeightFactor;
exports.countBoosts = countBoosts;
exports.getEVDescriptionText = getEVDescriptionText;
exports.handleFixedDamageMoves = handleFixedDamageMoves;
exports.pokeRound = pokeRound;
exports.OF16 = OF16;
exports.OF32 = OF32;
const util_1 = require("../util");
const stats_1 = require("../stats");
const EV_ITEMS = [
    'Macho Brace',
    'Power Anklet',
    'Power Band',
    'Power Belt',
    'Power Bracer',
    'Power Lens',
    'Power Weight',
];
function isGrounded(pokemon, field) {
    if (field.isGravity)
        return true;
    if (pokemon.isGrounded !== undefined)
        return pokemon.isGrounded;
    return pokemon.hasItem('Iron Ball') ||
        (!pokemon.hasType('Flying') &&
            !pokemon.hasAbility('Levitate') &&
            !pokemon.hasItem('Air Balloon'));
}
function getModifiedStat(stat, mod, gen) {
    if (gen && gen.num < 3) {
        if (mod >= 0) {
            const pastGenBoostTable = [1, 1.5, 2, 2.5, 3, 3.5, 4];
            stat = Math.floor(stat * pastGenBoostTable[mod]);
        }
        else {
            const numerators = [100, 66, 50, 40, 33, 28, 25];
            stat = Math.floor((stat * numerators[-mod]) / 100);
        }
        return Math.min(999, Math.max(1, stat));
    }
    const numerator = 0;
    const denominator = 1;
    const modernGenBoostTable = [
        [2, 8],
        [2, 7],
        [2, 6],
        [2, 5],
        [2, 4],
        [2, 3],
        [2, 2],
        [3, 2],
        [4, 2],
        [5, 2],
        [6, 2],
        [7, 2],
        [8, 2],
    ];
    stat = OF16(stat * modernGenBoostTable[6 + mod][numerator]);
    stat = Math.floor(stat / modernGenBoostTable[6 + mod][denominator]);
    return stat;
}
function computeFinalStats(gen, attacker, defender, field, ...stats) {
    const sides = [[attacker, field.attackerSide], [defender, field.defenderSide]];
    for (const [pokemon, side] of sides) {
        for (const stat of stats) {
            if (stat === 'spe') {
                pokemon.stats.spe = getFinalSpeed(gen, pokemon, field, side);
            }
            else {
                pokemon.stats[stat] = getModifiedStat(pokemon.rawStats[stat], pokemon.boosts[stat], gen);
            }
        }
    }
}
function getFinalSpeed(gen, pokemon, field, side) {
    const weather = field.weather || '';
    const terrain = field.terrain;
    let speed = getModifiedStat(pokemon.rawStats.spe, pokemon.boosts.spe, gen);
    const speedMods = [];
    if (side.isTailwind)
        speedMods.push(8192);
    if (side.isPledgeSwamp)
        speedMods.push(1024);
    if ((pokemon.hasAbility('Unburden') && pokemon.abilityOn) ||
        (pokemon.hasAbility('Chlorophyll') && weather.includes('Sun')) ||
        (pokemon.hasAbility('Sand Rush') && weather === 'Sand') ||
        (pokemon.hasAbility('Swift Swim') && weather.includes('Rain')) ||
        (pokemon.hasAbility('Slush Rush') && ['Hail', 'Snow'].includes(weather)) ||
        (pokemon.hasAbility('Surge Surfer') && terrain === 'Electric')) {
        speedMods.push(8192);
    }
    else if (pokemon.hasAbility('Quick Feet') && pokemon.status) {
        speedMods.push(6144);
    }
    else if (pokemon.hasAbility('Slow Start') && pokemon.abilityOn) {
        speedMods.push(2048);
    }
    else if (getMostProficientStat(pokemon, gen) === 'spe' &&
        ((pokemon.hasAbility('Protosynthesis') &&
            (weather.includes('Sun') || pokemon.hasItem('Booster Energy'))) ||
            (pokemon.hasAbility('Quark Drive') &&
                (terrain === 'Electric' || pokemon.hasItem('Booster Energy'))))) {
        speedMods.push(6144);
    }
    if (pokemon.hasItem('Choice Scarf')) {
        speedMods.push(6144);
    }
    else if (pokemon.hasItem('Iron Ball', ...EV_ITEMS)) {
        speedMods.push(2048);
    }
    else if (pokemon.hasItem('Quick Powder') && pokemon.named('Ditto')) {
        speedMods.push(8192);
    }
    speed = OF32(pokeRound((speed * chainMods(speedMods, 410, 131172)) / 4096));
    if (pokemon.hasStatus('par') && !pokemon.hasAbility('Quick Feet')) {
        speed = Math.floor(OF32(speed * (gen.num < 7 ? 25 : 25)) / 100);
    }
    speed = Math.min(gen.num <= 2 ? 999 : 10000, speed);
    return Math.max(0, speed);
}
function getMoveEffectiveness(gen, move, type, isGhostRevealed, isGravity, isRingTarget, isMiracleEye) {
    if (isMiracleEye && type === 'Dark' && move.hasType('Psychic')) {
        return 1;
    }
    else if ((isRingTarget || isGhostRevealed) && type === 'Ghost' &&
        move.hasType('Normal', 'Fighting')) {
        return 1;
    }
    else if ((isRingTarget || isGravity) && type === 'Flying' && move.hasType('Ground')) {
        return 1;
    }
    else if (move.named('Freeze-Dry') && type === 'Water') {
        return 2;
    }
    else if (move.named('Flying Press')) {
        return (gen.types.get('fighting').effectiveness[type] *
            gen.types.get('flying').effectiveness[type]);
    }
    else {
        return gen.types.get((0, util_1.toID)(move.type)).effectiveness[type];
    }
}
function checkAirLock(pokemon, field) {
    if (pokemon.hasAbility('Air Lock', 'Cloud Nine')) {
        field.weather = undefined;
    }
}
function checkForecast(pokemon, weather) {
    if (pokemon.hasAbility('Forecast') && pokemon.named('Castform')) {
        switch (weather) {
            case 'Sun':
            case 'Harsh Sunshine':
                pokemon.types = ['Fire'];
                break;
            case 'Rain':
            case 'Heavy Rain':
                pokemon.types = ['Water'];
                break;
            case 'Hail':
            case 'Snow':
                pokemon.types = ['Ice'];
                break;
            default:
                pokemon.types = ['Normal'];
        }
    }
}
function checkItem(pokemon, magicRoomActive) {
    if (pokemon.itemSuppressed && pokemon.item) {
        pokemon.heldItem = pokemon.item;
        pokemon.item = '';
    }
    if (pokemon.hasAbility('Klutz') && !EV_ITEMS.includes(pokemon.item) ||
        magicRoomActive) {
        pokemon.item = '';
    }
}
function checkWonderRoom(pokemon, wonderRoomActive) {
    if (wonderRoomActive) {
        [pokemon.rawStats.def, pokemon.rawStats.spd] = [pokemon.rawStats.spd, pokemon.rawStats.def];
    }
}
function checkIntimidate(gen, source, target) {
    const blocked = target.hasAbility('Clear Body', 'White Smoke', 'Hyper Cutter', 'Full Metal Body') ||
        (gen.num >= 8 && target.hasAbility('Inner Focus', 'Own Tempo', 'Oblivious', 'Scrappy')) ||
        target.hasItem('Clear Amulet');
    if (source.hasAbility('Intimidate') && source.abilityOn && !blocked) {
        if (target.hasAbility('Contrary', 'Defiant', 'Guard Dog')) {
            target.boosts.atk = Math.min(6, target.boosts.atk + 1);
        }
        else if (target.hasAbility('Simple')) {
            target.boosts.atk = Math.max(-6, target.boosts.atk - 2);
        }
        else {
            target.boosts.atk = Math.max(-6, target.boosts.atk - 1);
        }
        if (target.hasAbility('Competitive')) {
            target.boosts.spa = Math.min(6, target.boosts.spa + 2);
        }
    }
}
function checkDownload(source, target, wonderRoomActive) {
    if (source.hasAbility('Download')) {
        let def = target.stats.def;
        let spd = target.stats.spd;
        if (wonderRoomActive)
            [def, spd] = [spd, def];
        if (spd <= def) {
            source.boosts.spa = Math.min(6, source.boosts.spa + 1);
        }
        else {
            source.boosts.atk = Math.min(6, source.boosts.atk + 1);
        }
    }
}
function checkIntrepidSword(source, gen) {
    if (source.hasAbility('Intrepid Sword') && gen.num < 9) {
        source.boosts.atk = Math.min(6, source.boosts.atk + 1);
    }
}
function checkDauntlessShield(source, gen) {
    if (source.hasAbility('Dauntless Shield') && gen.num < 9) {
        source.boosts.def = Math.min(6, source.boosts.def + 1);
    }
}
function checkInfiltrator(pokemon, affectedSide) {
    if (pokemon.hasAbility('Infiltrator')) {
        affectedSide.isReflect = false;
        affectedSide.isLightScreen = false;
        affectedSide.isAuroraVeil = false;
    }
}
function checkSeedBoost(pokemon, field) {
    if (!pokemon.item)
        return;
    if (field.terrain && pokemon.item.includes('Seed')) {
        const terrainSeed = pokemon.item.substring(0, pokemon.item.indexOf(' '));
        if (field.hasTerrain(terrainSeed)) {
            if (terrainSeed === 'Grassy' || terrainSeed === 'Electric') {
                pokemon.boosts.def = pokemon.hasAbility('Contrary')
                    ? Math.max(-6, pokemon.boosts.def - 1)
                    : Math.min(6, pokemon.boosts.def + 1);
            }
            else {
                pokemon.boosts.spd = pokemon.hasAbility('Contrary')
                    ? Math.max(-6, pokemon.boosts.spd - 1)
                    : Math.min(6, pokemon.boosts.spd + 1);
            }
        }
    }
}
function checkMultihitBoost(gen, attacker, defender, move, field, desc, usedWhiteHerb = false) {
    if (move.named('Gyro Ball', 'Electro Ball') && defender.hasAbility('Gooey', 'Tangling Hair')) {
        if (attacker.hasItem('White Herb') && !usedWhiteHerb) {
            desc.attackerItem = attacker.item;
            usedWhiteHerb = true;
        }
        else {
            attacker.boosts.spe = Math.max(attacker.boosts.spe - 1, -6);
            attacker.stats.spe = getFinalSpeed(gen, attacker, field, field.attackerSide);
            desc.defenderAbility = defender.ability;
        }
    }
    else if (move.named('Power-Up Punch')) {
        attacker.boosts.atk = Math.min(attacker.boosts.atk + 1, 6);
        attacker.stats.atk = getModifiedStat(attacker.rawStats.atk, attacker.boosts.atk, gen);
    }
    if (defender.hasAbility('Stamina')) {
        if (attacker.hasAbility('Unaware')) {
            desc.attackerAbility = attacker.ability;
        }
        else {
            defender.boosts.def = Math.min(defender.boosts.def + 1, 6);
            defender.stats.def = getModifiedStat(defender.rawStats.def, defender.boosts.def, gen);
            desc.defenderAbility = defender.ability;
        }
    }
    else if (defender.hasAbility('Weak Armor')) {
        if (attacker.hasAbility('Unaware')) {
            desc.attackerAbility = attacker.ability;
        }
        else {
            if (defender.hasItem('White Herb') && !usedWhiteHerb) {
                desc.defenderItem = defender.item;
                usedWhiteHerb = true;
            }
            else {
                defender.boosts.def = Math.max(defender.boosts.def - 1, -6);
                defender.stats.def = getModifiedStat(defender.rawStats.def, defender.boosts.def, gen);
            }
        }
        defender.boosts.spe = Math.min(defender.boosts.spe + 2, 6);
        defender.stats.spe = getFinalSpeed(gen, defender, field, field.defenderSide);
        desc.defenderAbility = defender.ability;
    }
    const simple = attacker.hasAbility('Simple') ? 2 : 1;
    if (move.dropsStats) {
        if (attacker.hasAbility('Unaware')) {
            desc.attackerAbility = attacker.ability;
        }
        else {
            const stat = move.category === 'Special' ? 'spa' : 'atk';
            let boosts = attacker.boosts[stat];
            if (attacker.hasAbility('Contrary')) {
                boosts = Math.min(6, boosts + move.dropsStats);
                desc.attackerAbility = attacker.ability;
            }
            else {
                boosts = Math.max(-6, boosts - move.dropsStats * simple);
                if (simple > 1)
                    desc.attackerAbility = attacker.ability;
            }
            if (attacker.hasItem('White Herb') && attacker.boosts[stat] < 0 && !usedWhiteHerb) {
                boosts += move.dropsStats * simple;
                desc.attackerItem = attacker.item;
                usedWhiteHerb = true;
            }
            attacker.boosts[stat] = boosts;
            attacker.stats[stat] = getModifiedStat(attacker.rawStats[stat], defender.boosts[stat], gen);
        }
    }
    return usedWhiteHerb;
}
function chainMods(mods, lowerBound, upperBound) {
    let M = 4096;
    for (const mod of mods) {
        if (mod !== 4096) {
            M = (M * mod + 2048) >> 12;
        }
    }
    return Math.max(Math.min(M, upperBound), lowerBound);
}
function getBaseDamage(level, basePower, attack, defense) {
    return Math.floor(OF32(Math.floor(OF32(OF32(Math.floor((2 * level) / 5 + 2) * basePower) * attack) / defense) / 50 + 2));
}
function getMostProficientStat(pokemon, gen) {
    let bestStat = 'atk';
    for (const stat of ['def', 'spa', 'spd', 'spe']) {
        if (getModifiedStat(pokemon.rawStats[stat], pokemon.boosts[stat], gen) >
            getModifiedStat(pokemon.rawStats[bestStat], pokemon.boosts[bestStat], gen)) {
            bestStat = stat;
        }
    }
    return bestStat;
}
function getFinalDamage(baseAmount, i, effectiveness, isBurned, stabMod, finalMod, protect) {
    let damageAmount = Math.floor(OF32(baseAmount * (85 + i)) / 100);
    if (stabMod !== 4096)
        damageAmount = OF32(damageAmount * stabMod) / 4096;
    damageAmount = Math.floor(OF32(pokeRound(damageAmount) * effectiveness));
    if (isBurned)
        damageAmount = Math.floor(damageAmount / 2);
    if (protect)
        damageAmount = pokeRound(OF32(damageAmount * 1024) / 4096);
    return OF16(pokeRound(Math.max(1, OF32(damageAmount * finalMod) / 4096)));
}
function getShellSideArmCategory(source, target) {
    const physicalDamage = source.stats.atk / target.stats.def;
    const specialDamage = source.stats.spa / target.stats.spd;
    return physicalDamage > specialDamage ? 'Physical' : 'Special';
}
function getWeightFactor(pokemon) {
    return pokemon.hasAbility('Heavy Metal') ? 2
        : (pokemon.hasAbility('Light Metal') || pokemon.hasItem('Float Stone')) ? 0.5 : 1;
}
function countBoosts(gen, boosts) {
    let sum = 0;
    const STATS = gen.num === 1
        ? ['atk', 'def', 'spa', 'spe']
        : ['atk', 'def', 'spa', 'spd', 'spe'];
    for (const stat of STATS) {
        const boost = boosts[stat];
        if (boost && boost > 0)
            sum += boost;
    }
    return sum;
}
function getEVDescriptionText(gen, pokemon, stat, natureName) {
    const nature = gen.natures.get((0, util_1.toID)(natureName));
    return (pokemon.ivs[stat] +
        (nature.plus === nature.minus ? ''
            : nature.plus === stat ? '+'
                : nature.minus === stat ? '-'
                    : '') + ' ' +
        stats_1.Stats.displayStat(stat));
}
function handleFixedDamageMoves(attacker, move, defender) {
    if (move.named('Seismic Toss', 'Night Shade')) {
        return attacker.level;
    }
    else if (move.named('Dragon Rage')) {
        return 40;
    }
    else if (move.named('Sonic Boom')) {
        return 20;
    }
    else if (move.named('Super Fang')) {
        return Math.floor(defender.originalCurHP / 2) > 0 ? Math.floor(defender.originalCurHP / 2) : 1;
    }
    return 0;
}
function pokeRound(num) {
    return num % 1 > 0.5 ? Math.ceil(num) : Math.floor(num);
}
function OF16(n) {
    return n > 65535 ? n % 65536 : n;
}
function OF32(n) {
    return n > 4294967295 ? n % 4294967296 : n;
}
//# sourceMappingURL=util.js.map
})();
