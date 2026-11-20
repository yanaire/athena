FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 coreutils && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /outputs && chmod 0555 /workspace /outputs
USER 65534:65534
WORKDIR /workspace
