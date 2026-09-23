// classify-mail.mjs を通信なしで検証する。
//
// ここで守りたいのは、判定が静かに壊れて「全部どうでもいい」と
// 見なされる状態にならないこと。
//   ① プロンプト … 判定に必要な材料が本文に載っているか
//   ② 突き合わせ … 応答が乱れても、読めたぶんは救えるか
//   ③ 取りこぼし … 判定が返らなかったメールを skip 扱いにしていないか
//   ④ 費用       … 実行前に示す見積もりが件数に応じて動くか
//
// ★件名は架空のものを使う★
// このリポジトリは public。実際に届いたメールの件名を置くと購入内容が
// 読み取れてしまうので、言い回しの形だけ同じにした架空の件名で検証する。
//
// 実行: node scripts/test-classify-mail.mjs

import {
  buildUserMessage, buildRequest, mergeVerdicts, extractVerdicts,
  estimateCost, classify, SCHEMA, BODY_CHARS,
} from './classify-mail.mjs';

let pass = 0;
const fails = [];

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log(`  OK   ${label}`); }
  else { fails.push(`${label}\n    期待: ${w}\n    実際: ${g}`); console.log(`  FAIL ${label}`); }
}
function ok(label, cond) { eq(label, !!cond, true); }

const TODAY = '2026-09-23';

// 見本レスポンス（data/sample-mail-verdicts.json）と順番を合わせること。
const MAILS = [
  { subject: '【10月15日まで】ツアー代金の残金お支払い期日のご案内', snippet: '残金のお支払い期日が近づいています', date: '2026-09-23' },
  { subject: '交通系アプリでログインすると500円相当のコインもらえる！', snippet: 'ログインするだけで500円相当のコインを進呈', date: '2026-09-23' },
  { subject: 'ご入金を確認いたしました', snippet: 'お支払いありがとうございました', date: '2026-09-22' },
  { subject: '【ID】認証コードのお知らせ', snippet: '認証コードは123456です', date: '2026-09-22' },
  { subject: '打ち合わせ日程のご相談', snippet: 'ご都合のよい日をお知らせください', date: '2026-09-21' },
  { subject: '年会費のお知らせ', snippet: '11月10日に口座より引き落とされます', date: '2026-09-20' },
  { subject: '今週のおすすめ商品', snippet: '新着アイテムのご紹介です', date: '2026-09-20' },
  { subject: '最大3,000円分の商品券をプレゼント！', snippet: 'ご応募いただいた方から抽選で進呈', date: '2026-09-19' },
];

console.log('── ① プロンプト ──');
{
  const msg = buildUserMessage(MAILS, TODAY);
  ok('本日の日付を渡す（「9月29日まで」を年つきに直すのに要る）', msg.includes(TODAY));
  ok('添字を渡す（応答を元のメールに戻す鍵）', msg.includes('[0]') && msg.includes('[7]'));
  ok('件名を渡す', msg.includes('ツアー代金の残金お支払い期日'));
  ok('本文を渡す（件名だけでは判断できないため）', msg.includes('ログインするだけで500円相当'));
  ok('受信日を渡す', msg.includes('2026-09-19'));

  const long = buildUserMessage([{ subject: 'あ'.repeat(500), snippet: 'い'.repeat(5000) }], TODAY);
  ok('長すぎる本文は切る（費用が件数に比例しなくなるのを防ぐ）', long.length < BODY_CHARS + 1200);
  ok('切ったことが分かる', long.includes('…'));

  const nl = buildUserMessage([{ subject: '改\n行\nあり', snippet: 'body' }], TODAY);
  ok('改行を潰して1行にする（添字の行と混ざらないように）', nl.includes('件名: 改 行 あり'));
  ok('本文が無くても落ちない', buildUserMessage([{ subject: 'のみ' }], TODAY).includes('(なし)'));
}

console.log('\n── ② リクエストの形 ──');
{
  const body = buildRequest(MAILS, TODAY, 'claude-opus-5');
  eq('モデルはそのまま渡す', body.model, 'claude-opus-5');
  ok('構造化出力を指定する', body.output_config.format.type === 'json_schema');
  eq('スキーマを渡す', body.output_config.format.schema, SCHEMA);
  eq('対応モデルには effort を付ける', body.output_config.effort, 'low');

  /* ★effort を受け付けないモデルに付けると 400 になる★
     Haiku 4.5 は effort 非対応。安いモデルに切り替えた瞬間に
     全滅するのを防ぐため、モデルごとに出し分ける。 */
  const haiku = buildRequest(MAILS, TODAY, 'claude-haiku-4-5');
  eq('Haiku には effort を付けない', haiku.output_config.effort, undefined);
  ok('Haiku でも構造化出力は付ける', haiku.output_config.format.type === 'json_schema');

  ok('日付サフィックスの付いたIDを勝手に作らない', !/claude-opus-5-\d{8}/.test(JSON.stringify(body)));
}

console.log('\n── ③ 応答の突き合わせ ──');
{
  const verdicts = [
    { index: 1, action: 'deal', title: 'コインをもらう', category: 'ポイ活', deadline: null, reason: '特典' },
    { index: 0, action: 'todo', title: '残金を支払う', category: 'お金', deadline: '2026-10-15', reason: '期日あり' },
  ];
  const { merged, missing } = mergeVerdicts(MAILS, verdicts);
  eq('判定が返ったぶんだけ返す', merged.length, 2);
  eq('元のメールの情報を保つ', merged[1].subject, MAILS[0].subject);
  eq('判定を付ける', merged[1].action, 'todo');
  eq('期限を取り出す', merged[1].deadline, '2026-10-15');

  /* ★取りこぼしを skip にしない★
     応答が丸ごと壊れたとき、未判定を skip として扱うと
     「全部どうでもいい」と静かに判断したことになる。数えて返す。 */
  eq('判定が返らなかった数を数える', missing, MAILS.length - 2);
  eq('応答が空なら全件を取りこぼしとして数える', mergeVerdicts(MAILS, []).missing, MAILS.length);
  eq('応答が配列でなくても落ちない', mergeVerdicts(MAILS, null).merged, []);

  // 添字が乱れても、読めたものは救う
  const messy = [
    { index: 99, action: 'todo', title: 'x', category: 'お金', deadline: null, reason: '' },
    { index: -1, action: 'todo', title: 'x', category: 'お金', deadline: null, reason: '' },
    { index: 'あ', action: 'todo', title: 'x', category: 'お金', deadline: null, reason: '' },
    { index: 2, action: 'skip', title: '入金通知', category: 'その他', deadline: null, reason: '済み' },
    { index: 2, action: 'todo', title: '重複', category: 'お金', deadline: null, reason: '' },
  ];
  const m2 = mergeVerdicts(MAILS, messy);
  eq('範囲外・重複を捨てて残りを通す', m2.merged.length, 1);
  eq('重複は先に来たほうを採る', m2.merged[0].title, '入金通知');

  eq('知らない判定は skip に倒す', mergeVerdicts(MAILS, [{ index: 0, action: 'なにか' }]).merged[0].action, 'skip');
  eq('壊れた期限は null にする（そのまま通すと期限タスクが狂う）',
    mergeVerdicts(MAILS, [{ index: 0, action: 'todo', deadline: '9月29日' }]).merged[0].deadline, null);
  eq('タイトルが無ければ件名で代える',
    mergeVerdicts(MAILS, [{ index: 0, action: 'todo', deadline: null }]).merged[0].title, MAILS[0].subject);
}

console.log('\n── ④ 応答の取り出し ──');
{
  const msg = { content: [{ type: 'text', text: '{"verdicts":[{"index":0,"action":"todo"}]}' }] };
  eq('本文から取り出す', extractVerdicts(msg).length, 1);
  eq('JSON でなければ空', extractVerdicts({ content: [{ type: 'text', text: 'こんにちは' }] }), []);
  eq('verdicts が無ければ空', extractVerdicts({ content: [{ type: 'text', text: '{"a":1}' }] }), []);
  eq('応答が空でも落ちない', extractVerdicts(null), []);
  eq('thinking ブロックが混ざっても読める',
    extractVerdicts({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"verdicts":[]}' }] }), []);
}

console.log('\n── ⑤ 費用の見積もり ──');
{
  const a = estimateCost(12, 'claude-opus-5');
  const b = estimateCost(120, 'claude-opus-5');
  ok('件数が増えれば費用も増える', b.usd > a.usd);
  ok('Haiku は Opus より安い', estimateCost(12, 'claude-haiku-4-5').usd < a.usd);
  eq('20通ずつまとめる', estimateCost(41).batches, 3);
  eq('0件なら1回も呼ばない', estimateCost(0).batches, 0);
  ok('1日12通なら月2.5ドル未満（Opus）', a.usd * 30 < 2.5);

  /* ★判定済みの記録が費用を決める★
     収集は10日窓なので、記録せず毎回判定し直すと同じメールを
     何度も読ませることになる。1日2回 × 105通で月$33。
     12通だけを判定する前提との差が17倍あるので、
     記録が効かなくなったことに気づけるよう、ここで差を固定しておく。 */
  const noCache = estimateCost(105, 'claude-opus-5').usd * 60;
  const withCache = estimateCost(12, 'claude-opus-5').usd * 30;
  ok('記録が効かないと10倍以上に跳ねる', noCache > withCache * 10);
}

console.log('\n── ⑥ validate では API を呼ばない ──');
{
  let called = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => { called += 1; throw new Error('呼んではいけない'); };
  try {
    const { results, missing } = await classify(MAILS, { today: TODAY, callsApi: false });
    eq('見本レスポンスで全件判定できる', results.length, MAILS.length);
    eq('取りこぼしなし', missing, 0);
    eq('支払期日を todo として拾う', results[0].action, 'todo');
    eq('支払期日から期限を取り出す', results[0].deadline, '2026-10-15');
    eq('ログイン特典を deal として拾う', results[1].action, 'deal');
    eq('入金確認は skip にする', results[2].action, 'skip');
    eq('認証コードは skip にする', results[3].action, 'skip');
    eq('引き落とし予告を todo として拾う', results[5].action, 'todo');
  } finally {
    globalThis.fetch = origFetch;
  }
  eq('通信は一度も発生しない', called, 0);
  eq('0件なら見本も読まない', (await classify([], { today: TODAY, callsApi: false })).results, []);
}

console.log(`\n${pass}件 通過 / ${fails.length}件 失敗`);
if (fails.length) {
  console.error('\n失敗:');
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✅ すべて通りました');
