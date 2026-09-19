// remind-deadlines.mjs の判定部分を通信なしで検証する。
//
// ここで潰しておきたいのは、実運用で静かに壊れる類のもの。
//   ① 日付境界  … 実行マシンの TZ が UTC でも JST の「今日」でなければならない
//   ② 取りこぼし … done を除く、期限なしを除く、枠ごとの絞り込み
//   ③ 文面      … 改行入りのタスク名が本文を壊さないこと
//
// 実行: node scripts/test-remind-deadlines.mjs

import {
  daysUntil, todayJst, selectTasks, humanDays, formatTask, buildMessage, stateKey,
  isLinkable, THRESHOLDS, SLOT_KEYS,
} from './remind-deadlines.mjs';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log(`  OK   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n       got:  ${g}\n       want: ${w}`); }
}

function ok(label, cond) { eq(label, !!cond, true); }

console.log('── ① 日数計算と日付境界 ──');
eq('同日は0', daysUntil('2026-09-15', '2026-09-15'), 0);
eq('翌日は1', daysUntil('2026-09-16', '2026-09-15'), 1);
eq('前日は-1', daysUntil('2026-09-14', '2026-09-15'), -1);
eq('月をまたぐ', daysUntil('2026-10-01', '2026-09-15'), 16);
eq('年をまたぐ', daysUntil('2027-01-01', '2026-12-31'), 1);
eq('空文字はnull', daysUntil('', '2026-09-15'), null);
eq('未定義はnull', daysUntil(undefined, '2026-09-15'), null);
eq('書式違いはnull', daysUntil('2026/09/15', '2026-09-15'), null);
eq('日付として不正でもnullにする', daysUntil('abcd-ef-gh', '2026-09-15'), null);

// 実行環境の TZ に引きずられないこと。UTC 15:00 は JST では翌日の 00:00。
eq('UTCの15時はJSTでは翌日', todayJst(new Date('2026-09-15T15:00:00Z')), '2026-09-16');
eq('UTCの14時59分はJSTでは当日', todayJst(new Date('2026-09-15T14:59:59Z')), '2026-09-15');

console.log('\n── ② 抽出ロジック ──');
const today = '2026-09-15';
const sample = [
  { name: '期限切れ', deadline: '2026-09-10', status: 'active' },
  { name: '本日', deadline: '2026-09-15', status: 'active' },
  { name: '明日', deadline: '2026-09-16', status: 'active' },
  { name: '3日後', deadline: '2026-09-18', status: 'active' },
  { name: '7日後', deadline: '2026-09-22', status: 'active' },
  { name: '8日後', deadline: '2026-09-23', status: 'active' },
  { name: '完了済みなので出さない', deadline: '2026-09-15', status: 'done' },
  { name: '期限なしなので出さない', deadline: '', status: 'active' },
  { name: '名前なしは無視', deadline: '2026-09-15', status: 'active', skip: true },
];
delete sample[8].name;

const morning = selectTasks(sample, today, 'morning');
eq('朝は8日後と完了と期限なしを除く5件', morning.map((t) => t.name), ['期限切れ', '本日', '明日', '3日後', '7日後']);
eq('期限が近い順に並ぶ', morning.map((t) => t.days), [-5, 0, 1, 3, 7]);

const evening = selectTasks(sample, today, 'evening');
eq('夕方は期限切れと本日だけ', evening.map((t) => t.name), ['期限切れ', '本日']);

eq('Firebaseがオブジェクトで返しても動く', selectTasks({ a: sample[1], b: sample[2] }, today, 'morning').length, 2);
eq('nullでも落ちない', selectTasks(null, today, 'morning'), []);
eq('配列の穴で落ちない', selectTasks([null, sample[1], undefined], today, 'morning').length, 1);
eq('status未設定はactive扱い', selectTasks([{ name: 'x', deadline: today }], today, 'morning').length, 1);

console.log('\n── ③ 表示 ──');
eq('超過日数', humanDays(-5), '5日超過');
eq('本日', humanDays(0), '本日');
eq('明日', humanDays(1), '明日');
eq('それ以降', humanDays(3), 'あと3日');

eq('改行入りのタスク名は1行に潰す',
  formatTask({ name: '確定申告\nの準備', deadline: '2026-09-15', days: 0 }),
  '• *確定申告 の準備*　_2026-09-15（本日）_');
eq('アイコン・場所・URLが付く',
  formatTask({ name: 'A', deadline: '2026-09-15', days: 0, icon: '🏥', location: '銀座', url: 'https://x.test' }),
  '• 🏥 *A*　_2026-09-15（本日）_　📍銀座　<https://x.test|リンク>');

// 実データで Gmail のメッセージID形式が入っており、Slack で壊れたリンクになった
eq('http/https だけリンクにする', isLinkable('https://x.test'), true);
eq('http も可', isLinkable('http://x.test'), true);
eq('message: は弾く', isLinkable('message:<abc@def.jp>'), false);
eq('mailto: は弾く', isLinkable('mailto:a@b.jp'), false);
eq('スキーム無しは弾く', isLinkable('example.com'), false);
eq('空は弾く', isLinkable(''), false);
eq('undefined は弾く', isLinkable(undefined), false);
eq('javascript: は弾く', isLinkable('javascript:alert(1)'), false);
eq('リンクにできないURLは出力ごと省く',
  formatTask({ name: 'A', deadline: '2026-09-15', days: 0, url: 'message:<abc@def.jp>' }),
  '• *A*　_2026-09-15（本日）_');

console.log('\n── ④ 本文の組み立て ──');
eq('対象ゼロなら送らない（nullを返す）', buildMessage([], { slot: 'morning', today }), null);

const msg = buildMessage(morning, { slot: 'morning', today });
ok('見出しに日付が入る', msg.includes(today));
ok('朝の見出し', msg.startsWith('🌅'));
ok('区分の見出しと件数が入る', msg.includes('*期限切れ*　1件'));
ok('本日の区分が入る', msg.includes('*本日が期限*　1件'));
ok('7日以内の区分が入る', msg.includes('*7日以内*　1件'));
ok('8日後は含まれない', !msg.includes('8日後'));
ok('完了済みは含まれない', !msg.includes('完了済み'));
eq('末尾に余分な空行を残さない', msg.endsWith('\n'), false);

const emsg = buildMessage(evening, { slot: 'evening', today });
ok('夕方の見出し', emsg.startsWith('🌆'));
ok('夕方は明日以降を含まない', !emsg.includes('明日が期限'));

console.log('\n── ⑤ 二重送信の防止 ──');
eq('日付と枠で鍵が決まる', stateKey('2026-09-15', 'morning'), '2026-09-15#morning');
ok('枠が違えば別の鍵', stateKey(today, 'morning') !== stateKey(today, 'evening'));
ok('日が違えば別の鍵', stateKey('2026-09-15', 'morning') !== stateKey('2026-09-16', 'morning'));

console.log('\n── ⑥ 設定の整合 ──');
const keys = THRESHOLDS.map((b) => b.key);
for (const [slot, allowed] of Object.entries(SLOT_KEYS)) {
  const unknown = allowed.filter((k) => !keys.includes(k));
  eq(`${slot} の対象区分は全て定義済み`, unknown, []);
}
// 残り日数がどの区分にも属さない穴が無いこと（0〜7日は必ずどれかに入る）
for (let d = -3; d <= 7; d += 1) {
  ok(`残り${d}日はいずれかの区分に入る`, THRESHOLDS.some((b) => b.match(d)));
}
// 区分が重複しないこと（重複すると同じタスクが2回出る）
for (let d = -3; d <= 7; d += 1) {
  eq(`残り${d}日が属する区分は1つだけ`, THRESHOLDS.filter((b) => b.match(d)).length, 1);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
