/** Minimal FIFO concurrency limiter with no external dependencies. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error('Concurrency limit must be a positive safe integer.');
	}

	let active = 0;
	const queue: Array<() => void> = [];

	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active >= limit) {
			await new Promise<void>((resolve) => queue.push(resolve));
		}
		active += 1;
		try {
			return await task();
		} finally {
			active -= 1;
			queue.shift()?.();
		}
	};
}
