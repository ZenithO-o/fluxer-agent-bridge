# fluxer-agent-bridge image: Node 22 + Fluxer.js (patched close codes).
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY patches ./patches
RUN node patches/apply-fluxerjs-ws-close-4000.mjs
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev --ignore-scripts && node patches/apply-fluxerjs-ws-close-4000.mjs

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
ENV NODE_ENV=production BB_CFG_DIR=/cfg BB_STATE_DIR=/state BB_HEALTH_PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN grep -q 'fluxer-agent-bridge patched' node_modules/@fluxerjs/ws/dist/index.js
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=6s --start-period=60s --retries=3 CMD ["node", "/app/dist/cli.js", "health"]
CMD ["node", "--enable-source-maps", "/app/dist/main.js"]
