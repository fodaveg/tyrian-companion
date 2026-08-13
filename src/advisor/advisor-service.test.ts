import { describe, expect, it } from 'vitest';

import { AdvisorService } from './advisor-service';

describe('AdvisorService', () => {
	it('asks for configuration without inventing recommendations', () => {
		const advisor = new AdvisorService({ isConfigured: () => false });

		expect(advisor.getSnapshot()).toMatchObject({ status: 'needs-api-key' });
	});

	it('reports only foundation readiness when configured', () => {
		const advisor = new AdvisorService({ isConfigured: () => true });

		expect(advisor.getSnapshot()).toEqual({
			status: 'ready',
			title: 'Foundation ready',
			detail: 'Account sync and recommendations are not enabled in this version.',
		});
	});
});
