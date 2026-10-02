# NAP — Nanopore Amplicon Pipeline

Nanopore アンプリコンの FASTQ 分割、コンセンサス生成、参照データベースによる分類を、ブラウザ内で実行するアプリです。`split-reads`、`get-consensus`、`rRNA annotation` を別タブにまとめ、メモリー内で次の解析へ渡せます。

リポジトリ: [c2997108/NAP](https://github.com/c2997108/NAP)

基になった処理は OpenPortablePipeline の [nanopore~split-barcode](https://github.com/c2997108/OpenPortablePipeline/blob/53c159aeedff6038f0fe5ab032bdd4f064067483/PortablePipeline/scripts/nanopore~split-barcode) と [nanopore~get-consensus](https://github.com/c2997108/OpenPortablePipeline/blob/53c159aeedff6038f0fe5ab032bdd4f064067483/PortablePipeline/scripts/nanopore~get-consensus) です。NCBI BLAST、MAFFT、VSEARCH、CD-HIT、minimap2、samtools を WebAssembly で実行します。

## 起動

Node.js 18 以降と Chrome / Edge を使用します。ビルド済み WASM を同梱しているため、解析時に Docker、WSL、Python、Java は不要です。

```powershell
cd "NAP (Nanopore Amplicon Pipeline)"
npm ci
npm start
```

[http://localhost:8002/](http://localhost:8002/) を開きます。別ポートを使う場合は PowerShell で `$env:PORT='8010'; npm start`、Bash で `PORT=8010 npm start` とします。起動だけなら `npm ci` は省略できます。依存パッケージは開発用ブラウザテストに使います。

サーバーはローカルの静的ファイルを配信するだけです。入力データのアップロード、外部 API、CDN は使用しません。解析は Web Worker とブラウザのメモリー内で行います。

## 分割からコンセンサスまで

1. **split-reads** タブで FASTQ / FQ / gzip（複数可）を選びます。プライマー・サンプルは `primer.fa` と `sample.txt` を選ぶか、「表で作成・編集」で入力します。
2. 条件を確認して「FASTQ を分割する」を押します。FASTQ ファイル単位で並列に処理します。
3. 「分割結果を選んでget-consensusへ」、または **get-consensus** タブを開きます。
4. サンプル別 FASTQ のチェックを選び、「選択したFASTQをget-consensusに渡す」を押します。名前による絞り込み、すべて選択、選択解除ができます。
5. get-consensus の入力一覧と解析条件を確認し、「解析を開始」を押します。
6. コンセンサス、サンプル別集計、アラインメントを確認し、ZIP / FASTA / FASTQ / Excel / HTML ビューアーを保存します。
7. 「結果をrRNA annotationへ」を押すと、`all.cnt.seq.qual.txt` が分類タブに渡されます。参照DBと条件を確認して「分類解析を開始」を押します。

受け渡しでは FASTQ の配列、品質値、ヘッダーをそのまま保持し、ファイルの保存・再選択は不要です。受け渡しだけでは解析を開始せず、解析条件も変更しません。保存済み FASTQ を get-consensus の入力欄から直接読み込むこともできます。1 FASTQ を 1 サンプルとして扱います。

タブの切り替えで入力、結果、実行中の Worker は失われません。解析中は get-consensus の入力を上書きできません。split-reads を再実行・リセットすると選択一覧は更新されますが、既に渡した FASTQ とコンセンサス結果は保持されます。**ページの再読み込み・終了ではメモリー内の結果が消えます。保存してから閉じてください。**

分割タブには、サンプル別 FASTQ だけをまとめる ZIP と、未分類リード・集計・判定座標などを含む ZIP の保存ボタンもあります。

## rRNA annotation

PortablePipelineの [annotation~rRNA-for-metabarcoding](https://github.com/c2997108/OpenPortablePipeline/blob/5c98917ecd94f807670e0537c8a63c5a0a048924/PortablePipeline/scripts/annotation~rRNA-for-metabarcoding) と、その呼び出し先のmetagenomeスクリプトを移植しています。get-consensusの入力配列・品質・カウントを保持し、`lca`、`top.taxpath`、`align.len`、`identity` を追加します。保存済みの `all.cnt.seq.qual.txt` を直接読み込むこともできます。

既定のBLAST条件はmegablast、フィルターはbitscore 100以上・一致率90%以上・クエリー座標のアラインメント長100 bp以上・被覆率0%以上です。最初に条件を満たしたヒットのスコアに対する比率（既定値1）でLCA対象を選びます。内部コントロールは元スクリプトの配列を使用し、一致率80%以上・アラインメント長60 bp以上なら `internal_control` に上書きします。内部コントロール欄を空にするとこの検索を省略します。

分類グループ表は元スクリプトと同じく **LCAと最上位ヒットの分類パスの組み合わせ**でカウントを合算します。分類なしの行は画面で `No Hit` と表示し、保存する分類列は空欄です。品質値は分類判定には使いません。

異なる根の分類が混在する場合は葉緑体候補を優先し、葉緑体候補同士の共通祖先を使います。

参照DBの指定方法は3通りです。

- **準備済みのローカル統合DB**: ローカルサーバーでは `data/annotation/`、GitHub Pagesでは同梱した `docs/annotation/database/` を自動で読み込みます。公開ページではファイル選択が不要です。
- **参照DBフォルダーを選択**: `manifest.json` と分割したDBファイルを含むフォルダーを選びます。ファイルはブラウザ内で読み込みます。
- **参照FASTA + 分類対応表**: FASTA（gzip可）と、`参照ID TAB 分類パス` の2列の `.path` / TSV（gzip可）を指定します。分類階層は `;` で区切ります。大きいFASTAは分割してBLAST DBを作り、順次検索します。「分類デモ」は合成配列・架空のDemo分類による動作確認用です。

### コンテナ内の参照DBを用意する

初回準備にはSSH、サーバー側のPodman・Python 3、ローカルのtarを使用します。解析の実行時にはこれらは不要です。

```powershell
npm run prepare:annotation-db
```

既定では `ssh m768` で接続し、既にインストールされている `docker.io/c2997108/centos7:2-blast-taxid-2-KronaTools-2.7-pr2-mito-silva-3` 内の `/usr/local/blastdb/mergedDB.maskadaptors.fa` と `.path` を使用します。この参照DBは2023年11月作成で、1,599,178配列・4,479,942,144塩基を含みます。利用したコンテナID・DB情報はマニフェストと各解析の `run.json` に記録します。ほかのホスト・コンテナを指定する場合は `npm run prepare:annotation-db -- ホスト名 イメージ名` とします。

準備処理は元コンテナのデータを保持し、元FASTAタイトルの先頭にある配列名を使ってBLAST DB v4の小さいボリュームを作成し、gzipで保存します。現在のDBは36ボリューム、ローカル保存量は約904 MBです。元の `data/` はGitの管理対象外です。サーバー側の一時コピーの場所は `data/annotation/source-location.txt` に記録します。

GitHub Pages用の統合DBを作り直す場合は、ローカルDBを用意してから次を実行します。

```powershell
npm run prepare:pages:db
npm run check:package
```

公開用コピーだけをgzipレベル9で再圧縮し、`docs/annotation/database/` に配置します。元のDBを変更せず、入力のSHA-256と展開サイズを確認し、公開ファイルのSHA-256・展開後のSHA-256・転送サイズをマニフェストに記録します。公開DBは約875 MB、`docs/` 全体は約976 MBです。[GitHub Pagesの上限1 GB](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)とGitの単一ファイル上限100 MiBを確認してからコピーします。公開DBはGit管理対象なので、更新した `docs/` をpushすると公開ページに反映されます。

分類解析では36分割と分類対応表を順に読み込みます。DB全体の転送量は約875 MBです。DBは入力表やFASTQの指定前には読み込まず、ユーザーの配列をサーバーへ送る処理もありません。Service Workerによる永続保存は追加していないため、再実行時の再ダウンロードはブラウザのHTTPキャッシュに依存します。

ブラウザは各ボリュームのSHA-256を確認し、1ボリュームずつ読み込んで使い終わったWorkerを終了します。全ボリュームのヒットを合わせてから500参照配列の上限・フィルター・LCAを適用します。`-dbsize` は全DBの塩基数を指定します。DB分割・BLASTのバージョン差により、E-valueや上限付近の同点ヒットの順序が元環境と異なる可能性があります。参照DB由来の2配列、内部コントロール、No Hit、短すぎる配列の計5配列で比較し、分類付き表と分類グループ表は元スクリプトの結果と一致しました。

| 保存ファイル | 内容 |
| --- | --- |
| `all.cnt.seq.qual.tax.txt` | 元の配列・品質・サンプル別カウントに分類情報を追加 |
| `all.cnt.seq.qual.tax.sp.txt` / `.xlsx` | 分類グループ別に合算したカウント表 |
| `annotation-results.html` | 単独で開ける分類結果・集計表・実行条件のページ |
| `blast.tsv` / `blast.filtered.tsv` | 全DBで上位500参照配列までのヒット / フィルター後のヒット |
| `internalcontrol.blast.tsv` / `annotations.tsv` | 内部コントロールの検索結果 / 配列別分類情報 |
| `all.cnt.seq.qual.txt` / `queries.fasta` | 解析に使用した入力表 / 検索配列 |
| `run.json` / `pipeline.log` | 条件・参照DBの出所・実行記録 |

```powershell
npm run test:annotation
# 実際のコンテナDBと元スクリプトの比較（m768へのSSH接続と準備済みDBが必要）
npm run test:annotation-full
```

## プライマー・サンプルの入力表

split-reads の入力欄で **「表で作成・編集」** を選ぶと、Excelのようにセルを編集する入力表が表示されます。FASTQは通常のファイル選択欄で指定してください。

1. Forward / Reverse それぞれの表に、**配列名と塩基配列の2列**を入力します。配列名が空欄の場合は、表の行番号に応じてForwardは `F1`、`F2`…、Reverseは `R1`、`R2`…を使用します。サンプル表の軸・自動サンプル名・保存ファイル・分割処理には同じ名前を使用します。配列名・塩基配列とも空欄の行は使用しません。「＋ Forward行を追加」／「＋ Reverse行を追加」で複数プライマーを登録できます。
2. サンプル表は Forward を縦の行、Reverse を横の列に並べます。交点にサンプル名を入力します。空欄は初期設定で `s_F名_R名` として sample.txt に出力します。「サンプル名が空欄の場合」を「出力しない」にすると、名前を入力した組み合わせだけを使用します。
3. プライマー名を変更すると、軸の表示、sample.txt の参照名と空欄セルの自動サンプル名が更新されます。入力済みのサンプル名と長さは保持されます。行を削除すると、そのプライマーに対応する組み合わせも削除します。
4. 最小・最大アンプリコン長は初期設定でどちらも空欄です。入力欄のラベル横に「0: 制限なし」と表示しています。空欄または `0` の側は長さを制限せず、最小だけ・最大だけも設定できます。長さは両端のプライマーを含みます。「セルごとの長さも表示」で組み合わせごとに調整できます。共通長の変更は個別設定していないセルに反映し、「全セルに長さを適用」は個別設定も含めて更新します。
5. **「FASTQ を分割する」** を押すと、表の最新内容を直接使用します。先に保存したファイルを選び直す必要はありません。

プライマー表は「配列名」と「塩基配列」の2列をタブ区切り・スペース区切りのどちらでも貼り付けられます。ForwardまたはReverseの配列名の欄を選び、次のような複数行をまとめて貼り付けると、必要な行を自動追加し、サンプル表の行・列にも反映します。連続したスペースやタブ、空行にも対応します。

```text
F1 ACGTACGA
F2 GCTAGCTT
```

サンプル表はExcelなどからタブ・改行区切りの範囲を既存の行・列へ長方形で貼り付けられます。プライマー表では配列名・塩基配列のどちらからEnterキーを押しても次の行の配列名へ移動し、最終行では新しい行を追加します。行の削除ボタン（×）は配列名の左側にあります。サンプル表ではEnterキーで同じ列の次の行へ移動します。サンプル表の最終行では新しいForwardプライマーの配列名入力欄へ移動し、配列名または塩基配列を入力するとサンプル表にも行が追加されます。空のForward行がある場合はその行を使用します。日本語入力の変換確定中は移動しません。通常のTabキーでも入力欄を移動できます。プライマー名・サンプル名には半角の英数字と `- . _` だけを使用できます（`*` は使用できません）。デフォルト名と入力した名前の重複も、入力欄を離れたときに確認します。名前の重複、不正なDNA、使用できない文字や長さの不備は保存・実行前に検証します。実際にリードが割り当てられた組み合わせだけにFASTQを作成します。

名前や塩基配列に禁止文字を入力・貼り付けると該当セルを赤く表示し、警告をポップアップします。塩基配列のセルは半角アルファベット（A-Z、a-z）のみ有効で、数字・記号・空白・日本語は使用できません。使える文字だけに修正すると赤色は解除されます。同じセルが不正な間は警告を繰り返しません。

プライマー名はForward / Reverse全体で、サンプル名は自動命名を含めて重複を確認します。重複の判定はテキストボックスからフォーカスが外れたときに行い、入力中・貼り付け直後には警告しません。同じ名前のセルをすべてオレンジ色にし、重複した名前を警告欄とポップアップで知らせます。空欄を「出力しない」に設定したサンプルは重複判定の対象外です。修正後に入力欄を離れると色と警告は解除されます。行の削除や空欄の出力設定の変更でも判定を更新します。

**「primer.fasta を保存」「sample.txt を保存」** でファイルをダウンロードできます。「生成ファイルのプレビュー」は初期状態で開いており、内容を確認できます。見出しをクリックすると折りたためます。FASTAはForwardの全レコードとReverseの全レコードをまとめ、配列名の後にスペースと方向情報を追加します。

```fasta
>F1 Forward
ACGTACGA
>R1 Reverse
TTGCTAAC
```

入力した5′→3′の配列をそのまま使い、Reverseを保存時に逆相補へ変換することはありません。塩基配列の小文字は保存時に大文字へ整えます。保存・分割には4塩基以上のDNA配列（IUPAC縮重塩基を含む）が必要です。プライマー名は両方向を通して一意にしてください。保存するsample.txt はヘッダーなしの `サンプル名・Forward名・Reverse名・最小長・最大長` の5列です。空欄の長さは、ファイルでは最小 `0`・最大 `0` として保存します。方向情報はFASTAヘッダーの補足なので、分割時の照合は配列名だけを使います。

既存ファイルの編集は「ファイルを選択」でFASTAとsample.txtの両方を指定すると、自動で表に読み込み、「表で作成・編集」を開きます。どちらのファイルを先に選んでも同じです。FASTAだけを選んだ場合も「表で作成・編集」を押すと、その時点でファイルを読み込み、方向を判定してサンプル表を作成します。方向はFASTAのForward / Reverse指定を優先し、指定がない配列はsample.txtのForward / Reverse参照から判定します。参照名とFASTAの配列名を一致させてください。どちらからも方向を判定できない配列はForwardに配置し、その配列名を読み込み結果に表示します。読み込み済みの同じファイルで入力方法を切り替えても、表の編集内容は保持します。ファイルの内容を再読込みするには、表モードの「選択済みファイルを表に読み込む」を押してください。形式が不正な場合や方向の指定が矛盾する場合は、現在の表を保持してエラーを表示します。

入力方法やメインタブを切り替えても表の内容は保持します。解析中は表を編集できません。ページの再読み込み・終了前に、作成したファイルを保存してください。

## 合成デモ

「分割デモを読み込む」→「FASTQ を分割する」で、`public/examples/` の合成入力を使えます。実験由来の配列や個人の入力ファイルは同梱していません。

| 段階 | 既定条件での結果 |
| --- | --- |
| 入力 | 2 gzip FASTQ、計 12 リード、4 プライマー、2 サンプル定義 |
| split-reads | `nap_demo_A.fq` と `nap_demo_B.fq`、各 6 リード、各配列 400 bp |
| get-consensus に両方渡す | 2 コンセンサス、2 代表配列 |
| BLAST 集計 | サンプル A / B の割当数が `[6, 0]` / `[0, 6]` |
| A だけ渡す | 1 サンプル、1 代表配列、6 リードを割当 |

`scripts/generate-demo.mjs` でデモを再生成できます。期待配列は `public/examples/expected.json` に記録しています。「比較用設定（blastn / 80%）」は検索条件を変更するボタンです。このデモには必要ありません。

get-consensus 内の「デモを読み込む」は元アプリの別の合成デモ（各 60 リード）です。逆向きリードを含むため、そのボタンだけは両方向検索と MAFFT 方向調整を有効にします。

## split-reads の入力と条件

サンプル表はヘッダーなし、空白またはタブ区切りの 5 列です。

```text
sample_A  forward_A  reverse_A  430  530
sample_B  forward_B  reverse_B  430  530
```

列はサンプル名、Forward プライマー ID、Reverse プライマー ID、最小アンプリコン長、最大長です。長さの空欄・省略はその側の制限なしとして読み込み、最小 `0`・最大 `0` でも無制限にできます。空欄の列を含めるときはタブ区切りを使用してください。サンプル名が空欄の行は `s_F名_R名` として読み込みます。長さは両端のプライマーを含みます。プライマーの ID を `primer.fa` と一致させてください。出力ではプライマーを除去し、逆向きアンプリコンの配列と品質を補正します。連結リードから複数の配列が出ることがあります。

| 条件 | 既定値 |
| --- | --- |
| BLAST 検索モード | megablast（原本の `-task` 省略に対応） |
| word_size | プライマー・バーコードともに 4 |
| プライマー被覆率 / 一致率 | 0.6 / 80% |
| バーコード被覆率 / 一致率 | 0.9 / 90% |
| max_target_seqs | プライマー 10000、バーコードは BLAST の既定値 500 |
| バッチあたりリード数 | 300 |
| 同時処理ファイル数 | 8、設定可能範囲 1〜16 |

これらは既存ブラウザ版から保持しています。大量のヒットで BLAST がメモリー不足を報告した場合は、検索条件を変えずにバッチを半分に分けて再試行します。`run.json` に条件、再試行回数、ファイルごとの実行状況を残します。

進捗は各ジョブの **分割処理を完了したリード数 / 総リード数** で更新します。総リード数は処理前にストリーミングで数えるため、FASTQ の読み込み・gzip 展開が 1 回追加されます。確認中はその旨を表示し、配列全体はメモリーに保持しません。ファイル別のバー、％、完了 / 全リード数、現在の検索段階を表示します。全体のバーは各ファイルの割合を入力ファイルサイズで重み付けし、最終集計の完了で100%になります。gzip の先読み、ジョブの開始、失敗した検索・メモリー再試行は完了として数えません。BLAST コマンド内の細かい進行率は取得できないため、処理済みリード数はバッチの完了時に更新します。

「分類済みリード」は分類された入力リード数、「出力配列」は分割後の断片数です。原スクリプトの `Demultiplexed reads` と比較するときは出力配列数を使ってください。

分割結果の各サンプル別FASTQに、最短・最長・平均長・中央値（bp）と、その右側にリード長分布・クオリティ分布を表示します。複数の入力ファイルが同じサンプルに分割される場合は、すべての出力配列をまとめて集計します。中央値は正確な長さ別の件数から計算し、偶数本の場合は中央2本の長さの平均です。リード長分布の縦軸は、各区間に含まれる出力配列の実際の長さを合計した**塩基数（bp）**です。棒にカーソルを重ねると、区間・塩基数・配列数・全出力塩基数に対する割合を確認できます。クオリティ分布の縦軸と割合は、品質情報のある出力配列数を使います。

長さは**プライマー除去後の配列**を使い、クオリティ分布は**元リードのFASTQヘッダーに記載されたQスコア**を1 Q幅で集計します。リードIDの後の空白・タブに続く `qs:f:17.25`、`qscore=17.25`、`mean_qscore=17.25`、`mean_qscore_template=17.25`、`qs=17.25` を認識します。FASTQの品質文字列からQスコアを計算・補完する処理は行いません。

品質注記がない、または値が不正・負数の場合は品質分布から除外します。サンプル内に有効な値が一件もない場合はグラフを表示せず、その旨を表示します。一部だけに品質情報がある場合は、グラフの下に対象配列数 / 全出力配列数を表示し、グラフの割合は対象配列数を分母にします。長さの集計には品質情報のない配列も含みます。

Qスコアはトリミング前の元リードの情報です。同じ元リードから複数の断片を出力した場合は、各断片に同じQスコアを対応付けます。ヘッダーの注記とFASTQの品質文字列は出力にも保持します。元スクリプトが `sequencing_summary` の値を `qs:f:` として付けたFASTQも使用できます。品質注記が複数ある場合は最後の注記を使います。

分割中に長さ別・Q別の件数だけを保持して集計し、グラフのためにFASTQを再読み込みしたり、各リードの配列や品質を別途保持したりしません。表示する長さ分布は最大約33区間にまとめますが、中央値の精度は変わりません。

| 保存ファイル | 内容 |
| --- | --- |
| `sample-counts.tsv` | 配列数、塩基数、最短・最長・平均長・中央値、品質情報のある / ない配列数 |
| `length-distribution.tsv` | 画面の長さ分布と同じ区間の配列数・総塩基数。上端を含む |
| `quality-histogram.tsv` | ヘッダーQスコア分布の配列数。下端以上・上端未満 |
| `length-histogram.tsv` | 従来の長さ区間（100 bp以上は約10%刻み）の配列数・塩基数 |
| `run.json` | 実行条件、集計値、画面用の分布、品質の取得元・対象配列数 |
| `split-barcode-results.html` | 実行条件・入力情報・結果表・長さ／品質の分布を含む、単独で開ける結果ページ |
| `primer.fa` / `sample.txt` | 実際に解析へ渡したプライマーとサンプル定義。表入力の場合は生成した内容 |

「すべて ZIP で保存」は全出力ファイルを含みます。「分割 FASTQ をまとめて保存」には、サンプル別FASTQに加え、`split-barcode-results.html`・`primer.fa`・`sample.txt` を含めます。FASTQは前者では `output/` の下、後者ではZIPの直下に配置します。各HTMLのファイルリンクは、そのZIP内の配置に対応しています。

`primer.fa`・`sample.txt` はクリーン化・縮重展開前の、解析に使用したテキストそのものです。解析後に入力欄を編集しても、保存する定義やHTMLの実行条件は変わりません。既存の `primer-clean.fa`・`primer-tags.fa` は別ファイルとして保持します。

## get-consensus の条件と出力

品質ビンによる VSEARCH クラスタリング → MAFFT コンセンサス → VSEARCH 再統合 → minimap2 / samtools / VarScan の変異判定とハプロタイプ生成 → 全サンプルの CD-HIT 統合 → BLAST 割当・集計を行います。

初期値は最小 3 リード、コンセンサスに使う最大 30 リード、ハプロタイプの最小深度 30、初回同一率 0.97、2 回目 0.99、全サンプル統合 1、最大 8 サンプル並列です。初期の鎖方向は元スクリプトと同じ順方向です。受け渡しでこれらの値は変更しません。

FASTQの読み込み・品質別クラスタリングの準備・結果の解析を、サンプルごとの独立したWorkerで処理します。大きい入力から実行し、結果は入力順に統合します。各ツールは1計算スレッドですが、異なるサンプルのツールは並列に動きます。全サンプルのCD-HIT統合・代表配列MAFFT・DB生成・Excel生成は共通処理なので1ジョブです。並列数とCPU使用率は一致しません。

解析済みサンプルの全リードをBLASTまで保持せず、サンプルWorkerの終了時に解放します。BLAST集計では元のFASTQを再読み込みし、バッチ分の配列だけを保持します（重複ID検査用のID集合は保持します）。gzip入力はこの段階で再び展開します。ツールの標準出力は固定サイズのバイト配列で受け取り、大きなSAMやpileupをJavaScriptの数値配列に溜めません。

WASMのメモリー確保が失敗した場合は、同時処理上限を半分に下げ、起動済みジョブが減ってから失敗したサンプルを再試行します。完了済みサンプルと検索条件は保持し、低下した上限は後段のBLASTにも適用します。実効上限・再試行回数・警告は`run.json`に記録します。単独のジョブでも確保できない場合は、有限回の再試行後に理由を表示して停止します。入力ファイルの分割や並列数の低下が必要になる場合があります。ブラウザのプロセス自体が終了した場合の自動復旧はできません。

全体とサンプル別のプログレスバーを表示します。読み込み済みの入力サイズ、品質別クラスタリングの処理済みビン、各クラスターのMAFFT段階と完了数、マッピング・ハプロタイプの完了段階、BLAST集計済みのリード数で進捗を更新します。全サンプル統合・代表配列の整列・データベース生成も全体進捗に含めます。並列ジョブの開始だけでは進まず、Excelと結果画面の生成が完了して100%になります。段階の重みと入力ファイルサイズによる集計なので、残り時間の見積もりではありません。ツールが内部進捗を報告できない処理は、その段階の完了までバーを保持します。

| 保存ファイル | 内容 |
| --- | --- |
| `output-consensus.fastq` / `.fasta` | クラスターとハプロタイプのコンセンサス |
| `output-all-clusters.max.uc.fasta` / `.mafft` | 全サンプル統合後の代表配列・整列 |
| `all.cnt.txt` / `.seq.txt` / `.seq.qual.txt` | サンプル別割当数・配列・品質 |
| `all.cnt.seq.qual.xlsx` | Excel 集計表 |
| `get-consensus-results.html` | 結果表・サンプル別の結果・実行条件・ログ・アラインメントを含む、単独で開ける結果ページ |
| `output-consensus-viewer.html` | 単独で開けるアラインメントビューアー |
| `work/` / `work-blast/` | 中間結果、BAM / BAI / FAI、VCF、検索結果 |
| `run.json` / `pipeline.log` | 条件・バージョン・ログ |

split-reads から渡した場合、コンセンサス側の `run.json` の `nap` に、選択ファイル名と分割側の条件・入力名・集計を記録します。ディスクから直接選択したファイルには、この分割履歴を付けません。

両段階の結果HTMLはZIPに含まれ、画面の出力ファイル一覧から個別にも保存できます。CSS・グラフ表示・アラインメント表示に必要なデータとスクリプトをHTML内に埋め込むため、サーバーを停止しても、インターネットに接続しなくてもブラウザーで開けます。get-consensusの結果表からアラインメントを選択し、拡大・差分の強調も使用できます。出力ファイルのリンクを使う場合はZIPを展開し、HTMLと各出力ファイルの位置関係を保ってください。結果HTMLは完了した解析の閲覧用で、解析を再実行する場合はNAPアプリを使用します。

## 互換性と実行上の制限

- 分割の同点ヒットは HSP 数、プライマー名の順で固定します。原 AWK はバッチの先頭リードの列挙順が未指定なので、同点のあるリードは原本と異なることがあります。既存ブラウザ版の 95,008 リード検証では 75,129 断片に対して 75,126 断片でした。完全一致を保証するものではありません。
- IUPAC の `S→S` / `W→W` 逆相補を保持しています。名前は上記の文字に制限するため、以前の展開済みFASTAに含まれる `#_#番号` のIDは使用できません。元のプライマー配列を使用し、アプリの縮重展開を利用してください。
- コンセンサスの同率塩基は辞書順で固定し、SNP と INDEL を統合します。原本の乱数選択・INDEL 分岐とは異なります。全サンプル統合は原本どおり CD-HIT（アミノ酸用コマンド）です。
- **コンセンサス FASTQ の品質値は塩基の一致率であり、通常の Phred スコアではありません。** 100% 一致は `Z` です。
- 各 WASM インスタンスは最大 2 GiB、各ツールは 1 計算スレッドです。並列数を増やすほど同時に使う CPU とメモリーが増えます。大きな入力では並列数・バッチサイズを下げてください。
- get-consensusのクラスタリング時は実行中のサンプルの全リードをメモリーに保持します。完了したサンプルの全リードは解放し、BLASTは再読込してバッチ処理します。中間結果と最終出力はBlobとして保持するため、出力総量にも注意が必要です。ZIPは非圧縮ZIP32、4 GiB未満です。大規模データはネイティブ版が必要になる場合があります。
- sequencing_summary の品質注釈、Docker の CPU / メモリー設定、任意のシェルオプション列、R / PNG グラフ生成は移植対象外です。

既存アプリの説明を [split-reads の記録](docs/split-reads-original.md)と [get-consensus の記録](docs/get-consensus-original.md)に保存しています。これらは統合前の参考資料なので、起動パス・ポート・テストの実行方法はこの README を使用してください。過去の実データや検証出力はこの配布物には含めていません。

## 検証

```powershell
npm ci
npm test
```

インストール済み Chrome と Playwright 1.56.1 を使い、実際のブラウザと WASM で次を確認します。

- 12 リードの並列分割、各 6 リードの配列・品質・ヘッダー。
- プライマーの2列表、Excel貼り付け、名前に連動するサンプル表、長さの保持、方向情報付きFASTA保存、sample.txt保存・読み戻し、生成入力を使うWASM通し解析。
- ジョブ内のバッチ進捗、読み込みや開始だけでバーが進まないこと、最終集計後の100%、メモリー再試行時の進捗。
- 空欄の長さで短い・長いアンプリコンを制限しないこと、空欄サンプルの自動命名と除外オプション、`- . _` を含む名前によるWASM通し解析、`*` を含む名前の拒否。
- get-consensusのMAFFT完了段階・BLAST処理済みリード数による進捗、並列サンプルの重み付け、結果生成後の100%、失敗時に完了と数えないこと。
- 1 ファイルだけの選択、全選択、FASTQ の内容が完全に保持される受け渡し。
- 解析条件の保持、解析中の入力保護、タブ切り替え中の Worker 継続。
- 2 サンプルの並列コンセンサス生成と BLAST 集計、ZIP / Excel / HTML 保存、分割履歴。
- サンプルWorkerでの逐次／並列結果一致（通常・品質別クラスタリング）、300個の合成FASTQを16サンプル並列で処理、WASMメモリー確保失敗を模擬した並列数の低下・再試行・結果一致、完了後のWorker解放（`npm run test:consensus-memory`）。この300ファイル検証は各3リードの合成入力であり、任意の実データサイズを保証するものではありません。
- リセット後の結果保持、古い分割結果の受け渡し拒否、保存済み FASTQ の選択、中止・再実行。
- モバイル表示、COOP / COEP、外部通信・アップロードがないこと。
- ヘッダーなしの静的配信と `/リポジトリ名/` 配下でのService Worker起動、初回のみの再読み込み、両タブのWASM通し解析、Worker更新後の入力・結果保持、起動失敗時の再読み込みループ防止。
- 同梱 WASM、対応ソース、vendor の SHA-256 とファイルサイズ、相対参照の整合性。

結果とスクリーンショットは `test-results/` に保存します。パッケージ確認だけは `npm run check:package`、ブラウザ検証だけは `npm run test:integration` です。

入力表のブラウザ検証だけを実行する場合は `npm run test:editor`。モデルと進捗の単体検証は `node --test tests` です。

ヘッダーなしの配信を検証する場合は `npm run test:service-worker`（`public/`）または `npm run test:pages`（公開用の `docs/`）。GitHub Pagesのプロジェクトサイトを想定したサブパスで配信し、実際のBLAST / VSEARCH / コンセンサス処理まで検証します。`npm test` では `docs/` の検証と、`public/` とのファイル一致も確認します。

2026-09-27 に Windows Chrome 152 で通し検証済みです。[統合版の検証記録](docs/integration-verification.md)を参照してください。

Edge では `$env:BROWSER_CHANNEL='msedge'; npm test`。Playwright Chromium を使う場合は `npx playwright install chromium` 後に `$env:BROWSER_CHANNEL='chromium'; npm test`（Bash では `BROWSER_CHANNEL=chromium npm test`）です。GitHub Actions は Chromium を使います。

## 配置・ソース

```text
NAP (Nanopore Amplicon Pipeline)/
├── public/
│   ├── index.html, nap.mjs, nap.css  # 3 タブと解析結果の受け渡し
│   ├── bootstrap.mjs, isolation.mjs # 解析環境の準備と初回起動制御
│   ├── coi-serviceworker.js         # ヘッダーなしの配信向け補助
│   ├── split-reads/                 # 分割アプリと Worker
│   ├── get-consensus/               # コンセンサスアプリと WASM
│   │   └── sources/                 # WASM の対応ソースアーカイブ
│   ├── annotation/                  # BLASTによる分類・LCAと集計
│   ├── shared/wasm/                 # 両アプリ共通の NCBI BLAST
│   └── examples/                    # 合成入力のみ
├── docs/                            # GitHub Pages公開一式と参考資料
│   ├── index.html, .nojekyll
│   ├── split-reads/, get-consensus/, shared/, examples/
│   ├── annotation/database/         # 公開用の統合参照DB
│   └── coi-serviceworker.js         # public/と同じ解析環境の補助
├── scripts/                         # サーバー、公開用コピー、テスト、デモ生成
├── upstream/                        # 固定版の元スクリプトと出典
├── sources/, licenses/              # 再ビルド手順とライセンス
├── .github/workflows/               # ブラウザ検証 CI
└── README.md, LICENSE, THIRD_PARTY_NOTICES.md
```

このフォルダー全体で独立しています。元の `webBLASTN` と `get-consensus` は実行に不要です。ビルド済み WASM と約 70 MB の対応ソースアーカイブもリポジトリに含めてください。ハッシュは各 `wasm/manifest.json` に記録しています。再ビルド方法は [sources/README.md](sources/README.md) を参照してください。

別の静的サーバーで配信する場合は、`public/` を公開ルートにします。HTTPヘッダーを設定できるサーバーでは、全リソースに次のヘッダーを付けます。

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

`.mjs` は JavaScript、`.wasm` は `application/wasm` として配信し、localhost または HTTPS で開きます。`file://` の直接起動には対応しません。

### GitHub Pagesなど、HTTPヘッダーを設定できない配信先

`public/` に同梱した `coi-serviceworker.js` がブラウザ内でCOOP / COEPヘッダーを補い、VSEARCHの共有メモリーを利用できる環境を準備します。外部CDNからの読み込みはありません。`/リポジトリ名/` のようなサブパスに置いた場合も、登録範囲はそのアプリのフォルダー内です。

GitHub Pagesの **Deploy from a branch** では、公開フォルダーとしてブランチのリポジトリ直下 `/` または `/docs` を指定できます（[GitHub公式の公開元設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)）。このパッケージは `/docs` から公開できる構成です。

```powershell
npm run prepare:pages
```

このコマンドで `public/` の中身を `docs/` 直下にコピーします。HTML・JavaScript・CSS・WASM・Worker・合成デモ・対応ソースアーカイブ・ライセンスを含みます。`docs/.nojekyll` によりJekyll処理を無効にし、`vendor/` などもそのまま配信します。`public/` を編集した後は、pushする前にもう一度実行してください。`docs/` はGitの管理対象です。

`npm run prepare:pages` は既存の公開用DBを保持します。DBも更新する場合は `npm run prepare:pages:db` を使います。GitHub Pagesで「準備済みのローカル統合DB」を使用するには、`docs/annotation/database/` も公開に含めてください。

GitHub側では **Settings → Pages → Source: Deploy from a branch → 公開ブランチ（例: main）→ /docs → Save** を選択します。公開URLは通常 `https://ユーザー名.github.io/リポジトリ名/` です。URLに `/docs/` は付きません。このNAPフォルダーをリポジトリのルートにして配置してください。GitHub Actionsを公開元にする場合も、統合DBを含む `docs/` をアップロードしてください。

- 初回は「ブラウザの解析環境を準備しています…」と表示し、入力前に一度だけ自動再読み込みします。準備が終わってから入力表と解析画面を有効にします。
- トップ画面、split-reads単独画面、get-consensus単独画面、ツール単体画面に対応します。
- Service Workerの更新による自動再読み込みは行いません。開いている入力・解析結果を保持します。通常のページ再読み込みや終了で入力・結果が消える点は従来と同じです。
- ブラウザがService Workerを利用できない場合や準備に失敗した場合は、理由を表示して停止し、再読み込みを繰り返しません。HTTPSで開き、ブラウザの設定を確認してください。
- Service Workerは配信された応答のヘッダーを補う処理だけを行います。FASTQや解析結果のサーバー送信・永続キャッシュは追加しません。オフライン用キャッシュではありません。

`npm start` のようにサーバー側でCOOP / COEPが設定済みの場合は、新しくService Workerを登録せずに起動します。公開設定・GitHub Pagesへのデプロイは別途行ってください。この変更は公開ワークフローを追加しません。

同梱元は [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) v0.1.7（MIT）です。[固定コミットとSHA-256](public/coi-serviceworker.manifest.json)、[ライセンス全文](public/coi-serviceworker-LICENSE.txt)を同梱しています。上流のページ側スクリプトは実行せず、NAPの起動処理で登録・初回再読み込みを制御します。

## GitHub への登録

この NAP フォルダーをリポジトリのルートにできます。`.gitignore` は依存パッケージ、テスト出力、ビルド、`data/` と `results/` を除外します。実験入力はこれらのフォルダー、またはリポジトリ外に保存してください。実行時にユーザーのファイルをこのフォルダーへ書き込む処理はありません。

新しいリポジトリへ登録する例です。リモート URL は作成したリポジトリのものに置き換えます。

```powershell
git init -b main
npm run prepare:pages
git add .
git commit -m "Add NAP browser pipeline"
git remote add origin <repository-url>
git push -u origin main
```

## ライセンス

アプリの MIT ライセンスと元パイプラインの著作権表示を [LICENSE](LICENSE) に保持しています。同梱ツール、ランタイム、移植部分にはそれぞれのライセンスが適用されます。配布物全体が一律に MIT という意味ではありません。

**VarScan の移植部分は非商用の学術・政府・非営利機関向けライセンスです。** 詳細は [VARSCAN-LICENSE.txt](licenses/VARSCAN-LICENSE.txt) と [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を確認してください。
