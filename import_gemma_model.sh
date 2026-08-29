#!/usr/bin/env bash
# =========================================================================
# 🍓 Import Gemma 2B GGUF Model into Ollama on Raspberry Pi 5
# =========================================================================

set -e

GGUF_FILE="${1:-./data/models/gemma-2b.gguf}"

if [ ! -f "$GGUF_FILE" ]; then
    echo "❌ Error: GGUF file not found at $GGUF_FILE"
    echo "Usage: ./import_gemma_model.sh /path/to/gemma-2b.gguf"
    exit 1
fi

echo "🍓 Importing Gemma 2B into Ollama on Raspberry Pi 5..."
MODELFILE_TMP="$(mktemp)"
echo "FROM $(realpath "$GGUF_FILE")" > "$MODELFILE_TMP"

ollama create gemma:2b -f "$MODELFILE_TMP"
rm -f "$MODELFILE_TMP"

echo "✅ Gemma 2B successfully imported into Ollama!"
echo "   Verify with: ollama list"
echo "   Test with  : ollama run gemma:2b 'Hello RPi 5'"
