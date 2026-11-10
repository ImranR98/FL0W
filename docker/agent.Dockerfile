# Generic FL0W agent. Node built-ins, GNU tar and curl for artifact fetches.
FROM node:alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

RUN apk add --no-cache tar gzip curl ca-certificates \
    && tar --version | head -1

WORKDIR /app
COPY src/agent/ ./
RUN chmod 0755 /app/fetch-artifact.sh \
    && mkdir -p /state && chown node:node /state

ENV NODE_ENV=production
EXPOSE 8788
USER node
ENTRYPOINT ["node", "server.mjs"]
