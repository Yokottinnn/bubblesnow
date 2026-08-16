# BubblesNow 運用手順（スマホのClaude Codeから）

## ★前提: クラウドセッションから Firebase には直接書けない★

Claude Code の**クラウドセッション**（スマホ/webから使うもの。セッション一覧で ☁️ アイコン、
`Connected · <Mac名>` が出ないもの）は、egress ポリシーにより Firebase に到達できない。

```
$ curl https://nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app/....json
curl: (56) CONNECT tunnel failed, response 403
```

プロキシの状態エンドポイントにも記録される:

```
$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [{
  "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app:443"
}]
```

到達可否の実測（2026-08-09時点）:

| 宛先 | クラウドセッション | GitHub Actions ランナー |
|---|---|---|
| `api.github.com`（git push 等） | ✅ | ✅ |
| Web検索（WebSearch） | ✅ | – |
| 任意サイトの取得（WebFetch） | ❌ 403 | ✅ |
| **Firebase Realtime DB** | ❌ **403** | ✅ |

**結論: Firebase への読み書きは GitHub Actions を踏み台にする。**
これによりMacを開かずスマホだけで完結する（＝移管の当初ゴールを維持できる）。

```
スマホのClaude Code（クラウド）
  │ git push
  ▼
GitHub Actions ランナー ── ここは制限なし ──▶ Firebase Realtime DB
```

なお、ローカルPC（Mac）でセッションを起動した場合はこの制限を受けないため、Firebase を
直接叩ける。Mac上のファイル（NY2Do フォルダの `_headers` や `make-body-v6-nocite.txt` 等、
未取り込みの原本）が必要なときもローカルが必要。

---

## レコメンド（recs）を更新したいとき

### 仕組み

| ファイル | 役割 |
|---|---|
| `data/poikatsu-recs.json` | 投入したいrecの元データ。`urlCandidates` に候補URLを複数書ける |
| `scripts/push-recs.mjs` | バックアップ→URL実チェック→dismissed除外→ID採番→マージ→書き込み |
| `.github/workflows/push-recs.yml` | 上記を実行。`DRY_RUN` が安全弁 |

スクリプトが自動でやること:

1. **バックアップ** — 既存 recs を `recs-backup.json` に保存し、Actions の artifact として残す（30日保持）
2. **URL実チェック** — `urlCandidates` を上から HTTP アクセスし、最初に生きていたものを採用。
   全滅なら空文字（設計書の「壊れたリンクは無リンクより悪い」を機械的に担保）。
   お金カテゴリはURL必須なので、全滅したrecは投入せず落とす
3. **dismissed除外** — `dismissedTitles` と双方向部分一致するタイトルを除外（index.html:213 と同じ判定）
4. **重複除外** — 既存recsと同じタイトルは追加しない
5. **ID採番** — 既存の `rNNN` の最大値+1から連番
6. **マージ** — 既存recsを消さず末尾に追加（`.set()` の全置換とは異なる）

### 手順

1. `data/poikatsu-recs.json` を編集（Claude Codeに「〇〇のrecを追加して」と指示）
2. commit → push すると Actions が自動で走る（**DRY_RUN=true なので読むだけ**）
3. Actions のログで「既存N件 + 新規M件」とURL判定を確認
4. 問題なければ `.github/workflows/push-recs.yml` の `DRY_RUN` を `"false"` にして push → 実書き込み
5. **書き込み後は `DRY_RUN` を `"true"` に戻す**（誤爆防止。戻したpushで再度DRY RUNが走り、
   「新規追加なし」と出れば書き込みが反映された証拠になる）
6. アプリの【おすすめ】タブで 🔄 を押すと反映される

### 巻き戻したいとき

Actions の該当runページから `recs-backup-<番号>` artifact をダウンロードすると、
書き込み**直前**の recs がそのまま入っている。それを `data/` に戻して書き込めば復旧できる。

---

## GitHub Pages（Phase 2）

### 初回有効化だけは自動化できない（実測で確定）

Pages の有効化はGUI操作ではなくAPI操作なので自動化を試みたが、**権限の壁で不可能**だった。

```
actions/configure-pages@v5 (enablement: true) の結果:
  Get Pages site failed.    Error: Not Found
  Create Pages site failed. Error: Resource not accessible by integration
```

理由: Actions の `GITHUB_TOKEN` は `pages: write`（＝デプロイ）までは持てるが、
**Pagesサイトの新規作成はリポジトリ管理者権限**であり、設計上 `GITHUB_TOKEN` には付与できない。
クラウドの Claude Code から直接叩く道も、APIプロキシが `/repos/*/pages` を403で塞いでいる:

```
{"message":"Access to this GitHub API path is not permitted through this proxy."}
```

### 有効化の方法（どちらか1回だけ）

**A. Settings で有効化（最速・推奨）**

1. https://github.com/Yokottinnn/bubblesnow/settings/pages を開く
2. **Source を「GitHub Actions」に変更**する
   ※「Deploy from a branch」を選ぶと deploy-pages.yml が別のエラーで失敗するので注意
3. 保存すると、次に該当ファイルへ push した時点で自動デプロイされる
   （すぐ流したい場合は Actions タブから "Deploy to GitHub Pages" を再実行）

**B. PAT を登録して以後も自動化する**

1. repo の管理権限を持つ Personal Access Token を作る
2. Settings → Secrets and variables → Actions に `PAGES_ADMIN_TOKEN` として登録
3. deploy-pages.yml がそれを使って**有効化ごと自動で**やる

Aは1回で終わるが、Bにしておくと今後の同種の管理系操作も自動化できる。

### 公開URL

`https://yokottinnn.github.io/bubblesnow/` で公開中。

**2026-08-14、実機で確認済み（Phase 2 完了）。**
ログイン → タスク一覧の表示 → ホーム画面への追加まで通った。
Phase 1 で `index.html` の `href="/manifest.json"` を `./manifest.json` に、
`manifest.json` の `start_url` を `"./"` に直し `scope` を足した修正が効いている。
絶対パスのままだと `https://yokottinnn.github.io/manifest.json` を指して 404 になり、
ホーム画面への追加そのものが出てこない。**この2点はサブパス配信で最初に踏む地雷**なので、
`index.html` や `manifest.json` を触ったら実機で追加し直して確かめること。

このセッションからは github.io に到達できない（egress で 403）ため、
**ここだけは利用者の実機でしか確認できない**。デプロイ自体の成否は
deploy-pages.yml のスモークテスト（配信開始待ち・各ページ200・
配信バイト列に `"start_url":"\./"` などが含まれるか）で機械的に見ている。

---

## その他の操作

### コードを改修したいとき
1. Claude Codeに「index.htmlの〇〇を修正して」と指示
2. Claude Codeが修正 → commit → push
3. （GitHub Pages有効化後は）自動で再デプロイ

### 日次バッチのプロンプトを調整したいとき
`scripts/generate-recs.mjs`（Phase 3で作成予定）の systemPrompt を修正して push。

### バッチが失敗したとき
Claude Codeに「daily-recsのログを見て原因を調べて」と指示すれば、
Actions のログを直接読んで原因を特定できる（GitHub APIには到達できるため）。

---

## 注意点

- **Actions は push で発火する**。`workflow_dispatch`（手動実行）はワークフローが
  デフォルトブランチ(main)に存在しないと使えないため、main にマージするまでは
  対象ファイルへの push が唯一のトリガーになる
- **Make.com への依存は 2026-08-15 に解消済み**（利用者の判断で不使用と決定）。
  アプリ側のコードに `hook.us2.make.com` は 1 箇所も残っていない。

  | 依存していた場所 | どうしたか |
  |---|---|
  | `add.html`（webhookでタスク追加） | `add-direct.html` へ転送するだけにした |
  | `index.html` の 🔄（webhookで再生成を依頼） | webhook 呼び出しを削除。Firebase を読み直すだけにした |

  `add.html` を消さずに転送にしたのは、iOSショートカットやブックマークがこの URL を
  指しているため。**ショートカット類を書き換えなくてもそのまま動く。**
  クエリと hash はそのまま引き渡す。

  🔄 は元々 webhook を `.catch` で握りつぶしていたので、Make.com が recs を
  更新しなくなった後もエラーは出ず、押しても何も起きない状態が続いていた。
  webhook の返事を待つための 3 秒の待機も一緒に外したので、押した直後に読み直す。

  なお **recs を生成する仕組みは現在どこにも無い**。Make.com は 08-09 以降
  `recommendations` を更新しておらず（08-15 時点で 9 件・ID も `r246〜r254` のまま）、
  代替の `daily-recs.yml` はまだ API で成功していない。**表示は正常だが中身は増えない。**

- Actions から recs を書くときは `users/yokota/recommendations` を**全置換**で書く点に注意。
  `scripts/push-recs.mjs` は既存を消さず末尾に足すが、`generate-recs.mjs` は置き換える。
