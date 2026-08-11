/* eslint-env browser, jquery, node */
/**
 * Thin Sets → BattleState bridge for Run & Bun AI surfaces.
 * Converts calc-panel / setdex / trainer-party data into serializable
 * PokemonState / BattleState shapes. Does not score or resolve turns.
 */
(function (root) {
	'use strict';

	var RUN_AND_BUN_GENERATION = 8;
	var ZERO_EVS = Object.freeze({hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0});

	function hasCalc() {
		return typeof calc !== 'undefined' && calc && calc.Pokemon && calc.Generations;
	}

	function gen8() {
		return calc.Generations.get(RUN_AND_BUN_GENERATION);
	}

	function setDex() {
		if (typeof SETDEX_SS !== 'undefined' && SETDEX_SS) return SETDEX_SS;
		if (typeof setdex !== 'undefined' && setdex) return setdex;
		return {};
	}

	function cleanMoveName(name) {
		if (!name || name === '(No Move)' || name === 'Nothing') return null;
		return String(name);
	}

	function moveStatesFromNames(names) {
		var moves = [];
		(names || []).forEach(function (name) {
			var cleaned = cleanMoveName(typeof name === 'string' ? name : (name && name.name));
			if (cleaned) moves.push({name: cleaned});
		});
		return moves;
	}

	function compactBoosts(boosts) {
		if (!boosts) return undefined;
		var out = {};
		['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'].forEach(function (stat) {
			if (typeof boosts[stat] === 'number' && boosts[stat] !== 0) out[stat] = boosts[stat];
		});
		return Object.keys(out).length ? out : undefined;
	}

	function compactIvs(ivs) {
		if (!ivs) return undefined;
		var out = {};
		var incomplete = false;
		['hp', 'atk', 'def', 'spa', 'spd', 'spe'].forEach(function (stat) {
			var value = typeof ivs[stat] === 'number' ? ivs[stat] : 31;
			out[stat] = value;
			if (value !== 31) incomplete = true;
		});
		return incomplete ? out : undefined;
	}

	/**
	 * Rebuild a calculator Pokémon under Gen 8 with explicit zero EVs so
	 * BattleState HP matches Run & Bun AI projections.
	 */
	function rebuildZeroEvPokemon(source, hpRatio) {
		if (!hasCalc()) throw new Error('Calculator package is not loaded');
		var ratio = typeof hpRatio === 'number' && isFinite(hpRatio) ? hpRatio : 1;
		ratio = Math.max(0, Math.min(1, ratio));
		var moveNames = (source.moves || []).map(function (move) {
			return typeof move === 'string' ? move : move.name;
		}).filter(Boolean);
		var options = {
			level: source.level || 100,
			ability: source.ability || undefined,
			abilityOn: source.abilityOn !== false,
			item: source.item || undefined,
			nature: source.nature || undefined,
			gender: source.gender || undefined,
			ivs: source.ivs || undefined,
			evs: {
				hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0,
			},
			boosts: source.boosts || undefined,
			status: source.status || undefined,
			toxicCounter: source.toxicCounter || 0,
			teraType: source.teraType || undefined,
			isDynamaxed: !!source.isDynamaxed,
			isSaltCure: !!source.isSaltCure,
			alliesFainted: source.alliesFainted || 0,
			moves: moveNames,
		};
		if (source.types && source.types.length) {
			options.overrides = {types: source.types.filter(Boolean)};
		}
		var rebuilt = new calc.Pokemon(gen8(), source.name, options);
		var maxHp = rebuilt.maxHP(true);
		var current = Math.max(0, Math.min(maxHp, Math.round(maxHp * ratio)));
		options.curHP = current;
		return new calc.Pokemon(gen8(), source.name, options);
	}

	function pokemonStateFromCalcPokemon(pokemon, id) {
		if (!pokemon || !pokemon.name) throw new Error('Pokémon is required for id ' + id);
		var maxHp = pokemon.maxHP(true);
		var current = pokemon.curHP(true);
		var state = {
			id: id,
			species: pokemon.name,
			level: pokemon.level,
			hp: {current: current, max: maxHp},
			moves: moveStatesFromNames(pokemon.moves),
		};
		if (!state.moves.length) {
			throw new Error(id + ' (' + pokemon.name + ') needs at least one move');
		}
		if (pokemon.ability) state.ability = pokemon.ability;
		if (pokemon.abilityOn === true) state.abilityOn = true;
		if (pokemon.item) state.item = pokemon.item;
		if (pokemon.nature) state.nature = pokemon.nature;
		if (pokemon.gender && pokemon.gender !== 'N') state.gender = pokemon.gender;
		var ivs = compactIvs(pokemon.ivs);
		if (ivs) state.ivs = ivs;
		// Transport compatibility only; AI projections force zero EVs.
		state.evs = {
			hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0,
		};
		var boosts = compactBoosts(pokemon.boosts);
		if (boosts) state.boosts = boosts;
		if (pokemon.status) state.status = pokemon.status;
		if (pokemon.status === 'tox' && pokemon.toxicCounter) {
			state.toxicCounter = pokemon.toxicCounter;
		}
		if (pokemon.teraType) state.teraType = pokemon.teraType;
		if (pokemon.isDynamaxed) state.isDynamaxed = true;
		if (pokemon.isSaltCure) state.isSaltCure = true;
		if (pokemon.alliesFainted) state.alliesFainted = pokemon.alliesFainted;
		return state;
	}

	function pokemonStateFromPanel(pokeInfo, id) {
		if (typeof createPokemon !== 'function') {
			throw new Error('createPokemon is not available');
		}
		var source = createPokemon(pokeInfo);
		var ratio = source.maxHP() > 0 ? source.curHP() / source.maxHP() : 1;
		return pokemonStateFromCalcPokemon(rebuildZeroEvPokemon(source, ratio), id);
	}

	function parseSetLabel(label) {
		var text = String(label || '');
		// Trainer list labels look like "[12]Species (Set Name)"
		var indexed = text.match(/^\[\d+\](.+?) \((.+)\)\s*$/);
		if (indexed) return {species: indexed[1], setName: indexed[2]};
		var open = text.indexOf(' (');
		var close = text.lastIndexOf(')');
		if (open > 0 && close > open) {
			return {
				species: text.substring(0, open),
				setName: text.substring(open + 2, close),
			};
		}
		return {species: text, setName: ''};
	}

	function ivsFromSet(set) {
		var ivs = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
		if (!set || !set.ivs) return ivs;
		var map = {hp: 'hp', at: 'atk', df: 'def', sa: 'spa', sd: 'spd', sp: 'spe'};
		Object.keys(map).forEach(function (legacy) {
			if (typeof set.ivs[legacy] === 'number') ivs[map[legacy]] = set.ivs[legacy];
		});
		['hp', 'atk', 'def', 'spa', 'spd', 'spe'].forEach(function (stat) {
			if (typeof set.ivs[stat] === 'number') ivs[stat] = set.ivs[stat];
		});
		return ivs;
	}

	function pokemonStateFromSet(species, setName, id) {
		if (!hasCalc()) throw new Error('Calculator package is not loaded');
		var dex = setDex();
		var entry = dex[species] && dex[species][setName];
		if (!entry) {
			throw new Error('Unknown set: ' + species + ' (' + setName + ')');
		}
		var source = {
			name: species,
			level: entry.level || 100,
			ability: entry.ability,
			abilityOn: true,
			item: entry.item,
			nature: entry.nature,
			ivs: ivsFromSet(entry),
			moves: entry.moves || [],
			boosts: {},
			status: '',
			toxicCounter: 0,
		};
		return pokemonStateFromCalcPokemon(rebuildZeroEvPokemon(source, 1), id);
	}

	function pokemonStateFromSetLabel(label, id) {
		var parsed = parseSetLabel(label);
		if (!parsed.species || !parsed.setName) {
			throw new Error('Could not parse set label: ' + label);
		}
		return pokemonStateFromSet(parsed.species, parsed.setName, id);
	}

	function uniqueBySpeciesSet(labels) {
		var seen = {};
		var out = [];
		(labels || []).forEach(function (label) {
			var parsed = parseSetLabel(label);
			var key = parsed.species + '\0' + parsed.setName;
			if (seen[key]) return;
			seen[key] = true;
			out.push(label);
		});
		return out;
	}

	function collectTeamLabels(containerId) {
		var rootEl = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
		if (!rootEl) return [];
		var labels = [];
		Array.prototype.forEach.call(rootEl.querySelectorAll('[data-id]'), function (node) {
			if (node.getAttribute('data-id')) labels.push(node.getAttribute('data-id'));
		});
		return labels;
	}

	function sideEffectsFromCalcSide(side) {
		if (!side) return undefined;
		var effects = {};
		if (side.spikes) effects.spikes = side.spikes;
		if (side.isSR) effects.stealthRock = true;
		if (side.steelsurge) effects.steelsurge = true;
		if (side.vinelash) effects.vinelash = true;
		if (side.wildfire) effects.wildfire = true;
		if (side.cannonade) effects.cannonade = true;
		if (side.volcalith) effects.volcalith = true;
		if (side.isReflect) effects.reflect = true;
		if (side.isLightScreen) effects.lightScreen = true;
		if (side.isAuroraVeil) effects.auroraVeil = true;
		if (side.isTailwind) effects.tailwind = true;
		if (side.isSeeded) effects.seeded = true;
		if (side.isForesight) effects.foresight = true;
		if (side.isHelpingHand) effects.helpingHand = true;
		if (side.isFriendGuard) effects.friendGuard = true;
		if (side.isBattery) effects.battery = true;
		if (side.isPowerSpot) effects.powerSpot = true;
		if (side.isProtected) effects.protected = true;
		return Object.keys(effects).length ? effects : undefined;
	}

	function fieldStateFromCalcField(field) {
		var out = {};
		if (!field) return out;
		if (field.weather && field.weather !== 'None' && field.weather !== '') {
			out.weather = field.weather;
		}
		if (field.terrain && field.terrain !== 'None' && field.terrain !== '') {
			out.terrain = field.terrain;
		}
		if (field.isMagicRoom) out.magicRoom = true;
		if (field.isWonderRoom) out.wonderRoom = true;
		if (field.isGravity) out.gravity = true;
		if (field.isBeadsOfRuin) out.beadsOfRuin = true;
		if (field.isTabletsOfRuin) out.tabletsOfRuin = true;
		if (field.isSwordOfRuin) out.swordOfRuin = true;
		if (field.isVesselOfRuin) out.vesselOfRuin = true;
		return out;
	}

	function partyWithActives(actives, bench, sidePrefix) {
		var party = actives.slice();
		var activeSpecies = {};
		actives.forEach(function (active) {
			activeSpecies[active.species] = true;
		});
		var nextIndex = actives.length + 1;
		(bench || []).forEach(function (candidate) {
			// Prefer unique bench slots; skip exact species duplicates of an active.
			if (!candidate || activeSpecies[candidate.species]) return;
			var id = sidePrefix + '-' + nextIndex;
			nextIndex += 1;
			party.push(Object.assign({}, candidate, {id: id}));
		});
		return party;
	}

	/**
	 * One side's Pokémon on the field.
	 *
	 * Singles has one, Doubles has two, so a side's actives are a LIST. The
	 * singular `playerActive`/`aiActive` spelling stays because every existing
	 * caller uses it; `playerActives`/`aiActives` is the opt-in for the second
	 * slot, and passing more than the mode has slots for is refused rather than
	 * quietly truncated — a dropped active is a Pokémon missing from the fight.
	 */
	function activesForSide(single, list, mode, label) {
		var actives = Array.isArray(list) && list.length ? list.slice() : (single ? [single] : []);
		if (!actives.length) throw new Error(label + ' Pokémon is required');
		var slots = mode === 'Doubles' ? 2 : 1;
		if (actives.length > slots) {
			throw new Error('a ' + mode + ' battle has ' + slots + ' active Pokémon per side, got ' +
				actives.length + ' for ' + label);
		}
		var ids = {};
		actives.forEach(function (active) {
			if (!active || !active.id) throw new Error(label + ' Pokémon need an id');
			if (ids[active.id]) throw new Error(label + ' repeats active id ' + active.id);
			ids[active.id] = true;
		});
		return actives;
	}

	function buildBattleState(options) {
		var opts = options || {};
		var mode = opts.mode === 'Doubles' ? 'Doubles' : 'Singles';
		var playerActives = activesForSide(opts.playerActive, opts.playerActives, mode, 'playerActive');
		var aiActives = activesForSide(opts.aiActive, opts.aiActives, mode, 'aiActive');
		var playerParty = partyWithActives(playerActives, opts.playerBench || [], 'player');
		var aiParty = partyWithActives(aiActives, opts.aiBench || [], 'ai');
		var field = opts.field || {};
		var playerEffects = opts.playerEffects;
		var aiEffects = opts.aiEffects;
		var idsOf = function (actives) {
			return actives.map(function (active) {
				return active.id;
			});
		};
		var state = {
			generation: RUN_AND_BUN_GENERATION,
			mode: mode,
			turn: typeof opts.turn === 'number' ? opts.turn : 1,
			field: field,
			sides: {
				ai: {
					activeIds: idsOf(aiActives),
					party: aiParty,
				},
				player: {
					activeIds: idsOf(playerActives),
					party: playerParty,
				},
			},
			firstTurnOutIds: idsOf(aiActives).concat(idsOf(playerActives)),
		};
		if (aiEffects) state.sides.ai.effects = aiEffects;
		if (playerEffects) state.sides.player.effects = playerEffects;
		return state;
	}

	/**
	 * Emit Gen 8 BattleState from the current calc panels.
	 * Left (#p1) → player, right (#p2) → ai. Optional benches from Team /
	 * opposing trainer lists.
	 */
	function battleStateFromCalcPanels(options) {
		var opts = options || {};
		if (typeof window === 'undefined' || typeof document === 'undefined') {
			throw new Error('battleStateFromCalcPanels requires a browser');
		}
		if (typeof window.jQuery === 'undefined') {
			throw new Error('jQuery is required to read calc panels');
		}
		var $ = window.jQuery;
		var p1 = $('#p1');
		var p2 = $('#p2');
		if (!p1.length || !p2.length) {
			throw new Error('Calc panels #p1 and #p2 were not found');
		}

		var playerActive = pokemonStateFromPanel(p1, 'player-1');
		var aiActive = pokemonStateFromPanel(p2, 'ai-1');

		var playerBench = [];
		if (opts.includePlayerTeam !== false) {
			uniqueBySpeciesSet(collectTeamLabels('team-poke-list')).forEach(function (label) {
				try {
					var parsed = parseSetLabel(label);
					if (parsed.species === playerActive.species) return;
					playerBench.push(pokemonStateFromSetLabel(label, 'player-bench'));
				} catch (error) {
					// Skip sets the current dex cannot resolve.
				}
			});
		}

		var aiBench = [];
		if (opts.includeTrainerParty !== false) {
			var trainerLabels = [];
			if (typeof CURRENT_TRAINER_POKS !== 'undefined' && CURRENT_TRAINER_POKS && CURRENT_TRAINER_POKS.length) {
				trainerLabels = CURRENT_TRAINER_POKS.slice();
			} else {
				trainerLabels = collectTeamLabels('trainer-pok-list-opposing')
					.concat(collectTeamLabels('trainer-pok-list-opposing2'));
			}
			uniqueBySpeciesSet(trainerLabels).forEach(function (label) {
				try {
					var parsed = parseSetLabel(label);
					if (parsed.species === aiActive.species) return;
					aiBench.push(pokemonStateFromSetLabel(label, 'ai-bench'));
				} catch (error) {
					// Skip unresolved trainer set labels.
				}
			});
		}

		var field = {};
		var playerEffects;
		var aiEffects;
		if (typeof createField === 'function') {
			var calcField = createField();
			field = fieldStateFromCalcField(calcField);
			playerEffects = sideEffectsFromCalcSide(calcField.attackerSide);
			aiEffects = sideEffectsFromCalcSide(calcField.defenderSide);
		}

		return buildBattleState({
			playerActive: playerActive,
			aiActive: aiActive,
			playerBench: playerBench,
			aiBench: aiBench,
			field: field,
			playerEffects: playerEffects,
			aiEffects: aiEffects,
			mode: opts.mode || 'Singles',
			turn: 1,
		});
	}

	/**
	 * UX callouts for Sets → AI loads. Always Gen 8 + zero-EV projection so
	 * callers do not silently assume calc-panel generation/EV spreads apply.
	 */
	function projectionCallouts() {
		return [
			{
				id: 'generation',
				level: 'warn',
				summary: 'Always Gen ' + RUN_AND_BUN_GENERATION + '.',
				text: 'Run & Bun AI BattleState is always generation ' + RUN_AND_BUN_GENERATION +
					', even when the calc UI generation selector differs.',
			},
			{
				id: 'zero-evs',
				level: 'warn',
				summary: 'EVs forced to 0 for AI projections.',
				text: 'All EVs are forced to 0 when projecting HP and stats for AI. ' +
					'Panel EV spreads are ignored — calc damage may not match AI ActionFacts.',
			},
		];
	}

	var api = {
		RUN_AND_BUN_GENERATION: RUN_AND_BUN_GENERATION,
		ZERO_EVS: ZERO_EVS,
		parseSetLabel: parseSetLabel,
		pokemonStateFromCalcPokemon: pokemonStateFromCalcPokemon,
		pokemonStateFromSet: pokemonStateFromSet,
		pokemonStateFromSetLabel: pokemonStateFromSetLabel,
		pokemonStateFromPanel: pokemonStateFromPanel,
		rebuildZeroEvPokemon: rebuildZeroEvPokemon,
		buildBattleState: buildBattleState,
		battleStateFromCalcPanels: battleStateFromCalcPanels,
		fieldStateFromCalcField: fieldStateFromCalcField,
		sideEffectsFromCalcSide: sideEffectsFromCalcSide,
		projectionCallouts: projectionCallouts,
	};

	root.RunBunSetsBridge = api;
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
})(typeof window !== 'undefined' ? window : global);
