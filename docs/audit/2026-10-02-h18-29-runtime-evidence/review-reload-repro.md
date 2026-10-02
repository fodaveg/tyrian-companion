# Review reproduction: skipped cycle accepted as a reload

Executed against `9f415f303833cf97b4b74bd3c7b6ab0c04b7fdfe`, from `/home/fodaveg/code/tyrian-companion/.claude/worktrees/install-smoke-honesty-20261002`.
This preserves the executed review probe and its captured output; it is not a fresh execution against the fixed candidate.

Command:

```sh
node --input-type=module <<'NODE'
import { readFileSync, realpathSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync('scripts/dev-install.mjs', 'utf8');
const functionSource = source.slice(source.indexOf('function reloadPlugin('), source.indexOf('/** `pluginDir`'));
const completed = [];
const app = { vault: { adapter: { getBasePath: () => '/tmp/.' } }, plugins: {
 isEnabled: () => true, enabledPlugins: new Set(['tyrian-companion']),
 manifests: { 'tyrian-companion': { version: '1' } }, plugins: { 'tyrian-companion': { manifest: { version: '1' } } },
 async loadManifests() { completed.push('manifests'); }, async disablePlugin() { completed.push('disable'); }, async enablePlugin() { completed.push('enable'); }
} };
let stdout;
const runCli = ({ args }) => {
 const promise = runInNewContext(args[1].slice('code='.length), { app });
 if (completed.length !== 0) throw new Error('Probe expected guard-only evidence');
 return { status: 0, stdout };
};
const context = { realpathSync, process: { platform: process.platform }, JSON, PLUGIN_ID: 'tyrian-companion', RELOAD_EVIDENCE_PREFIX: 'TYRIAN_DEV_RELOAD_V1\t', isRecord: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), fail: (code) => { throw new Error(code); } };
const reload = runInNewContext(functionSource + '\nreloadPlugin', context);
let expression;
try { reload(({args}) => { expression = args[1].slice('code='.length); return { status: 0, stdout: '' }; }, 'unused', '/tmp', '1'); } catch {}
stdout = await runInNewContext(expression, { app });
const evidence = reload(runCli, 'unused', '/tmp', '1');
console.log(JSON.stringify({ accepted: true, cycle: completed, expectedCanonical: realpathSync('/tmp'), reportedPath: evidence.vaultPath, version: evidence.loadedVersion }));
NODE
```

Captured output (exit 0):

```json
{"accepted":true,"cycle":[],"expectedCanonical":"/tmp","reportedPath":"/tmp/.","version":"1"}
```

Fix reviewed in `c8d34c623cc74f4eee9717e3a6d35a21d8be871d`: a strict `reloadCompleted === true` is required, and only emitted after all three awaited reload operations.
