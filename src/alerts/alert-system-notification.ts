/**
 * The channel that survives a full-screen game.
 *
 * An Obsidian `Notice` is drawn inside the Obsidian window, so while Guild
 * Wars 2 owns the screen it is a message delivered to nobody. A desktop
 * notification is drawn by the compositor and is the only surface here that can
 * appear on top.
 *
 * `urgency: 'critical'` is Electron's Linux extension to the notification
 * options: GNOME hides normal banners while a window holds exclusive
 * full-screen, and only critical ones break through. It is passed only on
 * Linux, and everywhere else Chromium ignores an unknown option, so the banner
 * still shows without it. That is the whole degradation policy: an absent API,
 * a denied permission or a constructor that throws returns a status, never an
 * exception, because a missing banner must not take the toast down with it.
 */
export type SystemNotificationOutcome = 'shown' | 'denied' | 'unavailable';

export interface SystemNotificationInput {
	readonly title: string;
	readonly body: string;
	readonly platform: 'linux' | 'other';
}

interface SystemNotificationOptions {
	body: string;
	silent: true;
	urgency?: 'critical';
}

export interface SystemNotificationConstructor {
	new (title: string, options: SystemNotificationOptions): unknown;
	readonly permission?: string;
}

/**
 * Builds the option bag handed to the constructor.
 *
 * `silent: true` is deliberate and is not an accident of copying: this plugin
 * plays its own two-tone chime, and letting the desktop add its default sound
 * on top would double every alert.
 */
export function systemNotificationOptions(input: SystemNotificationInput): SystemNotificationOptions {
	return input.platform === 'linux'
		? { body: input.body, silent: true, urgency: 'critical' }
		: { body: input.body, silent: true };
}

/** Delivers one desktop notification, reporting why it could not instead of throwing. */
export function showSystemNotification(
	constructor: SystemNotificationConstructor | null,
	input: SystemNotificationInput,
): SystemNotificationOutcome {
	if (typeof constructor !== 'function') return 'unavailable';
	if (constructor.permission === 'denied') return 'denied';
	try {
		new constructor(input.title, systemNotificationOptions(input));
		return 'shown';
	} catch {
		return 'unavailable';
	}
}

/** Reads the renderer's notification constructor without assuming it exists. */
export function hostSystemNotificationConstructor(host: unknown): SystemNotificationConstructor | null {
	if (typeof host !== 'object' || host === null) return null;
	const candidate = (host as Record<string, unknown>).Notification;
	return typeof candidate === 'function' ? candidate as SystemNotificationConstructor : null;
}
