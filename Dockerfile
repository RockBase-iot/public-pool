############################
# Docker build environment #
############################

FROM node:22.11.0-bookworm-slim AS build

# Upgrade all packages and install dependencies
RUN apt-get update \
    && apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        cmake \
        curl \
        ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build

COPY . .

# Build Public Pool using NPM
RUN npm i && npm run build

############################
# Docker final environment #
############################

FROM node:22.11.0-bookworm-slim

# Expose ports for Stratum and Bitcoin RPC
EXPOSE 3333 3334 8332

WORKDIR /public-pool

# Configurable heap size via build-arg / env (default 512MB for small servers)
ENV NODE_HEAP_MB=512
ENV PM2_MAX_MEMORY=800M
ENV PM2_WORKERS=1

# Install pm2 globally for cluster mode
RUN npm install -g pm2

# Copy built binaries into the final image
COPY --from=build /build .
#COPY .env.example .env

CMD ["pm2-runtime", "ecosystem.config.js"]
