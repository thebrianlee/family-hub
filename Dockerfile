FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3847
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data
# No DB file name here: the app picks sproutwall.db, or family-hub.db on an
# install from before the rename (scripts/lib/db-path.mjs).
ENV PHOTO_DIR=/photos
# tzdata: SQLite date('now','localtime') uses the C library, which needs the
# zone files to follow the household timezone (TZ). Without them it stays UTC.
RUN apk add --no-cache su-exec tzdata \
  && mkdir -p /data /photos \
  && chown node:node /data /photos
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/bridge ./bridge
COPY --from=build /app/scripts ./scripts
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3847
VOLUME ["/data", "/photos"]
ENTRYPOINT ["/entrypoint.sh"]
