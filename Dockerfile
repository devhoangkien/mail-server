# Dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./

RUN mkdir -p maildir certs logs

EXPOSE 25 587 143 3000

CMD ["bun", "src/index.ts"]
