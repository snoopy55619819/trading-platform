# The broker's front door: Caddy serving the web client and routing /api and /md to the
# backend and market-data, with HTTPS from Let's Encrypt.
#
#   docker build -t broker-web broker/web

FROM node:26.8.1-slim AS build
RUN npm install --global pnpm@12.3.4
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Paths on the page's own host, so the same image works on any hostname.
ENV VITE_BACKEND_URL=/api \
    VITE_MARKET_DATA_URL=/md
RUN pnpm build

FROM caddy:2.10-alpine
LABEL org.opencontainers.image.source=https://github.com/snoopy55619819/trading-platform
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
# Which release this is, at /version.txt: the deploy workflow waits until the live site
# reports the version it just released.
ARG VERSION=dev
RUN echo "$VERSION" > /srv/version.txt
