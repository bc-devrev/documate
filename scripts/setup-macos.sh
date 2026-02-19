#!/usr/bin/env bash
# macOS setup for screenpipe: install deps and build CLI.
# Usage: ./scripts/setup-macos.sh

set -e
cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

echo "==> screenpipe macOS setup (repo: $REPO_ROOT)"
echo ""

# --- Rust ---
if ! command -v cargo &>/dev/null; then
  echo "==> Installing Rust (rustup)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
else
  echo "==> Rust already installed: $(cargo --version)"
  source "$HOME/.cargo/env" 2>/dev/null || true
fi

# --- Homebrew ---
if ! command -v brew &>/dev/null; then
  echo "==> Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for this session (common paths)
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
else
  echo "==> Homebrew already installed"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

# --- Build deps ---
echo "==> Installing build dependencies (pkg-config, ffmpeg, jq, cmake, wget, git-lfs)..."
brew install pkg-config ffmpeg jq cmake wget git-lfs

# --- Bun (optional for desktop app) ---
if ! command -v bun &>/dev/null; then
  echo "==> Installing Bun (for desktop app / pipes)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
else
  echo "==> Bun already installed: $(bun --version)"
fi

# --- Build ---
echo ""
echo "==> Building screenpipe (release + metal)..."
cargo build --release --features metal

echo ""
echo "==> Done. Run screenpipe with:"
echo "    $REPO_ROOT/target/release/screenpipe"
echo ""
echo "    Or on a different port/data-dir:"
echo "    $REPO_ROOT/target/release/screenpipe --port 3035 --data-dir /tmp/sp"
echo ""
