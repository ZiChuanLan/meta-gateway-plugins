# Standalone image for trying the host without a gateway. The gateway does not
# need it: a market install unpacks the same files into the plugin directory and
# starts `node src/host.mjs` itself, using the Node the gateway image ships.
#
# Same major as the gateway image (Alpine 3.22 provides Node 22), so a bug that
# only shows on one of them shows up here first.
FROM node:22-alpine

WORKDIR /app
COPY package.json plugin.json ./
COPY src ./src
COPY public ./public

# Installing a provider package needs `tar` for the npm tarball and CA roots for
# the registry; node:22-alpine has both, npm is only a fallback for packages that
# declare dependencies.
ENV META_GATEWAY_PLUGIN_PORT=9300 \
    META_GATEWAY_PLUGIN_ADDR=0.0.0.0 \
    META_GATEWAY_PLUGIN_DIR=/data \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 9300

CMD ["node", "src/host.mjs"]
