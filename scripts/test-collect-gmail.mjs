// collect-gmail.mjs の判断部分を通信なしで検証する。
//
// 実行: node scripts/test-collect-gmail.mjs

import { keep, gmailUrl, mailAppUrl, QUERY } from './collect-gmail.mjs';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log(`  OK   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n       got:  ${g}\n       want: ${w}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

console.log('── Gmail の permalink 生成 ──');
eq('メールアドレスを authuser に付けてメール本体へ飛ぶ',
  gmailUrl('user@example.com', '18d1f2a3b4c5d6e7'),
  'https://mail.google.com/mail/?authuser=user%40example.com#all/18d1f2a3b4c5d6e7');
eq('メールアドレスが取れないときは authuser を省く',
  gmailUrl('', '18d1f2a3b4c5d6e7'),
  'https://mail.google.com/mail/#all/18d1f2a3b4c5d6e7');

console.log('\n── iOS メールアプリの message: リンク生成 ──');
eq('Message-ID をそのまま URL エンコードして message: を付ける',
  mailAppUrl('<CAOU_x123@mail.gmail.com>'),
  'message:%3CCAOU_x123%40mail.gmail.com%3E');
eq('Message-ID が無ければ空文字（呼び出し側で gmailUrl にフォールバック）',
  mailAppUrl(''),
  '');

console.log('\n── 一斉配信メールだけを対象にする（既存の判定を壊していないか） ──');
ok('検索条件は promotions カテゴリ限定のまま', QUERY.includes('category:promotions'));
ok('List-Unsubscribe があり販促語を含めば残す', keep({ subject: '', snippet: 'キャンペーン実施中', bulk: true }));
ok('List-Unsubscribe が無ければ落とす（個人宛ての保険）', !keep({ subject: '', snippet: 'キャンペーン実施中', bulk: false }));
ok('請求書は落とす', !keep({ subject: '', snippet: 'ご請求書のお知らせ キャンペーン', bulk: true }));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
