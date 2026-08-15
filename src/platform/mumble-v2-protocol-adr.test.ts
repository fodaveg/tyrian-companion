import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	MUMBLE_V2_CHANNEL_ERRORS,
	MUMBLE_V2_LIFECYCLE_CONTRACT,
	MUMBLE_V2_MESSAGE_KEYS,
	MUMBLE_V2_RECOMMENDED_DEFAULTS,
	MUMBLE_V2_SOURCE_STATUSES,
	MUMBLE_V2_TRANSPORT_CONTRACT,
} from './mumble-v2-contract';

const ADR_PATH = 'docs/adr/0002-h8-4-local-ipc-protocol.md';
const BLOCK_START = '<!-- h8.4-protocol:start -->\n```json\n';
const BLOCK_END = '\n```\n<!-- h8.4-protocol:end -->';
const EXPECTED_SEMANTIC_SHA256 = '036bbbe7cf9e7d7a2449658932e5c42f6fb9bd3f0b49ca19a045fd66569c8e87';
const EXPECTED_DOCUMENT_SHA256 = '16cc528757794a7f46cc8eccd65edeaca74b7132faff52df398b42fe1c561e7f';

const EXPECTED_PROTOCOL_DECISION = {
	schemaVersion: 1,
	decisionId: 'H8.4',
	status: 'accepted_protocol_only',
	version: 1,
	roles: { server: 'helper', client: 'plugin' },
	network: {
		protocol: MUMBLE_V2_TRANSPORT_CONTRACT.protocol,
		host: MUMBLE_V2_TRANSPORT_CONTRACT.host,
		bindPort: MUMBLE_V2_TRANSPORT_CONTRACT.bindPort,
		discoveredPortMinimum: MUMBLE_V2_TRANSPORT_CONTRACT.discoveredPortMinimum,
		discoveredPortMaximum: MUMBLE_V2_TRANSPORT_CONTRACT.discoveredPortMaximum,
		authenticatedConnectionMaximum:
			MUMBLE_V2_TRANSPORT_CONTRACT.authenticatedConnectionMaximum,
		pendingConnectionMaximum: MUMBLE_V2_TRANSPORT_CONTRACT.pendingConnectionMaximum,
	},
	framing: {
		lengthBytes: MUMBLE_V2_TRANSPORT_CONTRACT.recordLengthBytes,
		lengthEncoding: MUMBLE_V2_TRANSPORT_CONTRACT.recordLengthEncoding,
		payloadEncoding: MUMBLE_V2_TRANSPORT_CONTRACT.payloadEncoding,
		minimumPayloadBytes: MUMBLE_V2_TRANSPORT_CONTRACT.minimumFrameBytes,
		maximumPayloadBytes: MUMBLE_V2_TRANSPORT_CONTRACT.maxFrameBytes,
		maximumBufferedRecordBytes: MUMBLE_V2_TRANSPORT_CONTRACT.maximumBufferedRecordBytes,
		inputChunkRetention: MUMBLE_V2_TRANSPORT_CONTRACT.inputChunkRetention,
		recordDelivery: MUMBLE_V2_TRANSPORT_CONTRACT.recordDelivery,
		reject: [
			'zero_length', 'oversize', 'truncated', 'invalid_utf8', 'byte_order_mark',
			'invalid_json', 'non_object_json', 'duplicate_keys', 'trailing_content',
			'unknown_fields', 'missing_fields',
		],
	},
	credentials: {
		token: {
			generatedBy: MUMBLE_V2_TRANSPORT_CONTRACT.tokenGeneratedBy,
			entropyBytes: MUMBLE_V2_TRANSPORT_CONTRACT.tokenEntropyBytes,
			encodedCharacters: MUMBLE_V2_TRANSPORT_CONTRACT.tokenEncodedCharacters,
			randomness: MUMBLE_V2_TRANSPORT_CONTRACT.tokenRandomness,
			encoding: MUMBLE_V2_TRANSPORT_CONTRACT.tokenEncoding,
			scope: MUMBLE_V2_TRANSPORT_CONTRACT.tokenScope,
			comparison: MUMBLE_V2_TRANSPORT_CONTRACT.tokenComparison,
			binding: MUMBLE_V2_TRANSPORT_CONTRACT.tokenBinding,
			retainedAcrossSameProcessReconnect:
				MUMBLE_V2_TRANSPORT_CONTRACT.tokenRetainedAcrossSameProcessReconnect,
			invalidatedOn: MUMBLE_V2_TRANSPORT_CONTRACT.tokenInvalidatedOn,
			allowedSurfaces: MUMBLE_V2_TRANSPORT_CONTRACT.tokenSurfaces,
			forbiddenSurfaces: MUMBLE_V2_TRANSPORT_CONTRACT.tokenForbiddenSurfaces,
		},
		nonce: {
			generatedBy: MUMBLE_V2_TRANSPORT_CONTRACT.nonceGeneratedBy,
			entropyBytes: MUMBLE_V2_TRANSPORT_CONTRACT.nonceEntropyBytes,
			encodedCharacters: MUMBLE_V2_TRANSPORT_CONTRACT.nonceEncodedCharacters,
			randomness: MUMBLE_V2_TRANSPORT_CONTRACT.nonceRandomness,
			encoding: MUMBLE_V2_TRANSPORT_CONTRACT.nonceEncoding,
			scope: MUMBLE_V2_TRANSPORT_CONTRACT.nonceScope,
			requireFreshPerConnection:
				MUMBLE_V2_TRANSPORT_CONTRACT.requireFreshNoncePerConnection,
			allowedSurfaces: MUMBLE_V2_TRANSPORT_CONTRACT.nonceSurfaces,
		},
	},
	handshake: MUMBLE_V2_TRANSPORT_CONTRACT.handshakeOrder,
	messages: MUMBLE_V2_MESSAGE_KEYS,
	sequence: {
		sharedBy: MUMBLE_V2_TRANSPORT_CONTRACT.sequencedKinds,
		initial: MUMBLE_V2_TRANSPORT_CONTRACT.initialSequence,
		step: MUMBLE_V2_TRANSPORT_CONTRACT.sequenceStep,
		maximum: MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMaximum,
		rejectGap: MUMBLE_V2_TRANSPORT_CONTRACT.rejectSequenceGap,
		rejectReplay: MUMBLE_V2_TRANSPORT_CONTRACT.rejectSequenceReplay,
		rejectRegression: MUMBLE_V2_TRANSPORT_CONTRACT.rejectSequenceRegression,
		rejectWrap: MUMBLE_V2_TRANSPORT_CONTRACT.rejectSequenceWrap,
		resetOnNewNonce: MUMBLE_V2_TRANSPORT_CONTRACT.resetSequenceOnNewNonce,
	},
	cadence: {
		slotIntervalMs: MUMBLE_V2_TRANSPORT_CONTRACT.sequencedSlotIntervalMs,
		recordsPerSlot: MUMBLE_V2_TRANSPORT_CONTRACT.sequencedRecordsPerSlot,
		recordChoice: MUMBLE_V2_TRANSPORT_CONTRACT.sequencedRecordChoice,
		sampleReplacesHeartbeat: MUMBLE_V2_TRANSPORT_CONTRACT.sampleReplacesHeartbeatInSlot,
		sampleSatisfiesLiveness: MUMBLE_V2_TRANSPORT_CONTRACT.sampleSatisfiesLiveness,
		heartbeatIntervalMeaning: MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatIntervalMeaning,
		heartbeatSourceStatusPolicy: MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatSourceStatusPolicy,
		heartbeatHealthyStatusAllowed: MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatHealthyStatusAllowed,
		firstValidReadAfter: MUMBLE_V2_TRANSPORT_CONTRACT.firstValidReadAfter,
		firstValidReadEmits: MUMBLE_V2_TRANSPORT_CONTRACT.firstValidReadEmits,
		warmingUpValidReadCount: MUMBLE_V2_TRANSPORT_CONTRACT.warmingUpValidReadCount,
		warmingUpStoresSourceHistory: MUMBLE_V2_TRANSPORT_CONTRACT.warmingUpStoresSourceHistory,
		nextValidReadAction: MUMBLE_V2_TRANSPORT_CONTRACT.nextValidReadAction,
		sourceReadInput: MUMBLE_V2_TRANSPORT_CONTRACT.sourceReadInput,
		sampleActivityDerivation: MUMBLE_V2_TRANSPORT_CONTRACT.sampleActivityDerivation,
		heartbeatClearsSourceHistory: MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatClearsSourceHistory,
		sourceHistoryOnDiscontinuity:
			MUMBLE_V2_TRANSPORT_CONTRACT.sourceHistoryOnDiscontinuity,
		lateInvocationRecordMaximum: MUMBLE_V2_TRANSPORT_CONTRACT.lateInvocationRecordMaximum,
		missedSlotPolicy: MUMBLE_V2_TRANSPORT_CONTRACT.missedSlotPolicy,
		nextSlotAfterLateInvocation: MUMBLE_V2_TRANSPORT_CONTRACT.nextSlotAfterLateInvocation,
		lateAfterHeartbeatTimeout: MUMBLE_V2_TRANSPORT_CONTRACT.lateAfterHeartbeatTimeout,
	},
	timingMs: {
		heartbeatInterval: MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatIntervalMs,
		sourceStalledAfter: MUMBLE_V2_TRANSPORT_CONTRACT.sourceStalledAfterMs,
		discoveryTimeout: MUMBLE_V2_TRANSPORT_CONTRACT.discoveryTimeoutMs,
		connectTimeout: MUMBLE_V2_TRANSPORT_CONTRACT.connectTimeoutMs,
		helloTimeout: MUMBLE_V2_TRANSPORT_CONTRACT.helloTimeoutMs,
		firstSequencedRecordTimeout:
			MUMBLE_V2_TRANSPORT_CONTRACT.firstSequencedRecordTimeoutMs,
		heartbeatTimeout: MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatTimeoutMs,
		reconnectBackoff: MUMBLE_V2_TRANSPORT_CONTRACT.reconnectBackoffMs,
	},
	lifecycle: {
		initialState: MUMBLE_V2_LIFECYCLE_CONTRACT.initialState,
		terminalState: MUMBLE_V2_LIFECYCLE_CONTRACT.terminalState,
		phaseRecordError: MUMBLE_V2_LIFECYCLE_CONTRACT.phaseRecordError,
		phaseRecords: MUMBLE_V2_LIFECYCLE_CONTRACT.phaseRecords,
		transitions: MUMBLE_V2_LIFECYCLE_CONTRACT.transitions,
		timeouts: MUMBLE_V2_LIFECYCLE_CONTRACT.timeouts,
		failureRoutes: MUMBLE_V2_LIFECYCLE_CONTRACT.failureRoutes,
		stdinEofFromStates: MUMBLE_V2_LIFECYCLE_CONTRACT.stdinEofFromStates,
		stdinEofTo: MUMBLE_V2_LIFECYCLE_CONTRACT.stdinEofTo,
		stdinEofAction: MUMBLE_V2_LIFECYCLE_CONTRACT.stdinEofAction,
		stdinEofCloses: MUMBLE_V2_LIFECYCLE_CONTRACT.stdinEofCloses,
		backoffResetState: MUMBLE_V2_LIFECYCLE_CONTRACT.backoffResetState,
		backoffResetEvents: MUMBLE_V2_LIFECYCLE_CONTRACT.backoffResetEvents,
		backoffResetOnlyWhenHealthy:
			MUMBLE_V2_LIFECYCLE_CONTRACT.backoffResetOnlyWhenHealthy,
		sameProcessReconnectEvent: MUMBLE_V2_LIFECYCLE_CONTRACT.sameProcessReconnectEvent,
		newProcessReconnectEvent: MUMBLE_V2_LIFECYCLE_CONTRACT.newProcessReconnectEvent,
	},
	sourceStatuses: MUMBLE_V2_SOURCE_STATUSES,
	channelErrors: MUMBLE_V2_CHANNEL_ERRORS,
	authority: {
		rollout: MUMBLE_V2_RECOMMENDED_DEFAULTS.rollout,
		source: MUMBLE_V2_RECOMMENDED_DEFAULTS.authority,
		confirmation: MUMBLE_V2_RECOMMENDED_DEFAULTS.confirmation,
		retention: MUMBLE_V2_RECOMMENDED_DEFAULTS.retention,
	},
} as const;

describe('H8.4 parseable protocol ADR', () => {
	it('is one exact closed-schema decision with pinned semantic and document hashes', () => {
		const source = readFileSync(ADR_PATH, 'utf8');
		expect(protocolAdrViolations(source)).toEqual([]);
		expect(protocolDecision(source)).toEqual(EXPECTED_PROTOCOL_DECISION);
		expect(protocolBlock(source)).toBe(JSON.stringify(EXPECTED_PROTOCOL_DECISION, null, 2));
	});

	it('rejects extra, missing and reordered decision fields causally', () => {
		const source = readFileSync(ADR_PATH, 'utf8');
		const extra = rewriteDecision(source, (decision) => {
			decision.unexpected = true;
		});
		expect(protocolAdrViolations(extra)).toContain('semantic_contract');

		const missing = rewriteDecision(source, (decision) => {
			delete decision.authority;
		});
		expect(protocolAdrViolations(missing)).toContain('semantic_contract');

		const decision = protocolDecision(source);
		const reordered = Object.fromEntries([
			['decisionId', decision.decisionId],
			...Object.entries(decision).filter(([key]) => key !== 'decisionId'),
		]);
		const reorderedSource = replaceBlock(source, JSON.stringify(reordered, null, 2));
		expect(protocolAdrViolations(reorderedSource)).not.toContain('semantic_contract');
		expect(protocolAdrViolations(reorderedSource)).toContain('serialized_schema');
	});

	it('turns red for drift in rejects, timing, errors, surfaces and authority', () => {
		const source = readFileSync(ADR_PATH, 'utf8');
		const sabotages: Array<(decision: JsonObject) => void> = [
			(decision) => framing(decision).reject.pop(),
			(decision) => { framing(decision).maximumBufferedRecordBytes = 515; },
			(decision) => { framing(decision).recordDelivery = 'incremental_copy'; },
			(decision) => { timing(decision).helloTimeout = 1_999; },
			(decision) => channelErrors(decision).splice(0, 1),
			(decision) => token(decision).forbiddenSurfaces.push('clipboard'),
			(decision) => { token(decision).binding = 'hello_any_valid_token'; },
			(decision) => { authority(decision).source = 'mumble_v2'; },
		];
		for (const sabotage of sabotages) {
			const findings = protocolAdrViolations(rewriteDecision(source, sabotage));
			expect(findings).toContain('semantic_contract');
			expect(findings).toContain('semantic_hash');
			expect(findings).toContain('document_hash');
		}
		for (const surface of MUMBLE_V2_TRANSPORT_CONTRACT.tokenForbiddenSurfaces) {
			const findings = protocolAdrViolations(rewriteDecision(source, (decision) => {
				const surfaces = token(decision).forbiddenSurfaces;
				surfaces.splice(surfaces.indexOf(surface), 1);
			}));
			expect(findings, surface).toContain('semantic_contract');
		}
	});

	it('turns red for lifecycle phase, timeout and backoff-reset drift', () => {
		const source = readFileSync(ADR_PATH, 'utf8');
		const sabotages: Array<(decision: JsonObject) => void> = [
			(decision) => lifecycle(decision).phaseRecords.healthy.push('welcome'),
			(decision) => lifecycle(decision).phaseRecords.awaiting_first_sequenced.push('sample'),
			(decision) => { lifecycle(decision).timeouts[2]!.error = 'peer_closed'; },
			(decision) => lifecycle(decision).timeouts[5]!.deadlineRefreshesAfter.pop(),
			(decision) => { lifecycle(decision).backoffResetState = 'awaiting_welcome'; },
			(decision) => { lifecycle(decision).stdinEofAction = 'ignore'; },
			(decision) => { lifecycle(decision).failureRoutes[0]!.to = 'reconnect_wait'; },
			(decision) => lifecycle(decision).failureRoutes[2]!.fromStates.pop(),
		];
		for (const sabotage of sabotages) {
			expect(protocolAdrViolations(rewriteDecision(source, sabotage)))
				.toContain('semantic_contract');
		}
	});

	it('turns red for any weakening of exact slot cadence, warm-up or sample liveness', () => {
		const source = readFileSync(ADR_PATH, 'utf8');
		const sabotages: Array<(decision: JsonObject) => void> = [
			(decision) => { cadence(decision).recordsPerSlot = 2; },
			(decision) => { cadence(decision).recordChoice = 'heartbeat_and_sample'; },
			(decision) => { cadence(decision).sampleReplacesHeartbeat = false; },
			(decision) => { cadence(decision).sampleSatisfiesLiveness = false; },
			(decision) => { cadence(decision).heartbeatIntervalMeaning = 'heartbeat_only'; },
			(decision) => { cadence(decision).heartbeatHealthyStatusAllowed = true; },
			(decision) => { cadence(decision).warmingUpValidReadCount = 0; },
			(decision) => { cadence(decision).sourceHistoryOnDiscontinuity = 'retain'; },
			(decision) => { cadence(decision).sourceReadInput = 'activity_precomputed'; },
			(decision) => { cadence(decision).lateInvocationRecordMaximum = 120; },
			(decision) => { cadence(decision).missedSlotPolicy = 'catch_up'; },
			(decision) => { cadence(decision).nextSlotAfterLateInvocation = 'previous_plus_interval'; },
			(decision) => { cadence(decision).lateAfterHeartbeatTimeout = 'emit_anyway'; },
		];
		for (const sabotage of sabotages) {
			expect(protocolAdrViolations(rewriteDecision(source, sabotage)))
				.toContain('semantic_contract');
		}
	});
});

type JsonObject = Record<string, unknown>;

function protocolAdrViolations(source: string): string[] {
	const findings: string[] = [];
	if (source.split(BLOCK_START).length !== 2 || source.split(BLOCK_END).length !== 2) {
		return ['marker_count'];
	}
	let decision: JsonObject;
	try {
		decision = protocolDecision(source);
	} catch {
		return ['parse'];
	}
	const block = protocolBlock(source);
	if (canonicalJson(decision) !== canonicalJson(EXPECTED_PROTOCOL_DECISION)) {
		findings.push('semantic_contract');
	}
	if (block !== JSON.stringify(EXPECTED_PROTOCOL_DECISION, null, 2)) {
		findings.push('serialized_schema');
	}
	if (sha256(canonicalJson(decision)) !== EXPECTED_SEMANTIC_SHA256) {
		findings.push('semantic_hash');
	}
	if (sha256(source) !== EXPECTED_DOCUMENT_SHA256) findings.push('document_hash');
	return findings;
}

function protocolDecision(source: string): JsonObject {
	return JSON.parse(protocolBlock(source)) as JsonObject;
}

function protocolBlock(source: string): string {
	return source.split(BLOCK_START)[1]?.split(BLOCK_END)[0] ?? '';
}

function replaceBlock(source: string, block: string): string {
	const [before, rest = ''] = source.split(BLOCK_START);
	const [, after = ''] = rest.split(BLOCK_END);
	return `${before}${BLOCK_START}${block}${BLOCK_END}${after}`;
}

function rewriteDecision(source: string, mutate: (decision: JsonObject) => void): string {
	const decision = structuredClone(protocolDecision(source));
	mutate(decision);
	return replaceBlock(source, JSON.stringify(decision, null, 2));
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as JsonObject).sort(([left], [right]) =>
			left.localeCompare(right));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function framing(decision: JsonObject): {
	reject: unknown[];
	maximumBufferedRecordBytes: number;
	recordDelivery: string;
} {
	return decision.framing as {
		reject: unknown[];
		maximumBufferedRecordBytes: number;
		recordDelivery: string;
	};
}

function timing(decision: JsonObject): JsonObject {
	return decision.timingMs as JsonObject;
}

function cadence(decision: JsonObject): JsonObject {
	return decision.cadence as JsonObject;
}

function channelErrors(decision: JsonObject): unknown[] {
	return decision.channelErrors as unknown[];
}

function token(decision: JsonObject): { forbiddenSurfaces: unknown[]; binding: string } {
	return (decision.credentials as JsonObject).token as {
		forbiddenSurfaces: unknown[];
		binding: string;
	};
}

function authority(decision: JsonObject): JsonObject {
	return decision.authority as JsonObject;
}

function lifecycle(decision: JsonObject): {
	phaseRecords: { awaiting_first_sequenced: unknown[]; healthy: unknown[] };
	timeouts: Array<JsonObject & { deadlineRefreshesAfter: unknown[] }>;
	backoffResetState: string;
	stdinEofAction: string;
	failureRoutes: Array<{ to: string; fromStates: unknown[] }>;
} {
	return decision.lifecycle as {
		phaseRecords: { awaiting_first_sequenced: unknown[]; healthy: unknown[] };
		timeouts: Array<JsonObject & { deadlineRefreshesAfter: unknown[] }>;
		backoffResetState: string;
		stdinEofAction: string;
		failureRoutes: Array<{ to: string; fromStates: unknown[] }>;
	};
}
