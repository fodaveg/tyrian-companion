interface SecretStorageReader {
	getSecret(id: string): string | null;
	listSecrets(): string[];
}

interface SecretStorageHost {
	secretStorage: SecretStorageReader;
}

export interface ApiKeyProvider {
	hasSelection(): boolean;
	/** Reads the selected value once. Callers must keep it ephemeral. */
	readSelectedApiKey(): string | null;
}

/** Resolves the selected secret only when an explicit operation begins. */
export class ObsidianApiKeyProvider implements ApiKeyProvider {
	constructor(
		private readonly app: SecretStorageHost,
		private readonly getSecretName: () => string,
	) {}

	hasSelection(): boolean {
		const secretName = this.getSecretName();
		return secretName.length > 0 && this.app.secretStorage.listSecrets().includes(secretName);
	}

	readSelectedApiKey(): string | null {
		const secretName = this.getSecretName();
		if (!secretName || !this.app.secretStorage.listSecrets().includes(secretName)) {
			return null;
		}

		return this.app.secretStorage.getSecret(secretName);
	}
}
