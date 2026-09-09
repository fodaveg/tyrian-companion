/**
 * Type declarations for `security-scan.mjs`, hand-written because the `scripts/` tree is plain
 * JS and outside `tsconfig.json`'s `include`. Only the surface `src/security-boundary.test.ts`
 * (H14.17, lote L) actually imports; extend it if another `.test.ts` needs more of the scanner.
 */

export const SECURITY_SCANNER_VERSION: number;

export interface SecurityFinding {
	readonly rule: string;
	readonly path: string;
}

export function scanSecurityBoundaries(root?: string): readonly SecurityFinding[];
export function scanReleaseArtifacts(root: string, relativePaths: readonly string[]): readonly SecurityFinding[];

/** Every production `.ts` module under `src/`, repository-relative, sorted; no tests or fixtures. */
export function productionSourceFiles(root?: string): readonly string[];

export interface NetworkAndCredentialCapabilityCensus {
	readonly requestUrl: readonly string[];
	readonly fetch: readonly string[];
	readonly webSocket: readonly string[];
	readonly httpImport: readonly string[];
	readonly netImport: readonly string[];
	readonly secretProviderImport: readonly string[];
	readonly secretCapability: readonly string[];
}

export function censusNetworkAndCredentialCapabilities(root?: string): NetworkAndCredentialCapabilityCensus;
export function isSensitivePersistenceBoundary(path: string, root?: string): boolean;
export function persistenceBoundaryHasCredentialCapability(path: string, root?: string): boolean;
export function isFutureOutboundFile(path: string): boolean;
