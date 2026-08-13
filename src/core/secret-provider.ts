interface SecretStorageReader {
	getSecret(id: string): string | null;
	listSecrets(): string[];
}

interface SecretStorageHost {
	secretStorage: SecretStorageReader;
}

export interface ApiKeyProvider {
	hasSelection(): boolean;
	getApiKey(): string | null;
}

/** Resolves the selected secret only at the point where a request needs it. */
export class ObsidianApiKeyProvider implements ApiKeyProvider {
	constructor(
		private readonly app: SecretStorageHost,
		private readonly getSecretName: () => string,
	) {}

	hasSelection(): boolean {
		const secretName = this.getSecretName();
		return secretName.length > 0 && this.app.secretStorage.listSecrets().includes(secretName);
	}

	getApiKey(): string | null {
		const secretName = this.getSecretName();
		if (!secretName) {
			return null;
		}

		return this.app.secretStorage.getSecret(secretName);
	}
}
