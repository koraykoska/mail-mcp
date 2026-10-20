#!/bin/sh
set -eu
if [ -n "${IMAP_CAPABILITY_REMOVE:-}" ]; then
  printf 'protocol imap {\n  imap_capability = %s\n}\n' "$IMAP_CAPABILITY_REMOVE" > /etc/dovecot/conf.d/99-capability.conf
fi
mkdir -p /var/mail
chown -R vmail:vmail /var/mail
exec dovecot -F
