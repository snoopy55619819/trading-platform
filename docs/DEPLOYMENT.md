# Deploying the trading platform

The plan for running the platform publicly as a live demo: what gets deployed, where, and
how a change gets from `main` to the server. **Not built yet.** Why one server with Docker
Compose rather than two servers, Kubernetes or managed services is in
[ADR 0003](adr/0003-one-server-with-docker-compose.md). Running it locally is in
[RUNNING.md](RUNNING.md).

## The layout

One AWS EC2 server, a `t4g.small` (2 vCPU, 2 GB of memory, ARM), running Docker Compose.
Only [Caddy](https://caddyserver.com/) is reachable from the internet. It gets HTTPS
certificates by itself and routes each subdomain:

```
app.<domain>  ->  the web client's files
api.<domain>  ->  backend :8080
md.<domain>   ->  market-data :8081 (including WebSocket)
```

```mermaid
flowchart LR
  browser([Browser]) -->|HTTPS| caddy
  subgraph server [One server, Docker Compose]
    caddy[Caddy + web files] --> backend
    caddy --> md[market-data]
    backend -->|FIX 9878| gateway
    gateway -->|feed 9879| md
    sim[simulator] -->|FIX 9878| gateway
    gateway -->|feed 9879| sim
    backend --- bdb[(broker db)]
    md --- mdb[(market-data db)]
    gateway --- edb[(exchange db)]
    gateway --- days[/day files/]
  end
```

- **Each company deploys itself,** from its own compose file: `exchange-alpha/deploy/`,
  `participants/simulator/deploy/` and `broker/deploy/`. All three join one shared Docker
  network, so containers reach each other by name (`gateway:9878`), on the same published
  ports any client uses.
- **Nothing private is published.** The gateway, the databases and the simulator have no
  ports open to the internet; the security group allows only 443 and 80 (for certificate
  renewal).

## What each process needs

Every process already reads its settings from environment variables, so nothing in the code
changes to deploy it.

| Process | Settings |
|---|---|
| gateway | `DATABASE_URL`, `ALPHA_DATA_DIR`, `ALPHA_LISTEN` and `ALPHA_MD_LISTEN` (`0.0.0.0:…` inside its container), `ALPHA_COMP_IDS` |
| simulator | `SIM_FIX_HOST=gateway`, `SIM_FEED_URL=ws://gateway:9879`, `SIM_ACTIVITY=0.2` for a quieter market |
| backend | `DATABASE_URL`, `FIX_HOST=gateway`, `FIX_PORT=9878`, `BROKER_WEB_ORIGIN=https://app.<domain>` |
| market-data | `MD_DATABASE_URL`, `MD_FEED_URL=ws://gateway:9879` |
| web (at build time) | `VITE_BACKEND_URL=https://api.<domain>`, `VITE_MARKET_DATA_URL=https://md.<domain>` |

**Health checks**, so compose starts things in order:
- Postgres: `pg_isready`;
- gateway: its FIX port accepting connections;
- backend: `GET /status`;
- market-data: `GET /health`.

**Memory** is estimated, not measured: about 1 to 1.3 GB in use (three small Postgres
instances, three Node services, the gateway and Caddy). The server gets a 2 GB swap file as
a safety net. Measure once it runs; if it is tight, a `t4g.medium` (4 GB) adds about $12 a
month.

## AWS services and cost

Estimated for us-east-1 (N. Virginia), November 2026. Prices change; check the totals in the
[AWS Pricing Calculator](https://calculator.aws/) before relying on them.

| Service | How many | What for | Per month |
|---|---|---|---|
| EC2 `t4g.small` | 1 | runs everything | ~$12.30 |
| EBS gp3, 30 GB | 1 volume | the server's disk: databases, day files, images | ~$2.40 |
| Public IPv4 (Elastic IP) | 1 | a fixed address for DNS; AWS charges for every public IPv4 | ~$3.65 |
| Route 53 hosted zone | 1 | DNS for `app.`, `api.` and `md.` | $0.50 |
| Route 53 domain (`.com`) | 1 | the domain name, about $15 a year | ~$1.25 |
| S3 | 1 bucket | nightly database dumps and the exchange's old day files | < $1 |
| CloudWatch | a disk-usage metric, its alarm, a billing alarm | warnings before the disk or the bill gets out of hand | ~$0.30 |
| Systems Manager | | shell access and deploys without SSH | $0 |
| Data transfer out | | the first 100 GB a month is free; a demo uses far less | $0 |
| **Total** | | | **≈ $21** |

Not needed: a load balancer (Caddy routes), certificates from ACM (Caddy uses Let's
Encrypt for free) and ECR (images live in the GitHub Container Registry).

**Ways to pay less:** a 1-year Savings Plan takes about 30 to 40% off EC2, new accounts get
sign-up credits for the first months, and an existing domain removes the domain line.

**Alternatives.**

| Option | Per month | Trade-off |
|---|---|---|
| Two servers, split by company (the planned next step) | ≈ $39 | shows the company split; more to set up (see below) |
| AWS Lightsail, 2 GB plan | ≈ $14 | simplest AWS setup; disk, transfer and IPv4 included; less control over networking |
| Hetzner | ≈ €5 to €8 | cheapest; not AWS |
| Fully managed AWS (load balancer, 3 × RDS, Fargate) | ≈ $110 to $130 | nothing to patch, but five to six times the cost |

## Images

Five Dockerfiles, each in its own folder. There is still no shared build.

- **Exchange** (`exchange-alpha/Dockerfile`): a two-stage build. Compile with the Rust image,
  then copy the binary into a small Debian slim image.
- **Backend, market-data, simulator:** `node:26-slim` plus `pnpm install --prod`. No build
  step: Node runs `.ts` directly, as it does locally. market-data and the simulator run
  `proto:gen` while the image is built.
- **Web** (`broker/web/Dockerfile`): build with `vite build` in one stage, then copy the files
  into a Caddy image along with the broker's `Caddyfile`. That one container is the broker's
  front door for all three subdomains.

Images go to the GitHub Container Registry (free for public repositories), tagged with the
git commit they were built from, and built for `linux/arm64` on GitHub's ARM runners, since
the server is ARM.

## From merge to running

1. **Check every PR.** GitHub Actions runs each deployable's tests and typechecks. The Rust
   tests need nothing else; the backend's and market-data's tests need Postgres, which runs
   as a service container in the job.
2. **Build on merge to `main`.** Build the five images and push them, tagged with the commit.
3. **Deploy.** GitHub Actions signs in to AWS with short-lived credentials (OpenID Connect,
   no stored keys) and, through Systems Manager, runs on the server: `db:migrate` for the
   backend and market-data as one-off containers, then `docker compose pull && docker
   compose up -d` for each company. Only containers whose image changed restart. The seed
   (instruments) runs once, on the first deploy.
4. **What a restart does.** A gateway restart loads the day's snapshot and journal in
   seconds; the broker reconnects and recovers anything it missed by resend, and the
   simulator cancels and re-quotes. A backend restart signs everyone out.
5. **Roll back** by deploying the previous commit's tag.

## Secrets and access

- **No SSH.** Port 22 stays closed. A shell is through Systems Manager's Session Manager,
  and deploys run through it too.
- **No stored AWS keys.** GitHub Actions assumes an IAM role through OpenID Connect; the
  server reaches S3 through its own instance role.
- **Database passwords** live in GitHub Actions secrets and in a `.env` file per company on
  the server that only root can read.
- **Sign-in sessions** are random tokens in the backend's memory, so there is no signing key
  to manage.

## Backups and upkeep

- **Nightly:** `pg_dump` each of the three databases to S3. A lifecycle rule deletes dumps
  older than 30 days.
- **Nightly:** copy the exchange's finished day files (every snapshot and journal except the
  newest pair) to S3, then delete local copies older than a week. The gateway only ever reads
  the newest pair and never deletes anything itself. At the simulator's default activity
  that is about 3 GB a month in S3.
- **Disk alarm:** a CloudWatch alarm when the disk passes 80%. market-data's `ticks` grow
  about 13 MB a day and are kept on purpose; how to move old ones rather than delete them is
  in [BACKLOG.md](BACKLOG.md).
- **Uptime:** a free checker (UptimeRobot or Better Stack) on `app.`, `api.` and `md.`.
- **Server:** automatic security updates.
- **Spend:** a CloudWatch billing alarm, set up before anything else.

## Next step: two servers

Planned once one server is running. The exchange (gateway, its database, the simulator)
moves to a second, private server; the broker stays on the first; the web client moves to
S3 and CloudFront. The broker then reaches the exchange over AWS's private network, the way
a real broker reaches a venue, and each half gets its own memory. About $39 a month in all.

What changes:

- a second `t4g.small` with a 20 GB disk and a public IPv4 address for outbound traffic only
  (pulling images, updates; a NAT gateway instead would cost about $33 a month). Its
  security group allows nothing in except 9878 and 9879 from the broker server;
- three settings point at the exchange server's private address instead of `gateway`:
  `FIX_HOST`, `MD_FEED_URL` and the simulator's host;
- the exchange's and the simulator's compose files move to the new server unchanged;
- the web client becomes an S3 bucket behind a CloudFront distribution with an ACM
  certificate, uploaded by CI instead of built into the Caddy image;
- deploys target two servers, the exchange first.

No code changes: every process already finds the others through settings.

## To do

In the repo:

| | |
|---|---|
| Five Dockerfiles | exchange, backend, market-data, simulator, web (with Caddy) |
| Three compose files and a `Caddyfile` | `exchange-alpha/deploy/`, `participants/simulator/deploy/`, `broker/deploy/` |
| GitHub Actions: `ci` | tests and typechecks on every PR |
| GitHub Actions: `deploy` | images and the server on merge to `main` |
| Nightly scripts | database dumps, and archiving the exchange's day files |

In AWS, once:

| | |
|---|---|
| Account | a billing alarm first; an admin user, not the root account |
| IAM | a role for GitHub Actions (OpenID Connect); an instance role for the server (Systems Manager, S3) |
| Server | a `t4g.small` with Docker, a 2 GB swap file and automatic updates; a security group allowing 443 and 80 |
| S3 | a bucket for backups and archived day files, with lifecycle rules |
| DNS | a domain in Route 53: `app.`, `api.` and `md.` to the server's Elastic IP |
| Monitoring | a disk alarm and an uptime checker |
