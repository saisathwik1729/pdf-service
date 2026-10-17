// Minimal FIFO async semaphore. acquire() resolves to a release function.
export class Semaphore {
  constructor(n) {
    this.available = n;
    this.queue = [];
  }

  get waiting() {
    return this.queue.length;
  }

  acquire() {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  #releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.queue.shift();
      if (next) next(this.#releaser());
      else this.available += 1;
    };
  }
}
