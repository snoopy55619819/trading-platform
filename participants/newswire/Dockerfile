# The newswire. Another company: it publishes headlines to anyone who subscribes, over its
# own spec (spec/README.md; ADR 0006).
#
#   docker build -t newswire participants/newswire

FROM node:26.8.1-slim
LABEL org.opencontainers.image.source=https://github.com/snoopy55619819/trading-platform
RUN npm install --global pnpm@12.3.4
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
USER node
EXPOSE 9890
CMD ["node", "src/main.ts"]
