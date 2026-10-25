# The bundle is plain JavaScript, so the build stage runs on the native build platform
# and its output is shared by every target architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime: Node + a single bundled file, no node_modules.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    CONFIG_PATH=/config/config.yaml \
    SIGNING_KEY_PATH=/data/signing-key.pem
COPY --from=build /app/dist/server.mjs ./server.mjs
COPY config/config.yaml /config/config.yaml
# The app is one bundled file. npm, corepack and yarn are never used at runtime, and npm's own
# dependencies are a regular source of CVEs, so they are removed.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
