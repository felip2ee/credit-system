# syntax=docker/dockerfile:1

# --- pinned Restic binary ---------------------------------------------------
FROM restic/restic:0.18.1 AS restic

# --- backup image ---------------------------------------------------------
# PostgreSQL 18 client (pg_dump / pg_restore / psql, plus initdb + pg_ctl for
# the isolated restore drill), busybox crond for the schedule, and curl as the
# SMTP client: the app sends mail with nodemailer over SMTP, and curl is the
# shell-side equivalent that honours SMTP_SECURE through the smtps:// scheme.
# No Docker socket, no Docker-in-Docker: this image never talks to a daemon.
FROM postgres:18.6-alpine3.23

RUN apk add --no-cache curl jq tzdata coreutils su-exec

COPY --from=restic /usr/bin/restic /usr/local/bin/restic

COPY backup.sh restore-test.sh prune.sh /opt/backup/
COPY crontab /etc/crontabs/root
RUN chmod 0755 /opt/backup/backup.sh /opt/backup/restore-test.sh /opt/backup/prune.sh \
 && chmod 0644 /etc/crontabs/root

# Runs as root so crond can read the mounted secrets and write the scratch and
# state volumes; restore-test.sh drops to the unprivileged "postgres" user for
# every throwaway-cluster command (initdb/postgres refuse to run as root).
WORKDIR /opt/backup
ENTRYPOINT ["/usr/sbin/crond", "-f", "-d", "8"]
