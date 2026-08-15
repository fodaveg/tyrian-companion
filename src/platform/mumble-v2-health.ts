import type {
	MumbleV2ChannelError,
	MumbleV2DerivedActivity,
	MumbleV2HeartbeatRecordV1,
	MumbleV2IpcFrameV1,
	MumbleV2LifecycleState,
	MumbleV2SourceStatus,
} from './mumble-v2-contract';

export type MumbleV2SourceHealth = 'unknown' | 'available' | MumbleV2SourceStatus;
export type MumbleV2ActivityHealth = 'unknown' | MumbleV2DerivedActivity;

export interface MumbleV2Health {
	channel: {
		state: MumbleV2LifecycleState;
		error: MumbleV2ChannelError | null;
	};
	source: MumbleV2SourceHealth;
	activity: MumbleV2ActivityHealth;
}

export type MumbleV2HealthEvent =
	| { kind: 'channel'; state: MumbleV2LifecycleState; error?: MumbleV2ChannelError | null }
	| { kind: 'record'; record: MumbleV2HeartbeatRecordV1 | MumbleV2IpcFrameV1 };

export function initialMumbleV2Health(): MumbleV2Health {
	return {
		channel: { state: 'awaiting_bootstrap', error: null },
		source: 'unknown',
		activity: 'unknown',
	};
}

/** Keeps transport, source availability and derived activity as independent axes. */
export function reduceMumbleV2Health(
	current: Readonly<MumbleV2Health>,
	event: MumbleV2HealthEvent,
): MumbleV2Health {
	if (event.kind === 'channel') {
		return {
			channel: { state: event.state, error: event.error ?? null },
			source: current.source,
			activity: current.activity,
		};
	}
	if ('kind' in event.record) {
		return {
			channel: { ...current.channel },
			source: event.record.sourceStatus,
			activity: 'unknown',
		};
	}
	return {
		channel: { ...current.channel },
		source: 'available',
		activity: event.record.activity,
	};
}
