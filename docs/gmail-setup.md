# Gmail 連携の設定

recs の材料に販促メールを加えるための手順。**無料枠で収まる。**

## 先に知っておくこと

`users/yokota/recommendations` は**認証なしで誰でも読める**。
メールの件名がそのまま rec になるので、**個人的なメールの件名を公開しない**設計が要る。

`scripts/collect-gmail.mjs` は次の4段で絞っている。

1. **検索が `category:promotions` に限定されている** — Google 自身が販促と分類したものだけ。
   個人的なやり取り・仕事のメール・領収書はそもそも検索結果に入らない
2. **`List-Unsubscribe` ヘッダを持つものだけ通す** — 一斉配信の証。個人宛てを弾く保険
3. **請求・注文・パスワード・「様へ」などは落とす** — 販促に分類されていても個人性が濃いもの
4. **本文は読まない** — 件名と Google が返すスニペットだけ

ログにも件名は出さない。出るのは件数とドメインだけ。

## 手順（1回だけ）

### 1. Google Cloud でプロジェクトを作る

1. https://console.cloud.google.com/projectcreate で適当な名前（例: `bubblesnow`）
2. 作成後、そのプロジェクトを選択

### 2. Gmail API を有効化

1. https://console.cloud.google.com/apis/library/gmail.googleapis.com
2. 「有効にする」

### 3. OAuth 同意画面

1. https://console.cloud.google.com/apis/credentials/consent
2. User Type: **外部**
3. アプリ名・サポートメール・デベロッパー連絡先を埋める（自分用なので何でもよい）
4. スコープ: `https://www.googleapis.com/auth/gmail.readonly` を追加
5. **テストユーザー**に3つのアドレスをすべて追加する

   - tacseigaku@gmail.com
   - daredemosanka@gmail.com
   - n-yokota@fieldbeside.com

   ※ テストユーザーのままでよい。公開申請は不要。
   ただし**テストモードのリフレッシュトークンは7日で失効する**。
   長く回したい場合は同意画面を「本番」に切り替える（審査は不要。
   自分だけが使うスコープなので警告画面を「詳細」→「移動」で抜けられる）

### 4. OAuth クライアントIDを作る

1. https://console.cloud.google.com/apis/credentials
2. 「認証情報を作成」→「OAuth クライアント ID」
3. 種類: **デスクトップアプリ**
4. 出てきた**クライアントID**と**クライアントシークレット**を控える

### 5. アカウントごとにリフレッシュトークンを取る

3アカウントぶん繰り返す。各アカウントでログインした状態のブラウザで行う。

```bash
# ① 認可URLを組み立てて開く（CLIENT_ID は自分の値に置き換え）
CLIENT_ID="ここにクライアントID"
open "https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/gmail.readonly&access_type=offline&prompt=consent"
```

ブラウザで許可すると `http://localhost/?code=4/0A...` に飛ぶ（ページは表示されない）。
**アドレスバーの `code=` の値**をコピーする。

```bash
# ② コードをリフレッシュトークンに交換
curl -s https://oauth2.googleapis.com/token \
  -d client_id="ここにクライアントID" \
  -d client_secret="ここにシークレット" \
  -d code="ここにcodeの値" \
  -d grant_type=authorization_code \
  -d redirect_uri=http://localhost | python3 -m json.tool
```

返ってきた JSON の **`refresh_token`** を控える。

> `access_type=offline` と `prompt=consent` の両方が必要。
> 片方でも欠けると `refresh_token` が返らず、access_token だけになる。

### 6. mac/.env に書く

```bash
cat >> ~/bubblesnow/mac/.env <<'EOF'
GMAIL_CLIENT_ID=ここにクライアントID
GMAIL_CLIENT_SECRET=ここにシークレット
GMAIL_REFRESH_TOKENS=トークン1,トークン2,トークン3
EOF
```

`mac/.env` は `.gitignore` 済み。**リポジトリにも GitHub にも出ない。**

### 7. 確かめる

```bash
cd ~/bubblesnow && node scripts/collect-gmail.mjs
```

アカウントごとの件数が出れば成功。

## 失効したとき

テストモードなら7日で切れる。切れると `invalid_grant` が出る。

```
⚠️ アカウント1: トークン更新に失敗 (400) — リフレッシュトークンが失効しています
```

全アカウントが失敗した場合はスクリプトが異常終了するので、**静かに0件になることはない**。
手順5をやり直すか、同意画面を「本番」に切り替える。

---

## テストモードのままだと7日で死ぬ（2026-08-30 追記）

OAuth 同意画面が **テストモード** のままだと、リフレッシュトークンは **7日で失効する**。
これは設定ミスではなく Google の仕様。そして厄介なのは、失効しても**何も壊れないこと**。

`mac/run-daily.sh` は Gmail の失敗を握りつぶして X の材料だけで続行し、**正常終了する**。
アプリには X 由来の rec が並び続けるので、見た目には何も起きていない。
`mac/logs/daily.out.log` を開く習慣が無い限り、連携が死んだことに何週間も気づけない。

実際、確認できている最後の Gmail 稼働は **2026-08-27**（コミット 6bd1f85 の
「Dry-run against real Gmail data」）。テストモードなら、この時点のトークンは
**8月末に切れている可能性が高い。**

### 恒久対策: 同意画面を「本番」に切り替える

**Console の場所（2025〜2026 で変わっている）**

`APIs & Services` → **`Google Auth Platform`** → **`Audience`** タブ →
**`Publish app`**（アプリを公開）。
旧UIの「OAuth 同意画面」は `Google Auth Platform` 配下の
`Branding` / `Audience` / `Data Access` / `Clients` に分割された。

**審査について（当初「不要」と書いたのは誤り）**

このプロジェクトが使う `https://www.googleapis.com/auth/gmail.readonly` は
Google の **restricted scope（制限付きスコープ）** にあたる。External のまま
本番公開すると、Google の審査対象アプリという扱いになる。

ただし **審査を通さなくても使える**。未審査のまま本番にすると、認可画面で
「このアプリは確認されていません」の警告が出る。`詳細` → `<アプリ名>（安全ではないページ）に移動`
から進めば認可は完了する。自分の3アカウントで使うだけなので、これで足りる。
審査（restricted scope は第三者のセキュリティ評価まで必要で、費用も期間もかかる）が
要るのは他人に配布する場合。

**やる順番を間違えないこと**

公開しても、**テストモード中に発行済みのトークンは失効し続ける**。
公開だけでは今のトークンは生き返らない。

1. `Publish app` で本番にする
2. **そのあとで** 手順5 をやり直し、3アカウント分のトークンを取り直す
3. `mac/.env` の `GMAIL_REFRESH_TOKENS` を差し替える
4. `node scripts/collect-gmail.mjs` で3アカウントとも件数が出ることを確認

順番を逆にすると、取り直したトークンがまた7日で切れて二度手間になる。

### それまでの検知

`mac/last-run.md` の「結果」欄に `（⚠️ Gmail の収集に失敗）` が付く。
GitHub でこのファイルを見れば、Mac に触らなくても分かる。

---

## 別案: アプリパスワード + IMAP（同意画面も審査も要らない）

OAuth の面倒はほぼ全部「同意画面」から来ている。テストモードなら7日で失効し、
本番にすれば `gmail.readonly` が restricted scope なので未審査アプリの警告が挟まる。
**自分の3アカウントを自分の Mac から読むだけ**の用途に、この重さは釣り合っていない。

アプリパスワードなら **失効しない**。取り消すまで有効で、クライアントIDも
同意画面も審査も要らない。

`scripts/collect-gmail-imap.mjs` がその実装。出力先も形も OAuth 版と同じ
`collected-gmail.json` なので、`build-recs.mjs` は変更なしで読める。
判定（`keep()`）は OAuth 版から読み込んで共有している——二重に持つと
片方だけ緩んで、個人的なメールの件名が公開の rec に載る事故になるため。
本文は `BODY.PEEK` で読むので **既読にならない**。

### 設定

1. 各アカウントで **2段階認証を有効化**（アプリパスワードの前提）
2. https://myaccount.google.com/apppasswords で発行（16桁）
3. `mac/.env` に書く

```bash
cat >> ~/bubblesnow/mac/.env <<'ENV'
GMAIL_IMAP_ACCOUNTS=tacseigaku@gmail.com:xxxxxxxxxxxxxxxx,daredemosanka@gmail.com:yyyyyyyyyyyyyyyy,n-yokota@fieldbeside.com:zzzzzzzzzzzzzzzz
ENV
```

表示される4桁区切りの空白は入れたままでよい（スクリプトが落とす）。

4. 確かめる

```bash
cd ~/bubblesnow && set -a && . mac/.env && set +a && node scripts/collect-gmail-imap.mjs
```

### 併用（2026-08-30 以降の既定）

日次バッチは **OAuth を先に試し、失敗したときだけ IMAP に落ちる**。

| `.env` の状態 | 動き |
|---|---|
| OAuth だけ | OAuth |
| IMAP だけ | IMAP |
| **両方** | **OAuth → 失敗したら IMAP** |
| どちらも無い | Gmail を丸ごと省略 |

順番に意味がある。2026-08-30 時点で OAuth は3アカウントとも生きていて
7日連続で成功しているので、動いているものをわざわざ止める理由がない。
一方 OAuth はトークンが失効しうるし Google の方針変更も受ける。
そのとき収集が丸ごと止まらないよう、IMAP を受け皿として置いておく。

**どちらで採れたかは `mac/last-run.md` に出る**（`OAuth: 3 / 3 アカウント成功、24件`）。
ある日これが `IMAP:` に変わっていたら、OAuth が倒れて受け皿が働いた合図。

### 通らない可能性がある場合

- **2段階認証が無効** — 発行画面自体が出ない。有効にする
- **Workspace で管理者が禁止している** — `n-yokota@fieldbeside.com` が
  Workspace ならこれに当たりうる。そのアカウントだけ OAuth 版に残せばよい
- **Google がこの仕組みを縮小した** — 2026年時点では現役だが、方針は揺れている

3アカウントのうち一部だけ失敗しても、残りで収集は続く。
全滅したときだけスクリプトが異常終了する（静かに0件にはならない）。

### 検証

Gmail に接続せずにパース部分だけ確かめられる。

```bash
node scripts/test-collect-gmail-imap.mjs
```

36ケース。IMAP のリテラル（本文の中に `a5 OK` に見える並びが入っても
応答の終端を誤判定しないか）、**1通ずつの束ね方**、件名のデコード
（分割された encoded-word、Base64 と Quoted-Printable）、折り返しヘッダー、
本文の復号、そして `keep()` を OAuth 版と共有できているかを見る。

**このテストは実際に4つのバグを見つけている**ので、触ったら必ず走らせること。
なかでも束ね方は静かに間違う。`BODY[1]` は非マルチパートのメールでは
`NIL` が返るため、リテラルを「2つずつ」数えると、そこから先は
**別のメールの本文が別の件名に貼り付く**。件名と本文が入れ替わった rec が
そのまま公開の場に出るので、目視でも気づきにくい。
