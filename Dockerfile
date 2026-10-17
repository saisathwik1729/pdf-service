# One image, two roles: `node src/api/server.js` (API) and `node src/queue/worker.js` (renderer).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    PUPPETEER_CHROME_SKIP_DOWNLOAD=true \
    PUPPETEER_HEADLESS=shell

WORKDIR /app

# tini: proper PID 1 so Chromium's child processes are reaped and SIGTERM
# reaches node (graceful drain of in-flight renders on deploy/scale-in).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini fontconfig ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# chrome-headless-shell only (no full Chrome): smaller image, ~40% cheaper renders.
# --install-deps pulls the shared libraries it needs via apt.
RUN npm ci --omit=dev \
 && npx puppeteer browsers install chrome-headless-shell --install-deps \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Pinned TrueType fonts (see assets/fonts/README.md): identical layout everywhere.
COPY assets/fonts/ /usr/share/fonts/truetype/app/
RUN fc-cache -f

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Never run Chromium as root. With --no-sandbox, the container boundary is the
# sandbox, so: non-root user, read-only root FS and dropped capabilities (see compose).
RUN groupadd -r app && useradd -r -g app -d /app app && mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/api/server.js"]
