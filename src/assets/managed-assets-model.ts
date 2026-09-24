import { normalizeVaultRelativePath } from '../core/vault-path';

export const MANAGED_ASSETS_SCHEMA_VERSION = 2 as const;
export const LEGACY_MANAGED_ASSETS_SCHEMA_VERSION = 1 as const;
export const MANAGED_ASSETS_MANIFEST = 'Tyrian Companion Assets.json' as const;

export type AssetLocale = 'neutral' | 'es' | 'en';
export type ManagedAssetKind = 'base' | 'template';
export type ManagedAssetStatus =
	| 'create' | 'unchanged' | 'update' | 'missing' | 'recoverable' | 'modified'
	| 'occupied_unowned' | 'newer_than_plugin' | 'unsupported_manifest' | 'conflict';
export type ManagedAssetsBlockerReason = Extract<ManagedAssetStatus,
	'modified' | 'occupied_unowned' | 'newer_than_plugin' | 'unsupported_manifest' | 'conflict'> | 'detached';
export type ManagedOperationKind = 'install' | 'upgrade' | 'repair' | 'relocate' | 'uninstall';

export interface PackagedAsset {
	id: string;
	kind: ManagedAssetKind;
	contentVersion: number;
	locale: AssetLocale;
	relativePath: string;
	/** Complete LF-normalized bytes, including the compatible ownership marker. */
	bytes: string;
	contentHash: string;
}

export interface ManagedAssetEntry {
	id: string;
	kind: ManagedAssetKind;
	contentVersion: number;
	locale: AssetLocale;
	path: string;
	installedHash: string;
	/** Canonical parsed-YAML hash for Base assets. Absent only in legacy schema v1 manifests. */
	installedSemanticHash?: string;
}

export interface ManagedOperationStep {
	id: string;
	path: string;
	beforeHash: string | null;
	afterHash: string | null;
	state: 'pending' | 'done';
}

export interface PendingManagedOperation {
	operationId: string;
	kind: ManagedOperationKind;
	fromGeneration: number;
	targetBundleVersion: number;
	steps: ManagedOperationStep[];
}

export interface ManagedAssetsManifest {
	schemaVersion: typeof LEGACY_MANAGED_ASSETS_SCHEMA_VERSION | typeof MANAGED_ASSETS_SCHEMA_VERSION;
	pluginId: 'tyrian-companion';
	root: string;
	bundleVersion: number;
	generation: number;
	locale: 'es' | 'en';
	state: 'ready' | 'applying' | 'detached';
	assets: ManagedAssetEntry[];
	pendingOperation?: PendingManagedOperation;
}

export interface InspectedAsset {
	asset: PackagedAsset;
	path: string;
	status: ManagedAssetStatus;
	currentHash: string | null;
	currentSemanticHash: string | null;
	installedHash: string | null;
}

export interface ManagedAssetsInspection {
	root: string;
	manifestPath: string;
	manifest: ManagedAssetsManifest | null;
	manifestStatus: 'missing' | 'ready' | 'applying' | 'detached' | 'unsupported_manifest' | 'conflict';
	bundleVersion: number;
	locale: 'es' | 'en';
	assets: InspectedAsset[];
}

export interface ManagedAssetsPlan {
	kind: ManagedOperationKind;
	root: string;
	canApply: boolean;
	reasons: ManagedAssetsBlockerReason[];
	steps: Array<{ id: string; path: string; status: ManagedAssetStatus }>;
}

export function managedAssetMarker(asset: Pick<PackagedAsset, 'id' | 'kind' | 'contentVersion' | 'locale'>): string {
	const payload = `plugin=tyrian-companion id=${asset.id} kind=${asset.kind} version=${asset.contentVersion} locale=${asset.locale}`;
	return asset.kind === 'base' ? `# tyrian-companion-managed ${payload}` : `<!-- tyrian-companion-managed ${payload} -->`;
}

export function hasCompatibleMarker(content: string, asset: PackagedAsset): boolean {
	return content.replace(/\r\n?/gu, '\n').split('\n', 1)[0] === managedAssetMarker(asset);
}

/** Validates one NFC, vault-relative path and its managed extension. */
export function normalizeManagedAssetPath(value: unknown, configDir: string): string | null {
	const path = normalizeVaultRelativePath(value, { forbiddenPathPrefixes: [configDir] });
	if (path === null) return null;
	const file = path.split('/').at(-1) ?? '';
	if (file !== MANAGED_ASSETS_MANIFEST && !file.endsWith('.base') && !file.endsWith('.md')) return null;
	return path;
}

export function managedAssetPath(root: string, asset: PackagedAsset): string {
	const folder = asset.kind === 'base' ? 'Bases' : 'Templates';
	return `${root}/${folder}/${asset.relativePath}`;
}

export function manifestPath(root: string): string {
	return `${root}/${MANAGED_ASSETS_MANIFEST}`;
}

/** Pure preview: modified/unowned/future/conflicting evidence always blocks writes. */
export function planManagedAssets(inspection: ManagedAssetsInspection, kind: ManagedOperationKind): ManagedAssetsPlan {
	const blockers = new Set<ManagedAssetStatus>(['modified', 'occupied_unowned', 'newer_than_plugin', 'unsupported_manifest', 'conflict']);
	const reasons: ManagedAssetsBlockerReason[] = inspection.assets
		.filter((entry) => blockers.has(entry.status))
		.map((entry) => entry.status as ManagedAssetsBlockerReason);
	if (inspection.manifestStatus === 'unsupported_manifest' || inspection.manifestStatus === 'conflict') reasons.push(inspection.manifestStatus);
	if (inspection.manifestStatus === 'detached' && kind !== 'uninstall') reasons.push('detached');
	return {
		kind,
		root: inspection.root,
		canApply: reasons.length === 0,
		reasons: [...new Set(reasons)].sort(),
		steps: inspection.assets.map(({ asset, path, status }) => ({ id: asset.id, path, status })),
	};
}

/** Why an automatic Base update is left to the manual preview: a conflict, or a Base the user deleted. */
export type ManagedAssetsAutoUpdateHold = ManagedAssetsBlockerReason | 'missing';

export type ManagedAssetsAutoUpdateDecision =
	/** Nothing installed (never installs by itself), another operation in flight, or nothing newer. */
	| { action: 'none' }
	/** A newer bundle and nothing the user touched: apply it through the ordinary upgrade. */
	| { action: 'apply' }
	/** A newer bundle held back: leave everything as it is and point the user to the preview. */
	| { action: 'manual'; reasons: ManagedAssetsAutoUpdateHold[] };

/**
 * H18.18: whether the managed Bases can follow a newer plugin on their own. It reuses the exact
 * conflict rule of the manual preview (`planManagedAssets(…, 'upgrade')`), so anything that
 * preview would refuse (a Base the user edited, a foreign file, a newer manifest, a detached
 * root) keeps the manual path and only earns a warning, and adds one hold of its own: a Base the
 * user deleted is never recreated behind their back. An edited Base whose installed version is
 * already current is not "pending", so a user who customised a Base is not warned on every sync.
 */
export function decideManagedAssetsAutoUpdate(inspection: ManagedAssetsInspection): ManagedAssetsAutoUpdateDecision {
	if (inspection.manifestStatus === 'missing' || inspection.manifestStatus === 'applying') return { action: 'none' };
	const installedVersion = new Map((inspection.manifest?.assets ?? []).map((entry) => [entry.id, entry.contentVersion]));
	const pending = inspection.assets.some((entry) => entry.status === 'update' || entry.status === 'create'
		|| entry.status === 'recoverable'
		|| (entry.status === 'modified' && (installedVersion.get(entry.asset.id) ?? 0) < entry.asset.contentVersion));
	if (!pending) return { action: 'none' };
	const plan = planManagedAssets(inspection, 'upgrade');
	const missing = inspection.assets.some((entry) => entry.status === 'missing');
	if (plan.canApply && !missing) return { action: 'apply' };
	return { action: 'manual', reasons: [...plan.reasons, ...(missing ? ['missing' as const] : [])] };
}

export function isManagedAssetsManifest(value: unknown): value is ManagedAssetsManifest {
	if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.pluginId !== 'tyrian-companion') return false;
	const schemaVersion = value.schemaVersion;
	if (!exactKeys(value, ['schemaVersion', 'pluginId', 'root', 'bundleVersion', 'generation', 'locale', 'state', 'assets'], ['pendingOperation'])) return false;
	if (typeof value.root !== 'string' || !positiveInt(value.bundleVersion) || !nonNegativeInt(value.generation)) return false;
	if ((value.locale !== 'es' && value.locale !== 'en') || !['ready', 'applying', 'detached'].includes(String(value.state)) || !Array.isArray(value.assets)) return false;
	if (!value.assets.every((entry) => isAssetEntry(entry, schemaVersion))) return false;
	if (value.state === 'applying') return isPendingOperation(value.pendingOperation);
	return value.pendingOperation === undefined;
}

function isAssetEntry(value: unknown, schemaVersion: 1 | 2): value is ManagedAssetEntry {
	if (!record(value) || !exactKeys(value, ['id', 'kind', 'contentVersion', 'locale', 'path', 'installedHash'], ['installedSemanticHash']) ||
		typeof value.id !== 'string' || value.id.length === 0 || (value.kind !== 'base' && value.kind !== 'template') ||
		!positiveInt(value.contentVersion) || !['neutral', 'es', 'en'].includes(String(value.locale)) ||
		typeof value.path !== 'string' || !isHash(value.installedHash)) return false;
	if (schemaVersion === 1) return value.installedSemanticHash === undefined;
	return value.kind === 'base' ? isHash(value.installedSemanticHash) : value.installedSemanticHash === undefined;
}

function isPendingOperation(value: unknown): value is PendingManagedOperation {
	return record(value) && exactKeys(value, ['operationId', 'kind', 'fromGeneration', 'targetBundleVersion', 'steps']) && typeof value.operationId === 'string' && value.operationId.length > 0 &&
		['install', 'upgrade', 'repair', 'relocate', 'uninstall'].includes(String(value.kind)) &&
		nonNegativeInt(value.fromGeneration) && positiveInt(value.targetBundleVersion) && Array.isArray(value.steps) &&
		value.steps.every((step) => record(step) && exactKeys(step, ['id', 'path', 'beforeHash', 'afterHash', 'state']) && typeof step.id === 'string' && typeof step.path === 'string' &&
			(step.beforeHash === null || isHash(step.beforeHash)) && (step.afterHash === null || isHash(step.afterHash)) &&
			(step.state === 'pending' || step.state === 'done'));
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function positiveInt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function nonNegativeInt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function isHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
