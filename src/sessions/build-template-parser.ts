/** Known binary build-template fields, without claiming active equipment or API skill IDs. */
interface BuildPaletteBarV1 { heal: number; utilities: [number,number,number]; elite: number }
export interface DecodedBuildTemplateV1 {
	profession: 'Guardian' | 'Warrior' | 'Engineer' | 'Ranger' | 'Thief' | 'Elementalist' | 'Mesmer' | 'Necromancer' | 'Revenant';
	specializations: { id: number; traitSelections: [number,number,number] }[];
	skills: { terrestrial: BuildPaletteBarV1; aquatic: BuildPaletteBarV1 };
	rangerPets: [number,number,number,number] | null;
	revenantLegends: [number,number,number,number] | null;
	inactiveLegendUtilities: { terrestrial: [number,number,number]; aquatic: [number,number,number] } | null;
	/** Legacy templates have no weapon/override section; absent coverage is not an empty array. */
	weaponTypes: number[] | null;
	skillOverrides: number[] | null;
}
export const MAX_BUILD_TEMPLATE_CODE_LENGTH = 4096;
type BuildTemplateFailureReason = 'invalid_format' | 'invalid_base64' | 'wrong_header' | 'truncated' | 'too_long'
	| 'unsupported_profession' | 'reserved_bits' | 'unknown_profession_data' | 'unknown_extension';
type BuildTemplateParseResult = {status:'valid';templateCode:string;configuration:DecodedBuildTemplateV1}
	| {status:'invalid' | 'unsupported';reason:BuildTemplateFailureReason};
const PROFESSIONS = ['Guardian','Warrior','Engineer','Ranger','Thief','Elementalist','Mesmer','Necromancer','Revenant'] as const;

/**
 * Parses the documented 0x0D format locally. Palette IDs remain palettes, traits remain tier
 * selections, and unknown reserved bytes/tails never certify structural build equivalence.
 */
export function parseBuildTemplate(code: unknown): BuildTemplateParseResult {
	if (typeof code !== 'string') return {status:'invalid',reason:'invalid_format'};
	if (code.length > MAX_BUILD_TEMPLATE_CODE_LENGTH) return {status:'invalid',reason:'too_long'};
	const match = /^\[&([A-Za-z0-9+/]+={0,2})\]$/u.exec(code.trim());
	if (!match) return {status:'invalid',reason:'invalid_format'};
	const encoded = match[1]!;
	if (encoded.length % 4 === 1 || encoded.includes('=') && encoded.length % 4 !== 0) return {status:'invalid',reason:'invalid_base64'};
	let binary: string;
	try { binary = atob(encoded); } catch { return {status:'invalid',reason:'invalid_base64'}; }
	const canonical = btoa(binary);
	if (encoded.replace(/=+$/u,'') !== canonical.replace(/=+$/u,'')) return {status:'invalid',reason:'invalid_base64'};
	const bytes = Uint8Array.from(binary,(character) => character.charCodeAt(0));
	if (bytes[0] !== 0x0d) return {status:'invalid',reason:'wrong_header'};
	if (bytes.length < 44) return {status:'invalid',reason:'truncated'};
	const profession = PROFESSIONS[bytes[1]! - 1];
	if (!profession) return {status:'unsupported',reason:'unsupported_profession'};
	const view = new DataView(bytes.buffer); const u16 = (at:number) => view.getUint16(at,true);
	const specializations:DecodedBuildTemplateV1['specializations'] = [];
	for (let index=0;index<3;index++) {
		const traits = bytes[3 + index*2]!;
		if ((traits & 0xc0) !== 0) return {status:'unsupported',reason:'reserved_bits'};
		specializations.push({id:bytes[2 + index*2]!,traitSelections:[traits & 3,(traits >>> 2) & 3,(traits >>> 4) & 3]});
	}
	const bar = (aquatic:number):BuildPaletteBarV1 => ({heal:u16(8+aquatic*2),
		utilities:[u16(12+aquatic*2),u16(16+aquatic*2),u16(20+aquatic*2)],elite:u16(24+aquatic*2)});
	let rangerPets:DecodedBuildTemplateV1['rangerPets'] = null;
	let revenantLegends:DecodedBuildTemplateV1['revenantLegends'] = null;
	let inactiveLegendUtilities:DecodedBuildTemplateV1['inactiveLegendUtilities'] = null;
	if (profession === 'Ranger') {
		rangerPets = [bytes[28]!,bytes[29]!,bytes[30]!,bytes[31]!];
		if (bytes.slice(32,44).some((byte) => byte !== 0)) return {status:'unsupported',reason:'unknown_profession_data'};
	} else if (profession === 'Revenant') {
		revenantLegends = [bytes[28]!,bytes[29]!,bytes[30]!,bytes[31]!];
		inactiveLegendUtilities = {terrestrial:[u16(32),u16(34),u16(36)],aquatic:[u16(38),u16(40),u16(42)]};
	} else if (bytes.slice(28,44).some((byte) => byte !== 0)) return {status:'unsupported',reason:'unknown_profession_data'};
	let weaponTypes:number[] | null = null; let skillOverrides:number[] | null = null; let position = 44;
	if (bytes.length > position) {
		weaponTypes = []; skillOverrides = [];
		const weaponCount = bytes[position++]!;
		if (position + weaponCount*2 > bytes.length) return {status:'invalid',reason:'truncated'};
		for (let index=0;index<weaponCount;index++,position+=2) weaponTypes.push(u16(position));
		if (bytes.length === position) return {status:'invalid',reason:'truncated'};
		if (bytes.length > position) {
			const overrideCount = bytes[position++]!;
			if (position + overrideCount*4 > bytes.length) return {status:'invalid',reason:'truncated'};
			for (let index=0;index<overrideCount;index++,position+=4) skillOverrides.push(view.getUint32(position,true));
		}
	}
	if (position !== bytes.length) return {status:'unsupported',reason:'unknown_extension'};
	return {status:'valid',templateCode:`[&${canonical}]`,configuration:{profession,specializations,
		skills:{terrestrial:bar(0),aquatic:bar(1)},rangerPets,revenantLegends,inactiveLegendUtilities,weaponTypes,skillOverrides}};
}
