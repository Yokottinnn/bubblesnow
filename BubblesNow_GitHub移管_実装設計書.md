# BubblesNow GitHub移管 実装設計書

## この設計書の目的

BubblesNow（個人向けタスク管理PWA）のホスティング・日次バッチ・コード管理を**すべてGitHubに集約**し、スマホのClaude Codeアプリから改修・デプロイ・データ更新・バッチ調整の全てを操作できる状態にする。

**この設計書は、Claude Codeがこれ一枚で移管作業を最初から最後まで自走できるように書かれている。** 各Phaseを順に実行し、チェックポイントで検証しながら進めること。

---

## 移管の全体像

### Before（現状）
- フロント: Netlify（`effortless-hamster-59633c.netlify.app`）、手動ドラッグ&ドロップでデプロイ
- 日次バッチ: Make.com（0:00 JST、Firebase GET → Claude API → Firebase PUT）
- DB: Firebase Realtime Database（`nydaytodo-e0f20`）
- 問題: 分散していてスマホから操作できない、Make.comがブラックボックス

### After（移管後）
- フロント: **GitHub Pages**（git pushで自動公開）
- 日次バッチ: **GitHub Actions**（クラウドcron 0:00 JST、Mac不要）
- DB: **Firebase維持**（データ移行なし＝リスクゼロ）
- コード管理: **GitHubリポジトリ**（唯一の中心/SSOT）
- Make.com: **廃止**（ただし並行検証してから）

### 変わらないもの（重要）
- Firebase Realtime Database はそのまま。データ移行は一切しない
- ユーザー体験（タスク追加/dismiss/recs表示）は完全に同じ
- recs処理のロジック（extractRecs、parseResponse相当）はそのまま移植

---

## 既知の重要情報（現行BubblesNowの仕様）

Claude Codeが把握しておくべき現行の構成:

```
Firebase:
  プロジェクト: nydaytodo-e0f20
  DB URL: https://nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app
  主要パス: /tasks, /dismissed, /recs

フロントHTML（3ファイル）:
  index.html … メインアプリ（PWA本体、タスク表示・recs表示）
  add.html   … タスク追加プロキシ
  recs.html  … レコメンド取り込み（リンクをタップ→Firebase更新）

日次バッチ（現Make.com、これをGitHub Actionsへ移植）:
  タイミング: 0:00 JST
  ① Firebase GET: tasks / dismissed / recs を取得
  ② Claude API POST: web search有効で新レコメンド生成
  ③ Firebase PUT: HTTP経由でrecs書き込み
  注意点:
    - Claude API呼び出しは parseResponse:false 相当（生レスポンスを扱う）
    - recs配列の抽出（extractRecs）はアプリ側で実施
    - recs.html バッチ上限: 1リンク最大8アイテム、URL 10,000〜12,000字以内
    - recs IDは重複不可。/recs に一度書かれたIDは永久に重複排除される
    - 次のセッションで使うID採番は既存の管理ルールに従う

recs学習ルール（バッチのプロンプトに反映）:
  - タスク追加傾向を強化、dismiss傾向を抑制（徐々に、急激にしない）
  - 既出タスクは再提示しない
  - 追加傾向: サウナ、AI/tech系イベント、キャリア系、ポイ活/キャッシュバック
  - URLは公式ソースのみ。不確実なら空欄（リンク切れは無リンクより悪い）
  - ポイ活recsは必ずキャンペーン告知ページURLを含める
```

**注意**: 上記の値は設計書作成時点の情報。Claude Codeは実際のNetlify上のHTMLファイルとMake.comシナリオの中身を必ず自分で確認し、齟齬があれば実物を正とすること。

---

## リポジトリ構成（目標）

```
bubblesnow/                        ← 新規GitHubリポジトリ
├── index.html                     ← メインアプリ（ルート配置でパス問題回避）
├── add.html
├── recs.html
├── manifest.json                  ← PWAマニフェスト（パス要調整）
├── sw.js                          ← service worker（パス要調整）
├── assets/                        ← アイコン・CSS・画像
├── .github/
│   └── workflows/
│       ├── deploy-pages.yml       ← GitHub Pages自動公開
│       └── daily-recs.yml         ← 日次バッチ（Make.com代替）
├── scripts/
│   └── generate-recs.mjs          ← バッチ本体（Node.js）
├── docs/
│   ├── MIGRATION.md               ← この設計書
│   ├── OPERATIONS.md              ← 運用手順（スマホからの操作方法）
│   └── STATE.md                   ← 現在の状態・ID採番記録
└── README.md
```

---

## Phase 0: 事前準備・確認

Claude Codeが最初にやること:

```
1. 現行資産の吸い上げ
   - Netlify上の index.html / add.html / recs.html の最新版を取得
     （Jordanのローカルに NY2Do フォルダがあるはず。その場所を確認）
   - manifest.json / service worker / assets の有無を確認
   - Firebase参照パスがコード内でどう書かれているか確認（絶対パス/相対パス）

2. Make.comシナリオの内容を書き出す
   - ① Firebase GETのエンドポイントとクエリ
   - ② Claude APIのモデル名、プロンプト全文、web search設定、max_tokens等
   - ③ Firebase PUTの書き込み先パスと形式
   - Jordanに「Make.comシナリオのスクショまたはエクスポート」を依頼してもよい

3. 必要な認証情報の洗い出し（後でGitHub Secretsに入れる）
   - Firebase DB URL（既知）
   - Firebase書き込みに認証が必要か（現状のルールを確認）
   - Claude APIキー

4. GitHubアカウントの確認
   - Jordanのアカウントで新規リポジトリを作れるか
   - リポジトリは public（GitHub Pages無料枠のため）
```

**チェックポイント0**: 上記4点が揃ったらJordanに報告してからPhase 1へ。特にMake.comの②Claude APIプロンプト全文は、バッチ移植の心臓部なので必ず取得すること。

---

## Phase 1: リポジトリ作成とフロント移植

```
1. GitHubで新規リポジトリ bubblesnow を作成（public）

2. ローカルにclone
   git clone https://github.com/<ユーザー名>/bubblesnow.git
   cd bubblesnow

3. 既存HTMLファイルをルートに配置
   - index.html / add.html / recs.html をコピー
   - manifest.json / sw.js / assets/ もコピー

4. ★最重要: PWAパスの調整★
   GitHub Pagesが https://<ユーザー名>.github.io/bubblesnow/ という
   サブパス配信になる場合、以下を全部相対パス or サブパス対応にする:
   - manifest.json の "start_url" と "scope"
   - service worker の登録パスとキャッシュパス
   - HTML内の <link>, <script>, <img> の参照
   - Firebase SDK参照（CDN or ローカル）
   
   対応方針:
   - 絶対パス（/xxx）→ 相対パス（./xxx or xxx）に変更
   - manifest: "start_url": "./", "scope": "./"
   - sw.js: register('./sw.js') とし、キャッシュパスも相対に
   
   ※ もし独自ドメインを後で当てる場合はルート配信になるので、
     その時は再調整。まずは .github.io サブパスで動く形にする

5. ★セキュリティ: キーの直書き禁止★
   - リポジトリはpublicなので、コードは全世界に公開される
   - Firebase DB URLはフロントに書かれるが、これはFirebaseの
     セキュリティルールで保護する前提（現状と同じ）
   - Claude APIキーは絶対にフロントに書かない（バッチ側=Secretsのみ）
   - もし現状のHTMLにAPIキーが直書きされていたら、その部分は
     バッチ（GitHub Actions）に移すので削除する

6. commit & push
   git add .
   git commit -m "Initial: migrate BubblesNow frontend to GitHub"
   git push origin main
```

**チェックポイント1**: pushできたらPhase 2へ。

---

## Phase 2: GitHub Pages 有効化

```
1. GitHubリポジトリの Settings → Pages
2. Source: "Deploy from a branch" を選択
3. Branch: main / (root) を選択して Save
   （または後述の deploy-pages.yml でActions経由デプロイ）

4. 数分待つと https://<ユーザー名>.github.io/bubblesnow/ で公開される

5. ★動作確認（最重要）★
   - ページが表示されるか
   - PWAとしてインストールできるか（manifest正常か）
   - service workerが登録されるか（DevToolsで確認）
   - Firebaseからタスクが読めるか
   - タスクの追加/dismissができるか
   - recs.html が正常に動くか
```

**deploy-pages.yml（Actions経由で公開する場合）:**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Pages
        uses: actions/configure-pages@v5
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

**チェックポイント2**: 公開URLで全機能が動くことを確認してからPhase 3へ。ここでPWAパスの問題が出たら必ず潰す。

---

## Phase 3: 日次バッチを GitHub Actions に移植

これが移管の心臓部。Make.comのシナリオをNode.jsスクリプト＋GitHub Actionsで再現する。

### scripts/generate-recs.mjs（バッチ本体）

```javascript
// BubblesNow 日次レコメンド生成バッチ
// Make.com シナリオの Node.js 移植版
// 実行: node scripts/generate-recs.mjs

const FIREBASE_URL = process.env.FIREBASE_URL;         // GitHub Secrets
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;     // GitHub Secrets
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;   // 書き込み認証が必要な場合

// ① Firebase GET: 現在の tasks / dismissed / recs を取得
async function fetchFirebase(path) {
  const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return await res.json();
}

// ③ Firebase PUT: recs を書き込み
async function putFirebase(path, data) {
  const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${path} failed: ${res.status}`);
  return await res.json();
}

// ② Claude API POST: web search有効で新レコメンド生成
async function generateRecs(tasks, dismissed, existingRecs) {
  // ★ここのプロンプトは Make.com の②の内容をそのまま移植する★
  // 学習ルール（追加傾向強化/dismiss抑制、公式URLのみ、ポイ活は告知ページURL必須 等）を反映
  const systemPrompt = `あなたはBubblesNowのレコメンドエンジンです。
ユーザーの追加済みタスク・dismiss履歴・既出recsを踏まえ、新しいおすすめタスクを生成してください。
ルール:
- 追加傾向を強化、dismiss傾向を抑制（徐々に）
- 既出タスク・既出recIDは再提示しない
- 追加傾向: サウナ、AI/tech系イベント、キャリア系、ポイ活/キャッシュバック
- URLは公式ソースのみ。不確実なら空欄
- ポイ活recsは必ずキャンペーン告知ページURLを含める`;

  const userPrompt = `現在のタスク: ${JSON.stringify(tasks)}
dismiss履歴: ${JSON.stringify(dismissed)}
既出recs: ${JSON.stringify(existingRecs)}

新しいレコメンドを生成してください。`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',   // ★Make.comで使っていたモデルに合わせる★
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],  // web search有効
    }),
  });
  if (!res.ok) throw new Error(`Claude API failed: ${res.status} ${await res.text()}`);
  return await res.json();   // 生レスポンス（parseResponse:false 相当）
}

// extractRecs: Claudeの生レスポンスからrecs配列を抽出
// ★Make.com時代はアプリ側で実施していた処理をここに移植★
function extractRecs(claudeResponse) {
  // content配列からtextブロックを集約
  const text = (claudeResponse.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  // JSON配列部分を抽出してparse（```json フェンス除去含む）
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('recs配列が抽出できませんでした');
  return JSON.parse(match[0]);
}

// 新ID採番（既存recIDと重複しないように）
function assignFreshIds(newRecs, existingRecs) {
  const usedIds = new Set(Object.keys(existingRecs || {}));
  // 既存の採番ルールに従う（rNNN形式）。最大番号+1から採番
  let maxNum = 0;
  for (const id of usedIds) {
    const m = id.match(/^r(\d+)$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  let next = maxNum + 1;
  const result = {};
  for (const rec of newRecs) {
    result[`r${next}`] = rec;
    next++;
  }
  return result;
}

// メイン処理
async function main() {
  console.log('=== BubblesNow 日次recs生成 開始 ===');
  const tasks = await fetchFirebase('tasks');
  const dismissed = await fetchFirebase('dismissed');
  const existingRecs = await fetchFirebase('recs');

  const claudeResponse = await generateRecs(tasks, dismissed, existingRecs);
  const newRecs = extractRecs(claudeResponse);
  const recsWithIds = assignFreshIds(newRecs, existingRecs);

  // 既存recsとマージ（上書きでなく追加）
  const merged = { ...(existingRecs || {}), ...recsWithIds };
  await putFirebase('recs', merged);

  console.log(`=== 完了: ${Object.keys(recsWithIds).length}件の新recを追加 ===`);
}

main().catch(err => {
  console.error('バッチ失敗:', err);
  process.exit(1);
});
```

### .github/workflows/daily-recs.yml

```yaml
name: Daily Recommendations

on:
  schedule:
    # 0:00 JST = 15:00 UTC（前日）
    - cron: '0 15 * * *'
  workflow_dispatch:   # 手動トリガーも可能（テスト用）

jobs:
  generate-recs:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run recs generation
        env:
          FIREBASE_URL: ${{ secrets.FIREBASE_URL }}
          CLAUDE_API_KEY: ${{ secrets.CLAUDE_API_KEY }}
          FIREBASE_SECRET: ${{ secrets.FIREBASE_SECRET }}
        run: node scripts/generate-recs.mjs
```

**注意**: cronは `0 15 * * *`（UTC15時=JST0時）。GitHub ActionsのcronはUTC基準。またGitHub Actionsのcronは混雑時に数分〜十数分遅延することがある（Make.comより時刻精度は落ちる）。BubblesNowの用途では問題ないはず。

**チェックポイント3**: スクリプトを書いたらまず**ローカルで手動実行**して動作確認（Secretsは.env等で一時的に与える）。Firebaseに正しく書けるか確認してからPhase 4へ。

---

## Phase 4: GitHub Secrets 設定

```
1. GitHubリポジトリ Settings → Secrets and variables → Actions
2. 以下のシークレットを登録（"New repository secret"）:
   - FIREBASE_URL: https://nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app
   - CLAUDE_API_KEY: （Anthropic APIキー）
   - FIREBASE_SECRET: （Firebase書き込みに認証が必要な場合のみ）

3. ★重要: これらは絶対にコードにハードコードしない★
   Secretsに入れた値は workflow の ${{ secrets.XXX }} でのみ参照
```

**チェックポイント4**: Secrets登録後、`workflow_dispatch` で手動トリガーしてGitHub Actions上でバッチが成功するか確認。

---

## Phase 5: 並行検証（Make.comを止めない）

**重要: いきなりMake.comを止めない。二重書き込みを避けつつ検証する。**

```
検証方法（二重書き込み回避）:
  オプションA: GitHub Actionsは手動トリガーのみで数日テスト
    - scheduleをコメントアウトし、workflow_dispatch のみ有効化
    - 手動実行 → Firebaseの結果を目視確認
    - Make.comは通常通り0:00に動かし続ける
    - GitHub Actions手動実行の結果とMake.comの結果を比較

  オプションB: 別パスでドライラン
    - GitHub Actions版は /recs_test に書き込むようにして検証
    - 本番 /recs はMake.comが担当
    - 結果が同等の品質なら本番切替

推奨: オプションA。数日間、手動トリガーで結果品質を確認する。
```

**チェックポイント5**: GitHub Actions版が期待通りのrecsを生成し、Firebaseに正しく書けることを数日確認。ID採番の重複がないことも確認。Jordanが品質OKと判断したらPhase 6へ。

---

## Phase 6: 本番切替

```
1. Make.com のシナリオを停止（削除でなく一時停止。すぐ戻せるように）

2. daily-recs.yml の schedule を有効化
   - cron: '0 15 * * *' のコメントアウトを解除

3. 翌0:00 JST に自動実行されるのを待つ

4. 実行後、Firebaseの /recs が更新されたか確認
   - GitHub Actions の実行ログを確認
   - アプリ上で新recsが表示されるか確認

5. 数日間、毎朝正常に動いているか観察

6. 完全に安定したら Make.com シナリオを削除してOK
   （不安なら1〜2週間は一時停止のまま残す）
```

**チェックポイント6**: 3日連続で0:00バッチが正常動作したら移管完了。

---

## Phase 7: スマホからの操作フロー確立（docs/OPERATIONS.md）

移管の最終目的＝スマホのClaude Codeアプリから全部操作。運用手順を文書化する。

```markdown
# BubblesNow 運用手順（スマホのClaude Codeから）

## コードを改修したいとき
1. スマホのClaude Codeアプリで bubblesnow リポジトリを開く
2. 「index.htmlの〇〇を修正して」と指示
3. Claude Codeが修正 → commit → push
4. GitHub Pagesが自動で再デプロイ（数分）
5. 公開URLで確認

## 日次バッチのプロンプトを調整したいとき
1. scripts/generate-recs.mjs の systemPrompt を修正指示
2. commit → push
3. 次回0:00の実行から反映
4. すぐ試したいなら Actions の workflow_dispatch で手動実行

## データを直接更新したいとき
1. Claude Codeに「Firebaseの〇〇を更新して」と指示
2. Claude CodeがFirebase REST APIを叩いて更新
   （またはスクリプトを書いて実行）

## バッチが失敗したとき
1. GitHub → Actions タブで失敗ログを確認
2. Claude Codeに「daily-recsのログを見て原因を調べて」と指示
3. 修正 → push
```

---

## トラブルシューティング（想定される問題）

### PWAがGitHub Pagesで動かない
- 原因: サブパス配信でのパスずれ
- 対処: manifest.jsonのstart_url/scope、sw.jsの登録パスとキャッシュパスを相対に

### Firebaseに書き込めない
- 原因: セキュリティルールで認証必須になっている
- 対処: FIREBASE_SECRETをSecretsに追加、またはFirebaseルールを確認

### cronが動かない/遅れる
- GitHub Actionsのcronは無料枠だと遅延・稀にスキップあり
- 重要度が上がったら別のスケジューラも検討（が、BubblesNowでは許容範囲）

### recs IDが重複する
- assignFreshIds が既存IDを正しく読めているか確認
- /recs のGETが最新を取れているか確認

### Claude APIのレスポンスからrecsが抽出できない
- extractRecsの正規表現を、実際のレスポンス形式に合わせて調整
- web search使用時はcontent配列にtool_use/tool_resultブロックも混在するので、textブロックのみ抽出しているか確認

---

## 作業順序サマリー（Claude Code向け）

```
Phase 0: 現行資産の吸い上げ・Make.comプロンプト取得 → Jordanに報告
Phase 1: リポジトリ作成・フロント移植・PWAパス調整・push
Phase 2: GitHub Pages有効化・全機能の動作確認
Phase 3: バッチをNode.js化（generate-recs.mjs）・ローカルテスト
Phase 4: GitHub Secrets設定・手動トリガーで動作確認
Phase 5: 並行検証（Make.com維持したまま数日）→ Jordan品質確認
Phase 6: 本番切替（Make.com停止・schedule有効化）→ 数日観察
Phase 7: 運用手順の文書化（OPERATIONS.md）

各Phaseのチェックポイントで、破壊的操作の前は必ずJordanに確認する。
特にPhase 6（Make.com停止）の前は必ず承認を取ること。
```

---

## 重要な原則

1. **Firebaseのデータは絶対に壊さない**。移行せず維持。既存の/tasks /dismissed /recsに触るのはバッチの通常書き込みのみ
2. **Make.comは検証完了まで止めない**。日次recsが途切れると困る
3. **キーは絶対にpublicリポジトリのコードに直書きしない**。Secretsのみ
4. **PWAパスは移行の最大の技術リスク**。Phase 2で徹底確認
5. **各チェックポイントでJordanに報告**。特にPhase 6は承認必須
```
