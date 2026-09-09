import { createTranslator, type Translator } from '../core/i18n';
import {
	formatLootMoney,
	localizedLootState,
	type LootPresentationRow,
	type LootPresentationV1,
} from '../sessions/loot-presentation';

export type LootPresentationLayout = 'wide' | 'compact' | 'ledger';

export function lootPresentationLayout(width: number): LootPresentationLayout {
	return width >= 760 ? 'wide' : width >= 480 ? 'compact' : 'ledger';
}

/** DOM-only adapter for the shared data-only H5.5 presentation. */
export function renderLootPresentationView(container: HTMLElement, presentation: LootPresentationV1): void {
	const t = createTranslator(presentation.locale);
	const section = createEl('section');
	section.className = 'tyrian-companion-loot';
	const region = lootPresentationRegionAttributes(presentation);
	section.setAttribute('aria-label', region['aria-label']);
	const heading = createEl('h3');
	heading.textContent = lootPresentationRegionLabel(presentation);
	section.append(heading);
	section.append(renderTable(presentation, t));
	section.append(renderCards(presentation, t));
	section.append(renderEconomy(presentation, t));
	container.append(section);
}

export function lootPresentationRegionLabel(presentation: Pick<LootPresentationV1, 'locale'>): string {
	return createTranslator(presentation.locale).t('loot.regionLabel');
}

export function lootPresentationRegionAttributes(
	presentation: Pick<LootPresentationV1, 'locale'>,
): { 'aria-label': string } {
	return { 'aria-label': lootPresentationRegionLabel(presentation) };
}

function renderTable(presentation: LootPresentationV1, t: Translator): HTMLTableElement {
	const table = createEl('table');
	table.className = 'tyrian-companion-loot__table';
	const caption = createEl('caption');
	caption.textContent = t.t('loot.tableCaption');
	table.append(caption);
	const headers = [
		t.t('loot.header.item'), t.t('loot.header.netDelta'), t.t('loot.header.reserved'), t.t('loot.header.hold'),
		t.t('loot.header.free'), t.t('loot.header.nowNet'), t.t('loot.header.listingNet'), t.t('loot.header.nextStep'),
		t.t('loot.header.destination'), t.t('loot.header.value'),
	];
	const head = createEl('thead');
	const headRow = createEl('tr');
	for (const [index, label] of headers.entries()) {
		const cell = createEl('th'); cell.scope = 'col'; cell.textContent = label;
		if (index >= 8) cell.className = 'tyrian-companion-loot__compact';
		headRow.append(cell);
	}
	head.append(headRow); table.append(head);
	const body = createEl('tbody');
	for (const row of presentation.rows) body.append(renderTableRow(row, presentation, t));
	table.append(body);
	return table;
}

function renderTableRow(row: LootPresentationRow, presentation: LootPresentationV1, t: Translator): HTMLTableRowElement {
	const tr = createEl('tr');
	const name = createEl('th'); name.scope = 'row'; name.textContent = row.name; tr.append(name);
	appendCell(tr, String(row.netQuantity));
	if (row.allocation.status === 'known') {
		appendCell(tr, String(row.allocation.reserved));
		appendCell(tr, String(row.allocation.held));
		appendCell(tr, String(row.allocation.free));
	} else {
		for (let index = 0; index < 3; index += 1) appendCell(tr, localizedLootState(presentation.locale, row.allocation.status));
	}
	appendCell(tr, valuation(row, 'immediate', presentation));
	appendCell(tr, valuation(row, 'listing', presentation));
	appendCell(tr, recommendation(row, presentation, t));
	appendCompactCell(tr, row.allocation.status === 'known'
		? `${String(row.allocation.reserved)} · ${String(row.allocation.held)} · ${String(row.allocation.free)}`
		: localizedLootState(presentation.locale, row.allocation.status));
	appendCompactCell(tr, `${valuation(row, 'immediate', presentation)} · ${valuation(row, 'listing', presentation)}`);
	return tr;
}

function renderCards(presentation: LootPresentationV1, t: Translator): HTMLElement {
	const list = createDiv(); list.className = 'tyrian-companion-loot__cards';
	for (const row of presentation.rows) {
		const article = createEl('article'); article.className = 'tyrian-companion-loot__card';
		const heading = createEl('h4'); heading.textContent = row.name; article.append(heading);
		article.append(definitionList(presentation, row, t));
		list.append(article);
	}
	return list;
}

function definitionList(presentation: LootPresentationV1, row: LootPresentationRow, t: Translator): HTMLDListElement {
	const dl = createEl('dl');
	addDefinition(dl, t.t('loot.netDelta'), String(row.netQuantity));
	addDefinition(dl, t.t('loot.destination'), row.allocation.status === 'known'
		? `${String(row.allocation.reserved)} · ${String(row.allocation.held)} · ${String(row.allocation.free)}`
		: localizedLootState(presentation.locale, row.allocation.status));
	addDefinition(dl, t.t('loot.value'),
		`${valuation(row, 'immediate', presentation)} · ${valuation(row, 'listing', presentation)}`);
	addDefinition(dl, t.t('loot.nextStep'), recommendation(row, presentation, t));
	return dl;
}

function renderEconomy(presentation: LootPresentationV1, t: Translator): HTMLElement {
	const economy = createEl('section'); economy.className = 'tyrian-companion-loot__economy';
	const heading = createEl('h4'); heading.textContent = presentation.economy.label; economy.append(heading);
	const dl = createEl('dl');
	addDefinition(dl, t.t('loot.immediateNet'), money(presentation.economy.immediateCopper, presentation));
	addDefinition(dl, t.t('loot.listingNet'), money(presentation.economy.listingCopper, presentation));
	addDefinition(dl, t.t('loot.netCoin'), money(presentation.economy.coinNetCopper, presentation));
	if (presentation.economy.valuedItemKinds !== null && presentation.economy.totalItemKinds !== null) {
		addDefinition(dl, t.t('loot.valuedKinds'),
			`${String(presentation.economy.valuedItemKinds)}/${String(presentation.economy.totalItemKinds)}`);
	}
	economy.append(dl);
	for (const reason of presentation.decision.reasons) {
		const warning = createEl('p'); warning.textContent = reason; economy.append(warning);
	}
	const footer = createEl('p'); footer.textContent = presentation.decision.footer; economy.append(footer);
	return economy;
}

function valuation(row: LootPresentationRow, route: 'immediate' | 'listing', presentation: LootPresentationV1): string {
	if (row.valuation.status !== 'complete' && row.valuation.status !== 'partial') {
		return localizedLootState(presentation.locale, row.valuation.status);
	}
	return money(route === 'immediate' ? row.valuation.immediateCopper : row.valuation.listingCopper, presentation);
}

function recommendation(row: LootPresentationRow, presentation: LootPresentationV1, t: Translator): string {
	if (row.recommendation.status !== 'ready') return localizedLootState(presentation.locale, row.recommendation.status);
	const action = t.t(row.recommendation.action === 'open' ? 'loot.action.open' : 'loot.action.sell');
	return `${action} ${String(row.recommendation.quantity)}`;
}

function money(value: number | null, presentation: LootPresentationV1): string {
	if (value === null) return '—';
	const formatted = formatLootMoney(value, presentation.locale);
	return `${formatted.visual} (${formatted.accessible})`;
}

// `createEl` is Obsidian's element factory and resolves the owning document itself, so none of
// the builders below ever needed the `Document` that used to be threaded through all of them.
function appendCell(row: HTMLTableRowElement, text: string): void {
	const cell = createEl('td'); cell.textContent = text; row.append(cell);
}
function appendCompactCell(row: HTMLTableRowElement, text: string): void {
	const cell = createEl('td'); cell.className = 'tyrian-companion-loot__compact'; cell.textContent = text; row.append(cell);
}
function addDefinition(list: HTMLDListElement, term: string, value: string): void {
	const dt = createEl('dt'); dt.textContent = term; list.append(dt);
	const dd = createEl('dd'); dd.textContent = value; list.append(dd);
}
