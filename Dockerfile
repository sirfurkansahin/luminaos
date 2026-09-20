# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm rebuild argon2 @swc/core esbuild
RUN pnpm turbo run build --filter=...@luminaos/server
RUN pnpm --filter @luminaos/server deploy --legacy --prod /deploy \
    && cp -r apps/server/src/db/migrations /deploy/dist/db/migrations

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /deploy ./

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
