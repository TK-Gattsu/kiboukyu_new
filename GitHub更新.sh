#!/bin/bash
cd "$(dirname "$0")"
echo "Uploading to GitHub..."
git add index.html
git commit -m "Update"
git push
echo ""
echo "=== Upload complete! ==="
