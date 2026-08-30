import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { moduleSpecifiers } from '../test/module-boundary';

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
].sort((left, right) => left.path.localeCompare(right.path))
	.map((entry) => ({ ...entry, source: readFileSync(entry.path, 'utf8') }));

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
			'./inventory-advisor-view-model', './inventory-advisor-view',
			'./inventory-vault-sync-run-controller'],
			portCalls: ['actions.getInventoryAdvisorLocale', 'actions.getInventoryAdvisorViewModel',
				'actions.createInventoryPreferencesEditorSession', 'preferenceSession.current', 'preferenceSession.load',
				'preferenceSession.upsertGoal', 'preferenceSession.removeGoal', 'preferenceSession.upsertKeepException', 'preferenceSession.removeKeepException',
				'actions.getInventoryVaultSyncRunState', 'actions.hasManagedAssetsRoot', 'actions.refreshInventoryAdvisor',
				'actions.runInventoryVaultSync', 'actions.confirmInventoryVaultSync', 'actions.cancelInventoryVaultSync',
				'actions.getPriceHistoryState', 'actions.enablePriceHistory', 'actions.loadPriceHistorySeries'],
	}],
	['src/ui/inventory-advisor-view.ts', {
		imports: ['obsidian', '../core/i18n', '../advisor/inventory-advisor-model', '../advisor/inventory-preferences-runtime',
			'../economy/reservation-model', './inventory-advisor-view-model',
			'./inventory-vault-sync-run-controller', './inventory-sync-panel-view', './price-history-panel-view'],
		portCalls: [],
	}],
	['src/ui/inventory-sync-panel-view.ts', {
		imports: ['../core/i18n', './inventory-vault-sync-controller', './inventory-vault-sync-run-controller'],
		portCalls: [],
	}],
	['src/ui/price-history-panel-view.ts', {
		imports: ['../core/i18n', '../economy/price-history-runtime', '../economy/price-history-model'],
		portCalls: [],
	}],
]);

const FORBIDDEN_ITEM_OPERATION = /\b(?:destroyItem|deleteItem|salvageItem|openContainer)\s*\(/u;

const CAPABILITY_NAME = '(?:(?:executor|gateway|client|store|timer|capture)(?:[A-Z_$][\\w$]*)?|[\\w$]+(?:Executor|Gateway|Client|Store|Timer|Capture)(?:[A-Z_$][\\w$]*)?)';
const FORBIDDEN_CAPABILITY = new RegExp(`^\\s*(?:(?:public|private|protected|readonly|static|declare|abstract|override|async)\\s+)*(?:get\\s+|set\\s+)?#?${CAPABILITY_NAME}\\s*(?:\\?|!)?\\s*(?::|\\(|=)`, 'mu');

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
		for (const { path, source } of PRESENTATION_FILES) {
			for (const specifier of moduleSpecifiers(source)) {
				expect(forbiddenDependency(specifier), `${path} imports forbidden dependency ${specifier}`).toBe(false);
			}
			expect(source, `${path} performs an irreversible item operation`).not.toMatch(FORBIDDEN_ITEM_OPERATION);
			expect(source, `${path} declares a forbidden capability`).not.toMatch(FORBIDDEN_CAPABILITY);
		}
	});

	it('censuses the explicit integration capabilities the controller may reach for', () => {
		const controller = PRESENTATION_FILES.find(({ file }) => file === 'inventory-advisor-controller.ts')?.source ?? '';
		expect([...new Set(boundaryPortCalls(controller))].sort()).toEqual(['ports.invalidate', 'ports.load', 'ports.reclassify']);
	});

	it('guards workflow, presentation, ItemView and renderer with per-file import and capability allowlists', () => {
		for (const [path, policy] of BOUNDARY_POLICIES) {
			const source = readFileSync(path, 'utf8');
			expect([...new Set(moduleSpecifiers(source))].sort(), `${path} import allowlist`).toEqual([...policy.imports].sort());
			expect(source, `${path} performs an irreversible item operation`).not.toMatch(FORBIDDEN_ITEM_OPERATION);
			expect(boundaryPortCalls(source).sort(), `${path} capability allowlist`).toEqual([...policy.portCalls].sort());
		}
	});

	it('poisons a GuildWars2Client import in every UI boundary', () => {
		for (const path of [
			'src/ui/inventory-advisor-item-view.ts',
			'src/ui/inventory-advisor-view.ts',
			'src/ui/inventory-sync-panel-view.ts',
			'src/ui/price-history-panel-view.ts',
		]) {
			const source = readFileSync(path, 'utf8');
			expect(boundarySourceAllowed(path, source)).toBe(true);
			const poisoned = `import { GuildWars2Client } from '../account/guild-wars-2-client';\n${source}`;
			expect(boundarySourceAllowed(path, poisoned)).toBe(false);
		}
	});

	it('censuses non-null asserted port calls instead of letting an optional callback bypass the boundary guard', () => {
		expect(boundaryPortCalls('this.actions.upsertInventoryGoal!(goal); this.ports.reclassify!(); this.actions.loadInventoryPreferences?.(); this.preferenceSession?.current();').sort())
			.toEqual(['actions.loadInventoryPreferences', 'actions.upsertInventoryGoal', 'ports.reclassify', 'preferenceSession.current']);
	});

	it('turns red when an ItemView session capability is added without an allowlist entry', () => {
		const source = readFileSync('src/ui/inventory-advisor-item-view.ts', 'utf8');
		const poisoned = `${source}\nthis.preferenceSession.exportEverything?.();`;
		expect(boundaryPortCalls(poisoned)).toContain('preferenceSession.exportEverything');
		expect(boundaryPortCalls(poisoned).sort()).not.toEqual(BOUNDARY_POLICIES.get('src/ui/inventory-advisor-item-view.ts')!.portCalls.slice().sort());
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
		(source) => expect(FORBIDDEN_ITEM_OPERATION.test(source)).toBe(true),
	);

	it.each([
		'private readonly executor?: Executor;',
		'public static gateway(): Gateway { throw new Error(); }',
		'protected client!: Client;',
		'readonly store: Store;',
		'private timer() {}',
		'public capture?(): void;',
	])('turns red for capability declaration %s', (source) => {
		expect(FORBIDDEN_CAPABILITY.test(source)).toBe(true);
	});
});

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

function boundaryPortCalls(source: string): string[] {
	const instanceCalls = [...source.matchAll(/\bthis\.(ports|actions|preferenceSession)(?:!\.|\?\.|\.)(\w+)(?:\.(\w+))?(?:!|\?\.)?\s*\(/gu)]
		.map((match) => `${match[1]}.${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`);
	const providerCalls = [...source.matchAll(/\bprovider\.(\w+)\s*\(/gu)].map((match) => `provider.${match[1]}`);
	return [...new Set([...instanceCalls, ...providerCalls])];
}

function boundarySourceAllowed(path: string, source: string): boolean {
	const allowed = BOUNDARY_POLICIES.get(path)?.imports;
	if (allowed === undefined) return false;
	const actual = [...new Set(moduleSpecifiers(source))].sort();
	return actual.length === allowed.length && actual.every((specifier, index) => specifier === [...allowed].sort()[index]);
}
