#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <object-name>" >&2
  exit 64
fi

umask 077
app_dir="/opt/luminaos"
encrypted_path="/var/backups/luminaos/restore-test.dump.gpg"
plain_path="/var/backups/luminaos/restore-test.dump"
object_name="$1"

cleanup() {
  cd "${app_dir}"
  docker compose -p lumina-restore --env-file .env.production \
    -f docker-compose.production.yml down -v > /dev/null 2>&1 || true
  if [[ -f "${plain_path}" ]]; then
    shred --remove "${plain_path}"
  fi
  rm -f "${encrypted_path}"
}
trap cleanup EXIT

set -a
# shellcheck disable=SC1091
source /etc/luminaos/backup.env
set +a

mkdir -p "$(dirname "${plain_path}")"

/opt/oci-cli/bin/oci os object get \
  --auth instance_principal \
  --namespace-name "${OCI_NAMESPACE}" \
  --bucket-name "${OCI_BUCKET}" \
  --name "${object_name}" \
  --file "${encrypted_path}" > /dev/null

gpg --batch --yes --decrypt \
  --passphrase-file /etc/luminaos/backup-passphrase \
  --output "${plain_path}" "${encrypted_path}"

cd "${app_dir}"
docker compose -p lumina-restore --env-file .env.production \
  -f docker-compose.production.yml up -d --wait postgres

docker compose -p lumina-restore --env-file .env.production \
  -f docker-compose.production.yml exec -T postgres \
  sh -c 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "${plain_path}"

migration_count="$(
  docker compose -p lumina-restore --env-file .env.production \
    -f docker-compose.production.yml exec -T postgres \
    sh -c 'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from drizzle.__drizzle_migrations"'
)"

echo "Restore rehearsal passed; migration rows: ${migration_count}"
