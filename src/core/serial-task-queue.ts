/**
 * One task at a time, in two priorities. It knows nothing about what a task does: the caller
 * decides what has to be serial and hands every such task to the same queue.
 *
 * - `interactive`: somebody is looking at the result. It goes ahead of every `background` task
 *   that has not started yet, and waits only for the task in flight, which is never interrupted.
 * - `background`: work nobody is waiting on. It advances while no interactive task is waiting.
 *
 * Within one priority, tasks run in arrival order.
 */
export type SerialTaskPriority = 'interactive' | 'background';

/**
 * How one task's turn ended. `dropped` means the task was never started: the queue was disposed
 * before its turn came. A task that throws rejects its own turn and nothing else.
 */
export type SerialTaskTurn<T> = { status: 'ran'; value: T } | { status: 'dropped' };

/** A queue already bound to one priority, which is all a consumer needs to be handed. */
export type SerialTaskRunner = <T>(task: () => Promise<T>) => Promise<SerialTaskTurn<T>>;

/** The runner of a consumer that was handed no queue: the task runs at once, on its own. */
export const runSerialTaskUnqueued: SerialTaskRunner = async (task) => ({ status: 'ran', value: await task() });

interface WaitingTask {
	/** Never rejects: the task's own failure goes to the turn it belongs to. */
	start(): Promise<void>;
	drop(): void;
}

export class SerialTaskQueue {
	private readonly waiting: Record<SerialTaskPriority, WaitingTask[]> = { interactive: [], background: [] };
	private draining = false;
	private disposed = false;

	/**
	 * Queues one task and resolves with its turn. An idle queue starts it before this returns.
	 * A task may queue further tasks; awaiting one of them from inside itself would wait forever,
	 * as it would on any serial queue.
	 */
	run<T>(priority: SerialTaskPriority, task: () => Promise<T>): Promise<SerialTaskTurn<T>> {
		if (this.disposed) return Promise.resolve({ status: 'dropped' });
		return new Promise<SerialTaskTurn<T>>((resolve) => {
			this.waiting[priority].push({
				start: async () => {
					// An async wrapper, so a task that throws before returning its promise rejects too.
					const flight = (async () => await task())();
					// The turn takes the task's own rejection, with the error it was thrown.
					resolve(flight.then((value) => ({ status: 'ran', value })));
					await flight.then(() => undefined, () => undefined);
				},
				drop: () => { resolve({ status: 'dropped' }); },
			});
			void this.drain();
		});
	}

	/** `run` with the priority already chosen. */
	runner(priority: SerialTaskPriority): SerialTaskRunner {
		return async (task) => await this.run(priority, task);
	}

	/**
	 * Drops every task that has not started: each of their turns resolves as `dropped`, and so does
	 * any task queued from now on. The task in flight is left to end as it would.
	 */
	dispose(): void {
		this.disposed = true;
		for (const priority of ['interactive', 'background'] as const) {
			for (const task of this.waiting[priority].splice(0)) task.drop();
		}
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			for (let next = this.takeNext(); next !== undefined; next = this.takeNext()) await next.start();
		} finally {
			this.draining = false;
		}
	}

	private takeNext(): WaitingTask | undefined {
		return this.waiting.interactive.shift() ?? this.waiting.background.shift();
	}
}
