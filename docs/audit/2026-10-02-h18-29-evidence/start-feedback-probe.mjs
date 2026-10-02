import assert from 'node:assert/strict';
import { createJiti } from '/home/fodaveg/code/tyrian-companion/node_modules/jiti/lib/jiti.mjs';
const jiti = createJiti(import.meta.url);
const root = '/home/fodaveg/code/tyrian-companion/src';
const { HostApiKeyProvider } = await jiti.import(`${root}/core/secret-provider.ts`);
const { GuildWars2Client } = await jiti.import(`${root}/account/guild-wars-2-client.ts`);
const { IngameSessionMarker } = await jiti.import(`${root}/sessions/ingame-session-marker.ts`);
const { ManualSessionStartService } = await jiti.import(`${root}/sessions/manual-session-start-service.ts`);
const { MemorySessionRuntimeStore } = await jiti.import(`${root}/sessions/session-runtime-store.ts`);
const now = Date.parse('2026-10-02T12:00:00Z');
const selection = 'synthetic-selection';
const provider = new HostApiKeyProvider({ list: () => [], get: () => null }, () => selection);
const client = new GuildWars2Client({ request: () => { throw new Error('Unexpected HTTP request'); } }, provider);
let attempts = 0;
let marker;
const stateChanges = [];
const capturedErrorClasses = [];
const markerErrorClasses = [];
const lease = { machineId: 'synthetic-machine', instanceId: 'synthetic-instance', sessionId: 'synthetic-session', fence: 1, acquiredAt: now, renewedAt: now, expiresAt: now + 30000 };
const service = new ManualSessionStartService({
  instanceId: 'synthetic-instance',
  acquire: async () => ({ status: 'acquired', handle: lease }),
  renew: async () => ({ status: 'renewed', handle: lease }),
  assertOwned: async () => ({ status: 'owned' }),
  release: async () => ({ status: 'released' }),
  dispose: () => {},
}, {
  capture: async () => {
    attempts += 1;
    try { client.beginOperation(); } catch (error) { capturedErrorClasses.push(error.name); throw error; }
    throw new Error('Expected missing credential');
  },
}, {
  runtimeStore: new MemorySessionRuntimeStore(), now: () => now, sessionId: () => lease.sessionId,
  setInterval: () => 1, clearInterval: () => {},
  onStateChange: () => { stateChanges.push(service.getState().status); if (marker) void marker.reconcile(); },
});
const presence = { status: 'present', presenceId: 'synthetic-presence', context: { character: 'Synthetic Character', labyrinth: false } };
marker = new IngameSessionMarker({
  now: () => now, presence: () => presence,
  port: {
    enabled: () => selection.trim().length > 0 && attempts < 5,
    session: () => { const state = service.getState(); return { status: state.status, sessionId: state.status === 'idle' ? null : state.sessionId, canStart: state.status === 'idle' }; },
    start: async (characterName) => { const result = await service.start({ characterName, magicFind: 1, consumablesBonus: 0 }); if (result.status === 'failed') throw new Error('Start failed.'); return result.state.sessionId; },
    stopAt: async () => {}, loadLink: () => null, saveLink: () => {},
    recordFailure: (error) => markerErrorClasses.push(error.name),
  },
});
await marker.reconcile();
await new Promise((resolve) => setImmediate(resolve));
marker.dispose();
await service.dispose();
assert.equal(attempts, 5);
assert.deepEqual(capturedErrorClasses, Array(5).fill('MissingApiKeyError'));
assert.equal(markerErrorClasses.length, 5);
console.log(JSON.stringify({ externalReconcileCalls: 1, attempts, configuredNameNonempty: true, providerHasSelection: provider.hasSelection(), missingCredentialClasses: capturedErrorClasses, markerFailureClasses: markerErrorClasses, stateChanges, limit: 'Node composition probe; no real Obsidian secret store, presence or runtime' }, null, 2));
