// Gmail から recs の材料を集める。読み取り専用・課金なし。
//
// ★プライバシーが最大の論点★
// recs は users/yokota/recommendations に入り、そこは**認証なしで誰でも読める**。
// メールの件名をそのまま rec にすると、個人的なメールの件名が公開される。
//
// そのため検索を `category:promotions` に限定する。Google 自身が販促メールと
// 分類したものだけが対象で、個人的なやり取り・仕事のメール・領収書などは
// そもそも検索結果に入らない。加えて:
//   - 本文は読まない。件名とスニペットだけ
//   - ログには件数しか出さない（このリポジトリは public）
//   - 「様」「ご請求」など個人宛ての匂いがするものは落とす
//
// ★Gmail API を使う。IMAP ではない★
// アプリパスワードによる IMAP は2段階認証の設定に依存し、Google が縮小方向。
// OAuth のリフレッシュトークンなら失効まで無人で回り続ける。無料枠で足りる
// （1日あたり10億クォータ単位に対し、この用途は数千程度）。
//
// ★必要な環境変数（mac/.env）★
//   GMAIL_CLIENT_ID       … Google Cloud の OAuth クライアントID
//   GMAIL_CLIENT_SECRET   … 同シークレット
//   GMAIL_REFRESH_TOKENS  … アカウントごとのリフレッシュトークンをカンマ区切り
// 取得手順は docs/gmail-setup.md を参照。
//
// 実行: node scripts/collect-gmail.mjs

import { writeFile } from 'node:fs/promises';

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const REFRESH_TOKENS = (process.env.GMAIL_REFRESH_TOKENS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_AGE_DAYS = Number(process.env.GMAIL_MAX_AGE_DAYS || 10);
const PER_ACCOUNT = Number(process.env.GMAIL_PER_ACCOUNT || 40);

// ★category:promotions が肝★ ここを外すと個人的なメールが対象に入る。
// -is:chat で Hangouts 由来を除き、期間で絞る。
const QUERY = `category:promotions newer_than:${MAX_AGE_DAYS}d -is:chat`;

// 販促メールの中でも、recs にして意味があるのはこの手の告知。
const MUST = ['キャンペーン', 'クーポン', '還元', 'ポイント', 'セール', '割引',
  '無料', 'プレゼント', '抽選', '先着', '特典', 'エントリー', '開催', '募集'];

// 販促に分類されていても個人宛ての要素が濃いものは落とす。
// 公開される先に入るので、判定は厳しめに倒す。
const DENY = [
  /ご請求|請求書|お支払い|決済完了|領収書|明細/,
  /ご注文|発送|配送|お届け|返品/,
  /パスワード|認証コード|ログイン|セキュリティ|本人確認/,
  /様のアカウント|様へ|さまへ/,
  /退会|解約|契約更新|重要なお知らせ/,
];

async function accessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    // トークンの中身はログに出さない。失効理由だけ分かればよい。
    throw new Error(`トークン更新に失敗 (${res.status})${t.includes('invalid_grant') ? ' — リフレッシュトークンが失効しています' : ''}`);
  }
  return (await res.json()).access_token;
}

async function api(path, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // エラーの reason（insufficientPermissions 等）は個人情報ではないので出す。
    // メール内容は一切含まれない。
    let reason = '';
    try { reason = (await res.json())?.error?.errors?.[0]?.reason || ''; } catch { /* ignore */ }
    throw new Error(`Gmail API ${path.split('?')[0]} failed: ${res.status}${reason ? ` (${reason})` : ''}`);
  }
  return res.json();
}

const header = (msg, name) => (msg.payload?.headers || [])
  .find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

// 本文は読まない。件名とスニペット（Google が返す短い抜粋）だけ使う。
function toItem(msg) {
  const subject = header(msg, 'Subject').replace(/\s+/g, ' ').trim();
  const snippet = String(msg.snippet || '').replace(/\s+/g, ' ').trim();
  const listUnsub = header(msg, 'List-Unsubscribe');
  const messageId = header(msg, 'Message-ID').trim();
  return { subject, snippet, bulk: Boolean(listUnsub), id: msg.id, messageId };
}

// Gmail の Web 版を開く URL（フォールバック用）。
// スニペットからの正規表現抽出（旧 findUrl）は途中で切れたり不完全なことがあるので、
// タスク化したときにタップして開く先は「元メールそのもの」に統一する。
// authuser にメールアドレスを指定しておけば、他のアカウントでサインイン中でも
// Gmail 側が正しいアカウントに切り替えてくれる。
function gmailUrl(email, id) {
  const auth = email ? `?authuser=${encodeURIComponent(email)}` : '';
  return `https://mail.google.com/mail/${auth}#all/${id}`;
}

// iOS 標準の「メール」アプリでそのメールを直接開く URL。
// Gmail アプリ自体には特定の1通を指定して開く公式リンク形式が無い
// （googlegmail:// は受信トレイを開くだけ）。iOS 標準メールが対応している
// message: スキームなら Message-ID ヘッダーで直接開ける。
// ただし対象アカウントが iOS の「メール」アプリ（IMAP）側にも登録されている
// ことが前提（登録されていなければ開けない）。
function mailAppUrl(messageId) {
  return messageId ? `message:${encodeURIComponent(messageId)}` : '';
}

function keep(item) {
  const text = `${item.subject} ${item.snippet}`;
  // List-Unsubscribe を持たない＝一斉配信ではない可能性が高いので落とす。
  // 個人宛てを公開の場に載せないための保険。
  if (!item.bulk) return false;
  if (DENY.some((re) => re.test(text))) return false;
  return MUST.some((w) => text.includes(w));
}

async function collectAccount(refreshToken, index) {
  const token = await accessToken(refreshToken);

  // 自分のアドレスは表示にも保存にも使わないが、どのアカウントか区別できると
  // 失効時の切り分けが楽なので、ドメインだけ控える。
  const profile = await api('profile', token).catch(() => ({}));
  const domain = String(profile.emailAddress || '').split('@')[1] || '不明';

  const list = await api(`messages?q=${encodeURIComponent(QUERY)}&maxResults=${PER_ACCOUNT}`, token);
  const ids = (list.messages || []).map((m) => m.id);

  const items = [];
  for (const id of ids) {
    const msg = await api(`messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=Message-ID`, token)
      .catch(() => null);
    if (!msg) continue;
    const item = toItem(msg);
    if (!item.subject || !keep(item)) continue;
    items.push({
      key: 'メール',
      category: 'お金',
      icon: '📧',
      // build-recs.mjs 側で「〜を確認する」のようなタスク形式の動詞を
      // 足す余白として、60字ではなく90字まで残す。
      title: item.subject.slice(0, 90),
      // 120 文字での事前カットはやめた。定型文除去・文単位での整形は
      // build-recs.mjs 側でまとめて行うので、ここでは切り詰めずに渡す。
      desc: item.snippet,
      url: mailAppUrl(item.messageId) || gmailUrl(profile.emailAddress, item.id),
      via: 'gmail',
    });
  }

  return { index, domain, scanned: ids.length, kept: items.length, items };
}

async function main() {
  console.log('=== Gmail から recs の材料を収集（読み取り専用・課金なし）===');
  console.log(`検索条件: ${QUERY}`);
  console.log('※ 販促カテゴリに限定。個人的なメールは対象外。件名や本文はログに出しません\n');

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKENS.length) {
    console.error('❌ Gmail の認証情報が未設定です。');
    console.error('   mac/.env に GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKENS を設定してください。');
    console.error('   手順: docs/gmail-setup.md');
    process.exit(1);
  }

  const all = [];
  const seen = new Set();
  let failures = 0;

  for (let i = 0; i < REFRESH_TOKENS.length; i += 1) {
    try {
      const r = await collectAccount(REFRESH_TOKENS[i], i + 1);
      console.log(`  アカウント${r.index}（@${r.domain}）: ${r.scanned}件を確認 → ${r.kept}件を採用`);
      for (const it of r.items) {
        const k = it.title.toLowerCase().replace(/\s/g, '');
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(it);
      }
    } catch (e) {
      failures += 1;
      console.error(`  ⚠️ アカウント${i + 1}: ${e.message}`);
    }
  }

  console.log(`\n合計 ${all.length}件（重複除去後）`);

  // ★書き込みを判定より先にやる★
  //   以前は全滅時にここへ来る前に exit していたので、部分的に採れた分まで
  //   捨てていた。しかも古い collected-gmail.json が残るため、次の工程は
  //   前日のメールを今日のものとして扱っていた。
  //   結果がどうであれ、その回の実測をそのまま書く。
  await writeFile('collected-gmail.json', JSON.stringify({
    collectedAt: new Date().toISOString(),
    // どちらの経路で採れたかを残す。併用にしたので、心拍を見たときに
    // 「OAuth がまだ生きているのか、IMAP に落ちているのか」が分かる必要がある。
    method: 'oauth',
    query: QUERY,
    counts: { total: all.length, accounts: REFRESH_TOKENS.length, failures },
    items: all,
  }, null, 2));
  console.log('📦 collected-gmail.json に保存');

  // ★過半数が落ちたら失敗として返す★
  //   2026-08-31 の実行が 3 アカウント中 2 つ失敗したのに「正常終了」で
  //   通ってしまった。全滅だけを失敗とみなす設計だったため、
  //   IMAP の受け皿も呼ばれず、見出しも健全なままだった。
  //   大半が死んでいる状態は「動いている」ではない。
  const dead = failures * 2 > REFRESH_TOKENS.length;
  if (dead) {
    console.error(`\n❌ ${REFRESH_TOKENS.length}アカウント中 ${failures}件で失敗しました。`);
    console.error('   リフレッシュトークンの失効が疑われます（テストモードなら7日で切れます）。');
    console.error('   docs/gmail-setup.md の「失効したとき」を参照してください。');
    console.error('   採れた分は保存済みです。受け皿（IMAP）があればそちらを試します。');
    process.exit(1);
  }
  if (failures) {
    console.warn(`\n⚠️ ${failures}件のアカウントで失敗しましたが、過半数は採れているので続けます。`);
  }

  console.log('=== 完了・課金は発生していません（$0）===');
}

const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'collect-gmail.mjs') main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });

export { keep, gmailUrl, mailAppUrl, QUERY };
