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
//                          例: a@gmail.com:abcdefghijklmnop,b@gmail.com:qrstuvwxyzabcdef
//                          アプリパスワードの空白は取り除いてよい
//
// 実行: node scripts/collect-gmail-imap.mjs

import { writeFile } from 'node:fs/promises';
import tls from 'node:tls';
import { keep, mailAppUrl } from './collect-gmail.mjs';

const HOST = process.env.GMAIL_IMAP_HOST || 'imap.gmail.com';
const PORT = Number(process.env.GMAIL_IMAP_PORT || 993);
const MAX_AGE_DAYS = Number(process.env.GMAIL_MAX_AGE_DAYS || 10);
const PER_ACCOUNT = Number(process.env.GMAIL_PER_ACCOUNT || 40);
const TIMEOUT_MS = Number(process.env.GMAIL_IMAP_TIMEOUT_MS || 30000);

// OAuth 版と同じ検索条件。X-GM-RAW は Gmail の検索構文をそのまま受ける。
const QUERY = `category:promotions newer_than:${MAX_AGE_DAYS}d -is:chat`;

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

    const search = await c.send(`UID SEARCH X-GM-RAW ${quote(QUERY)}`);
    const hits = (search.lines.find((l) => /^\* SEARCH/i.test(l.text))?.text || '')
      .replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean);
    // 新しいものから。UID は増加するので末尾が最新。
    const uids = hits.slice(-PER_ACCOUNT).reverse();
    if (!uids.length) return { email, scanned: 0, kept: 0, items: [] };

    const fetched = await c.send(
      `UID FETCH ${uids.join(',')} (BODY.PEEK[HEADER.FIELDS (SUBJECT LIST-UNSUBSCRIBE MESSAGE-ID)] BODY.PEEK[1]<0.3000>)`,
    );

    // リテラルは要求した順に並ぶ: ヘッダー → 本文の先頭。
    const items = [];
    const lits = fetched.lines.filter((l) => l.literal);
    for (let i = 0; i + 1 < lits.length; i += 2) {
      const raw = lits[i].literal;
      const subject = decodeWords(headerOf(raw, 'Subject'));
      const item = {
        subject,
        snippet: snippetFrom(lits[i + 1].literal),
        bulk: Boolean(headerOf(raw, 'List-Unsubscribe')),
        messageId: headerOf(raw, 'Message-ID'),
      };
      if (!item.subject) continue;
      // 判定は OAuth 版と共有する。片方だけ緩むのを防ぐため。
      if (!keep(item)) continue;
      items.push({
        key: 'メール',
        category: 'お金',
        icon: '📧',
        title: item.subject.slice(0, 90),
        desc: item.snippet,
        url: mailAppUrl(item.messageId),
        via: 'gmail',
      });
    }

    return { email, scanned: uids.length, kept: items.length, items };
  } finally {
    try { await c.send('LOGOUT'); } catch { /* 閉じるだけ */ }
    sock.destroy();
  }
}

async function main() {
  console.log('=== Gmail から recs の材料を収集（IMAP・読み取り専用・課金なし）===');
  console.log(`検索条件: ${QUERY}`);
  console.log('※ 販促カテゴリに限定。BODY.PEEK なので既読になりません。件名や本文はログに出しません\n');

  const list = accounts();
  if (!list.length) {
    console.error('❌ GMAIL_IMAP_ACCOUNTS が未設定です。');
    console.error('   mac/.env に "アドレス:アプリパスワード" をカンマ区切りで書いてください。');
    console.error('   手順: docs/gmail-setup.md');
    process.exit(1);
  }

  const all = [];
  const seen = new Set();
  let failures = 0;

  for (const acc of list) {
    // ログに出すのはドメインだけ。どのアカウントが落ちたかの切り分けには足りる。
    const domain = acc.email.split('@')[1] || '不明';
    try {
      const r = await collectAccount(acc);
      console.log(`  @${domain}: ${r.scanned}件を確認 → ${r.kept}件を採用`);
      for (const it of r.items) {
        const k = it.title.toLowerCase().replace(/\s/g, '');
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(it);
      }
    } catch (e) {
      failures += 1;
      console.error(`  ⚠️ @${domain}: ${e.message}`);
    }
  }

  console.log(`\n合計 ${all.length}件（重複除去後）`);

  if (failures === list.length) {
    console.error('\n❌ 全アカウントで失敗しました。');
    console.error('   2段階認証が有効か、アプリパスワードが正しいかを確認してください。');
    console.error('   手順: docs/gmail-setup.md');
    process.exit(1);
  }

  // 出力先も形も OAuth 版と同じ。build-recs.mjs は変更なしで読める。
  await writeFile('collected-gmail.json', JSON.stringify({
    collectedAt: new Date().toISOString(),
    query: QUERY,
    counts: { total: all.length, accounts: list.length, failures },
    items: all,
  }, null, 2));

  console.log('📦 collected-gmail.json に保存');
  console.log('=== 完了・課金は発生していません（$0）===');
}

const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'collect-gmail-imap.mjs') {
  main().catch((e) => { console.error('❌ 失敗:', e.message); process.exit(1); });
}

export { decodeWords, snippetFrom, headerOf, accounts, scan, QUERY };
