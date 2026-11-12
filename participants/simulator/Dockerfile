# The simulated trading firms. Another company: it trades over the same public FIX session
# and feed as anyone else.
#
#   docker build -t simulator participants/simulator

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
RUN npm install --global pnpm@12.3.4 && mkdir /data && chown node /data
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
COPY --from=gen /app/gen gen
USER node
# Open orders are saved here, so a restart cancels what a crash left resting.
ENV SIM_STATE_FILE=/data/open-orders.json
CMD ["node", "src/main.ts"]
