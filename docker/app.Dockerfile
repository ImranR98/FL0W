# FL0W app image: tasks, file pipelines and the unified UI in one process.
FROM node:latest@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725

ARG RESTIC_VERSION=0.19.1
ARG KUBECTL_VERSION=v1.37.2

WORKDIR /app

# Runtime tools used by one or more task/pipeline jobs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash rsync git age jq unzip tar wget \
        python3 python3-venv python3-pip ca-certificates adb curl bzip2 \
        ffmpeg perl gzip \
    && curl -fsSL "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2" -o /tmp/restic.bz2 \
    && bzip2 -d /tmp/restic.bz2 \
    && install -m 0755 /tmp/restic /usr/local/bin/restic \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod 0755 /usr/local/bin/kubectl \
    && rm -rf /var/lib/apt/lists/* /tmp/restic

COPY package.json package-lock.json ./
COPY kit ./kit
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:ui \
    && npm prune --omit=dev \
    && chown -R node:node /app

ENV NODE_ENV=production
ENV HOME=/home/node
ENV BACKUPCTL_REPO_DIR=/app
EXPOSE 8085

USER node
CMD ["node", "src/server.mjs"]
