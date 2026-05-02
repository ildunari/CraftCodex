import { describe, expect, it } from 'bun:test';

import { AcpPromptQueue } from '../acp/acp-prompt-queue.ts';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('AcpPromptQueue', () => {
  it('runs a single task and resolves the enqueue promise', async () => {
    const q = new AcpPromptQueue();
    let ran = false;
    await q.enqueue(async () => { ran = true; });
    expect(ran).toBe(true);
    expect(q.pending).toBe(0);
  });

  it('serializes concurrent tasks in submission order', async () => {
    const q = new AcpPromptQueue();
    const order: string[] = [];
    const a = deferred();
    const b = deferred();

    const p1 = q.enqueue(async () => {
      order.push('a-start');
      await a.promise;
      order.push('a-end');
    });
    const p2 = q.enqueue(async () => {
      order.push('b-start');
      await b.promise;
      order.push('b-end');
    });

    expect(q.pending).toBe(1);
    await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(['a-start']);

    a.resolve();
    await p1;
    expect(order.includes('a-end')).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);

    b.resolve();
    await p2;
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('continues draining after a task throws', async () => {
    const q = new AcpPromptQueue();
    const failed = q.enqueue(async () => { throw new Error('boom'); });
    const ok = q.enqueue(async () => { /* fine */ });
    await expect(failed).rejects.toThrow('boom');
    await expect(ok).resolves.toBeUndefined();
  });

  it('cancelAll rejects waiting tasks but lets the running one settle', async () => {
    const q = new AcpPromptQueue();
    const running = deferred();
    const r1 = q.enqueue(async () => { await running.promise; });
    const r2 = q.enqueue(async () => { /* should be cancelled */ });
    await new Promise(res => setTimeout(res, 0));
    q.cancelAll('shutting down');
    await expect(r2).rejects.toThrow('shutting down');
    running.resolve();
    await expect(r1).resolves.toBeUndefined();
  });
});
