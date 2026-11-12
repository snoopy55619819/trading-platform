# The broker's backend: API, order management, ledger and FIX initiator, one process.
# No build step: Node runs the TypeScript directly, as it does locally.
#
#   docker build -t broker-backend broker/backend

FROM node:26.8.1-slim
RUN npm install --global pnpm@12.3.4
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
USER node
EXPOSE 8080
# Migrations run on every start and apply only what is pending. The security master seed
# does not: it is data, run deliberately (node scripts/seed-securities.mjs).
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node src/main.ts"]
