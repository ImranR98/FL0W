# Generic FL0W agent. Node built-ins, GNU tar and curl for artifact fetches.
FROM node:alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

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
