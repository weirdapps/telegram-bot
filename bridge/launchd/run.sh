#!/bin/zsh -l
# Wrapper for launchd. The `-l` (login) flag makes zsh source ~/.zprofile
# / ~/.zshrc, which is where fnm injects npm/node onto PATH. Without it
# launchd's minimal env can't find the right Node version.
set -euo pipefail
# Resolve repo root from this script's location (bridge/launchd/run.sh → ../../)
cd "$(cd "$(dirname "$0")/../.." && pwd)"
exec npm run bridge
