// build-recs.mjs の判断部分を通信なしで検証する。
//
// スコアリングは「どれを recs に出すか」を決める。ここが狂うと、
// 終わったキャンペーンやまとめ記事が毎日おすすめに並ぶ。
// LLM を使わない以上、この判断の質＝機能の質なので、実物に近い見出しで固定しておく。
//
// 実行: node scripts/test-build-recs.mjs

import { score, extractDeadline, toRec, isDismissed, assignIds } from './build-recs.mjs';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log(`  OK   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n       got:  ${g}\n       want: ${w}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

console.log('── スコアリング: 出すべきものが上に来るか ──');
// 実際に X から取れた形に近いもの
const good = score({ title: 'PayPay、最大20%還元キャンペーンを8月31日まで開催', category: 'お金', url: 'https://example.com/a' });
const vague = score({ title: 'キャンペーンやってます', category: 'お金', url: 'https://example.com/b' });
const listicle = score({ title: '2026年版 ポイ活アプリおすすめ20選', category: 'お金', url: 'https://example.com/c' });
const ended = score({ title: 'キャンペーンは終了しました', category: 'お金', url: 'https://example.com/d' });
const hack = score({ title: '北朝鮮ハッカーが取引所から資産流出、被害を特定', category: 'お金', url: 'https://example.com/e' });

ok('具体的な還元キャンペーンは高得点', good.total >= 8);
ok('曖昧な告知より具体的な方が上', good.total > vague.total);
ok('まとめ記事は負になる', listicle.total < 0);
ok('終了した告知は負になる', ended.total < 0);
ok('被害・流出の話題は負になる', hack.total < 0);

console.log('\n── スコアリング: リンクの扱い ──');
const withUrl = score({ title: 'サウナが新規オープン、8月10日から', category: 'おでかけ', url: 'https://example.com/f' });
const noUrl = score({ title: 'サウナが新規オープン、8月10日から', category: 'おでかけ' });
ok('リンクがある方が上', withUrl.total > noUrl.total);

const moneyNoUrl = score({ title: '最大5000円キャッシュバック実施', category: 'お金' });
const moneyUrl = score({ title: '最大5000円キャッシュバック実施', category: 'お金', url: 'https://example.com/g' });
ok('お金カテゴリでリンク無しは強く減点', moneyUrl.total - moneyNoUrl.total >= 8);

console.log('\n── スコアリング: 反応数 ──');
const quiet = score({ title: 'エアドロップ配布を開始しました', category: 'お金', url: 'https://x.com/i/status/1' });
const loud = score({ title: 'エアドロップ配布を開始しました', category: 'お金', url: 'https://x.com/i/status/1', likes: 5000, reposts: 1000 });
ok('反応が多い方が上', loud.total > quiet.total);
ok('反応ボーナスは3点までで頭打ち', loud.total - quiet.total <= 3);

console.log('\n── 締切の抽出: 読めるものだけ拾う ──');
const now = new Date();
const mm = String(now.getMonth() + 1).padStart(2, '0');
eq('「M月D日まで」を拾う', extractDeadline(`${now.getMonth() + 1}月28日まで開催`), `${now.getFullYear()}-${mm}-28`);
eq('締切が無ければ空', extractDeadline('キャンペーン開催中'), '');
eq('ありえない日付は空', extractDeadline('13月45日まで'), '');
ok('過ぎた月は翌年扱い', extractDeadline('1月5日まで').startsWith(String(now.getMonth() + 1 > 1 ? now.getFullYear() + 1 : now.getFullYear())));

console.log('\n── 整形: 壊れた値を Firebase に入れない ──');
const rec = toRec({
  title: '<b>タグ入り</b>   タイトル',
  desc: 'せつめい',
  category: '存在しないカテゴリ',
  url: 'not-a-url',
  icon: '',
  via: 'search',
});
eq('HTMLタグを除去し空白を畳む', rec.title, 'タグ入り タイトル');
eq('不正なカテゴリは その他 に落とす', rec.category, 'その他');
eq('http で始まらない url は空', rec.url, '');
eq('icon 未指定は既定値', rec.icon, '📌');
eq('X由来は source=x', rec.source, 'x');
eq('RSS由来は source=news', toRec({ title: 'あいうえおかきくけこ', via: 'rss' }).source, 'news');

const near = toRec({ title: `${now.getMonth() + 1}月${String(now.getDate()).padStart(2, '0')}日まで実施`, category: 'お金' });
ok('締切が近ければ 🔴期限迫', near.priority === '🔴期限迫');
eq('締切が無ければ 🟡中', toRec({ title: '普通のおしらせです', category: 'お金' }).priority, '🟡中');

console.log('\n── 却下済みの判定 ──');
ok('完全一致は弾く', isDismissed('楽天ペイ チャージの日エントリー', ['楽天ペイ チャージの日エントリー']));
ok('部分一致も弾く', isDismissed('楽天ペイ チャージの日エントリー開始', ['楽天ペイ チャージの日エントリー']));
ok('短い語では巻き込まない', !isDismissed('サウナ新店オープン', ['サウナ']));
ok('無関係は通す', !isDismissed('全然ちがう見出し', ['楽天ペイ チャージの日エントリー']));

console.log('\n── ID採番: 既存の続きから振る ──');
eq('最大値+1から', assignIds([{ title: 'a' }, { title: 'b' }], [{ id: 'r246' }, { id: 'r254' }]).map((r) => r.id), ['r255', 'r256']);
eq('既存が空なら r1 から', assignIds([{ title: 'a' }], []).map((r) => r.id), ['r1']);
eq('rNNN 以外の id は無視', assignIds([{ title: 'a' }], [{ id: 'weird' }]).map((r) => r.id), ['r1']);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
