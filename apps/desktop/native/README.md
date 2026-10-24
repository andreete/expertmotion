# apps/desktop/native (optional native hardening addon)

**Status: stub. Not required to build or ship.** This folder describes an optional Node-API
(N-API) C++ addon that moves the two most security-sensitive operations out of JavaScript —
licence verification and the prompt-decryption key derivation — into compiled native code. It is
the strongest of the defence-in-depth layers (ADR-007, SEC-131/132) because it removes those code
paths from the obfuscated/bytecode JavaScript entirely.

Honest boundary (ADR-006, ADR-007): a native addon raises the cost of extraction further, but it
**cannot** make reverse engineering impossible for someone who owns the machine. A debugger
attached to the running process can still observe the derived key in memory and the verification
result. We never claim otherwise in the UI or docs.

## What it would do

1. `verifyLicense(tokenBytes: Buffer, publicKeyBytes: Buffer): { valid: boolean, claims?: object }`
   Ed25519 verification of a Licence Key (LICENSE_OPERATIONS.md), with the public key compiled in.
2. `derivePromptKey(halfA: Buffer): Buffer`
   Combines the build-constant half (compiled into the addon) with the half passed from the
   bytecode-compiled service (src/lib/keysplit.ts), returning the 32-byte AES key. The build
   constant never appears in any JavaScript artefact.

## Build

- Toolchain: MSVC (Visual Studio Build Tools) on the Windows build machine; `node-gyp` / `prebuild`.
- ABI: compiled against the pinned Electron's Node-API version (Electron 45 → Node 22 ABI). The
  addon ships in `app.asar.unpacked` (native modules cannot load from inside the asar).
- Wiring: the Local Service `require`s it; when absent the service falls back to the pure-JS path in
  `src/lib/keysplit.ts` and the licence module (so Linux CI and this dev server still work).

## Files (to add when adopted)

- `binding.gyp` — see the sketch below.
- `src/addon.cc` — N-API entry (`NAPI_MODULE`), the two functions above.
- `index.js` — thin loader that `require`s the prebuilt `.node` or throws a clear error.

### binding.gyp sketch

```python
{
  "targets": [{
    "target_name": "em_native",
    "sources": ["src/addon.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_VERSION=9", "NODE_ADDON_API_DISABLE_DEPRECATED"],
    "cflags_cc": ["/O2", "/GL"],   # MSVC: optimise + whole-program; strip symbols in release
    "msvs_settings": { "VCCLCompilerTool": { "ExceptionHandling": 1 } }
  }]
}
```

This is a **sketch**; the real `.cc` and the embedded key material are added on the build machine
and are out of scope for the Linux-only work in this task (marked [UNVERIFIED]).
