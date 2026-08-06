import {StatusName} from './model';

/** Major-status moves whose supported effect is exhausted by an existing status. */
export const PURE_STATUS_EFFECTS: Record<string, {status: StatusName; moveType?: string}> = {
  darkvoid: {status: 'slp'}, glare: {status: 'par'}, grasswhistle: {status: 'slp'}, hypnosis: {status: 'slp'},
  lovelykiss: {status: 'slp'}, nuzzle: {status: 'par', moveType: 'Electric'}, poisonpowder: {status: 'psn', moveType: 'Poison'},
  poisongas: {status: 'psn', moveType: 'Poison'}, sing: {status: 'slp'}, sleeppowder: {status: 'slp', moveType: 'Grass'},
  spore: {status: 'slp', moveType: 'Grass'}, stunspore: {status: 'par', moveType: 'Grass'},
  thunderwave: {status: 'par', moveType: 'Electric'}, toxic: {status: 'tox', moveType: 'Poison'},
  willowisp: {status: 'brn', moveType: 'Fire'},
};

export const PURE_STATUS_MOVE_IDS = new Set(Object.keys(PURE_STATUS_EFFECTS));
