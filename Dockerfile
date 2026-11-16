FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

# Solo dependencias de producción (express)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data/uploads && chown -R node:node /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server/index.js"]
