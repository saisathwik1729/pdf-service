// One long-lived Chromium per worker process, with a fixed number of page slots.
//
// Why not launch a browser per PDF? Launch is the expensive part (~0.5-1s CPU,
// ~150MB+). The "2-3s and 400MB per PDF" in the brief is what you get with
// launch-per-request; a warm browser renders a 2-page invoice in a fraction of
// that (see docs/benchmarks.md). The pool:
//   - caps concurrent renders (slots) so memory is bounded by design
//   - relaunches Chromium if it crashes (OOM-killer, renderer crash)
//   - recycles Chromium after N renders or when its RSS grows past a limit,
//     draining in-flight renders first (Chromium leaks slowly over time)
//   - blocks every network request from rendered pages (SSRF protection)
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { Semaphore } from '../lib/semaphore.js';

export class BrowserCrashError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'BrowserCrashError';
    this.cause = cause;
  }
}

const LAUNCH_ARGS = [
  '--no-sandbox', // the container is the sandbox; see Dockerfile (non-root user, seccomp)
  '--disable-dev-shm-usage', // Docker's 64MB /dev/shm is a classic source of "random" crashes
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--no-first-run',
  '--mute-audio',
  '--font-render-hinting=none', // stable glyph metrics between machines
];

// Memory of Chromium's whole process tree (browser + renderers + GPU/utility).
// Uses PSS (proportional set size) when available: plain RSS double-counts the
// shared libraries mapped into every Chromium process and overstates usage.
function procMemBytes(pid) {
  try {
    const roll = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const m = roll.match(/^Pss:\s+(\d+) kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch {
    /* fall through */
  }
  const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
  return Number(statm[1]) * 4096;
}

export function processTreeRssMb(rootPid) {
  if (!rootPid || process.platform !== 'linux') return null;
  try {
    const children = new Map();
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(Number(entry));
      } catch {
        /* process exited */
      }
    }
    let total = 0;
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop();
      try {
        total += procMemBytes(pid);
      } catch {
        /* gone */
      }
      for (const c of children.get(pid) || []) stack.push(c);
    }
    return Math.round(total / 1024 / 1024);
  } catch {
    return null;
  }
}

export class BrowserPool {
  constructor({
    executablePath,
    headless = 'shell',
    size = 2,
    maxRendersPerBrowser = 500,
    rssLimitMb = 1200,
    pageReuseLimit = 50,
    logger = console,
  } = {}) {
    this.executablePath = executablePath;
    // 'shell' = chrome-headless-shell: no browser UI code at all. Measured ~40%
    // less CPU per render than full Chrome in headless mode (docs/benchmarks.md).
    this.headless = headless === 'true' ? true : headless;
    this.size = size;
    this.maxRenders = maxRendersPerBrowser;
    this.rssLimitMb = rssLimitMb;
    this.pageReuseLimit = pageReuseLimit;
    this.log = logger;
    this.slots = new Semaphore(size);
    this.current = null; // { browser, gen, inflight, renders, idlePages: [] }
    this.launching = null;
    this.gen = 0;
    this.stats = { launches: 0, crashes: 0, recycles: 0, renders: 0, failures: 0, lastRssMb: null, peakRssMb: 0 };
  }

  async #launch() {
    const gen = ++this.gen;
    const started = Date.now();
    const browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: this.headless,
      args: LAUNCH_ARGS,
      protocolTimeout: 120_000,
    });
    const entry = { browser, gen, inflight: 0, renders: 0, retiring: false, idlePages: [] };
    browser.on('disconnected', () => {
      entry.idlePages = [];
      if (this.current === entry) {
        this.current = null;
        if (!entry.retiring) {
          this.stats.crashes += 1;
          this.log.warn({ gen }, 'chromium disconnected unexpectedly; will relaunch on next render');
        }
      }
    });
    this.stats.launches += 1;
    this.log.info({ gen, ms: Date.now() - started, pid: browser.process()?.pid }, 'chromium launched');
    return entry;
  }

  async #ensureBrowser() {
    if (this.current && this.current.browser.connected) return this.current;
    if (!this.launching) {
      this.launching = this.#launch()
        .then((e) => {
          this.current = e;
          return e;
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  #retire(entry, reason) {
    if (entry.retiring) return;
    entry.retiring = true;
    if (this.current === entry) this.current = null;
    this.stats.recycles += 1;
    this.log.info({ gen: entry.gen, reason, renders: entry.renders }, 'recycling chromium');
    this.#closeWhenIdle(entry);
  }

  #closeWhenIdle(entry) {
    if (entry.inflight === 0) {
      entry.idlePages = [];
      entry.browser.close().catch(() => {});
    }
  }

  async #newPage(entry) {
    const page = await entry.browser.newPage();
    // Templates are rendered to static HTML before they reach Chromium, so
    // the page never needs JavaScript, and it must never touch the network:
    // a customer name like <img src="http://169.254.169.254/..."> would
    // otherwise make the server fetch its own cloud metadata (SSRF).
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url === 'about:blank') req.continue().catch(() => {});
      else req.abort('blockedbyclient').catch(() => {});
    });
    page.__uses = 0;
    return page;
  }

  async start() {
    await this.#ensureBrowser();
  }

  /**
   * Run fn(page) inside one pool slot.
   *  fresh=false: reuse a warm page (cheap; used for normal documents)
   *  fresh=true : brand-new page, closed afterwards (used for heavy chunks so
   *               their memory is returned immediately)
   */
  async withPage(fn, { timeoutMs = 30_000, fresh = false } = {}) {
    const release = await this.slots.acquire();
    let entry;
    let page;
    let healthy = false;
    try {
      entry = await this.#ensureBrowser();
      entry.inflight += 1;
      try {
        page = (!fresh && entry.idlePages.pop()) || (await this.#newPage(entry));
        page.__uses += 1;
        let onError;
        const crashPromise = new Promise((_, reject) => {
          onError = (err) => reject(new BrowserCrashError(`renderer crashed: ${err.message}`, err));
          page.once('error', onError);
        });
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`render timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        try {
          const out = await Promise.race([fn(page), crashPromise, timeout]);
          healthy = true;
          return out;
        } finally {
          clearTimeout(timer);
          page.off('error', onError);
          crashPromise.catch(() => {});
        }
      } catch (err) {
        this.stats.failures += 1;
        if (err instanceof BrowserCrashError) this.stats.crashes += 1;
        if (!entry.browser.connected || /Target closed|Session closed|Protocol error|crash/i.test(err.message)) {
          throw err instanceof BrowserCrashError ? err : new BrowserCrashError(err.message, err);
        }
        throw err;
      } finally {
        if (page) {
          const reusable = healthy && !fresh && !entry.retiring && page.__uses < this.pageReuseLimit && entry.browser.connected;
          if (reusable) entry.idlePages.push(page);
          else page.close().catch(() => {});
        }
        entry.inflight -= 1;
        entry.renders += 1;
        this.stats.renders += 1;
        this.#afterRender(entry);
      }
    } finally {
      release();
    }
  }

  #afterRender(entry) {
    if (entry.retiring) {
      this.#closeWhenIdle(entry);
      return;
    }
    if (entry.renders >= this.maxRenders) {
      this.#retire(entry, 'max-renders');
      return;
    }
    // Sampling /proc is cheap but not free; check every 10th render.
    if (entry.renders % 10 !== 0) return;
    const rss = processTreeRssMb(entry.browser.process()?.pid);
    if (rss !== null) {
      this.stats.lastRssMb = rss;
      this.stats.peakRssMb = Math.max(this.stats.peakRssMb, rss);
      if (rss > this.rssLimitMb) this.#retire(entry, `memory ${rss}MB > ${this.rssLimitMb}MB`);
    }
  }

  snapshot() {
    return {
      size: this.size,
      busy: this.size - this.slots.available,
      waiting: this.slots.waiting,
      generation: this.current?.gen ?? null,
      memMb: this.current ? processTreeRssMb(this.current.browser.process()?.pid) : null,
      ...this.stats,
    };
  }

  async close() {
    const e = this.current;
    this.current = null;
    if (e) {
      e.retiring = true;
      await e.browser.close().catch(() => {});
    }
  }
}
