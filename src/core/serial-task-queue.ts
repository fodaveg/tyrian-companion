/**
 * One task at a time, in two priorities. It knows nothing about what a task does: the caller
 * decides what has to be serial and hands every such task to the same queue.
 *
 * - `interactive`: somebody is looking at the result. It goes ahead of the `background` tasks
 *   that have not started yet, and waits only for the task in flight, which is never interrupted.
 * - `background`: work nobody is waiting on. It advances while no interactive task is waiting,
 *   and, so that it cannot be starved, one of them also runs after every
 *   `SERIAL_TASK_INTERACTIVE_RUN_BEFORE_BACKGROUND` interactive tasks that went ahead of it.
 *
 * Within one priority, tasks run in arrival order.
 */
export type SerialTaskPriority = 'interactive' | 'background';

/**
 * How many interactive tasks in a row may go ahead of a waiting background task before one
 * background task takes a turn. Without it, interactive tasks that keep arriving (a view that
 * queues one again on every repaint while its source is down) would hold back for good a
 * background task something else IS waiting on, such as an action that needs its result to end.
 * Four keeps what somebody is looking at first, and bounds that wait to four tasks. Only the
 * interactive tasks that passed a waiting background task count; the count starts again when a
 * background task runs, and whenever none is waiting.
 */
export const SERIAL_TASK_INTERACTIVE_RUN_BEFORE_BACKGROUND = 4;

/**
 * How one task's turn ended. `dropped` means the task was never started: the queue was disposed
 * before its turn came. A task that throws rejects its own turn and nothing else.
 */
export type SerialTaskTurn<T> = { status: 'ran'; value: T } | { status: 'dropped' };

/** A queue already bound to one priority, which is all a consumer needs to be handed. */
export type SerialTaskRunner = <T>(task: () => Promise<T>) => Promise<SerialTaskTurn<T>>;

/**
 * The runner a caller hands over when it has no queue to share: the task runs at once, on its
 * own. Consumers take their runner as a required option, so choosing this one is explicit.
 */
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
	/** Interactive tasks started in a row while a background task waited; see the constant above. */
	private interactivePassedBackground = 0;

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
		const { interactive, background } = this.waiting;
		if (background.length === 0) {
			// Nothing is being passed, so nothing is counted.
			this.interactivePassedBackground = 0;
			return interactive.shift();
		}
		if (interactive.length > 0 && this.interactivePassedBackground < SERIAL_TASK_INTERACTIVE_RUN_BEFORE_BACKGROUND) {
			this.interactivePassedBackground += 1;
			return interactive.shift();
		}
		this.interactivePassedBackground = 0;
		return background.shift();
	}
}
