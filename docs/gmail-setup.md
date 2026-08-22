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
