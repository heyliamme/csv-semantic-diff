// The host's handle on a comparison's worker thread: one request at a time per id, with
// a promise for each, and a restart when the worker dies (out of memory, say).
import { Worker } from 'worker_threads';
import type { WorkerRequest } from './worker';

/** A request dropped because the worker was stopped or replaced; not worth reporting. */
export class Superseded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Superseded';
  }
}

export class Engine {
  private worker?: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ended = false;
  /** Bumped every time a worker starts: a new worker holds no tables. */
  generation = 0;

  constructor(private script: string) {}

  private start() {
    const w = new Worker(this.script, { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.result);
    });
    const fail = (why: string) => {
      if (this.worker !== w) return;
      this.worker = undefined;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    w.on('error', (e: Error) => fail(/heap|memory/i.test(e.message) ? 'The files are too large to compare in the available memory.' : `The comparison failed: ${e.message}`));
    w.on('exit', (code) => fail(code === 0 ? 'The comparison was stopped.' : 'The comparison ran out of memory or crashed; reopen it to try again.'));
    this.worker = w;
    this.generation++;
  }

  /** Starts a worker if none is running; the generation tells whether it is a new one. */
  ensure(): number {
    if (this.ended) throw new Superseded('closed');
    if (!this.worker) this.start();
    return this.generation;
  }

  /**
   * Sends a request. With `timeout`, a request that runs longer stops the worker (it
   * can't be interrupted otherwise) and fails with `slow`; the next request starts a
   * fresh worker, which the caller notices through `generation`.
   */
  call<T = unknown>(req: WorkerRequest, timeout?: { ms: number; slow: string }): Promise<T> {
    this.ensure();
    const w = this.worker!;
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = <V>(f: (v: V) => void) => (v: V) => {
        if (timer) clearTimeout(timer);
        f(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (timeout)
        timer = setTimeout(() => {
          if (this.worker !== w || !this.pending.has(id)) return;
          this.pending.delete(id);
          this.stop();
          reject(new Error(timeout.slow));
        }, timeout.ms);
      w.postMessage({ id, req });
    });
  }

  /** Ends the current worker; requests waiting on it are dropped quietly. */
  private stop() {
    const w = this.worker;
    this.worker = undefined;
    for (const p of this.pending.values()) p.reject(new Superseded('stopped'));
    this.pending.clear();
    w?.terminate().catch(() => {});
  }

  dispose() {
    this.ended = true;
    this.stop();
  }
}
