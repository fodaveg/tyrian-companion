import { describe, expect, it, vi } from 'vitest';

import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import type { IngameSessionMarker } from '../sessions/ingame-session-marker';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import { IngameSessionRuntime, type IngameSessionRuntimePort } from './ingame-session-runtime';

/**
 * DE-01, ninth wave: `IngameSessionRuntime` on its own, over a port of plain fakes that hold only
 * what each case reads. The core's side (its delegates, the sibling ports that reach
 * it, the marker written back to the core's field) is `src/main-ingame-session-runtime-wiring.test.ts`;
 * the marker's whole start and stop over the real core is `src/main-ingame-session-start.test.ts`.
 */

/** A port over plain fakes; `overrides` replaces any member. */
function port(overrides: Partial<Record<keyof IngameSessionRuntimePort, unknown>> = {}): IngameSessionRuntimePort & { events: unknown[] } {
	const events: unknown[] = [];
	const base = {
		events,
		settings: { alertIngameEnabled: true },
		runtimeReady: true,
		collectorMode: 'collector' as const,
		host: {},
		localDebugActions: { run: vi.fn(), event: (context: unknown) => { events.push(context); } },
		sessionHistoryRuntimeAuthority: { runtimeMutationAllowed: () => true },
		sessions: {
			getState: () => ({ status: 'idle' }),
			getRecoveryState: () => ({ status: 'none' }),
			initialize: vi.fn(async () => undefined),
			getPreservedLegacyRuntime: () => null,
			preserveLegacyForLiveMigration: vi.fn(async () => true),
		},
		liveSessions: null,
		ingameSessionMarker: null,
		getIngamePresence: () => ({ status: 'absent', context: null }),
		onIngamePresence: () => () => undefined,
		renderViews: () => undefined,
	};
	return { ...base, ...overrides } as unknown as IngameSessionRuntimePort & { events: unknown[] };
}

const presence = (snapshot: Record<string, unknown>): (() => IngamePresenceSnapshot) => () => snapshot as unknown as IngamePresenceSnapshot;

/** A finished session stopped at `stoppedAt`; only the fields the declaration reads. */
function finished(stoppedAt: string): SessionRuntimeRecord {
	return { state: { status: 'complete', sessionId: 'session-a', stoppedAt } } as unknown as SessionRuntimeRecord;
}

const marker = (labyrinthAt: string | null): IngameSessionMarker =>
	({ labyrinthObservedAt: (sessionId: string) => (sessionId === 'session-a' ? labyrinthAt : null) }) as unknown as IngameSessionMarker;

describe('what the advisor and the note read from the presence', () => {
	it.each([
		['a character in the world', { status: 'present', context: { state: 'gameplay', character: 'Astra Uno' } }, 'Astra Uno'],
		['the character select screen', { status: 'present', context: { state: 'character_select', character: 'Astra Uno' } }, null],
		['a lost connection', { status: 'lost', context: { state: 'gameplay', character: 'Astra Uno' } }, null],
	])('the storage character for %s', (_case, snapshot, expected) => {
		const runtime = new IngameSessionRuntime(port({ getIngamePresence: presence(snapshot) }));
		expect(runtime.storageCharacterFromIngame()).toBe(expected);
	});

	it.each([
		['the Labyrinth seen before the stop', marker('2026-10-11T10:00:00.000Z'),
			{ event: 'halloween', source: 'ingame_presence', observedAt: '2026-10-11T10:00:00.000Z' }],
		['the Labyrinth seen only after the stop', marker('2026-10-11T12:00:00.000Z'), null],
		['no Labyrinth seen', marker(null), null],
		['no marker at all', null, null],
	])('the note\'s event declaration with %s', (_case, ingameSessionMarker, expected) => {
		const runtime = new IngameSessionRuntime(port({ ingameSessionMarker }));
		expect(runtime.ingameLabyrinthDeclaration(finished('2026-10-11T11:00:00.000Z'))).toEqual(expected);
	});
});

describe('the session the marker sees', () => {
	it.each([
		['nothing saved', { status: 'none' }, true],
		['a saved session that can be taken', { status: 'available' }, true],
		// Z2-2: a store that did not answer says nothing about what is saved; the start asks it again.
		['a store that did not answer', { status: 'error', code: 'unavailable' }, true],
		['a corrupt record', { status: 'error', code: 'corrupt' }, false],
	])('an idle manual service with %s answers whether a start may go on', (_case, recovery, canStart) => {
		const fake = port();
		const runtime = new IngameSessionRuntime(port({ sessions: { ...fake.sessions, getRecoveryState: () => recovery } }));
		expect(runtime.ingameSessionView()).toEqual({ status: 'idle', sessionId: null, canStart });
	});
});

describe('the link in the host\'s local storage', () => {
	it('a save the storage refuses is recorded by error class only, and a host without the storage keeps nothing', () => {
		const save = vi.fn(() => { throw new RangeError('quota exceeded for tyrian-companion:ingame-session-link'); });
		const refused = port({ host: { localStorage: { load: () => null, save } } });
		const runtime = new IngameSessionRuntime(refused);
		(runtime as unknown as { writeIngameSessionLink(link: null): void }).writeIngameSessionLink(null);
		expect(save).toHaveBeenCalledWith('tyrian-companion:ingame-session-link', null);
		expect(refused.events).toEqual([{
			component: 'session', action: 'session_start', state: 'ingame_presence',
			level: 'error', phase: 'failure', code: 'internal_failure', details: { reason: 'RangeError' },
		}]);

		const without = port();
		expect((new IngameSessionRuntime(without) as unknown as { readIngameSessionLink(): unknown }).readIngameSessionLink()).toBeNull();
		expect(without.events).toEqual([]);
	});
});
