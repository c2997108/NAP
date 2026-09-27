# Corresponding sources and rebuilding

The exact corresponding-source bundle is stored at:

[`public/get-consensus/sources/get-consensus-wasm-source.tar.gz`](../public/get-consensus/sources/get-consensus-wasm-source.tar.gz)

SHA-256: `614abf308d1bd1450ffbb3eb910bfc1a7e6af74774ca129fd7faedbf5c9644fa` (69,797,999 bytes). `npm run check:package` verifies this archive and all shipped tool binaries.

The archive has a `get-consensus/` root. It includes pinned upstream source downloads, NCBI BLAST source, the VarScan source JAR, patches, original JavaScript driver code, build scripts, license notices, provenance records, and tests. NAP's UI, direct-transfer and progress-reporting modifications are in the repository's `public/` sources; the shipped compiled WASM binaries have not been changed by integration.

## Rebuild in a separate directory

The commands below operate on the extracted standalone tool-build project. They are not NAP root package commands. Linux or Ubuntu WSL is required, with Bash, make, GCC/G++, Python 3, curl, Git, Node.js, and Emscripten 3.1.64. The original build scripts can install their pinned SDK when one is not supplied. Rebuilding requires substantial time and disk space and may download build dependencies.

From the NAP root, extract into the ignored `build/` directory:

```bash
mkdir -p build/corresponding-sources
tar -xzf public/get-consensus/sources/get-consensus-wasm-source.tar.gz -C build/corresponding-sources
cd build/corresponding-sources/get-consensus
npm run build:wasm
npm run build:blast
```

Read the extracted README for `GET_CONSENSUS_EMSDK`, `WSL_DISTRO`, compiler prerequisites, source checksums and patch details. On Windows, extraction with `tar` and Node wrappers is supported by that project, but actual compilation runs in WSL. A Linux filesystem is recommended for compilation output.

## Updating NAP after a rebuild

Do not copy the extracted project's old UI over NAP. Copy tool assets only:

1. Copy `blastn.mjs`, `blastn.wasm`, `makeblastdb.mjs`, and `makeblastdb.wasm` from the extracted project's `public/wasm/` into NAP's `public/shared/wasm/`.
2. Copy the other generated `.mjs` / `.wasm` tool files and `vsearch.worker.mjs` into `public/get-consensus/wasm/`.
3. Retain/update both complete notice files and the corresponding-source archive when sources or patches change.
4. Recompute the four shared BLAST entries in `public/shared/wasm/manifest.json`. In the consensus manifest, keep local tools under `files`, the four BLAST entries under `sharedFiles` with `../../shared/wasm/` paths, and the archive checksum under `source`.
5. Run `npm test` from the NAP root before distributing updated assets.

The existing source-build tests are included in the archive. NAP's own integration tests check the combined application with its shipped binaries. Recompilation was not needed for this integration.
