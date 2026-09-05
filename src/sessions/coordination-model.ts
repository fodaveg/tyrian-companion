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
	| { status: 'busy'; ownerExpiresAt: number; ownerInstanceId: string; ownerMachineId: string }
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

/** Whole seconds until the current owner's lease naturally clears, floored at zero. */
export function leaseRemainingSeconds(ownerExpiresAt: number, now: number): number {
	return Math.max(0, Math.ceil((ownerExpiresAt - now) / 1_000));
}
