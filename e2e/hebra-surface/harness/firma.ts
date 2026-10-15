/**
 * The author signature (`hebra.json.minisig`) Hebra demands before installing a release, made with
 * Hebra's TEST key: the fixed seed of `src/lib/plugins/test-signing.ts` in Hebra (32 bytes of 7,
 * key id `hebrapru`), which is nobody's key and is not a secret. The fake catalogue pins its public
 * key (`TEST_SIGNING_KEY`), so the signature of the real `hebra.json` under test is computed here.
 * The real signing key (`~/.config/hebra-plugin-signing/`) is never read.
 *
 * Copied from Hebra `cfd4561f`, `src/lib/plugins/test-signing.ts` (`signForTest`, `publicKeyOf`) and
 * `e2e/plugin-signing.ts` (`releaseFileBytes`), rewritten over Node's own Ed25519 and BLAKE2b-512
 * instead of `@noble/*`, which this repository does not have. Same format as `minisign -S`: algorithm
 * `ED`, Ed25519 over the BLAKE2b-512 of the file, and the global signature over that signature plus
 * the trusted comment.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNATURE_FILE = 'hebra.json.minisig';

const SEED = Buffer.alloc(32, 7);
const KEY_ID = Buffer.from('hebrapru');
// PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
const PRIVATE_KEY = createPrivateKey({
	key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]),
	format: 'der',
	type: 'pkcs8',
});
const PUBLIC_KEY = createPublicKey(PRIVATE_KEY).export({ format: 'der', type: 'spki' }).subarray(-32);

/** The public key as the catalogue's `signingKey` carries it. */
export const TEST_SIGNING_KEY = Buffer.concat([Buffer.from('Ed'), KEY_ID, PUBLIC_KEY]).toString('base64');

/** The text of `hebra.json.minisig` for `message`. */
export function signForTest(message: Buffer): string {
	const signature = sign(null, createHash('blake2b512').update(message).digest(), PRIVATE_KEY);
	const trusted = 'timestamp:1792000000\tfile:hebra.json';
	const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), PRIVATE_KEY);
	return [
		'untrusted comment: signature from tauri secret key',
		Buffer.concat([Buffer.from('ED'), KEY_ID, signature]).toString('base64'),
		`trusted comment: ${trusted}`,
		global.toString('base64'),
		'',
	].join('\n');
}

/** The bytes of `name` in the release folder `dir`; the signature is computed over its `hebra.json`. */
export function releaseFileBytes(dir: string, name: string): Buffer {
	if (name === SIGNATURE_FILE) return Buffer.from(signForTest(readFileSync(join(dir, 'hebra.json'))));
	return readFileSync(join(dir, name));
}
