import { parseDocument } from 'yaml';

import { sha256Text } from './managed-asset-hash';
import { PUBLISHED_BASE_FINGERPRINTS, type PublishedBaseFingerprint } from './published-base-hashes';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import { legacyVaultFolder } from '../core/settings';
import { vaultFailureCause, type VaultFailureCause } from '../core/vault-failure-cause';
import { ensureFoldersBySegments } from '../core/vault-folders';
import {
	hasCompatibleMarker,
	isManagedAssetsManifest,
	MANAGED_ASSETS_SCHEMA_VERSION,
	managedAssetPath,
	manifestPath,
	normalizeManagedAssetPath,
	planManagedAssets,
	type InspectedAsset,
	type InspectedRetirement,
	type ManagedAssetEntry,
	type ManagedAssetsInspection,
	type ManagedAssetsManifest,
	type ManagedAssetsPlan,
	type ManagedOperationKind,
	type ManagedOperationStep,
	type PackagedAsset,
	type RetiredAsset,
} from './managed-assets-model';

export interface ManagedAssetFile { path: string }
export interface ManagedAssetsVault {
	file(path: string): ManagedAssetFile | null;
	listFiles(): ManagedAssetFile[];
	read(file: ManagedAssetFile): Promise<string>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<ManagedAssetFile>;
	process(file: ManagedAssetFile, update: (content: string) => string): Promise<string>;
	trashFile(file: ManagedAssetFile): Promise<void>;
	/**
	 * Removes `file` only while its LF-normalized text still equals `expectedContent` (both hosts have it;
	 * `labelledVault` passes it through). A port without it falls back to `trashFile` after the manager's
	 * own re-check, which leaves a wider window.
	 */
	trashIfUnchanged?(file: ManagedAssetFile, expectedContent: string): Promise<{ status: 'trashed' } | { status: 'conflict' } | { status: 'unsupported' }>;
}

export type ManagedAssetsResult =
	| { status: 'applied' | 'unchanged' | 'detached'; inspection: ManagedAssetsInspection; ownership: 'created' | 'existing' }
	| { status: 'busy' | 'conflict' | 'invalid' | 'unavailable'; message: string; cause?: ManagedAssetsFailureCause; details?: Record<string, unknown> };

/**
 * Why a failure happened, when it is one the Settings row can explain better than «not available» /
 * «conflict»: the three the vault names (`vault-failure-cause.ts`) and the folder holding only the user's files.
 */
export type ManagedAssetsFailureCause = VaultFailureCause | 'only_unowned_files';

/** The cause and the real error code for the diagnostic, read from what was thrown (never its message). */
function failureEvidence(error: unknown): { cause?: ManagedAssetsFailureCause; details: Record<string, unknown> } {
	const cause = vaultFailureCause(error);
	const details = unmappedErrorLogDetails(error);
	if (cause !== undefined) details.code = cause;
	return cause === undefined ? { details } : { cause, details };
}

interface PackagedEvidence { contentHash: string; semanticHash: string | null }

export interface ManagedAssetsBundle {
	bundleVersion: number;
	locale: 'es' | 'en';
	assets: PackagedAsset[];
	/** Assets an earlier bundle shipped and this one does not: recognised in the manifest and retired, never created. */
	retired?: readonly RetiredAsset[];
}

/** Explicit, journaled Vault-only asset lifecycle. Construction and inspection setup have no I/O. */
export class ManagedAssetsManager {
	private flight: { key: string; promise: Promise<ManagedAssetsResult> } | null = null;
	/** SHA-256 and semantic hash of each PACKAGED asset; Vault files are never cached here. */
	private packagedEvidence = new Map<PackagedAsset, { bytes: string; evidence: Promise<PackagedEvidence> }>();

	constructor(
		private readonly vault: ManagedAssetsVault,
		private readonly configDir: string,
		private bundle: ManagedAssetsBundle,
		/** Injectable so tests can publish a synthetic older version; production always uses the generated table. */
		private readonly published: readonly PublishedBaseFingerprint[] = PUBLISHED_BASE_FINGERPRINTS,
	) {}

	/** Replaces packaged evidence only between explicit operations; it performs no Vault I/O. */
	setBundle(bundle: ManagedAssetsBundle): void {
		if (this.flight) throw new Error('managed_assets_busy');
		this.bundle = bundle;
		this.packagedEvidence = new Map();
	}

	/**
	 * Hashes of the packaged bytes, computed once per asset until `setBundle`. `bytes` is kept so an asset
	 * mutated in place is never answered from a stale entry.
	 */
	private async packaged(asset: PackagedAsset): Promise<PackagedEvidence> {
		const cached = this.packagedEvidence.get(asset);
		if (cached && cached.bytes === asset.bytes) return await cached.evidence;
		const evidence = this.computePackaged(asset);
		this.packagedEvidence.set(asset, { bytes: asset.bytes, evidence });
		return await evidence;
	}

	private async computePackaged(asset: PackagedAsset): Promise<PackagedEvidence> {
		return {
			contentHash: await sha256Text(asset.bytes),
			semanticHash: asset.kind === 'base' ? await baseSemanticHash(asset.bytes) : null,
		};
	}

	/**
	 * `adoptPublished: false` keeps the strict ownership evidence (marker or manifest only). Relocation
	 * passes it so its own origin-manifest adoption stays the only way to take over a destination.
	 */
	async inspect(root: string, options: { adoptPublished?: boolean } = {}): Promise<ManagedAssetsInspection> {
		const adoptPublished = options.adoptPublished ?? true;
		const validatedRoot = validateRoot(root, this.configDir);
		if (!validatedRoot) throw new Error('invalid_root');
		validateBundle(this.bundle, validatedRoot, this.configDir);
		const targetManifestPath = manifestPath(validatedRoot);
		const manifestRead = await this.readManifest(targetManifestPath);
		const manifestMatchesRoot = manifestRead.status === 'valid' && await this.validManifestRelations(manifestRead.manifest, validatedRoot);
		const manifest = manifestMatchesRoot ? manifestRead.manifest : null;
		const assets: InspectedAsset[] = [];
		for (const asset of selectedAssets(this.bundle)) {
			const packaged = await this.packaged(asset);
			if (packaged.contentHash !== asset.contentHash) throw new Error('invalid_bundle_hash');
			const targetSemanticHash = packaged.semanticHash;
			if (asset.kind === 'base' && targetSemanticHash === null) throw new Error('invalid_bundle_yaml');
			const path = managedAssetPath(validatedRoot, asset);
			if (!normalizeManagedAssetPath(path, this.configDir)) throw new Error('invalid_asset_path');
			const file = this.vault.file(path);
			let registered = manifest?.assets.find((entry) => entry.id === asset.id) ?? null;
			if (!file) {
				assets.push({ asset, path, status: registered ? 'missing' : 'create', currentHash: null, currentSemanticHash: null, installedHash: registered?.installedHash ?? null });
				continue;
			}
			const content = normalizeLf(await this.vault.read(file));
			const currentHash = await sha256Text(content);
			const currentSemanticHash = asset.kind === 'base' ? await baseSemanticHash(content) : null;
			let status: InspectedAsset['status'] = 'occupied_unowned';
			let adopted: ManagedAssetEntry | undefined;
			if (!registered) {
				status = currentHash === asset.contentHash && hasCompatibleMarker(content, asset) ? 'recoverable' : 'occupied_unowned';
				// Obsidian rewrites a .base without its first-line marker, so a Base that MEANS exactly what
				// this plugin published is adopted by semantic hash: the current bundle is `recoverable`, an
				// older publication is registered at ITS contentVersion and reads `update`.
				if (status === 'occupied_unowned' && adoptPublished && currentSemanticHash !== null) {
					const current = currentSemanticHash === targetSemanticHash;
					const version = current ? asset.contentVersion : publishedVersionOf(this.published, asset, currentSemanticHash);
					if (version !== null) {
						adopted = { id: asset.id, kind: asset.kind, contentVersion: version, locale: asset.locale, path,
							installedHash: currentHash, installedSemanticHash: currentSemanticHash };
						if (current) status = 'recoverable';
						else registered = adopted;
					}
				}
			}
			if (!registered) { /* `status` is already recoverable or occupied_unowned */ }
			else if (registered.contentVersion > asset.contentVersion || (manifest !== null && manifest.bundleVersion > this.bundle.bundleVersion)) status = 'newer_than_plugin';
			else if (!await this.matchesInstalledContent(content, currentHash, registered, asset, targetSemanticHash)) status = 'modified';
			else status = currentHash === asset.contentHash ||
				(asset.kind === 'base' && registered.contentVersion === asset.contentVersion && currentSemanticHash === targetSemanticHash)
				? 'unchanged' : 'update';
			assets.push({ asset, path, status, currentHash, currentSemanticHash, installedHash: registered?.installedHash ?? null, ...(adopted ? { adopted } : {}) });
		}
		const manifestStatus = manifestRead.status === 'missing' ? 'missing'
			: manifestRead.status === 'unsupported' ? 'unsupported_manifest'
			: manifestRead.status === 'conflict' || !manifestMatchesRoot ? 'conflict' : manifest!.state;
		const retirements = manifest === null || manifest.state !== 'ready' ? [] : await this.inspectRetirements(manifest);
		return { root: validatedRoot, manifestPath: targetManifestPath, manifest, manifestStatus, bundleVersion: this.bundle.bundleVersion, locale: this.bundle.locale, assets,
			...(retirements.length > 0 ? { retirements } : {}) };
	}

	/**
	 * Registered entries of a retired asset. A file the plugin wrote and nobody edited (same bytes, same
	 * meaning once Obsidian reformatted it, or any published version of that Base) is `retire`; an edited
	 * or already deleted one is `release`: it is only unregistered, never a conflict.
	 */
	private async inspectRetirements(manifest: ManagedAssetsManifest): Promise<InspectedRetirement[]> {
		const retiredIds = new Set((this.bundle.retired ?? []).map((asset) => asset.id));
		const live = new Set(this.bundle.assets.map((asset) => asset.id));
		const found: InspectedRetirement[] = [];
		for (const entry of manifest.assets) {
			if (!retiredIds.has(entry.id) || live.has(entry.id)) continue;
			const file = this.vault.file(entry.path);
			found.push({ entry, path: entry.path, present: file !== null, status: file !== null && await this.isAsWritten(file, entry) ? 'retire' : 'release' });
		}
		// A retired id a version of the plugin once declared `excluded` (a file of the user's it could not prove
		// its own): never registered, never touched, only taken off the list.
		for (const id of manifest.excluded ?? []) {
			const retired = (this.bundle.retired ?? []).find((asset) => asset.id === id && !live.has(id));
			if (!retired) continue;
			const path = managedAssetPath(manifest.root, { ...retired, contentVersion: 0, bytes: '', contentHash: '' });
			found.push({ entry: { id, kind: retired.kind, contentVersion: 0, locale: retired.locale, path, installedHash: '' }, path,
				present: this.vault.file(path) !== null, status: 'release', excludedOnly: true });
		}
		return found;
	}

	/** The file is exactly what the plugin installed: same bytes, same meaning, or (implementation detail) any published version of that Base. */
	private async isAsWritten(file: ManagedAssetFile, entry: ManagedAssetEntry): Promise<boolean> {
		return await this.contentIsAsWritten(normalizeLf(await this.vault.read(file)), entry);
	}

	private async contentIsAsWritten(content: string, entry: ManagedAssetEntry): Promise<boolean> {
		if (await this.matchesInstalledContent(content, await sha256Text(content), entry)) return true;
		return await this.matchesPublished(content, entry);
	}

	private async matchesPublished(content: string, entry: ManagedAssetEntry): Promise<boolean> {
		if (entry.kind !== 'base') return false;
		const meaning = await baseSemanticHash(content);
		return meaning !== null && this.published.some((row) => row.assetId === entry.id && row.locale === entry.locale && row.semanticHash === meaning);
	}

	/**
	 * Remove / uninstall: what the manifest installed, or, only for an entry that recorded no semantic hash
	 * (a schema 1 manifest), a published version of it. An entry WITH a recorded hash is judged by it alone:
	 * a different published version is a change, as `inspect` says.
	 */
	private async matchesInstalledOrPublished(content: string, currentHash: string, entry: ManagedAssetEntry, target?: PackagedAsset): Promise<boolean> {
		if (await this.matchesInstalledContent(content, currentHash, entry, target)) return true;
		return entry.installedSemanticHash === undefined && await this.matchesPublished(content, entry);
	}

	private lastRetirement: { trashed: string[]; kept: string[] } = { trashed: [], kept: [] };

	/**
	 * What the last apply did to retired files, by path: `trashed` went through the host's removal, `kept` is a
	 * file that is still there (edited, or changed while the apply ran). A file that was already gone is in neither.
	 */
	retirementReport(): { trashed: string[]; kept: string[] } {
		const report = { trashed: [...this.lastRetirement.trashed], kept: [...this.lastRetirement.kept] };
		this.lastRetirement = { trashed: [], kept: [] };
		return report;
	}

	/**
	 * Retires what `inspectRetirements` found. A file still as the plugin installed it is removed through the
	 * host (`trashIfUnchanged` with the text just read, so an edit that lands in between is not removed;
	 * Obsidian follows the user's «Deleted files» preference, Hebra sends it to its trash). An edited,
	 * changed-meanwhile or already deleted one is left. Then every retired entry leaves the manifest in one
	 * compare-and-swap, a retired id declared `excluded` leaves that list, and the bundle version moves up
	 * when nothing else is pending. Files first: a crash in between leaves entries whose file is gone, which
	 * the next inspection reads as `release`.
	 */
	private async retire(inspection: ManagedAssetsInspection): Promise<boolean> {
		const manifest = inspection.manifest;
		const retirements = inspection.retirements ?? [];
		this.lastRetirement = { trashed: [], kept: [] };
		if (manifest === null || manifest.state !== 'ready' || retirements.length === 0) return true;
		for (const retirement of retirements) {
			const file = this.vault.file(retirement.path);
			if (retirement.excludedOnly || file === null) continue;
			const content = normalizeLf(await this.vault.read(file));
			if (retirement.status !== 'retire' || !await this.contentIsAsWritten(content, retirement.entry)) { this.lastRetirement.kept.push(retirement.path); continue; }
			if (this.vault.trashIfUnchanged) {
				const outcome = await this.vault.trashIfUnchanged(file, content);
				(outcome.status === 'trashed' ? this.lastRetirement.trashed : this.lastRetirement.kept).push(retirement.path);
			} else {
				await this.vault.trashFile(file);
				this.lastRetirement.trashed.push(retirement.path);
			}
		}
		const dropped = new Set(retirements.filter(({ excludedOnly }) => !excludedOnly).map(({ entry }) => entry.id));
		const droppedExcluded = new Set(retirements.filter(({ excludedOnly }) => excludedOnly).map(({ entry }) => entry.id));
		const next: ManagedAssetsManifest = { ...manifest, generation: manifest.generation + 1, assets: manifest.assets.filter((entry) => !dropped.has(entry.id)) };
		const excluded = (manifest.excluded ?? []).filter((id) => !droppedExcluded.has(id));
		if (excluded.length > 0) next.excluded = excluded; else delete next.excluded;
		// Nothing else pending: the manifest now describes this bundle exactly, so it says so. Only when every Base
		// is really registered and unchanged: a user's file on the path of a Base the manifest does not list
		// (`occupied_unowned`) is neither registered nor excluded, and the exact-set rule would call that a conflict.
		if (inspection.assets.every((entry) => entry.status === 'unchanged') && manifest.locale === this.bundle.locale) next.bundleVersion = this.bundle.bundleVersion;
		return await this.casManifest(manifest, next) !== null;
	}

	/** Reads an old managed root only while an explicit removal/move is in progress; it never creates there. */
	private async inspectLegacyForUninstall(root: string): Promise<ManagedAssetsInspection> {
		const validatedRoot = legacyVaultFolder(root, this.configDir);
		if (!validatedRoot) throw new Error('invalid_legacy_root');
		const targetManifestPath = manifestPath(validatedRoot);
		const manifestRead = await this.readManifest(targetManifestPath);
		const manifestMatchesRoot = manifestRead.status === 'valid' && await this.validManifestRelations(manifestRead.manifest, validatedRoot, true);
		const manifest = manifestMatchesRoot ? manifestRead.manifest : null;
		const manifestStatus = manifestRead.status === 'missing' ? 'missing'
			: manifestRead.status === 'unsupported' ? 'unsupported_manifest'
			: manifestRead.status === 'conflict' || !manifestMatchesRoot ? 'conflict' : manifest!.state;
		return { root: validatedRoot, manifestPath: targetManifestPath, manifest, manifestStatus, bundleVersion: this.bundle.bundleVersion, locale: this.bundle.locale, assets: [] };
	}

	private async inspectForUninstall(root: string): Promise<ManagedAssetsInspection> {
		return legacyVaultFolder(root, this.configDir) === null
			? await this.inspect(root)
			: await this.inspectLegacyForUninstall(root);
	}

	async preview(root: string, kind: ManagedOperationKind = 'install'): Promise<ManagedAssetsPlan> {
		return planManagedAssets(await this.inspect(root), kind);
	}

	/** Read-only legacy inspection used solely to adopt a retained root for Move/Remove. */
	async inspectForLegacyTransition(root: string): Promise<ManagedAssetsInspection> {
		return await this.inspectForUninstall(root);
	}

	/**
	 * `guard` sees the very inspection this apply would act on and can refuse it: false writes nothing and
	 * answers `unchanged`. It is how a caller that DECIDED on an earlier inspection re-decides inside the flight.
	 */
	apply(root: string, kind: Exclude<ManagedOperationKind, 'relocate' | 'uninstall'> = 'install', guard?: (inspection: ManagedAssetsInspection) => boolean, replaceUnowned: ReadonlySet<string> | null = null): Promise<ManagedAssetsResult> {
		const key = this.flightKey(root, kind, replaceUnowned ? `replace-unowned:${[...replaceUnowned].sort().join(',')}` : null);
		if (this.flight) return this.flight.key === key ? this.flight.promise : Promise.resolve({ status: 'busy', message: 'Another managed-assets operation is active.' });
		const promise = this.applyInternal(root, kind, guard, replaceUnowned).finally(() => { if (this.flight?.promise === promise) this.flight = null; });
		this.flight = { key, promise };
		return promise;
	}

	/**
	 * The user's explicit «Replace»: every Base of the bundle sitting on its managed path that the plugin
	 * cannot prove it wrote (`occupied_unowned`: edited by hand, or from a build nothing published) is
	 * overwritten with the bundle's bytes and registered. Nothing else is ever touched, and no automatic path
	 * reaches this: `apply` keeps leaving those files alone. The file is compared against the bytes inspected,
	 * so one edited in between is refused rather than lost. Only the ids in `confirmed` (what the user was
	 * shown) are replaced: an unrecognised Base that appeared since stays untouched.
	 */
	replaceUnowned(root: string, confirmed: readonly string[]): Promise<ManagedAssetsResult> {
		return this.apply(root, 'repair', undefined, new Set(confirmed));
	}

	relocate(from: string, to: string): Promise<ManagedAssetsResult> {
		const key = this.flightKey(to, 'relocate', from);
		if (this.flight) return this.flight.key === key ? this.flight.promise : Promise.resolve({ status: 'busy', message: 'Another managed-assets operation is active.' });
		const promise = this.relocateInternal(from, to).finally(() => { if (this.flight?.promise === promise) this.flight = null; });
		this.flight = { key, promise };
		return promise;
	}

	async uninstall(root: string): Promise<ManagedAssetsResult> {
		const key = this.flightKey(root, 'uninstall');
		if (this.flight) return this.flight.key === key ? this.flight.promise : { status: 'busy', message: 'Another managed-assets operation is active.' };
		const promise = this.uninstallInternal(root).finally(() => { if (this.flight?.promise === promise) this.flight = null; });
		this.flight = { key, promise };
		return await promise;
	}

	/** Read-only: the Bases on a managed path that the plugin cannot prove it wrote (what Replace would overwrite). */
	async listUnowned(root: string): Promise<Array<{ id: string; path: string }>> {
		return (await this.inspect(root)).assets
			.filter((entry) => entry.status === 'occupied_unowned')
			.map((entry) => ({ id: entry.asset.id, path: entry.path }));
	}

	private flightKey(root: string, kind: ManagedOperationKind, sourceRoot: string | null = null): string {
		return JSON.stringify([sourceRoot, root, kind, this.bundle.bundleVersion, this.bundle.locale,
			selectedAssets(this.bundle).map(({ id, contentVersion, locale, relativePath, contentHash }) => [id, contentVersion, locale, relativePath, contentHash])]);
	}

	/**
	 * Relocation is the only operation allowed to recover a complete destination whose Bases
	 * lost their byte marker during Obsidian serialization. The ready schema-v2 manifest at the
	 * pointer-owned origin supplies the exact semantic fingerprints; ordinary install remains
	 * deliberately unable to adopt the same files.
	 */
	private async relocateInternal(from: string, to: string): Promise<ManagedAssetsResult> {
		try {
			if (from === to) return { status: 'invalid', message: 'Managed-assets relocation roots must differ.' };
			let destination = await this.inspect(to, { adoptPublished: false });
			if (destination.manifest?.state === 'applying') {
				if (destination.manifest.pendingOperation?.kind !== 'relocate') {
					return { status: 'busy', message: 'Another managed-assets operation is active.' };
				}
				const finalized = await this.finalize(destination.manifest, destination.manifest.assets);
				if (!finalized) return { status: 'conflict', message: 'The recovered relocation could not be finalized.' };
				return { status: finalized.changed ? 'applied' : 'unchanged', inspection: await this.inspect(to), ownership: 'existing' };
			}
			if (destination.manifestStatus !== 'missing' ||
				destination.assets.every((entry) => entry.status !== 'occupied_unowned')) {
				return await this.applyInternal(to, 'install');
			}

			const source = await this.inspect(from);
			const adopted = this.relocationAdoption(source, destination);
			if (!adopted) return { status: 'conflict', message: 'Destination files do not exactly match the owned origin bundle.' };
			const operation = {
				operationId: await operationId(to, 0, this.bundle.bundleVersion, this.bundle.locale, 'relocate', adopted.steps),
				kind: 'relocate' as const, fromGeneration: 0, targetBundleVersion: this.bundle.bundleVersion,
				steps: adopted.steps,
			};
			let journal = await this.begin(destination, operation, adopted.entries);
			if (!journal) {
				destination = await this.inspect(to);
				if (destination.manifestStatus === 'ready' && destination.assets.every((entry) => entry.status === 'unchanged')) {
					return { status: 'unchanged', inspection: destination, ownership: 'existing' };
				}
				if (destination.manifest?.state !== 'applying' || destination.manifest.pendingOperation?.operationId !== operation.operationId) {
					return { status: 'conflict', message: 'The relocation journal changed.' };
				}
				journal = destination.manifest;
			}
			const finalized = await this.finalize(journal, adopted.entries);
			if (!finalized) return { status: 'conflict', message: 'The relocation could not be finalized.' };
			return { status: finalized.changed ? 'applied' : 'unchanged', inspection: await this.inspect(to), ownership: 'created' };
		} catch (error) {
			return { status: 'unavailable', message: 'Managed assets could not be relocated safely.', ...failureEvidence(error) };
		}
	}

	private relocationAdoption(
		source: ManagedAssetsInspection,
		destination: ManagedAssetsInspection,
	): { entries: ManagedAssetEntry[]; steps: ManagedOperationStep[] } | null {
		const manifest = source.manifest;
		if (manifest?.schemaVersion !== MANAGED_ASSETS_SCHEMA_VERSION || manifest.state !== 'ready' ||
			source.manifestStatus !== 'ready' || manifest.bundleVersion !== this.bundle.bundleVersion ||
			manifest.locale !== this.bundle.locale || destination.manifestStatus !== 'missing' ||
			source.assets.some((entry) => entry.status !== 'unchanged' && entry.status !== 'missing')) return null;
		const expectedPaths = destination.assets.map((entry) => entry.path).sort();
		const actualPaths = this.vault.listFiles().map((file) => file.path)
			.filter((path) => path.startsWith(`${destination.root}/Bases/`) || path.startsWith(`${destination.root}/Templates/`))
			.sort();
		if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) return null;

		const entries: ManagedAssetEntry[] = [];
		const steps: ManagedOperationStep[] = [];
		for (const inspected of destination.assets) {
			const { asset, currentHash, currentSemanticHash, path } = inspected;
			// A base's identity survives a plugin upgrade even when its contentVersion does not: the
			// origin manifest may still carry the version the user last installed, while the packaged
			// bundle has already moved on. Matching on id/kind/locale alone (and verifying equality by
			// semantic hash, never by version) is what lets that older origin be recognized as the same
			// asset; a template has no semantic hash, so it keeps requiring an exact version match.
			const origin = manifest.assets.find((entry) => entry.id === asset.id && entry.kind === asset.kind &&
				entry.locale === asset.locale && (asset.kind === 'base' || entry.contentVersion === asset.contentVersion));
			if (!origin || currentHash === null) return null;
			if (asset.kind === 'base') {
				if (origin.installedSemanticHash === undefined || currentSemanticHash !== origin.installedSemanticHash) return null;
			} else if (inspected.status !== 'recoverable' || currentHash !== origin.installedHash) {
				return null;
			}
			// Registered at the ORIGIN's contentVersion, not the packaged one: `inspect()` will then
			// report `update` (not `unchanged`) for a stale base, and the ordinary upgrade lifecycle
			// — not this relocation — is what carries it forward to the current bundle version.
			const entry: ManagedAssetEntry = {
				id: asset.id, kind: asset.kind, contentVersion: origin.contentVersion, locale: asset.locale,
				path, installedHash: currentHash,
			};
			if (asset.kind === 'base') entry.installedSemanticHash = currentSemanticHash!;
			entries.push(entry);
			steps.push({ id: asset.id, path, beforeHash: currentHash, afterHash: asset.contentHash, state: 'done' });
		}
		return { entries, steps };
	}

	private async applyInternal(root: string, kind: 'install' | 'upgrade' | 'repair', guard?: (inspection: ManagedAssetsInspection) => boolean, replaceUnowned: ReadonlySet<string> | null = null): Promise<ManagedAssetsResult> {
		try {
			// Each apply reports its own retirements (an earlier apply nobody read must not leak into this one).
			this.lastRetirement = { trashed: [], kept: [] };
			const inspectClaiming = async (): Promise<ManagedAssetsInspection> => {
				const inspected = await this.inspect(root);
				return replaceUnowned ? claimUnowned(inspected, replaceUnowned) : inspected;
			};
			let inspection = await inspectClaiming();
			if (guard && !guard(inspection)) return { status: 'unchanged', inspection, ownership: 'existing' };
			const ownership = inspection.manifestStatus === 'missing' ? 'created' as const : 'existing' as const;
			if (inspection.manifest?.state === 'applying') {
				if (inspection.manifest.pendingOperation?.kind !== kind) return { status: 'busy', message: 'Another managed-assets operation is active.' };
				let journal = inspection.manifest;
				for (let index = 0; index < journal.pendingOperation!.steps.length; index += 1) {
					const step = journal.pendingOperation!.steps[index]!;
					if (step.state === 'done') continue;
					const asset = selectedAssets(this.bundle).find((candidate) => candidate.id === step.id);
					const registered = journal.assets.find((candidate) => candidate.id === step.id);
					if (!asset || !await this.writeAsset(step, asset, registered)) return { status: 'conflict', message: 'A managed asset changed during recovery.' };
					const updated = await this.markDone(journal, index);
					if (!updated) {
						const raced = await this.inspect(root);
						if (raced.manifestStatus === 'ready' && raced.assets.every((entry) => isSettled(entry.status))) return { status: 'unchanged', inspection: raced, ownership: 'existing' };
						return { status: 'conflict', message: 'The recovery journal changed.' };
					}
					journal = updated;
				}
				const finalized = await this.finalize(journal);
				if (!finalized) return { status: 'conflict', message: 'The recovered operation could not be finalized.' };
				return { status: finalized.changed ? 'applied' : 'unchanged', inspection: await this.inspect(root), ownership: 'existing' };
			}
			const plan = planManagedAssets(inspection, kind);
			if (!plan.canApply) return { status: inspection.manifestStatus === 'applying' ? 'busy' : 'conflict', message: plan.reasons.join(', ') };
			const retiredAny = (inspection.retirements?.length ?? 0) > 0;
			if (retiredAny) {
				if (!await this.retire(inspection)) return { status: 'conflict', message: 'The managed-assets manifest changed.' };
				inspection = await inspectClaiming();
			}
			if (planManagedAssets(inspection, kind).steps.every((step) => isSettled(step.status))) {
				// Nothing to adopt or create and no manifest: an all-foreign folder must not become "managed".
				if (inspection.manifestStatus === 'missing') return { status: 'conflict', message: 'No managed asset can be created or adopted.', cause: 'only_unowned_files', details: { code: 'only_unowned_files' } };
				if (inspection.manifest?.schemaVersion === 1) {
					const migrated = await this.migrateReadyManifest(inspection);
					if (!migrated) return { status: 'conflict', message: 'The legacy managed-assets manifest changed.' };
					inspection = await this.inspect(root);
					if (inspection.assets.some((entry) => !isSettled(entry.status))) return { status: 'conflict', message: 'A managed asset changed during manifest migration.' };
					return { status: 'applied', inspection, ownership: 'existing' };
				}
				return { status: retiredAny ? 'applied' : 'unchanged', inspection, ownership: 'existing' };
			}
			const operation = await this.operation(inspection, kind);
			let journal = await this.begin(inspection, operation);
			if (!journal) {
				const raced = await this.inspect(root);
				if (raced.manifestStatus === 'ready' && raced.assets.every((asset) => isSettled(asset.status))) return { status: 'unchanged', inspection: raced, ownership: 'existing' };
				return { status: raced.manifestStatus === 'applying' ? 'busy' : 'conflict', message: 'The managed-assets manifest changed.' };
			}
			for (let index = 0; index < journal.pendingOperation!.steps.length; index += 1) {
				const step = journal.pendingOperation!.steps[index]!;
				if (step.state === 'done') continue;
				const asset = selectedAssets(this.bundle).find((candidate) => candidate.id === step.id);
				const registered = journal.assets.find((candidate) => candidate.id === step.id);
				if (!asset || !await this.writeAsset(step, asset, registered)) return { status: 'conflict', message: 'A managed asset changed during the operation.' };
				journal = await this.markDone(journal, index);
				if (!journal) {
					const raced = await this.inspect(root);
					if (raced.manifestStatus === 'ready' && raced.assets.every((entry) => isSettled(entry.status))) return { status: 'unchanged', inspection: raced, ownership: 'existing' };
					return { status: 'conflict', message: 'The operation journal changed.' };
				}
			}
			const finalized = await this.finalize(journal);
			if (!finalized) return { status: 'conflict', message: 'The operation could not be finalized.' };
			inspection = await this.inspect(root);
			return { status: finalized.changed ? 'applied' : 'unchanged', inspection, ownership };
		} catch (error) {
			return { status: 'unavailable', message: 'Managed assets could not be updated safely.', ...failureEvidence(error) };
		}
	}

	private async begin(
		inspection: ManagedAssetsInspection,
		operation: ManagedAssetsManifest['pendingOperation'],
		initialAssets: ManagedAssetEntry[] = [],
	): Promise<ManagedAssetsManifest | null> {
		if (!operation) return null;
		if (inspection.manifest?.state === 'applying') {
			return inspection.manifest.pendingOperation?.operationId === operation.operationId ? inspection.manifest : null;
		}
		const manifest: ManagedAssetsManifest = {
			schemaVersion: inspection.manifest?.schemaVersion ?? MANAGED_ASSETS_SCHEMA_VERSION,
			pluginId: 'tyrian-companion', root: inspection.root,
			bundleVersion: inspection.manifest?.bundleVersion ?? this.bundle.bundleVersion,
			generation: inspection.manifest?.generation ?? 0,
			locale: operation.kind === 'uninstall' ? inspection.manifest?.locale ?? this.bundle.locale : this.bundle.locale,
			state: 'applying',
			assets: this.withAdopted(inspection, operation.kind, inspection.manifest?.assets ?? initialAssets), pendingOperation: operation,
		};
		// An id is either registered or excluded, never both (the exact-set rule): a file taken over leaves the list.
		const stillExcluded = (inspection.manifest?.excluded ?? []).filter((id) => !manifest.assets.some((entry) => entry.id === id));
		if (stillExcluded.length > 0) manifest.excluded = stillExcluded;
		await ensureFolders(this.vault, inspection.root);
		const file = this.vault.file(inspection.manifestPath);
		const serialized = serializeManifest(manifest);
		if (!file) {
			try { await this.vault.create(inspection.manifestPath, serialized); }
			catch (error) { if (vaultFailureCause(error) !== undefined) throw error; /* create races are resolved by rereading */ }
			return await this.exactManifest(inspection.manifestPath, operation.operationId);
		}
		if (!inspection.manifest) {
			return await this.exactManifest(inspection.manifestPath, operation.operationId);
		}
		const expected = serializeManifest(inspection.manifest);
		let applied = false;
		// Every `process` update below decides `applied` on each run: a host may re-run it on a fresh read.
		await this.vault.process(file, (current) => {
			applied = normalizeLf(current) === expected;
			return applied ? serialized : current;
		});
		return applied ? await this.exactManifest(inspection.manifestPath, operation.operationId) : null;
	}

	/**
	 * A Base adopted by semantic hash is registered in the journal manifest at the version it was
	 * recognised as, so its `beforeHash` (the file as Obsidian left it) is legitimate evidence.
	 */
	private withAdopted(inspection: ManagedAssetsInspection, kind: ManagedOperationKind, entries: ManagedAssetEntry[]): ManagedAssetEntry[] {
		if (kind === 'uninstall') return entries;
		const adopted = inspection.assets.flatMap((entry) => entry.adopted && !entries.some((known) => known.id === entry.asset.id) ? [entry.adopted] : []);
		return adopted.length === 0 ? entries : [...entries, ...adopted];
	}

	/** `occupied_unowned` files are the user's: they get no step, no manifest entry and no write. */
	private async operation(inspection: ManagedAssetsInspection, kind: 'install' | 'upgrade' | 'repair') {
		const steps: ManagedOperationStep[] = inspection.assets.filter((entry) => entry.status !== 'occupied_unowned').map((entry) => ({
			id: entry.asset.id, path: entry.path,
			beforeHash: entry.currentHash === null ? null
				: entry.installedHash !== null && entry.currentHash !== entry.installedHash ? entry.installedHash : entry.currentHash,
			afterHash: entry.asset.contentHash, state: entry.status === 'unchanged' ? 'done' : 'pending',
		}));
		const generation = inspection.manifest?.generation ?? 0;
		return { operationId: await operationId(inspection.root, generation, this.bundle.bundleVersion, this.bundle.locale, kind, steps),
			kind, fromGeneration: generation, targetBundleVersion: this.bundle.bundleVersion, steps } as const;
	}

	private async writeAsset(step: ManagedOperationStep, asset: PackagedAsset, registered?: ManagedAssetEntry): Promise<boolean> {
		await ensureFolders(this.vault, step.path.slice(0, step.path.lastIndexOf('/')));
		const file = this.vault.file(step.path);
		if (!file) {
			if (step.beforeHash !== null) return false;
			try { await this.vault.create(step.path, asset.bytes); }
			catch (error) { if (vaultFailureCause(error) !== undefined) throw error; /* create race is checked below */ }
			return await this.hashAt(step.path) === step.afterHash;
		}
		const expectedContent = normalizeLf(await this.vault.read(file));
		const currentHash = await sha256Text(expectedContent);
		if (currentHash === step.afterHash) return true;
		if (currentHash !== step.beforeHash && (!registered || !await this.matchesInstalledContent(expectedContent, currentHash, registered, asset))) return false;
		let applied = false;
		await this.vault.process(file, (current) => {
			applied = normalizeLf(current) === expectedContent;
			return applied ? asset.bytes : current;
		});
		return applied && await this.hashAt(step.path) === step.afterHash;
	}

	private async markDone(manifest: ManagedAssetsManifest, index: number): Promise<ManagedAssetsManifest | null> {
		const next = structuredClone(manifest);
		next.pendingOperation!.steps[index]!.state = 'done';
		const applied = await this.casManifest(manifest, next);
		if (applied) return applied;
		const raced = await this.exactManifest(manifestPath(manifest.root), manifest.pendingOperation!.operationId);
		return raced?.pendingOperation?.steps[index]?.state === 'done' ? raced : null;
	}

	private async migrateReadyManifest(inspection: ManagedAssetsInspection): Promise<ManagedAssetsManifest | null> {
		const manifest = inspection.manifest;
		if (!manifest || manifest.schemaVersion !== 1 || manifest.state !== 'ready') return null;
		const installed: ManagedAssetEntry[] = [];
		for (const inspected of inspection.assets) {
			if (inspected.status === 'occupied_unowned') continue;
			if (inspected.status !== 'unchanged' || inspected.currentHash === null) return null;
			if (await this.hashAt(inspected.path) !== inspected.currentHash) return null;
			const entry: ManagedAssetEntry = {
				id: inspected.asset.id, kind: inspected.asset.kind, contentVersion: inspected.asset.contentVersion,
				locale: inspected.asset.locale, path: inspected.path, installedHash: inspected.currentHash,
			};
			if (inspected.asset.kind === 'base') {
				if (inspected.currentSemanticHash === null) return null;
				entry.installedSemanticHash = inspected.currentSemanticHash;
			}
			installed.push(entry);
		}
		const next: ManagedAssetsManifest = {
			...manifest, schemaVersion: MANAGED_ASSETS_SCHEMA_VERSION,
			generation: manifest.generation + 1, assets: installed,
		};
		return await this.casManifest(manifest, next);
	}

	/**
	 * `adopted` carries the exact entries a relocation adoption already verified (possibly
	 * registered at an older contentVersion than the packaged bundle, per `relocationAdoption`).
	 * When present for an asset, it replaces the bundle's own version/hash as the expected
	 * evidence, because that adopted content is deliberately not upgraded here; ordinary
	 * install/upgrade/repair never pass it, so their finalize behavior is unchanged.
	 */
	private async finalize(manifest: ManagedAssetsManifest, adopted: ManagedAssetEntry[] = []): Promise<{ manifest: ManagedAssetsManifest; changed: boolean } | null> {
		const installed: ManagedAssetEntry[] = [];
		// Only what the journal touched is registered: a file left out as the user's stays out.
		const journaled = manifest.pendingOperation ? new Set(manifest.pendingOperation.steps.map((step) => step.id)) : null;
		for (const asset of selectedAssets(this.bundle)) {
			if (journaled && !journaled.has(asset.id)) continue;
			const path = managedAssetPath(manifest.root, asset);
			const file = this.vault.file(path);
			if (!file) return null;
			const content = normalizeLf(await this.vault.read(file));
			const installedHash = await sha256Text(content);
			const override = adopted.find((entry) => entry.id === asset.id);
			const entry: ManagedAssetEntry = {
				id: asset.id, kind: asset.kind, contentVersion: override?.contentVersion ?? asset.contentVersion, locale: asset.locale,
				path, installedHash,
			};
			if (asset.kind === 'base') {
				const installedSemanticHash = await baseSemanticHash(content);
				const expectedSemanticHash = override ? override.installedSemanticHash ?? null : (await this.packaged(asset)).semanticHash;
				if (installedSemanticHash === null || expectedSemanticHash === null || installedSemanticHash !== expectedSemanticHash) return null;
				entry.installedSemanticHash = installedSemanticHash;
			} else if (override ? installedHash !== override.installedHash : (installedHash !== asset.contentHash || !hasCompatibleMarker(content, asset))) return null;
			installed.push(entry);
		}
		const next: ManagedAssetsManifest = { ...manifest, schemaVersion: MANAGED_ASSETS_SCHEMA_VERSION,
			bundleVersion: this.bundle.bundleVersion,
			generation: manifest.generation + 1, locale: this.bundle.locale, state: 'ready', assets: installed };
		delete next.pendingOperation;
		const excluded = journaled ? selectedAssets(this.bundle).filter((asset) => !journaled.has(asset.id)).map((asset) => asset.id) : [];
		if (excluded.length > 0) next.excluded = excluded; else delete next.excluded;
		const applied = await this.casManifest(manifest, next);
		if (applied) return { manifest: applied, changed: true };
		const raced = await this.exactManifest(manifestPath(manifest.root));
		return raced?.state === 'ready' && raced.bundleVersion === this.bundle.bundleVersion && raced.locale === this.bundle.locale
			? { manifest: raced, changed: false } : null;
	}

	private async uninstallInternal(root: string): Promise<ManagedAssetsResult> {
		try {
			const inspection = await this.inspectForUninstall(root);
				if (inspection.manifest?.state === 'detached') return { status: 'unchanged', inspection, ownership: 'existing' };
				if (!inspection.manifest) return { status: 'conflict', message: 'No owned managed bundle exists.' };
			let journal: ManagedAssetsManifest | null;
			if (inspection.manifest.state === 'applying') {
				if (inspection.manifest.pendingOperation?.kind !== 'uninstall') return { status: 'busy', message: 'Another managed-assets operation is active.' };
				journal = inspection.manifest;
			} else {
				for (const entry of inspection.manifest.assets) {
					const file = this.vault.file(entry.path);
					if (!file) continue;
					const content = normalizeLf(await this.vault.read(file));
					const currentHash = await sha256Text(content);
					const target = this.bundle.assets.find((asset) => asset.id === entry.id && asset.kind === entry.kind && asset.locale === entry.locale);
					if (!await this.matchesInstalledOrPublished(content, currentHash, entry, target)) return { status: 'conflict', message: 'Modified managed assets are preserved.' };
				}
				const steps: ManagedOperationStep[] = inspection.manifest.assets.map((entry) => ({
					id: entry.id, path: entry.path, beforeHash: entry.installedHash, afterHash: null, state: 'pending',
				}));
				const operation = { operationId: await operationId(root, inspection.manifest.generation, inspection.manifest.bundleVersion, inspection.manifest.locale, 'uninstall', steps),
					kind: 'uninstall' as const, fromGeneration: inspection.manifest.generation,
					targetBundleVersion: inspection.manifest.bundleVersion, steps };
				journal = await this.begin(inspection, operation);
			}
			if (!journal) return { status: 'conflict', message: 'The manifest changed.' };
			for (let index = 0; index < journal.pendingOperation!.steps.length; index += 1) {
				const step = journal.pendingOperation!.steps[index]!;
				if (step.state === 'done') continue;
				const entry = journal.assets.find((candidate) => candidate.id === step.id);
				if (!entry) return { status: 'conflict', message: 'The uninstall journal is invalid.' };
				const tombstone = tombstoneFor(entry.kind, journal.pendingOperation!.operationId);
				const file = this.vault.file(step.path);
				if (file) {
					const content = normalizeLf(await this.vault.read(file));
					if (content !== tombstone) {
						const currentHash = await sha256Text(content);
						const target = this.bundle.assets.find((asset) => asset.id === entry.id && asset.kind === entry.kind && asset.locale === entry.locale);
						if (!await this.matchesInstalledOrPublished(content, currentHash, entry, target)) return { status: 'conflict', message: 'A managed asset changed before removal.' };
						let applied = false;
						await this.vault.process(file, (current) => { applied = normalizeLf(current) === content; return applied ? tombstone : current; });
						if (!applied || normalizeLf(await this.vault.read(file)) !== tombstone) return { status: 'conflict', message: 'A managed asset changed during removal.' };
					}
					await this.vault.trashFile(file);
				}
				journal = await this.markDone(journal, index);
				if (!journal) return { status: 'conflict', message: 'The uninstall journal changed.' };
			}
			const detached = structuredClone(journal);
			detached.state = 'detached';
			detached.generation += 1;
			delete detached.pendingOperation;
			const saved = await this.casManifest(journal, detached);
			if (!saved) {
				const raced = await this.exactManifest(manifestPath(root));
				if (raced?.state !== 'detached') return { status: 'conflict', message: 'Uninstall could not be finalized.' };
			}
			return { status: 'detached', inspection: await this.inspectForUninstall(root), ownership: 'existing' };
		} catch (error) { return { status: 'unavailable', message: 'Managed assets could not be removed safely.', ...failureEvidence(error) }; }
	}

	private async casManifest(before: ManagedAssetsManifest, after: ManagedAssetsManifest): Promise<ManagedAssetsManifest | null> {
		const path = manifestPath(before.root);
		const file = this.vault.file(path);
		if (!file) return null;
		const expected = serializeManifest(before);
		let applied = false;
		await this.vault.process(file, (current) => { applied = normalizeLf(current) === expected; return applied ? serializeManifest(after) : current; });
		return applied ? await this.exactManifest(path, after.pendingOperation?.operationId) : null;
	}

	private async exactManifest(path: string, operationId?: string): Promise<ManagedAssetsManifest | null> {
		const read = await this.readManifest(path);
		if (read.status !== 'valid') return null;
		return operationId === undefined || read.manifest.pendingOperation?.operationId === operationId ? read.manifest : null;
	}

	private async readManifest(path: string): Promise<{ status: 'missing' } | { status: 'unsupported' | 'conflict' } | { status: 'valid'; manifest: ManagedAssetsManifest }> {
		const file = this.vault.file(path);
		if (!file) return { status: 'missing' };
		try {
			const raw: unknown = JSON.parse(await this.vault.read(file));
			if (isManagedAssetsManifest(raw)) return { status: 'valid', manifest: raw };
			if (typeof raw === 'object' && raw !== null && 'schemaVersion' in raw && Number(raw.schemaVersion) > MANAGED_ASSETS_SCHEMA_VERSION) return { status: 'unsupported' };
			return { status: 'conflict' };
		} catch { return { status: 'conflict' }; }
	}

	private retiredAsPackaged(): PackagedAsset[] {
		return (this.bundle.retired ?? []).map((asset) => ({ ...asset, contentVersion: 0, bytes: '', contentHash: '' }));
	}

	private async validManifestRelations(manifest: ManagedAssetsManifest, root: string, legacy = false): Promise<boolean> {
		if (manifest.root !== root) return false;
		const assetIds = new Set<string>();
		const assetPaths = new Set<string>();
		const finalState = manifest.state === 'ready' || manifest.state === 'detached';
		const assetsForManifestLocale = selectedAssetsForLocale(this.bundle, manifest.locale);
		const relatedAssets = finalState ? assetsForManifestLocale : this.bundle.assets;
		for (const entry of manifest.assets) {
			const folded = entry.path.normalize('NFC').toLocaleLowerCase();
			// A retired asset may still be registered by a manifest of an older bundle until the next apply drops it.
			const asset = [...relatedAssets, ...(finalState ? this.retiredAsPackaged() : [])].find((candidate) => candidate.id === entry.id && candidate.kind === entry.kind &&
				candidate.locale === entry.locale && entry.path === managedAssetPath(root, candidate));
			if (assetIds.has(entry.id) || assetPaths.has(folded) || !asset ||
				(finalState && entry.locale !== 'neutral' && entry.locale !== manifest.locale) ||
				!validManagedPath(entry.path, this.configDir, legacy) || !entry.path.startsWith(`${root}/`)) return false;
			if (manifest.schemaVersion === 2 && entry.kind === 'base' && entry.contentVersion === asset.contentVersion &&
				entry.installedSemanticHash !== (await this.packaged(asset)).semanticHash) return false;
			assetIds.add(entry.id); assetPaths.add(folded);
		}
		// The set stays exact, but a file the user owns at an asset's path may be declared `excluded`
		// instead of registered: it is in exactly one of the two lists, never in neither.
		const excluded = manifest.excluded ?? [];
		const retiredIds = new Set((this.bundle.retired ?? []).map((asset) => asset.id));
		if (new Set(excluded).size !== excluded.length || excluded.some((id) => manifest.assets.some((entry) => entry.id === id) ||
			(!assetsForManifestLocale.some((asset) => asset.id === id) && !retiredIds.has(id)))) return false;
		if (finalState && manifest.bundleVersion === this.bundle.bundleVersion) {
			if (manifest.assets.length + excluded.filter((id) => !retiredIds.has(id)).length !== assetsForManifestLocale.length ||
				assetsForManifestLocale.some((asset) => !excluded.includes(asset.id) && !manifest.assets.some((entry) => entry.id === asset.id &&
					entry.kind === asset.kind && entry.locale === asset.locale && entry.path === managedAssetPath(root, asset)))) return false;
		}
		if (manifest.state !== 'applying') return true;
		const operation = manifest.pendingOperation!;
		if (operation.fromGeneration !== manifest.generation) return false;
		const expectedEntries = operation.kind === 'uninstall'
			? manifest.assets.map((entry) => ({ id: entry.id, path: entry.path, beforeHash: entry.installedHash, afterHash: null }))
			: selectedAssets(this.bundle).map((asset) => ({ id: asset.id, path: managedAssetPath(root, asset), beforeHash: undefined, afterHash: asset.contentHash }));
		// Uninstall walks the registered set exactly; the others may omit files the user owns.
		if (operation.kind === 'uninstall' ? operation.steps.length !== expectedEntries.length
			: operation.steps.length === 0 || operation.steps.length > expectedEntries.length) return false;
		const stepIds = new Set<string>();
		const stepPaths = new Set<string>();
		for (const step of operation.steps) {
			const expected = expectedEntries.find((entry) => entry.id === step.id);
			const folded = step.path.normalize('NFC').toLocaleLowerCase();
			const registered = manifest.assets.find((entry) => entry.id === step.id) ?? null;
			const allowedBeforeHashes = operation.kind === 'uninstall'
				? [expected?.beforeHash]
				: [null, expected?.afterHash, registered?.installedHash];
			if (!expected || stepIds.has(step.id) || stepPaths.has(folded) || step.path !== expected.path ||
				!validManagedPath(step.path, this.configDir, legacy) || !step.path.startsWith(`${root}/`) ||
				step.afterHash !== expected.afterHash || !allowedBeforeHashes.includes(step.beforeHash)) return false;
			stepIds.add(step.id); stepPaths.add(folded);
		}
		if (operation.kind === 'uninstall' && operation.targetBundleVersion !== manifest.bundleVersion) return false;
		if (operation.kind !== 'uninstall' && operation.targetBundleVersion !== this.bundle.bundleVersion) return false;
		if (operation.operationId === await operationId(root, operation.fromGeneration, operation.targetBundleVersion, manifest.locale, operation.kind, operation.steps)) return true;
		const legacyInitialSteps = operation.steps.map((step): ManagedOperationStep => {
			const registered = manifest.assets.find((entry) => entry.id === step.id);
			const target = selectedAssetsForLocale(this.bundle, manifest.locale).find((asset) => asset.id === step.id);
			const initiallyDone = operation.kind !== 'uninstall' && step.beforeHash !== null && registered !== undefined && target !== undefined &&
				registered.contentVersion === target.contentVersion && (registered.kind === 'base' || step.beforeHash === step.afterHash);
			return { ...step, state: initiallyDone ? 'done' : 'pending' };
		});
		return operation.operationId === await legacyOperationId(root, operation.fromGeneration, operation.targetBundleVersion,
			manifest.locale, operation.kind, legacyInitialSteps);
	}

	private async hashAt(path: string): Promise<string | null> {
		const file = this.vault.file(path);
		return file ? await sha256Text(normalizeLf(await this.vault.read(file))) : null;
	}

	private async matchesInstalledContent(
		content: string,
		currentHash: string,
		entry: ManagedAssetEntry,
		target?: PackagedAsset,
		targetSemanticHash?: string | null,
	): Promise<boolean> {
		if (currentHash === entry.installedHash && hasInstalledMarker(content, entry)) return true;
		if (entry.kind !== 'base') return false;
		const expectedSemanticHash = entry.installedSemanticHash ??
			(target?.kind === 'base' && target.id === entry.id && target.contentVersion === entry.contentVersion && target.locale === entry.locale
				? targetSemanticHash ?? (await this.packaged(target)).semanticHash
				: null);
		if (expectedSemanticHash === null) return false;
		return await baseSemanticHash(content) === expectedSemanticHash;
	}
}

function validManagedPath(path: string, configDir: string, legacy: boolean): boolean {
	if (!legacy) return normalizeManagedAssetPath(path, configDir) !== null;
	const legacyPath = legacyVaultFolder(path, configDir);
	if (legacyPath === null) return false;
	const file = legacyPath.split('/').at(-1) ?? '';
	return file === 'Tyrian Companion Assets.json' || file.endsWith('.base') || file.endsWith('.md');
}

function selectedAssets(bundle: ManagedAssetsBundle): PackagedAsset[] {
	return selectedAssetsForLocale(bundle, bundle.locale);
}
function selectedAssetsForLocale(bundle: ManagedAssetsBundle, locale: ManagedAssetsBundle['locale']): PackagedAsset[] {
	return bundle.assets.filter((asset) => asset.locale === 'neutral' || asset.locale === locale)
		.sort((a, b) => a.id.localeCompare(b.id));
}
function validateRoot(root: string, configDir: string): string | null {
	return normalizeManagedAssetPath(`${root}/${'Tyrian Companion Assets.json'}`, configDir) ? root : null;
}
function validateBundle(bundle: ManagedAssetsBundle, root: string, configDir: string): void {
	if (!Number.isSafeInteger(bundle.bundleVersion) || bundle.bundleVersion <= 0) throw new Error('invalid_bundle');
	const ids = new Set<string>();
	const paths = new Set<string>();
	for (const asset of selectedAssets(bundle)) {
		const path = managedAssetPath(root, asset);
		const folded = path.normalize('NFC').toLocaleLowerCase();
		if (!asset.id || ids.has(asset.id) || paths.has(folded) || normalizeManagedAssetPath(path, configDir) === null ||
			asset.bytes.includes('\r') || !hasCompatibleMarker(asset.bytes, asset)) throw new Error('invalid_bundle');
		ids.add(asset.id); paths.add(folded);
	}
}
/** Highest published contentVersion (never above the bundle's) of this Base whose meaning is `semanticHash`. */
function publishedVersionOf(published: readonly PublishedBaseFingerprint[], asset: PackagedAsset, semanticHash: string): number | null {
	const versions = published
		.filter((row) => row.assetId === asset.id && row.locale === asset.locale && row.semanticHash === semanticHash &&
			row.contentVersion <= asset.contentVersion)
		.map((row) => row.contentVersion);
	return versions.length === 0 ? null : Math.max(...versions);
}
/**
 * The explicit «Replace» reads each CONFIRMED `occupied_unowned` file as one the plugin may overwrite: it
 * becomes an `update` whose «installed» evidence is the very bytes inspected, so the write is compare-and-swap
 * against them. An unowned file whose id is not in `confirmed` stays `occupied_unowned`, so the journal gives it
 * no step and nothing writes it.
 */
function claimUnowned(inspection: ManagedAssetsInspection, confirmed: ReadonlySet<string>): ManagedAssetsInspection {
	return {
		...inspection,
		assets: inspection.assets.map((entry) => {
			if (entry.status !== 'occupied_unowned' || entry.currentHash === null || !confirmed.has(entry.asset.id)) return entry;
			const adopted: ManagedAssetEntry = {
				id: entry.asset.id, kind: entry.asset.kind, contentVersion: entry.asset.contentVersion, locale: entry.asset.locale,
				path: entry.path, installedHash: entry.currentHash,
				...(entry.asset.kind === 'base' ? { installedSemanticHash: entry.currentSemanticHash ?? entry.currentHash } : {}),
			};
			return { ...entry, status: 'update' as const, installedHash: entry.currentHash, adopted };
		}),
	};
}
/** An unchanged asset needs no write, and an unowned one is left alone: neither is work for the journal. */
function isSettled(status: InspectedAsset['status']): boolean { return status === 'unchanged' || status === 'occupied_unowned'; }
function normalizeLf(value: string): string { return value.replace(/\r\n?/gu, '\n'); }
async function operationId(root: string, generation: number, targetBundleVersion: number, locale: string, kind: ManagedOperationKind, steps: ManagedOperationStep[]): Promise<string> {
	return await sha256Text(JSON.stringify([root, generation, targetBundleVersion, locale, kind,
		steps.map(({ id, path, beforeHash, afterHash }) => ({ id, path, beforeHash, afterHash }))]));
}
async function legacyOperationId(root: string, generation: number, targetBundleVersion: number, locale: string, kind: ManagedOperationKind, steps: ManagedOperationStep[]): Promise<string> {
	return await sha256Text(JSON.stringify([root, generation, targetBundleVersion, locale, kind, steps]));
}
function hasInstalledMarker(content: string, entry: ManagedAssetEntry): boolean {
	const first = normalizeLf(content).split('\n', 1)[0] ?? '';
	return first.includes('tyrian-companion-managed') && first.includes(`id=${entry.id}`) &&
		first.includes(`kind=${entry.kind}`) && first.includes(`version=${entry.contentVersion}`) &&
		first.includes(`locale=${entry.locale}`);
}
function tombstoneFor(kind: ManagedAssetEntry['kind'], operation: string): string {
	const marker = `tyrian-companion-managed tombstone operation=${operation}`;
	return kind === 'base' ? `# ${marker}\n` : `<!-- ${marker} -->\n`;
}
function serializeManifest(value: ManagedAssetsManifest): string { return `${JSON.stringify(value, null, 2)}\n`; }

/**
 * Hashes what a base MEANS, so a reformatted file is not mistaken for an edited one.
 *
 * This is the one place the `yaml` dependency cannot be traded for Obsidian's
 * own `parseYaml`, and the reason is the OPTIONS rather than the parsing: the
 * host signature is `parseYaml(yaml: string): any`, with nowhere to ask for the
 * four things this hash is built on. `uniqueKeys` and the `errors`/`warnings`
 * lists are what make an ambiguous file unhashable instead of silently hashed;
 * `mapAsMap` is what lets `canonicalYamlValue` refuse a non-string key rather
 * than watch it be coerced into one; and `maxAliasCount: 0` is what stops an
 * anchor from expanding, which on a file the plugin fetches is a decompression
 * bomb with a YAML syntax. Swapping in a parser that answers a plain value
 * would also move the hash itself, and every installed asset would read as
 * drifted on the next check.
 */
export async function baseSemanticHash(content: string): Promise<string | null> {
	try {
		const document = parseDocument(normalizeLf(content), { prettyErrors: false, uniqueKeys: true });
		if (document.errors.length > 0 || document.warnings.length > 0) return null;
		const value: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
		return await sha256Text(canonicalYamlValue(value, new Set<object>()));
	} catch {
		return null;
	}
}

function canonicalYamlValue(value: unknown, ancestors: Set<object>): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
	if (typeof value === 'boolean') return value ? 'boolean:true' : 'boolean:false';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('non_finite_yaml_number');
		return `number:${Object.is(value, -0) ? 0 : String(value)}`;
	}
	if (typeof value !== 'object') throw new Error('unsupported_yaml_value');
	if (ancestors.has(value)) throw new Error('cyclic_yaml_value');
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return `array:[${value.map((entry) => canonicalYamlValue(entry, ancestors)).join(',')}]`;
		if (value instanceof Map) {
			const entries = [...value.entries()].map(([key, entry]) => {
				if (typeof key !== 'string') throw new Error('non_string_yaml_key');
				return [key, canonicalYamlValue(entry, ancestors)] as const;
			}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
			return `map:{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${entry}`).join(',')}}`;
		}
		throw new Error('unsupported_yaml_object');
	} finally {
		ancestors.delete(value);
	}
}

async function ensureFolders(vault: ManagedAssetsVault, folder: string): Promise<void> {
	await ensureFoldersBySegments(vault, folder, 'folder_create_failed');
}
