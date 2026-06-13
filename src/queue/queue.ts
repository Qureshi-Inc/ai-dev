import { logger } from "../utils/logger.js";

type Task = () => Promise<void>;

/**
 * Minimal in-memory FIFO queue with concurrency 1.
 *
 * Serial execution is intentional: jobs for the same repo share one on-disk
 * clone, so running them one at a time avoids working-tree races without any
 * external dependency (Redis/BullMQ). Swap this out if multi-repo parallelism
 * is ever needed.
 */
class SerialQueue {
  private items: Array<{ name: string; task: Task }> = [];
  private running = false;

  enqueue(name: string, task: Task): void {
    this.items.push({ name, task });
    logger.debug({ name, depth: this.items.length }, "queue: enqueued");
    void this.drain();
  }

  size(): number {
    return this.items.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        logger.debug({ name: item.name }, "queue: running");
        try {
          await item.task();
        } catch (err) {
          logger.error({ name: item.name, err: (err as Error).message }, "queue: task failed");
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export const queue = new SerialQueue();
