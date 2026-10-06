import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBuildTemplate, type DecodedBuildTemplateV1 } from './build-template-parser';
import { isDeclaredBuild, manualBuildIdentityInput, readFarmingDeclaredBuild } from './manual-build-model';

interface PrimarySample {name:string;code:string;professionCode:number;specializations:{id:number;choices:number[]}[];
	skillPalettesInterleaved:number[];pets?:number[];legends?:number[];inactiveTerrestrialPalettes?:number[];inactiveAquaticPalettes?:number[];
	weapons:number[];overrideSkillIds:number[]}
const primary=JSON.parse(readFileSync(new URL('./__fixtures__/build-template-chatlinks.json',import.meta.url),'utf8')) as {samples:PrimarySample[]};
const ranger=primary.samples.find((sample) => sample.name === 'rangerPetSample')!;
function bytes(code:string):Uint8Array {return Uint8Array.from(atob(code.slice(2,-1)),(character) => character.charCodeAt(0));}
function code(raw:Uint8Array):string {return `[&${btoa(String.fromCharCode(...raw))}]`;}
function declared(templateCode=ranger.code,label:string|null=null) {
	const result=readFarmingDeclaredBuild({version:1,templateCode,label});
	if (result.status !== 'valid') throw new Error('Test declaration did not parse.');
	return result.value;
}

describe('local manual GW2 template declaration', () => {
	it.each(primary.samples)('decodes every known position from upstream real sample $name', (sample) => {
		const result=parseBuildTemplate(sample.code); expect(result.status).toBe('valid'); if (result.status !== 'valid') return;
		const config=result.configuration;
		expect(config.profession).toBe(['Guardian','Warrior','Engineer','Ranger','Thief','Elementalist','Mesmer','Necromancer','Revenant'][sample.professionCode-1]);
		expect(config.specializations).toEqual(sample.specializations.map((slot) => ({id:slot.id,traitSelections:slot.choices})));
		for (const [offset,bar] of [[0,config.skills.terrestrial],[1,config.skills.aquatic]] as const) {
			expect([bar.heal,...bar.utilities,bar.elite]).toEqual([0,2,4,6,8].map((index) => sample.skillPalettesInterleaved[index+offset]));
		}
		expect(config.rangerPets).toEqual(sample.pets ?? null); expect(config.revenantLegends).toEqual(sample.legends ?? null);
		expect(config.inactiveLegendUtilities).toEqual(sample.legends ? {terrestrial:sample.inactiveTerrestrialPalettes,aquatic:sample.inactiveAquaticPalettes} : null);
		expect(config.weaponTypes).toEqual(sample.weapons); expect(config.skillOverrides).toEqual(sample.overrideSkillIds);
		expect(isDeclaredBuild(declared(sample.code))).toBe(true);
	});
	it('keeps legacy absent tail unknown and requires both modern array counts', () => {
		const legacy=bytes(ranger.code).slice(0,44); const result=parseBuildTemplate(code(legacy));
		expect(result).toMatchObject({status:'valid',configuration:{weaponTypes:null,skillOverrides:null}});
		expect(parseBuildTemplate(code(Uint8Array.from([...legacy,0])))).toEqual({status:'invalid',reason:'truncated'});
		expect(parseBuildTemplate(code(Uint8Array.from([...legacy,0,0])))).toMatchObject({status:'valid',configuration:{weaponTypes:[],skillOverrides:[]}});
	});
	it.each([0,1,2])('rejects nonzero reserved trait bits in specialization slot %s', (slot) => {
		const raw=bytes(ranger.code); raw[3+slot*2]=0xc0;
		expect(parseBuildTemplate(code(raw))).toEqual({status:'unsupported',reason:'reserved_bits'});
	});
	it('rejects unknown profession bytes and trailing extensions without grouping opaque bytes', () => {
		const raw=bytes(ranger.code); raw[32]=1;
		expect(parseBuildTemplate(code(raw))).toEqual({status:'unsupported',reason:'unknown_profession_data'});
		expect(parseBuildTemplate(code(Uint8Array.from([...bytes(ranger.code),1])))).toEqual({status:'unsupported',reason:'unknown_extension'});
		const unknown=bytes(ranger.code); unknown[1]=255; expect(parseBuildTemplate(code(unknown))).toEqual({status:'unsupported',reason:'unsupported_profession'});
	});
	it.each(['[&AA==]','[&DQ==]','[&DQQ=]','[&x]','[&DQ*=]','not a link','[&DQ===]'])('rejects malformed, wrong-header or truncated input %s', (input) => {
		expect(parseBuildTemplate(input).status).toBe('invalid');
	});
	it('refuses declared weapon/override counts beyond available bytes', () => {
		const base=bytes(ranger.code).slice(0,44);
		for (const tail of [[3],[0,2],[1,5,0,1,0]]) expect(parseBuildTemplate(code(Uint8Array.from([...base,...tail])))).toEqual({status:'invalid',reason:'truncated'});
	});
	it('preserves zero slots and little-endian high unsigned override IDs', () => {
		const raw=Uint8Array.from([...bytes(ranger.code).slice(0,44),1,0,0,1,255,255,255,255]); raw[28]=0;
		expect(parseBuildTemplate(code(raw))).toMatchObject({status:'valid',configuration:{rangerPets:[0,59,20,63],weaponTypes:[0],skillOverrides:[4294967295]}});
	});
	it('canonicalizes equivalent Base64 spelling and excludes label/code spelling from identity', () => {
		const a=declared(); const b=declared(`  ${ranger.code.replace(/=\]$/u,']')}  `,'Different label');
		expect(b.templateCode).toBe(a.templateCode); expect(manualBuildIdentityInput(b)).toBe(manualBuildIdentityInput(a));
		const altered=bytes(ranger.code); altered[28]=0; expect(manualBuildIdentityInput(declared(code(altered)))).not.toBe(manualBuildIdentityInput(a));
	});
	it('restoration rejects mismatched configuration, foreign fields and noncanonical code', () => {
		const value=declared(); expect(isDeclaredBuild({...value,configuration:{...value.configuration,extra:1}})).toBe(false);
		expect(isDeclaredBuild({...value,configuration:{...value.configuration,weaponTypes:[50,35]}})).toBe(false);
		expect(isDeclaredBuild({...value,templateCode:value.templateCode.replace(/=\]$/u,']')})).toBe(false);
		expect(isDeclaredBuild({...value,source:'verified'})).toBe(false); expect(isDeclaredBuild({...value,fingerprint:'fabricated'})).toBe(false);
		const holes=new Array(3) as DecodedBuildTemplateV1['specializations']; expect(isDeclaredBuild({...value,configuration:{...value.configuration,specializations:holes}})).toBe(false);
	});
	it('reports empty, invalid and unsupported drafts without consulting a previous valid declaration', () => {
		expect(readFarmingDeclaredBuild(null)).toEqual({status:'empty'}); expect(readFarmingDeclaredBuild({version:1,templateCode:' ',label:null})).toEqual({status:'empty'});
		expect(readFarmingDeclaredBuild({version:1,templateCode:'bad',label:null})).toMatchObject({status:'invalid'});
		expect(readFarmingDeclaredBuild({version:1,templateCode:ranger.code,label:null,extra:'foreign'})).toMatchObject({status:'invalid'});
		const reserved=bytes(ranger.code); reserved[32]=1; expect(readFarmingDeclaredBuild({version:1,templateCode:code(reserved),label:null})).toMatchObject({status:'unsupported'});
		expect(readFarmingDeclaredBuild({version:1,templateCode:'a'.repeat(4097),label:null})).toMatchObject({status:'invalid'});
	});
});
