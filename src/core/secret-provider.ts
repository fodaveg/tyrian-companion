import type { TyrianSecretsPort } from '../host/tyrian-host';

/** The two synchronous reads of `TyrianHost.secrets` the API key needs; it never writes one. */
type SecretReader = Pick<TyrianSecretsPort, 'get' | 'list'>;

export interface ApiKeyProvider {
	hasSelection(): boolean;
	/** Reads the selected value once. Callers must keep it ephemeral. */
	readSelectedApiKey(): string | null;
}

/**
 * Resolves the selected secret only when an explicit operation begins. Settings hold only the
 * entry's NAME; the value comes from the host's secret store (Obsidian's `SecretStorage`, Hebra's
 * preloaded keychain) on every read and is never kept here.
 */
export class HostApiKeyProvider implements ApiKeyProvider {
	constructor(
		private readonly secrets: SecretReader,
		private readonly getSecretName: () => string,
	) {}

	hasSelection(): boolean {
		const secretName = this.getSecretName();
		return secretName.length > 0 && this.secrets.list().includes(secretName);
	}

	readSelectedApiKey(): string | null {
		const secretName = this.getSecretName();
		if (!secretName || !this.secrets.list().includes(secretName)) {
			return null;
		}

		return this.secrets.get(secretName);
	}
}
