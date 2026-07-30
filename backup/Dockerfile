# Official ClickHouse client image already has clickhouse-client + tzdata.
# Add aws-cli (via pip so no repo-manager surprises) + tar/gzip.
FROM clickhouse/clickhouse-server:24.8-alpine

RUN apk add --no-cache \
      bash \
      curl \
      gzip \
      tar \
      py3-pip \
      coreutils \
    && pip install --break-system-packages --no-cache-dir awscli

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
