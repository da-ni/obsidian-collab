#!/bin/bash
# Build and copy plugin to a vault
# Usage: ./deploy.sh /path/to/vault

set -euo pipefail

VAULT="${1:?Usage: ./deploy.sh /path/to/vault}"
DEST="$VAULT/.obsidian/plugins/obsidian-collab"

npm run build
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "Deployed to $DEST"
