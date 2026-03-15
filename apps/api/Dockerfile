FROM node:22-alpine AS base
WORKDIR /app

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json

RUN corepack enable
RUN pnpm install --frozen-lockfile=false

COPY . .
RUN pnpm --filter @mvp/shared-types build
RUN pnpm --filter @mvp/api build

EXPOSE 3001
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
