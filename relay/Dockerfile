FROM node:22-alpine
WORKDIR /app
COPY server.js /app/server.js
ENV PORT=8792
EXPOSE 8792
USER node
CMD ["node", "/app/server.js"]
