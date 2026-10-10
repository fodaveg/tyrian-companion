/**
 * The three official coin icons of the game. They are the `ui_coin_gold`, `ui_coin_silver` and
 * `ui_coin_copper` entries of the public `GET https://api.guildwars2.com/v2/files?ids=all`, on the same
 * render service as every other icon of the plugin (`https://render.guildwars2.com`, no new host).
 * Nothing is bundled: the browser fetches and caches them like the item icons.
 */
export const COIN_ICON_URLS = {
	gold: 'https://render.guildwars2.com/file/090A980A96D39FD36FBB004903644C6DBEFB1FFB/156904.png',
	silver: 'https://render.guildwars2.com/file/E5A2197D78ECE4AE0349C8B3710D033D22DB0DA6/156907.png',
	copper: 'https://render.guildwars2.com/file/6CF8F96A3299CFC75D5CC90617C3C70331A1EF0E/156902.png',
} as const;

const UNITS = [['gold', 'g'], ['silver', 's'], ['copper', 'c']] as const;

/** The copper amount split into its sign and the three coins. */
export function splitCopper(copper: number): { negative: boolean; gold: number; silver: number; copper: number } {
	const value = Math.abs(Math.round(copper));
	return { negative: copper < 0, gold: Math.floor(value / 10_000), silver: Math.floor(value / 100) % 100, copper: value % 100 };
}

/**
 * An amount of copper as `N [gold] N [silver] N [copper]`, with the official coin icons.
 *
 * The letters (`g`, `s`, `c`) are always in the DOM, so `textContent` is the plain `0g 37s 1c` of
 * `formatCopperVisual`; a letter hides only once ITS icon has loaded (`data-icon`), so with no network or a
 * broken image the text is what stays, never a gap or a broken icon. The whole figure is one `role="img"`
 * with the spoken amount as its name, and the icons are decorative. The three parts are built once and
 * `set()` only rewrites their numbers, so a changing value never reloads an icon.
 */
export class CoinFigure {
	readonly element: HTMLElement;
	private readonly sign: HTMLElement;
	private readonly numbers: HTMLElement[] = [];

	constructor(document: Document) {
		// The root has no parent yet (the live panel places it), so only it comes from `document`;
		// the parts hang from it through Obsidian's helpers (polyfilled in Hebra, `host/dom-polyfill.ts`).
		this.element = document.createElement('span');
		this.element.className = 'tyrian-money';
		this.element.setAttribute('role', 'img');
		this.sign = this.element.createSpan({ cls: 'tyrian-money__sign' });
		UNITS.forEach(([unit, letter], index) => {
			if (index > 0) this.element.append(document.createTextNode(' '));
			const part = this.element.createSpan({ cls: 'tyrian-money__part' });
			part.dataset.unit = unit;
			const number = part.createSpan({ cls: 'tyrian-money__num' });
			const icon = part.createEl('img', { cls: 'tyrian-money__icon' });
			icon.alt = '';
			icon.setAttribute('aria-hidden', 'true');
			icon.addEventListener('load', () => { part.dataset.icon = 'on'; });
			icon.addEventListener('error', () => { icon.remove(); });
			icon.src = COIN_ICON_URLS[unit];
			part.createSpan({ cls: 'tyrian-money__letter', text: letter });
			this.numbers.push(number);
		});
	}

	/** Paints `copper`; `label` is the spoken amount (see `speakCopper`). Touches only what changed. */
	set(copper: number, label: string): void {
		const parts = splitCopper(copper);
		const values = [parts.gold, parts.silver, parts.copper].map(String);
		const sign = parts.negative ? '-' : '';
		if (this.sign.textContent !== sign) this.sign.textContent = sign;
		values.forEach((value, index) => { if (this.numbers[index]!.textContent !== value) this.numbers[index]!.textContent = value; });
		if (this.element.getAttribute('aria-label') !== label) this.element.setAttribute('aria-label', label);
	}
}

/** The spoken amount from a template with `{gold}`, `{silver}` and `{copper}` (`negativeTemplate` for a loss). */
export function speakCopper(copper: number, template: string, negativeTemplate: string): string {
	const parts = splitCopper(copper);
	return (parts.negative ? negativeTemplate : template)
		.replace('{gold}', String(parts.gold)).replace('{silver}', String(parts.silver)).replace('{copper}', String(parts.copper));
}
