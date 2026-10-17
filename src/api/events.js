// One Redis pub/sub subscription per API process, fanned out in memory to
// any number of waiting HTTP requests and SSE streams.
import { EventEmitter } from 'node:events';
import { redisConnection } from '../queue/queues.js';

export class EventHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.sub = redisConnection();
    this.ready = this.sub.psubscribe('pdfsvc:events:*');
    this.sub.on('pmessage', (_pattern, channel, message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch {
        return;
      }
      this.emit(channel, data);
    });
  }

  /** Resolve with the first event on `channel`, or null after `ms`. */
  waitOnce(channel, ms, check) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off(channel, finish);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), ms);
      this.on(channel, finish);
      // Close the race where the event fired before we subscribed.
      if (check) Promise.resolve(check()).then((v) => v && finish(v), () => {});
    });
  }

  async close() {
    await this.sub.quit().catch(() => {});
  }
}
