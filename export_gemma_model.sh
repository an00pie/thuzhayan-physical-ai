#!/usr/bin/env bash
# =========================================================================
# 📦 Export Gemma 2B Model for Raspberry Pi 5 Offline Transfer
# =========================================================================

set -e

OUTPUT_DIR="${1:-./data/models}"
mkdir -p "$OUTPUT_DIR"

BLOB_PATH="/usr/share/ollama/.ollama/models/blobs/sha256-c1864a5eb19305c40519da12cc543519e48a0697ecd30e15d5ac228644957d12"
TARGET_FILE="$OUTPUT_DIR/gemma-2b.gguf"

if [ -f "$BLOB_PATH" ]; then
    echo "📦 Exporting Gemma 2B GGUF Model to $TARGET_FILE..."
    cp "$BLOB_PATH" "$TARGET_FILE"
    echo "✅ Export complete! Model file created at: $TARGET_FILE"
    echo "   File size: $(du -h "$TARGET_FILE" | cut -f1)"
    echo ""
    echo "📋 To transfer to Raspberry Pi 5:"
    echo "   • Via SCP/Tailscale : scp $TARGET_FILE pi@<raspi-ip>:~/thuzhayan/data/models/"
    echo "   • Via USB Drive     : Copy $TARGET_FILE to USB drive"
    echo ""
    echo "📋 To import on Raspberry Pi 5:"
    echo "   ./import_gemma_model.sh $TARGET_FILE"
else
    echo "❌ Error: Could not locate Gemma 2B blob at $BLOB_PATH"
    exit 1
fi
