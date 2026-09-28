/**
 * The host-neutral entry Hebra imports (R1a, SPEC-TYRIAN-EN-HEBRA.md section 1): the runtime
 * factory, `canonicalPathFor` and the `TyrianHost` contract types. Nothing reachable from here may
 * import `obsidian`, `electron`, `net`, a Node builtin, or use `Buffer`/`process`:
 * `npm run build:host-esm` bundles this file and fails if it does. No CSS, no path aliases.
 */

export { createTyrianRuntime } from './tyrian-companion-core';
export { canonicalPathFor } from './canonical-path';
export type * from '../host/tyrian-host';
