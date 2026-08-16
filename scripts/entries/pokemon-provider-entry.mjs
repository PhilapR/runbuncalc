import {
	createRabRunRuntimeProvider,
	resolveRabTrainerOrder,
} from '@philapr/pokemon-run-runtime';

const metadata = Object.freeze({
	repository: 'pokemon-mono',
	engineRevision: '58aad68ac7a93980e1d424e768b009ce7cc0ba2f',
	artifactSha256: 'c9ce24a7daf27a55fe3cd11002d1a6d7ed878ab79815ec545b54f429d8e08f2f',
	contractRevision: 'f7933f91b706c969a1dc5430a9484e5fafa4d66c',
	contractDigest: '2cd1db3e69c9989b9e766a97e35ebc96a41cef5d756794829c20be2385c88a61',
});

globalThis.RunBunPokemonProvider = Object.freeze({
	metadata,
	resolveTrainerOrder: resolveRabTrainerOrder,
	provider: createRabRunRuntimeProvider({
		providerRevision: metadata.engineRevision,
		engineVersion: '0.1.0',
	}),
});
