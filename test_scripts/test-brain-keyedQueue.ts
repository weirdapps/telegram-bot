import { describe, it, expect } from 'vitest';
import { KeyedQueue } from '../bridge/src/brain/keyedQueue.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('KeyedQueue', () => {
  it('runs tasks for one key in order, one at a time', async () => {
    const q = new KeyedQueue(2);
    const order: string[] = [];
    const gate = deferred();
    const a = q.run('k', async () => {
      order.push('a:start');
      await gate.promise;
      order.push('a:end');
    });
    const b = q.run('k', async () => {
      order.push('b');
    });
    await tick();
    expect(order).toEqual(['a:start']);
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('queues a late follow-up behind the task still running for its key', async () => {
    const q = new KeyedQueue(2); // a slot stays free, so only the key's queue holds 'c' back
    const gate = deferred();
    const order: string[] = [];
    const a = q.run('k', async () => {
      order.push('a');
    });
    const b = q.run('k', async () => {
      order.push('b:start');
      await gate.promise;
      order.push('b:end');
    });
    await tick(); // 'a' is done and 'b' is running
    const c = q.run('k', async () => {
      order.push('c');
    });
    await tick();
    expect(order).toEqual(['a', 'b:start']);
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b:start', 'b:end', 'c']);
  });

  it('overlaps different keys up to the limit, then waits', async () => {
    const q = new KeyedQueue(2);
    const gate = deferred();
    const started: string[] = [];
    const run = (key: string) =>
      q.run(key, async () => {
        started.push(key);
        await gate.promise;
      });
    const all = [run('a'), run('b'), run('c')];
    await tick();
    expect(started).toEqual(['a', 'b']);
    gate.resolve();
    await Promise.all(all);
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('never exceeds the limit when a slot is handed over', async () => {
    const q = new KeyedQueue(1);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    };
    await Promise.all([q.run('a', task), q.run('b', task), q.run('c', task), q.run('d', task)]);
    expect(peak).toBe(1);
  });

  it('hands a freed slot to the waiting task, not to a newcomer', async () => {
    const q = new KeyedQueue(1);
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const task = (key: string) => async () => {
      started.push(key);
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    };
    const gate = deferred();
    const runs = [
      q.run('a', async () => {
        await gate.promise;
      }),
      q.run('b', task('b')),
    ];
    await tick(); // 'a' holds the slot, 'b' waits for it
    // Newcomers arrive a microtask apart as 'a' finishes, so one of them lands between
    // 'a' letting go of the slot and 'b' picking it up.
    let arrivals: Promise<void> = gate.promise;
    for (const key of ['c', 'd', 'e']) {
      arrivals = arrivals.then(() => {
        runs.push(q.run(key, task(key)));
      });
    }
    gate.resolve();
    await arrivals;
    await Promise.all(runs);
    expect(started).toEqual(['b', 'c', 'd', 'e']);
    expect(peak).toBe(1);
  });

  it('frees a handed-over slot once the queue drains', async () => {
    const q = new KeyedQueue(1);
    const gate = deferred();
    const a = q.run('a', () => gate.promise);
    const b = q.run('b', async () => {});
    await tick(); // 'b' waits, so 'a' hands its slot over instead of freeing it
    gate.resolve();
    await Promise.all([a, b]);
    let ran = false;
    void q.run('c', async () => {
      ran = true;
    });
    await tick();
    expect(ran).toBe(true);
  });

  it('keeps going after a task fails', async () => {
    const q = new KeyedQueue(1);
    await expect(
      q.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    let ran = false;
    await q.run('k', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('reports a key busy while its task is queued or running', async () => {
    const q = new KeyedQueue(1);
    const gate = deferred();
    const p = q.run('k', () => gate.promise);
    expect(q.busy('k')).toBe(true);
    gate.resolve();
    await p;
    await tick();
    expect(q.busy('k')).toBe(false);
  });

  it('rejects a limit below one', () => {
    expect(() => new KeyedQueue(0)).toThrow();
  });
});
