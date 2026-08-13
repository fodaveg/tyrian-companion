export const COORDINATION_STATE_VERSION = 1 as const;

export interface ActiveSessionLease {
	machineId: string;
	instanceId: string;
	sessionId: string;
	fence: number;
	acquiredAt: number;
	renewedAt: number;
	expiresAt: number;
}

export interface CoordinationState {
	version: typeof COORDINATION_STATE_VERSION;
	machineId: string;
	fenceCounter: number;
	lease: ActiveSessionLease | null;
}

export type ActiveSessionLeaseHandle = ActiveSessionLease;

export type AcquireLeaseResult =
	| { status: 'acquired' | 'already_owned'; handle: ActiveSessionLeaseHandle }
	| { status: 'busy'; ownerExpiresAt: number }
	| { status: 'error'; code: 'unavailable' | 'corrupt' | 'clock_anomaly' | 'fence_overflow' | 'disposed' };

export type RenewLeaseResult =
	| { status: 'renewed'; handle: ActiveSessionLeaseHandle }
	| { status: 'lost' }
	| { status: 'error'; code: 'unavailable' | 'corrupt' | 'clock_anomaly' | 'disposed' };

export type AssertLeaseResult =
	| { status: 'owned' }
	| { status: 'lost' }
	| { status: 'error'; code: 'unavailable' | 'corrupt' | 'clock_anomaly' | 'disposed' };

export type ReleaseLeaseResult =
	| { status: 'released' }
	| { status: 'lost' }
	| { status: 'error'; code: 'unavailable' | 'corrupt' | 'clock_anomaly' | 'disposed' };
