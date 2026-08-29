import { describe, expect, it, vi } from 'vitest';

import { afterSnapshot, looseHolding, storageDeltaSnapshot, walletCurrency } from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import { calculateSessionValuation, type SessionValuation } from '../economy/session-valuation';
import { unavailableSessionPriceSnapshot } from '../economy/session-price-snapshot';
import { buildReservationBalance, createReservationPlan, partitionSessionValuation } from '../economy/reservation';
import { HALLOWEEN_RELEVANT_ITEM_RULE_SET } from './assisted-detection-service';
import { createSessionContaminationReview } from './session-contamination-review';
import { createAcceptedDetectionEvent } from './session-detection-quality';
import type { SessionDetectionQualitySummary } from './session-detection-quality';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import { createSessionRuntimeRecord, type SessionRuntimeRecord } from './session-runtime-store';
import type { CompleteSessionState, SessionAuthority, SessionSnapshotReference } from './session';
import {
	prepareSessionNote,
	normalizeSessionOutputFolder,
	sessionNoteEventDeclarationFromDetectionSummary,
	type SessionNoteInput,
} from './session-note-model';
import { renderSessionNote } from './session-note-renderer';
import {
	SessionNoteWriter,
	writeSessionNoteBeforeClear,
	type SessionNoteFile,
	type SessionNoteVault,
} from './session-note-writer';

describe('session note model and renderer', () => {
	it('builds a deterministic UTC path, hashed references and stable frontmatter', async () => {
		const input = sessionInput();
		const prepared = prepareSessionNote(input);
		expect(prepared.status).toBe('ok');
		if (prepared.status !== 'ok') return;
		const first = await renderSessionNote(prepared.note);
		const second = await renderSessionNote(prepared.note);
		expect(first).toEqual(second);
		if (first.status !== 'ok') return;
		expect(first.note.preferredPath).toMatch(/^Tyrian Companion\/sessions\/2026\/2026-08-13 080001Z - [a-f0-9]{16}\.md$/u);
		expect(first.note.frontmatter).toMatchObject({
			tc_schema: 3, tc_kind: 'gw2_farming_session', tc_locale: 'es',
			tc_positive_item_deltas_json: '[[100,3]]',
			tc_event: null,
			tc_scope: 'observed_storage_net', tc_execution: 'manual_in_game', tc_side_effects: 'none',
			tc_observed_immediate_copper: null, tc_recommendation_status: 'not_evaluated',
			tc_recommendation_action: null, tc_recommendation_quantity: null, tc_recommendation_route: null,
		});
		expect(first.note.frontmatter.tc_session_ref).toMatch(/^[a-f0-9]{64}$/u);
		expect(first.note.content).not.toContain('session-sensitive-id');
		expect(first.note.content).not.toContain(input.runtime.finalSnapshot?.accountId);
		expect(first.note.content.match(/tyrian-companion:managed:start:/gu)).toHaveLength(6);
	});

	it('localizes note labels, provenance, activities and reason codes without changing tc enums', async () => {
		for (const [locale, expected] of [
			['es', ['Clasificación: Exacta', 'Confianza: Alta', 'Abrir contenedores', 'El delta está limitado.', 'Núcleo y entrega', 'Precios del bazar de Guild Wars 2']],
			['en', ['Classification: Exact', 'Confidence: High', 'Open containers', 'The delta is limited.', 'Core and delivery', 'Guild Wars 2 Trading Post prices']],
		] as const) {
			const input = sessionInput('exact', locale);
			const prepared = prepareSessionNote(input);
			if (prepared.status !== 'ok') throw new Error('Invalid prepared fixture.');
			prepared.note.runtime.review.answers.activities.open = true;
			prepared.note.runtime.review.classification.reasons = [{ code: 'delta_limited' }];
			const result = await renderSessionNote(prepared.note);
			if (result.status !== 'ok') throw new Error('Render failed.');
			for (const copy of expected) expect(result.note.content).toContain(copy);
			expect(result.note.content).not.toContain('delta_limited');
			expect(result.note.content).not.toContain('core_only');
			expect(result.note.content).not.toContain('gw2-commerce-prices');
			expect(result.note.frontmatter).toMatchObject({ tc_classification: 'exact', tc_confidence: 'high' });
		}
	});

	it('traces an unreadable character to the note without naming it', async () => {
		for (const [locale, expected] of [
			['es', 'No se pudo leer el inventario de un personaje; queda fuera del delta.'],
			['en', 'One character inventory could not be read and is out of the delta.'],
		] as const) {
			const input = sessionInput('exact', locale);
			const prepared = prepareSessionNote(input);
			if (prepared.status !== 'ok') throw new Error('Invalid prepared fixture.');
			prepared.note.runtime.review.classification.reasons = [{ code: 'character_unobserved' }];
			const result = await renderSessionNote(prepared.note);
			if (result.status !== 'ok') throw new Error('Render failed.');

			expect(result.note.content).toContain(expected);
			expect(result.note.content).not.toContain('character_unobserved');
			expect(result.note.content).not.toContain('Astra Dos');
		}
	});

	it('records only an explicit validated event and never infers it from session evidence', async () => {
		const plain = sessionInput();
		expect((await rendered(plain)).frontmatter.tc_event).toBeNull();
		expect((await rendered(plain)).frontmatter.tc_event_source).toBeNull();
		plain.eventDeclaration = { event: 'halloween', source: 'manual_explicit', declaredAt: '2026-08-13T08:30:00.000Z' };
		expect((await rendered(plain)).frontmatter).toMatchObject({ tc_event: 'halloween', tc_event_source: 'manual_explicit' });
		expect(prepareSessionNote({ ...plain, eventDeclaration: { event: 'halloween', source: 'manual_explicit' } }))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
		const proposal = halloweenProposal();
		const accepted = createAcceptedDetectionEvent('start', 'session-sensitive-id', '2026-08-13T08:00:03.000Z', proposal);
		if (!accepted) throw new Error('Invalid assisted event fixture.');
		const summary = {
			version: 1, sessionId: 'session-sensitive-id', mode: 'assisted', stop: null,
			correctedFalsePositives: [], totalUncertaintyMs: 1, start: accepted,
		} satisfies SessionDetectionQualitySummary;
		expect(sessionNoteEventDeclarationFromDetectionSummary('session-sensitive-id', summary)).toMatchObject({
			event: 'halloween', source: 'assisted', accepted: { proposalId: proposal.proposalId },
		});
		expect(sessionNoteEventDeclarationFromDetectionSummary('other-session', summary)).toBeNull();
		for (const changed of [
			{ ...proposal, proposalId: `x${proposal.proposalId}` },
			{ ...proposal, proposalId: `${proposal.proposalId}:suffix` },
			{ ...proposal, ruleSet: { ...proposal.ruleSet, version: 2 } },
		]) {
			const event = { ...accepted, proposalId: changed.proposalId, startProposal: changed };
			expect(sessionNoteEventDeclarationFromDetectionSummary('session-sensitive-id', { ...summary, start: event })).toBeNull();
		}
		for (const changed of [
			{ ...proposal, firstSignal: { ...proposal.firstSignal, gains: [{ itemId: HALLOWEEN_RELEVANT_ITEM_RULE_SET.itemIds[0]! + 1, quantity: 1 }] } },
			{ ...proposal, confirmationSignal: { ...proposal.confirmationSignal, gains: [{ itemId: HALLOWEEN_RELEVANT_ITEM_RULE_SET.itemIds[0]! + 1, quantity: 1 }] } },
		]) {
			const event = { ...accepted, startProposal: changed };
			expect(sessionNoteEventDeclarationFromDetectionSummary('session-sensitive-id', { ...summary, start: event })).toBeNull();
			expect(prepareSessionNote({
				...sessionInput(), eventDeclaration: { event: 'halloween', source: 'assisted', accepted: event },
			})).toEqual({ status: 'invalid', reason: 'invalid_input' });
		}
		expect(prepareSessionNote({
			...sessionInput(), eventDeclaration: { event: 'halloween', source: 'assisted', accepted: { ...accepted, sessionId: 'other' } },
		})).toEqual({ status: 'invalid', reason: 'invalid_input' });
	});

	it('redacts valuation by classification permission and shows valid exact values', async () => {
		const exact = sessionInput('exact', 'en');
		exact.valuation = valuation(exact.runtime);
		const renderedExact = await rendered(exact);
		expect(renderedExact.frontmatter.tc_observed_immediate_copper).toBeTypeOf('number');
		expect(renderedExact.content).toContain('Observed economy');
		expect(renderedExact.content).toContain('Liquidation net');

		const contaminated = sessionInput('contaminated');
		contaminated.valuation = valuation(contaminated.runtime);
		const renderedContaminated = await rendered(contaminated);
		expect(renderedContaminated.frontmatter.tc_observed_immediate_copper).toBeNull();
		expect(renderedContaminated.content).toContain('La actividad externa impide atribuir valor');
		expect(renderedContaminated.content).toContain('Contaminada');
	});

	it('degrades malformed optional economics without blocking valid runtime', () => {
		const input = sessionInput();
		input.valuation = { sessionId: 'session-sensitive-id' } as SessionValuation;
		expect(prepareSessionNote(input)).toMatchObject({ status: 'ok', note: { valuation: { status: 'invalid' } } });
	});

	it('degrades malformed recommendation internals and envelope mismatch without throwing', () => {
		const input = sessionInput();
		input.recommendation = {
			status: 'blocked', reasons: [{ code: 'price_missing' }],
			recommendation: { reasons: null }, envelope: { decisions: null },
		} as never;
		input.envelope = { version: 1, kind: 'recommendation' } as never;
		expect(prepareSessionNote(input)).toMatchObject({
			status: 'ok',
			note: { recommendation: { status: 'invalid' }, envelope: { status: 'invalid' } },
		});
		return rendered(input).then((note) => {
			expect(note.frontmatter).toMatchObject({
				tc_recommendation_status: 'invalid', tc_recommendation_action: null,
				tc_recommendation_quantity: null, tc_recommendation_route: null,
			});
		});
	});

	it('rejects a reservation overlay that cannot be reproduced from valuation, delta and plan', () => {
		const input = sessionInput();
		input.valuation = valuation(input.runtime);
		const balance = buildReservationBalance(input.runtime.finalSnapshot);
		if (balance.status !== 'ok') throw new Error('Invalid balance fixture.');
		const plan = createReservationPlan({ goals: [], balance: balance.balance });
		if (plan.status !== 'ok') throw new Error('Invalid plan fixture.');
		const overlay = partitionSessionValuation({
			valuation: input.valuation,
			delta: input.runtime.delta,
			plan: plan.plan,
			sackItemIds: [],
		});
		if (overlay.status !== 'ok') throw new Error('Invalid overlay fixture.');
		input.reservation = { plan: plan.plan, overlay: structuredClone(overlay.overlay) };
		const line = input.reservation.overlay.lines[0];
		if (!line || line.protectedFromLiquidation === null) throw new Error('Invalid overlay line fixture.');
		line.protectedFromLiquidation += 1;
		expect(prepareSessionNote(input)).toMatchObject({
			status: 'ok', note: { reservation: { status: 'invalid' } },
		});
	});

	it('blocks identity mismatch and unsafe output paths', () => {
		const input = sessionInput();
		input.valuation = { sessionId: 'another-session' } as SessionValuation;
		expect(prepareSessionNote(input)).toEqual({ status: 'invalid', reason: 'identity_mismatch' });
		for (const path of ['', '/absolute', 'C:/absolute', 'a//b', 'a/../b', 'a\\b', `a/.${'obsidian'}/b`, 'a/b.', 'a/b ', 'a/b:c', 'a/\0b', 'a/\u0001b', 'a/CON', 'a/COM1.md', `a/${'b'.repeat(121)}`, 'a'.repeat(129)]) {
			expect(normalizeSessionOutputFolder(path), path).toBeNull();
		}
		expect(normalizeSessionOutputFolder('Tyrian Companion/Sesiones')).toBe('Tyrian Companion/Sesiones');
	});

	it('escapes hostile names, yaml, tables, links and managed-marker text', async () => {
		const input = sessionInput();
		input.displayNames = { 'item:100': ']| x\n<!-- tyrian-companion:managed:end:summary -->' };
		const note = await rendered(input);
		expect(note.content).not.toContain('\n<!-- tyrian-companion:managed:end:summary -->\n|');
		expect(note.content).toContain('&lt;\\!--');
		expect(note.content).toContain('\\|');
	});
});

describe('SessionNoteWriter', () => {
	it('rejects an unknown credential field before any Vault write', async () => {
		const credential = ['tyrian-h6', 'note-probe', 'not-a-credential'].join('-');
		const vault = new MemoryVault();
		const input = { ...sessionInput(), apiKey: credential };

		await expect(new SessionNoteWriter(vault).write(input)).resolves.toEqual({
			status: 'invalid',
			reason: 'invalid_input',
		});
		expect(vault.createCalls).toBe(0);
		expect([...vault.contents.values()].join('\n')).not.toContain(credential);
	});

	it('is byte-idempotent and preserves human frontmatter, tags and notes', async () => {
		const vault = new MemoryVault();
		const writer = new SessionNoteWriter(vault);
		const input = sessionInput();
		const created = await writer.write(input);
		expect(created.status).toBe('written');
		if (created.status !== 'written') return;
		const original = vault.contents.get(created.path)!;
		const human = original.replace('---\n', '---\naliases: [farm]\ntags: [personal]\ndescripcion: "Mi descripción"\n') + '\nTexto humano.\n';
		vault.contents.set(created.path, human);
		expect((await writer.write(input)).status).toBe('written');
		const merged = vault.contents.get(created.path)!;
		expect(merged).toContain('aliases: [farm]');
		expect(merged).toContain('"personal"');
		expect(merged).toContain('descripcion: "Mi descripción"');
		expect(merged).toContain('Texto humano.');
		const processCalls = vault.processCalls;
		expect((await writer.write(input)).status).toBe('unchanged');
		expect(vault.processCalls).toBe(processCalls + 1);
		expect(vault.contents.get(created.path)).toBe(merged);
	});

	it('fails closed for tampered, duplicate or out-of-order managed markers', async () => {
		for (const mutate of [
			(content: string) => content.replace('## Resumen', '## Resumen alterado'),
			(content: string) => `${content}\n<!-- tyrian-companion:managed:start:summary sha256=${'0'.repeat(64)} -->\nx\n<!-- tyrian-companion:managed:end:summary -->`,
			(content: string) => content.replace('managed:start:summary', 'managed:start:evidence'),
		]) {
			const vault = new MemoryVault();
			const writer = new SessionNoteWriter(vault);
			const created = await writer.write(sessionInput());
			if (created.status !== 'written') throw new Error('Fixture note was not written.');
			vault.contents.set(created.path, mutate(vault.contents.get(created.path)!));
			await expect(writer.write(sessionInput())).resolves.toMatchObject({ status: 'conflict' });
		}
	});

	it('uses the full hash on a 16-character prefix collision and never overwrites', async () => {
		const vault = new MemoryVault();
		const input = sessionInput();
		const note = await rendered(input);
		await vault.createFolder(note.preferredPath.slice(0, note.preferredPath.lastIndexOf('/')));
		await vault.create(note.preferredPath, '---\ntc_session_ref: "different"\n---\nHuman note\n');
		const result = await new SessionNoteWriter(vault).write(input);
		expect(result).toEqual({ status: 'written', path: note.collisionPath });
		expect(vault.contents.get(note.preferredPath)).toContain('Human note');
	});

	it('coalesces concurrent writes for one session into one note', async () => {
		const vault = new MemoryVault();
		const writer = new SessionNoteWriter(vault);
		const results = await Promise.all([writer.write(sessionInput()), writer.write(sessionInput())]);
		expect(results[0]).toEqual(results[1]);
		expect(vault.createCalls).toBe(1);
	});

	it('retries an atomic update and preserves a human edit interleaved after its read', async () => {
		const vault = new MemoryVault();
		const writer = new SessionNoteWriter(vault);
		const created = await writer.write(sessionInput());
		if (created.status !== 'written') throw new Error('Fixture note was not written.');
		vault.beforeProcess = (path) => {
			vault.contents.set(path, `${vault.contents.get(path)!}\nInterleaved human edit.\n`);
		};
		const updated = sessionInput('exact', 'en');
		await expect(writer.write(updated)).resolves.toMatchObject({ status: 'written' });
		expect(vault.contents.get(created.path)).toContain('Interleaved human edit.');
		expect(vault.contents.get(created.path)).toContain('## Summary');
	});

	it('verifies byte-identical output through process and preserves a concurrent human edit', async () => {
		const vault = new MemoryVault();
		const writer = new SessionNoteWriter(vault);
		const input = sessionInput();
		const created = await writer.write(input);
		if (created.status !== 'written') throw new Error('Fixture note was not written.');
		vault.beforeProcess = (path) => {
			vault.contents.set(path, `${vault.contents.get(path)!}\nConcurrent note.\n`);
		};
		await expect(writer.write(input)).resolves.toMatchObject({ status: 'written' });
		expect(vault.contents.get(created.path)).toContain('Concurrent note.');
	});

	it('fails closed when a byte-identical update races with managed-block tampering', async () => {
		const vault = new MemoryVault();
		const writer = new SessionNoteWriter(vault);
		const input = sessionInput();
		const created = await writer.write(input);
		if (created.status !== 'written') throw new Error('Fixture note was not written.');
		vault.beforeProcess = (path) => {
			vault.contents.set(path, vault.contents.get(path)!.replace('## Resumen', '## Resumen manipulado'));
		};
		const clear = vi.fn(async () => true);
		await expect(writeSessionNoteBeforeClear(writer, input, clear)).resolves.toBe(false);
		expect(clear).not.toHaveBeenCalled();
		expect(vault.contents.get(created.path)).toContain('## Resumen manipulado');
	});

	it('prevents clear when Vault write fails', async () => {
		const clear = vi.fn(async () => true);
		const writer = { write: vi.fn(async () => ({ status: 'unavailable' as const, message: 'failed' })) };
		await expect(writeSessionNoteBeforeClear(writer, sessionInput(), clear)).resolves.toBe(false);
		expect(clear).not.toHaveBeenCalled();
	});
});

class MemoryVault implements SessionNoteVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	createCalls = 0;
	processCalls = 0;
	beforeProcess: ((path: string) => void) | null = null;
	file(path: string): SessionNoteFile | null {
		return this.contents.has(path) || this.folders.has(path) ? { path } : null;
	}
	async read(file: SessionNoteFile): Promise<string> {
		const value = this.contents.get(file.path);
		if (value === undefined) throw new Error('not a file');
		return value;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<SessionNoteFile> {
		if (this.file(path)) throw new Error('exists');
		this.createCalls += 1;
		this.contents.set(path, content);
		return { path };
	}
	async process(file: SessionNoteFile, update: (content: string) => string): Promise<string> {
		this.processCalls += 1;
		this.beforeProcess?.(file.path);
		this.beforeProcess = null;
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error('not a file');
		const next = update(current);
		this.contents.set(file.path, next);
		return next;
	}
}

async function rendered(input: SessionNoteInput) {
	const prepared = prepareSessionNote(input);
	if (prepared.status !== 'ok') throw new Error(`Invalid fixture: ${prepared.reason}`);
	const result = await renderSessionNote(prepared.note);
	if (result.status !== 'ok') throw new Error(`Render failed: ${result.reason}`);
	return result.note;
}

function sessionInput(classification: 'exact' | 'contaminated' = 'exact', locale: 'es' | 'en' = 'es'): SessionNoteInput {
	return {
			runtime: completeRuntime(classification), valuation: null, reservation: null, hold: null,
		recommendation: null, envelope: null, eventDeclaration: null, displayNames: { 'item:100': 'Objeto de prueba' },
		locale, outputFolder: 'Tyrian Companion',
	};
}

function halloweenProposal(): RelevantStartProposal {
	const ruleSet = { id: 'halloween.trick-or-treat-bag', version: 1 };
	const firstSignal = {
		accountId: 'account-anonymous', beforeSnapshotId: 'halloween-before', afterSnapshotId: 'halloween-middle',
		window: { from: '2026-08-13T08:00:00.000Z', to: '2026-08-13T08:00:01.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }],
	};
	const confirmationSignal = {
		accountId: 'account-anonymous', beforeSnapshotId: 'halloween-middle', afterSnapshotId: 'halloween-after',
		window: { from: '2026-08-13T08:00:01.000Z', to: '2026-08-13T08:00:02.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }],
	};
	return {
		version: 1,
		proposalId: `relevant-start:${ruleSet.id}:${String(ruleSet.version)}:${firstSignal.beforeSnapshotId}:${confirmationSignal.afterSnapshotId}`,
		accountId: 'account-anonymous', ruleSet,
		possibleStart: { ...firstSignal.window, uncertaintyMs: 1_000 },
		evidenceQuality: 'complete', confirmedAt: confirmationSignal.window.to,
		firstSignal, confirmationSignal,
	};
}

function completeRuntime(classification: 'exact' | 'contaminated'): SessionRuntimeRecord {
	const baseline = storageDeltaSnapshot();
	const final = afterSnapshot({
		holdings: [looseHolding(100, 5, { source: 'bank', slot: 0 })],
		currencies: [walletCurrency(1, 150)],
	});
	const delta = compareStorageSnapshots(baseline, final);
	const activities = {
		open: classification === 'contaminated', salvage: false, consume: false, craft: false,
		tpBuy: false, tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
	};
	const review = createSessionContaminationReview(
		baseline, final, delta, { certainty: 'confirmed', activities }, '2026-08-13T09:00:02.000Z',
	);
	if (!review || review.classification.status !== classification) throw new Error('Invalid review fixture.');
	const state: CompleteSessionState = {
		version: 1, status: 'complete', sessionId: 'session-sensitive-id', authority,
		requestedAt: '2026-08-13T07:59:59.000Z', baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] },
					{ id: 52, traits: [4, 5, 6] },
					{ id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: '2026-08-13T08:59:59.000Z', stoppedAt: '2026-08-13T08:59:59.000Z',
		finalSnapshot: reference(final), finalizedAt: '2026-08-13T09:00:02.000Z', classification,
	};
	const prices = unavailableSessionPriceSnapshot(state.sessionId, delta, Date.parse(final.completedAt));
	const record = createSessionRuntimeRecord(state, baseline, final, delta, Date.parse(state.finalizedAt), review, prices);
	if (!record) throw new Error('Invalid runtime fixture.');
	return record;
}

function valuation(runtime: SessionRuntimeRecord): SessionValuation {
	const result = calculateSessionValuation({
		sessionId: runtime.state.status === 'complete' ? runtime.state.sessionId : '', delta: runtime.delta,
		prices: runtime.priceSnapshot, catalogItems: {}, bindingByItem: { '100': 'unknown' },
		durationMs: Date.parse(runtime.state.status === 'complete' ? runtime.state.finalSnapshot.completedAt : '') -
			Date.parse(runtime.state.status === 'complete' ? runtime.state.baseline.completedAt : ''),
		sackItemIds: [],
	});
	if (result.status !== 'ok') throw new Error(`Invalid valuation fixture: ${result.reason}`);
	return result.valuation;
}

function reference(snapshot: ReturnType<typeof storageDeltaSnapshot>): SessionSnapshotReference {
	return {
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt, quality: snapshot.quality as 'stable',
	};
}

const authority: SessionAuthority = {
	machineId: 'machine', instanceId: 'instance', sessionId: 'session-sensitive-id', fence: 1,
	acquiredAt: Date.parse('2026-08-13T07:59:58.000Z'),
};
