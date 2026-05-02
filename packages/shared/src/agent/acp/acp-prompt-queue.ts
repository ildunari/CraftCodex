/**
 * Per-agent FIFO that serializes `chat()` calls.
 *
 * Concurrent prompts are common from automations, slash-commands, and quick
 * follow-ups. Without serialization they race on the shared event queue,
 * `_isProcessing` flag, and ACP `sessionId`. This queue lets producers fire
 * and forget; the worker drains tasks one at a time, awaiting each to
 * complete before starting the next.
 */

interface Task {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class AcpPromptQueue {
  private readonly queue: Task[] = [];
  private active = false;

  enqueue(run: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      void this.drain();
    });
  }

  /**
   * Generator-friendly variant. Returns `{ ready, release }` where `ready`
   * resolves when this slot reaches the head of the queue. Callers MUST call
   * `release()` exactly once — typically in a `finally` block — to let the
   * next slot proceed.
   */
  acquire(): { ready: Promise<void>; release: () => void } {
    let releaseSlot!: () => void;
    const released = new Promise<void>((res) => { releaseSlot = res; });
    let signalReady!: () => void;
    const ready = new Promise<void>((res) => { signalReady = res; });

    void this.enqueue(async () => {
      signalReady();
      await released;
    });

    let releasedFlag = false;
    return {
      ready,
      release: () => {
        if (releasedFlag) return;
        releasedFlag = true;
        releaseSlot();
      },
    };
  }

  /** Number of tasks waiting (excluding the one currently running). */
  get pending(): number {
    return this.queue.length;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Reject all waiting tasks. The currently-running task is left to settle. */
  cancelAll(reason: string | Error): void {
    const error = reason instanceof Error ? reason : new Error(reason);
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.reject(error);
    }
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        try {
          await task.run();
          task.resolve();
        } catch (error) {
          task.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.active = false;
    }
  }
}
