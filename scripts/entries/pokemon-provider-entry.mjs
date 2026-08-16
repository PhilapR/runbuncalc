import {
	createRabRunRuntimeProvider,
	resolveRabTrainerOrder,
} from '@philapr/pokemon-run-runtime';

const metadata = Object.freeze({
	repository: 'pokemon-mono',
	engineRevision: '2ae1b7e5721a2d2ff3b9692df75f65329c891650',
	artifactSha256: '5503927e7d7cccc85bae88f30c4d73a2c4f7c2c207096c0166693fcb8d108e55',
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
