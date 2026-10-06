FROM node:22-bookworm-slim
# System Chromium + fonts: deterministic executable path, no Chrome download at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/bridge
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production
COPY package.json ./
# sharp ships prebuilt linux-x64 binaries via npm optional deps
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
RUN useradd -m bridge && chown -R bridge:bridge /srv/bridge
USER bridge
EXPOSE 8790
CMD ["node", "server.js"]
