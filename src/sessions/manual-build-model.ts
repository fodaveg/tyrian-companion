import { canonicalJson } from '../core/canonical-sha256';
import { MAX_BUILD_TEMPLATE_CODE_LENGTH, parseBuildTemplate, type DecodedBuildTemplateV1 } from './build-template-parser';
export type { DecodedBuildTemplateV1 } from './build-template-parser';

/** The independent raw draft is retained even when it cannot be interpreted as a build. */
export interface FarmingDeclaredBuildPreferenceV1 { version:1; templateCode:string; label:string|null }
/** A manual template declaration does not certify the build was active or describe equipment. */
export interface DeclaredBuildV1 {
	version:1; source:'manual_template'; label:string|null;
	templateCode:string; configuration:DecodedBuildTemplateV1;
}
export type FarmingDeclaredBuildReadResult = {status:'empty'} | {status:'valid';value:DeclaredBuildV1}
	| {status:'invalid' | 'unsupported';reason:string};
export const MAX_DECLARED_BUILD_LABEL_LENGTH = 120;

/** One normalizer shared by editor, start capture and portable history validation; no I/O. */
export function readFarmingDeclaredBuild(value: unknown): FarmingDeclaredBuildReadResult {
	if (value === undefined || value === null) return {status:'empty'};
	if (!record(value) || !keys(value,['version','templateCode','label']) || value.version !== 1
		|| typeof value.templateCode !== 'string' || value.templateCode.length > MAX_BUILD_TEMPLATE_CODE_LENGTH
		|| !label(value.label)) return {status:'invalid',reason:'invalid_preference'};
	if (value.templateCode.trim().length === 0) return {status:'empty'};
	const parsed = parseBuildTemplate(value.templateCode);
	if (parsed.status !== 'valid') return parsed;
	return {status:'valid',value:{version:1,source:'manual_template',label:value.label === null ? null : value.label.trim() || null,
		templateCode:parsed.templateCode,configuration:parsed.configuration}};
}

/** Restoration redecodes the code and requires the exact known configuration, including zeros. */
export function isDeclaredBuild(value: unknown): value is DeclaredBuildV1 {
	if (!record(value) || !keys(value,['version','source','label','templateCode','configuration'])
		|| value.version !== 1 || value.source !== 'manual_template' || !label(value.label)) return false;
	const parsed = parseBuildTemplate(value.templateCode);
	return parsed.status === 'valid' && value.templateCode === parsed.templateCode
		&& sameShape(value.configuration,parsed.configuration);
}

/** Identity excludes label, textual encoding and the unrelated Nexus executable build hash. */
export function manualBuildIdentityInput(value: DeclaredBuildV1): string {
	if (!isDeclaredBuild(value)) throw new Error('The declared build is invalid.');
	return canonicalJson({version:value.version,source:value.source,configuration:value.configuration});
}
function label(value:unknown):value is string|null {
	return value === null || typeof value === 'string' && value.length <= MAX_DECLARED_BUILD_LABEL_LENGTH && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function record(value:unknown):value is Record<string,unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
function keys(value:Record<string,unknown>,expected:string[]):boolean {return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');}

/** Recursively compare JSON fields so foreign keys/prototypes cannot bypass a persisted shape. */
function sameShape(value:unknown, expected:unknown):boolean {
	if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length
		&& Object.keys(value).length === expected.length && expected.every((entry,index) => sameShape(value[index],entry));
	if (record(expected)) return record(value) && Object.getPrototypeOf(value) === Object.prototype
		&& keys(value,Object.keys(expected)) && Object.entries(expected).every(([key,entry]) => sameShape(value[key],entry));
	return value === expected;
}
