# Railway Docker build (monorepo) - server only
FROM node:18-bullseye AS build
WORKDIR /app

# Copy lockfiles first for caching
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json

# Install deps (dev 포함: TS build에 필요)
RUN npm install --include=dev --prefer-offline --no-audit --no-fund

# Copy the rest
COPY . .

# Build only server
RUN npm run build --workspace server

FROM node:18-bullseye-slim AS run
WORKDIR /app

# Copy minimal runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server

ENV NODE_ENV=production
CMD ["npm","start","--workspace","server"]
