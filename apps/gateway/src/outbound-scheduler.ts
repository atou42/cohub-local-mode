export type OutboundTask = {
  key: string;
  provider: string;
  media: boolean;
  run: () => Promise<void>;
  onRelease?: () => void;
};

export class OutboundScheduler {
  private readonly queues = new Map<string, OutboundTask[]>();
  private readonly activeKeys = new Set<string>();
  private readonly providers = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private running = 0;
  private mediaRunning = 0;
  size = 0;

  constructor(
    readonly capacity = 256,
    private readonly concurrency = 16,
    private readonly mediaConcurrency = 4,
    private readonly providerConcurrency = 8,
  ) {}

  add(task: OutboundTask) {
    if (this.size >= this.capacity) throw new Error("Outbound scheduler is full");
    const queue = this.queues.get(task.key) ?? [];
    queue.push(task);
    this.queues.set(task.key, queue);
    this.size += 1;
    this.pump();
  }

  releaseQueued(key: string) {
    const queue = this.queues.get(key) ?? [];
    this.queues.delete(key);
    this.size -= queue.length;
    for (const task of queue) task.onRelease?.();
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  pendingFor(key: string) {
    return (this.queues.get(key)?.length ?? 0) + Number(this.activeKeys.has(key));
  }

  async waitForCapacity() {
    while (this.size >= this.capacity) await this.changed();
  }

  async drain() {
    while (this.size > 0) await this.changed();
  }

  private changed() {
    return new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  private pump() {
    for (const [key, queue] of this.queues) {
      if (this.running >= this.concurrency) break;
      const task = queue[0];
      if (!task || this.activeKeys.has(key)) continue;
      if (task.media && this.mediaRunning >= this.mediaConcurrency) continue;
      if ((this.providers.get(task.provider) ?? 0) >= this.providerConcurrency) continue;
      queue.shift();
      this.queues.delete(key);
      if (queue.length) this.queues.set(key, queue);
      this.activeKeys.add(key);
      this.running += 1;
      this.mediaRunning += Number(task.media);
      this.providers.set(task.provider, (this.providers.get(task.provider) ?? 0) + 1);
      void Promise.resolve().then(task.run).finally(() => {
        this.activeKeys.delete(key);
        this.running -= 1;
        this.mediaRunning -= Number(task.media);
        this.providers.set(task.provider, (this.providers.get(task.provider) ?? 1) - 1);
        if (this.providers.get(task.provider) === 0) this.providers.delete(task.provider);
        this.size -= 1;
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
        this.pump();
      }).catch(() => undefined);
    }
  }
}
