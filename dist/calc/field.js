(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

class Field {
    constructor(field = {}) {
        this.gameType = field.gameType || 'Singles';
        this.terrain = field.terrain;
        this.weather = field.weather;
        this.isMagicRoom = !!field.isMagicRoom;
        this.isWonderRoom = !!field.isWonderRoom;
        this.isGravity = !!field.isGravity;
        this.isWaterSport = !!field.isWaterSport;
        this.isMudSport = !!field.isMudSport;
        this.isIonDeluge = !!field.isIonDeluge;
        this.isAuraBreak = field.isAuraBreak || false;
        this.isFairyAura = field.isFairyAura || false;
        this.isDarkAura = field.isDarkAura || false;
        this.isBeadsOfRuin = field.isBeadsOfRuin || false;
        this.isSwordOfRuin = field.isSwordOfRuin || false;
        this.isTabletsOfRuin = field.isTabletsOfRuin || false;
        this.isVesselOfRuin = field.isVesselOfRuin || false;
        this.attackerSide = new Side(field.attackerSide || {});
        this.defenderSide = new Side(field.defenderSide || {});
    }
    hasWeather(...weathers) {
        return !!(this.weather && weathers.includes(this.weather));
    }
    hasTerrain(...terrains) {
        return !!(this.terrain && terrains.includes(this.terrain));
    }
    swap() {
        [this.attackerSide, this.defenderSide] = [this.defenderSide, this.attackerSide];
        return this;
    }
    clone() {
        return new Field({
            gameType: this.gameType,
            weather: this.weather,
            terrain: this.terrain,
            isMagicRoom: this.isMagicRoom,
            isWonderRoom: this.isWonderRoom,
            isGravity: this.isGravity,
            isWaterSport: this.isWaterSport,
            isMudSport: this.isMudSport,
            isIonDeluge: this.isIonDeluge,
            attackerSide: this.attackerSide,
            defenderSide: this.defenderSide,
            isAuraBreak: this.isAuraBreak,
            isDarkAura: this.isDarkAura,
            isFairyAura: this.isFairyAura,
            isBeadsOfRuin: this.isBeadsOfRuin,
            isSwordOfRuin: this.isSwordOfRuin,
            isTabletsOfRuin: this.isTabletsOfRuin,
            isVesselOfRuin: this.isVesselOfRuin,
        });
    }
}
exports.Field = Field;
class Side {
    constructor(side = {}) {
        this.spikes = side.spikes || 0;
        this.steelsurge = !!side.steelsurge;
        this.vinelash = !!side.vinelash;
        this.wildfire = !!side.wildfire;
        this.cannonade = !!side.cannonade;
        this.volcalith = !!side.volcalith;
        this.isSR = !!side.isSR;
        this.isReflect = !!side.isReflect;
        this.isLightScreen = !!side.isLightScreen;
        this.isProtected = !!side.isProtected;
        this.isSeeded = !!side.isSeeded;
        this.isForesight = !!side.isForesight;
        this.isMiracleEye = !!side.isMiracleEye;
        this.isTailwind = !!side.isTailwind;
        this.isHelpingHand = !!side.isHelpingHand;
        this.isFlowerGift = !!side.isFlowerGift;
        this.isFriendGuard = !!side.isFriendGuard;
        this.isAuroraVeil = !!side.isAuroraVeil;
        this.isLuckyChant = !!side.isLuckyChant;
        this.isBattery = !!side.isBattery;
        this.isPowerSpot = !!side.isPowerSpot;
        this.isPledgeSwamp = !!side.isPledgeSwamp;
        this.isSwitching = side.isSwitching;
    }
    clone() {
        return new Side(this);
    }
}
exports.Side = Side;
//# sourceMappingURL=field.js.map
})();
