# The broker's market-data service: live fanout and chart history.
#
#   docker build -t broker-market-data broker/market-data

# The feed's types are generated from the vendored proto, never committed.
FROM node:26.8.1-slim AS gen
RUN npm install --global pnpm@12.3.4
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY buf.gen.yaml ./
COPY vendor vendor
RUN pnpm dlx @bufbuild/buf@1.72.0 generate

FROM node:26.8.1-slim
LABEL org.opencontainers.image.source=https://github.com/snoopy55619819/trading-platform
RUN npm install --global pnpm@12.3.4
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
COPY --from=gen /app/gen gen
USER node
EXPOSE 8081
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node src/main.ts"]
