#!/usr/bin/env bash
# Start SortedWMS. The only thing it needs is Node.js 22.13 or newer; when that
# is missing this script offers to install it (Enter means yes) and never runs
# sudo for you. Commands: start (default), demo, sample <home|maker|3pl>,
# backup, backups, restore <file>, setup. See scripts/cli.js.
set -euo pipefail
cd "$(dirname "$0")"

NEED="22.13"

have_node() {
  command -v node >/dev/null 2>&1 && node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1);'
}

# Ask, show the exact command, run it on a bare Enter.
offer() {
  local what="$1" cmd="$2" answer=""
  echo
  echo "$what"
  echo "  $cmd"
  if [ -t 0 ]; then read -r -p "Run it now? [Y/n] " answer || answer=""; else answer="n"; fi
  case "$answer" in [Nn]*) return 1 ;; esac
  eval "$cmd"
}

if ! have_node; then
  echo "SortedWMS needs Node.js $NEED or newer. Found: $(node --version 2>/dev/null || echo 'none')."
  if command -v brew >/dev/null 2>&1; then
    offer "Install Node.js with Homebrew:" "brew install node" || true
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    offer "Install Node.js 22 with nvm (into your home folder, no sudo):" ". \"\$HOME/.nvm/nvm.sh\" && nvm install 22 && nvm use 22" || true
  else
    offer "Install nvm and Node.js 22 into your home folder (no sudo):" \
      "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && . \"\$HOME/.nvm/nvm.sh\" && nvm install 22 && nvm use 22" || true
    echo
    echo "Or install it yourself with the system's package manager, for example:"
    echo "  sudo apt install nodejs     (Debian and Ubuntu: Node 22 comes from NodeSource or nvm)"
  fi
  if ! have_node; then
    echo
    echo "Node.js $NEED or newer is still missing. Install it, then run ./start.sh again."
    exit 1
  fi
fi

exec node --no-warnings scripts/cli.js "$@"
