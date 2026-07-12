# syntax=docker/dockerfile:1

# --- build stage: compile TS -> JS (no ncc bundling here — that's an
# Actions Marketplace convention; Docker images conventionally ship
# node_modules rather than a single bundled file) ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build:daemon

# --- runtime stage: production deps only + compiled output, non-root user ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/lib ./lib

RUN addgroup -S stackwatch && adduser -S stackwatch -G stackwatch
USER stackwatch

EXPOSE 8080
ENTRYPOINT ["node", "lib/daemon/index.js"]
