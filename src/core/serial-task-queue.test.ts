import { describe, expect, it } from 'vitest';

import {
	SERIAL_TASK_INTERACTIVE_RUN_BEFORE_BACKGROUND,
	SerialTaskQueue,
	runSerialTaskUnqueued,
	type SerialTaskTurn,
} from './serial-task-queue';

/** A task the test finishes by hand, so nothing here depends on a timer. */
function heldTask<T>(log: string[], name: string) {
	let settle: { resolve: (value: T) => void; reject: (error: unknown) => void } | null = null;
	const task = (): Promise<T> => {
		log.push(`start ${name}`);
		return new Promise<T>((resolve, reject) => { settle = { resolve, reject }; });
	};
	const settled = (): { resolve: (value: T) => void; reject: (error: unknown) => void } => {
		if (settle === null) throw new Error(`Task ${name} has not started.`);
		return settle;
	};
	return {
		task,
		started: () => settle !== null,
		finish: (value: T) => { log.push(`end ${name}`); settled().resolve(value); },
		fail: (error: unknown) => { log.push(`fail ${name}`); settled().reject(error); },
	};
}

/** Lets every continuation already queued run; the queue itself uses no timers. */
async function settleMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('SerialTaskQueue', () => {
	it('runs one task at a time, in arrival order within one priority', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const a = heldTask<string>(log, 'a');
		const b = heldTask<string>(log, 'b');
		const c = heldTask<string>(log, 'c');

		const turns = [queue.run('background', a.task), queue.run('background', b.task), queue.run('background', c.task)];
		await settleMicrotasks();
		expect(log).toEqual(['start a']);

		a.finish('A');
		await settleMicrotasks();
		expect(log).toEqual(['start a', 'end a', 'start b']);

		b.finish('B');
		await settleMicrotasks();
		c.finish('C');

		expect(await Promise.all(turns)).toEqual([
			{ status: 'ran', value: 'A' }, { status: 'ran', value: 'B' }, { status: 'ran', value: 'C' },
		]);
		expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
	});

	it('starts an idle queue\'s task at once, without waiting for a later turn', () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		void queue.run('background', heldTask<void>(log, 'a').task);
		expect(log).toEqual(['start a']);
	});

	it('an interactive task passes every background task that has not started, and waits only for the one in flight', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const inFlight = heldTask<void>(log, 'background-1');
		const waiting = heldTask<void>(log, 'background-2');
		const alsoWaiting = heldTask<void>(log, 'background-3');
		const interactive = heldTask<void>(log, 'interactive-1');
		const laterInteractive = heldTask<void>(log, 'interactive-2');

		const turns = [
			queue.run('background', inFlight.task),
			queue.run('background', waiting.task),
			queue.run('background', alsoWaiting.task),
			queue.run('interactive', interactive.task),
			queue.run('interactive', laterInteractive.task),
		];
		await settleMicrotasks();
		// It does not cut in on the task under way.
		expect(log).toEqual(['start background-1']);

		inFlight.finish();
		await settleMicrotasks();
		interactive.finish();
		await settleMicrotasks();
		laterInteractive.finish();
		await settleMicrotasks();
		waiting.finish();
		await settleMicrotasks();
		alsoWaiting.finish();
		await Promise.all(turns);

		expect(log.filter((line) => line.startsWith('start'))).toEqual([
			'start background-1', 'start interactive-1', 'start interactive-2', 'start background-2', 'start background-3',
		]);
	});

	/** Queues instant tasks behind one held task and returns the order they ran in once it ends. */
	async function orderBehindOneInFlight(queued: ReadonlyArray<readonly [name: string, priority: 'interactive' | 'background']>): Promise<string[]> {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const inFlight = heldTask<void>(log, 'first');
		const turns = [queue.run('background', inFlight.task)];
		for (const [name, priority] of queued) turns.push(queue.run(priority, async () => { log.push(name); }));
		inFlight.finish();
		await Promise.all(turns);
		return log.slice(2);
	}

	it('with a background task waiting, one of them runs after every four interactive tasks in a row', async () => {
		expect(SERIAL_TASK_INTERACTIVE_RUN_BEFORE_BACKGROUND).toBe(4);
		const interactive = Array.from({ length: 10 }, (_unused, index) => [`I${String(index + 1)}`, 'interactive'] as const);

		const order = await orderBehindOneInFlight([['B1', 'background'], ['B2', 'background'], ['B3', 'background'], ...interactive]);

		expect(order).toEqual(['I1', 'I2', 'I3', 'I4', 'B1', 'I5', 'I6', 'I7', 'I8', 'B2', 'I9', 'I10', 'B3']);
	});

	it('with no background task waiting, interactive tasks run in a row without limit, and none of them counts later', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const inFlight = heldTask<void>(log, 'first');
		const turns = [queue.run('interactive', inFlight.task)];
		for (let index = 1; index <= 6; index += 1) turns.push(queue.run('interactive', async () => { log.push(`I${String(index)}`); }));
		inFlight.finish();
		await Promise.all(turns);
		expect(log.slice(2)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6']);

		// Six ran in a row with nothing behind them. A background task that arrives now still
		// lets four interactive ones pass: only the ones that went AHEAD of a waiting one count.
		const later = heldTask<void>(log, 'later');
		const more = [queue.run('interactive', later.task), queue.run('background', async () => { log.push('B'); })];
		for (let index = 7; index <= 11; index += 1) more.push(queue.run('interactive', async () => { log.push(`I${String(index)}`); }));
		later.finish();
		await Promise.all(more);
		expect(log.slice(10)).toEqual(['I7', 'I8', 'I9', 'I10', 'B', 'I11']);
	});

	it('the count starts again once a background task has run', async () => {
		const order = await orderBehindOneInFlight([
			['B1', 'background'], ['I1', 'interactive'], ['I2', 'interactive'], ['I3', 'interactive'], ['I4', 'interactive'],
			['I5', 'interactive'], ['I6', 'interactive'], ['B2', 'background'], ['I7', 'interactive'], ['I8', 'interactive'], ['I9', 'interactive'],
		]);

		// B1 after four; then I5 and I6 are only two, so B2 waits for I7 and I8 as well.
		expect(order).toEqual(['I1', 'I2', 'I3', 'I4', 'B1', 'I5', 'I6', 'I7', 'I8', 'B2', 'I9']);
	});

	it('a task that throws rejects its own turn and the queue goes on with the next one', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const failing = heldTask<string>(log, 'a');
		const next = heldTask<string>(log, 'b');

		const failed = queue.run('background', failing.task);
		const ran = queue.run('background', next.task);
		failing.fail(new Error('boom'));
		await expect(failed).rejects.toThrow('boom');
		await settleMicrotasks();
		next.finish('B');

		expect(await ran).toEqual({ status: 'ran', value: 'B' });
	});

	it('a task that throws before returning a promise is a rejected turn too, not a broken queue', async () => {
		const queue = new SerialTaskQueue();
		const failed = queue.run('background', () => { throw new Error('sync boom'); });
		const ran = queue.run('background', async () => 'after');

		await expect(failed).rejects.toThrow('sync boom');
		expect(await ran).toEqual({ status: 'ran', value: 'after' });
	});

	it('a task that queues another one does not deadlock: the new one runs after it, by its priority', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const nested: Array<Promise<SerialTaskTurn<string>>> = [];

		const outer = queue.run('background', async () => {
			log.push('start outer');
			nested.push(queue.run('background', async () => { log.push('nested background'); return 'nb'; }));
			nested.push(queue.run('interactive', async () => { log.push('nested interactive'); return 'ni'; }));
			await Promise.resolve();
			log.push('end outer');
			return 'outer';
		});

		expect(await outer).toEqual({ status: 'ran', value: 'outer' });
		expect(await Promise.all(nested)).toEqual([{ status: 'ran', value: 'nb' }, { status: 'ran', value: 'ni' }]);
		expect(log).toEqual(['start outer', 'end outer', 'nested interactive', 'nested background']);
	});

	it('dispose drops what has not started, resolves every turn, and lets the task in flight end as it would', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const inFlight = heldTask<string>(log, 'a');
		const waitingBackground = heldTask<string>(log, 'b');
		const waitingInteractive = heldTask<string>(log, 'c');

		// Collected as they settle, so a turn left unresolved is a failed assertion and not a hang.
		const turns: Array<SerialTaskTurn<string> | null> = [null, null, null];
		void queue.run('background', inFlight.task).then((turn) => { turns[0] = turn; });
		void queue.run('background', waitingBackground.task).then((turn) => { turns[1] = turn; });
		void queue.run('interactive', waitingInteractive.task).then((turn) => { turns[2] = turn; });
		queue.dispose();
		await settleMicrotasks();

		expect(turns).toEqual([null, { status: 'dropped' }, { status: 'dropped' }]);
		inFlight.finish('A');
		await settleMicrotasks();
		expect(turns).toEqual([{ status: 'ran', value: 'A' }, { status: 'dropped' }, { status: 'dropped' }]);
		expect(waitingBackground.started()).toBe(false);
		expect(waitingInteractive.started()).toBe(false);
		expect(log).toEqual(['start a', 'end a']);
	});

	it('after dispose a new task is dropped without being started', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		queue.dispose();
		const late = heldTask<string>(log, 'late');

		expect(await queue.run('interactive', late.task)).toEqual({ status: 'dropped' });
		expect(late.started()).toBe(false);
	});

	it('runner binds one priority, and the unqueued runner just runs the task', async () => {
		const log: string[] = [];
		const queue = new SerialTaskQueue();
		const inFlight = heldTask<void>(log, 'a');
		void queue.run('background', inFlight.task);
		const background = queue.runner('background')(async () => { log.push('background'); });
		const interactive = queue.runner('interactive')(async () => { log.push('interactive'); });
		inFlight.finish();
		await Promise.all([background, interactive]);

		expect(log).toEqual(['start a', 'end a', 'interactive', 'background']);
		expect(await runSerialTaskUnqueued(async () => 7)).toEqual({ status: 'ran', value: 7 });
	});
});
