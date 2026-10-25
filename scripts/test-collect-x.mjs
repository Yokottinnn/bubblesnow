// collect-x.mjs の見出し抽出を通信なしで検証する。
//
// 装飾絵文字・記号だけの行を見出しに選んでしまうと、recs の一覧が
// 「🎪08.23(sun)°🌙 •┈˙˚ʚ♡ɞ˚˙┈• 再掲」のような意味不明な文字列だらけになる。
// import するだけでは main() が走らないよう collect-x.mjs 側にガードを入れてある。
//
// 実行: node scripts/test-collect-x.mjs

import { toTitle, TOPICS } from './collect-x.mjs';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log(`  OK   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n       got:  ${g}\n       want: ${w}`); }
}

console.log('── 見出し抽出: 装飾行を飛ばして内容のある行を拾うか ──');
eq('日付+記号の飾り行は飛ばして次の行を拾う',
  toTitle('🎪08.23(sun)°🌙 •┈˙˚ʚ♡ɞ˚˙┈• 再掲\nイベント開催します！詳細はこちら'),
  'イベント開催します！詳細はこちら');
eq('絵文字だけの行は飛ばす',
  toTitle('✨🎉🌟💫\n参加費無料のハッカソンを開催します'),
  '参加費無料のハッカソンを開催します');
eq('1行目が内容のある文章ならそのまま使う',
  toTitle('普通のツイート本文です。キャンペーン実施中！'),
  '普通のツイート本文です。キャンペーン実施中！');
eq('絵文字が混じっていても内容があれば使う',
  toTitle('📢 開催まであと2日！\n渋谷でハッカソンを開催します。参加費無料'),
  '📢 開催まであと2日！');
eq('内容のある行が無ければ最後は元の1行目にフォールバックする',
  toTitle('✨🎉🌟💫✌️🎊'),
  '✨🎉🌟💫✌️🎊');
eq('URLは除去する',
  toTitle('キャンペーン開始しました https://example.com/abc'),
  'キャンペーン開始しました');


console.log('\n── ポイ活: 実際の言い回しの投稿を落とさない ──');
{
  /* 2026-10-25: 「ファンドに出資で PayPayポイント」系が1件も入っていなかった。
     検索語（全語 AND）と、取得後の must の両方を通る必要がある。 */
  const poi = TOPICS.find((t) => t.key === 'ポイ活');
  const sample = '不動産ファンドに10万円出資でPayPayポイント5,000円分もらえる！';
  eq('must を通る', poi.must.some((w) => sample.includes(w)), true);
  eq('出資・ファンドの検索語がある', poi.queries.some((q) => q.includes('ファンド') && q.includes('出資')), true);
  eq('PayPayポイントの検索語がある', poi.queries.some((q) => q.includes('PayPayポイント')), true);
  eq('全検索語に反応の下限と言語指定が付く', poi.queries.every((q) => /min_faves:\d+ lang:ja -filter:retweets$/.test(q)), true);
}
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
