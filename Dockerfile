FROM node:22-alpine

ENV NODE_ENV=production \
    POLARIS_HOST=0.0.0.0 \
    POLARIS_PORT=8787 \
    TZ=Asia/Shanghai

WORKDIR /app

COPY package.json server.mjs ./
COPY src ./src
COPY public ./public
COPY config.example.json ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
