#!/bin/bash
# Fix Yjs ESM bundle for Turbopack compatibility.
#
# Turbopack can't parse Yjs's ESM bundle because it contains binary
# encoding at module evaluation time that triggers "Unexpected end of array".
#
# This script replaces yjs.mjs with a thin re-export wrapper that loads
# from yjs.cjs instead. All the actual code is identical — CJS and ESM
# builds are generated from the same source.

YJS_DIR="node_modules/yjs/dist"

if [ -f "$YJS_DIR/yjs.mjs" ] && [ -f "$YJS_DIR/yjs.cjs" ]; then
  # Back up the original (only if not already backed up)
  if [ ! -f "$YJS_DIR/yjs.mjs.original" ]; then
    cp "$YJS_DIR/yjs.mjs" "$YJS_DIR/yjs.mjs.original"
  fi

  # Replace with a CJS re-export shim
  cat > "$YJS_DIR/yjs.mjs" << 'EOF'
// Patched: re-export from CJS build for Turbopack compatibility.
// The ESM build contains binary encoding that Turbopack can't parse.
// See: scripts/fix-yjs-esm.sh
export * from './yjs.cjs';
import yjs from './yjs.cjs';
export default yjs;
EOF

  echo "✓ Patched yjs.mjs → re-exports from yjs.cjs"
else
  echo "⚠ yjs dist files not found, skipping patch"
fi
