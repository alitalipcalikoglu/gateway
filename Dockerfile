# Build from this directory: docker build -t atc-gateway .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 ROUTES_FILE=/config/routes.json
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY openapi.yaml ./
COPY src ./src
USER node
VOLUME ["/config"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- --no-check-certificate "$( [ -n "$TLS_CERT_PATH" ] && echo https || echo http )://127.0.0.1:3000/health" || exit 1
CMD ["node", "src/index.js"]
