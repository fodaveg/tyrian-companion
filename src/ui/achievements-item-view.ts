import type { TyrianUiPort } from '../host/tyrian-host';
import { createTranslator, type Locale } from '../core/i18n';
import { AchievementsView, type AchievementsViewActions } from './achievements-view';
import { sectionViewDescriptor, type TyrianSectionDescriptor, type TyrianSectionViewSlot, type TyrianViewDescriptor } from './mounted-views';
import type { ProductActionController } from './product-action-controller';
import { renderProductShell, type ProductShellMount } from './product-shell';

export const ACHIEVEMENTS_VIEW_TYPE = 'tyrian-achievements-view';

export interface AchievementsItemViewActions extends AchievementsViewActions {
	getProductActionController?(): ProductActionController;
	/** True while the host itself lists the sections (its main screen), so the shell builds no bar of tabs. Absent means false. */
	hostListsSections?(): boolean;
}

/** The Achievements section, wherever a host shows it. The badge is how many achievements are followed; none shows nothing. */
export function achievementsSection(actions: Pick<AchievementsItemViewActions, 'getLocale' | 'getTrackedAchievementIds'>): TyrianSectionDescriptor {
	return {
		id: 'achievements',
		title: () => createTranslator(actions.getLocale()).t('achievements.view.title'),
		label: () => createTranslator(actions.getLocale()).t('shell.nav.achievements'),
		icon: 'trophy',
		badge: () => {
			const count = actions.getTrackedAchievementIds().length;
			return count === 0 ? null : count;
		},
	};
}

/** Where the Achievements section is a view of its own: in Hebra, the 960×720 dialog, like Inventory and Sale. */
export const ACHIEVEMENTS_VIEW_SLOT: TyrianSectionViewSlot = { type: ACHIEVEMENTS_VIEW_TYPE, placement: 'dialog' };

/** The Achievements tab for `TyrianUiPort.registerView`: its section in its slot. */
export function achievementsView(actions: Pick<AchievementsItemViewActions, 'getLocale' | 'getTrackedAchievementIds'>): TyrianViewDescriptor {
	return sectionViewDescriptor(achievementsSection(actions), ACHIEVEMENTS_VIEW_SLOT);
}

/**
 * The Achievements tab's controller, mounted by the host into `contentEl`: the product shell (the
 * four tabs, or none where the host lists the sections) around an `AchievementsView`. Opening it
 * reads the public catalog and the kept reading; nothing here calls the API with the key.
 */
export class AchievementsItemView {
	private closed = false;
	private sectionHidden = false;
	private productShell: ProductShellMount | null = null;
	private productShellKey: string | null = null;
	private view: AchievementsView | null = null;
	private viewLocale: Locale | null = null;

	constructor(
		readonly contentEl: HTMLElement,
		private readonly ui: Pick<TyrianUiPort, 'setIcon'>,
		private readonly actions: AchievementsItemViewActions,
	) {}

	async onOpen(): Promise<void> {
		this.closed = false;
		this.sectionHidden = false;
		this.render();
	}

	/** The host hid this section, or showed it again, without unmounting it. Hidden, nothing is painted; shown again, the view reads again. */
	setVisible(visible: boolean): void {
		if (visible === !this.sectionHidden) return;
		this.sectionHidden = !visible;
		this.view?.setVisible(visible);
	}

	/** Stops the view's loads and waits (the index build, the search debounce). Idempotent; the runtime calls it on unload. */
	cancelLoads(): void {
		this.closed = true;
		this.view?.dispose();
		this.view = null;
		this.viewLocale = null;
	}

	async onClose(): Promise<void> {
		this.cancelLoads();
		this.productShell?.dispose();
		this.productShell = null;
		this.productShellKey = null;
	}

	/** The core changed something the section shows: the shell is remade when its facts change, the view reads again. */
	render(): void {
		if (this.closed || this.sectionHidden) return;
		const locale = this.actions.getLocale();
		const actionController = this.actions.getProductActionController?.();
		const missingApiKey = !this.actions.hasConfiguredApiKey();
		const navigation = !(this.actions.hostListsSections?.() ?? false);
		const shellKey = `${locale}:${String(missingApiKey)}:${String(navigation)}`;
		if (actionController !== undefined && (this.productShell === null || this.productShellKey !== shellKey)) {
			this.productShell?.dispose();
			this.view?.dispose();
			this.view = null;
			this.productShell = renderProductShell(this.contentEl, {
				locale,
				active: 'achievements',
				actions: actionController,
				missingApiKey,
				openSettings: () => this.actions.openProductSettings?.(),
				ui: this.ui,
				navigation,
			});
			this.productShellKey = shellKey;
		}
		const surface = this.productShell?.content ?? this.contentEl;
		this.productShell?.update();
		// A language change remakes the view (its labels are read once, on mount); anything else is a refresh.
		if (this.view === null || this.viewLocale !== locale) {
			this.view?.dispose();
			this.view = new AchievementsView(surface, this.actions);
			this.viewLocale = locale;
			this.view.mount();
			return;
		}
		this.view.refresh();
	}
}
