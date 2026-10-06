FROM ghcr.io/puppeteer/puppeteer:latest
USER root
WORKDIR /srv/bridge
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production
COPY package.json ./
# sharp ships prebuilt linux-x64 binaries via npm optional deps
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
RUN chown -R pptruser:pptruser /srv/bridge
USER pptruser
EXPOSE 8790
CMD ["node", "server.js"]
