#!/usr/bin/env bash
# The host's own jobs for a deployed Dozo stack: a daily backup and a health check every five
# minutes, both as systemd timers. Runs on the Docker host as root, from the deploy folder, where
# deploy.sh copies it on every deploy. Install once:
#   ssh <host> /opt/dozo/host-jobs.sh install
# Commands:
#   install        write and enable the two timers
#   remove         disable and delete them (backups stay)
#   backup         one backup now: <folder>/backups/<UTC stamp>/{db.dump,data.tgz,SHA256SUMS}
#   verify [dir]   restore a backup (default: the newest) into a throwaway database container and
#                  compare its row counts with the live database, which is only read
#   health         one health check now
# Restore steps and how to read the timers: dozo/deploy/README.md. Exits 0 on success, 1 when
# `health` finds a fault or `verify` finds different row counts, 2 on any other failure.
set -Eeuo pipefail
umask 077

root=$(cd "$(dirname "$0")" && pwd)
backups=$root/backups
keep=${DOZO_BACKUP_KEEP:-7}
units=/etc/systemd/system

die() {
  echo "host-jobs: $*" >&2
  exit 2
}
trap 'die "line $LINENO: $BASH_COMMAND"' ERR
[ "$keep" -ge 1 ] 2>/dev/null || die "DOZO_BACKUP_KEEP must be a number, 1 or more"

# The stack's containers are found by its volumes, whatever the panel calls the project:
# deploy.sh merges the compose file as project "dozo", which fixes their names.
postgres() {
  local id
  id=$(docker ps -q --filter volume=dozo_postgres | sed -n 1p)
  [ -n "$id" ] || die "no running container mounts the dozo_postgres volume"
  echo "$id"
}

# counts <psql command...>: the row count of every table, one "schema.table count" line each.
counts() {
  "$@" -At -F ' ' -c "
    select format('%I.%I', schemaname, tablename),
      (xpath('/row/c/text()', query_to_xml(
        format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]
    from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by 1"
}

backup() {
  local pg data stamp out rc
  pg=$(postgres)
  data=$(docker volume inspect -f '{{.Mountpoint}}' dozo_data)
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out=$backups/$stamp.partial
  mkdir -p "$backups"
  # One run at a time: a second one would delete the first one's unfinished folder.
  exec 9>"$backups/.lock"
  flock -n 9 || die "another backup is running"
  rm -rf "$backups"/*.partial # what an interrupted run left
  mkdir "$out"

  docker exec "$pg" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' >"$out/db.dump"
  docker exec -i "$pg" pg_restore --list <"$out/db.dump" >/dev/null
  # Bots write while this runs: tar exits 1 for a file that changed as it was read, and the
  # archive is still usable. Anything above 1 fails the backup.
  rc=0
  tar -czf "$out/data.tgz" --numeric-owner -C "$data" . || rc=$?
  [ "$rc" -le 1 ] || die "the data archive failed with exit $rc"
  tar -tzf "$out/data.tgz" >/dev/null
  (cd "$out" && sha256sum db.dump data.tgz >SHA256SUMS)
  mv "$out" "$backups/$stamp"

  # ponytail: whole bot homes, seven times; exclude caches or move to upstream's
  # backup-prod.sh size budget when the data volume grows past a few GB.
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | sort | head -n "-$keep" |
    while read -r old; do rm -rf "$old"; done
  echo "host-jobs: backup $backups/$stamp ($(du -sh "$backups/$stamp" | cut -f1)), $(find "$backups" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | wc -l) kept"
}

verify() {
  local snapshot=${1:-} pg image name live restored
  [ -n "$snapshot" ] || snapshot=$(find "$backups" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | sort | tail -1)
  [ -r "$snapshot/db.dump" ] || die "no backup to verify (${snapshot:-$backups is empty})"
  snapshot=$(cd "$snapshot" && pwd) # Docker reads a relative path as a volume name
  (cd "$snapshot" && sha256sum --check --quiet SHA256SUMS)
  tar -tzf "$snapshot/data.tgz" >/dev/null

  pg=$(postgres)
  image=$(docker inspect -f '{{.Config.Image}}' "$pg")
  name=dozo-restore-test-$$
  # No network, its own throwaway data: nothing here can reach the live database.
  docker run -d --rm --name "$name" --network none --memory 512m \
    -e POSTGRES_HOST_AUTH_METHOD=trust -v "$snapshot/db.dump:/db.dump:ro" "$image" >/dev/null
  # shellcheck disable=SC2064
  trap "docker rm -fv $name >/dev/null 2>&1 || true" EXIT
  # The image's first start listens on TCP only once its setup is over.
  local waited=0
  until docker exec "$name" pg_isready -q -h 127.0.0.1 2>/dev/null; do
    [ "$waited" -lt 60 ] || die "the throwaway database did not start"
    sleep 1
    waited=$((waited + 1))
  done
  # The dump's row-level policies name the live database's roles, so they have to exist first.
  docker exec "$pg" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
    select format(\$\$create role %I nologin;\$\$, rolname) from pg_roles
    where rolname !~ \$\$^pg_\$\$ and rolname <> \$\$postgres\$\$"' |
    docker exec -i "$name" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1
  docker exec "$name" pg_restore --no-owner --no-privileges --exit-on-error \
    -U postgres -d postgres /db.dump

  restored=$(counts docker exec "$name" psql -U postgres -d postgres)
  live=$(counts docker exec "$pg" sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh)
  local tables rows
  tables=$(printf '%s\n' "$restored" | wc -l)
  rows=$(printf '%s\n' "$restored" | awk '{n += $2} END {print n + 0}')
  [ "$rows" -gt 0 ] || die "the restored database is empty"
  if [ "$restored" = "$live" ]; then
    echo "host-jobs: VERIFY PASS ($snapshot: $tables tables, $rows rows, all equal to the live database)"
    return 0
  fi
  # Rows written since the backup show up here too: run right after `backup` for an exact match.
  diff <(printf '%s\n' "$restored") <(printf '%s\n' "$live") | grep '^[<>]' |
    sed -e 's/^</restored:/' -e 's/^>/live:    /' >&2 || true
  echo "host-jobs: VERIFY DIFFERS ($snapshot restored, $tables tables, $rows rows; the lines above differ from the live database)" >&2
  exit 1
}

health() {
  local pg project fault=0 service id state origin page
  pg=$(docker ps -aq --filter volume=dozo_postgres | sed -n 1p)
  [ -n "$pg" ] || die "no container mounts the dozo_postgres volume"
  project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$pg")
  for service in postgres supervisor web api worker; do
    id=$(docker ps -q -f "label=com.docker.compose.project=$project" \
      -f "label=com.docker.compose.service=$service" | sed -n 1p)
    state=missing
    [ -z "$id" ] || state=$(docker inspect -f \
      '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
    case "$state" in
      running/healthy | running/none) ;;
      *)
        echo "host-jobs: FAULT: $service is $state" >&2
        fault=1
        ;;
    esac
  done
  id=$(docker ps -q -f "label=com.docker.compose.project=$project" \
    -f label=com.docker.compose.service=api | sed -n 1p)
  if [ -n "$id" ]; then
    docker exec "$id" node -e \
      "fetch('http://127.0.0.1:3100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || {
      echo "host-jobs: FAULT: the api does not answer /health" >&2
      fault=1
    }
    # The public address, through the proxy and whatever is in front of it.
    origin=$(docker exec "$id" printenv WEB_ORIGIN) || origin=
    page=$(curl -fsS -m 20 "$origin/" 2>/dev/null) || page=
    grep -qi '<title>[^<]*dozo' <<<"$page" || {
      echo "host-jobs: FAULT: $origin/ does not answer with the app's page" >&2
      fault=1
    }
  fi
  [ "$fault" -eq 0 ] || exit 1
  echo "host-jobs: healthy"
}

# unit <name> <description> <command> <timer line> <seconds a run may take>
unit() {
  cat >"$units/$1.service" <<EOF
[Unit]
Description=$2
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
TimeoutStartSec=$5
ExecStart=$root/host-jobs.sh $3
EOF
  cat >"$units/$1.timer" <<EOF
[Unit]
Description=$2

[Timer]
$4
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

install_units() {
  unit dozo-backup "Dozo: daily backup of the database and app data" backup \
    "OnCalendar=*-*-* 03:30:00" 3600
  unit dozo-health "Dozo: health check of the stack and its public address" health \
    "OnCalendar=*:0/5" 120
  chmod 700 "$root/host-jobs.sh"
  mkdir -p "$backups"
  systemctl daemon-reload
  systemctl enable --now dozo-backup.timer dozo-health.timer
  echo "host-jobs: timers installed (systemctl list-timers 'dozo-*')"
}

remove_units() {
  systemctl disable --now dozo-backup.timer dozo-health.timer 2>/dev/null || true
  rm -f "$units"/dozo-backup.{service,timer} "$units"/dozo-health.{service,timer}
  systemctl daemon-reload
  echo "host-jobs: timers removed; $backups is kept"
}

case "${1:-}" in
  install) install_units ;;
  remove) remove_units ;;
  backup) backup ;;
  verify) verify "${2:-}" ;;
  health) health ;;
  *)
    echo "Usage: host-jobs.sh install | remove | backup | verify [dir] | health" >&2
    exit 64
    ;;
esac
