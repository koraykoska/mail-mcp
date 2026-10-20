#!/bin/sh
set -eu
if [ -n "${IMAP_CAPABILITY_REMOVE:-}" ]; then
  # Dovecot 2.3 treats `imap_capability = -TOKEN` as the entire banner.
  # Advertise a normal set and drop only the named tokens (a leading "-" is ignored).
  caps='IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE SORT SORT=DISPLAY THREAD=REFERENCES THREAD=REFS THREAD=ORDEREDSUBJECT MULTIAPPEND URL-PARTIAL CATENATE UNSELECT CHILDREN NAMESPACE UIDPLUS LIST-EXTENDED I18NLEVEL=1 CONDSTORE QRESYNC ESEARCH ESORT SEARCHRES WITHIN CONTEXT=SEARCH LIST-STATUS BINARY MOVE SPECIAL-USE QUOTA STARTTLS'
  for token in $IMAP_CAPABILITY_REMOVE; do
    drop=${token#-}
    next=
    for item in $caps; do
      if [ "$item" != "$drop" ]; then
        next="$next $item"
      fi
    done
    caps=${next# }
  done
  printf 'protocol imap {\n  imap_capability = %s\n}\n' "$caps" > /etc/dovecot/conf.d/99-capability.conf
fi
mkdir -p /var/mail
chown -R vmail:vmail /var/mail
exec dovecot -F
