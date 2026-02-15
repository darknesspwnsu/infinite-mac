# Snow Build Prerequisites

Use this checklist before rebuilding Snow with VM snapshot support.

1. Install Rust toolchain with the Emscripten target:
   - `rustup toolchain install stable`
   - `rustup target add wasm32-unknown-emscripten`
2. Install and activate Emscripten SDK in the build environment.
3. Ensure `cargo` and `emcc` are both on `PATH`.
4. Rebuild Snow from the repository root:
   - `scripts/rebuild-all-emulators.sh`
   - or for Snow only: `cd snow && cargo build -r -p snow_frontend_im --target wasm32-unknown-emscripten`
5. Import the Snow artifact into the web runtime:
   - `scripts/import-emulator.sh snow`

The Snow build must contain VM snapshot symbols (`js_snapshot_take_kind`) or import will fail.
