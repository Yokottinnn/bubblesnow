# Mac を常時稼働の実行機にする

## なぜ Mac なのか

クラウドのセッションは egress ポリシーで Firebase・github.io・一般サイトに届かず、
X もログイン済みセッションを持てない。Mac ならその制約が全部無い。

| | クラウド | Mac 常時稼働 |
|---|---|---|
| X のログイン済みセッション | 使えない | **そのまま使える** |
| Firebase | 403（Actions 経由が必須） | **直接読み書き** |
| 一般サイト | 403 | **自由** |
| 費用 | Actions は無料だが LLM は課金 | **電気代のみ** |

Cookie を public リポジトリの Secrets に置く必要も無くなる。`mac/.env` に置けば外に出ない。

## 蓋を閉じたまま動かす

**外部ディスプレイを繋がずに蓋を閉じると、通常 Mac はスリープする。**
止める決め手は `disablesleep`。`sleep 0` だけでは蓋閉じスリープは止まらない。

```bash
bash mac/check-power.sh          # いまの状態を見る（変更しない）
sudo bash mac/apply-power.sh     # 常時稼働に設定する
```

`apply-power.sh` は `-c`（電源アダプタ接続時）だけを変える。
バッテリー動作時は触らないので、持ち出したときに電池を食い潰さない。
変更前の値と、元に戻すコマンドを実行時に表示する。

## 日次ジョブを登録する

```bash
bash mac/install.sh
```

`~/Library/LaunchAgents/com.bubblesnow.daily.plist` を作り、毎日 0:00（Mac のローカル時刻）に
`mac/run-daily.sh` を実行する。sudo は不要。

```bash
launchctl kickstart -k gui/$(id -u)/com.bubblesnow.daily   # すぐ試す
tail -f mac/logs/daily.out.log                             # ログ
launchctl bootout gui/$(id -u)/com.bubblesnow.daily        # 外す
```

## X の Cookie（任意）

無くてもプロフィール経由で動く。検索まで使いたい場合だけ設定する。

```bash
cat > mac/.env <<'EOF'
X_AUTH_TOKEN=...
X_CT0=...
EOF
```

取り方: x.com にログインした状態で開発者ツール → Application → Cookies → `https://x.com`
から `auth_token` と `ct0` の値をコピーする。

`mac/.env` は `.gitignore` 済み。**リポジトリには入らない。**

Cookie は失効する。失効すると検索が 0 件になるが、`collect-x.mjs` は
「Cookie はあるのに検索が0件」を警告として出すので、静かに壊れたままにはならない。

## 注意

- **これは X API ではない。** X API は 2026-02 に無料枠が廃止され $0.005/投稿の従量課金になったが、
  ここで使うのは自分のログイン済みセッションで自分が見られるものを読む経路で、API 課金は発生しない。
- Mac が止まっていた時間帯のジョブは飛ぶ。`disablesleep=1` にしておけば起きたままになる。
