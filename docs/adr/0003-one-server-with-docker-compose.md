# ADR 0003: One server with Docker Compose, not Kubernetes

**Status:** accepted, 2026-11-12. Not built yet; the plan is in `docs/DEPLOYMENT.md`.
Replaces the "per-service deploys later" line in `docs/PLAN.md`'s decisions table with a
concrete choice.

## Context

The platform is ready to run somewhere public as a live demo. At runtime it is four
long-running processes, three Postgres databases and a static web client:

- the Alpha Exchange gateway (Rust; the matching engine and market data publisher run
  inside it), which keeps each business day's snapshot and journal on disk (ADR 0004);
- the broker's backend and market-data service, each with its own database;
- the simulator, a separate trading firm that keeps the market moving;
- the web client, plain files from `vite build`.

Three facts shape the choice more than anything else:

1. **The two most important processes must run exactly once.** The gateway owns the order
   book and its files. The backend holds the broker's single FIX session, which allows one
   connection at a time. Running two copies of either breaks it.
2. **It is small.** Everything fits in a few GB of memory, and there is no traffic to scale
   for: it is a synthetic market with a handful of visitors.
3. **The repo is organised by company,** and the companies only meet over published
   protocols. Every process already finds the others through environment variables, so
   where each one runs is a deployment choice, not a code change.

## Options

1. **One server running Docker Compose.** About $21 a month on AWS.
2. **Two servers, split by company:** the exchange on a private server, the broker on a
   public one, the web client on S3 and CloudFront. About $39 a month on AWS.
3. **A platform that runs containers for you (Fly.io):** each deployable its own app.
4. **Kubernetes** (a managed cluster, or k3s on a server).
5. **Serverless** (Lambda, Cloud Run) with the web client on a static host.
6. **Fully managed AWS:** a load balancer, three RDS databases and Fargate services, about
   $110 to $130 a month.

## Decision

Option 1: one EC2 server running Docker Compose, with the two-server split as the planned
next step.

- **It is the simplest thing that works.** One machine to create, patch, back up and debug.
  Containers find each other by name, Caddy serves the web client and the two public APIs
  with automatic HTTPS, and a deploy has one target.
- **It keeps the private parts private.** The exchange's FIX and feed ports are never
  published: only Caddy is reachable from the internet.
- **The company split still holds.** Each company owns its own compose file, in its own
  folder, like everything else in the repo. They join one shared Docker network on the
  server, so the broker reaches the gateway on its published ports by name, as any client
  would.
- **Two servers were weighed and deferred.** They show the split better (the broker reaching
  the exchange over a private network) and give each half its own memory, but add a second
  machine, cross-server network rules, private addresses in configuration, and an
  S3 + CloudFront setup for the web client, for about $7 to $19 a month more depending on
  measured memory. Because every process finds the others through settings, moving the
  exchange to its own server later means a second server and three changed addresses, not
  a redesign.
- **Kubernetes solves problems this project does not have.** Its main strength is running
  and moving many copies of a service; here the two key processes must never have more than
  one. It would cost more and take more upkeep than the application itself.
- **Serverless does not fit.** The gateway, backend, market-data and simulator are
  long-running processes holding open connections (FIX sessions, WebSockets, the feed).
- **Why AWS.** Any Linux server runs the same compose files, and Hetzner is cheaper. AWS
  uses services worth knowing (EC2, IAM, S3, CloudWatch, Systems Manager), and moving one
  piece to a managed service later, such as a database to RDS, stays in one account.
- **Fully managed AWS costs five to six times more** for a demo with a handful of visitors,
  and the gateway's day files still need a disk that outlives restarts.

## Consequences

- Five images, each built from a Dockerfile in its own folder: the exchange, backend,
  market-data, simulator, and the web client served by Caddy.
- Three compose files, one per company (`exchange-alpha/`, `participants/simulator/`,
  `broker/`), on one shared Docker network.
- Memory was the expected tight spot, estimated at 1 to 1.3 GB on a 2 GB server. Measured
  with the whole stack in Docker it is about 350 MB at start, so there is room; swap stays as
  a safety net, and a `t4g.medium` (4 GB) is the fix if that ever changes.
- No SSH, and no AWS keys anywhere. The server is reached through AWS Systems Manager, and
  it deploys itself: GitHub Actions builds the images and moves a `live` git tag, and an
  agent on the server pulls. (Planned first as GitHub signing in to AWS; the project's
  organization does not allow the identity provider that needs.)
- The server is a single point of failure. For a demo with fake money, a few minutes of
  downtime during a deploy or a reboot is acceptable.
- Deploying the backend signs everyone out, because sign-in sessions live in its memory.
  Moving them into Postgres (in `docs/BACKLOG.md`) fixes it if it matters.
- Kubernetes stays available as a separate learning exercise later, not as a requirement.
