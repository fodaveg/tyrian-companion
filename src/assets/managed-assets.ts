import { parseDocument } from 'yaml';

import { sha256Text } from './managed-asset-hash';
import { legacyVaultFolder } from '../core/settings';
import {
	hasCompatibleMarker,
	isManagedAssetsManifest,
	MANAGED_ASSETS_SCHEMA_VERSION,
	managedAssetPath,
	manifestPath,
	normalizeManagedAssetPath,
	planManagedAssets,
	type InspectedAsset,
	type ManagedAssetEntry,
	type ManagedAssetsInspection,
	type ManagedAssetsManifest,
	type ManagedAssetsPlan,
	type ManagedOperationKind,
	type ManagedOperationStep,
	type PackagedAsset,
} from './managed-assets-model';

export interface ManagedAssetFile { path: string }
export interface ManagedAssetsVault {
	file(path: string): ManagedAssetFile | null;
	read(file: ManagedAssetFile): Promise<string>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<ManagedAssetFile>;
	process(file: ManagedAssetFile, update: (content: string) => string): Promise<string>;
	trashFile(file: ManagedAssetFile): Promise<void>;
}

export type ManagedAssetsResult =
	| { status: 'applied' | 'unchanged' | 'detached'; inspection: ManagedAssetsInspection; ownership: 'created' | 'existing' }
	| { status: 'busy' | 'conflict' | 'invalid' | 'unavailable'; message: string };

export interface ManagedAssetsBundle {
	bundleVersion: number;
	locale: 'es' | 'en';
	assets: PackagedAsset[];
}

/** Explicit, journaled Vault-only asset lifecycle. Construction and inspection setup have no I/O. */
export class ManagedAssetsManager {
	private flight: { key: string; promise: Promise<ManagedAssetsResult> } | null = null;

	constructor(
		private readonly vault: ManagedAssetsVault,
		private readonly configDir: string,
		private bundle: ManagedAssetsBundle,
	) {}

	/** Replaces packaged evidence only between explicit operations; it performs no Vault I/O. */
	setBundle(bundle: ManagedAssetsBundle): void {
		if (this.flight) throw new Error('managed_assets_busy');
		this.bundle = bundle;
	}

	async inspect(root: string): Promise<ManagedAssetsInspection> {
		const validatedRoot = validateRoot(root, this.configDir);
		if (!validatedRoot) throw new Error('invalid_root');
		validateBundle(this.bundle, validatedRoot, this.configDir);
		const targetManifestPath = manifestPath(validatedRoot);
		const manifestRead = await this.readManifest(targetManifestPath);
		const manifestMatchesRoot = manifestRead.status === 'valid' && await this.validManifestRelations(manifestRead.manifest, validatedRoot);
		const manifest = manifestMatchesRoot ? manifestRead.manifest : null;
		const assets: InspectedAsset[] = [];
		for (const asset of selectedAssets(this.bundle)) {
			if (await sha256Text(asset.bytes) !== asset.contentHash) throw new Error('invalid_bundle_hash');
			const targetSemanticHash = asset.kind === 'base' ? await baseSemanticHash(asset.bytes) : null;
			if (asset.kind === 'base' && targetSemanticHash === null) throw new Error('invalid_bundle_yaml');
			const path = managedAssetPath(validatedRoot, asset);
			if (!normalizeManagedAssetPath(path, this.configDir)) throw new Error('invalid_asset_path');
			const file = this.vault.file(path);
			const registered = manifest?.assets.find((entry) => entry.id === asset.id) ?? null;
			if (!file) {
				assets.push({ asset, path, status: registered ? 'missing' : 'create', currentHash: null, currentSemanticHash: null, installedHash: registered?.installedHash ?? null });
				continue;
			}
			const content = normalizeLf(await this.vault.read(file));
			const currentHash = await sha256Text(content);
			const currentSemanticHash = asset.kind === 'base' ? await baseSemanticHash(content) : null;
			let status: InspectedAsset['status'];
			if (!registered) status = currentHash === asset.contentHash && hasCompatibleMarker(content, asset) ? 'recoverable' : 'occupied_unowned';
			else if (registered.contentVersion > asset.contentVersion || manifest!.bundleVersion > this.bundle.bundleVersion) status = 'newer_than_plugin';
			else if (!await this.matchesInstalledContent(content, currentHash, registered, asset, targetSemanticHash)) status = 'modified';
			else status = currentHash === asset.contentHash ||
				(asset.kind === 'base' && registered.contentVersion === asset.contentVersion && currentSemanticHash === targetSemanticHash)
				? 'unchanged' : 'update';
			assets.push({ asset, path, status, currentHash, currentSemanticHash, installedHash: registered?.installedHash ?? null });
		}
		const manifestStatus = manifestRead.status === 'missing' ? 'missing'
			: manifestRead.status === 'unsupported' ? 'unsupported_manifest'
			: manifestRead.status === 'conflict' || !manifestMatchesRoot ? 'conflict' : manifest!.state;
		return { root: validatedRoot, manifestPath: targetManifestPath, manifest, manifestStatus, bundleVersion: this.bundle.bundleVersion, locale: this.bundle.locale, assets };
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

	apply(root: string, kind: Exclude<ManagedOperationKind, 'relocate' | 'uninstall'> = 'install'): Promise<ManagedAssetsResult> {
		const key = this.flightKey(root, kind);
		if (this.flight) return this.flight.key === key ? this.flight.promise : Promise.resolve({ status: 'busy', message: 'Another managed-assets operation is active.' });
		const promise = this.applyInternal(root, kind).finally(() => { if (this.flight?.promise === promise) this.flight = null; });
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

	private flightKey(root: string, kind: ManagedOperationKind): string {
		return JSON.stringify([root, kind, this.bundle.bundleVersion, this.bundle.locale,
			selectedAssets(this.bundle).map(({ id, contentVersion, locale, relativePath, contentHash }) => [id, contentVersion, locale, relativePath, contentHash])]);
	}

	private async applyInternal(root: string, kind: 'install' | 'upgrade' | 'repair'): Promise<ManagedAssetsResult> {
		try {
			let inspection = await this.inspect(root);
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
						if (raced.manifestStatus === 'ready' && raced.assets.every((entry) => entry.status === 'unchanged')) return { status: 'unchanged', inspection: raced, ownership: 'existing' };
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
			if (plan.steps.every((step) => step.status === 'unchanged')) {
				if (inspection.manifest?.schemaVersion === 1) {
					const migrated = await this.migrateReadyManifest(inspection);
					if (!migrated) return { status: 'conflict', message: 'The legacy managed-assets manifest changed.' };
					inspection = await this.inspect(root);
					if (inspection.assets.some((entry) => entry.status !== 'unchanged')) return { status: 'conflict', message: 'A managed asset changed during manifest migration.' };
					return { status: 'applied', inspection, ownership: 'existing' };
				}
				return { status: 'unchanged', inspection, ownership: 'existing' };
			}
			const operation = await this.operation(inspection, kind);
			let journal = await this.begin(inspection, operation);
			if (!journal) {
				const raced = await this.inspect(root);
				if (raced.manifestStatus === 'ready' && raced.assets.every((asset) => asset.status === 'unchanged')) return { status: 'unchanged', inspection: raced, ownership: 'existing' };
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
					if (raced.manifestStatus === 'ready' && raced.assets.every((entry) => entry.status === 'unchanged')) return { status: 'unchanged', inspection: raced, ownership: 'existing' };
					return { status: 'conflict', message: 'The operation journal changed.' };
				}
			}
			const finalized = await this.finalize(journal);
			if (!finalized) return { status: 'conflict', message: 'The operation could not be finalized.' };
			inspection = await this.inspect(root);
			return { status: finalized.changed ? 'applied' : 'unchanged', inspection, ownership };
		} catch {
			return { status: 'unavailable', message: 'Managed assets could not be updated safely.' };
		}
	}

	private async begin(inspection: ManagedAssetsInspection, operation: ManagedAssetsManifest['pendingOperation']): Promise<ManagedAssetsManifest | null> {
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
			assets: inspection.manifest?.assets ?? [], pendingOperation: operation,
		};
		await ensureFolders(this.vault, inspection.root);
		const file = this.vault.file(inspection.manifestPath);
		const serialized = serializeManifest(manifest);
		if (!file) {
			try { await this.vault.create(inspection.manifestPath, serialized); }
			catch { /* create races are resolved by rereading */ }
			return await this.exactManifest(inspection.manifestPath, operation.operationId);
		}
		if (!inspection.manifest) {
			return await this.exactManifest(inspection.manifestPath, operation.operationId);
		}
		const expected = serializeManifest(inspection.manifest);
		let applied = false;
		await this.vault.process(file, (current) => {
			if (normalizeLf(current) !== expected) return current;
			applied = true;
			return serialized;
		});
		return applied ? await this.exactManifest(inspection.manifestPath, operation.operationId) : null;
	}

	private async operation(inspection: ManagedAssetsInspection, kind: 'install' | 'upgrade' | 'repair') {
		const steps: ManagedOperationStep[] = inspection.assets.map((entry) => ({
			id: entry.asset.id, path: entry.path,
			beforeHash: entry.installedHash !== null && entry.currentHash !== entry.installedHash ? entry.installedHash : entry.currentHash,
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
			catch { /* create race is checked below */ }
			return await this.hashAt(step.path) === step.afterHash;
		}
		const expectedContent = normalizeLf(await this.vault.read(file));
		const currentHash = await sha256Text(expectedContent);
		if (currentHash === step.afterHash) return true;
		if (currentHash !== step.beforeHash && (!registered || !await this.matchesInstalledContent(expectedContent, currentHash, registered, asset))) return false;
		let applied = false;
		await this.vault.process(file, (current) => {
			if (normalizeLf(current) === expectedContent) { applied = true; return asset.bytes; }
			return current;
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

	private async finalize(manifest: ManagedAssetsManifest): Promise<{ manifest: ManagedAssetsManifest; changed: boolean } | null> {
		const installed: ManagedAssetEntry[] = [];
		for (const asset of selectedAssets(this.bundle)) {
			const path = managedAssetPath(manifest.root, asset);
			const file = this.vault.file(path);
			if (!file) return null;
			const content = normalizeLf(await this.vault.read(file));
			const installedHash = await sha256Text(content);
			const entry: ManagedAssetEntry = {
				id: asset.id, kind: asset.kind, contentVersion: asset.contentVersion, locale: asset.locale,
				path, installedHash,
			};
			if (asset.kind === 'base') {
				const [installedSemanticHash, packagedSemanticHash] = await Promise.all([
					baseSemanticHash(content), baseSemanticHash(asset.bytes),
				]);
				if (installedSemanticHash === null || installedSemanticHash !== packagedSemanticHash) return null;
				entry.installedSemanticHash = installedSemanticHash;
			} else if (installedHash !== asset.contentHash || !hasCompatibleMarker(content, asset)) return null;
			installed.push(entry);
		}
		const next: ManagedAssetsManifest = { ...manifest, schemaVersion: MANAGED_ASSETS_SCHEMA_VERSION,
			bundleVersion: this.bundle.bundleVersion,
			generation: manifest.generation + 1, locale: this.bundle.locale, state: 'ready', assets: installed };
		delete next.pendingOperation;
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
					if (!await this.matchesInstalledContent(content, currentHash, entry, target)) return { status: 'conflict', message: 'Modified managed assets are preserved.' };
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
						if (!await this.matchesInstalledContent(content, currentHash, entry, target)) return { status: 'conflict', message: 'A managed asset changed before removal.' };
						let applied = false;
						await this.vault.process(file, (current) => { if (normalizeLf(current) === content) { applied = true; return tombstone; } return current; });
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
		} catch { return { status: 'unavailable', message: 'Managed assets could not be removed safely.' }; }
	}

	private async casManifest(before: ManagedAssetsManifest, after: ManagedAssetsManifest): Promise<ManagedAssetsManifest | null> {
		const path = manifestPath(before.root);
		const file = this.vault.file(path);
		if (!file) return null;
		const expected = serializeManifest(before);
		let applied = false;
		await this.vault.process(file, (current) => { if (normalizeLf(current) === expected) { applied = true; return serializeManifest(after); } return current; });
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

	private async validManifestRelations(manifest: ManagedAssetsManifest, root: string, legacy = false): Promise<boolean> {
		if (manifest.root !== root) return false;
		const assetIds = new Set<string>();
		const assetPaths = new Set<string>();
		const finalState = manifest.state === 'ready' || manifest.state === 'detached';
		const assetsForManifestLocale = selectedAssetsForLocale(this.bundle, manifest.locale);
		const relatedAssets = finalState ? assetsForManifestLocale : this.bundle.assets;
		for (const entry of manifest.assets) {
			const folded = entry.path.normalize('NFC').toLocaleLowerCase();
			const asset = relatedAssets.find((candidate) => candidate.id === entry.id && candidate.kind === entry.kind &&
				candidate.locale === entry.locale && entry.path === managedAssetPath(root, candidate));
			if (assetIds.has(entry.id) || assetPaths.has(folded) || !asset ||
				(finalState && entry.locale !== 'neutral' && entry.locale !== manifest.locale) ||
				!validManagedPath(entry.path, this.configDir, legacy) || !entry.path.startsWith(`${root}/`)) return false;
			if (manifest.schemaVersion === 2 && entry.kind === 'base' && entry.contentVersion === asset.contentVersion &&
				entry.installedSemanticHash !== await baseSemanticHash(asset.bytes)) return false;
			assetIds.add(entry.id); assetPaths.add(folded);
		}
		if (finalState && manifest.bundleVersion === this.bundle.bundleVersion) {
			if (manifest.assets.length !== assetsForManifestLocale.length ||
				assetsForManifestLocale.some((asset) => !manifest.assets.some((entry) => entry.id === asset.id && entry.kind === asset.kind &&
					entry.locale === asset.locale && entry.path === managedAssetPath(root, asset)))) return false;
		}
		if (manifest.state !== 'applying') return true;
		const operation = manifest.pendingOperation!;
		if (operation.fromGeneration !== manifest.generation) return false;
		const expectedEntries = operation.kind === 'uninstall'
			? manifest.assets.map((entry) => ({ id: entry.id, path: entry.path, beforeHash: entry.installedHash, afterHash: null }))
			: selectedAssets(this.bundle).map((asset) => ({ id: asset.id, path: managedAssetPath(root, asset), beforeHash: undefined, afterHash: asset.contentHash }));
		if (operation.steps.length !== expectedEntries.length) return false;
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
		return operation.operationId === await operationId(root, operation.fromGeneration, operation.targetBundleVersion, manifest.locale, operation.kind, operation.steps);
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
				? targetSemanticHash ?? await baseSemanticHash(target.bytes)
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
function normalizeLf(value: string): string { return value.replace(/\r\n?/gu, '\n'); }
async function operationId(root: string, generation: number, targetBundleVersion: number, locale: string, kind: ManagedOperationKind, steps: ManagedOperationStep[]): Promise<string> {
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

async function baseSemanticHash(content: string): Promise<string | null> {
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
	let current = '';
	for (const segment of folder.split('/')) {
		current = current ? `${current}/${segment}` : segment;
		if (!vault.file(current)) {
			try { await vault.createFolder(current); }
			catch { if (!vault.file(current)) throw new Error('folder_create_failed'); }
		}
	}
}
