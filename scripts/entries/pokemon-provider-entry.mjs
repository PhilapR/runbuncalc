import {
	createRabRunRuntimeProvider,
	resolveRabTrainerOrder,
} from '@philapr/pokemon-run-runtime';

const metadata = Object.freeze({
	repository: 'pokemon-mono',
	engineRevision: '5648e07f8c48f8ce20e091dbf367dab213350686',
	artifactSha256: '986f4ef086939bdb546ae1fdc117e6e180f7d0b2e2d4d6bc364ff8f3b662eec0',
	contractRevision: '8e2c3c8f021094814b1b44844c7de4992095d274',
	contractDigest: '402809acb338a7fc274e72ae9bcc6efbe4956f8a980a951e05b665ee52f0ba75',
});

globalThis.RunBunPokemonProvider = Object.freeze({
	metadata,
	resolveTrainerOrder: resolveRabTrainerOrder,
	provider: createRabRunRuntimeProvider({
		providerRevision: metadata.engineRevision,
		engineVersion: '0.2.0',
	}),
});
