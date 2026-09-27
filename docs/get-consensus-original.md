# get-consensus — Nanopore consensus web app

[OpenPortablePipeline の nanopore~get-consensus](https://github.com/c2997108/OpenPortablePipeline/blob/53c159aeedff6038f0fe5ab032bdd4f064067483/PortablePipeline/scripts/nanopore~get-consensus) をブラウザー内で実行する移植版です。新規ソース、WASM、ビルド作業、入力例、検証結果は、この `get-consensus` フォルダー内に保存します。

## 起動

Node.js 18 以降と Chrome / Edge が必要です。実行時に Docker・WSL・Java・Python は不要です。

```powershell
cd get-consensus
npm start
```

[http://localhost:8001/](http://localhost:8001/) を開きます。「デモを読み込む」→「解析を開始」で、2 サンプル各 60 リードを通し解析できます。逆相補リードを含むデモでは、読み込み時に両方向検索と MAFFT 方向調整を有効にします。通常の初期値は元スクリプトと同じ順方向です。

FASTQ / FQ と gzip（連結 gzip を含む）を複数選択できます。1 ファイルを 1 サンプルとして扱い、解析後に集計表とアラインメントを表示します。ZIP、FASTA、FASTQ、Excel、単独で開ける HTML ビューアーを保存できます。入力をサーバーへ送信する処理、外部 API、CDN はありません。

複数の FASTQ は標準で **最大 8 サンプルを同時に並列実行**します。「同時に処理するサンプル数」で変更でき、1 にすると順次処理します。クラスタリングからハプロタイプ生成までサンプルごとに進め、全サンプルの終了後に CD-HIT 統合と BLAST DB 生成を行います。BLAST 集計も同じ上限でサンプルごとに並列実行します。各ツールは独立した Web Worker と WASM メモリーを使い、サンプル内の処理順と最終結果の入力順は維持します。実行中のサンプル名を進捗に表示し、上限と最大同時実行数を `run.json` の `concurrency` に記録します。

サーバーは静的ファイル配信と COOP/COEP ヘッダー付与のみを行います。別ポートは `$env:PORT='8002'; npm start`。`file://` でアプリを直接開くと WASM の実行条件を満たしません。

## 移植した処理

1. FASTQ の読み込み、形式・重複 ID・gzip CRC の検証。
2. `qs:f:` タグがある入力は、元の品質ビン幅 1〜10→all、Q10 以上、Q20 上限、同一率 `1 - 3 × 10^(-Q/10)` で VSEARCH を反復。受理クラスターを完全一致で統合し、優先順位に従って元リードへ戻します。タグがなければ従来の VSEARCH クラスタリングです。
3. クラスター先頭の最大 30 リードを MAFFT `--auto` で整列し、元 `extract_consensus.py` の多数決・ギャップ条件・一致率品質でコンセンサスを生成。表示用にコンセンサスを含むアラインメントも生成します。
4. サンプル内のコンセンサスを VSEARCH で再統合し、リード数を合算。
5. minimap2 `map-ont` → samtools sort / index / faidx / mpileup → VarScan の SNP / INDEL 判定。品質深度でフィルターし、元 Python と同じ CIGAR 判定と完全なハプロタイプ・頻度 10% 以上・最小深度の条件でフェージング。各ハプロタイプを MAFFT で再整列してコンセンサスを追加します。
6. 全サンプルを CD-HIT で統合し、各グループから最大リード数の配列を選んで MAFFT と BLAST DB を生成。
7. 元の BLAST outfmt と閾値で各入力リードを検索し、最高 bitscore → 最短 subject 長の同率ヒットへ等分配。サンプル別集計表、配列・品質付き表、Excel を生成します。

## ツールとソース

| ツール | バージョン | 実装 |
| --- | --- | --- |
| MAFFT | 7.525 | 元 C コードの 9 カーネルを WASM 化、DNA 用ドライバーを JS 移植 |
| VSEARCH | 2.29.3 | 元 C++ コード、WASM SIMD、pthread pool 1 |
| CD-HIT / CD-HIT-EST | 4.8.1 | 元 C++ コード、OpenMP 無効 |
| minimap2 | 2.28 | 元 C コード、WASM SIMD、kthread を同期実行へ変更 |
| samtools / HTSlib | 1.17 | 元 C コード、zlib、sort の worker を同期実行へ変更 |
| makeblastdb / blastn | 2.16.0+ | このワークスペースで検証済みの NCBI WASM を同梱、独立した再ビルド手順も収録 |
| VarScan | 2.4.6 | getReadCounts、CNS variant call、strand filter、Fisher 検定の該当経路を JS 移植 |

`upstream/` に元スクリプト、Docker から取得した補助 Python、VarScan JAR、ライセンスを保存しています。Docker イメージと補助ファイルの元レイヤー・SHA-256 は `docker-image.json` / `helper-provenance.json`、各 WASM と対応ソースのハッシュは `public/wasm/manifest.json` です。

## 元スクリプトとの違い・制限

- 元の VCF 分岐はヘッダー行を変異行として数えるため INDEL を落とします。移植版は SNP と INDEL を統合します。
- 元のコンセンサスの同率塩基は未固定の乱数で選ばれます。移植版は辞書順に固定します。同率の代表配列とリード順序も固定し、`run.json` に記録します。
- `minReads=1` のとき単独リードのクラスターも使用します。元の legacy AWK は H 行がない単独クラスターを落とします。
- **コンセンサス FASTQ の品質は通常の Phred 値ではありません。** 元実装と同じ塩基の一致率で、100% は `Z` です。
- 全サンプル統合は元どおり **CD-HIT（アミノ酸用コマンド）** を呼びます。CD-HIT-EST に変更していません。
- ハプロタイプ分離には同一リードが 2 か所以上の変異をカバーする必要があります。条件を満たさない場合も通常のコンセンサスは出力します。
- bcftools の VCF 結合・DP フィルター、seqkit の形式変換・分割・ソート、AWK 集計を JS で実装しました。VCF は非圧縮で保存します。BAM と BAI / FAI は本物の samtools 出力です。
- 各ツール 1 スレッド、WASM は各インスタンス最大 2 GiB。サンプルの並列数を増やすと同時に使う CPU とメモリーも増えます。FASTQ と出力をメモリーに保持するため、大規模データにはネイティブ版が必要になることがあります。MAFFT は 20000 配列未満、DNA/RNA の対応済み `--auto` 経路を使用します。
- UI は元の主要閾値、鎖方向、MAFFT 方向調整を扱います。任意の `opt_v` / `opt_f` コマンド列、Docker の CPU / メモリー設定は入力しません。`tools.html` と `ConsensusTools` API では単体ツールも使用できます。
- XLSX のセル上限 32767 文字を超える配列・品質は TSV に全文を残し、Excel には参照案内を記載します。

## 保存ファイル

| ファイル | 内容 |
| --- | --- |
| `output-consensus.fastq` / `.fasta` | 全クラスターとハプロタイプのコンセンサス |
| `output-all-clusters.max.uc.fasta` / `.mafft` | 統合後の代表配列と整列 |
| `all.cnt.txt` / `.seq.txt` / `.seq.qual.txt` | サンプル別割当数、配列、品質 |
| `all.cnt.seq.qual.xlsx` | 数値型を保つ Excel 集計表 |
| `output-consensus-alignments/` | クラスターとハプロタイプのアラインメント |
| `output-consensus-viewer.html` | ローカルで開ける単独 HTML ビューアー |
| `work/` | UC、品質ビン記録、BAM / BAI / FAI、pileup、VCF、ハプロタイプ |
| `work-blast/` | 分割 BLAST 結果、サンプル別集計 |
| `run.json` / `pipeline.log` | 条件・版・互換性の変更点・実行ログ |

## 検証

```powershell
npm install
npm test
```

Playwright 1.56.1 とインストール済み Chrome で実行します。

- MAFFT 12 ケース、VSEARCH 4 ケース、CD-HIT / EST 6 ケースの出力がネイティブとバイト単位で一致。
- minimap2 SAM（実行パスを含む PG 行を除く）と samtools pileup が同一版ネイティブと一致。
- SNP、挿入、欠失の位置・アレルと深度が元 Java VarScan と一致。ハプロタイプの数・頻度・配列が元 Python と一致。
- 品質ビンを全 11 段階広げ、完全一致の統合と優先順位選択を元 Python と比較。
- 2 サンプル × 60 リードの通し解析で 6 コンセンサス → 2 代表配列、割当数 `[40,24]` / `[20,36]` を確認。
- 複数 FASTQ の WASM ツール同時実行、指定した並列上限、逐次実行との出力一致、同名ファイルの分離、中止・失敗時の他ジョブ停止と未開始サンプルの抑止を確認。
- gzip CRC、連結 gzip、不正 FASTQ、同率 BLAST 等分配、strand filter、中止・再実行、外部通信なしを確認。
- UI から ZIP / XLSX / HTML を保存し、デスクトップ・モバイル表示とオフライン HTML を確認。

結果は `test-results/*-report.json`、スクリーンショット、保存した ZIP / Excel にあります。ZIP CRC と OOXML は `python3 scripts/verify-downloads.py` でも検証します。

ネイティブ参照を再作成する場合は `scripts/generate-pipeline-fixtures.py --native`。Linux/WSL の GCC、ネイティブ VSEARCH、pysam 0.23.3、Java が必要です。Java は `GET_CONSENSUS_JAVA` で指定できます。テスト用の参照ファイルは同梱しているため、通常の `npm test` にこれらは不要です。

## WASM 再ビルド

Windows では Ubuntu-22.04 の WSL、Linux では Bash、make、GCC/G++、Python 3、curl、Git が必要です。Emscripten 3.1.64 を使用します。

```powershell
# MAFFT / VSEARCH / CD-HIT / minimap2 / samtools
npm run build:wasm
# NCBI makeblastdb / blastn
npm run build:blast
```

既存 SDK は `$env:GET_CONSENSUS_EMSDK='/path/to/emsdk'`、WSL ディストリビューションは `WSL_DISTRO` で指定できます。SDK を指定しない場合も、新規 SDK・コンパイル・一時ファイルは `build/` 内に作成します。

ダウンロードの版と SHA-256 は `sources.json` と `scripts/blast/build-wasm.sh` に固定しています。修正差分は `patches/`、BLAST の修正は `scripts/blast/prepare-build.py` です。`public/sources/get-consensus-wasm-source.tar.gz` に対応ソース、ビルドスクリプト、入力例、テストを収録します。

## ライセンス

各ライセンスは `public/wasm/THIRD_PARTY_NOTICES.txt` に収録します。各ツールと VarScan の移植部分に、それぞれの元ライセンスが適用されます。**VarScan は非商用の学術・政府・非営利機関向けライセンスです。** 商用利用の条件は `upstream/VARSCAN-LICENSE.txt` を確認してください。
