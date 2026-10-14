/** Minimal FIFO concurrency limiter with no external dependencies. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error('Concurrency limit must be a positive safe integer.');
	}

	let active = 0;
	const queue: Array<() => void> = [];

	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active >= limit) {
			// The slot is handed over by whoever frees it, still counted in `active`: counting it here, after the
			// waiter resumes, left a window where a new caller saw a free slot and ran next to the waiter (limit+1).
			await new Promise<void>((resolve) => queue.push(resolve));
		} else {
			active += 1;
		}
		try {
			return await task();
		} finally {
			const next = queue.shift();
			if (next === undefined) active -= 1;
			else next();
		}
	};
}
