# Container for FAL Serverless ("direct server" mode, see pyproject.toml).
# fal builds it remotely: `fal deploy imgen-storybook`.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# fal requires curl in the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    STORYBOOK_DATA_DIR=/data/storybook
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json schema.graphql ./
EXPOSE 8080
CMD ["node", "dist/server/main.js"]
