#!/bin/bash
# The LHC lane's server: the Claude-LHC V2 build from source (/srv/work/t3code-v2-lhc, branch
# lhc-provider-v2), run with Node, all arguments passed unchanged. CLAUDE_LHC_SIDECAR names the
# staged, pin-checked sidecar (lhc/stage-sidecar.sh). The released artifact this replaced is in
# the snapshot's server-path.txt.
export CLAUDE_LHC_SIDECAR=/srv/work/t3code-v2-lhc/lhc/.sidecar/node_modules/claude-lhc/dist/sidecar.js
exec /home/leemoore/.local/share/fnm/node-versions/v24.18.0/installation/bin/node /srv/work/t3code-v2-lhc/apps/server/dist/bin.mjs "$@"
