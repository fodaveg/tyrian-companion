import { ItemView, type WorkspaceLeaf } from 'obsidian';

import type { AdvisorService } from '../advisor/advisor-service';

export const COMPANION_VIEW_TYPE = 'tyrian-companion-view';

export class TyrianCompanionView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly advisor: AdvisorService,
	) {
		super(leaf);
	}

	getViewType(): string {
		return COMPANION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Tyrian companion';
	}

	getIcon(): string {
		return 'compass';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	render(): void {
		const { contentEl } = this;
		const snapshot = this.advisor.getSnapshot();

		contentEl.empty();
		contentEl.addClass('tyrian-companion-view');
		contentEl.createEl('h2', { text: 'Tyrian companion' });
		contentEl.createEl('h3', { text: snapshot.title });
		contentEl.createEl('p', {
			text: snapshot.detail,
			cls: 'tyrian-companion-view__status',
		});

		contentEl.createEl('h3', { text: 'Modules' });
		const modules = contentEl.createEl('ul', { cls: 'tyrian-companion-view__modules' });
		for (const moduleName of ['Account', 'Advisor', 'Sessions', 'Objectives']) {
			modules.createEl('li', { text: moduleName });
		}
	}
}
