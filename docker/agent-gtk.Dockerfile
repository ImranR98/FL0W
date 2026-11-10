# GTK-capable FL0W agent for tools such as Ludusavi.
FROM node:latest@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725

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
