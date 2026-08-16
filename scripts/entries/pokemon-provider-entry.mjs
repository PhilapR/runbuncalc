import {createRabRunRuntimeProvider} from '@philapr/pokemon-run-runtime';

const metadata = Object.freeze({
	repository: 'pokemon-mono',
	engineRevision: '112b916cf01732c5edba5b3ed1b24535369b4844',
	artifactSha256: '21c1f624907dbb1160182920c788aef531b3b2ec97cbd70b7e7c7721b91203c9',
	contractRevision: 'f7933f91b706c969a1dc5430a9484e5fafa4d66c',
	contractDigest: '2cd1db3e69c9989b9e766a97e35ebc96a41cef5d756794829c20be2385c88a61',
});

globalThis.RunBunPokemonProvider = Object.freeze({
	metadata,
	provider: createRabRunRuntimeProvider({
		providerRevision: metadata.engineRevision,
		engineVersion: '0.1.0',
	}),
});
