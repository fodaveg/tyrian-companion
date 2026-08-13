import type { GuildWars2Client } from './guild-wars-2-client';

export interface AccountProfile {
	id: string;
	name: string;
	world: number;
	created: string;
}

export interface AccountGateway {
	loadProfile(): Promise<AccountProfile>;
}

export class InvalidAccountProfileError extends Error {
	constructor() {
		super('The Guild Wars 2 API returned an invalid account profile.');
		this.name = 'InvalidAccountProfileError';
	}
}

/** Account boundary kept separate from transport and presentation concerns. */
export class GuildWars2AccountGateway implements AccountGateway {
	constructor(private readonly client: Pick<GuildWars2Client, 'request'>) {}

	async loadProfile(): Promise<AccountProfile> {
		const value = await this.client.request('account');
		if (!isAccountProfile(value)) {
			throw new InvalidAccountProfileError();
		}

		return {
			id: value.id,
			name: value.name,
			world: value.world,
			created: value.created,
		};
	}
}

function isAccountProfile(value: unknown): value is AccountProfile {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		typeof value.id === 'string' &&
		'name' in value &&
		typeof value.name === 'string' &&
		'world' in value &&
		typeof value.world === 'number' &&
		Number.isInteger(value.world) &&
		'created' in value &&
		typeof value.created === 'string'
	);
}
