# AGENTS.md — Public-Pool

> This file is intended for AI coding agents. It describes the project's architecture, conventions, and workflows based on the actual source tree.

---

## Project Overview

**Public-Pool** is a NestJS + TypeScript Bitcoin Stratum mining server. It exposes a Stratum V1 TCP/TLS socket server for miners and a REST API for pool statistics and management. The server integrates with a Bitcoin node via RPC (and optionally ZMQ) and persists data in PostgreSQL using TypeORM.

Key traits:
- Runtime: Node.js 22 (see `Dockerfile`)
- Framework: NestJS 9 on Fastify (`@nestjs/platform-fastify`)
- Language: TypeScript 5, target ES2020, module CommonJS
- Database: PostgreSQL (TypeORM)
- Process orchestration: PM2 with a master/worker split (`ecosystem.config.js`)

---

## Technology Stack

| Layer | Libraries / Tools |
|-------|-------------------|
| Framework | NestJS 9 (`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`) |
| Config | `@nestjs/config` (`.env` driven) |
| Scheduling | `@nestjs/schedule` |
| Caching | `@nestjs/cache-manager` |
| HTTP client | `@nestjs/axios` / `axios` |
| Database | `typeorm` + `pg` (PostgreSQL) |
| Pub/Sub | `pg-pubsub` (used to broadcast mining info from master to workers) |
| ZMQ | `zeromq` (subscribe to Bitcoin `rawblock` events) |
| Bitcoin | `bitcoinjs-lib`, `bitcoinjs-message`, `rpc-bitcoin`, `tiny-secp256k1`, `merkle-lib` |
| Notifications | `discord.js`, `node-telegram-bot-api` |
| Process Mgr | `pm2` (production) |
| Testing | `jest` + `ts-jest` + `@nestjs/testing` |
| Lint/Format | `eslint` (`@typescript-eslint`, `prettier`) |

Patches:
- `patch-package` runs on `postinstall`. There is one patch: `patches/rpc-bitcoin+2.0.0.patch`.

---

## Code Organization

```
src/
  main.ts                 # Entry point: Fastify bootstrap, TLS cert reload watcher
  app.module.ts           # Root NestJS module: wires ORM, controllers, providers
  app.controller.ts       # Root REST endpoints (/info, /pool, /network, /info/chart)
  controllers/            # REST controllers
    address/
    client/
    external-share/
  services/               # Business logic / domain services
    stratum-v1.service.ts         # TCP/TLS Stratum socket servers
    stratum-v1-jobs.service.ts    # Job template management for miners
    bitcoin-rpc.service.ts        # Bitcoin RPC + ZMQ + pg-pubsub
    notification.service.ts       # Telegram/Discord notifications
    discord.service.ts
    telegram.service.ts
    btc-pay.service.ts
    braiins.service.ts
    external-shares.service.ts
    app.service.ts
  models/                 # Domain models, DTOs, enums, validators
    stratum-messages/     # Stratum message types (authorize, submit, notify, etc.)
    bitcoin-rpc/          # RPC type definitions (IBlockTemplate, IMiningInfo)
    enums/                # eRequestMethod, eResponseMethod, eStratumErrorCode
    validators/           # Custom class-validator rules (bitcoin-address.validator)
    StratumV1Client.ts    # Per-miner state machine
    MiningJob.ts
    ExternalPoolShare.ts
  ORM/                    # TypeORM entities + services + modules
    client/
    client-statistics/
    address-settings/
    blocks/
    rpc-block/
    telegram-subscriptions/
    home-graph/
    external-shares/
    _views/user-agent-report/
    _migrations/UniqueNonceIndex.ts
  utils/
    difficulty.utils.ts
```

---

## Runtime Architecture

### Master / Worker Split
Production runs under PM2 (`ecosystem.config.js`):
- **master** (`MASTER=true`, 1 instance): Connects to Bitcoin ZMQ, fetches block templates via RPC, persists them to `rpc_block`, and broadcasts `miningInfo` via PostgreSQL `pg-pubsub`.
- **workers** (`MASTER=false`, `PM2_WORKERS` instances, cluster mode): Handle thousands of Stratum miner TCP/TLS connections. They receive new block templates via `pg-pubsub` and push mining jobs to connected clients.

### Network Ports
- `API_PORT` (default `3334`): REST API (Fastify).
- `STRATUM_PORTS` (default `3333,3332,3331,3330`): Plain TCP Stratum servers.
- `SECURE_STRATUM_PORTS` (e.g., `4333,4332,4331,4330`): TLS Stratum servers (enabled when `STRATUM_SECURE=true`).
- Bitcoin RPC port (`8332`) and optional ZMQ port are client-side connections, not exposed by this app.

### TLS Certificates
If `API_SECURE=true` or `STRATUM_SECURE=true`, the app reads `secrets/key.pem` and `secrets/cert.pem`. The API entry point also watches these files for changes and reloads the Fastify secure context dynamically.

---

## Build and Run Commands

Install dependencies:
```bash
npm install
```

Create an `.env` file from `.env.example` and fill in values before running.

Development:
```bash
npm run start:dev     # NestJS watch mode
npm run start         # Single run (no watch)
```

Production build:
```bash
npm run build         # Outputs to dist/
npm run start:prod    # node dist/main
```

Docker (local):
```bash
docker build -t public-pool .
docker compose up -d
```

Docker / PM2 (production image):
```bash
# The Dockerfile runs:
#   pm2-runtime ecosystem.config.js
```

---

## Testing Instructions

Unit tests (Jest, `src/**/*.spec.ts`):
```bash
npm run test
npm run test:cov      # With coverage
npm run test:watch    # Watch mode
```

End-to-end tests (`test/**/*.e2e-spec.ts`):
```bash
npm run test:e2e
```

Jest config is inline in `package.json`. E2E config is `test/jest-e2e.json`.

---

## Code Style Guidelines

- **Formatter**: Prettier (`npm run format`)
  - `singleQuote: true`
  - `trailingComma: "all"`
- **Linter**: ESLint (`npm run lint`)
  - Parser: `@typescript-eslint/parser`
  - Extends: `@typescript-eslint/recommended`, `plugin:prettier/recommended`
  - Explicit return types and `any` are allowed (rules are off).
- **Import style**: Standard ES/NestJS imports. `reflect-metadata` is imported in `main.ts`.
- **Strictness**: TypeScript has `strictNullChecks: false` and `noImplicitAny: false`.

---

## Security Considerations

- **`.env` is required**; `main.ts` exits early if `API_PORT` is missing.
- Bitcoin RPC credentials can be provided via `BITCOIN_RPC_USER`/`BITCOIN_RPC_PASSWORD` **or** `BITCOIN_RPC_COOKIEFILE`.
- Stratum and API TLS require PEM files under `secrets/`.
- The project connects directly to a Bitcoin node RPC and optionally ZMQ; ensure `rpcallowip` is configured correctly on the node.
- TypeORM `synchronize` is enabled **only when `PRODUCTION != 'true'`**.

---

## Key Configuration Files

- `package.json` — Dependencies, scripts, and inline Jest config.
- `tsconfig.json` — TypeScript compiler options (ES2020, CommonJS, decorators enabled).
- `nest-cli.json` — NestJS CLI config; `deleteOutDir: true`.
- `.env.example` — Environment variable template (Bitcoin RPC, DB, ports, bot tokens).
- `ecosystem.config.js` — PM2 master/worker orchestration.
- `docker-compose.yml` / `docker-compose-production.yaml` — Local and full production stacks.
- `Dockerfile` — Multi-stage build using Node 22 slim, installs native build tools for `zeromq`, runs `pm2-runtime`.
