# The host runs third-party plugin packages, so npm has to be here at run time:
# installing a package is how a subscription is added.
FROM node:24-alpine

WORKDIR /app
COPY package.json plugin.json ./
COPY src ./src
COPY public ./public

ENV META_GATEWAY_PLUGIN_PORT=9300 \
    META_GATEWAY_PLUGIN_ADDR=0.0.0.0 \
    META_GATEWAY_PLUGIN_DIR=/data \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 9300

CMD ["node", "src/host.mjs"]
