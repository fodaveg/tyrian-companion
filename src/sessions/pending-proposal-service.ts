import type { InactivityStopProposal } from './inactivity-stop-detector';
import {
	comparePendingProposals,
	isPendingProposal,
	normalizeProposalQueueRecord,
	sameProposalIntent,
	type PendingProposal,
	type PendingProposalIntent,
	type PendingProposalQueueRecord,
	type ProposalReceipt,
	type ProposalReceiptOutcome,
} from './pending-proposal-model';
import type { PendingProposalStore } from './pending-proposal-store';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import type { DetectionCorrectionCause } from './session-detection-quality';

export const PENDING_PROPOSAL_STALE_MS = 6 * 60 * 60_000;
export const PENDING_PROPOSAL_EXPIRES_MS = 24 * 60 * 60_000;
export const PROPOSAL_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const PROPOSAL_CLAIM_MS = 2 * 60_000;
export const MAX_PENDING_PROPOSALS = 32;
export const MAX_PROPOSAL_RECEIPTS = 256;

export type ProposalQueueState =
	| { status: 'loading'; pendingCount: 0; next: null }
	| { status: 'ready'; pendingCount: number; next: PendingProposal | null }
	| { status: 'unavailable'; pendingCount: 0; next: null; message: string };

export type ProposalEnqueueInput =
	| { phase: 'start'; proposal: RelevantStartProposal }
	| { phase: 'stop'; proposal: InactivityStopProposal; sessionId: string; baselineSnapshotId: string };

export type ProposalEnqueueResult =
	| { status: 'added' | 'duplicate' | 'coalesced'; proposal: PendingProposal }
	| { status: 'unavailable' };

export type ProposalClaimResult =
	| { status: 'claimed' | 'already_claimed'; proposal: PendingProposal }
	| { status: 'busy' | 'missing' | 'stale' | 'unavailable' };

export interface ProposalReconcileContext {
	accountId: string | null;
	session: { status: string; sessionId?: string; baselineSnapshotId?: string };
	recoveryPending: boolean;
}

export class PendingProposalService {
	private state: ProposalQueueState = { status: 'loading', pendingCount: 0, next: null };
	private initializeFlight: Promise<ProposalQueueState> | null = null;
	private disposed = false;

	constructor(
		private readonly store: PendingProposalStore,
		private readonly instanceId: string,
		private readonly now: () => Date = () => new Date(),
		private readonly onStateChange: () => void = () => undefined,
	) {
		if (!validId(instanceId)) throw new TypeError('Proposal queue instance id is invalid.');
	}

	initialize(): Promise<ProposalQueueState> {
		if (this.initializeFlight) return this.initializeFlight;
		if (this.state.status !== 'loading') return Promise.resolve(this.getState());
		const flight = this.project().finally(() => { if (this.initializeFlight === flight) this.initializeFlight = null; });
		this.initializeFlight = flight;
		return flight;
	}

	getState(): ProposalQueueState { return structuredClone(this.state); }

	async project(): Promise<ProposalQueueState> {
		if (this.disposed) return this.unavailable();
		try {
			const now = this.timestamp();
			const nextState = await this.store.transaction((raw) => {
				const record = this.record(raw);
				const reconciled = expireAndPrune(record, now);
				return { result: projection(reconciled), next: reconciled };
			});
			if (this.disposed) return this.getState();
			this.state = nextState;
			this.onStateChange();
			return this.getState();
		} catch { return this.unavailable(); }
	}

	async acknowledge(intent: PendingProposalIntent): Promise<boolean> {
		if (this.disposed) return false;
		try {
			const now = this.timestamp();
			const acknowledged = await this.store.transaction((raw) => {
				const record = expireAndPrune(this.record(raw), now);
				const proposal = record.proposals.find((entry) => sameProposalIntent(entry, intent));
				if (!proposal) return { result: false, next: record };
				proposal.acknowledgedAt ??= now;
				proposal.lastSurfacedAt = now;
				bump(record);
				return { result: true, next: record };
			});
			if (this.disposed) return false;
			await this.project();
			return acknowledged;
		} catch { this.unavailable(); return false; }
	}

	async enqueue(input: ProposalEnqueueInput): Promise<ProposalEnqueueResult> {
		if (this.disposed) return { status: 'unavailable' };
		try {
			const now = this.timestamp();
			const candidate = createPending(input, now);
			if (!candidate || !isPendingProposal(candidate)) return { status: 'unavailable' };
			const result = await this.store.transaction<ProposalEnqueueResult>((raw) => {
				const record = expireAndPrune(this.record(raw), now);
				const duplicate = record.proposals.find((entry) => entry.proposalId === candidate.proposalId);
				if (duplicate) {
					if (duplicate.claim) {
						return { result: { status: 'duplicate', proposal: structuredClone(duplicate) }, next: record };
					}
					duplicate.duplicateCount += 1;
					duplicate.lastObservedAt = now;
					bump(record);
					return { result: { status: 'duplicate', proposal: structuredClone(duplicate) }, next: record };
				}
				const coalesced = record.proposals.find((entry) => sameBinding(entry, candidate));
				if (coalesced?.claim) {
					return { result: { status: 'unavailable' }, next: record };
				}
				if (coalesced) resolve(record, coalesced, 'superseded', now, null, null, null);
				if (record.proposals.length >= MAX_PENDING_PROPOSALS) {
					return { result: { status: 'unavailable' }, next: record };
				}
				record.proposals.push(candidate);
				record.proposals.sort(comparePendingProposals);
				bump(record);
				return { result: { status: coalesced ? 'coalesced' : 'added', proposal: structuredClone(candidate) }, next: record };
			});
			if (this.disposed) return { status: 'unavailable' };
			await this.project();
			return result;
		} catch { this.unavailable(); return { status: 'unavailable' }; }
	}

	async claim(intent: PendingProposalIntent, operationId: string): Promise<ProposalClaimResult> {
		if (!validId(intent.proposalId) || !validId(operationId) || this.disposed) return { status: 'unavailable' };
		try {
			const now = this.timestamp();
			const result = await this.store.transaction<ProposalClaimResult>((raw) => {
				const record = expireAndPrune(this.record(raw), now);
				const proposal = record.proposals.find((entry) => sameProposalIntent(entry, intent));
				if (!proposal) return { result: { status: 'missing' }, next: record };
				if (Date.parse(proposal.staleAt) <= Date.parse(now)) return { result: { status: 'stale' }, next: record };
				const liveClaim = proposal.claim && Date.parse(proposal.claim.expiresAt) > Date.parse(now)
					? proposal.claim : null;
				const exactExisting = liveClaim?.instanceId === this.instanceId && liveClaim.operationId === operationId;
				if (liveClaim && !exactExisting) return { result: { status: 'busy' }, next: record };
				if (Date.parse(now) < Date.parse(proposal.enqueuedAt)) throw new Error('Clock moved backwards.');
				proposal.claim = {
					operationId, instanceId: this.instanceId, claimedAt: now,
					expiresAt: addMs(now, PROPOSAL_CLAIM_MS),
				};
				bump(record);
				return { result: { status: exactExisting ? 'already_claimed' : 'claimed', proposal: structuredClone(proposal) }, next: record };
			});
			if (this.disposed) return { status: 'unavailable' };
			await this.project();
			return result;
		} catch { this.unavailable(); return { status: 'unavailable' }; }
	}

	async renew(intent: PendingProposalIntent, operationId: string): Promise<boolean> {
		if (!validId(operationId) || this.disposed) return false;
		try {
			const now = this.timestamp();
			const renewed = await this.store.transaction((raw) => {
				const record = expireAndPrune(this.record(raw), now);
				const proposal = record.proposals.find((entry) => sameProposalIntent(entry, intent));
				if (!proposal?.claim || proposal.claim.instanceId !== this.instanceId || proposal.claim.operationId !== operationId) {
					return { result: false, next: record };
				}
				proposal.claim = { ...proposal.claim, claimedAt: now, expiresAt: addMs(now, PROPOSAL_CLAIM_MS) };
				bump(record);
				return { result: true, next: record };
			});
			if (this.disposed) return false;
			await this.project();
			return renewed;
		} catch { this.unavailable(); return false; }
	}

	async accept(intent: PendingProposalIntent, operationId: string, sessionId: string): Promise<boolean> {
		if (!validId(operationId) || !validId(sessionId)) return false;
		return this.completeClaim(intent, operationId, 'accepted', sessionId, null, null);
	}

	async dismiss(
		intent: PendingProposalIntent,
		operationId: string,
		sessionId: string | null,
		cause: DetectionCorrectionCause,
		correctionRecorded: boolean,
	): Promise<boolean> {
		if (!validId(operationId) || (sessionId !== null && !validId(sessionId))) return false;
		if (!allowedCause(intent.phase, cause)) return false;
		return this.completeClaim(intent, operationId, 'dismissed', sessionId, cause, correctionRecorded);
	}

	async reconcile(context: ProposalReconcileContext): Promise<ProposalQueueState> {
		try {
			const now = this.timestamp();
			await this.store.transaction((raw) => {
				const record = expireAndPrune(this.record(raw), now);
				let changed = false;
				for (const proposal of [...record.proposals]) {
					if (proposal.claim && Date.parse(proposal.claim.expiresAt) > Date.parse(now)) continue;
					const valid = (context.accountId === null || context.accountId === proposal.accountId) && !context.recoveryPending &&
						(proposal.phase === 'start'
							? context.session.status === 'idle'
							: context.session.status === 'active' && context.session.sessionId === proposal.binding.sessionId &&
								context.session.baselineSnapshotId === proposal.binding.baselineSnapshotId);
					if (!valid) { resolve(record, proposal, 'invalidated', now, null, null, null); changed = true; }
				}
				if (changed) bump(record);
				return { result: undefined, next: record };
			});
			return await this.project();
		} catch { return this.unavailable(); }
	}

	dispose(): void {
		this.disposed = true;
		this.store.close();
		this.state = { status: 'unavailable', pendingCount: 0, next: null, message: 'Pending confirmations are unavailable.' };
	}

	private async completeClaim(
		intent: PendingProposalIntent, operationId: string, outcome: 'accepted' | 'dismissed', sessionId: string | null,
		cause: DetectionCorrectionCause | null, recorded: boolean | null,
	): Promise<boolean> {
		try {
			const now = this.timestamp();
			const completed = await this.store.transaction((raw) => {
				const record = expireAndPrune(this.record(raw), now);
				const proposal = record.proposals.find((entry) => sameProposalIntent(entry, intent));
				if (!proposal?.claim || proposal.claim.operationId !== operationId || proposal.claim.instanceId !== this.instanceId ||
					Date.parse(proposal.claim.expiresAt) <= Date.parse(now)) return { result: false, next: record };
				resolve(record, proposal, outcome, now, sessionId, cause, recorded);
				bump(record);
				return { result: true, next: record };
			});
			if (this.disposed) return false;
			await this.project();
			return completed;
		} catch { this.unavailable(); return false; }
	}

	private record(raw: unknown): PendingProposalQueueRecord {
		if (raw === undefined) return { version: 1, revision: 0, proposals: [], receipts: [] };
		const record = normalizeProposalQueueRecord(raw);
		if (!record) throw new Error('Confirmation queue is corrupt.');
		return record;
	}

	private timestamp(): string {
		const value = this.now().toISOString();
		if (Number.isNaN(Date.parse(value))) throw new Error('Clock is unavailable.');
		return value;
	}

	private unavailable(): ProposalQueueState {
		this.state = { status: 'unavailable', pendingCount: 0, next: null, message: 'Pending confirmations are unavailable.' };
		if (!this.disposed) this.onStateChange();
		return this.getState();
	}
}

function createPending(input: ProposalEnqueueInput, now: string): PendingProposal | null {
	const common = {
		version: 1 as const, proposalId: input.proposal.proposalId, accountId: input.proposal.accountId,
		detectedAt: input.phase === 'start' ? input.proposal.confirmedAt : input.proposal.detectedAt,
		enqueuedAt: now, staleAt: addMs(now, PENDING_PROPOSAL_STALE_MS), expiresAt: addMs(now, PENDING_PROPOSAL_EXPIRES_MS),
		acknowledgedAt: null, lastSurfacedAt: null, duplicateCount: 0,
		lastObservedAt: input.phase === 'start' ? input.proposal.confirmedAt : input.proposal.detectedAt, claim: null,
	};
	return input.phase === 'start'
		? { ...common, phase: 'start', binding: { kind: 'idle', ruleSetId: input.proposal.ruleSet.id, ruleSetVersion: input.proposal.ruleSet.version }, proposal: structuredClone(input.proposal) }
		: { ...common, phase: 'stop', binding: { kind: 'session', sessionId: input.sessionId, baselineSnapshotId: input.baselineSnapshotId }, proposal: structuredClone(input.proposal) };
}

function expireAndPrune(record: PendingProposalQueueRecord, now: string): PendingProposalQueueRecord {
	const before = JSON.stringify({ proposals: record.proposals, receipts: record.receipts });
	for (const proposal of [...record.proposals]) {
		if (proposal.claim && Date.parse(proposal.claim.expiresAt) > Date.parse(now)) continue;
		if (proposal.claim) proposal.claim = null;
		if (Date.parse(proposal.expiresAt) <= Date.parse(now)) resolve(record, proposal, 'expired', now, null, null, null);
	}
	record.receipts = record.receipts
		.filter((receipt) => Date.parse(receipt.resolvedAt) + PROPOSAL_RECEIPT_RETENTION_MS > Date.parse(now))
		.sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || a.proposalId.localeCompare(b.proposalId))
		.slice(-MAX_PROPOSAL_RECEIPTS);
	record.proposals.sort(comparePendingProposals);
	if (before !== JSON.stringify({ proposals: record.proposals, receipts: record.receipts })) bump(record);
	return record;
}

function resolve(
	record: PendingProposalQueueRecord, proposal: PendingProposal, outcome: ProposalReceiptOutcome, resolvedAt: string,
	sessionId: string | null, correctionCause: DetectionCorrectionCause | null, correctionRecorded: boolean | null,
): void {
	record.proposals = record.proposals.filter((entry) => entry.proposalId !== proposal.proposalId);
	const receipt: ProposalReceipt = { version: 1, proposalId: proposal.proposalId, outcome, resolvedAt, sessionId, correctionCause, correctionRecorded };
	record.receipts = record.receipts.filter((entry) => entry.proposalId !== receipt.proposalId).concat(receipt);
	record.receipts = record.receipts
		.sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || a.proposalId.localeCompare(b.proposalId))
		.slice(-MAX_PROPOSAL_RECEIPTS);
}

function projection(record: PendingProposalQueueRecord): ProposalQueueState {
	return { status: 'ready', pendingCount: record.proposals.length, next: record.proposals[0] ? structuredClone(record.proposals[0]) : null };
}
function sameBinding(a: PendingProposal, b: PendingProposal): boolean {
	return a.phase === b.phase && JSON.stringify(a.binding) === JSON.stringify(b.binding);
}
function addMs(iso: string, milliseconds: number): string { return new Date(Date.parse(iso) + milliseconds).toISOString(); }
function validId(value: string): boolean { return value.length > 0 && value.length <= 512; }
function bump(record: PendingProposalQueueRecord): void {
	if (!Number.isSafeInteger(record.revision + 1)) throw new Error('Proposal queue revision overflow.');
	record.revision += 1;
}
function allowedCause(phase: PendingProposal['phase'], cause: DetectionCorrectionCause): boolean {
	return phase === 'start'
		? cause === 'not_farming' || cause === 'unrelated_account_activity' || cause === 'other'
		: cause === 'still_farming' || cause === 'temporary_pause' || cause === 'unrelated_account_activity' || cause === 'other';
}
