/**
 * `secrets` of HebraHost (SPEC-TYRIAN-EN-HEBRA.md §2, Hebra's decision of 28 Sep: synchronous,
 * preloaded from the keychain).
 *
 * The core reads its secrets SYNCHRONOUSLY (Obsidian's `SecretStorage`: `list`/`get`/`set`) and
 * keeps only each entry's NAME in its settings. Hebra's keychain is asynchronous and gives the
 * plugin ONE entry, `api.secrets` key `api-key`, which Hebra aliases to the keychain account the
 * compiled module used (`tyrian-api-key-v1`, SPEC-PLUGINS-EXTERNOS.md §7 and §11.2). So:
 *
 * - that entry holds a JSON document with EVERY named secret of the plugin
 *   (`{ "v": 1, "secrets": { name: value } }`), never in clear outside the keychain;
 * - `createPreloadedSecrets` reads it once before the core starts and answers from memory; `set`
 *   updates memory at once and writes the whole document behind it, in order;
 * - a stored value that is not that document (a bare key saved by hand before the format) is
 *   adopted as the secret `LEGACY_SECRET_NAME`, never lost.
 *
 * Where Hebra cannot keep secrets (the web, or a Hebra whose `secrets` is not implemented yet,
 * which rejects with `capability-not-available`), the backend is memory: the key is lost on reload,
 * which is enough for consultation mode.
 */
import type { HebraPluginApi } from 'hebra-plugin-api';

import type { TyrianSecretsPort } from '../tyrian-host';

/** Where the secrets document lives: the keychain entry or, without one, memory. */
export interface TyrianSecretsBackend {
	load(): Promise<string | null>;
	save(value: string): Promise<void>;
}

/** The `api.secrets` key Hebra aliases to the old keychain account `tyrian-api-key-v1`. */
export const HEBRA_SECRETS_KEY = 'api-key';
export const LEGACY_SECRET_NAME = 'tyrian-api-key';

interface SecretsDocument {
	v: 1;
	secrets: Record<string, string>;
}

export function parseSecretsDocument(raw: string | null): Record<string, string> {
	if (raw === null || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw) as Partial<SecretsDocument> | null;
		if (parsed?.v === 1 && parsed.secrets && typeof parsed.secrets === 'object') {
			const out: Record<string, string> = {};
			for (const [name, value] of Object.entries(parsed.secrets)) {
				if (typeof value === 'string') out[name] = value;
			}
			return out;
		}
	} catch {
		// Not JSON: a bare key saved before this format, adopted below.
	}
	return { [LEGACY_SECRET_NAME]: raw };
}

export interface PreloadedSecrets extends TyrianSecretsPort {
	/** Waits for the keychain writes in flight (tests and the plugin's cleanup). */
	flush(): Promise<void>;
}

export async function createPreloadedSecrets(
	backend: TyrianSecretsBackend,
	onWriteError: (error: unknown) => void = () => undefined,
): Promise<PreloadedSecrets> {
	const values = parseSecretsDocument(await backend.load());
	let writes: Promise<void> = Promise.resolve();
	return {
		list: () => Object.keys(values).sort(),
		get: (id) => (Object.prototype.hasOwnProperty.call(values, id) ? values[id] ?? null : null),
		set(id, value) {
			values[id] = value;
			const document: SecretsDocument = { v: 1, secrets: { ...values } };
			writes = writes
				.then(() => backend.save(JSON.stringify(document)))
				.catch((error: unknown) => onWriteError(error));
		},
		flush: () => writes,
	};
}

export function createMemorySecretsBackend(initial: string | null = null): TyrianSecretsBackend & { readonly value: string | null } {
	let value = initial;
	return {
		load: async () => value,
		save: async (next) => { value = next; },
		get value() { return value; },
	};
}

/**
 * The backend over `api.secrets`, or memory when this Hebra cannot keep secrets here. A `get`
 * that rejects at load (the capability is declared but not implemented in this Hebra, or the
 * keychain is locked) also falls back to memory, reported once, rather than stopping the plugin:
 * the core then simply has no key, which is consultation mode.
 */
export async function hebraSecretsBackend(
	api: Pick<HebraPluginApi, 'has' | 'secrets'>,
	report: (error: unknown, where: string) => void,
): Promise<TyrianSecretsBackend> {
	if (!api.has('secrets')) return createMemorySecretsBackend();
	let initial: string | null;
	try {
		initial = await api.secrets.get(HEBRA_SECRETS_KEY);
	} catch (error) {
		report(error, 'secrets.load');
		return createMemorySecretsBackend();
	}
	return {
		load: async () => initial,
		save: async (value) => { await api.secrets.set(HEBRA_SECRETS_KEY, value); },
	};
}
