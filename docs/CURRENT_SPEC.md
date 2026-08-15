# BubblesNow 現状機能 棚卸し（CURRENT_SPEC）

対象コミット: `936367a`（origin/main 追従時点）
対象ファイル: `index.html`（83KB / 341行）, `add.html`, `recs.html`, `cleanup.html`, `manifest.json`
目的: GitHub移管に先立ち、現行アプリの実装・依存・課題を「読んで記録」する（コード改変なし）。

> 注記: 本書は実物ソースを1行ずつ読んで作成した。設計書 v2 と食い違う点・v2が触れていない点は「⚠️」で明示する。

---

## 0. 全体アーキテクチャ（30秒サマリー）

- **単一HTMLのSPA**。`index.html` に React 18 アプリ全体がインライン（JSXなし、`React.createElement` を `h(...)` で直書きした高密度コード）。ビルド工程なし。
- **状態の永続化はすべて Firebase Realtime Database**（`users/yokota/*`）。Firebaseが使えない環境では `localStorage` にフォールバックする `Storage` 抽象を持つ。
- **画面は2タブ**: 「タスク（バブル表示）」と「おすすめ（recommend）」をヘッダのアイコンで相互に切替。ルーティングライブラリなし（`useState` の `tab` 切替のみ）。
- `add.html` / `recs.html` / `cleanup.html` は index 本体とは独立した**補助ページ**（外部連携・メンテ用）。

---

## 1. 実装されている機能の一覧

### 1-1. 認証（簡易・クライアントのみ）
- `LoginScreen`（index.html:74-75）。ハードコードされた認証情報 `CREDS={user:"yokota",pass:"naoki"}`（index.html:63）と照合するだけ。
- 成功で `localStorage.bn_auth="1"` を保存し、以降はスキップ（`App`、index.html:255-260）。
- ⚠️ サーバー認証ではない。Firebase側は認証なしで読み書き可能（後述4・5）なので、このログインは**UI上の目隠しに過ぎない**。

### 1-2. タスク：表示（バブルUI）
- `TaskApp`（index.html:143-181）が中心。タスクを浮遊する泡（`FloatingBubble`, index.html:105-114）として描画。
- **サイズ = 優先度**。`PS`（🔴最優先2.3 / 🔴期限迫1.8 / 🟡中1.0 / 🟢低0.65、index.html:65）× 基準 `B=100`。
- 共有 `requestAnimationFrame` ループ（`BR`/`regB`/`startL`、index.html:70-73）で全泡を物理演算（ゆらぎ・壁反射・減衰）。
- 各泡にアイコン（`task.icon` or `gIcon()` の絵文字自動判定、index.html:67）、締切バッジ（残り≤15日で表示、≤3日赤点滅）、WIPバッジを重畳。
- **カテゴリフィルタ**: `all` / `soon`（締切≤7日 = `soonT`）＋ 9カテゴリのタブ（index.html:173）。
- **スワイプでフィルタ切替**（左右, index.html:144-155）、タブ横スクロール連動。
- **プルダウンで再読込**（pull-to-refresh, index.html:145-155/174-175）: `db.ref("users/yokota/tasks").once()` で再取得。
- **DONEモード** トグル（index.html:172の`sDM`）: 直近30日以内に完了したタスクを泡表示（`doneRecent`, index.html:165-166）。
- `SizeGuide`（index.html:115）: サイズ＝優先度の凡例と操作ヘルプ。

### 1-3. タスク：追加
- **アプリ内**: `AddTaskModal`（index.html:118-119）。`+`ボタンで開く。`id:"t"+Date.now()`, `status:"active"` を付与して `save()` → Firebase `users/yokota/tasks` に**配列丸ごと `.set()`**。
- **おすすめから追加**: `addFromRec`（index.html:315-319）。recの各フィールドをタスク形に変換し `note:"おすすめから追加"` を付けて追加。`added[]`（コンポーネント状態）に rec.id を積む。
- ⚠️ **外部からの追加は別経路**: `add.html`（後述3-1）は Make.com webhook にPOSTする。**アプリ内追加＝Firebase直書き / add.html＝Make.com経由**という二系統が併存。

### 1-4. タスク：編集
- `TaskDetail`（index.html:116-117）。泡を**シングルタップ**で開く。
- 編集可能フィールド: name, category, priority, deadline, icon（`prompt()`で絵文字入力）, wip, detail, merit, demerit, url, location, note。
- **保存はモーダルを閉じた時に自動**（`asc`）。`JSON.stringify(f)!==元` かつ name非空のときだけ `onUpdate`（`upTask`, index.html:161）で反映。
- url は「開く↗」、location は Googleマップリンク「地図↗」を生成。

### 1-5. タスク：完了
- 泡を**ダブルタップ** → `hDT`（index.html:162）→ `ConfirmCompleteModal`（index.html:76-77、500ms は誤タップ防止で無効）。
- 確定で `complete()`（index.html:156）: `status:"done"`, `completedAt`(ISO) を付与して保存。
- 演出: `BubbleExplosion`（index.html:78-79）＋ ドット文字「DONE」アニメ（`DotDONE`, index.html:80-104）＋ 画面シェイク。
- `TaskDetail` の「✅完了」ボタンからも同じ `complete()`。

### 1-6. タスク：削除 / 復元
- 削除: `TaskDetail` の🗑ボタン → `del()`（index.html:157）で配列から除外して `.set()`。
- 復元: `CompletedPanel` の「戻す」→ `restore()`（index.html:159）で `status:"active"` に戻す。

### 1-7. 完了サマリー
- `CompletedPanel`（index.html:120-142）。📋ボタンで開く。
- **今週（JST・月曜起点）/今月の 追加数・完了数** を集計（index.html:122-129、JSTオフセット手計算）。
- 完了済みタスク一覧（カテゴリ絞り込み・完了日降順）、各行から「戻す」。

### 1-8. おすすめ（Recommendations）
- `RecommendTab`（index.html:209-253）。ヘッダ💡でタブ切替。
- **表示フィルタ**（`visible`, index.html:213）: `dismissed`(ID) にも `added`(ID) にも入らず、既存タスク名と一致せず、`dismissedTitles`（曖昧タイトル一致）にも該当しないものだけ表示。
- 各recに **source バッジ**（gmail/calendar/news/x/instagram/line/trend、index.html:211）、締切≤7日バッジ、URLリンク、location地図リンク。
- `+`で採用（`addFromRec`）、`−`で却下（`dismissRec`, index.html:320）。却下はIDとタイトル(lowercase)の両方を `dismissed` / `dismissedTitles` に永続化。
- **🔄リフレッシュ**（`doRefresh`, index.html:322-328）: Make.com webhook を叩き、3秒後に Firebase を再読込。

### 1-9. その他UI
- ヘッダに**外部アプリのクイックランチャー**（X, LINE, カレンダー`calshow://`, メール`message://`, Chrome`googlechrome://`）。index.html:172 と 218-223。⚠️ `calshow://`等はiOS専用スキームでPC/Androidでは無反応。
- アンビエント背景の光球（装飾）、各種CSSアニメーション（index.html:24-43）。

---

## 2. Firebaseとのやり取り

### 2-1. 接続
- SDK: `firebase-app-compat` / `firebase-database-compat` **v10.14.1**（index.html:15-16、gstatic CDN）。
- 設定: `FIREBASE_CONFIG`（index.html:60）に全キーをハードコード（`apiKey` 含む・後述5）。
- `Storage` 抽象（index.html:62）: `subscribe(path, cb)` は `db.ref(path).on("value")`、`set(path, v)` は `db.ref(path).set(v)`。db初期化失敗時は localStorage にフォールバック。

### 2-2. 読み書きしているパス（すべて `users/yokota/` 配下）

| パス | 読み | 書き | 用途 |
|------|:---:|:---:|------|
| `users/yokota/tasks` | ○ subscribe / once(pull) | ○ set（配列全置換） | タスク本体 |
| `users/yokota/recommendations` | ○ subscribe / once(refresh) | ○ set（初期シード時のみ） | おすすめ |
| `users/yokota/dismissed` | ○ subscribe | ○ set | 却下したrecのID配列 |
| `users/yokota/dismissedTitles` | ○ subscribe | ○ set | 却下タイトル(lowercase)配列 |

補足:
- `tasks` は**配列を丸ごと `.set()`** で上書きする方式（部分更新・トランザクションなし）。in-app編集・pull-refresh・（外部の）Make.com が同じ配列を奪い合うため**競合リスクあり**（後述5）。
- `recommendations` はアプリからは通常書かない（初回シードのみ）。実際の更新は外部の `recs.html` が `.set()` で全置換する（3-2）。
- ⚠️ 設計書v2は `tasks` を「Make.com webhook経由で追加」と記すが、実物ではアプリ内追加は**Firebase直書き**。両経路が併存している点は要認識。

### 2-3. データ構造

**タスク1件**（seed `IT`, index.html:66／`AddTaskModal` index.html:118 が正）:
```
id        : "t"+Date.now()（seedのみ "t1".."t11"）
name      : 文字列（"\n"改行可、表示は pre-line）
category  : 9カテゴリのいずれか（下記）
detail    : 詳細
merit     : メリット
demerit   : デメリット
deadline  : "YYYY-MM-DD" or ""
priority  : "🟢低" | "🟡中" | "🔴期限迫" | "🔴最優先"
status    : "active" | "done"
url       : 参考URL or ""
note      : 備考
icon      : 絵文字（未指定は gIcon() で自動）
wip       : boolean（Work In Progress）
location  : 場所名/住所（任意、地図リンク用）
completedAt: 完了時ISO日時（完了時のみ付与）
createdAt : （集計で参照。無ければ id の数値部を代用, index.html:126）
```
- カテゴリ `CC`（index.html:64）: 契約・手続き / お金 / ヘルスケア / グルメ / ショッピング / おでかけ / キャリア・学び / ヒト / その他。
- ⚠️ 旧カテゴリ名の移行マップ `cm`（index.html:306）: `手続き・お金→契約・手続き`, `キャリア→キャリア・学び`, `学び→キャリア・学び`。読込時に差異があれば書き戻す。

**おすすめ1件**（`INIT_RECS`, index.html:183-208／Make.comプロンプトが正）:
```
id       : "r"+番号（例 "r1".."r24"）
title    : タイトル
desc     : 説明
category : タスクと同じ9カテゴリ
source   : gmail | calendar | news | x | instagram | line | trend
icon     : 絵文字
priority : "🟢低" | "🟡中" | "🔴期限迫"（※recに最優先は無い）
deadline : "YYYY-MM-DD"
url      : 公式/X投稿URL or ""
location : 場所（任意）
```

---

## 3. 外部依存

### 3-1. Make.com webhook（2箇所・同一URL）
`https://hook.us2.make.com/it31k5edbvjv4cgihpo1a4rg54l7y5mx`
- **index.html:325**（`doRefresh`）: `{action:"refresh_recommendations", user:"yokota"}` をPOST → Make.comがrecs再生成を実行。
- **add.html:13**: URLクエリで受けたタスク項目をJSONでPOST → Make.com経由でタスク登録（iOSショートカット等からの追加口と推測）。
- ⚠️ **移管で Make.com を止めると `add.html` と 🔄リフレッシュが両方壊れる**。add.html の代替（Firebase直書き）を用意しない限り外部追加口が失われる。

### 3-2. recs.html（Make.com → Firebase 書き戻しの受け皿）
- Firebase compat **v9.23.0**（recs.html:3-4）。`databaseURL` のみで初期化（**apiKeyなし＝認証なしで書けている**）。
- `location.hash` のJSON配列を `users/yokota/recommendations` に `.set()`（全置換）（recs.html:9-19）。
- 設計書v2の通り、Make.comが生成JSONを hash に載せて recs.html を開く方式。1リンクにJSONを詰めるため長さ制約あり。

### 3-3. CDN・外部ライブラリ
| 用途 | URL | バージョン |
|------|-----|-----------|
| フォント | fonts.googleapis.com（Outfit, Noto Sans JP） | - |
| React | unpkg.com react@18 / react-dom@18（production UMD） | 18 |
| Firebase（index） | gstatic firebasejs | **10.14.1** |
| Firebase（recs.html） | gstatic firebasejs | **9.23.0** |
| Firebase（cleanup.html） | gstatic firebasejs | **9.22.0** |
- ⚠️ **Firebase SDKのバージョンが3ファイルで不一致**（10.14.1 / 9.23.0 / 9.22.0）。動作はするが将来の一本化候補。
- すべて絶対URL(CDN)なので GitHub Pages のサブパス移行の影響は受けない。

---

## 4. PWA関連

- **manifest**: `index.html:10` で `<link rel="manifest" href="...">`。アイコンは inline data-URI SVG（🫧・外部ファイル不要）。
  棚卸し時点では絶対パス（`/manifest.json` / `"start_url":"/"` / `scope`なし）だったが、Phase 1 で相対化済み。
- **メタタグ**: `apple-mobile-web-app-capable`, `mobile-web-app-capable`, `theme-color` 等でPWA/フルスクリーン対応。
- ⚠️ **サービスワーカーは存在しない**。`sw.js` も `navigator.serviceWorker.register(...)` もコード中に一切ない（grep確認済み）。つまり**オフライン動作・キャッシュ制御はしていない**。設計書 v1/v2 が言及する `sw.js` は実体がないので、移管時に「パス調整」する対象自体が無い。
- **絶対/相対パスの使われ方**（GitHub Pages `https://<user>.github.io/bubblesnow/` サブパス配信で問題になる箇所）:
  - ✅ `index.html:10` `href="/manifest.json"` → サブパスでは `https://<user>.github.io/manifest.json` を指し **404**。`./manifest.json` に修正済み。
  - ✅ `manifest.json` `"start_url":"/"` → アプリのルート（`/bubblesnow/`）でなくドメイン直下を指す。`"./"` に修正し `scope` も追加済み。
  - **2026-08-14、実機で確認済み**。ホーム画面への追加まで通った。この2点が直っていないと追加の項目自体が出てこないので、実機で追加できたこと自体が修正の効果の証明になる。
  - 🟢 それ以外（React/Firebase/フォントの`<script>`/`<link>`、manifestアイコン）はすべて絶対CDN or data-URIで、**パス修正不要**。
  - 🟢 CSS/JS/画像の相対参照は無い（全部インライン）ため、アセットのパス崩れは起きない。
  - 補足: 独自ドメインでルート配信にする場合は上記2点は逆に「/」のままで良い。まず .github.io サブパスで動く形（相対）にするのが無難。

---

## 5. 気づいた課題

### 5-1. セキュリティ / 設計
1. ⚠️ **Firebase `apiKey` が index.html:60 に平文**。設計書v2は「cleanup.htmlのapiKeyを除去」としか書いておらず（実際 cleanup.html からは除去済み＝commit `3d63cd2`）、**index.html の apiKey は残っている**。webのFirebase apiKeyは本質的に公開前提の識別子ではあるが、「除去する」方針と実態が不整合。移管時にv2の方針（隠蔽ベース維持 or 除去）を index.html にも適用するか判断が必要。
2. **Firebaseルールが認証なし読み書き許可**（recs.html/cleanup.htmlが認証なしで書けている事実から）。DB URLを知る誰でも `users/yokota/*` を読み書きできる。ログイン画面(1-1)は見た目だけ。移管で public リポジトリ化してもリスクの質は変わらないが、現状の弱さは記録しておく。
3. `CREDS`（user/pass）と全recのシード、`knownDismissedTitles`（index.html:311）がコードに直書き。

### 5-2. データ整合 / 競合
4. **`tasks` 配列の全置換 `.set()`** が複数経路（in-app編集・pull-refresh・DONEトグル・外部Make.com）から走る。ほぼ同時操作で**ロストアップデート（上書き消失）**の可能性。トランザクション/部分更新にしていない。
5. **`added[]` が永続化されない**（`sAdded` はコンポーネント状態のみ）。リロードで消え、採用済みrecの再表示抑制は「recタイトル＝タスク名一致」フィルタ（index.html:213）頼み。タイトルが少しでも変わると再出現し得る。
6. recの重複排除が **ID(`dismissed`) と 曖昧タイトル(`dismissedTitles`)の二重管理**。recs全置換で毎回新IDが振られる前提のため、恒久的な除外は実質 `dismissedTitles` の部分文字列マッチ（index.html:213）に依存。誤一致/取りこぼしの両リスク。

### 5-3. 移管で壊れる/引っかかる箇所
7. 🔴 **add.html が Make.com webhook 依存**（3-1）。Make.com廃止時に外部タスク追加口が死ぬ。Firebase直書き版への置換設計が必要。
8. ✅ **manifest 絶対パス2点**（4）。GitHub Pagesサブパスで最初に踏む地雷。Phase 1 で修正し、2026-08-14 に実機で確認済み。
9. 🟡 **Firebase SDK バージョン不一致**（3-3）。一本化するかは任意。

### 5-4. デッドコード / 動いていなさそうな箇所
10. `cleanup.html`: dismissed を `r1..r24` だけに戻すワンショットのメンテ用ツール。恒久機能ではなく、移管後は**リポジトリに含めるか（ローカル保管か）**の判断対象。
11. `INIT_RECS`（r1-r24, index.html:183-208）と `knownDismissedTitles`（index.html:311）は特定日付（2026年3月想定）に紐づくシードで、実データが入れば無意味化する準デッドデータ。
12. ヘッダの `calshow://` / `message://` / `googlechrome://`（index.html:172,221-223）はiOS前提スキーム。PC/Android では無反応（実害はないが「動かない機能」）。
13. `Storage` の localStorage フォールバックは Firebase 初期化失敗時のみ。通常経路では使われず、フォールバック時はリアルタイム同期・複数パス購読が劣化する（`subscribe` が単発 cb になる）。

### 5-5. 改修が難しい箇所（保守性）
14. **`index.html` が単一巨大ファイルの超高密度コード**。JSXなしの `h(...)` 直書き＋インラインstyleが全域に渡り、1行が数百〜千文字に達する箇所多数（例: index.html:66 のseed, 114 の`FloatingBubble`描画, 172 のヘッダ）。**部分編集の当たり判定が難しく、差分レビューもしづらい**。ここが最大の改修コスト源。
15. 泡の**物理演算ループ（`BR`/`startL`, index.html:70-73）とReactのライフサイクルが密結合**（`regB/unregB` を `useEffect` で登録、DOMを直接 `transform` 操作）。挙動変更は副作用が読みにくい。
16. タッチ/マウス/ホイールのジェスチャ処理（`FloatingBubble` の `onTS/onTM/onTE/onMD/onW`、index.html:109-113）が手書きで、pinch=優先度・drag=移動・tap/doubletap の判定が絡む。ここへの機能追加は回帰リスク高。

---

## 付録: 補助ページ早見表

| ファイル | 役割 | Firebase | 外部 | 移管時メモ |
|---------|------|---------|------|-----------|
| index.html | 本体SPA（2タブ） | 直接(compat10.14.1) | Make webhook(refresh) | manifest絶対パス修正 / apiKey要判断 |
| add.html | 外部からのタスク追加プロキシ | なし | Make webhook(追加) | Make廃止で要代替 |
| recs.html | Make生成recsの書き戻し受け皿 | 直接(compat9.23.0, 認証なし) | hash受け渡し | バッチ直PUT化で不要にできる |
| cleanup.html | dismissed整理のメンテ用 | 直接(compat9.22.0) | なし | apiKey除去済 / 収録可否を判断 |
| manifest.json | PWAマニフェスト | - | - | start_url `/`→`./`（Phase 1で修正済み） |

---

## 追記: 本番Firebaseの実測値（2026-08-09、Actions経由で構造のみ取得）

本書の1〜5章はコードを読んで書いたもの。以下は**実データを測った結果**。
※ リポジトリがpublicのため、Actionsログには中身を出さず構造のみ取得している。

```
users/yokota 直下のキー: dismissed, dismissedTitles, recommendations, tasks

tasks            : Array / 94件（うち name 有り 94件）
  status別       : done 75 / active 19
  id形式         : t+epoch 60 / t+連番 10 / その他 24
  フィールド出現 : category,icon,id,name,priority,status = 94/94
                   deadline,demerit,merit,note,url = 88/94
                   detail 87 / completedAt 67 / wip 46 / location 9 / done 8
dismissed        : Array / 182件
dismissedTitles  : Array / 244件
recommendations  : Array / 9件
```

### ここから分かる追加の課題

1. **`tasks` は素の Array**（オブジェクトではない）。
   → `add-direct.html` の「配列に push する」実装で正しいことが裏付けられた。
2. ⚠️ **`dismissedTitles` が244件**。index.html:213 はこれを**双方向部分一致**で
   全recに突き合わせる（`t.includes(dt) || dt.includes(t)`）。件数が増えるほど
   誤一致で新recが黙って消える。実際、今回投入した「楽天ペイ 5と0のつく日エントリー」は
   この判定に引っかかって除外された。**短い語が1つ混じるだけで大量のrecを巻き込む**構造。
   → 対策候補: 完全一致＋正規化に変える、期限切れエントリを間引く、上限を設ける。
3. ⚠️ **legacy `done` フィールドが8件残存**。index.html:306 の移行コード
   （`t.status?t:...t.done?"done":"active"`）がまだ現役で必要な状態。
4. **id形式が3種類混在**（`その他` 24件）。ID採番を前提にしたロジックを足すときは注意。
5. `location` は 9/94 しか入っていない。地図リンクはほぼ未活用。
6. `tasks` 94件を**毎回まるごと `.set()`** している。件数は今後も増える一方なので、
   ロストアップデートのリスク（5-2の項目4）は時間とともに悪化する。
