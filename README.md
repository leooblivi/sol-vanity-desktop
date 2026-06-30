# Sol Vanity — Desktop

Native Windows/macOS app for generating Solana vanity addresses, built with [Tauri](https://tauri.app) and Rust. Same idea as the [web version](https://sol-vanity-sage.vercel.app), but the brute-force loop runs as compiled native code instead of JavaScript — multiple times faster, and able to handle 5-7 character keywords in reasonable time.

## Why a desktop app

The web app caps keywords at 4 characters to stay fast in a browser. Brute-forcing a vanity address is pure CPU work — generate a keypair, encode it, check the pattern, repeat — and JavaScript (even in a Web Worker) is a few times slower than compiled Rust for this kind of workload. This app runs the exact same algorithm natively across every CPU core on your machine, so longer keywords that would take hours in a browser tab become practical.

## Security model

Same guarantee as the web version, just stronger: this app makes **zero network requests**. It doesn't talk to any server, ever — not for telemetry, not for updates (auto-update is disabled), nothing. Everything happens in local memory and local files you explicitly choose to save.

- Keypair generation, pattern matching, and address encoding all happen in the Rust backend, on-device.
- The frontend (the UI you see) only ever talks to the local Rust process via Tauri's `invoke` — never to the internet.
- "Save .json" opens a native save dialog and writes the file wherever you choose. Nothing is uploaded.
- As with the web version: lose the saved file or copied key, and the wallet is gone for good. There's no account, no backend, and no recovery path.

## Project structure

```
.
├── vanity-core/          plain Rust library — the grinding algorithm itself,
│                         independent of Tauri so it's easy to test/benchmark
│   └── src/lib.rs
├── src-tauri/             Tauri application shell
│   ├── src/main.rs        commands exposed to the frontend (start/stop/poll)
│   ├── tauri.conf.json     app config, window size, bundle targets
│   └── icons/
├── ui/                    frontend — same pixel UI as the web app, wired to
│   ├── index.html         Tauri's `invoke` instead of a Web Worker
│   ├── style.css
│   └── app.js
└── .github/workflows/release.yml   builds Windows + macOS installers in CI
```

## How the grinding works

`vanity-core` spawns one OS thread per CPU core (`std::thread::available_parallelism`). Each thread independently generates random ed25519 keypairs, base58-encodes the public key, and checks it against the requested pattern, until one thread finds a match or the search is cancelled. Progress is shared via atomics (`AtomicU64` for the running try count, `AtomicBool` for cancellation), so the frontend can poll for progress without any locking overhead on the hot path.

The result's secret key is laid out exactly like a `solana-keygen`-generated keypair file: 32-byte seed followed by the 32-byte public key, 64 bytes total — so the `.json` this app saves is directly compatible with the Solana CLI and wallet apps like Phantom, Backpack, or Solflare.

## Building locally

Requires a recent stable Rust toolchain (1.81+) and the [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites).

```bash
cargo install tauri-cli --version "^1"
cargo tauri dev      # run in development
cargo tauri build    # produce an installer for your current OS
```

On Linux, building requires `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, and `libsoup-3.0-dev` (or your distro's equivalents).

## Benchmarking the core algorithm

`vanity-core` ships a small benchmark binary independent of the GUI:

```bash
cd vanity-core
cargo run --release --bin bench
```

This grinds a real keyword and prints tries/sec for your machine — useful for sanity-checking that the native build is meaningfully faster than the browser before relying on it for longer keywords.

## CI builds

`.github/workflows/release.yml` builds signed-ready (but currently **unsigned**) installers for Windows (`.msi`/`.exe`) and macOS (universal `.dmg`) whenever a `v*` tag is pushed, or manually via the Actions tab. Artifacts are attached to the GitHub Release automatically when triggered by a tag.

**Note on code signing:** these builds are not code-signed yet. Windows will show a SmartScreen warning and macOS will block the app via Gatekeeper until it's signed and notarized. That requires a Windows code-signing certificate and an Apple Developer account ($99/yr) respectively — worth doing before a public launch, since an unsigned app asking people to generate private keys is a hard sell on trust.

## Icons

Placeholder icons are included so the bundler has something to work with. Before a real release, regenerate them from a proper source image:

```bash
cargo tauri icon path/to/source-icon.png
```

This produces all required sizes/formats, including the macOS `.icns` that isn't included yet.

## Credits

Built by [@leonardong169](https://x.com/leonardong169) and [@sunnyteehee](https://x.com/sunnyteehee).

## License

MIT
