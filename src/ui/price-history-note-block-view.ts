import type { Translator } from '../core/i18n';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import { priceHistorySvgElement } from './price-history-panel-view';

/**
 * What the note-embedded piloto block draws. It never has a local `daily`
 * series of its own (the note is not a capture surface): `seed` is the panel's
 * datawars2 state, `undefined` while the plugin has not answered yet, and only
 * ever populated by `PriceHistoryNoteBlockController` calling `ensure`.
 */
export interface PriceHistoryNoteBlockState {
	/** `null` only when the block's own source could not be parsed at all. */
	itemId: number | null;
	/** Resolved from the note's own `tc_item_name` frontmatter, or the piloto's static fallback. */
	itemName: string | null;
	/** `false` for every item outside the four-item piloto allowlist, and for an unparseable block. */
	piloted: boolean;
	seed: PriceHistoryPanelSeedState | undefined;
}

/**
 * Mounts a small, self-contained chart into one note's rendered code block.
 * Draws with the exact same SVG engine as the settings panel (H9.1); this block
 * never shows local captures because a note is not where those are recorded.
 */
export function renderPriceHistoryNoteBlock(
	container: HTMLElement,
	translator: Translator,
	state: PriceHistoryNoteBlockState,
): void {
	container.replaceChildren();
	container.className = 'tyrian-price-history-note';
	const heading = createEl('p');
	heading.className = 'tyrian-price-history-note__heading';
	heading.textContent = state.itemId === null
		? translator.t('priceHistoryNote.headingUnknown')
		: state.itemName
			? translator.t('priceHistoryNote.headingNamed', { itemId: state.itemId, name: state.itemName })
			: translator.t('priceHistoryNote.heading', { itemId: state.itemId });
	container.append(heading);

	if (state.itemId === null) {
		appendState(container, translator.t('priceHistoryNote.state.malformed'), false);
		return;
	}
	if (!state.piloted) {
		appendState(container, translator.t('priceHistoryNote.state.notPiloted'), false);
		return;
	}
	if (state.seed === undefined || state.seed.status === 'idle' || state.seed.status === 'loading') {
		appendState(container, translator.t('priceHistoryNote.state.loading'), false);
		return;
	}
	if (state.seed.status === 'store_unavailable') {
		appendState(container, translator.t('priceHistoryNote.state.unavailable'), true);
		return;
	}
	if (state.seed.status === 'no_seed' || state.seed.days.length === 0) {
		appendState(container, translator.t('priceHistoryNote.state.noHistory'), true);
		return;
	}

	const figure = createEl('figure');
	const chart = createDiv();
	chart.className = 'tyrian-price-history-note__chart';
	chart.append(priceHistorySvgElement([], 'bid', state.seed.days, chart.ownerDocument));
	const legend = createEl('figcaption');
	legend.textContent = translator.t('priceHistoryNote.legend', { days: state.seed.days.length });
	figure.append(chart, legend);
	container.append(figure);
	// A refresh failure inside the 24h window keeps serving the stale cache (see
	// `price-seed-panel-service.ts`); the chart stays up, but this says why it may
	// be a day old instead of leaving that silent.
	if (state.seed.failureReason !== null) {
		appendState(container, translator.t('priceHistoryNote.state.staleCache'), false);
	}
}

function appendState(container: HTMLElement, text: string, alert: boolean): void {
	const paragraph = createEl('p');
	paragraph.className = 'tyrian-price-history-note__state';
	paragraph.setAttribute('aria-live', 'polite');
	if (alert) paragraph.setAttribute('role', 'alert');
	paragraph.textContent = text;
	container.append(paragraph);
}
