import { describe, expect, it } from 'vitest';

import { moduleSpecifiers } from './module-boundary';

describe('module boundary specifier parser', () => {
	it('keeps side-effect imports before and after imports with from', () => {
		const source = `
			import 'before-side-effect';
			import { middle } from 'middle-from';
			import 'after-side-effect';
		`;
		expect(moduleSpecifiers(source)).toEqual([
			'before-side-effect',
			'middle-from',
			'after-side-effect',
		]);
	});

	it('keeps commented side-effect import syntax without reading comments as modules', () => {
		const source = `
			// import 'comment-only';
			import /* before specifier */ 'commented-side-effect' /* after specifier */;
			/* import 'block-comment-only'; */
		`;
		expect(moduleSpecifiers(source)).toEqual(['commented-side-effect']);
	});

	it('keeps static, export, dynamic import and require literals in source order', () => {
		const source = `
			import type { A } from 'static-type';
			export { B } from 'export-from';
			const dynamic = import('dynamic-import', { with: { type: 'json' } });
			const required = require(\`required-module\`);
		`;
		expect(moduleSpecifiers(source)).toEqual([
			'static-type',
			'export-from',
			'dynamic-import',
			'required-module',
		]);
	});

	it('ignores module-like text and computed specifiers', () => {
		const source = `
			const text = "import 'string-only'";
			const template = \`require('template-only')\`;
			const moduleName = 'computed-module';
			void import(moduleName);
			require(moduleName);
		`;
		expect(moduleSpecifiers(source)).toEqual([]);
	});
});
