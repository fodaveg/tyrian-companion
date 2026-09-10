import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { classMemberNames, moduleBoundaryFacts, moduleSpecifiers, propertyCallChains, referencedNames } from '../test/module-boundary';

const inventoryAdvisorFiles = (directory: string) => readdirSync(directory)
	.filter((file) => file.startsWith('inventory-advisor-')
		&& file.endsWith('.ts') && !file.endsWith('.test.ts'))
	.map((file) => ({ file, path: `${directory}/${file}` }));

const INVENTORY_ADVISOR_FILES = [
	...inventoryAdvisorFiles('src/advisor'),
	...inventoryAdvisorFiles('src/ui'),
	{ file: 'inventory-equipment-economy.ts', path: 'src/advisor/inventory-equipment-economy.ts' },
	{ file: 'inventory-sync-panel-view.ts', path: 'src/ui/inventory-sync-panel-view.ts' },
	{ file: 'price-history-panel-view.ts', path: 'src/ui/price-history-panel-view.ts' },
].sort((left, right) => left.path.localeCompare(right.path));

const PRESENTATION_DOMAIN_ALLOWLIST = new Set([
	'src/advisor/inventory-advisor-classifier-model.ts',
	'src/advisor/inventory-advisor-classifier.ts',
	'src/advisor/inventory-advisor-contract.ts',
	'src/advisor/inventory-advisor-market.ts',
	'src/advisor/inventory-advisor-model.ts',
	'src/advisor/inventory-advisor-presentation-model.ts',
	'src/advisor/inventory-advisor-presentation.ts',
	'src/advisor/inventory-advisor-result.ts',
	'src/advisor/inventory-equipment-economy.ts',
	'src/ui/inventory-advisor-controller.ts',
	'src/ui/inventory-advisor-view-model.ts',
	'src/ui/inventory-sync-panel-view.ts',
	'src/ui/price-history-panel-view.ts',
]);

const PRESENTATION_FILES = INVENTORY_ADVISOR_FILES
	.filter(({ path }) => PRESENTATION_DOMAIN_ALLOWLIST.has(path));

const BOUNDARY_POLICIES = new Map<string, { imports: string[]; portCalls: string[] }>([
	['src/advisor/inventory-advisor-presentation.ts', {
		imports: ['../economy/gw2-fees', './inventory-advisor-result', './inventory-advisor-discard',
			'./inventory-advisor-classifier-model', './inventory-advisor-discard-model', './inventory-advisor-model',
			'./inventory-advisor-presentation-model', '../economy/item-liquidity', '../economy/reservation',
			'./inventory-container-economy', '../economy/commerce-listings', './inventory-equipment-economy'],
		portCalls: [],
	}],
	['src/advisor/inventory-equipment-economy.ts', {
		imports: ['../economy/equipment-salvage-economy', '../economy/item-liquidity',
			'./inventory-advisor-contract', './inventory-advisor-classifier-model', './inventory-advisor-model'],
		portCalls: [],
	}],
	['src/advisor/inventory-advisor-workflow.ts', {
		imports: ['./inventory-advisor-evidence-model', './inventory-advisor-evidence-contract', './inventory-advisor-classifier',
			'./inventory-advisor-classifier-model', './inventory-advisor-discard', './inventory-advisor-model',
			'../economy/reservation-model', './inventory-advisor-presentation', '../catalog/public-catalog-model',
			'./inventory-advisor-builtin-bundle', './inventory-container-economy', '../economy/container-personal-valuation',
			'../economy/equipment-salvage-economy', '../economy/models/equipment-salvage-policy',
			'../economy/commerce-listings', '../core/local-debug-action-runner'],
		portCalls: ['ports.capture.capture', 'ports.now', 'ports.preferences.load', 'ports.rules.current', 'provider.load'],
	}],
	['src/ui/inventory-advisor-item-view.ts', {
		imports: ['obsidian', '../core/i18n', '../advisor/inventory-advisor-model', '../advisor/inventory-preferences-runtime',
			'../economy/reservation-model', '../economy/price-history-model', '../economy/price-history-runtime',
			'../economy/price-seed-panel-service', '../economy/sell-signal-runtime',
			'./inventory-advisor-view-model', './inventory-advisor-view', './price-history-panel-view',
			'./inventory-vault-sync-run-controller', './product-action-controller', './product-shell'],
			portCalls: ['actions.getInventoryAdvisorLocale', 'actions.getInventoryAdvisorViewModel',
				'actions.createInventoryPreferencesEditorSession', 'preferenceSession.current', 'preferenceSession.load',
				'preferenceSession.upsertGoal', 'preferenceSession.removeGoal', 'preferenceSession.upsertKeepException', 'preferenceSession.removeKeepException',
				'actions.getInventoryVaultSyncRunState', 'actions.hasManagedAssetsRoot', 'actions.refreshInventoryAdvisor',
				'actions.runInventoryVaultSync', 'actions.confirmInventoryVaultSync', 'actions.cancelInventoryVaultSync',
				'actions.getPriceHistoryState', 'actions.enablePriceHistory', 'actions.loadPriceHistorySeries',
				'actions.resolvePriceHistoryItemCatalog', 'actions.getPriceHistorySeedState', 'actions.getSellSignalState',
				'actions.getProductActionController', 'actions.hasConfiguredApiKey', 'actions.openProductSettings'],
	}],
	['src/ui/inventory-advisor-view.ts', {
		imports: ['obsidian', '../core/i18n', '../advisor/inventory-advisor-model', '../advisor/inventory-preferences-runtime',
			// H13.2: type-only, for the decision union the economy layer owns. The
			// view maps its `hold` onto the existing `keep` label and calls nothing.
			'../advisor/inventory-container-economy',
			'../economy/reservation-model', '../economy/sell-signal-runtime', './inventory-advisor-view-model',
			'./inventory-vault-sync-run-controller', './inventory-sync-panel-view', './price-history-panel-view',
			'./sell-signal-line'],
		portCalls: [],
	}],
	['src/ui/inventory-sync-panel-view.ts', {
		imports: ['../core/i18n', './inventory-vault-sync-controller', './inventory-vault-sync-run-controller'],
		portCalls: [],
	}],
	['src/ui/price-history-panel-view.ts', {
		imports: ['../core/i18n', '../economy/price-history-runtime', '../economy/price-history-model',
			'../economy/price-seed-panel-service', '../economy/price-seed-model',
			'./format-time', './price-history-chart-view', './price-history-svg'],
		portCalls: [],
	}],
]);

const FORBIDDEN_ITEM_OPERATIONS = ['destroyItem', 'deleteItem', 'salvageItem', 'openContainer'];
const CAPABILITY_STEMS = ['executor', 'gateway', 'client', 'store', 'timer', 'capture'];
const CAPABILITY_SUFFIXES = ['Executor', 'Gateway', 'Client', 'Store', 'Timer', 'Capture'];
// `this.ports.X()`/`this.actions.X()`/`this.preferenceSession.X()` only count with the explicit
// `this.` prefix: a local DOM element a renderer happens to name `actions` is not the actions
// port. `provider.X()` counts either way, since nothing else in this codebase is named `provider`.
const THIS_ROOTED_PORT_CALL_RECEIVERS = new Set(['ports', 'actions', 'preferenceSession']);

describe('H5.11 inventory advisor presentation boundary', () => {
	it('censuses the complete presentation surface and keeps it review-only', () => {
		expect(INVENTORY_ADVISOR_FILES.map(({ path }) => path)).toEqual([
			'src/advisor/inventory-advisor-builtin-bundle.ts',
			'src/advisor/inventory-advisor-classifier-model.ts',
			'src/advisor/inventory-advisor-classifier.ts',
			'src/advisor/inventory-advisor-contract.ts',
			'src/advisor/inventory-advisor-discard-model.ts',
			'src/advisor/inventory-advisor-discard.ts',
			'src/advisor/inventory-advisor-evidence-contract.ts',
			'src/advisor/inventory-advisor-evidence-model.ts',
			'src/advisor/inventory-advisor-evidence.ts',
			'src/advisor/inventory-advisor-market.ts',
			'src/advisor/inventory-advisor-model.ts',
			'src/advisor/inventory-advisor-presentation-model.ts',
			'src/advisor/inventory-advisor-presentation.ts',
			'src/advisor/inventory-advisor-result.ts',
			'src/advisor/inventory-advisor-workflow.ts',
			'src/advisor/inventory-equipment-economy.ts',
			'src/ui/inventory-advisor-controller.ts',
			'src/ui/inventory-advisor-item-view.ts',
			'src/ui/inventory-advisor-view-model.ts',
			'src/ui/inventory-advisor-view.ts',
			'src/ui/inventory-sync-panel-view.ts',
			'src/ui/price-history-panel-view.ts',
		]);
		expect(PRESENTATION_FILES.map(({ path }) => path)).toEqual([...PRESENTATION_DOMAIN_ALLOWLIST].sort());
		for (const { path } of PRESENTATION_FILES) {
			const facts = moduleBoundaryFacts(path);
			for (const specifier of facts.specifiers) {
				expect(forbiddenDependency(specifier), `${path} imports forbidden dependency ${specifier}`).toBe(false);
			}
			for (const operation of FORBIDDEN_ITEM_OPERATIONS) {
				expect(facts.names.has(operation), `${path} performs an irreversible item operation ${operation}`).toBe(false);
			}
			for (const member of facts.classMemberNames) {
				expect(isForbiddenCapabilityMemberName(member), `${path} declares a forbidden capability ${member}`).toBe(false);
			}
		}
	});

	it('censuses the explicit integration capabilities the controller may reach for', () => {
		const controller = PRESENTATION_FILES.find(({ file }) => file === 'inventory-advisor-controller.ts');
		if (controller === undefined) throw new Error('Missing inventory-advisor-controller.ts in the presentation census.');
		const calls = knownPortCalls(moduleBoundaryFacts(controller.path).propertyCallChains);
		expect(calls.sort()).toEqual(['ports.dispose', 'ports.invalidate', 'ports.load', 'ports.reclassify']);
	});

	it('guards workflow, presentation, ItemView and renderer with per-file import and capability allowlists', () => {
		for (const [path, policy] of BOUNDARY_POLICIES) {
			const facts = moduleBoundaryFacts(path);
			expect([...new Set(facts.specifiers)].sort(), `${path} import allowlist`).toEqual([...policy.imports].sort());
			for (const operation of FORBIDDEN_ITEM_OPERATIONS) {
				expect(facts.names.has(operation), `${path} performs an irreversible item operation ${operation}`).toBe(false);
			}
			expect(knownPortCalls(facts.propertyCallChains).sort(), `${path} capability allowlist`).toEqual([...policy.portCalls].sort());
		}
	});

	it('censuses non-null asserted port calls instead of letting an optional callback bypass the boundary guard', () => {
		const calls = knownPortCalls(propertyCallChains(
			'this.actions.upsertInventoryGoal!(goal); this.ports.reclassify!(); this.actions.loadInventoryPreferences?.(); this.preferenceSession?.current();',
		));
		expect(calls.sort()).toEqual(['actions.loadInventoryPreferences', 'actions.upsertInventoryGoal', 'ports.reclassify', 'preferenceSession.current']);
	});

	it.each([
		[`import type { Client } from '../account/guild-wars-2-client';`, '../account/guild-wars-2-client'],
		[`export { request } from '../core/http';`, '../core/http'],
		[`import 'obsidian';`, 'obsidian'],
		[`const capture = import('../advisor/inventory-advisor-evidence');`, '../advisor/inventory-advisor-evidence'],
		[`const fs = require('node:fs/promises');`, 'node:fs/promises'],
		[`import http from 'node:http';`, 'node:http'],
		[`import https from 'node:https';`, 'node:https'],
		[`import net from 'node:net';`, 'node:net'],
		[`import fs from 'fs/promises';`, 'fs/promises'],
		[`import { fetch } from 'undici';`, 'undici'],
	])('extracts and rejects forbidden dependency syntax in %s', (source, expected) => {
		expect(moduleSpecifiers(source)).toEqual([expected]);
		expect(forbiddenDependency(expected)).toBe(true);
	});

	it.each(['destroyItem(10);', 'deleteItem(10);', 'salvageItem(10);', 'openContainer(10);'])(
		'turns red for the irreversible operation %s',
		(source) => expect(FORBIDDEN_ITEM_OPERATIONS.some((operation) => referencedNames(source).has(operation))).toBe(true),
	);

	it.each([
		'private readonly executor?: Executor;',
		'public static gateway(): Gateway { throw new Error(); }',
		'protected client!: Client;',
		'readonly store: Store;',
		'private timer() {}',
		'public capture?(): void;',
	])('turns red for capability declaration %s', (source) => {
		const members = classMemberNames(`class Probe { ${source} }`);
		expect([...members].some((member) => isForbiddenCapabilityMemberName(member))).toBe(true);
	});
});

function isForbiddenCapabilityMemberName(name: string): boolean {
	for (const stem of CAPABILITY_STEMS) {
		if (name === stem) return true;
		if (name.startsWith(stem) && /^[A-Z_$]/u.test(name.charAt(stem.length))) return true;
	}
	return CAPABILITY_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
}

function knownPortCalls(chains: readonly string[]): string[] {
	const result = new Set<string>();
	for (const chain of chains) {
		const thisRooted = chain.startsWith('this.');
		const withoutThis = thisRooted ? chain.slice('this.'.length) : chain;
		const receiver = withoutThis.split('.')[0] ?? '';
		if ((thisRooted && THIS_ROOTED_PORT_CALL_RECEIVERS.has(receiver)) || receiver === 'provider') {
			result.add(withoutThis);
		}
	}
	return [...result];
}

function forbiddenDependency(specifier: string): boolean {
	const forbiddenPackages = new Set([
		'obsidian', 'node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
		'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns',
		'node:fs', 'node:fs/promises', 'fs', 'fs/promises',
		'undici', 'node-fetch', 'cross-fetch', 'axios', 'got', 'superagent',
	]);
	if (forbiddenPackages.has(specifier) || specifier.startsWith('undici/')) return true;
	return specifier.split('/').some((token) => /(?:^|[-_.])(?:client|http|request|gateway|transport|secret|store|capture|evidence|executor|operation)(?:$|[-_.])/iu.test(token));
}

// H14.17: the poisoned-import and added-capability regression cases that used to live here read
// the real file, mutated its text and re-ran the same specifier/port-call extraction on the
// splice. That is subsumed by the exact-allowlist checks above: `toEqual` against
// `policy.imports`/`policy.portCalls` already fails the moment ANY extra import or call appears,
// poisoned or not. Verified causally instead: temporarily adding a GuildWars2Client import (and,
// separately, a preferenceSession.exportEverything call) to a real UI boundary file turns the
// allowlist check above red; both were reverted after confirming it.
