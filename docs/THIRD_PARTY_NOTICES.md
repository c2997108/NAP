# NAP third-party notices

NAP combines the existing webBLASTN split-barcode browser port and get-consensus browser port. Upstream copyright and license texts are retained. The root [LICENSE](LICENSE) describes application code under MIT; it does not replace licenses of bundled tools or their JavaScript ports.

| Component | Version | Retained notices / source |
| --- | --- | --- |
| OpenPortablePipeline | commit `53c159aeedff6038f0fe5ab032bdd4f064067483` | MIT, copyright 2023 c2997108; [LICENSE](LICENSE), [upstream/](upstream/) |
| NCBI BLAST+ | 2.16.0+ | [Complete retained notices](public/shared/wasm/THIRD_PARTY_NOTICES.txt), [checksums](public/shared/wasm/manifest.json); source archive includes NCBI source and portability scripts |
| MAFFT | 7.525 | BSD core license; [complete notices](public/get-consensus/wasm/THIRD_PARTY_NOTICES.txt) |
| VSEARCH | 2.29.3 | GPL v3 / BSD 2-Clause dual license; complete notices and corresponding source retained |
| CD-HIT / CD-HIT-EST | 4.8.1 | GPL text retained in complete notices and corresponding source |
| minimap2 | 2.28 | MIT; complete notices and corresponding source retained |
| samtools / HTSlib | 1.17 | MIT/BSD and embedded-library notices retained in complete notices and corresponding source |
| VarScan JavaScript port | 2.4.6 | [Original license](licenses/VARSCAN-LICENSE.txt), original source JAR in corresponding-source archive |
| fflate | 0.8.2 | MIT, [split copy](public/split-reads/vendor/fflate-LICENSE.txt), [consensus copy](public/get-consensus/vendor/fflate-LICENSE.txt) |
| coi-serviceworker | 0.1.7, commit `7b1d2a092d0d2dd2b7270b6f12f13605de26f214` | MIT, copyright 2021 Guido Zuidhof; [license](public/coi-serviceworker-LICENSE.txt), [source and SHA-256 provenance](public/coi-serviceworker.manifest.json), [upstream](https://github.com/gzuidhof/coi-serviceworker) |
| Emscripten and embedded runtime libraries | 3.1.64 | Emscripten, musl, libc++, libc++abi, compiler-rt and other retained notices in both tool notice files |
| SQLite | 3.46.0 | Public-domain notice in BLAST notice file; downloaded source retained in corresponding-source archive |

VarScan's upstream terms permit non-commercial use by academic, government, and nonprofit institutions and describe a separate commercial license. The terms continue to apply to the ported variant-calling code. See the complete original text rather than inferring permission from the root MIT license.

The [corresponding-source archive](public/get-consensus/sources/get-consensus-wasm-source.tar.gz) contains tool source archives, build scripts, patches, upstream helper scripts, provenance records, license texts, and original tests. Its SHA-256 and size are recorded in [the consensus manifest](public/get-consensus/wasm/manifest.json). It also contains the sources and build scripts for the BLAST binaries shared by both tabs. See [sources/README.md](sources/README.md) for extraction and build instructions.

The scientific analysis algorithms and compiled tools were retained from the existing browser ports. NAP modifies UI embedding, shared BLAST resource paths, input/result state protection, direct FASTQ transfer, run provenance, completed-read and native-stage progress reporting, primer/sample definition editing, optional amplicon-length bounds, name validation and automatic sample naming, and cross-origin isolation startup on static hosts. The root Git sources contain the modified browser modules. Synthetic demos and integration tests are provided separately from tool sources.

The bundled coi-serviceworker source is unmodified. NAP uses it as a Service Worker with its default `require-corp` policy; the upstream page-side registration and update/reload script is not executed. The application's `bootstrap.mjs` and `isolation.mjs` register it only when needed and defer inputs and embedded apps until the initial reload is complete.
