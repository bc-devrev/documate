# screenpipe – local setup (macOS)

The repo is cloned at `Documents/Screenpipe`. Follow these steps to build and run.

## 1. Install dependencies

Run the automated script (recommended):

```bash
cd /Users/devrev/Documents/Screenpipe
./scripts/setup-macos.sh
```

Or install manually:

### Rust (required)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

The project uses the toolchain in `rust-toolchain.toml` (1.92.0); rustup will install it on first build.

### Homebrew + build deps (required)

Install [Homebrew](https://brew.sh) if needed, then:

```bash
brew install pkg-config ffmpeg jq cmake wget git-lfs
```

### Xcode (required on macOS)

- Install **full Xcode** from the App Store (command line tools only are not enough).
- Accept license and run first launch:

```bash
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
```

### Bun (required for desktop app / pipes)

Only needed if you build the Tauri desktop app or use pipes:

```bash
curl -fsSL https://bun.sh/install | bash
```

## 2. Build the CLI

From the repo root:

```bash
cd /Users/devrev/Documents/Screenpipe
cargo build --release --features metal
```

- Use `--features metal` on Apple Silicon/Intel Mac (Metal).
- First build can take several minutes.

## 3. Run screenpipe

```bash
./target/release/screenpipe
```

Or run on a different port and data dir (e.g. to avoid touching your main instance):

```bash
./target/release/screenpipe --port 3035 --data-dir /tmp/sp
```

## 4. (Optional) Build the desktop app

```bash
cd apps/screenpipe-app-tauri
bun install
bun tauri build
```

## 5. (Optional) Use without building

You can use the published CLI without building from source:

```bash
bunx screenpipe@latest record
# or
npx screenpipe@latest record
```

---

**Reference:** [CONTRIBUTING.md](CONTRIBUTING.md) (full install and build guide).
