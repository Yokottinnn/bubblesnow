# Firebase を認証必須にする

## いま何が起きているか

`users/yokota/*` は**認証なしで誰でも読み書きできる**。

- DBのURLは `index.html:60` に書かれていて、公開サイトのソースを見れば分かる
- タスクには確定申告・通院・冠婚葬祭が含まれる
- アプリのログイン画面は**文字列比較の目隠し**で、Firebase には何も伝わっていなかった。
  DevTools で `localStorage.setItem("bn_auth","1")` を実行すれば素通りできたし、
  そもそもアプリを開かずに DB の URL を叩けば読めた

**これは移管で悪化したのではなく、最初からこうだった**（`docs/CURRENT_SPEC.md` 課題2）。

## 直す順番（間違えるとロックアウトする）

**ルールを先に締めると、アプリが認証できないまま締め出される。** 順序を守ること。

### 1. Firebase Console で Google サインインを有効化

1. https://console.firebase.google.com/ → プロジェクト `nydaytodo-e0f20`
2. Authentication → Sign-in method → **Google** を有効化
3. Authentication → Settings → **承認済みドメイン**に次を追加

   - `yokottinnn.github.io`
   - `localhost`（手元で試すとき用）

### 2. アプリを更新して、自分の uid を調べる

`index.html` は Google サインイン対応済み。デプロイ後に公開サイトを開き、
サインインしてから DevTools のコンソールで:

```js
firebase.auth().currentUser.uid
```

出てきた文字列が**あなたの uid**。控える。

### 3. バッチ用の認証情報を取る

Firebase Console → ⚙️ プロジェクトの設定 → **サービス アカウント** →
「データベースのシークレット」（Realtime Database の項）から secret を表示してコピー。

```bash
cat >> ~/bubblesnow/mac/.env <<'EOF'
FIREBASE_SECRET=ここにsecret
EOF
```

**この secret はルールを迂回する管理者権限。** `mac/.env` は `.gitignore` 済みなので
リポジトリには出ない。GitHub Secrets にも置かないこと（public リポジトリのため）。

設定したらバッチが認証付きで読めるか確かめる:

```bash
cd ~/bubblesnow && node scripts/inspect-tasks.mjs
```

### 4. バックアップを取る

締める前に必ず取る。戻せなくなるのを避けるため。

```bash
cd ~/bubblesnow
curl -s "https://nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app/users/yokota.json?auth=$FIREBASE_SECRET" \
  > ~/bubblesnow-backup-$(date +%Y%m%d).json
ls -lh ~/bubblesnow-backup-*.json
```

### 5. ルールを適用する

`firebase/database.rules.json` の **`OWNER_UID` を手順2の uid に置き換えてから**、
Firebase Console → Realtime Database → **ルール** に貼り付けて公開。

### 6. 確認する

- 公開サイトを**シークレットウィンドウ**で開く → サインインを求められる
- サインインするとタスクが見える
- サインインせずに DB の URL を直接開く → `Permission denied` になる

```bash
curl -s "https://nydaytodo-e0f20-default-rtdb.asia-southeast1.firebasedatabase.app/users/yokota/tasks.json"
# {"error":"Permission denied"} が返れば成功
```

## 補助ページの扱い

| ファイル | 状態 |
|---|---|
| `add-direct.html` | ✅ 対応済み。サインイン済みセッションを使い、未サインインならボタンを出す |
| `recs.html` | Make.com の受け皿だったので**もう不要**。削除候補 |
| `cleanup.html` | メンテ用。締めると動かなくなるが、使うときに直せばよい |

`add-direct.html` は iOS ショートカットから開かれるため、毎回サインインを
求めない作りにしてある。Firebase Auth のセッションは同じオリジンに保存されるので、
本体アプリでサインインしていれば黙って通る。**そのため、ショートカットを使う
ブラウザで一度は本体アプリにサインインしておくこと。**

未サインインのときはボタンを出し、リダイレクトで戻ってきたあと
クエリが保持されているのでそのまま追加処理に進む。

## secret が漏れたら

Firebase Console の同じ画面で secret を無効化して再発行する。
アプリ側は Google サインインなので影響を受けない。
