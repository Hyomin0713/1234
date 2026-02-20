# Railway/Nixpacks may detect Dockerfile and use it.
# This Dockerfile builds ONLY the `server` workspace (Express/TS) and runs it without devDependencies.

FROM node:18-bullseye AS build
WORKDIR /app

# Copy lockfiles + workspace manifests first (better layer caching)
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json

# Install deps needed to build SERVER (includes devDeps so `tsc` exists)
# NOTE: This intentionally does NOT install web workspace.
RUN npm install --include=dev --workspace server --no-audit --no-fund

# Now copy the rest of the repo
COPY . .

# Build server (tsc -> dist)
RUN npm run build --workspace server

# Remove devDependencies for server to keep runtime small
RUN npm prune --omit=dev --workspace server


FROM node:18-bullseye AS run
WORKDIR /app
ENV NODE_ENV=production

# Copy only what runtime needs
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server

WORKDIR /app/server
EXPOSE 3000

CMD ["npm", "start"]
