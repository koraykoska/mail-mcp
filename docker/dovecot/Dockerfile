FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends dovecot-imapd \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system vmail \
  && useradd --system --gid vmail --home-dir /var/mail --shell /usr/sbin/nologin vmail

COPY docker/dovecot/dovecot.conf /etc/dovecot/dovecot.conf
COPY docker/dovecot/entrypoint.sh /entrypoint.sh
COPY test/fixtures/certs/dovecot-cert.pem /certs/dovecot-cert.pem
COPY test/fixtures/certs/dovecot-key.pem /certs/dovecot-key.pem
RUN chmod 755 /entrypoint.sh && chmod 644 /certs/dovecot-key.pem

EXPOSE 143 993
ENTRYPOINT ["/entrypoint.sh"]
