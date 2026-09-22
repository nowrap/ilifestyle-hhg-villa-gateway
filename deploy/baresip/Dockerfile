FROM debian:trixie-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends baresip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

USER 65532:65532
ENTRYPOINT ["baresip", "-f", "/config"]
