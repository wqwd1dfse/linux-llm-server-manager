function createLimiterError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class ConcurrencyLimiter {
  constructor(limit, maxQueue = 64, queueTimeoutMs = 10_000) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Concurrency limit must be a positive integer');
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new TypeError('Queue limit must be a non-negative integer');
    if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1) throw new TypeError('Queue timeout must be a positive integer');
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.queueTimeoutMs = queueTimeoutMs;
    this.activeCount = 0;
    this.queue = [];
  }

  get pendingCount() {
    return this.queue.length;
  }

  createRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drain();
    };
  }

  drain() {
    while (this.activeCount < this.limit && this.queue.length > 0) {
      const entry = this.queue.shift();
      entry.cleanup();
      if (entry.signal?.aborted) {
        entry.reject(createLimiterError('Operation aborted while queued', 'ABORT_ERR'));
        continue;
      }
      this.activeCount += 1;
      entry.resolve(this.createRelease());
    }
  }

  acquire(signal = null) {
    if (signal?.aborted) {
      return Promise.reject(createLimiterError('Operation already aborted', 'ABORT_ERR'));
    }
    if (this.activeCount < this.limit) {
      this.activeCount += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(createLimiterError('Remote operation queue is full', 'QUEUE_FULL'));
    }

    return new Promise((resolve, reject) => {
      let timeout = null;
      const entry = {
        signal,
        resolve,
        reject,
        cleanup: () => {
          if (timeout) clearTimeout(timeout);
          signal?.removeEventListener('abort', handleAbort);
        }
      };
      const removeEntry = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const handleAbort = () => {
        removeEntry();
        entry.cleanup();
        reject(createLimiterError('Operation aborted while queued', 'ABORT_ERR'));
      };

      signal?.addEventListener('abort', handleAbort, { once: true });
      timeout = setTimeout(() => {
        removeEntry();
        entry.cleanup();
        reject(createLimiterError('Timed out waiting for a remote operation slot', 'QUEUE_TIMEOUT'));
      }, this.queueTimeoutMs);
      timeout.unref?.();
      this.queue.push(entry);
    });
  }

  async run(operation, { signal = null } = {}) {
    if (typeof operation !== 'function') throw new TypeError('Limited operation must be a function');
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
