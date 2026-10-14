/**
 * Why a vault operation could not even be tried, as a closed code the Settings row and the local
 * diagnostic can name (Hebra, 10 oct 2026: all of these used to end in the same «not available»).
 * A host puts it on the `code` of the error it throws; callers read it with `vaultFailureCause`,
 * which also follows `Error.cause`, because the folder helpers re-throw under their own message.
 *
 * - `bytes_not_synced`: the library lists the file but this device has not received its bytes yet.
 * - `output_folder_missing`: the output folder is not in the library, so there is nowhere to write. Only a
 *   press of Apply, Repair or Replace creates it (`TyrianVault.createOutputFolder`); when that fails the core
 *   says `output_folder_create_failed` instead (`ManagedAssetsFailureCause`).
 * - `host_refused`: the host blocks every write for now (a restart is pending).
 */
export const VAULT_FAILURE_CAUSES = ['bytes_not_synced', 'output_folder_missing', 'host_refused'] as const;
export type VaultFailureCause = typeof VAULT_FAILURE_CAUSES[number];

export function vaultFailure(message: string, cause: VaultFailureCause): Error {
	return Object.assign(new Error(message), { code: cause });
}

export function vaultFailureCause(error: unknown): VaultFailureCause | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(current, 'code');
		const code: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
		const found = VAULT_FAILURE_CAUSES.find((cause) => cause === code);
		if (found !== undefined) return found;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Why a vault WRITE failed once the host did try it, as a closed code for the local diagnostic. Kept apart
 * from `VaultFailureCause` on purpose: that one reaches the Settings row, and these three have no wording there.
 *
 * - `write_not_converged`: `process`/`saveNote` lost the compare-and-swap on every attempt (a persistent conflict).
 * - `entry_not_indexed`: the path is not in the host's index, so there is nothing to read or rewrite.
 * - `entry_missing`: the indexed note or file is gone, trashed or protected when it was read.
 */
export const VAULT_WRITE_FAILURE_CAUSES = ['write_not_converged', 'entry_not_indexed', 'entry_missing'] as const;
export type VaultWriteFailureCause = typeof VAULT_WRITE_FAILURE_CAUSES[number];

export function vaultWriteFailure(message: string, cause: VaultWriteFailureCause): Error {
	return Object.assign(new Error(message), { code: cause });
}

export function vaultWriteFailureCause(error: unknown): VaultWriteFailureCause | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(current, 'code');
		const code: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
		const found = VAULT_WRITE_FAILURE_CAUSES.find((cause) => cause === code);
		if (found !== undefined) return found;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** The closed local-debug code for a vault write failure: never `unknown_failure` for a cause the host named. */
export function vaultWriteFailureLogCode(cause: VaultWriteFailureCause): 'precondition_failed' | 'missing' {
	return cause === 'write_not_converged' ? 'precondition_failed' : 'missing';
}
