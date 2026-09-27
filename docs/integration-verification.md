# NAP integration verification

Verified on 2026-09-27 with Node.js 20.11.1, Playwright 1.56.1 and Windows Chrome 152.0.7977.84. `npm ci --ignore-scripts` and `npm test` completed successfully from the NAP folder. No computational server, Docker, WSL or Java was used for the browser integration test.

## Actual WASM pipeline results

| Case | Result |
| --- | --- |
| Split two synthetic gzip FASTQs | 12 input reads, 12 assigned reads, 12 output sequences, zero unassigned |
| Output samples | `nap_demo_A.fq`, `nap_demo_B.fq`; six 400-base sequences each |
| Concurrent split files | Two overlapping file jobs |
| Transfer only sample A | One FASTQ, full header/sequence/quality content preserved |
| Analyze sample A | One consensus, one representative, six assigned reads |
| Transfer both samples | Both FASTQs preserved; previous consensus result cleared |
| Analyze both samples | Two consensuses, two representatives, two concurrent sample jobs |
| BLAST counts for A / B | `[6, 0]` / `[0, 6]`, respectively |
| Split FASTQ ZIP | Both files present and byte-for-byte identical to split output |
| Consensus ZIP | FASTA, Excel, standalone HTML viewer and run provenance present |

The integration test executed the actual NCBI BLAST, VSEARCH, MAFFT, minimap2, samtools and CD-HIT WASM modules; variant calling and pipeline transformations use the retained JavaScript ports. This small identical-read demo checks the combined workflow. It does not replace the original tool-port tests for variant-rich or large experimental data.

## Integration behavior checked

- Tab changes retain input, output and running Workers; arrow keys switch the focused tab.
- Sample filtering, select-none, select-all and one-file selection operate correctly.
- Handoff preserves FASTQ contents and analysis thresholds, and does not automatically start a run.
- Active consensus input cannot be overwritten. An older split revision cannot be exported.
- Split reset clears the selector and retains previously imported FASTQ and consensus results.
- Choosing a FASTQ from disk clears old split provenance. Cancel and restart succeed.
- The parent and both embedded pages are cross-origin isolated with COOP/COEP.
- Desktop and 390-pixel mobile layouts fit their viewport; output tables scroll internally.
- No uncaught browser errors, failing HTTP responses, uploads or external network requests occurred.

## Headerless static-host startup

The Service Worker test uses a separate static server with no COOP, COEP or CORP headers, mounted under `/nap-pages-test/` to simulate a GitHub Pages project site. It uses a fresh browser context for each entry point; this is a local simulation, not a deployed GitHub Pages test.

- The first document arrives without isolation headers. Inputs stay inert and embedded pages are not requested until startup is ready.
- The bundled coi-serviceworker registers only within the application subpath. One automatic reload retains the selected tab and enables isolation in the parent and both embedded pages.
- The actual WASM pipeline splits 12 raw reads into two six-read FASTQs and generates two consensus representatives matching the expected sequences.
- An activated Service Worker update preserves an edited input value and both split/consensus results without reloading the document.
- Direct split-reads, get-consensus and tool-test URLs bootstrap from a fresh context. The standalone VSEARCH test completes successfully.
- An unavailable Service Worker or a worker that fails to add the headers leaves inputs inactive, displays a reason and stops without a reload loop.
- The headerless pipeline makes no upload or external requests. Startup does not add a persistent data cache.

Run `npm run test:service-worker` for this case. Its JSON report is written to `test-results/service-worker-report.json`. Public deployment settings are left to the repository owner.

## Completed-read progress verification

The combined test also runs each six-read input in three two-read batches. Actual WASM progress events confirm that starting both jobs and reading compressed input to EOF leaves processing progress at zero. Each running job subsequently reports partial completed-read fractions, the aggregate never decreases, and the overall bar reaches 100% after output merging. Final file rows report `6 / 6` and 100%. Progress snapshots are saved to `test-results/split-progress-report.json`.

Node regression tests additionally cover differently sized concurrent and queued jobs, empty files, concatenated gzip, failed BLAST attempts with automatic memory retries, invalid gzip, and unchanged FASTQ/assignment output. `npm run test:progress` runs the split and consensus progress checks independently.

## Consensus progress verification

The browser integration test observes the actual displayed progress during a two-sample WASM run. Starting jobs leaves the bar at zero. MAFFT reports completed native commands within each alignment, BLAST reports two and four of six processed reads before completing each sample, and the displayed overall percentage never decreases. Both sample bars finish at 100%; the overall bar reaches 100% after Excel and the result view are created. Snapshots are saved to `test-results/consensus-progress-report.json`.

Node tests check weighted progress across differently sized samples, pending global analysis and BLAST, the 99% worker-completion ceiling, automatic MAFFT strategy and strand-adjustment stage counts, and no completion credit for a failed MAFFT command. Percentages represent completed stages and batches, rather than estimated remaining time; a native command without intermediate reports holds its stage fraction until it finishes.

## Primer and sample editor verification

The definition editor is verified with two Forward rows and two Reverse rows. Each primer table has exactly two columns. Excel-style rectangular paste, row insertion/removal, renamed axes, preserved sample assignments and per-pair lengths, optional blank-pair exclusion, invalid duplicate names, annotated FASTA downloads, sample.txt downloads, and saved-file round trips pass. Selecting both definition files automatically imports them and opens the editor, in either selection order. Unannotated FASTA imports infer directions from sample.txt references; unreferenced records default to Forward and are listed in the import message. Desktop and mobile checks cover automatic scrolling, sample/length preservation, latest-file replacement, and FASTA-only manual import. Model tests confirm an invalid import preserves the existing draft.

Minimum and maximum lengths start blank. With all four sample cells blank, the editor creates four definitions with automatic `s_F_R` names and no length limits. Actual BLAST assigns the 12 synthetic reads to two output FASTQs, six each; the other two combinations have no reads and produce no FASTQ. A primer name containing allowed `- . _` characters is retained through automatic naming, FASTQ handoff and the full consensus pipeline. Names containing `*` are rejected. The “omit” option then restores use of only explicitly named sample cells. Model tests verify the ASCII name alphabet, live automatic renaming, optional file columns, and independent limits accepting 50-base and 10,000-base amplicons when both bounds are blank.

The browser test generates input files after renaming primers, with two sample definitions (including maximum length 0). These table inputs produce 12 assigned sequences using actual BLAST WASM, six per sample, followed by two consensus representatives. The editor is locked during processing. Main tab changes retain draft inputs, and desktop/mobile views fit their viewport. Reports and screenshots are generated as `test-results/definition-editor-*`, `primer.fasta` and `sample.txt`. Model tests cover serialization, validation and stable pair identity.

## Packaging checks

All shipped tool files, the corresponding-source archive, vendor code and fixed upstream scripts passed SHA-256 checks. Shared BLAST copies and both manifests agree. Relative module, Worker, CSS and HTML references are present with case-sensitive names. The GitHub Pages copy in `docs/` includes all 100 `public/` assets, `.nojekyll`, and license notices. Package checks verify that every published asset matches its development source. The package is approximately 193.6 MiB including both copies, excluding dependencies, build and test output; each site's assets occupy approximately 96.7 MiB. Its largest file is the 69,797,999-byte corresponding-source archive.

`npm run prepare:pages` refreshes the branch-published files before commit/push. `npm run test:pages` serves the actual `docs/` folder without isolation headers under a repository subpath; Service Worker startup, 12-read splitting, two consensus representatives, standalone tools, and safe Worker updates pass. No GitHub Pages settings or remote deployment were changed.

See [the integration test](../scripts/test-integration.mjs) and [the package checker](../scripts/check-package.mjs). Running these regenerates reports, ZIPs and screenshots under the Git-ignored `test-results/` folder. GitHub Actions configuration is included; no remote CI run or push was performed during this local integration.
