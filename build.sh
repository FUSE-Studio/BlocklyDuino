#!/bin/sh
#
# Retired — kept only so muscle memory hits this message instead of the old
# script. It used to `rm -rf build` and repopulate from blockly/apps/blocklyduino/,
# which is destructive: build/ is now the source of truth and holds fixes that
# never existed upstream.
#
#   header.js      Event.path polyfill (Chrome 109+), audio-preload disable,
#                  flyout click-target fix
#   css/style.css  pointer-events fix for flyouts in modern browsers
#   js/init.js     category_sparki in the base toolbox
#
# It also copied blockly/*_compressed.js, which are not in the repo, and ran a
# Closure build that cannot work: build.py is Python 2 only, closure-library is
# an unchecked-out submodule, and the Google API it called is long gone. The
# only copies of the compiled Blockly core are the ones under build/js/.
#
# Running it deleted 83 tracked files and reverted 4 more. Use the Makefile.

cat >&2 <<'EOF'
build.sh is retired and does nothing — it used to destroy build/.

  make dev            build and serve locally on :8080
  make index          regenerate build/index.html from src/
  make publish-dev    publish to the dev satellite CDN
  make publish-prod   publish to the prod satellite CDN

See the Makefile header for why blockly/ is no longer a build input.
EOF
exit 1
