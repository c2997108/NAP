# webBLASTN

NCBI BLAST+ **2.16.0** の `makeblastdb` と `blastn` を Emscripten **3.1.64** で WebAssembly にコンパイルし、ブラウザ内の Web Worker で実行します。NCBI の検索・スコア計算の実装を使用しています。

[OpenPortablePipeline の nanopore~split-barcode](https://github.com/c2997108/OpenPortablePipeline/blob/53c159aeedff6038f0fe5ab032bdd4f064067483/PortablePipeline/scripts/nanopore~split-barcode) の FASTQ 分割処理もブラウザ内で実行できます。

## Nanopore FASTQ の分割

`npm start` 後に <http://localhost:8000/nanopore.html> を開きます。BLAST 画面上部のリンクからも移動できます。

1. FASTQ / FASTQ.gz（複数可）、プライマー FASTA、サンプル表を選択します。
2. 判定条件と「同時処理ファイル数」を設定し、「FASTQ を分割する」を押します。複数ファイルを選択すると、指定した数まで同時に処理します。
3. 「分割 FASTQ をまとめて保存」で、すべてのサンプル別 FASTQ を `nanopore-split-fastq.zip` に保存します。ZIP 内には `<sample>.fq` が並びます。サンプルごとの個別保存や、集計表・未分類リードを含む「すべて ZIP で保存」も使えます。

サンプル表はヘッダーなしの5列です。タブまたは空白で区切ります。

```text
sample_name  forward_primer  reverse_primer  min_amplicon_length  max_amplicon_length
s_32_32      MiFish_F32      MiFish_R32      300                  500
```

上の1行目は列の説明です。実際のファイルにはデータ行だけを記載します。長さは両端のプライマーを含むアンプリコン長です。最大長 `0` は上限なしです。サンプル名とプライマー対はそれぞれ一意にしてください。

プライマーのクリーニング、IUPAC 縮重展開、共有配列からのタグ抽出、2種類の BLAST 検索、スコア・長さ順での包含ヒット除去、タグの向きと被覆確認、隣接する F/R 対とアンプリコン長の判定を移植しました。プライマーを除去し、逆向きのアンプリコンの配列と品質を補正して `output/<sample>.fq` に出力します。連結リードから複数のアンプリコンを出力する場合があるため、画面には「分類済み入力リード」と「出力配列数」を別々に表示します。

既定条件は元スクリプトと同じです。

| 条件 | 既定値 | 元の引数 |
| --- | --- | --- |
| 縮重展開 | 有効 | `-p y` |
| プライマー被覆率 / 一致率 | 0.6 / 80% | `-f 0.6 -i 80` |
| バーコード被覆率 / 一致率 | 0.9 / 90% | `-a 0.9 -j 90` |
| 低一致率ヒットによるキメラ抑制 | 無効 | `-b n` |
| バッチあたりリード数 | 300 | `-d 300` |
| 検索モード | megablast | 元スクリプトは `-task` を省略 |

プライマー検索・バーコード検索ともに `-word_size 4 -outfmt 6` を指定します。プライマー検索だけ `-max_target_seqs 10000` を指定し、バーコード検索は BLAST の既定値500を使います。`evalue`、DUST、マッチ・ミスマッチの得点、ギャップのペナルティは原本と同様に指定せず、選んだ検索モードの既定値を使います。「テスト用の設定」は `-task blastn` とバーコード一致率80%に変更するため、原本の既定条件とは異なります。

原本から次の対応を加えています。

- `primer.fa` が既に `MiFish_F32#_#3` のように展開済みの場合、元の ID と展開後の ID を別々に管理します。タグ照合は元 ID で行い、サンプル表への照合では、完全一致を優先して末尾の `#_#番号` を取り除いた名前にも対応します。
- IUPAC の逆相補鎖で `S→S`, `W→W` を使用します（原本の AWK はこの2文字を入れ替えています）。
- 最大長 `0` の上限なし指定を、最小長が正の行でも扱えます。壊れた FASTQ・gzip、重複したサンプル定義や不正な出力ファイル名はエラーにします。
- `blastn` モードを選択できます。既定値は変更していません。
- 同点・同じ被覆長のヒットは、元 AWK の2リード目以降の処理に合わせ、各プライマーの検索ヒット数が少ない順、同数ならプライマー名順で選びます。原本は先頭リードの列挙順を指定していませんが、ブラウザ版では全リードでこの順序を固定します。
- 未分類リードを `unassigned.fq` に保持します。gzip は fflate 0.8.2 で逐次展開し、連結 gzip の各メンバーの CRC と展開サイズも検証します。

出力には `assignments.tsv`（1-based、両端を含む抽出座標）、`sample-counts.tsv`、`length-histogram.tsv`、`output.stats`、プライマーとタグの FASTA、条件と集計を記録した `run.json` が含まれます。「BLAST 判定根拠も保存する」を有効にすると、包含ヒット除去後の `primer-hits.tsv`（最終列がタグ確認の0/1）と `barcode-hits.tsv` も保存できます。

FASTQ は標準の4行形式に対応します。プライマーとタグの DB は一度だけ作成し、ファイルを処理する各 Worker に配布します。各 Worker は1ファイルをバッチごとに処理し、完了すると次のファイルを受け取ります。大きなファイルから開始して待ち時間を減らし、出力は入力ファイルの選択順に統合します。同じサンプルの FASTQ、未分類リード、判定座標、集計表は全ファイル分をまとめて保存できます。

「同時処理ファイル数」の画面の初期値はブラウザが報告する論理 CPU 数に応じて最大4です。1〜16で設定でき、1は順次処理です。実際の同時実行数は入力ファイル数が上限です。1つの FASTQ の内部はバッチ順に処理します。バッチはファイルの境界をまたぎません。Worker と BLAST のメモリ使用量は同時実行数に応じて増加します。画面でファイルごとの待機・処理中・完了とリード数を確認できます。「中止・リセット」で処理を止められ、いずれかの入力にエラーがあれば他のファイルの処理も停止します。

大量のヒットで BLAST がメモリ不足を報告した場合、そのバッチを半分に分け、同じ検索条件で再試行します。以後は同じ Worker のバッチ上限も小さくします。1リードでもメモリ不足になる場合や、他のエラーは停止します。`run.json` の `summary.memoryRetries` に再試行回数を記録します。

出力はブラウザのメモリに保持します。ZIP は非圧縮の ZIP32（4 GiB未満）です。元スクリプトの Docker、CPU/メモリ割当、R/PNG グラフ生成、任意の sequencing_summary による品質注釈は、このブラウザ版の対象外です。リード長の集計は TSV で保存できます。`run.json` の `execution` に実際の同時処理数、最大実行ファイル数、各ファイルの開始・終了時刻とリード数を記録します。

### 指定ファイルによる検証結果

`BAC386_pass_8e1b977d_12751232_51.fastq.gz` は758 bytesの圧縮ファイルで、**1リード**を含みます。`primer.fa` は420配列、`sample.txt` は3,600サンプル定義です。「テスト入力を読み込む」で、この3ファイルを読み込めます。

| 設定 | 結果 |
| --- | --- |
| 原本の既定設定 / ブラウザ版の既定設定 | 0配列、1リード未分類 |
| `-task blastn`、バーコード一致率80%、被覆率90% | `s_32_32` に1配列、172 bp |

「テスト用の設定（blastn / 80%）」ボタンで後者を選べます。この設定を使った判定は `MiFish_F32` と `MiFish_R32`、アンプリコン長370 bp、プライマー除去後の抽出座標 **124–295** です。元スクリプトの AWK・seqkit と公式ネイティブ BLAST+ 2.16.0 を使い、上記の名前対応を加えて検索条件を合わせた出力と、ブラウザの FASTQ の**配列・品質・ヘッダーが完全一致**することを確認しました。これは指定された1リードでの検証です。

2026-09-27 の追加検証で、包含ヒット除去の同点時に、ブラウザ版が BLAST の出力順を使って元 AWK と異なるプライマー変異型を選んでいたことが分かりました。タグ判定がその変異型に対応するため、同じ BLAST 結果でも分割漏れや誤った割当が発生していました。検索条件・判定閾値を保持したまま、上記のヒット選択順に修正しました。実データ由来の検索ヒットを使う回帰テストで、漏れと誤割当の両方を検証しています。

`BAC386_pass_8e1b977d_12751232_10.fastq.gz` の402リードを300・102リードの2バッチで比較した結果は次の通りです。元スクリプト側にも既存の展開済みプライマー名への対応を加え、BLAST+ 2.16.0 を使いました。

| 設定 | 元 AWK・ネイティブ BLAST | 修正後のブラウザ WASM |
| --- | --- | --- |
| 既定値（megablast / バーコード一致率90%） | 19リード・19配列 | 19リード・19配列 |
| テスト設定（blastn / バーコード一致率80%） | 146リード・146配列 | 146リード・146配列 |

両設定とも全サンプルの FASTQ がバイト単位で一致しました。ブラウザ実行の集計は `test-results/options-audit/browser-comparison.json`、同じ BLAST 結果に対する修正前後の判定比較は `test-results/options-audit/comparison.json` に保存しています。既定条件では元スクリプトでも未分類が多く、バーコード被覆率・一致率、両端の向き、プライマーを含む300–500 bpの長さ条件をすべて満たす必要があります。

`m768:~/work/eDNA/kurita-COI3` の3 FASTQ、`primer.fa`、`sample.txt`でも、全95,008リードをChrome内のWASMで検索から検証しました。検索・判定条件は原本の既定値と同じです。出力は保存済みのネイティブ結果75,129断片に対して75,126断片、分類された元リードは57,838件に対して57,837件でした。3リードで各1断片が欠落し、後続の断片番号がずれました。残った断片の配列・品質値・割当・座標・向き・ヘッダーメタデータは一致しました（FASTQレコードの並び順は除外）。

差のある3リードはすべて原本の300リードバッチの先頭で、生のネイティブHSPを使っても同じ差を再現できました。原本では最初のリードのプライマー走査順が未指定ですが、ブラウザ版は全リードでHSP数・プライマー名順を使うため、同点ヒットの選択に差が出ます。画面の「分類済みリード」は元リード数、「出力配列」が原本の `Demultiplexed reads` に対応します。[検証レポート](test-results/kurita-COI3/verification.md)と[全件比較](test-results/kurita-COI3/wasm-full/comparison.json)に、条件・差分・サンプル別ハッシュを保存しました。検証はLinux Chromeで最大150リードずつ実行し、実際のメモリ不足からの自動分割も確認しました。Windowsでの大規模16並列の安定性は確認できていません。

```powershell
npm test
npm run test:nanopore
```

ブラウザテストでは、既定値での未分類、条件変更後の172 bpの分割、ZIP 保存、複数ファイル、同一IDの独立処理、連結 gzip、1リードずつ3バッチの処理、逆相補鎖と品質値、入力エラー後の回復、中止・リセットを検証します。ファイルの処理時間が実際に重なること、逐次処理と並列処理の FASTQ・座標・診断・集計表のバイト単位での一致、ファイル別の進捗表示、実行中の並列ジョブの中止も確認します。HTTP 通信がローカル静的 GET だけであることも確認します。

実データで速度を比較する場合は、2つ以上の FASTQ を指定します。テスト設定（blastn、バーコード一致率80%、被覆率90%、300リード/バッチ）で、1ファイルずつの実行と最大4ファイルの同時実行を比較し、生成ファイルの SHA-256 が一致することを検証します。結果は `test-results/demultiplex-benchmark.json` に保存されます。

```powershell
node scripts/benchmark-demultiplex.mjs file1.fastq.gz file2.fastq.gz file3.fastq.gz
```

追加された `BAC386_pass_8e1b977d_12751232_10.fastq.gz`（402リード）、`_14.fastq.gz`（806リード）、`_18.fastq.gz`（902リード）の計2,110リードで、同点ヒット選択順の修正前に Chrome の実ブラウザによる速度比較を実施しました。上記テスト設定で、逐次実行 **423.71秒**、3ファイル同時実行 **188.01秒**、約 **2.25倍** の速度でした。FASTQ・座標・集計表を含む全出力（実行時間を記録する `run.json` を除く）の SHA-256 が一致しました。速度は CPU・メモリ・入力ファイルの構成で変わります。

テスト結果の FASTQ は `test-results/nanopore/output/s_32_32.fq`、ZIP は `test-results/nanopore-split.zip`、スクリーンショットは `test-results/nanopore-browser.png` に保存されます。原本の固定版とライセンスは `tests/upstream/`、ネイティブ比較の期待値は `tests/fixtures/nanopore/` に置いています。

ネイティブ期待値は Linux/WSL の gawk、seqkit 2.1.0、samtools と BLAST+ 2.16.0 で再生成できます。

```bash
python3 scripts/generate-native-demultiplex.py --blast-bin /path/to/ncbi-blast-2.16.0+/bin
```

fflate は静的配信できるよう `public/vendor/` に同梱しています。`npm ci` 後、`npm run vendor:sync` で固定版から再配置できます。実行時の外部 CDN への接続はありません。

## 起動

ビルド済みの `.wasm` と `.mjs` は `public/wasm/` に配置されています。Node.js 20 以降で起動できます。

```powershell
npm install
npm start
```

ブラウザで <http://localhost:8000> を開き、次の順に操作します。

1. 「サンプルを読み込む」、または参照配列とクエリの FASTA を開く。
2. 「makeblastdb を実行」で参照配列のデータベースを作る。
3. 「blastn を実行」で検索し、「結果を保存」で出力をダウンロードする。

引数欄にはコマンド名を除く BLAST の引数を指定します。引用符を使えます。入力と DB は仮想ファイルシステム `/work` に保持され、「作業ファイル」で追加・保存できます。既存の DB v4 ファイルも、同じ接頭辞を持つ全ファイルをまとめて追加することで使用できます。

`npm start` のサーバーは静的ファイルの配信だけを行います。配列・DB 作成・検索はブラウザ内で処理され、配列をサーバーに送信しません。`public/` を通常の静的 HTTP サーバーに配置することもできます。`.mjs` は JavaScript、`.wasm` は `application/wasm` で配信してください。`file://` では起動できません。

## JavaScript API

```javascript
import { BlastClient } from './app/blast-client.mjs';

const blast = new BlastClient({
  onLog: ({ stream, text }) => console.log(stream, text),
});

const sequence = 'GCTAGGCTAACGTTCGATGACCTGATCGTACGATGCTAGCTAGGTCATCGATCGTGCATACGGTAC';
await blast.writeFile('reference.fa', `>ref\n${sequence}\n`);
await blast.writeFile('query.fa', `>query\n${sequence}\n`);

const database = await blast.run('makeblastdb', [
  '-in', 'reference.fa', '-dbtype', 'nucl', '-out', 'reference',
  '-parse_seqids', '-blastdb_version', '4',
]);
if (database.exitCode !== 0) throw new Error(database.stderr);

const result = await blast.run('blastn', [
  '-query', 'query.fa', '-db', 'reference', '-task', 'blastn',
  '-outfmt', '6', '-out', 'results.tsv', '-num_threads', '1',
]);
if (result.exitCode !== 0) throw new Error(result.stderr);

console.log(await blast.readFile('results.tsv'));
console.log(await blast.listFiles());
const binary = await blast.readFile('reference.nsq', { encoding: 'binary' });
await blast.removeFile('query.fa');
blast.dispose();
```

画面では `window.blast` から同じ API を利用できます。`writeFile` は文字列・ArrayBuffer・Uint8Array、`readFile` は UTF-8 または Uint8Array に対応します。コマンド結果には `exitCode`、`stdout`、`stderr`、`elapsedMs`、ファイル一覧が含まれます。引数エラーなどの通常の BLAST エラーは非ゼロの `exitCode` を返し、WASM 読み込みやランタイムの異常は Promise を reject します。

各コマンドを新しい WASM インスタンスで実行し、`/work` 内のファイルを引き継ぎます。NCBI のアプリケーションのグローバル状態と終了処理を安全に扱い、連続実行やエラー後の再実行を可能にしています。`reset()` は Worker を終了して作り直すため、実行中の処理を中止できます。

## WASM の再ビルド

Linux x86_64 または Windows の WSL Ubuntu 22.04 でビルドします。`make`、GCC/G++、Git、curl、Python 3 が必要です。Ubuntu では以下で準備できます。

```bash
sudo apt-get update
sudo apt-get install -y build-essential git curl python3
```

```powershell
npm run build:wasm
```

Windows では既定で `Ubuntu-22.04` を使用します。別のディストリビューションを使う場合は `$env:WSL_DISTRO = 'Ubuntu-24.04'` を設定してください。Linux からは `bash scripts/build-wasm.sh` でも実行できます。

ソース・Emscripten SDK・ネイティブコード生成ツール・SQLite をダウンロードし、SHA-256 を確認します。ビルド作業は Linux 側の `~/.cache/webblastn/` に置きます。初回は SDK の取得と多数の C++ ファイルのコンパイルが必要です。`WEBBLASTN_BUILD_DIR` でキャッシュ先、`JOBS` で並列数（既定 16）、`RECONFIGURE=1` で設定の再生成を指定できます。キャッシュ先には Linux のパスを使用してください。

ログはキャッシュ内の `configure.log`、`generate.log`、`build.log` に保存されます。生成物のバージョン・サイズ・SHA-256 は `public/wasm/manifest.json` に記録されます。

コード生成には NCBI 配布のネイティブ `datatool` 2.25.0 を使用します。この配布 URL は `CURRENT` を含むため、配布内容が更新されるとチェックサム確認で停止します。検証済みの `datatool.tar.gz` をキャッシュに保持することで同じ入力で再ビルドできます。

移植用の変更は `scripts/prepare-build.py` にまとめています。

- LLVM のアーカイバと WASM のリンク設定。
- BitMagic の既存アロケータ API への修正と、32-bit の `size_t` に対する JSON 用の明示的型変換。
- ブラウザに存在しない対話パスワード入力を未対応として扱う処理と、DNS コードの移植用の型修正。
- Emscripten に存在しない LMDB の robust mutex API の無効化（DB v4 を使用）。
- NCBI のサービス探索で、ブラウザに存在しない System V IPC・DNS resolver の代わりに既存の未対応プラットフォーム向け処理を使用。
- ブラウザでの BLAST 利用状況レポートの無効化。

検索・アラインメント・統計処理のアルゴリズムは変更していません。

## 制約

- **各 BLAST コマンドはシングルスレッド**。Nanopore の複数 FASTQ は独立した Worker で並列実行できます。コマンド API は `-num_threads 1` を受け付け、実行時には省略します（NCBI の `--without-mt` ビルドでは、このオプション自体が存在しないため）。SharedArrayBuffer や COOP/COEP ヘッダーは不要です。
- **BLAST DB v4**。`makeblastdb` でバージョンが省略された場合は API が `-blastdb_version 4` を追加します。DB v5 はこの構成の対象外です。
- **ローカル検索**。`-remote` は使用できません。NCBI の `nt` を自動取得する機能はありません。
- ファイルはメモリ上で保持し、ページ再読み込み・リセットで失われます。WASM のメモリ上限は各インスタンス 2 GiB で、ファイルのコピーなどに追加のメモリが必要です。大規模なゲノムや `nt` 全体での動作は検証対象外です。
- 画面の FASTA 入力は非圧縮ファイルを対象としています。

## 検証

```powershell
npm test
npm run test:browser
```

ブラウザテストにはローカルの Chrome を使用します。Edge を使う場合は `$env:BROWSER_CHANNEL = 'msedge'` を設定してください。

ブラウザでの DB 作成、検索、一致配列・逆相補鎖、ヒットなし、DB バイナリの別 Worker への移動、繰り返し実行、非ゼロの終了コード、エラー後の再実行を検証します。ミスマッチと挿入を含む決定的な配列セットでも `blastn`・`megablast`・`dc-megablast`・`blastn-short` の結果を、公式のネイティブ BLAST+ 2.16.0 の出力と比較します。期待値の再生成スクリプトは `tests/generate-native-fixtures.py` です。

## ソースとライセンス

- [NCBI BLAST+ 2.16.0 ソース配布](https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/2.16.0/)
- [NCBI BLAST+ コマンドマニュアル](https://www.ncbi.nlm.nih.gov/books/NBK279690/)
- [Emscripten](https://github.com/emscripten-core/emscripten)
- [OpenPortablePipeline](https://github.com/c2997108/OpenPortablePipeline) — MIT。分割処理のライセンスは `public/app/DEMULTIPLEX-LICENSE.txt`。
- [fflate 0.8.2](https://github.com/101arrowz/fflate/tree/v0.8.2) — MIT。`public/vendor/fflate-LICENSE.txt` を同梱。

NCBI のソースには public-domain notice が含まれます。依存ライブラリと Emscripten ランタイムのライセンス表示は `public/wasm/THIRD_PARTY_NOTICES.txt` に収録しています。移植した生成物を再配布する際には、このファイルも同梱してください。
