#!/usr/bin/env bash
# wire-stripe-to-railway.sh
#
# Seals Stripe secrets into the Phantom vault and pushes them to Railway.
# The agent can invoke this script; it never sees any secret values.
#
# Usage:
#   ./server/scripts/wire-stripe-to-railway.sh
#
# Prerequisites:
#   - phantom installed: https://phantom.ashlr.ai
#   - RAILWAY_TOKEN already in vault: `phantom stack add railway`
#   - .phantom.toml at repo root filled in with your Railway IDs
#
# Idempotent: running it a second time re-seals the same keys (phantom init
# does an upsert) and re-pushes — safe to run after key rotations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_TMP="${REPO_ROOT}/.env.stripe-tmp"

# Confirm phantom is available
if ! command -v phantom &>/dev/null; then
  echo "ERROR: phantom is not installed. Visit https://phantom.ashlr.ai to install."
  exit 1
fi

echo ""
echo "=== Stripe → Phantom → Railway secret wiring ==="
echo ""
echo "You will be prompted for three Stripe values. Input is hidden (read -rs)."
echo "Values are written to a temp .env file, sealed into the Phantom vault,"
echo "then pushed to Railway. The temp file is deleted before the script exits."
echo ""

# Read secrets from TTY — never echoed, never in shell history via variable expansion
read -rs -p "STRIPE_SECRET_KEY (sk_live_... or sk_test_...): " STRIPE_SECRET_KEY
echo ""
read -rs -p "STRIPE_WEBHOOK_SECRET (whsec_...): " STRIPE_WEBHOOK_SECRET
echo ""
read -rs -p "STRIPE_PRICE_ID_PRO (price_...): " STRIPE_PRICE_ID_PRO
echo ""

# Validate inputs look non-empty (no format enforcement — keys change over time)
if [[ -z "${STRIPE_SECRET_KEY}" || -z "${STRIPE_WEBHOOK_SECRET}" || -z "${STRIPE_PRICE_ID_PRO}" ]]; then
  echo "ERROR: one or more values were empty. Aborting — nothing written."
  exit 1
fi

# Write temp env file. Uses a tmp name so it never matches .gitignore's
# .env.local glob that developers might have added to staging area already.
cat >"${ENV_TMP}" <<EOF
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
STRIPE_PRICE_ID_PRO=${STRIPE_PRICE_ID_PRO}
EOF

# Clear variables from memory immediately after writing
unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID_PRO

echo "[1/3] Sealing secrets into Phantom vault..."
phantom init --env-file "${ENV_TMP}" --yes

echo "[2/3] Pushing to Railway via .phantom.toml sync target..."
(cd "${REPO_ROOT}" && phantom sync --platform railway)

echo "[3/3] Cleaning up temp env file..."
rm -f "${ENV_TMP}"

echo ""
echo "Done. Stripe secrets are now live in the Railway environment."
echo "Run 'phantom list' to confirm keys are in the vault (values are never shown)."
echo ""

# Offer to also clean up any stray .env.local the user may have had
if [[ -f "${REPO_ROOT}/server/.env.local" ]]; then
  echo "NOTE: server/.env.local exists. It may contain plaintext secrets."
  read -r -p "Run 'phantom init' on it to seal those too? [y/N] " CONFIRM
  if [[ "${CONFIRM}" =~ ^[Yy]$ ]]; then
    phantom init --env-file "${REPO_ROOT}/server/.env.local" --yes
    echo "Sealed. You can now delete server/.env.local if it only contained secrets."
  fi
fi
