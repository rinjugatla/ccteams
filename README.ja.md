# ccteams — Claude Code のためのエージェントチーム・パッケージマネージャー

> [!NOTE]
> このファイルは [README.md](./README.md) の日本語訳です。**正本は英語版**で、内容が食い違う場合は英語版が正しいものとして扱ってください（更新の運用は [翻訳について](#翻訳について) を参照）。

あらかじめ用意された Claude Code サブエージェントのチームを、コマンド1つでプロジェクトに適用できます。作業の内容が変われば、チームを積み増したり外したりできます。**エージェントチーム**とは、役割・専門性・振る舞いを持つサブエージェント一式と、それらの連携を制御するオーケストレーションルールをまとめたもので、プロジェクトの `.claude/` ディレクトリで1つの単位として管理されます。チームの適用は**追加式**です。同じプロジェクトに複数のチームを同時に適用でき（たとえばスタック専用のチームに `frontend` を重ねる、など）、`ccteams unuse <team>` を使えば他のチームに影響を与えずに1つだけ外せます。

## 2つの使い方

ccteams はターミナルからでも、Claude Code の中からでも、両方併用でも使えます。自分のやり方に合うものを選んでください。

![コマンドラインから使う ccteams](assets/cli-demo.gif)

![Claude Code の中から使う ccteams](assets/plugin-demo.gif)

```bash
ccteams list                 # チームの一覧を見る
ccteams use <team>           # 現在のプロジェクトに1つ適用する（例: ccteams use go-api）— 追加式で重ねられる
ccteams unuse <team>         # 適用済みチームを1つ外す。他のチームはそのまま残る
```

|                                | 操作の仕方              |                                                                                                                     |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **CLI**（`ccteams`）           | ターミナルから          | `ccteams list`、`ccteams use <team>`、`ccteams unuse <team>`、`ccteams current`                                       |
| **プラグイン**（`/ccteams:*`） | Claude Code の中から    | `/ccteams:list-teams`、`/ccteams:use-team`、`/ccteams:unuse-team`、`/ccteams:choose-team` — やりたいことを説明すると、チームを選んでくれます |

実際に処理を行うのは CLI なので、こちらは必ずインストールします。プラグインは Claude Code の中でスラッシュコマンドを使えるようにするもので、その中のスキルは裏で CLI を呼び出します。入れるのはどちらか一方でも、両方でも構いません。

## インストール

### 1. CLI をインストールする

> [!IMPORTANT]
> ここに書いたインストール手順は、npm レジストリに公開されている `ccteams` パッケージのものとは異なります。公開されているほうはアップストリーム（本家）のパッケージで、このフォークの変更（マニフェスト v4、`ccteams migrate` など）が入っていません。下記のとおり、このリポジトリの Git URL からインストールしてください。`npm install -g ccteams` は**使わないでください** — 無関係なアップストリームのパッケージが入ってしまいます。`ccteams upgrade` は安全に実行できます。このフォークの Git URL から入れ直すので、常にこのフォークのままになります。

```bash
npm install -g https://github.com/rinjugatla/ccteams.git
ccteams list
```

クローンは不要です。npm が Git URL から直接インストールします。（ccteams 自体を開発する場合は、クローンして `npm install -g .` でも構いません。[開発とローカルでの動作確認](#開発とローカルでの動作確認) を参照してください。）

利用できるチームの一覧が表示されれば成功です。この時点でもう使えます。`ccteams use <team>` でチームを適用し、Claude Code を再起動してください。

### 2. Claude Code プラグインを追加する

Claude Code の中でスラッシュコマンドを使うには、マーケットプレイスを追加してプラグインをインストールします。

```
/plugin marketplace add rinjugatla/ccteams
/plugin install ccteams@ccteams
/reload-plugins
```

`/reload-plugins` の代わりに Claude Code を再起動しても構いません。これで `/ccteams:list-teams`、`/ccteams:use-team`、`/ccteams:unuse-team`、`/ccteams:choose-team` が使えるようになります。（プラグインのスキルは裏で `ccteams` CLI を呼ぶので、CLI も入っている必要があります。）

## 更新する

```bash
# CLI（新しいコマンドや新しい同梱チーム）— 上と同じ Git URL からのインストール
npm install -g https://github.com/rinjugatla/ccteams.git
# ...または同じ意味で: ccteams upgrade

# プラグイン（新規・変更されたスラッシュコマンド）
/plugin marketplace update ccteams   # リポジトリから最新を取り直す
/reload-plugins                       # または Claude Code を再起動する
```

`npm install -g ccteams@latest` で更新してはいけません。アップストリームの npm パッケージが取得され、このフォークの CLI が置き換わってしまいます（[インストール](#インストール) の注記を参照）。`ccteams upgrade` は上の Git URL からのインストールと同じ処理なので、こちらは安心して使えます。

完全にアンインストールして入れ直す必要は**ありません**。新しいスラッシュコマンドは、プラグインの `version` が上がったときに利用者へ届きます（プラグインのバージョンは `plugin.json` で管理されています）。マーケットプレイスを更新してから `/reload-plugins` を実行すれば取り込まれます。

パッケージを更新しただけでは、プロジェクトの `.claude/` にすでに置かれたものは何も変わりません。そこに書き込むコマンドは `ccteams use`、`ccteams unuse`、`ccteams migrate` の3つだけで、いずれも自分で実行したときにしか動きません。すでにプロジェクトへ雛形として配置済みのディレクトリ（たとえば `.claude/skills/team-lessons/`）に、新しい ccteams が新しいファイルを追加している場合は、`ccteams migrate` を実行して取り込んでください。詳しくは後述の [プロジェクトを最新に保つ](#プロジェクトを最新に保つccteams-migrate) を参照してください。

## 使い方

### コマンドライン（CLI）

```bash
ccteams list                      # すべてのチーム（1行ずつの簡易表示）
ccteams list --details            # 説明とタグを省略せずに表示
ccteams list --json               # 機械可読な JSON
ccteams use <team>                # 現在のプロジェクトにチームを適用（積み増し）する — 追加式
ccteams use <team> --agent-teams  # 適用に加えて agent-teams モードも有効にする（任意）
ccteams unuse <team>              # 適用済みチームを1つ外す。他のチームはそのまま残る
ccteams current                   # 現在適用されているチームをすべて表示
ccteams migrate                   # 新しい ccteams が持つファイルを追加・更新し、古い SKILL.md を報告する
ccteams migrate --dry-run         # プレビューのみ。何も書き込まない。処理すべきものが残っていれば終了コード1
ccteams migrate --yes             # 確認を省略。それでも、あなたが編集したファイルには手を触れない
ccteams migrate --yes --force     # あなたが編集したファイル（やベースラインが不明なファイル）も上書きする
ccteams --version                 # バージョンを表示
```

`ccteams use` や `ccteams unuse` を実行したら、変更を読み込ませるために **Claude Code を再起動してください**（後述）。

### Claude Code のスラッシュコマンド（プラグイン経由）

```
/ccteams:list-teams                    # 利用できるチームを一覧表示
/ccteams:use-team <team-name>          # チームを適用（積み増し）する
/ccteams:unuse-team <team-name>        # 適用済みチームを1つ外す
/ccteams:choose-team <natural-language> # 説明からチームを探して適用する（「バックエンド作業向け」「フロントエンド中心」など）
```

## 用意されているチーム

ccteams には最初から次のチームが同梱されています。どのチームも builder と reviewer の組み合わせです（例外は `research` で、読み取り専用の researcher が1人だけです）。さらにどのチームにも、そのスタック向けの**ドメイン playbook スキル**（`<team>-playbook`）が付属します。これはフロンティアモデルの作業規律をそのスタック向けに実務的にまとめたもので、作業ループ、失敗カタログ（症状 → 誤った直感 → 正しい打ち手）、判別に使えるチェック、決定木、検証の手順、レビュー時に探すべき点の一覧が入っています。各エージェントには、最初の行動として自分の playbook を読むことが指示されています。またチームのオーケストレーションルールは、playbook に照らして報告の可否を判断します。

| チーム           | 用途                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `generalist`     | スタックを問わない、最初から最後まで通して担当する機能開発チーム。範囲の整理 → 設計 → 実装 → QA → 出荷。スタック専用チームが合わないときや、スタックをまたぐ一般的な作業に。 |
| `next-ts`        | Next.js（App Router）+ TypeScript + Tailwind — RSC、Server Actions、型安全なデータ取得、アクセシブルな UI。                                |
| `frontend`       | フレームワークに依存しない UI/UX とアクセシビリティ — Next.js 固有ではない UI 作業や、a11y・レスポンシブ・UX 品質に集中したいとき。          |
| `sveltekit`      | SvelteKit 2 + Svelte 5 + TypeScript — リアクティブなコンポーネント、サーバーサイドレンダリング、form actions、型安全な load 関数。         |
| `react-native`   | Expo + React Native（TypeScript）のモバイルアプリ — 画面、ナビゲーション、データ取得に加えて、ネイティブ周りの判断を助けるアドバイザー（Expo/EAS/config plugins）付き。 |
| `go-api`         | Go の HTTP API バックエンド — `net/http` と `database/sql` を使った Go らしいサービス。                                                    |
| `python-fastapi` | Python FastAPI + Pydantic v2 — 型を網羅した非同期 HTTP API とバリデーション。                                                              |
| `rails`          | Ruby on Rails — ActiveRecord、設定より規約、Rails スタック一式。                                                                           |
| `django`         | Django + Django REST Framework — ORM、マイグレーション、クラスベースビュー、DRF の API。モデルは厚く、ビューは薄く。                        |
| `debug`          | スタックを問わないバグ調査 — 再現 → 根本原因 → 最小限の修正 → リグレッションテスト。                                                       |
| `research`       | スタックを問わない技術調査 — 選択肢を比較し、推奨案を文書にまとめる。コードは書かない。                                                     |

説明とタグをすべて見るには `ccteams list` を、Claude に選んでもらうには `/ccteams:choose-team <やりたいこと>` を実行してください。

## 1つのプロジェクトに複数のチームを適用する（モノレポを含む）

`ccteams use <team>` は**追加式**です。すでに適用されているチームを置き換えるのではなく、その横に積み増します。プロジェクトに**最初に**適用したチームが**プライマリチーム**になり、そのオーケストレーションルールがプロジェクト全体を統括し、そのリードが唯一のオーケストレーターとして振る舞います。それ以外の適用済みチームは**サポートチーム**で、そのエージェントは委譲先として使える追加の専門家という位置づけです。`ccteams unuse <team>` を実行すれば、他のチームに影響を与えずに1つだけ外せます。プライマリチームを外した場合は、次に適用されたチームがプライマリに繰り上がります。`ccteams current` は適用済みチームを適用順にすべて表示し、プライマリには印が付きます。

よくある使い方は、スタック専用のチーム（たとえば `go-api`）をプライマリとして適用し、同じプロジェクトの UI 作業のために `frontend` を追加で適用するというものです。どちらのチームのエージェントも失われません。

ただし `.claude/agents/` に置かれたサブエージェントは**プロジェクト全体で有効**で、サブディレクトリ単位に絞ることはできません。たとえば `next-ts` チームを `apps/web/` だけ、`go-api` を `apps/api/` だけで有効にして互いに隔離する、といった使い分けはできません。

**モノレポでの回避策:** いま実際に触っている領域に合うチームを適用してください。Claude Code は編集対象のファイルまでのパス上にある `CLAUDE.md` を読み込むので、作業中のサブディレクトリから `claude` を起動すれば、そのサブツリーの `CLAUDE.md` がコンテキストに入ります。ただし、適用済みチームのエージェントはリポジトリ全体で使える状態のままです。

## 重要: セッションの再起動が必要

`ccteams use`、`ccteams unuse`、`/ccteams:use-team`、`/ccteams:unuse-team`、`/ccteams:choose-team` を実行したあとは、変更を読み込ませるために **Claude Code を再起動する必要があります**。エージェントはセッションの開始時に生成されるもので、セッションの途中では生成されません。

**再起動の方法:** `/exit` と入力し（または Claude Code を閉じ）、新しいセッションを開始してください。

## チームがプロジェクトに適用される仕組み

`ccteams use <team>` または `/ccteams:use-team <team>` でチームを適用すると、次のことが起こります。

1. チームのエージェント定義が `.claude/agents/` にコピーされます。
2. チームのスキルが `.claude/skills/` にコピーされます。共有の `working-method` スキル（後述）はどのチームにも付属し、そのチームが宣言している固有のスキルも一緒にコピーされます。
3. `.claude/skills/team-lessons/` スキルが雛形として配置されます（`SKILL.md`、`AUTHORING.md`、`scripts/gen-lessons.mjs`、`scripts/lessons-index.mjs`、`scripts/template-version.mjs`、`lessons/.gitkeep`）。各ファイルは**存在しない場合にのみ**書き込まれます。すでにあるものはそのままの内容で残り、マニフェストに記録されることも削除されることも一切ありません。このスキルは、チームの適用・削除・再適用やパッケージの更新をまたいで残ります。あなたの lesson — `SKILL.md` と `lessons/**` — が書き換えられることは、何をしても決してありません（lesson とは、ここでは教訓1件のことです）。ccteams がその隣に置くツール類（`AUTHORING.md` と `scripts/**`）は、あとから `ccteams migrate` で最新にできます — [プロジェクトを最新に保つ](#プロジェクトを最新に保つccteams-migrate) を参照してください。（`team-lessons` という名前は予約されており、チームがこの名前でスキルを配布することはできません。）詳しくは [team-lessons スキル](#team-lessons-スキル) を参照してください。
4. チームのオーケストレーションルールが `.claude/ccteams/<team-name>.md` にコピーされます。
5. 生成物である複合ファイル `.claude/active-team.md` が（再）作成されます。ここには現在適用されているチームが適用順に並び（先頭がプライマリ）、各チームの `.claude/ccteams/<team-name>.md` が import されます。
6. プロジェクトの `.claude/CLAUDE.md` に import 文（`@.claude/active-team.md`）が1行追加されます（すでにあれば追加しません）。この行は、チームが増えても減っても変わりません。
7. `.claude/.ccteams-manifest.json` が書き込まれ、どのチームがどの順で適用され、それぞれがどのファイルを置いたかを記録します。これにより、あとから1つのチームを外すときに、他の適用済みチームのファイルに触れずに済みます。記録されるパスはすべてプロジェクト内に限定されます。プロジェクトルートの外を指すことになるエントリは、マニフェストを書き込む時点で除外され、ファイルを操作するあらゆる処理からも無視されます。マニフェストに載ったものを削除する `ccteams unuse` も同様です。したがって、マニフェストがどれだけ壊れていても、手で書き換えられていても、これらの処理がプロジェクトの外のパスを対象にすることはありません。はっきり書いておきたい制限が2つあります。1つは、確認するのはパスそのものであって、最終的に何を指すかではないことです（`.claude/` の下に置かれたシンボリックリンクは内側として扱われます）。もう1つは、`ccteams current` のファイル数のような単なる情報表示は、マニフェストに保存されているとおりに報告することです。書き込み時の除外は、あえて何も知らせずに行われます。`ccteams migrate` がマニフェストを書き込むのは実際に実行したときだけなので、ここで警告を出すと、`--dry-run` のプレビューでは構造上出せない警告を、実際に実行したときだけ表示することになってしまうためです。
8. `--agent-teams` を付けた場合（またはチームが `"requiresAgentTeams": true` で自ら有効化している場合）、`.claude/settings.json` に `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` が設定されます。この設定は、必要とする適用済みチームが1つでもある限り残り、どのチームも必要としなくなった時点で自動的に削除されます。

すでに適用済みのチームに対してもう一度 `ccteams use <team>` を実行すると、その場で**再適用**され（ファイルが更新され）、順序もプライマリかどうかも変わりません。

`ccteams unuse <team>` は適用済みチームを1つ外します。そのファイルは削除されますが、まだ適用されている別のチームも同じファイルを所有している場合は**削除されません**（たとえば共有の `working-method` スキルは、必要とするチームが1つでも残っていれば消えません）。`.claude/active-team.md` は残ったチームの内容で再生成されます。最後の1チームを外したときは、ccteams が `.claude/active-team.md` を削除し、`CLAUDE.md` から `@.claude/active-team.md` の import 行を取り除き、マニフェストも削除します。`team-lessons` と、ccteams 自身が書き込んだものではない `.claude/settings.json` のキーには、決して手を触れません。

ccteams には**衝突ガード**があります。ディスク上にはあるものの、現在適用されているどの ccteams チームも置いていないファイル — つまり、あなたが手で書いたファイルがあるとします。これから適用するチームのエージェントやスキルのファイル名がそれと重なる場合、ccteams は適用を拒否します。これにより、うっかり上書きしてしまうのを防ぎます。別の適用済み ccteams チームが所有しているファイルは、共有しても問題ありません。

## working-method スキル

どのチームも `.claude/skills/working-method/SKILL.md` をインストールします。これはフロンティアモデルの作業規律をまとめたもので、ゴールを一文に絞り込むこと、意見より先に事実を確かめること、仮説の扱い方、実行を証拠とすること、正直な報告、そして終了時のチェックリストが含まれます。目的はモデルの階層差を埋めることです。上位モデルの出力を良くしている要素の多くは規律と検証です。これらは、小さいモデルでも指示として与えれば守れます。

届け方は2つあります。

- **常に有効:** どのチームのオーケストレーションルール（`.claude/active-team.md` に import され、常にコンテキストにあります）も、委譲プロンプトごとに working method の6項目ダイジェストを差し込むようオーケストレーターに指示します。そのため、モデルが何であれ、すべてのサブエージェントに届きます。
- **必要なときに:** より深く知りたいときは、オーケストレーターでも各エージェントでも、スキルファイル全体を読めます。

このファイルは ccteams が配置するものなので、これを含むチームに対して `ccteams use` を再実行すると、ローカルの編集は上書きされます。削除されるのは、どの適用済みチームもこのファイルを必要としなくなったときだけです（上の `ccteams unuse` を参照）。恒久的にカスタマイズしたい場合は、内容を別名のスキルにコピーしてください。

## チームの playbook

共有の working method に加えて、どのチームも独自の `<team>-playbook` スキルを同梱しています（`.claude/skills/<team>-playbook/SKILL.md` にインストールされます）。working method がスタックを問わない規律であるのに対し、playbook はドメインの専門知識です。そのスタックでの調査手順の正確な順番、中位モデルが実際に犯している10〜15個の失敗、繰り返し出てくる不確かさを低コストで決着させる実験、そして検証と呼べる具体的なコマンドが書かれています。サブエージェントに確実に届くよう、届け方は3層になっています。各エージェントのシステムプロンプトは、「FIRST ACTION: playbook を読むこと」という指示と、絶対に外せない最低条件をその場に書き下したものから始まります。オーケストレーションルールは、委譲プロンプトを必ず playbook を読む指示で始めるよう求めます。そのうえで、スキルファイル全体もいつでも読めます。

playbook は生きた文書です。working method には学習ループがあり、playbook が予測していなかった失敗が出てくるたびに、新しい失敗カタログの項目（症状 → 誤った直感 → 正しい打ち手）を起草してあなたに提案するよう、オーケストレーターに指示します。採用された lesson には、その適用範囲によって2つの置き場所があります。

- **プロジェクト固有の lesson** は `.claude/skills/team-lessons/` スキルに入ります。そこにある `SKILL.md` と `lessons/**` はあなただけのもので、決して書き換えられません。このスキルは、チームの適用・削除・再適用やパッケージの更新をまたいで残り、オーケストレーターはその項目を playbook のルールと並べて委譲プロンプトに差し込みます。（playbook のコピー自体に lesson を書いてはいけません。あれは `ccteams use` のたびに置き換えられます。）
- **普遍的な lesson** — そのスタックならどのプロジェクトでも成り立つもの — はアップストリームに置くべきです。このリポジトリの該当チームの playbook に対して PR を出してください。次のリリースで、すべての利用者のチームが同じ失敗への免疫を得られます。

## team-lessons スキル

`.claude/skills/team-lessons/` は、学習ループで採用された項目の置き場所です。次の6ファイルが雛形として配置されます。

```
.claude/skills/team-lessons/
├── SKILL.md                     # あなたのもの — 生成される索引。lesson 1件につき短い項目1つ
├── AUTHORING.md                 # ccteams のもの — frontmatter のスキーマと項目の追加方法
├── lessons/                     # あなたのもの — lesson 1件につき1ファイル: NN-slug.md
└── scripts/                     # ccteams のもの
    ├── gen-lessons.mjs          # lesson の frontmatter から索引を組み立てる
    ├── lessons-index.mjs        # Claude Code のフックに渡す索引を出力する（後述）
    └── template-version.mjs     # 手元にあるツール類の世代（migrate を参照）
```

**どれが誰のものか。** `SKILL.md` と `lessons/**` はあなたのものです。このプロジェクトが積み上げた知識が入っており、ccteams はどのコマンド・どのフラグでも、これらを決して書き換えず、上書きせず、削除しません。`AUTHORING.md` と `scripts/**` は ccteams 自身の執筆ルールとツールの実装であって、あなたが書く中身ではありません。だからこそ、新しい ccteams がこれらを直したり拡張したりしたときに、`ccteams migrate` で最新にできます。あなたが*実際に編集した*コピーをどう保護するかも含め、詳しい仕組みは [プロジェクトを最新に保つ](#プロジェクトを最新に保つccteams-migrate) を参照してください。

**なぜ分けているのか。** 1ファイルのカタログは際限なく大きくなり、カタログを参照するたびにファイル全体がコンテキストに読み込まれます。つまり、今日は誰も必要としない古い lesson が、毎回のタスクでトークンを消費します。分ければ、常時読み込まれるコストを lesson 1件あたり数行（`applies_when → symptom → correct move` と詳細ファイルへのリンク）に抑えられます。さらに `AUTHORING.md` を読み込み経路から完全に外せます。これを読むのは lesson を書くときであって、lesson を適用するときではありません。

**なぜ索引を生成するのか。** 手書きの索引は、lesson を追加したり、採番し直したり、書き換えたりした瞬間にズレます。そして古い索引は、エージェントを間違った lesson に導くか、lesson の存在自体を隠してしまいます。`scripts/gen-lessons.mjs` は各 lesson 自身の frontmatter（`applies_when` / `symptom` / `summary`）から索引を導き出すので、手で同期を保つものは何もありません。

```bash
# 索引を再生成する（lesson を追加・編集したら実行し、結果をコミットする）
node .claude/skills/team-lessons/scripts/gen-lessons.mjs

# コミット済みの索引が lessons/ と一致するか検証する — ズレていれば終了コード1。CI に組み込むとよい
node .claude/skills/team-lessons/scripts/gen-lessons.mjs --check
```

索引を必要に応じて生成するのではなくコミットしているのは、エージェントが読むのはリポジトリであって、ビルド成果物ではないからです。コミットされた生成ファイルを正しく保つ役目は `--check` が担い、`<!-- team-lessons:catalog:* -->` マーカーの間を手で編集した場合も検出します。スクリプトは依存関係ゼロの素の Node ESM なので、言語やパッケージマネージャーを問わず、Node が入っているプロジェクトならどこでも動きます。

> [!IMPORTANT]
> **prettier との互換性。** プロジェクトで `.claude/**` に prettier をかけている場合、生成される `SKILL.md` の索引が、あなたの prettier 設定の*不動点*（prettier をかけても内容が変わらない状態）である必要があります。そうでないと `prettier --write` と `gen-lessons.mjs --check` が互いの出力を書き換え合い、どちらも永久にグリーンになりません（このツール類の v9 で解消したデッドロックです。Issue [#68](https://github.com/rinjugatla/ccteams/issues/68)）。prettier 3.8.3 で確認しています。
>
> | prettier の設定 | 対応 | 挙動 |
> | --- | --- | --- |
> | 既定の設定 | ✅ | 生成された索引がバイト単位でそのまま戻る |
> | `--use-tabs` | ✅ | prettier の Markdown プリンタは、どちらの設定でもリストのインデントをスペースで出力する |
> | `--print-width <any>`（単独） | ✅ | `proseWrap` の既定は `preserve` なので、幅だけでは索引が折り返されない |
> | `--end-of-line crlf` | ✅ | ディスク上のファイルは CRLF になるが、`--check` は比較の前に CRLF を正規化する |
> | `--prose-wrap never` | ✅ | 結合されるのはカタログのマーカーの*外*にある手書きの文章だけで、`--check` は生成されたブロックだけを比べる |
> | `--prose-wrap always` | ❌ | `printWidth` を超えた索引の行が折り返され、`--check` が永久に失敗する |
> | `--tab-width` が 2 以外 | ❌ | 入れ子リストのインデント（1桁の `N.` の下の3スペース）が付け直され、`--check` が永久に失敗する |
>
> **未対応の設定への回避策**: 生成された索引を `.prettierignore` に追加して、prettier の対象から外してください。
>
> ```
> .claude/skills/team-lessons/SKILL.md
> ```
>
> こうすれば prettier は索引に手を触れず、`--check` はそのまま動き続けます。さらに2点だけ注意してください。(1) lesson の `id` は連番のまま詰めておくこと。prettier は順序付きリストの番号を振り直すので、lesson を削除するなどして番号が飛ぶと、*どの* prettier 設定でも、採番し直すまで `--check` が失敗し続けます（生成側で対応する件は [#69](https://github.com/rinjugatla/ccteams/issues/69) で追跡しています）。(2) lesson の `applies_when` / `symptom` / `summary` の中で、単独の `*` や `*強調*` を使わないこと。prettier が索引の中でそれを書き換えてしまいます（`` `.claude/**` `` のようなコードスパンは安全です。詳しくは `AUTHORING.md` の注意書きを参照してください）。

**フックでカタログを注入する。** カタログが参照されるのは、エージェントが `SKILL.md` を開くと判断したときだけです。`scripts/lessons-index.mjs` はカタログ本体を標準出力に書き出すので（lesson が1件もなければ何も出しません）、これを Claude Code のフックに組み込めば、すべてのセッションとすべてのサブエージェントのコンテキストに無条件で入ります。`.claude/settings.json` に次のように書きます。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/skills/team-lessons/scripts/lessons-index.mjs"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/skills/team-lessons/scripts/lessons-index.mjs"
          }
        ]
      }
    ]
  }
}
```

`SessionStart` と `SubagentStart` の両方が必要です。`SessionStart` はメインのセッションでしか発火せず、サブエージェントでは発火しません。そしてカタログを最も必要とするのはサブエージェントです（実際に作業をするのはサブエージェントで、自分から `SKILL.md` を開いてくれるとは限りません）。つまり `SessionStart` だけでは目的を果たせません。この登録を ccteams が代わりに書き込むことはありません。フックはセッションのたびに任意のコマンドを実行させるものであり、ccteams が自分で書いていない `.claude/settings.json` のキーには触れないという原則はここにも当てはまります。だからこの登録を追加するのは、あなた自身が意識して行う明示的な操作になります。

**lesson はプロジェクト自身の言語で書きます** — README で使っている言語です。そうすればカタログがリポジトリの他の部分と地続きに読め、外国語の付録のようにはなりません。frontmatter のキーとファイル名の slug は、言語にかかわらず ASCII のままにします。雛形として配置される `AUTHORING.md` にも、lesson を書く人が実際に目にする場所としてこのルールが書かれています。

**古い1ファイル構成からの移行。** この構成より前の `SKILL.md` を使っていて、lesson が本文中に直接書かれている場合、`ccteams use` はそのファイルをそのままの内容で残し、不足している部分（`AUTHORING.md`、`lessons/`、`scripts/`）だけを追加して、注記を表示します。移行の手順は雛形の `AUTHORING.md` にあります。

## プロジェクトを最新に保つ（`ccteams migrate`）

CLI を入れ直すと（`npm install -g https://github.com/rinjugatla/ccteams.git`。[インストール](#インストール) を参照）、グローバルにインストールされた CLI は新しくなります。しかし、入れ直しても、ccteams がすでにプロジェクトへ置いたファイルには**手を触れません**。それらが変わるのは、`ccteams use`、`ccteams unuse`、`ccteams migrate` を実行したときだけです。`ccteams migrate` は、ccteams が自分の判断で追加・更新しても安全な範囲について、このすき間を埋めます。

```bash
ccteams migrate                # 不足ファイルを追加し、ccteams 側で変わったファイルを更新し、あなたにしか解決できないズレを報告する
ccteams migrate --dry-run      # プレビューのみ。何も書き込まない。確認なしで追加・更新される対象があれば終了コード1
ccteams migrate --yes          # 対話的な確認を省略。それでも、あなたが編集したファイルには手を触れない
ccteams migrate --yes --force  # あなたが編集したファイル（やベースラインが不明なファイル）も、確認なしで上書きする
```

- **現時点でできること:** 次の6つです。作業の成果を失いかねない操作が、あなたの了解なしに起きないよう段階を分けてあります。
  1. `.claude/skills/team-lessons/` の中の **ccteams 所有のファイルを更新します** — `AUTHORING.md` と `scripts/**`（`gen-lessons.mjs`、`lessons-index.mjs`、`template-version.mjs`）です。あなたの `SKILL.md` と `lessons/**` は、*このステップ*では**決して**読まれず、書かれず、報告もされません。`lessons/**` の frontmatter を読む唯一の箇所は後述のステップ4で、そこでも書き込みはしません。古い ccteams はすべての lesson を `SKILL.md` そのものに保存していました。それを上書きすれば、このスキルが守ろうとしている知識をまさに壊してしまいます。判断の仕組みは次のとおりです。
     - `scripts/template-version.mjs` は**世代番号**を持っています。これは単なる整数で、ccteams 所有の team-lessons ファイルが実際に変わったときにだけ上がります。パッケージのバージョンとはあえて連動させていません（連動させると、リリースのたびに意味もなくこれらのファイルを書き換えることになるからです）。ccteams はプロジェクト側の番号と自分が持つ番号を比べます。同じなら何も起きません。低ければファイルが最新化されます。高い場合（ccteams をダウングレードしたときです）は何も変更せず、もう一度アップグレードするよう促す注記を表示します。
     - このマーカーが存在するより**前**に導入されたプロジェクトには、読むべき番号がありません。その場合 ccteams は、ファイルの内容から世代を特定します。まず、出荷してきた全バージョンの台帳と照合します。フォーマッタで整形し直されたコピーについては、フォーマッタも利用者も取り除かないであろう機能マーカーを、生成スクリプトの中に探します。
     - 出荷したままのバージョンだと確認できなかったファイル（実際に編集された場合も、外からは同じに見える再フォーマットの場合もあります）は、**手を触れず、報告だけします**。黙って上書きすることはありません。注記にはフォーマッタの場合のことも書いてあります。差分が整形だけなら `ccteams migrate --yes --force` で安全に更新でき、そのあとフォーマッタを流し直せばプロジェクトのスタイルに戻せます。あるいはターミナルで `ccteams migrate` を実行し、ファイルごとに判断することもできます。
  2. 雛形として配置される `.claude/skills/team-lessons/` スキル（前述）から欠けているファイルを**追加します**。これは `ccteams use` が実行するのと同じ、決して上書きしない雛形配置です。そのため、しばらく前に `ccteams use` を実行しただけのプロジェクトでも、新しい ccteams がこのスキルに追加したファイル（新しいスクリプトなど）を、チームを再適用せずに取り込めます。
  3. 既存の `.claude/skills/team-lessons/SKILL.md` のカタログ索引が古い形式のときに**報告します**。使えるマーカーの対が無い（そもそも無い、または終了マーカーが先にある）場合か、自動生成である旨の注記がマーカーの内側に残ったままの場合です。このファイルはあなたのものなので、ccteams は実行すべきコマンド（`gen-lessons.mjs`。マーカーが無い場合は、先に追加すべきマーカーも）を表示するだけで、ファイル自体は決して書き換えません。
  4. `.claude/skills/team-lessons/lessons/` にある lesson のうち、frontmatter に使える `applies_when` が無いものを**報告します**。このために `lessons/**` を読みますが、書き込みはしません。ccteams がこの値を自分で書くことはできません（lesson の内容を要約する必要があり、それこそ `applies_when` が記録しようとしている判断そのものだからです）。そこで該当ファイルを列挙し、frontmatter のスキーマについては雛形の `AUTHORING.md` を、実際の記入については Claude Code に頼むことを案内し、そのあと再生成コマンド（`gen-lessons.mjs`）を実行するよう促します。frontmatter をそもそも解析できない lesson（先頭に `---` ブロックが無い、または読み取れない）は、別枠で報告されます。索引を再生成する前に、手で直す必要があるからです。どちらの場合も、`ccteams migrate` の残りの処理を中断させることはありません。
  5. カタログ注入用のフック（前述の [team-lessons スキル](#team-lessons-スキル) の「フックでカタログを注入する」を参照）が、`.claude/settings.json` に `SessionStart` と `SubagentStart` の両方について登録されているかを**報告します**。片方だけ登録してもすき間が残るので、それぞれ個別に確認して報告します。フックはセッションのたびに任意のコマンドを実行するものなので、ccteams がこの登録を代わりに書き込むことは決してありません。足りないものがあれば、そのイベント用の、コピーして貼り付けられる JSON 断片を表示します。両方が登録されれば、`ccteams migrate` はこれについて何も言わなくなります。
  6. **ccteams 所有のファイルを突き合わせます** — エージェント定義（`.claude/agents/*.md`）、各チームの playbook スキル（`.claude/skills/<team>-playbook/`）、共有の `.claude/skills/working-method/` スキルを、いま入っている ccteams パッケージが今日置くであろう内容と比べます。各ファイルは、3つのものを比べて分類されます。パッケージの現在のソース、プロジェクトの現在の内容、そして ccteams がそのファイルを置いたときにベースラインとして記録したハッシュです。
     - **変更なし**（あなたのコピーがパッケージと一致している）: することは何もなく、報告もされません。
     - **アップストリーム側の変更**（あなたのコピーは記録されたベースラインと一致し、パッケージ側のファイルだけが先に進んでいる）: 確認なしで自動的に更新されます。あなたは一度も触っていないからです。
     - **利用者による変更**（あなたのコピーが記録されたベースラインと一致しない）: 既定では手を触れません。上書きしたい場合は `ccteams migrate --yes --force` を使うか、ターミナルで実行して対話的なプロンプト（`[y] overwrite [n] keep mine [d] show diff [a] overwrite all [q] quit`）に答えてください。
     - **ベースライン不明**（そのファイルのベースラインハッシュが一度も記録されていない。たとえばプロジェクトのマニフェストがこの機能より古い場合）: 既定の扱いは同じ（手を触れない）ですが、比べるべきベースラインが記録されていない以上、あなたの編集とアップストリームの更新を区別できないことを ccteams は明示します。

     マニフェストにはまだ載っているのに、パッケージ側がソースを見つけられなくなったファイル（チームの改名や削除など）は、手を触れずに報告されます。決して削除しません。`.claude/skills/team-lessons/` の下にあるものは、*このステップ*の対象外です。`team-lessons` スキルはマニフェストに記録されないため、上のステップ1が独自のルールで丸ごと扱います。

- **`--yes` と `--force` の違い:** `--yes` だけを付けた場合、確認プロンプトは省略されますが、自動で適用されるのは、あなたが一度も触っていないと ccteams が確認できたファイルだけです（アップストリーム側が変更されたファイルか、内容が ccteams の出荷したバージョンと一致する team-lessons のテンプレートファイル）。あなたが変更したファイル、ベースラインが不明なファイル、確認のとれないテンプレートファイルについては、これは意図的な設計で、決して上書きしません。無人の CI 実行が、あなたの編集を黙って捨ててしまうことがないようにするためです。`--force` は `--yes` と併用したときにだけ効きます（単独で実行するとエラーになります）。これらのファイルの上書きまで追加で許可するのが `--force` の役目です。
- **非対話の環境（CI、パイプで渡された標準入力）では、プロンプトを出しません。** `--yes` が無い場合、判断が必要なファイルは単に手を触れず、報告されるだけです。`ccteams migrate` が、得られない入力を待って止まることはありません。
- **何も削除されません。** `.claude/skills/team-lessons/` の中でも、あなたの lesson — `SKILL.md` と `lessons/` 以下のすべて — は、フラグの組み合わせが何であれ、`ccteams migrate` によって書き換えられることも、上書きされることも、削除されることもありません。その隣に ccteams が置くツール類（`AUTHORING.md`、`scripts/**`）は、上のステップ1の条件で更新*され得ます*。黙って更新されるのは、あなたのコピーが ccteams の出荷したバージョンそのままだと確認できた場合だけで、それ以外は `--yes --force` を付けるか、プロンプトであなたが答えた場合に限られます。
- **`--dry-run` は何も書き込まず**、追加・更新の対象になるものを列挙します。確認なしで追加・更新されるファイル（欠けているファイル、アップストリーム側が変更されたファイル、内容が出荷したままだと ccteams が確認できた team-lessons のテンプレートファイル）がある場合は終了コード `1` で終了し、それ以外は `0` で終了します（そのため `gen-lessons.mjs --check` と同じように、CI のズレ検出に組み込めます。前述参照）。**注記や、あなたの判断待ちでスキップされたファイルは、終了コードに影響しません。** `SKILL.md` についての注記や、あなたが変更したために手を触れなかったファイルについての注記で終わる報告でも、終了コードは `0` です。終了コードだけでなく、まとめの行を読んでください。
- **worktree ではなく、プロジェクトのメインチェックアウトで実行してください。** ccteams は `.claude/` に書き込みますが、git worktree の `.claude/` は通常、追跡されないローカルの状態であり、worktree を削除すると失われます。そのため、worktree の中で `migrate` を実行しても、変更はリポジトリに残りません。
- 現在のプロジェクトに ccteams が適用されていない場合（`.claude/.ccteams-manifest.json` が無い場合）、`ccteams migrate` は何もせずに終了コード `0` で終了し、代わりに `ccteams use <team>` を案内します。
- **マニフェスト v4 と古い ccteams:** 上の突き合わせにはファイルごとのベースラインハッシュが必要なので、マニフェストの形式は v4 になりました（`.claude/.ccteams-manifest.json` の `"version": "4"`）。次に `ccteams use` か `ccteams migrate` を実行したときに自動で書き込まれます。マニフェストがまだ v3 以前のプロジェクトも、現在の ccteams で問題なく動きます（ベースラインハッシュが記録されるまでは、上の「ベースライン不明」の扱いに落ちるだけです）。ただし逆は成り立ちません。v4 より前の ccteams CLI は v4 のマニフェストを読めず、チームが1つも適用されていないものとして扱います。その結果、ccteams が置いたファイルすべてが予期しない「手書きファイル」に見えて衝突ガードに引っかかり、`ccteams use` は何も書き込まないまま中断します。チームで ccteams のバージョンを固定している場合は、一部のマシンだけ v4 より前の CLI で v4 マニフェストのプロジェクトを触ることがないよう、全員まとめて上げてください。
- **1台につき ccteams は1バージョンに揃えてください。** 古い `ccteams` と新しい `ccteams` のバイナリを行き来しないでください。グローバルに一度だけインストールしておけば、プロジェクトのマニフェストとそれを読む CLI が食い違うことはありません。これを書いている時点では、npm に公開されている `ccteams` パッケージは v4 に対応しておらず、v4 のマニフェストを読めません。v4 に対応した CLI はこのリポジトリから入ります（`npm install -g https://github.com/rinjugatla/ccteams.git`。[インストール](#インストール) を参照。クローンして作業する場合は `npm install -g .` でも構いません）。上で説明した中断に遭遇したら、CLI を上げてください。古い CLI に合わせてマニフェストが下げられることはありません。

## エージェントごとのモデルプリセット

同梱されているエージェントは、どれも frontmatter に `model:` が設定されています。役割にどれだけの推論が必要かで割り当てています。

- **`opus`** — 計画、設計、レビュー、調査の役割（scope-planner、architect、すべての `*-reviewer` エージェント、アドバイザー、researcher）。
- **`sonnet`** — 機械的な実装の役割（すべての `*-builder` エージェントと shipper）。

リードとなるセッション自身のモデルは、ccteams では設定しません。Claude Code の `/model` で選んでください。よくある構成は、上位モデルのオーケストレーター（たとえば Fable 5）が、これらの Opus / Sonnet のサブエージェントに委譲するというものです。こうすれば、高価なモデルは計画と統合だけを担い、実作業は安いモデルが受け持ちます。

**プリセットを変える。** `model:` の行はエージェントの frontmatter にすぎません。`.claude/agents/*.md` を編集すれば、指定し直せます（`opus`、`sonnet`、`haiku`、または完全なモデル ID）。行を削除すれば、そのエージェントはセッションのモデルを引き継ぎます。契約プランに Opus が含まれていない場合は、`opus` のエージェントを使えるモデルに指定し直すか、行を削除してセッションのモデルにフォールバックさせてください。

## `.claude/` をコミットするかどうか — あなた次第

選択肢は2つあります。

**選択肢A（チームを共有する）:** `.claude/agents/`、`.claude/ccteams/`、`.claude/active-team.md`、`.claude/.ccteams-manifest.json` を git にコミットします。リポジトリを取得した同僚の環境でも、同じチームが自動的に適用された状態になります。

**選択肢B（チームをローカルに留める）:** `.claude/agents/`、`.claude/ccteams/`、`.claude/active-team.md`、`.claude/.ccteams-manifest.json` を `.gitignore` に追加します。開発者それぞれが `ccteams use` をローカルで実行し、好みのチームを適用できます。

**おすすめ:** チーム構成をそろえることに意味があるプロジェクト（コードスタイルの統一や QA エージェントの必須化など）なら、コミットしてください。そうでなければローカルに留めるのがよいでしょう。

## チームをコントリビュートする

ccteams が適用するのは、このリポジトリの `teams/` ディレクトリに同梱されたチームです。新しいチームを追加したい場合は、ここにコントリビュートしてください（PR を出してください）。利用者のローカルに別のチームレジストリがあるわけではありません。チームは `teams/<name>/` に置きます。

```
teams/<name>/
├── team.json               # メタデータ: 名前、説明、タグ、任意のフラグ
├── orchestration.md        # import される CLAUDE.md 用のルール（役割・目標・振る舞いを定義する）
├── agents/
│   ├── agent1.md           # YAML frontmatter + エージェントのシステムプロンプト
│   ├── agent2.md
│   └── ...
└── skills/                 # 任意: チーム固有のスキル
    └── my-skill/
        └── SKILL.md
```

### `team.json` のスキーマ

```json
{
  "name": "my-team",
  "description": "A short pitch of what this team does",
  "tags": ["backend", "api", "performance"],
  "requiresAgentTeams": false,
  "skills": ["my-skill"]
}
```

エージェント間のメッセージングや、協調型のメンバー機能を使うチームであれば、`"requiresAgentTeams": true` を設定してください。

`skills` は任意です。各名前は、まずそのチーム自身の `skills/<name>/` として解決され、無ければリポジトリ直下の `shared/skills/<name>/` にフォールバックします。共有の `working-method` スキルはどのチームにも自動的に配置されるので、書き並べる必要はありません。

### エージェントファイル（`.md`）

各エージェントファイルは、標準的な Claude Code のサブエージェントです。YAML frontmatter（`name`、`description`、任意で `tools`）に続けて、システムプロンプトを書きます。

```markdown
---
name: my-agent
description: Backend API specialist. Use for building and reviewing REST/GraphQL endpoints, data layers, and integrations.
tools: Read, Write, Edit, Bash, Glob, Grep, Skill
---

You are a Python backend expert. Your job is to...
```

`description` は、このエージェントに委譲すべきかどうかを Claude が判断する材料になるので、具体的に書いてください。`tools` を明示するときは `Skill` を含めてください。そうすればエージェントは自分が使えるスキルを把握でき、状況に応じて自分の判断で呼び出せます。`tools` を丸ごと省略すれば、使えるツールをすべて引き継ぎます。

そのまま参考にできる例としては、`teams/next-ts/`（スタック専用のチーム）と `teams/debug/`（スタックを問わないチーム）を見てください。builder + reviewer の形を知るには、`next-ts/` がいちばんきれいな見本です。

### オーケストレーション型と協調型のチーム

現在同梱されているチームは、すべて**オーケストレーション型**です。1人のリードが専門のサブエージェントに委譲し、サブエージェントはそれぞれ独立に報告を返します。単純で予測しやすい、既定の形です。

ccteams は**協調型**のチーム（サブエージェント同士が直接メッセージをやり取りする形）にも対応しています。Claude Code の実験的な agent-teams 機能（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）を使います。ccteams がこの環境変数キーを `.claude/settings.json` に書き込むのは、次の2つの場合です。

- チームが `team.json` で `"requiresAgentTeams": true` を宣言している場合。適用すると、agent-teams モードが自動的に有効になります。
- `ccteams use` に `--agent-teams` フラグを渡した場合。そのプロジェクトに限り、任意のチームを agent-teams モードにできます。

  ```bash
  ccteams use <team> --agent-teams
  ```

  フラグの位置は問わないので、`ccteams use --agent-teams <team>` でも動きます。

どちらの経路で環境変数キーを追加した場合でも、それを必要とする適用済みチームが無くなった時点で、ccteams はキーを削除します。必要としていたチームに `ccteams unuse` を実行した場合も、残った適用済みチームがすべて通常のオーケストレーション型で動く場合も同じです。既定で同梱される協調型チームはありませんが、フォーマットとしては作成に対応しています。

## 開発とローカルでの動作確認

### プラグインをローカルで試す（そのセッションのみ）

```bash
claude --plugin-dir ./plugins/ccteams
```

現在のセッションでだけプラグインを読み込みます。恒久的なインストールはしません。開発時に便利です。

### CLI をローカルで試す

```bash
npm install -g .
ccteams list
```

リポジトリの現在のソースから CLI をインストールします。

### テストスイートを実行する

```bash
npm test
```

`package.json` の `test` スクリプトに列挙されたテストファイルを、`node --test` で実行します。この一覧はグロブではなく明示的な列挙なので、新しいテストファイルを作っただけでは何も実行されません。そこにも追記する必要があります。インストールする依存関係はありません。テストスイートが使うのは `node:test` と `node:assert` だけで、パッケージの依存関係ゼロの方針に合わせてあります。対象は、team-lessons の索引生成、注入用にカタログを取り出すフックスクリプト、team-lessons の雛形配置が守る「決して上書きしない」という契約、マニフェストの v4 スキーマ（と v1〜v3 の正規化）、`ccteams use` と `ccteams migrate` の両方が使う `placedFiles` の src→dest 解決、そして `ccteams migrate` と `ccteams migrate --dry-run` です。最後の2つについては、CLI 経由での結合テスト、`ccteams use` と共通する team-lessons の雛形配置とフック検出の挙動、さらに（`test/migrate-owned-files.test.mjs` で）ccteams 所有ファイルの突き合わせが含まれます。突き合わせについては、変更なし／アップストリーム側の変更／利用者による変更／ベースライン不明の分類、`--yes` と `--force` による制御、対話プロンプトの流れ（`y`／`n`／`a`／`q`／不正な入力／EOF）、非 TTY での安全性、ベースラインハッシュの記録、そしてこのステップから `team-lessons` スキルが構造的に除外されていることを確認します。`test/migrate-team-lessons-template.test.mjs` は、team-lessons のテンプレート分離を対象にします。世代マーカー、出荷済みハッシュの台帳とメンテナ向けの不変条件（台帳の最後のエントリは `scaffold/team-lessons/` と完全に一致すること、`template-version.mjs` はそのエントリのバージョンと一致すること）、再フォーマットされた古いコピーに対する機能シグネチャによるフォールバック、世代を確認する前にマーカーが置かれないようにするステップの順序、そしてその間ずっと `SKILL.md` と `lessons/**` がバイト単位で変わらないという保証を確認します。`test/migrate-applies-when.test.mjs` は、`lessons/**` の `applies_when` を助言的に走査する処理を対象にします。`applies_when` が無い（または空、あるいは配列記法の）ファイルは `AUTHORING.md` と再生成コマンドの案内と並べて1件ずつ名前が挙がること、frontmatter ブロックを解析できないファイルは `applies_when` 欠落ではなく読み取り不能として報告されること、壊れた lesson（`id` が不正、`symptom` が空）が `migrate()` の残りの処理を中断させないこと、`--dry-run` と実際の実行が同じ注記を出し、終了コードを動かさないこと、そしてこのステップが何も追加も更新もしないことを確認します。

## 翻訳について

正本は [`README.md`](./README.md) で、この `README.ja.md` はその翻訳です。`README.md` を変更する PR では、原則として同じ PR で `README.ja.md` も更新してください。同時に更新するのが難しい場合は、翻訳を追随させるための Issue を立てたうえで、英語版だけを先にマージしても構いません。

## ライセンス

MIT © toffyui, rinjugatla. 全文は [LICENSE](./LICENSE) を参照してください。

## Orynth

ここで投票していただけるとうれしいです！

<a href="https://orynth.dev/projects/rinjugatla-ccteams" target="_blank" rel="noopener">
  <img src="https://orynth.dev/api/badge/rinjugatla-ccteams?theme=light&style=default" alt="Featured on Orynth" width="260" height="80" />
</a>
