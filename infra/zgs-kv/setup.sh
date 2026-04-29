#!/usr/bin/env bash
# Generate config.toml from root .env file.
# Run from repo root: bash infra/zgs-kv/setup.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE"
  exit 1
fi

source "$ENV_FILE"

PRIVATE_KEY="${ZG_PRIVATE_KEY#0x}"
if [ -z "$PRIVATE_KEY" ]; then
  echo "ERROR: ZG_PRIVATE_KEY not set in .env"
  exit 1
fi

WALLET_ADDR=$(node -e "
const {ethers} = require('ethers');
const w = new ethers.Wallet('0x$PRIVATE_KEY');
process.stdout.write(w.address.toLowerCase());
")

STREAM_ID=$(node -e "
const {ethers} = require('ethers');
process.stdout.write(ethers.keccak256(ethers.toUtf8Bytes('zeromem:$WALLET_ADDR')).slice(2));
")

OUT="$SCRIPT_DIR/config.toml"
sed \
  -e "s|<STREAM_ID_WITHOUT_0X>|$STREAM_ID|g" \
  -e "s|<PRIVATE_KEY_WITHOUT_0X>|$PRIVATE_KEY|g" \
  "$SCRIPT_DIR/config.toml.template" > "$OUT"

echo "Written: $OUT"
echo "  wallet:    $WALLET_ADDR"
echo "  stream_id: $STREAM_ID"
echo ""
echo "Next:"
echo "  1. Download zgs_kv binary from https://github.com/0gfoundation/0g-storage-kv/releases"
echo "  2. Place binary alongside config.toml"
echo "  3. Run: ./zgs_kv --config config.toml"
