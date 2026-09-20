#!/usr/bin/env bash
set -euo pipefail

umask 077

app_dir="/opt/luminaos"
backup_dir="/var/backups/luminaos"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
plain_path="${backup_dir}/luminaos-${timestamp}.dump"
encrypted_path="${plain_path}.gpg"

cleanup() {
  if [[ -f "${plain_path}" ]]; then
    shred --remove "${plain_path}"
  fi
  rm -f "${encrypted_path}"
}
trap cleanup EXIT

mkdir -p "${backup_dir}"
cd "${app_dir}"

docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${plain_path}"

docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T postgres pg_restore --list < "${plain_path}" > /dev/null

gpg --batch --yes --symmetric --cipher-algo AES256 \
  --passphrase-file /etc/luminaos/backup-passphrase \
  --output "${encrypted_path}" "${plain_path}"

shred --remove "${plain_path}"

set -a
# shellcheck disable=SC1091
source /etc/luminaos/backup.env
set +a

/opt/oci-cli/bin/oci os object put \
  --auth instance_principal \
  --namespace-name "${OCI_NAMESPACE}" \
  --bucket-name "${OCI_BUCKET}" \
  --name "daily/$(basename "${encrypted_path}")" \
  --file "${encrypted_path}" \
  --force > /dev/null

echo "Encrypted backup uploaded: $(basename "${encrypted_path}")"
