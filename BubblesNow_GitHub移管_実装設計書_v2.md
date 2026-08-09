# BubblesNow GitHub移管 実装設計書（実物ベース改訂版 v2）

## この設計書について

**v2改訂**: 実際のソースファイル（index.html / add.html / recs.html / cleanup.html / manifest.json / _headers / make-body-v6-nocite.txt）を確認し、実物に合わせて全面改訂した。v1の想定と食い違っていた点を全て修正済み。

BubblesNow（個人向けタスク管理PWA）のホスティング・日次バッチ・コード管理を**すべてGitHubに集約**し、スマホのClaude Codeアプリから改修・デプロイ・データ更新・バッチ調整の全てを操作できる状態にする。

**この設計書は、Claude Codeがこれ一枚で移管作業を最初から最後まで自走できるように書かれている。**

---

## 実物から判明した正確な仕様（v1からの訂正）

### Firebaseデータパス（★v1から訂正★）
```
DB URL: https://nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app
プロジェクト: nydaytodo-e0f20

正しいパス:
  users/yokota/recommendations  ← レコメンド（v1で /recs と誤記）
  users/yokota/dismissed         ← dismiss履歴
  タスク本体 ← Make.com webhook 経由で追加される
```

### 認証の実態（★重要★）
- `recs.html` は databaseURL のみで認証なしに書き込めている
  → **Firebaseセキュリティルールが「認証なしで読み書き許可」の状態**
- `cleanup.html` にはFirebase APIキーが平文で直書きされている
  → **移管時に除去する**（下記セキュリティ方針参照）

### 日次バッチの正確な仕様（make-body-v6-nocite.txt より）
```
モデル: claude-sonnet-4-20250514
max_tokens: 4000
tools: web_search_20250305 有効

systemプロンプト（実物）:
"BubblesNowリコメンドエンジン。タスク追加傾向を増やしdismiss傾向を減らす。
サウナ好き、AI/テック好き、キャリア重視。JSON配列のみ返せ。説明文もmarkdownも
HTMLタグもciteタグも絶対に含めるな。最初の文字は[、最後の文字は]であること。
各要素: {id,title,desc,category,source,icon,priority,deadline,url,location}。
title,descにはHTMLタグやciteタグを絶対に含めるな。プレーンテキストのみ。
locationは場所名や住所。場所不明なら空文字。urlは確実に存在する公式サイトのみ。
不確かなURLは空文字にせよ。壊れたリンクは絶対に含めるな。urlにはX(Twitter)の
投稿URLも積極的に使え。公式サイトよりもXの投稿のほうが情報として分かりやすい
場合はXのURLを優先せよ。誰かがPR・紹介・レビューしている投稿でもよい。
source:gmail/calendar/news/x/instagram。category:契約・手続き/お金/ヘルスケア/
グルメ/ショッピング/おでかけ/キャリア・学び/ヒト/その他。お金カテゴリにはポイ活・
ポイント還元・キャッシュバックキャンペーン・クリプト関連(エアドロップ案件・NFT登録/
購入インセンティブ・仮想通貨キャンペーン)も含め、必ずキャンペーン告知ページのURLを
付けること。priority:🟢低/🟡中/🔴期限迫。15-25件。期限切れ除外。"

userメッセージ（実物）:
"TASKS={{substring(encodeURL(2.data); 0; 8000)}}&DISMISSED={{substring(encodeURL(3.data); 0; 2000)}}&RECS={{substring(encodeURL(4.data); 0; 8000)}}

上記データを分析しておすすめJSON配列を返せ。Web検索で東京のサウナ新店・
テックイベント・アート展・ポイ活キャンペーン・クリプトエアドロップ/NFT
インセンティブの最新情報を調べろ。X(Twitter)の投稿で有益な情報があれば
そのURLを優先的に使え。JSON配列のみ。HTMLタグやciteタグは絶対に含めるな。"
```

### レコメンドのデータ構造
各レコメンド要素:
```json
{
  "id": "r150",
  "title": "...",
  "desc": "...",
  "category": "お金",
  "source": "x",
  "icon": "💰",
  "priority": "🟡",
  "deadline": "...",
  "url": "...",
  "location": "..."
}
```

### 現在のデータフロー（実物）
```
Make.com（0:00 JST）:
  ① Firebase GET: users/yokota のタスク・dismissed・recommendations取得
  ② Claude API POST: 上記プロンプトで生成（web search有効）
  ③ 生成したJSONを recs.html の URL hash に載せて渡す
     → recs.html が users/yokota/recommendations に .set() で書き込み

※ v1で想定した「バッチが直接PUT」ではなく、recs.html経由のhash受け渡し方式
※ GitHub Actions化する際は、バッチが直接 REST API で
   users/yokota/recommendations に PUT する方式に簡素化できる
```

### manifest.json（実物）
```json
{"name":"BubblesNow","short_name":"BubblesNow","start_url":"/","display":"standalone",...}
```
→ `start_url":"/"` はGitHub Pagesサブパス配信でズレる。要修正。

### _headers ファイル
Netlify用のヘッダ設定ファイル。GitHub Pagesでは使わない（GitHub Pagesは_headers非対応）。移行時は役割を確認し、必要ならmeta tagやService Workerで代替。

---

## セキュリティ方針（現状維持＋APIキー除去）

Jordanの判断: **現状維持（隠蔽ベース）＋ cleanup.htmlのAPIキー除去**。

理由と対応:
- BubblesNowは個人専用のタスク管理。実害リスクが低い
- DB URLは元々ブラウザ（recs.html等）に露出しており、publicリポジトリ化で露出度は本質的に変わらない
- ただし `cleanup.html` の Firebase APIキー（AIzaSy...）は、他のFirebase機能へのアクセスに使われうるため**必ず除去する**

具体的対応:
1. cleanup.html から `apiKey:"AIzaSy..."` を削除
   - cleanup.html はメンテ用ツール。databaseURLのみで動くよう書き換える
     （recs.html と同じく認証なしアクセスの形にする）
   - または cleanup.html 自体をリポジトリに含めない（ローカル保管のみ）
2. 他のファイルにAPIキーの直書きがないか全確認
3. Claude APIキーは絶対にフロントに書かない（GitHub Secretsのみ）

**注意**: 将来的にセキュリティを強化したくなったら、Firebaseルールで認証必須化＋アプリにログイン機構追加が必要になる（今回はやらない）。

---

## 移管後の構成

```
スマホ/PCのClaude Codeアプリ
  │ git push
  ▼
GitHubリポジトリ Yokottinnn/bubblesnow（唯一の中心）
  ├── index.html / add.html / recs.html  （フロント、パス調整済み）
  ├── manifest.json                       （start_url相対化）
  ├── cleanup.html                         （APIキー除去、または除外）
  ├── .github/workflows/
  │     ├── deploy-pages.yml               （GitHub Pages自動公開）
  │     └── daily-recs.yml                 （日次バッチ 0:00 JST）
  ├── scripts/generate-recs.mjs            （Make.com代替バッチ）
  ├── docs/                                （設計書・運用手順）
  └── README.md
  │
  ├─ push → GitHub Pages（自動公開）
  └─ cron 0:00 JST → GitHub Actions（Firebase直接読み書き）
         │
         ▼
  Firebase Realtime DB（維持・データ移行なし）
  users/yokota/recommendations, dismissed, tasks
```

---

## Phase 0: 現状確認（完了済み）

実物ファイルの確認は完了。判明事項:
- ✅ フロント: index.html / add.html / recs.html / cleanup.html
- ✅ manifest.json（start_url要修正）
- ✅ _headers（Netlity用、GitHub Pagesでは不要）
- ✅ Make.comプロンプト全文（make-body-v6-nocite.txt）
- ✅ Firebaseパス: users/yokota/recommendations, dismissed
- ✅ 認証: 現状ルール緩め（認証なし読み書き可）

**Jordanから追加で必要なもの:**
1. Claude APIキー（Phase 4でGitHub Secretsに登録）
2. index.html の中身（今回未添付。タスク表示ロジック・Firebase参照を確認したい）
3. Firebase書き込みに認証トークンが必要か最終確認
   （recs.htmlは認証なしで書けているので恐らく不要だが、バッチのPUTで確認）

---

## Phase 1: リポジトリにフロント配置＋パス調整

リポジトリ `Yokottinnn/bubblesnow` は作成済み。ここにフロントを配置する。

```
1. 既存フロントファイルをリポジトリに配置
   - index.html / add.html / recs.html / manifest.json
   - cleanup.html は APIキー除去してから配置（または除外）

2. ★manifest.json のパス修正★
   "start_url":"/" → "start_url":"./"
   "scope" があれば "./" に
   （GitHub Pages: https://yokottinnn.github.io/bubblesnow/ で動くように）

3. ★index.html 内のパス確認・修正★
   - manifest への <link rel="manifest" href="..."> を相対パスに
   - Service Worker登録があれば register('./sw.js') 等 相対に
   - Firebase参照は databaseURL 直書きなのでパス影響なし（そのまま）
   - アイコン・CSS・JS参照を相対パスに

4. ★cleanup.html のAPIキー除去★
   var fc={apiKey:"AIzaSy...",...} から apiKey 行を削除
   recs.html と同じ形（databaseURLのみ）に書き換えて動作確認
   ※ もしくは cleanup.html はリポジトリに含めず、ローカル保管に

5. _headers は一旦除外（GitHub Pages非対応）
   必要なヘッダがあれば別途 meta tag 等で代替を検討

6. commit & push
```

**チェックポイント1**: pushしたらPhase 2へ。

---

## Phase 2: GitHub Pages 有効化＋動作確認

```
1. Settings → Pages → Source: "GitHub Actions"（deploy-pages.yml使用）
   または "Deploy from a branch" main/(root)

2. https://yokottinnn.github.io/bubblesnow/ で公開

3. ★動作確認（最重要）★
   - index.html が表示されるか
   - PWAインストールできるか（manifest正常か、start_url確認）
   - Firebaseからタスク・recommendationsが読めるか
   - recs.html が hash付きURLで正常動作するか
     テスト: recs.html#<JSON配列> でアクセスして書き込めるか
   - add.html が Make.com webhook に飛ばせるか
     （※webhookは当面Make.com維持なので動くはず）
```

**deploy-pages.yml:**
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
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - id: deployment
        uses: actions/deploy-pages@v4
```

**チェックポイント2**: 公開URLで全機能動作を確認。PWAパス問題が出たら潰す。

---

## Phase 3: 日次バッチをGitHub Actionsに移植

Make.comの処理をNode.jsで再現。実物プロンプトをそのまま使う。

### scripts/generate-recs.mjs

```javascript
// BubblesNow 日次レコメンド生成バッチ
// Make.com make-body-v6 の忠実な移植版

const FIREBASE_URL = process.env.FIREBASE_URL;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const FIREBASE_SECRET = process.env.FIREBASE_SECRET; // 不要なら空でOK

const BASE = 'users/yokota';

async function fetchFirebase(path) {
  const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return await res.json();
}

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

// Make.com make-body-v6 の system プロンプト（実物そのまま）
const SYSTEM_PROMPT = `BubblesNowリコメンドエンジン。タスク追加傾向を増やしdismiss傾向を減らす。サウナ好き、AI/テック好き、キャリア重視。JSON配列のみ返せ。説明文もmarkdownもHTMLタグもciteタグも絶対に含めるな。最初の文字は[、最後の文字は]であること。各要素: {id,title,desc,category,source,icon,priority,deadline,url,location}。title,descにはHTMLタグやciteタグを絶対に含めるな。プレーンテキストのみ。locationは場所名や住所。場所不明なら空文字。urlは確実に存在する公式サイトのみ。不確かなURLは空文字にせよ。壊れたリンクは絶対に含めるな。urlにはX(Twitter)の投稿URLも積極的に使え。公式サイトよりもXの投稿のほうが情報として分かりやすい場合はXのURLを優先せよ。誰かがPR・紹介・レビューしている投稿でもよい。source:gmail/calendar/news/x/instagram。category:契約・手続き/お金/ヘルスケア/グルメ/ショッピング/おでかけ/キャリア・学び/ヒト/その他。お金カテゴリにはポイ活・ポイント還元・キャッシュバックキャンペーン・クリプト関連(エアドロップ案件・NFT登録/購入インセンティブ・仮想通貨キャンペーン)も含め、必ずキャンペーン告知ページのURLを付けること。priority:🟢低/🟡中/🔴期限迫。15-25件。期限切れ除外。`;

async function generateRecs(tasks, dismissed, existingRecs) {
  // Make.comのuserメッセージを再現（データを埋め込む）
  const tasksStr = encodeURIComponent(JSON.stringify(tasks || {})).slice(0, 8000);
  const dismissedStr = encodeURIComponent(JSON.stringify(dismissed || [])).slice(0, 2000);
  const recsStr = encodeURIComponent(JSON.stringify(existingRecs || [])).slice(0, 8000);

  const userMessage = `TASKS=${tasksStr}&DISMISSED=${dismissedStr}&RECS=${recsStr}

上記データを分析しておすすめJSON配列を返せ。Web検索で東京のサウナ新店・テックイベント・アート展・ポイ活キャンペーン・クリプトエアドロップ/NFTインセンティブの最新情報を調べろ。X(Twitter)の投稿で有益な情報があればそのURLを優先的に使え。JSON配列のみ。HTMLタグやciteタグは絶対に含めるな。`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',  // 実物と同じモデル
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// 生レスポンスからJSON配列を抽出
function extractRecs(claudeResponse) {
  const text = (claudeResponse.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('recs配列が抽出できませんでした');
  return JSON.parse(match[0]);
}

async function main() {
  console.log('=== BubblesNow 日次recs生成 開始 ===');
  const tasks = await fetchFirebase(`${BASE}/tasks`).catch(() => null);
  const dismissed = await fetchFirebase(`${BASE}/dismissed`).catch(() => []);
  const existingRecs = await fetchFirebase(`${BASE}/recommendations`).catch(() => []);

  const claudeResponse = await generateRecs(tasks, dismissed, existingRecs);
  const newRecs = extractRecs(claudeResponse);

  // 実物のrecs.htmlは .set()（全置換）。同じ挙動にする。
  // ※もし追記・重複排除にしたいなら別途ロジック追加
  await putFirebase(`${BASE}/recommendations`, newRecs);

  console.log(`=== 完了: ${newRecs.length}件のrecommendationsを書き込み ===`);
}

main().catch(err => {
  console.error('バッチ失敗:', err);
  process.exit(1);
});
```

**重要な設計判断（要Jordan確認）:**
- 実物の recs.html は `.set()` = **全置換**（既存recsを新recsで丸ごと上書き）
- 上記スクリプトも同じく全置換にした
- もし「既存recsに追記＋ID重複排除」にしたいなら別ロジックが必要
  → 現状の挙動を踏襲するなら全置換のままでOK

### .github/workflows/daily-recs.yml
```yaml
name: Daily Recommendations
on:
  schedule:
    - cron: '0 15 * * *'   # 0:00 JST = 15:00 UTC
  workflow_dispatch:
jobs:
  generate-recs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Run recs generation
        env:
          FIREBASE_URL: ${{ secrets.FIREBASE_URL }}
          CLAUDE_API_KEY: ${{ secrets.CLAUDE_API_KEY }}
          FIREBASE_SECRET: ${{ secrets.FIREBASE_SECRET }}
        run: node scripts/generate-recs.mjs
```

**チェックポイント3**: ローカルで手動実行してFirebaseに書けるか確認。Phase 4へ。

---

## Phase 4: GitHub Secrets 設定

```
Settings → Secrets and variables → Actions で登録:
  FIREBASE_URL: https://nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app
  CLAUDE_API_KEY: （Jordanが渡すAnthropic APIキー）
  FIREBASE_SECRET: （認証不要なら空欄でOK。recs.htmlが認証なしで書けているので恐らく不要）

★絶対にコードに直書きしない★
```

**チェックポイント4**: workflow_dispatch で手動実行 → Actions上で成功確認。

---

## Phase 5: 並行検証（Make.com維持）

```
Make.comを止めずにGitHub Actions版を検証:
  - daily-recs.yml の schedule をコメントアウト、workflow_dispatch のみ有効
  - 手動実行 → Firebase の users/yokota/recommendations 結果を目視確認
  - Make.com版の結果と品質比較
  - ★全置換なので、GitHub Actions版とMake.com版が交互に上書きしないよう注意★
    検証中はMake.comを一時停止するか、検証を別時間帯にやる

推奨: 数日間、手動トリガーで結果品質を確認
```

**チェックポイント5**: 品質OKならJordan承認 → Phase 6。

---

## Phase 6: 本番切替（★承認必須★）

```
1. Make.com シナリオを一時停止（削除しない）
2. daily-recs.yml の schedule を有効化
3. 翌0:00 JST の自動実行を待つ
4. Actions実行ログ＋アプリ表示を確認
5. 数日観察して安定したらMake.com削除（不安なら停止のまま維持）
```

**チェックポイント6**: 3日連続正常動作で移管完了。

---

## Phase 7: 運用手順の文書化（docs/OPERATIONS.md）

スマホのClaude Codeから操作するフローを文書化（v1と同じ）:
- コード改修 → 指示 → push → Pages自動デプロイ
- バッチプロンプト調整 → generate-recs.mjs 編集 → push
- データ更新 → Firebase REST APIを叩く指示
- バッチ失敗 → Actions ログ確認 → 修正

---

## v1からの主な訂正点まとめ

| 項目 | v1（誤） | v2（実物） |
|------|---------|-----------|
| recsパス | /recs | users/yokota/recommendations |
| dismissedパス | /dismissed | users/yokota/dismissed |
| モデル | claude-sonnet-4-6 | claude-sonnet-4-20250514 |
| max_tokens | 4096 | 4000 |
| プロンプト | 仮 | make-body-v6実物 |
| 書き込み方式 | PUT（追記想定） | .set()全置換 |
| データ受け渡し | 直接PUT | recs.html hash経由（→バッチ直接PUTに簡素化） |
| APIキー | 言及なし | cleanup.htmlに直書き→除去 |
| manifest | 汎用 | start_url:"/"→"./"要修正 |
| _headers | 言及なし | Netlify用、GitHub Pages不要 |

---

## 重要な原則

1. Firebaseのデータは壊さない（維持、パスは users/yokota/...）
2. Make.comは検証完了まで止めない
3. cleanup.html のAPIキーは必ず除去
4. Claude APIキーはSecretsのみ、コード直書き禁止
5. PWAパス（manifest start_url）は移行の技術リスク、Phase 2で確認
6. recs書き込みは全置換（.set()）= 実物の挙動を踏襲
7. 各チェックポイントでJordanに報告、Phase 6は承認必須
```
