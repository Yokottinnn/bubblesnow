// collect-gmail-imap.mjs のパース部分をオフラインで検証する。
//
// クラウドのセッションからは Gmail に届かない（egress で塞がれている）ので、
// 実接続では確かめられない。壊れていても「0件でした」に見えてしまい、
// 気づくのは何日も後になる。だから危ないところは全部ここで固定する。
//
// 特に scan() は、リテラルの中に CRLF や "a5 OK" に見える並びが入りうる。
// 単純な行分割だと応答の終端を誤判定して、件名の途中でちぎれる。
// 実際のメールには HTML も base64 も入るので、これは起こる前提で書いてある。
//
// 実行: node scripts/test-collect-gmail-imap.mjs

import { decodeWords, snippetFrom, headerOf, accounts, scan, groupFetch, keepAction } from './collect-gmail-imap.mjs';
import { keep } from './collect-gmail.mjs';

let pass = 0;
const fails = [];

function eq(name, got, want) {
  if (got === want) { pass += 1; return; }
  fails.push(`${name}\n    期待: ${JSON.stringify(want)}\n    実際: ${JSON.stringify(got)}`);
}
function ok(name, cond) { eq(name, Boolean(cond), true); }

/* ── scan（IMAP 応答の終端判定）── */
{
  const body = 'これは本文\r\na9 OK にせものの完了行\r\n';
  const lit = Buffer.from(body, 'utf8');
  const buf = Buffer.concat([
    Buffer.from(`* 1 FETCH (BODY[1] {${lit.length}}\r\n`, 'latin1'),
    lit,
    Buffer.from(')\r\na1 OK Success\r\n', 'latin1'),
  ]);

  const r = scan(buf, 'a1');
  ok('リテラル内の偽の完了行で終端を誤判定しない', r.done);
  eq('本物のタグ行で終わる', r.tagLine, 'a1 OK Success');
  const got = r.lines.find((l) => l.literal);
  eq('リテラルを丸ごと取り出せる', got.literal.toString('utf8'), body);
}
{
  // まだ全部届いていない状態では done にしない（途中で処理すると欠ける）
  const buf = Buffer.from('* 1 FETCH (BODY[1] {50}\r\nまだ足りない', 'latin1');
  eq('リテラルが届き切るまで待つ', scan(buf, 'a1').done, false);
}
{
  const buf = Buffer.from('* SEARCH 1 2 3\r\n', 'latin1');
  eq('完了行が無ければ待つ', scan(buf, 'a1').done, false);
}

/* ── groupFetch（1通ずつに束ねる）──
   ここが最も壊れやすい。BODY[1] は非マルチパートのメールでは NIL が返り、
   リテラルが1つしか来ない。「2つずつ」で数えると、そこから先は
   別のメールの本文が別の件名に貼り付く。件名と本文が入れ替わった rec が
   公開の場に出るので、静かに間違うぶん一番たちが悪い。 */
{
  const H = (n) => ({ text: `* ${n} FETCH (UID ${n} BODY[HEADER.FIELDS (SUBJECT)] {9}`, literal: Buffer.from(`h${n}`) });
  const B = (n) => ({ text: ' BODY[1]<0> {9}', literal: Buffer.from(`b${n}`) });
  const close = { text: ')', literal: null };

  // 2通目だけ本文が無い（＝実際に起きるケース）
  const lines = [H(1), B(1), close, H(2), close, H(3), B(3), close];
  const recs = groupFetch(lines);

  eq('3通に束ねる', recs.length, 3);
  eq('1通目の本文', recs[0].body.toString(), 'b1');
  eq('本文の無い通は body が null', recs[1].body, null);
  eq('本文の無い通でもヘッダーは取れる', recs[1].header.toString(), 'h2');
  // ここが本題。ずれていれば 3通目の本文が b1 になる。
  eq('本文が欠けても後続がずれない', recs[2].body.toString(), 'b3');
  eq('後続のヘッダーもずれない', recs[2].header.toString(), 'h3');
}

/* ── decodeWords（件名のデコード）── */
{
  const b64 = Buffer.from('【緊急】ポイント還元キャンペーン', 'utf8').toString('base64');
  eq('UTF-8 Base64 の件名',
    decodeWords(`=?UTF-8?B?${b64}?=`), '【緊急】ポイント還元キャンペーン');

  // 長い件名は複数の encoded-word に割られて届く。間の空白は本来の空白ではない。
  const a = Buffer.from('最大50%', 'utf8').toString('base64');
  const b = Buffer.from('還元セール', 'utf8').toString('base64');
  eq('分割された件名をつなぐ',
    decodeWords(`=?UTF-8?B?${a}?= =?UTF-8?B?${b}?=`), '最大50%還元セール');

  eq('Quoted-Printable の件名',
    decodeWords('=?UTF-8?Q?=E3=82=BB=E3=83=BC=E3=83=AB?='), 'セール');
  eq('Q エンコードの _ は空白',
    decodeWords('=?UTF-8?Q?Big_Sale?='), 'Big Sale');
  eq('素の ASCII はそのまま', decodeWords('Plain Subject'), 'Plain Subject');
  eq('壊れた encoded-word で例外にしない',
    typeof decodeWords('=?UTF-8?B?こわれてる?='), 'string');
}

/* ── headerOf（折り返しヘッダー）── */
{
  const raw = Buffer.from(
    'Subject: 前半\r\n 後半\r\nList-Unsubscribe: <https://example.com/u>\r\nMessage-ID: <abc@x>\r\n',
    'utf8',
  );
  eq('折り返された Subject をつなぐ', headerOf(raw, 'Subject'), '前半 後半');
  eq('List-Unsubscribe を拾う', headerOf(raw, 'List-Unsubscribe'), '<https://example.com/u>');
  eq('Message-ID を拾う', headerOf(raw, 'Message-ID'), '<abc@x>');
  eq('無いヘッダーは空', headerOf(raw, 'X-Nope'), '');
}

/* ── snippetFrom（本文の先頭）── */
{
  const b64 = Buffer.from('本文のテキストです', 'utf8').toString('base64');
  eq('base64 の本文を戻す', snippetFrom(Buffer.from(b64, 'latin1')), '本文のテキストです');

  // latin1 の Buffer に日本語をそのまま入れると 1 バイトに潰れる（中 → '-'）。
  // 実際の受信バイト列に合わせて、QP 部分と生の UTF-8 を連結して作る。
  eq('quoted-printable の本文を戻す',
    snippetFrom(Buffer.concat([
      Buffer.from('=E3=82=BB=E3=83=BC=E3=83=AB=\r\n', 'latin1'),
      Buffer.from('中', 'utf8'),
    ])), 'セール中');

  eq('HTML のタグを落とす',
    snippetFrom(Buffer.from('<p>お得な<b>情報</b></p>', 'utf8')), 'お得な 情報');

  eq('style/script の中身は捨てる',
    snippetFrom(Buffer.from('<style>.a{color:red}</style><p>本文</p>', 'utf8')), '本文');

  ok('長い本文は 300 字で止める',
    snippetFrom(Buffer.from('あ'.repeat(2000), 'utf8')).length === 300);
}

/* ── accounts（mac/.env の読み取り）── */
{
  const before = process.env.GMAIL_IMAP_ACCOUNTS;

  process.env.GMAIL_IMAP_ACCOUNTS = 'a@gmail.com:abcd efgh ijkl mnop';
  const one = accounts();
  eq('貼り付けた空白入りのアプリパスワードを詰める', one[0].pass, 'abcdefghijklmnop');
  eq('アドレスを取り出す', one[0].email, 'a@gmail.com');

  process.env.GMAIL_IMAP_ACCOUNTS = 'a@x.com:pass1, b@y.com:pass2 ,c@z.com:pass3';
  eq('3アカウントを読む', accounts().length, 3);

  process.env.GMAIL_IMAP_ACCOUNTS = 'こわれた,a@x.com:p';
  eq('コロンの無い行は捨てる', accounts().length, 1);

  process.env.GMAIL_IMAP_ACCOUNTS = '';
  eq('未設定なら 0 件', accounts().length, 0);

  if (before === undefined) delete process.env.GMAIL_IMAP_ACCOUNTS;
  else process.env.GMAIL_IMAP_ACCOUNTS = before;
}

/* ── keep（OAuth 版と同じ判定を使えているか）──
   ここが緩むと個人的なメールの件名が公開の rec に載る。
   IMAP 版で独自に書き直していないことを、実際に呼んで確かめる。 */
{
  ok('販促は通す',
    keep({ subject: '春のポイント還元キャンペーン', snippet: '', bulk: true }));
  ok('List-Unsubscribe が無ければ落とす',
    !keep({ subject: '春のポイント還元キャンペーン', snippet: '', bulk: false }));
  ok('請求は落とす',
    !keep({ subject: 'ご請求のお知らせ クーポン同封', snippet: '', bulk: true }));
  ok('本人確認は落とす',
    !keep({ subject: '認証コードのお知らせ', snippet: 'キャンペーン', bulk: true }));
  ok('販促語が無ければ落とす',
    !keep({ subject: '今週のニュースレター', snippet: '', bulk: true }));
}

/* ── keepAction（対応が要るメールの判定）──
   実際に取りこぼした件名から作ったテスト。保険マンモスからの
   「面談場所に関するご相談」が三重に落とされていた——promotions に
   入らない・「様へ」で DENY・販促語が無いので MUST 不成立。
   お得情報の経路とは別に、返事が要るものを拾う経路が要る。

   判定は件名だけを見る。本文まで見るとメルマガの定型文がほぼ全部
   引っかかるので、精度はここで決まる。 */
{
  // 拾うべきもの
  ok('面談場所のご相談を拾う',
    keepAction('■保険マンモスより横田様へ（お客様ＩＤ：1432541）※面談場所に関するご相談※'));
  ok('提出期限を拾う', keepAction('【重要】ご提出書類の期限について'));
  ok('日程調整を拾う', keepAction('日程調整のお願い'));
  ok('返信依頼を拾う', keepAction('先日の件、ご返信いただけますでしょうか'));
  ok('手続きを拾う', keepAction('お手続きが完了していません'));

  // 落とすべきもの
  ok('販促は拾わない（お得の経路が扱う）', !keepAction('春のポイント還元キャンペーン開催中！'));
  ok('発送通知は拾わない', !keepAction('【楽天市場】商品を発送しました'));
  ok('決済完了は拾わない', !keepAction('お支払い完了のお知らせ'));
  ok('認証コードは拾わない', !keepAction('認証コード: 483920'));
  ok('パスワード再設定は拾わない', !keepAction('パスワードの再設定について'));
  ok('メルマガは拾わない', !keepAction('メールマガジン第120号 今週のご案内'));
  ok('自動返信は拾わない', !keepAction('自動返信: お問い合わせありがとうございます'));
  ok('空の件名は拾わない', !keepAction(''));
  ok('依頼の語が無ければ拾わない', !keepAction('本日のニュースまとめ'));
}

console.log(`\n${pass}件 通過 / ${fails.length}件 失敗`);
if (fails.length) {
  console.error('\n失敗:');
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✅ すべて通りました');
