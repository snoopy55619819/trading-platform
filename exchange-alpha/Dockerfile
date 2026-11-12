# Alpha Exchange's gateway: the FIX acceptor, matching engine and market data publisher,
# one binary. Built in a Rust image, run in a small Debian one.
#
#   docker build -t alpha-exchange exchange-alpha

FROM rust:1.98-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY spec spec
COPY crates crates
RUN cargo build --release --locked -p gateway

FROM debian:trixie-slim
RUN useradd --system --uid 10001 alpha && mkdir /data && chown alpha /data
COPY --from=build /src/target/release/gateway /usr/local/bin/gateway
USER alpha
# Each business day's snapshot and journal live in /data: mount a volume there.
ENV ALPHA_DATA_DIR=/data \
    ALPHA_LISTEN=0.0.0.0:9878 \
    ALPHA_MD_LISTEN=0.0.0.0:9879
EXPOSE 9878 9879
CMD ["gateway"]
