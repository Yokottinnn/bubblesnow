// Gmail から recs の材料を集める（IMAP + アプリパスワード版）。読み取り専用・課金なし。
//
// ★なぜ OAuth 版と別に用意したのか★
//   collect-gmail.mjs の冒頭には「アプリパスワードは Google が縮小方向なので
//   OAuth にした。リフレッシュトークンなら失効まで無人で回り続ける」と書いてある。
//   後半が誤りだった。OAuth 同意画面がテストモードのままだと、
//   リフレッシュトークンは **7日で失効する**。しかも失効しても日次バッチは
//   X の材料だけで正常終了するので、連携が死んだことに気づけない。
//
//   本番公開すれば期限は外れるが、gmail.readonly は restricted scope なので
//   未審査アプリの警告画面を挟むことになり、Google の方針次第で今後も揺れる。
//
//   アプリパスワードは **失効しない**。2段階認証さえ有効なら発行でき、
//   取り消すまで有効。同意画面も審査もクライアントIDも要らない。
//   この用途（自分の3アカウントを自分の Mac から読むだけ）には、
//   OAuth の仕組みは重すぎる。
//
// ★制約（正直に書いておく）★
//   - 2段階認証が必須。無効だとアプリパスワードを発行できない
//   - Google Workspace のドメインでは、管理者がアプリパスワードを
//     禁止している場合がある。fieldbeside.com がそれに当たる可能性はある
//   - Google はこの仕組みを縮小したい意向を示し続けている。将来消える前提で見る
//   どれかに当たったら、そのアカウントだけ OAuth 版に戻せばよい（併用できる）。
//
// ★プライバシー方針は OAuth 版と同一★
//   検索を category:promotions に限定し、List-Unsubscribe を持つものだけ採用し、
//   個人宛ての匂いがするものを落とす。判定は collect-gmail.mjs の keep() を
//   そのまま読み込んで使う——二重に持つと片方だけ緩む事故が起きるため。
//   ログには件数しか出さない（このリポジトリは public）。
//   本文は BODY.PEEK で読むので **既読にならない**。
//
// ★必要な環境変数（mac/.env）★
//   GMAIL_IMAP_ACCOUNTS … アドレスとアプリパスワードの組をカンマ区切り
//     例: GMAIL_IMAP_ACCOUNTS="a@gmail.com:abcdefghijklmnop,b@gmail.com:qrstuvwxyzabcdef"
//     ★4桁区切りの空白は必ず消し、値全体を二重引用符で囲む★
//     run-daily.sh は `. mac/.env` でこのファイルをシェルとして解釈するので、
//     空白が残っていると値が途中で切れる（実際に踏んだ）。
//
// 実行: node scripts/collect-gmail-imap.mjs

import { writeFile, readFile } from 'node:fs/promises';
import {
  classify, estimateCost, credential, MODEL as CLASSIFY_MODEL,
} from './classify-mail.mjs';
import tls from 'node:tls';
import { keep, mailAppUrl } from './collect-gmail.mjs';

const HOST = process.env.GMAIL_IMAP_HOST || 'imap.gmail.com';
const PORT = Number(process.env.GMAIL_IMAP_PORT || 993);
const MAX_AGE_DAYS = Number(process.env.GMAIL_MAX_AGE_DAYS || 10);
const PER_ACCOUNT = Number(process.env.GMAIL_PER_ACCOUNT || 40);
const TIMEOUT_MS = Number(process.env.GMAIL_IMAP_TIMEOUT_MS || 30000);
// 検証のときに本番の材料を上書きしないよう、書き先を差し替えられるようにする。
const OUT_FILE = process.env.GMAIL_OUT_FILE || 'collected-gmail-imap.json';

// OAuth 版と同じ検索条件。X-GM-RAW は Gmail の検索構文をそのまま受ける。
const QUERY = `category:promotions newer_than:${MAX_AGE_DAYS}d -is:chat`;

/* ── 「対応が要るメール」の経路 ──
   ★なぜ別の経路が要るのか★
   上の QUERY と keep() は「お得情報を拾う」ために作られている。
   promotions に限定し、List-Unsubscribe を必須にし、「様へ」のように
   個人宛ての匂いがするものを落とす。recs が誰でも読める場所に入る前提だった
   からで、当時は正しかった。

   2026-08-23 に Firebase を閉じたので、その前提は消えた。そして実際、
   返事が要るメール（例: 面談場所のご相談）が三重に落とされていた——
   promotions に入らない・「様へ」で DENY・販促語が無いので MUST 不成立。
   これは調整ではなく、拾う対象が違うという話。

   ★精度の作り方★
   判定は **件名だけ** を見る。本文まで見るとメルマガの定型文が
   ほぼ全部引っかかる。件名に「ご相談」「ご返信」と書いてあるものは、
   実際に相手が返事を待っている確率が高い。
   件数の上限も別に持つ。壊れたときの影響をこの経路の中に閉じ込める。 */
const ACTION_QUERY = `newer_than:${MAX_AGE_DAYS}d -is:chat -in:spam -in:trash`;
const ACTION_PER_ACCOUNT = Number(process.env.GMAIL_ACTION_PER_ACCOUNT || 20);

/* ★LLM 判定の切り替え。既定は off で、従来どおりキーワードだけ見る★
     off      … 何も変わらない。課金なし
     validate … 見本レスポンスで配線だけ確かめる。API を呼ばないので課金なし
     live     … 実際に API を呼ぶ。**課金あり**
   既定を off にしてあるのは、この収集が1日2回 launchd で自動実行されるため。
   既定を live にすると、気づかないうちに毎日課金が始まる。 */
const CLASSIFY_MODES = ['off', 'validate', 'live'];
const CLASSIFY = String(process.env.CLASSIFY || 'off').toLowerCase();
if (!CLASSIFY_MODES.includes(CLASSIFY)) {
  console.error(`CLASSIFY が不正です: "${CLASSIFY}"（使えるのは ${CLASSIFY_MODES.join(' / ')}）`);
  process.exit(1);
}

/* 判定済みの記録。同じメールを二度 LLM に読ませないための鍵。
   収集は10日窓なので、記録が効かないと同じメールを毎回読み直すことになり、
   費用が十数倍に跳ねる（月$2 → 月$33）。費用を決めているのはここ。 */
const CACHE_FILE = process.env.CLASSIFY_CACHE || '.mail-verdicts-cache.json';
const CACHE_KEEP_DAYS = 30;


// 件名にこれがあれば「相手が何かを待っている」と見なす。
//
// ★金銭と期限の語を必ず入れる★
// 「【9月29日まで】ディズニー・クルーズラインの残金お支払い期日」が
// 丸ごと落ちていた（2026-09-23 に発覚）。当時の語は「手続き」「期限」
// 「お願い」などで、支払いを直接指す語が一つも無かった。
// 同じ差出人の「クルーズ残金お支払い期日について」は末尾の「について」
// でたまたま通っており、拾えるかどうかが偶然に左右されていた。
// 支払期日は落としてはいけない種類なので、金銭の語は厚めに持つ。
const ACTION_WORDS = [
  // 返事・調整
  'ご相談', '相談', 'ご連絡', 'ご確認', 'ご返信', 'ご返答', 'ご回答',
  '日程', '面談', '面接', '打ち合わせ', '打合せ', '来社', '訪問',
  'お願い', 'ご依頼', 'ご提出', '提出', '手続き', 'お手続き',
  'リマインド', '再送', 'ご案内の件', 'について',
  // 期限
  '期限', '期日', '締切', '締め切り', '要対応', '未提出', 'ご対応',
  'まで', '最終日', '本日まで', '残り',
  // 金銭
  '支払', 'お支払', '残金', '請求', 'ご請求', '入金', 'ご入金',
  '振込', 'お振込', '振替', '引き落とし', '引落', '決済',
  '料金', '会費', '年会費', '更新料', '延滞', '未納', '未払',
  // 予約・契約で動きが要るもの
  'キャンセル期限', '変更期限', '更新', '自動更新', '満了', '失効',
];

/* 件名に依頼の語があっても、実際には対応が要らないもの。
   - 済んだことの通知（決済完了・発送）は読むだけ
   - 認証コードの類は寿命が数分で、タスクにする意味がない
   - 配信物そのもの（メルマガ）は「ご案内」を含みがち */
/* 件名に依頼の語があっても、実際には対応が要らないもの。
   金銭の語を厚くしたぶん、ここで「済んだことの通知」を確実に落とす。
   支払いの依頼（まだ払っていない）と完了通知（もう払った）を
   取り違えると、片方は漏れ、もう片方は不要なタスクになる。 */
const ACTION_DENY = [
  /認証コード|ワンタイム|確認コード|パスワード(?:の)?(?:再設定|変更|リセット)|セキュリティ(?:通知|警告)/,
  // 済んだこと。「完了」「しました」「受付ました」で終わるもの
  /(?:決済|お?支払い?|入金|振込|振替|返金)(?:完了|済み?|を?受(?:付|け付け)(?:ました)?|いただき)/,
  /* 「ご入金を確認いたしました」のように助詞が挟まる形も落とす。
     連続一致の「入金確認」だけでは素通りした。 */
  /(?:入金|決済|支払い?|振込)[^。\n]{0,6}確認(?:いた)?しました|ご入金ありがとう/,
  /領収書|レシート|ご利用明細|利用明細|ご利用のお知らせ/,
  /発送(?:のお知らせ|完了)|配送完了|お届け完了|出荷(?:完了|のお知らせ)/,
  /メールマガジン|メルマガ|ニュースレター|配信停止/,
  /自動返信|Automatic reply|Out of Office/i,
];

export function keepAction(subject) {
  const t = String(subject || '');
  if (!t) return false;
  if (ACTION_DENY.some((re) => re.test(t))) return false;
  return ACTION_WORDS.some((w) => t.includes(w));
}

/* mac/.env から "アドレス:アプリパスワード" の組を読む。
   アプリパスワードは英小文字16桁で、表示上4桁ごとに空白が入る。貼り付けたまま
   でも動くように空白を落とす。アドレスに : は入らないので最初の : で割る。 */
function accounts() {
  return (process.env.GMAIL_IMAP_ACCOUNTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      if (i < 0) return null;
      return { email: pair.slice(0, i).trim(), pass: pair.slice(i + 1).replace(/\s+/g, '') };
    })
    .filter((a) => a && a.email && a.pass);
}

/* .env が壊れていないかを先に見る。
   ★実際に踏んだ壊れ方★ アプリパスワードは 4 桁区切りの空白付きで表示される。
   それを引用符なしで .env に貼ると、run-daily.sh の `. mac/.env` が
   シェルとして解釈するので「...:abcd を代入して efgh を実行」と読まれ、
   値が 4 文字で切れる。IMAP 側からは「パスワードが違う」としか見えず、
   本当の原因（.env の書き方）に辿り着けない。ここで名指しする。 */
function warnIfTruncated(list) {
  const short = list.filter((a) => a.pass.length < 16);
  if (!short.length) return;
  console.warn(`⚠️ ${short.length}件のアプリパスワードが16桁未満です（${short.map((a) => a.pass.length).join(', ')}文字）。`);
  console.warn('   .env で空白を詰めていない可能性があります。4桁区切りの空白は消して、');
  console.warn('   値全体を二重引用符で囲んでください（docs/gmail-setup.md）。');
  console.warn('   例: GMAIL_IMAP_ACCOUNTS="a@gmail.com:abcdefghijklmnop"');
}

/* ── 最小の IMAP クライアント ──
   依存を足さずに済ませたい（この用途に必要なのは LOGIN / SELECT / SEARCH /
   FETCH の4つだけで、ライブラリを入れるほどではない）。
   面倒なのはリテラル（{123} のあとに生バイトが続く形式）で、
   件名も本文もここに入ってくるため、そこだけ正しく扱う。 */
function connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host }, () => resolve(sock));
    sock.setTimeout(TIMEOUT_MS);
    sock.once('timeout', () => { sock.destroy(); reject(new Error('IMAP: 応答がありません（タイムアウト）')); });
    sock.once('error', reject);
  });
}

/* バッファを頭から歩き、リテラルを飛ばしながら「タグ付き完了行」に届いたかを見る。
   リテラルの中に CRLF や 'a5 OK' に見える並びが入りうるので、
   単純な行分割では終端を誤判定する。 */
function scan(buf, tag) {
  let i = 0;
  const lines = [];
  while (i < buf.length) {
    const j = buf.indexOf('\r\n', i, 'latin1');
    if (j < 0) return { done: false };
    const text = buf.toString('latin1', i, j);
    const lit = text.match(/\{(\d+)\}$/);
    if (lit) {
      const n = Number(lit[1]);
      const start = j + 2;
      if (start + n > buf.length) return { done: false };
      lines.push({ text, literal: buf.subarray(start, start + n) });
      i = start + n;
      continue;
    }
    lines.push({ text, literal: null });
    if (text.startsWith(`${tag} `)) return { done: true, lines, tagLine: text };
    i = j + 2;
  }
  return { done: false };
}

function client(sock) {
  let seq = 0;
  let buf = Buffer.alloc(0);
  const waiters = [];

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (const w of waiters) {
      const r = scan(buf, w.tag);
      if (r.done) { w.resolve(r); buf = Buffer.alloc(0); waiters.length = 0; break; }
    }
  });

  // 接続直後のグリーティングを捨てる。
  const greeting = new Promise((resolve) => {
    const on = () => { if (buf.includes('\r\n')) { buf = Buffer.alloc(0); sock.off('data', on); resolve(); } };
    sock.on('data', on);
  });

  async function send(cmd) {
    seq += 1;
    const tag = `a${seq}`;
    buf = Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`IMAP: ${cmd.split(' ')[0]} が応答しません`)), TIMEOUT_MS);
      waiters.push({ tag, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      sock.write(`${tag} ${cmd}\r\n`);
    });
  }

  return { greeting, send };
}

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/* ── MIME encoded-word のデコード ──
   件名はほぼ =?UTF-8?B?....?= の形で来る。素のまま使うと rec の見出しが
   文字化けするので必ず戻す。 */
function decodeWords(s) {
  return String(s)
    // 長い件名は複数の encoded-word に割られて届く。その境目の空白は
    // 本来の空白ではないので、デコードする前に詰める。あとから詰めようとしても
    // 復号後の文字列に紛れてしまい、本物の空白と区別できない。
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs, enc, txt) => {
      try {
        const charset = cs.toLowerCase().replace('shift_jis', 'sjis');
        if (enc.toUpperCase() === 'B') {
          return new TextDecoder(charset, { fatal: false }).decode(Buffer.from(txt, 'base64'));
        }
        const bytes = Buffer.from(
          txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))),
          'latin1',
        );
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
      } catch {
        return txt;
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/* 本文の先頭だけを、スニペット相当として使えるところまで戻す。
   OAuth 版が使っていた snippet も Google が本文から作ったものなので、
   ここで見る情報の量は同じ。長さで縛って、それ以上は読まない。 */
function snippetFrom(bytes) {
  let t = bytes.toString('latin1');
  // base64 らしさの判定。40字を境にしていたら短い本文を素通ししていた。
  // 4の倍数長という base64 の性質を足したうえで下限を下げる。
  const bare = t.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && bare.length >= 16 && bare.length % 4 === 0) {
    try {
      const dec = Buffer.from(bare, 'base64').toString('latin1');
      // 復号結果が制御文字だらけなら、元から base64 ではなかったと見て戻す。
      // 記号の無い英数字だけの本文を誤って壊さないための保険。
      const ctrl = (dec.match(/[\x00-\x08\x0e-\x1f]/g) || []).length;
      if (dec && ctrl / dec.length < 0.1) t = dec;
    } catch { /* そのまま */ }
  }
  t = t.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  let s;
  try { s = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(t, 'latin1')); } catch { s = t; }
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function headerOf(raw, name) {
  // m フラグは使わない。$ が行末に当たってしまい、
  // 折り返されたヘッダー（次行が空白始まり）の1行目で切れる。
  // 行頭の判定は ^ ではなく (?:^|\r\n) で行う。
  const re = new RegExp(`(?:^|\\r\\n)${name}:\\s*([\\s\\S]*?)(?=\\r\\n\\S|\\r\\n$|$)`, 'i');
  const m = new TextDecoder('utf-8', { fatal: false }).decode(raw).match(re);
  return m ? m[1].replace(/\r?\n\s+/g, ' ').trim() : '';
}

/* FETCH の応答を1通ずつに束ねる。
   リテラルを「要求した順に2つずつ」取ってはいけない。BODY[1] は
   非マルチパートのメールでは NIL が返り、リテラルが1つしか来ない。
   数で数えると、そこから先は別のメールの本文が別の件名に貼り付く。
   件名と本文が入れ替わった rec が公開の場に出るので、実害がある。

   リテラルは必ず自分の行のテキストに種別を持っている
   （... BODY[HEADER.FIELDS (...)] {123} / ... BODY[1]<0> {456}）ので、
   順番ではなくその名前で振り分ける。 */
function groupFetch(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^\* \d+ FETCH/i.test(l.text)) {
      if (cur) out.push(cur);
      // どちらの検索で引っかかったかを後で見分けるために UID を控える。
      const uid = (l.text.match(/\bUID\s+(\d+)/i) || [])[1] || null;
      cur = { uid, header: null, body: null };
    }
    if (!cur || !l.literal) continue;
    if (/HEADER\.FIELDS/i.test(l.text)) cur.header = l.literal;
    else if (/BODY\[1\]/i.test(l.text)) cur.body = l.literal;
  }
  if (cur) out.push(cur);
  return out;
}

async function collectAccount({ email, pass }) {
  const sock = await connect(HOST, PORT);
  const c = client(sock);
  await c.greeting;

  try {
    const login = await c.send(`LOGIN ${quote(email)} ${quote(pass)}`);
    if (!/^\S+ OK/i.test(login.tagLine)) {
      // サーバーの文言をそのまま出すとアドレスが混ざることがあるので種別だけ返す。
      const why = /AUTHENTICATIONFAILED|Invalid credentials/i.test(login.tagLine)
        ? 'アプリパスワードが違うか、2段階認証が無効です'
        : /Application-specific password required/i.test(login.tagLine)
          ? '通常のパスワードでは入れません。アプリパスワードを発行してください'
          : 'LOGIN が拒否されました';
      throw new Error(why);
    }

    // 「すべてのメール」の名前は言語設定で変わる（[Gmail]/All Mail /
    // [Gmail]/すべてのメール）。名前で決め打ちせず \All 属性で選ぶ。
    const list = await c.send('LIST "" "*"');
    const allBox = list.lines
      .filter((l) => l.text.startsWith('* LIST') && /\\All/i.test(l.text))
      .map((l) => (l.text.match(/"([^"]+)"\s*$/) || [])[1])
      .find(Boolean) || 'INBOX';

    const sel = await c.send(`SELECT ${quote(allBox)}`);
    if (!/^\S+ OK/i.test(sel.tagLine)) throw new Error(`メールボックスを開けません（${allBox}）`);

    /* 2経路を順に引く。お得情報（promotions＋販促語）と、
       対応が要るもの（件名に依頼の語）。同じメールが両方に出ることも
       あるが、build-recs がタイトルで重複を除く。 */
    async function search(q, cap) {
      const res = await c.send(`UID SEARCH X-GM-RAW ${quote(q)}`);
      const hits = (res.lines.find((l) => /^\* SEARCH/i.test(l.text))?.text || '')
        .replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean);
      // 新しいものから。UID は増加するので末尾が最新。
      return hits.slice(-cap).reverse();
    }

    const promoUids = await search(QUERY, PER_ACCOUNT);
    const actionUids = await search(ACTION_QUERY, ACTION_PER_ACCOUNT);
    // 同じ UID が両方に出たら1回だけ取る。
    const actionSet = new Set(actionUids);
    const uids = [...new Set([...promoUids, ...actionUids])];
    if (!uids.length) return { email, scanned: 0, kept: 0, promo: 0, action: 0, items: [] };

    const fetched = await c.send(
      // DATE と FROM は LLM 判定に渡す。「9月29日まで」のように年が
      // 書かれていない期限を、受信日を起点に解釈させるために要る。
      `UID FETCH ${uids.join(',')} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE LIST-UNSUBSCRIBE MESSAGE-ID)] BODY.PEEK[1]<0.3000>)`,
    );

    const items = [];
    // キーワードで捨てる前の全件。LLM 判定はこちらを見る。
    // 語の一覧に無いという理由で消えたメールを拾い直せるようにするため、
    // 判定と収集を分けている。
    const pool = [];
    let promo = 0;
    let action = 0;
    for (const rec of groupFetch(fetched.lines)) {
      if (!rec.header) continue;
      const raw = rec.header;
      const subject = decodeWords(headerOf(raw, 'Subject'));
      const item = {
        subject,
        snippet: rec.body ? snippetFrom(rec.body) : '',
        bulk: Boolean(headerOf(raw, 'List-Unsubscribe')),
        messageId: headerOf(raw, 'Message-ID'),
        from: decodeWords(headerOf(raw, 'From')),
        date: headerOf(raw, 'Date'),
      };
      if (!item.subject) continue;
      pool.push(item);

      /* お得情報の判定は OAuth 版と共有する（片方だけ緩むのを防ぐため）。
         そこを通らなかったものだけ、対応が要るかを見る。
         販促の判定を先にするのは、両方に当てはまるメール——
         「キャンペーンのご案内、ご確認ください」のようなもの——を
         お金として扱いたいため。 */
      if (keep(item)) {
        items.push({
          key: 'メール',
          category: 'お金',
          icon: '📧',
          title: item.subject.slice(0, 90),
          desc: item.snippet,
          url: mailAppUrl(item.messageId),
          via: 'gmail',
        });
        promo += 1;
      } else if (rec.uid && actionSet.has(rec.uid) && keepAction(item.subject)) {
        items.push({
          key: 'メール',
          // 販促ではなく、返事や手続きが要るもの。カテゴリを分けておくと
          // 一覧で混ざらず、学習の重みも別々に効く。
          category: '契約・手続き',
          icon: '✉️',
          title: item.subject.slice(0, 90),
          desc: item.snippet,
          url: mailAppUrl(item.messageId),
          via: 'gmail',
        });
        action += 1;
      }
    }

    return { email, scanned: uids.length, kept: items.length, promo, action, items, pool };
  } finally {
    try { await c.send('LOGOUT'); } catch { /* 閉じるだけ */ }
    sock.destroy();
  }
}

/** 判定済みの記録を読む。壊れていても落とさず、空から始める。 */
async function readCache() {
  try {
    const c = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    return c && typeof c === 'object' && c.byMessageId ? c.byMessageId : {};
  } catch { return {}; }
}

/** 古い記録を落として書き戻す。放っておくと際限なく増えるため。 */
async function writeCache(byMessageId) {
  const cutoff = Date.now() - CACHE_KEEP_DAYS * 86400000;
  const kept = {};
  for (const [k, v] of Object.entries(byMessageId)) {
    const at = Date.parse(v && v.at);
    if (Number.isFinite(at) && at < cutoff) continue;
    kept[k] = v;
  }
  await writeFile(CACHE_FILE, JSON.stringify({ byMessageId: kept }, null, 2));
  return Object.keys(kept).length;
}

const ICON = {
  お金: '💰', '契約・手続き': '✉️', グルメ: '🍽️', おでかけ: '🗺️',
  ショッピング: '🛍️', エンタメ: '🎬', ポイ活: '🎁', その他: '📧',
};

/** JST の今日を YYYY-MM-DD で。サーバのTZに依存させない。 */
export function todayJst(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * 判定結果を recs の材料の形に直す。skip は捨てる。
 *
 * ★期限切れのお得情報は出さない★
 * 収集は10日窓なので、締め切りが過ぎたセールやキャンペーンが混ざる。
 * 実際に 9/15・9/17 締め切りのものが候補に並んだ（2026-09-23 の実行）。
 * 応募できないものを出しても選ぶ手間が増えるだけなので落とす。
 * 一方、要対応（todo）は期限が過ぎていても残す。未払いの支払いは
 * 期限を過ぎたからこそ知らせる必要がある。
 */
export function toItem(v, today = todayJst()) {
  if (v.action === 'skip') return null;
  if (v.action === 'deal' && v.deadline && v.deadline < today) return null;
  return {
    key: 'メール',
    category: v.action === 'todo' ? (v.category === 'お金' ? 'お金' : '契約・手続き') : v.category,
    icon: ICON[v.category] || '📧',
    title: String(v.title || v.subject).slice(0, 90),
    // ★既に行動形になっていることを伝える★
    // 判定は「〜を支払う」のような行動が分かる形でタイトルを返す。
    // 選別側がもう一度語尾を足すと「〜を支払うをチェックする」になる
    // （実際に発生）。語尾の一覧を増やして対応しようとすると、
    // キーワード照合と同じで別の動詞が出るたびに破れる。印を付けて渡す。
    titleIsAction: true,
    desc: v.snippet,
    url: mailAppUrl(v.messageId),
    via: 'gmail',
    // 期限が読み取れたものはタスクの期限として使う。
    // Slack のリマインドがこれを見るので、支払期日が鳴るようになる。
    ...(v.deadline ? { deadline: v.deadline } : {}),
    reason: v.reason,
  };
}

/**
 * 取得した全件を LLM に読ませて判定する。
 *
 * ★キーワード判定は残す★
 * ここが落ちても収集が丸ごと無に帰さないよう、失敗時は従来の結果を使う。
 * LLM を足したせいで、それまで拾えていたものまで消えるのが一番困る。
 */
async function classifyPool(pool, keywordItems) {
  const cache = await readCache();
  const today = new Date().toISOString().slice(0, 10);

  const fresh = [];
  const cached = [];
  for (const m of pool) {
    const hit = m.messageId && cache[m.messageId];
    if (hit) cached.push({ ...m, ...hit });
    else fresh.push(m);
  }

  const est = estimateCost(fresh.length, CLASSIFY_MODEL);
  console.log(`\n判定: ${pool.length}件中 ${cached.length}件は記録済み、${fresh.length}件を判定`);
  console.log(`  モデル: ${CLASSIFY_MODEL}（${est.batches}回に分割）`);
  console.log(`  見積もり: 約 $${est.usd.toFixed(3)}${CLASSIFY === 'validate' ? '（validate なので実際には呼びません）' : ''}`);

  let results = [];
  try {
    const r = await classify(fresh, {
      today,
      model: CLASSIFY_MODEL,
      apiKey: credential(),
      callsApi: CLASSIFY === 'live',
    });
    results = r.results;
    if (r.missing) console.log(`  ⚠️ ${r.missing}件は判定が返りませんでした`);
  } catch (e) {
    console.error(`  ⚠️ 判定に失敗: ${e.message}`);
    console.error('     キーワード判定の結果をそのまま使います。');
    return { items: keywordItems, used: 'keyword' };
  }

  for (const v of results) {
    if (!v.messageId) continue;
    cache[v.messageId] = {
      action: v.action, title: v.title, category: v.category,
      deadline: v.deadline, reason: v.reason, at: new Date().toISOString(),
    };
  }
  const size = await writeCache(cache);

  const all = [...cached, ...results];
  /* ★map に関数をそのまま渡さない★
     Array.map は (要素, 添字, 配列) を渡すので、`all.map(toItem)` と書くと
     toItem の第2引数 today に添字（数値）が入る。文字列の日付と数値を
     比べても常に false になり、期限切れの除外が丸ごと効かなくなる。
     実際に 9/15・9/17 締め切りのものが候補に残った（2026-09-23）。
     引数を明示して渡すこと。 */
  const items = all.map((v) => toItem(v, today)).filter(Boolean);
  const byAction = {};
  for (const v of all) byAction[v.action] = (byAction[v.action] || 0) + 1;
  console.log(`  内訳: 要対応 ${byAction.todo || 0} / お得 ${byAction.deal || 0} / 対象外 ${byAction.skip || 0}`);
  console.log(`  記録: ${size}件を保持`);

  return { items, used: 'llm' };
}

async function main() {
  console.log('=== Gmail から recs の材料を収集（IMAP・読み取り専用・課金なし）===');
  console.log(`検索条件: ${QUERY}`);
  console.log('※ 販促カテゴリに限定。BODY.PEEK なので既読になりません。件名や本文はログに出しません\n');

  const list = accounts();
  warnIfTruncated(list);
  if (!list.length) {
    console.error('❌ GMAIL_IMAP_ACCOUNTS が未設定です。');
    console.error('   mac/.env に "アドレス:アプリパスワード" をカンマ区切りで書いてください。');
    console.error('   手順: docs/gmail-setup.md');
    process.exit(1);
  }

  const keywordItems = [];
  const pool = [];
  let failures = 0;
  let promoTotal = 0;
  let actionTotal = 0;

  for (const acc of list) {
    // ログに出すのはドメインだけ。どのアカウントが落ちたかの切り分けには足りる。
    const domain = acc.email.split('@')[1] || '不明';
    try {
      const r = await collectAccount(acc);
      console.log(`  @${domain}: ${r.scanned}件を確認 → ${r.kept}件を採用（お得 ${r.promo} / 要対応 ${r.action}）`);
      promoTotal += r.promo || 0;
      actionTotal += r.action || 0;
      keywordItems.push(...r.items);
      pool.push(...(r.pool || []));
    } catch (e) {
      failures += 1;
      console.error(`  ⚠️ @${domain}: ${e.message}`);
    }
  }

  console.log(`\nキーワード判定: ${keywordItems.length}件 — お得 ${promoTotal} / 要対応 ${actionTotal}`);

  // LLM 判定を使うなら、キーワードで絞る前の全件を読ませて置き換える。
  // off のときは何も呼ばないので、従来と全く同じ動きになる。
  let source = 'keyword';
  let picked = keywordItems;
  if (CLASSIFY !== 'off') {
    const c = await classifyPool(pool, keywordItems);
    picked = c.items;
    source = c.used;
  }

  // タイトルで重複を除く。アカウントをまたいで同じ案内が届くため。
  const all = [];
  const seen = new Set();
  for (const it of picked) {
    const k = String(it.title).toLowerCase().replace(/\s/g, '');
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(it);
  }

  console.log(`\n合計 ${all.length}件（重複除去後・判定は ${source}）`);

  // 判定より先に書く。採れた分を捨てず、古いファイルを残さないため
  // （理由は collect-gmail.mjs の同じ箇所に書いた）。
  //
  // ★書き先は OAuth 版と分ける★
  //   同じ collected-gmail.json に書くと、後から走ったほうが前を消す。
  //   併用（OAuth と IMAP を両方走らせて合流させる）では、それぞれの
  //   結果が残らないと片方のアカウントが丸ごと落ちる。
  //   build-recs.mjs は両方を材料として読み、タイトルで重複を除く。
  await writeFile(OUT_FILE, JSON.stringify({
    collectedAt: new Date().toISOString(),
    method: 'imap',
    query: QUERY,
    counts: { total: all.length, accounts: list.length, failures, promo: promoTotal, action: actionTotal },
    items: all,
  }, null, 2));
  console.log(`📦 ${OUT_FILE} に保存`);

  // 過半数が落ちたら失敗として返す。OAuth 版と同じ規則に揃える。
  if (failures * 2 > list.length) {
    console.error(`\n❌ ${list.length}アカウント中 ${failures}件で失敗しました。`);
    console.error('   2段階認証が有効か、アプリパスワードが正しいかを確認してください。');
    console.error('   手順: docs/gmail-setup.md');
    process.exit(1);
  }
  if (failures) {
    console.warn(`\n⚠️ ${failures}件のアカウントで失敗しましたが、過半数は採れているので続けます。`);
  }

  /* ★課金の有無は「設定」ではなく「実際に呼べたか」で判定する★
     IMAP の読み取りは無料、LLM 判定は有料。区別せず $0 と書いていると
     課金が始まったことに気づけない。一方 CLASSIFY=live でも、判定が
     404 や認証切れで落ちればキーワードに後退して課金は発生しない。
     設定を見て「課金あり」と書くと、今度は逆に嘘になる。
     結果（source）を見ること。 */
  console.log(source === 'llm'
    ? '=== 完了（LLM 判定を実行したため課金あり）==='
    : '=== 完了・課金は発生していません（$0）===');
}

const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'collect-gmail-imap.mjs') {
  main().catch((e) => { console.error('❌ 失敗:', e.message); process.exit(1); });
}

export { decodeWords, snippetFrom, headerOf, accounts, warnIfTruncated, scan, groupFetch, QUERY };
