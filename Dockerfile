# Multi-stage Google Cloud Run build (Node 24 LTS, minimal production image)
FROM node:24-slim AS builder
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm install --ignore-scripts
COPY packages/shared packages/shared
COPY backend backend
COPY frontend frontend
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 appuser
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/backend/package.json ./backend/
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist
RUN mkdir -p /app/data && chown -R appuser:nodejs /app/data
USER appuser
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
