import { HttpTransportError } from '../core/http';
import {
	MissingApiKeyError,
	type GuildWars2Operation,
} from './guild-wars-2-client';

export const REQUIRED_ACCOUNT_SCOPES = ['account'] as const;
export const RECOMMENDED_SCOPES = [
	'account',
	'characters',
	'inventories',
	'wallet',
	'tradingpost',
	'progression',
	'unlocks',
] as const;

export interface AccountProfile {
	id: string;
	name: string;
	world: number;
	created: string;
	access: string[];
	commander: boolean;
}

export interface TokenInfo {
	id: string;
	name: string;
	permissions: string[];
	type?: string;
	expiresAt?: string;
	urls?: string[];
}

export interface ConnectionDetails {
	account: AccountProfile;
	keyName: string;
	scopes: string[];
	missingRecommendedScopes: string[];
	hasFutureUrlRestrictions: boolean;
}

export type ConnectionErrorCode =
	| 'missing_key'
	| 'key_invalid'
	| 'key_expired'
	| 'url_restricted'
	| 'scope_missing'
	| 'rate_limited'
	| 'unavailable'
	| 'invalid_response';

export class ConnectionCheckError extends Error {
	constructor(
		readonly code: ConnectionErrorCode,
		message: string,
		readonly preserveLastGood = false,
		readonly retryAfterMs: number | null = null,
	) {
		super(message);
		this.name = 'ConnectionCheckError';
	}
}

export interface AccountGateway {
	checkConnection(): Promise<ConnectionDetails>;
}

/** Performs the explicit and atomic tokeninfo → account connection check. */
export class GuildWars2AccountGateway implements AccountGateway {
	constructor(
		private readonly client: {
			beginOperation(): Pick<GuildWars2Operation, 'request'>;
		},
		private readonly now: () => number = Date.now,
	) {}

	async checkConnection(): Promise<ConnectionDetails> {
		let operation: Pick<GuildWars2Operation, 'request'>;
		try {
			operation = this.client.beginOperation();
		} catch (error) {
			throw mapConnectionError(error, 'tokeninfo');
		}

		let tokenInfo: TokenInfo;
		try {
			tokenInfo = parseTokenInfo(
				await operation.request('tokeninfo', new Set([401, 403])),
			);
		} catch (error) {
			throw mapConnectionError(error, 'tokeninfo');
		}

		this.validateTokenAccess(tokenInfo);

		let account: AccountProfile;
		try {
			account = parseAccountProfile(await operation.request('account', new Set([401])));
		} catch (error) {
			throw mapConnectionError(error, 'account');
		}

		const scopes = [...tokenInfo.permissions].sort();
		return {
			account,
			keyName: tokenInfo.name,
			scopes,
			missingRecommendedScopes: RECOMMENDED_SCOPES.filter((scope) => !scopes.includes(scope)),
			hasFutureUrlRestrictions: (tokenInfo.urls?.length ?? 0) > 0,
		};
	}

	private validateTokenAccess(tokenInfo: TokenInfo): void {
		if (!tokenInfo.permissions.includes('account')) {
			throw new ConnectionCheckError(
				'scope_missing',
				'The selected API key does not grant account access.',
			);
		}

		if (tokenInfo.expiresAt && Date.parse(tokenInfo.expiresAt) <= this.now()) {
			throw new ConnectionCheckError('key_expired', 'The selected API key has expired.');
		}

		if (tokenInfo.urls && tokenInfo.urls.length > 0 && !allowsConnectionEndpoints(tokenInfo.urls)) {
			throw new ConnectionCheckError(
				'url_restricted',
				'The selected API key is restricted to specific endpoints.',
			);
		}
	}
}

function allowsConnectionEndpoints(urls: string[]): boolean {
	const normalized = new Set(urls.map((url) => url.split('?')[0]?.replace(/\/$/u, '')));
	return normalized.has('/v2/tokeninfo') && normalized.has('/v2/account');
}

export function parseAccountProfile(value: unknown): AccountProfile {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		typeof value.name !== 'string' ||
		typeof value.world !== 'number' ||
		!Number.isInteger(value.world) ||
		typeof value.created !== 'string' ||
		Number.isNaN(Date.parse(value.created)) ||
		!isStringArray(value.access) ||
		typeof value.commander !== 'boolean'
	) {
		throw new ConnectionCheckError('invalid_response', 'The account response was invalid.');
	}

	return {
		id: value.id,
		name: value.name,
		world: value.world,
		created: value.created,
		access: [...value.access],
		commander: value.commander,
	};
}

export function parseTokenInfo(value: unknown): TokenInfo {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		typeof value.name !== 'string' ||
		!isStringArray(value.permissions) ||
		(value.type !== undefined && typeof value.type !== 'string') ||
		(value.expires_at !== undefined && typeof value.expires_at !== 'string') ||
		(typeof value.expires_at === 'string' && Number.isNaN(Date.parse(value.expires_at))) ||
		(value.urls !== undefined && !isStringArray(value.urls))
	) {
		throw new ConnectionCheckError('invalid_response', 'The API key response was invalid.');
	}

	return {
		id: value.id,
		name: value.name,
		permissions: [...value.permissions],
		type: value.type,
		expiresAt: value.expires_at,
		urls: value.urls === undefined ? undefined : [...value.urls],
	};
}

function mapConnectionError(error: unknown, endpoint: 'tokeninfo' | 'account'): ConnectionCheckError {
	if (error instanceof ConnectionCheckError) {
		return error;
	}
	if (error instanceof MissingApiKeyError) {
		return new ConnectionCheckError('missing_key', error.message);
	}
	if (!(error instanceof HttpTransportError)) {
		return new ConnectionCheckError('unavailable', 'Guild Wars 2 is currently unavailable.', true);
	}
	if (error.status === 401) {
		return new ConnectionCheckError('key_invalid', 'The selected API key is invalid.');
	}
	if (error.status === 403) {
		return endpoint === 'tokeninfo'
			? new ConnectionCheckError(
					'unavailable',
					'The API key could not be verified right now.',
					true,
				)
			: new ConnectionCheckError(
					'scope_missing',
					'The selected API key cannot access account details.',
				);
	}
	if (error.status === 429) {
		return new ConnectionCheckError(
			'rate_limited',
			'Guild Wars 2 is rate limiting requests. Try again shortly.',
			true,
			error.retryAfterMs,
		);
	}
	if (error.kind === 'timeout' || error.kind === 'network' || (error.status ?? 0) >= 500) {
		return new ConnectionCheckError(
			'unavailable',
			'Guild Wars 2 is currently unavailable.',
			true,
		);
	}

	return new ConnectionCheckError('unavailable', 'The connection check failed.', true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
