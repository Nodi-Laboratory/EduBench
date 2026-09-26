FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# pdftoppm/pdfinfo render PDF pages before Document Parse.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
# tsx and the migration/seed scripts run at container start, so the full
# node_modules from the build stage is kept.
COPY --from=build --chown=node:node /app ./
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
EXPOSE 3000
CMD ["npm", "start"]
