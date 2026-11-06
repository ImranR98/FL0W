# GTK-capable FL0W agent for tools such as Ludusavi.
FROM node:latest@sha256:a98e6fda54fdbb22d4238054cca9a2a113bcd1191c09193a535aae22f400aa8e

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tar gzip ca-certificates curl libgtk-3-0t64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/agent/ ./
RUN chmod 0755 /app/fetch-artifact.sh \
    && mkdir -p /state && chown node:node /state

ENV NODE_ENV=production
EXPOSE 8788
USER node
ENTRYPOINT ["node", "server.mjs"]
