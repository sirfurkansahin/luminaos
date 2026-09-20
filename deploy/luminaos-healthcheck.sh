#!/usr/bin/env bash
set -euo pipefail

response="$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health)"

grep --fixed-strings --quiet '"status":"ok"' <<< "${response}"
grep --fixed-strings --quiet '"db":"ok"' <<< "${response}"
grep --fixed-strings --quiet '"redis":"ok"' <<< "${response}"

echo "LuminaOS health check passed"
