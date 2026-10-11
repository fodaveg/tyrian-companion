import type { LiveJournalEntryV1, LiveSessionCharacterV1, LiveSessionFormat, LiveSessionRuntimeRecord } from './live-session-model';
import { prepareLiveSessionPayload } from './live-session-note-model';
import { summaryMainMap, summaryNamedEntities, type SummaryEntityIds, type SummaryItemMetaMap } from './live-session-summary-figures';
import { readComparablePerHour, type SummaryHistoryVault } from './live-session-summary-history';
import { linkFullNoteToSummary, LiveSessionSummaryWriter, type LiveSessionSummaryVault, type LiveSessionSummaryWriteResult } from './live-session-summary-note';
import { normalizeSessionOutputFolder } from './session-note-model';

/** At most this many attempts per session, at least this far apart: a failing vault is not hammered. */
export const LIVE_SUMMARY_MAX_ATTEMPTS = 3;
export const LIVE_SUMMARY_RETRY_MS = 60_000;
/** Map names are cosmetic: the summary waits this long for the public API and then writes «Mapa <id>». */
const LIVE_SUMMARY_MAP_WAIT_MS = 5_000;

/** The two cache-only reads the entity names need; the public catalog service satisfies it. */
interface SummaryNameCache {
	readCachedItems(ids: readonly number[], locale: 'es' | 'en'): Promise<Record<string, { id: number; name: string }>>;
	readCachedCurrencies(ids: readonly number[], locale: 'es' | 'en'): Promise<Record<string, { id: number; name: string }>>;
}

/**
 * Item and currency names keyed `item:<id>` / `currency:<id>`, from the catalog CACHE alone (any age):
 * it never makes a request. The summary is approved to ask the public API for map names only, so an
 * id the cache does not hold is absent from the result and the note writes its fallback.
 */
export async function summaryCachedNames(cache: SummaryNameCache, wanted: SummaryEntityIds, locale: 'es' | 'en'): Promise<Record<string, string>> {
	const items = wanted.itemIds.length === 0 ? {} : await cache.readCachedItems(wanted.itemIds, locale);
	const currencies = wanted.currencyIds.length === 0 ? {} : await cache.readCachedCurrencies(wanted.currencyIds, locale);
	const names: Record<string, string> = {};
	for (const item of Object.values(items)) names[`item:${String(item.id)}`] = item.name;
	for (const currency of Object.values(currencies)) names[`currency:${String(currency.id)}`] = currency.name;
	return names;
}

interface LiveSessionSummaryServiceOptions {
	vault: LiveSessionSummaryVault & SummaryHistoryVault;
	runtime(): LiveSessionRuntimeRecord | null;
	journal(): readonly LiveJournalEntryV1[];
	/** The format of the session `runtime()` gives (`LiveSessionLifecycle.getSessionFormat()`): the summary is worked out from the same payload its full note carries. */
	format(): LiveSessionFormat;
	locale(): 'es' | 'en';
	outputFolder(): string;
	/** Names already in memory, keyed `item:<id>` / `currency:<id>`. An entity nobody has named has NO key: never its id as a name. */
	displayNames(record: LiveSessionRuntimeRecord): Record<string, string>;
	/** Names of the given items and currencies, by the same keys, from the catalog CACHE only; never the network. */
	cachedNames(wanted: SummaryEntityIds): Promise<Record<string, string>>;
	/** Characters the session saw, in order (kept apart from the closed record); empty when unknown. */
	characters(): readonly LiveSessionCharacterV1[];
	charactersCapped(): boolean;
	/** The persisted «summary already written for this session» mark. With it set nothing is read, asked or written. */
	isWritten(): boolean;
	/** Marks the summary of THAT session as written; a no-op when the persisted mark belongs to another session (a later one may have started). */
	markWritten(sessionId: string): Promise<void>;
	/** Flags and types of the given items from the catalog CACHE only; never the network. */
	itemMeta(itemIds: readonly number[]): Promise<SummaryItemMetaMap>;
	/** Map names by decimal id: the cache, and the public API only when `network` is true. The service bounds the wait. */
	mapNames(mapIds: readonly number[], network: boolean): Promise<Record<string, string>>;
	/** Whether the host paints a remote image inside a line of the note; absent, it does not, and the item tables carry names alone. */
	inlineIcons?(): boolean;
	/** False while the plugin is loading: the summary of a session closed earlier is then written from caches only. */
	networkAllowed(): boolean;
	/** False in consult mode and after unload: the same gate that governs the full note. */
	enabled(): boolean;
	now(): number;
	/** Diagnostics only (a class name and what was missing, no user data); a failure here never reaches the session. */
	onFailure(details: { status: string; reason: string | null; attempt: number }): void;
	/** Starts a timer and returns how to cancel it (the host's `window` timers; the service owns no global). */
	startTimer(callback: () => void, ms: number): () => void;
	/** Test seam for the map-name wait. */
	mapWaitMs?: number;
}

interface Progress { attempts: number; lastAttemptAt: number; done: boolean; running: boolean }

/** Everything one summary is worked out from, copied before the first await: the next session may replace all of it while the summary is written. */
interface Subject {
	record: LiveSessionRuntimeRecord; receipt: NonNullable<LiveSessionRuntimeRecord['summaryReceipt']>;
	journal: readonly LiveJournalEntryV1[]; format: LiveSessionFormat;
	characters: readonly LiveSessionCharacterV1[]; charactersCapped: boolean;
}

/** Progress kept for this many sessions: a summary that failed for the session before the current one can still be retried. */
const PROGRESS_KEPT = 4;

/**
 * Writes the summary note of the closed session AFTER its full note is saved and acknowledged:
 * `observe()` does nothing until the runtime is `complete` and carries its `summaryReceipt`.
 * The host calls it on every lifecycle state change (the receipt itself raises one), so the retry
 * policy is: the first attempt right after the receipt, then at most two more on later state
 * changes at least a minute apart. No timer of its own, no loop. Once written, a persisted mark
 * stops every later attempt, including the ones a plugin load raises: loading never reads notes,
 * asks the network or rewrites a note the user deleted. Without the mark, a load writes from caches.
 * A failure is logged and never thrown, so it cannot hold the session, the header or the next start.
 * Everything optional (flags, names, earlier summaries) degrades to «unknown» and leaves a diagnostic.
 * An item or a currency is named from memory and then from the catalog cache, never from the
 * network: one still unnamed is left out, and the note writes its fallback («Objeto <id>»).
 */
export class LiveSessionSummaryService {
	private readonly progress = new Map<string, Progress>();
	/** The subjects of the attempts that failed with attempts left, by session; they are retried even after another session has started. */
	private readonly stranded = new Map<string, Subject>();
	private readonly writer: LiveSessionSummaryWriter;
	/** The cancel handle of every map-name wait in flight: more than one session can be writing at once. */
	private readonly cancelWaits = new Set<() => void>();
	private disposed = false;

	constructor(private readonly options: LiveSessionSummaryServiceOptions) {
		this.writer = new LiveSessionSummaryWriter(options.vault);
	}

	/** Cancels the pending map-name waits; whatever is in flight writes nothing once this was called. */
	dispose(): void {
		this.disposed = true;
		for (const cancel of this.cancelWaits) cancel();
		this.cancelWaits.clear();
	}

	async observe(): Promise<void> {
		try { await this.attempt(); } catch (error) {
			this.report({ status: 'unexpected', reason: error instanceof Error ? error.name : null, attempt: 0 });
		}
	}

	private report(details: { status: string; reason: string | null; attempt: number }): void {
		try { this.options.onFailure(details); } catch { /* The diagnostics sink failed: nothing else can be done about it here. */ }
	}

	private live(): boolean { return !this.disposed && this.options.enabled(); }

	private async attempt(): Promise<void> {
		if (!this.live()) return;
		const current = this.options.runtime();
		const currentReceipt = current?.summaryReceipt ?? null;
		const currentReady = current !== null && current.phase === 'complete' && currentReceipt !== null && currentReceipt.sessionId === current.sessionId;
		// A summary that failed for a session that is no longer the current one is retried from what was copied then; the current
		// session (when it is the same one) is read live, as always. Every session that may be tried now is chosen and copied before
		// the first await, so the one written first cannot leave the others to wait for another state change.
		const now = this.options.now();
		const jobs: { subject: Subject; progress: Progress }[] = [];
		const take = (sessionId: string, subject: () => Subject): void => {
			let progress = this.progress.get(sessionId);
			if (progress === undefined) {
				progress = { attempts: 0, lastAttemptAt: 0, done: false, running: false };
				this.progress.set(sessionId, progress);
				for (const key of this.progress.keys()) { if (this.progress.size <= PROGRESS_KEPT) break; this.progress.delete(key); this.stranded.delete(key); }
			}
			if (progress.done || progress.running || progress.attempts >= LIVE_SUMMARY_MAX_ATTEMPTS
				|| progress.attempts > 0 && now - progress.lastAttemptAt < LIVE_SUMMARY_RETRY_MS) return;
			progress.running = true; progress.attempts += 1; progress.lastAttemptAt = now;
			jobs.push({ subject: subject(), progress });
		};
		for (const [sessionId, subject] of this.stranded) if (!(currentReady && current.sessionId === sessionId)) take(sessionId, () => subject);
		if (currentReady && !this.options.isWritten()) {
			take(current.sessionId, () => ({ record: current, receipt: currentReceipt, journal: this.options.journal(), format: this.options.format(),
				characters: this.options.characters(), charactersCapped: this.options.charactersCapped() }));
		}
		for (const job of jobs) await this.write(job.subject, job.progress);
	}

	private async write(subject: Subject, progress: Progress): Promise<void> {
		const { record, receipt } = subject;
		try {
			const locale = this.options.locale(); const outputFolder = this.options.outputFolder();
			const session = await prepareLiveSessionPayload({ record, journal: subject.journal, format: subject.format, locale, outputFolder });
			if (session === null) { progress.done = true; this.report({ status: 'invalid', reason: 'invalid_live_evidence', attempt: progress.attempts }); return; }
			const itemIds = session.totals.filter((row) => row.kind === 'item' && row.net !== 0).map((row) => row.idNumber);
			const mapIds = [...new Set(session.mapIntervals.flatMap((interval) => interval.mapId === null ? [] : [interval.mapId]))];
			// The same normalized folder the writer uses, so the earlier summaries are looked up where they were written.
			const folder = normalizeSessionOutputFolder(outputFolder) ?? outputFolder;
			const network = this.options.networkAllowed();
			const known = this.options.displayNames(record);
			const [itemMeta, mapNames, comparable, displayNames] = await Promise.all([
				this.optional('item_meta', progress.attempts, () => this.options.itemMeta(itemIds), {}),
				this.optional('map_names', progress.attempts, () => this.boundedMapNames(mapIds, network), {}),
				this.optional('comparables', progress.attempts, () => readComparablePerHour(this.options.vault, folder, summaryMainMap(session), session.sessionRef), { perHour: [], unreadable: 0 }),
				this.entityNames(known, summaryNamedEntities(session), progress.attempts),
			]);
			if (comparable.unreadable > 0) this.report({ status: 'optional_comparables_unreadable', reason: String(comparable.unreadable), attempt: progress.attempts });
			// The plugin may have unloaded while the lookups ran: then nothing is written.
			if (!this.live()) return;
			const result: LiveSessionSummaryWriteResult = await this.writer.write({ session, locale, outputFolder, fullNotePath: receipt.path,
				fullNoteLinkTarget: this.options.vault.linkTarget?.(receipt.path) ?? null,
				displayNames, characters: subject.characters, charactersCapped: subject.charactersCapped,
				itemMeta, mapNames, comparablePerHour: comparable.perHour, inlineIcons: this.options.inlineIcons?.() === true, ...(comparable.capped === true ? { comparablesCapped: true } : {}) });
			if (result.status === 'written' || result.status === 'unchanged' || result.status === 'kept') {
				progress.done = true; await this.options.markWritten(record.sessionId);
				// The link back goes in right after the summary exists and is marked, because a host that names notes by id knows its id only
				// now. It is for the full note this session just saved (its receipt): no earlier note is looked up or rewritten. A failure
				// costs the link and nothing else (the summary is done): `observe` reports it as any unexpected one.
				await linkFullNoteToSummary(this.options.vault, { fullNotePath: receipt.path, summaryPath: result.path, sessionRef: session.sessionRef, locale });
				return;
			}
			// Invalid input will not heal by itself; a conflict is somebody else's note on our path.
			if (result.status === 'invalid' || result.status === 'conflict') progress.done = true;
			this.report({ status: result.status, attempt: progress.attempts,
				reason: 'reason' in result ? result.reason : 'errorName' in result ? result.errorName ?? null : null });
		} catch (error) {
			// Reported with the attempt of THIS session: another may be writing at the same time.
			this.report({ status: 'unexpected', reason: error instanceof Error ? error.name : null, attempt: progress.attempts });
		} finally {
			progress.running = false;
			// Kept for a retry only while it has attempts left, by session; the oldest go first once the bound is passed.
			if (progress.done || progress.attempts >= LIVE_SUMMARY_MAX_ATTEMPTS) this.stranded.delete(record.sessionId);
			else {
				this.stranded.set(record.sessionId, subject);
				for (const key of this.stranded.keys()) { if (this.stranded.size <= PROGRESS_KEPT) break; this.stranded.delete(key); }
			}
		}
	}

	/** Never longer than `mapWaitMs`: a slow API costs the name, not the summary. */
	private async boundedMapNames(mapIds: readonly number[], network: boolean): Promise<Record<string, string>> {
		if (mapIds.length === 0) return {};
		// Local to this call: another write can be waiting on its own timer, and `dispose()` reaches all of them through the set.
		const timer = { cancel: (): void => undefined };
		const wait = new Promise<Record<string, string>>((resolve) => {
			timer.cancel = this.options.startTimer(() => { resolve({}); }, this.options.mapWaitMs ?? LIVE_SUMMARY_MAP_WAIT_MS);
		});
		this.cancelWaits.add(timer.cancel);
		try { return await Promise.race([this.options.mapNames(mapIds, network), wait]); } finally { timer.cancel(); this.cancelWaits.delete(timer.cancel); }
	}

	/**
	 * The names the note is written with. What memory already names is kept; what it lacks is read from
	 * the catalog cache, and that is all: no request is made for an item or a currency name, whether the
	 * plugin is loading or the session has just closed. An entity still unnamed has no key.
	 */
	private async entityNames(known: Readonly<Record<string, string>>, wanted: SummaryEntityIds, attempt: number): Promise<Record<string, string>> {
		const names: Record<string, string> = {};
		const add = (found: Readonly<Record<string, string>>): void => {
			for (const [key, name] of Object.entries(found)) if (names[key] === undefined && typeof name === 'string' && name.trim() !== '') names[key] = name;
		};
		add(known);
		const lacking: SummaryEntityIds = { itemIds: wanted.itemIds.filter((id) => names[`item:${String(id)}`] === undefined),
			currencyIds: wanted.currencyIds.filter((id) => names[`currency:${String(id)}`] === undefined) };
		if (lacking.itemIds.length > 0 || lacking.currencyIds.length > 0) add(await this.optional('cached_names', attempt, () => this.options.cachedNames(lacking), {}));
		return names;
	}

	/** Optional context: whatever fails here is absent from the note, and a diagnostic says which part and the error class. */
	private async optional<T>(what: string, attempt: number, work: () => Promise<T>, fallback: T): Promise<T> {
		try { return await work(); } catch (error) {
			this.report({ status: `optional_${what}`, reason: error instanceof Error ? error.name : null, attempt });
			return fallback;
		}
	}
}
