# Small Alpine image with clickhouse-client + aws-cli. Runs a bash loop that
# dumps the whole gonka_vote database once a day and uploads it to R2.
FROM alpine:3.20

RUN apk add --no-cache \
      bash \
      curl \
      gzip \
      tar \
      tzdata \
      aws-cli \
      clickhouse-client \
      coreutils

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
