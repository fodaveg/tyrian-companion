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
	const section = createEl('section');
	section.className = 'tyrian-companion-loot';
	const region = lootPresentationRegionAttributes(presentation);
	section.setAttribute('aria-label', region['aria-label']);
	const heading = createEl('h3');
	heading.textContent = lootPresentationRegionLabel(presentation);
	section.append(heading);
	section.append(renderTable(presentation));
	section.append(renderCards(presentation));
	section.append(renderEconomy(presentation));
	container.append(section);
}

export function lootPresentationRegionLabel(presentation: Pick<LootPresentationV1, 'locale'>): string {
	return presentation.locale === 'es' ? 'Botín observado' : 'Observed loot';
}

export function lootPresentationRegionAttributes(
	presentation: Pick<LootPresentationV1, 'locale'>,
): { 'aria-label': string } {
	return { 'aria-label': lootPresentationRegionLabel(presentation) };
}

function renderTable(presentation: LootPresentationV1): HTMLTableElement {
	const table = createEl('table');
	table.className = 'tyrian-companion-loot__table';
	const caption = createEl('caption');
	caption.textContent = presentation.locale === 'es'
		? 'Cambios netos del almacenamiento observado'
		: 'Net changes in observed storage';
	table.append(caption);
	const headers = presentation.locale === 'es'
		? ['Botín', 'Cambio neto', 'Reserva', 'Guardar', 'Libre', 'Neto ahora', 'Neto listado', 'Siguiente paso', 'Destino', 'Valor']
		: ['Loot', 'Net delta', 'Reserved', 'Hold', 'Free', 'Now net', 'Listing net', 'Next step', 'Destination', 'Value'];
	const head = createEl('thead');
	const headRow = createEl('tr');
	for (const [index, label] of headers.entries()) {
		const cell = createEl('th'); cell.scope = 'col'; cell.textContent = label;
		if (index >= 8) cell.className = 'tyrian-companion-loot__compact';
		headRow.append(cell);
	}
	head.append(headRow); table.append(head);
	const body = createEl('tbody');
	for (const row of presentation.rows) body.append(renderTableRow(row, presentation));
	table.append(body);
	return table;
}

function renderTableRow(row: LootPresentationRow, presentation: LootPresentationV1): HTMLTableRowElement {
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
	appendCell(tr, recommendation(row, presentation));
	appendCompactCell(tr, row.allocation.status === 'known'
		? `${String(row.allocation.reserved)} · ${String(row.allocation.held)} · ${String(row.allocation.free)}`
		: localizedLootState(presentation.locale, row.allocation.status));
	appendCompactCell(tr, `${valuation(row, 'immediate', presentation)} · ${valuation(row, 'listing', presentation)}`);
	return tr;
}

function renderCards(presentation: LootPresentationV1): HTMLElement {
	const list = createDiv(); list.className = 'tyrian-companion-loot__cards';
	for (const row of presentation.rows) {
		const article = createEl('article'); article.className = 'tyrian-companion-loot__card';
		const heading = createEl('h4'); heading.textContent = row.name; article.append(heading);
		article.append(definitionList(presentation, row));
		list.append(article);
	}
	return list;
}

function definitionList(presentation: LootPresentationV1, row: LootPresentationRow): HTMLDListElement {
	const dl = createEl('dl');
	addDefinition(dl, presentation.locale === 'es' ? 'Cambio neto' : 'Net delta', String(row.netQuantity));
	addDefinition(dl, presentation.locale === 'es' ? 'Destino' : 'Destination', row.allocation.status === 'known'
		? `${String(row.allocation.reserved)} · ${String(row.allocation.held)} · ${String(row.allocation.free)}`
		: localizedLootState(presentation.locale, row.allocation.status));
	addDefinition(dl, presentation.locale === 'es' ? 'Valor' : 'Value',
		`${valuation(row, 'immediate', presentation)} · ${valuation(row, 'listing', presentation)}`);
	addDefinition(dl, presentation.locale === 'es' ? 'Siguiente paso' : 'Next step', recommendation(row, presentation));
	return dl;
}

function renderEconomy(presentation: LootPresentationV1): HTMLElement {
	const economy = createEl('section'); economy.className = 'tyrian-companion-loot__economy';
	const heading = createEl('h4'); heading.textContent = presentation.economy.label; economy.append(heading);
	const dl = createEl('dl');
	addDefinition(dl, presentation.locale === 'es' ? 'Neto inmediato' : 'Immediate net',
		money(presentation.economy.immediateCopper, presentation));
	addDefinition(dl, presentation.locale === 'es' ? 'Neto listado' : 'Listing net',
		money(presentation.economy.listingCopper, presentation));
	addDefinition(dl, presentation.locale === 'es' ? 'Moneda neta' : 'Net coin',
		money(presentation.economy.coinNetCopper, presentation));
	if (presentation.economy.valuedItemKinds !== null && presentation.economy.totalItemKinds !== null) {
		addDefinition(dl, presentation.locale === 'es' ? 'Tipos valorados' : 'Valued kinds',
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

function recommendation(row: LootPresentationRow, presentation: LootPresentationV1): string {
	if (row.recommendation.status !== 'ready') return localizedLootState(presentation.locale, row.recommendation.status);
	const action = presentation.locale === 'es'
		? row.recommendation.action === 'open' ? 'Abrir' : 'Vender'
		: row.recommendation.action === 'open' ? 'Open' : 'Sell';
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
