// build-recs.mjs の判断部分を通信なしで検証する。
//
// スコアリングは「どれを recs に出すか」を決める。ここが狂うと、
// 終わったキャンペーンやまとめ記事が毎日おすすめに並ぶ。
// LLM を使わない以上、この判断の質＝機能の質なので、実物に近い見出しで固定しておく。
//
// 実行: node scripts/test-build-recs.mjs

import { score, extractDeadline, toRec, isDismissed, assignIds, prune, setLearned } from './build-recs.mjs';
import { learnWeights, ngrams } from './learn-preferences.mjs';

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
eq('message: は Gmail の iOS メールアプリ向けリンクとして許可する',
  toRec({ title: 'メール件名', url: 'message:%3Cid%40mail.gmail.com%3E', via: 'gmail' }).url,
  'message:%3Cid%40mail.gmail.com%3E');
eq('javascript: のような未知のスキームは通さない',
  toRec({ title: 'x', url: 'javascript:alert(1)', via: 'search' }).url,
  '');
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
eq('却下済みで recommendations から消えた id も踏まえて番号を巻き戻さない',
  assignIds([{ title: 'a' }], [{ id: 'r5' }], ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r20']).map((r) => r.id),
  ['r21']);

console.log('\n── 溜まらないようにする ──');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const many = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, title: `件名${i}` }));

eq('上限までに削る', prune(many, { limit: 60 }).length, 60);
eq('削るのは古い方（末尾の新しいものを残す）', prune(many, { limit: 3 }).map((r) => r.title), ['件名97', '件名98', '件名99']);
eq('上限内ならそのまま', prune(many.slice(0, 10), { limit: 60 }).length, 10);

eq('締切切れは落とす', prune([
  { title: 'きれてる', deadline: day(-1) },
  { title: 'まだ有効', deadline: day(3) },
  { title: '締切なし' },
], { limit: 60 }).map((r) => r.title), ['まだ有効', '締切なし']);

eq('同じタイトルは新しい方を残す', prune([
  { title: 'PayPay 20%還元', url: 'old' },
  { title: 'PayPay 20%還元', url: 'new' },
], { limit: 60 }).map((r) => r.url), ['new']);

// 押せないものを消してから数を削る、という順番でないと有効な rec が先に消える
eq('先に締切切れを消してから数を削る', prune([
  { title: 'きれてる1', deadline: day(-5) },
  { title: 'きれてる2', deadline: day(-3) },
  { title: '有効A' },
  { title: '有効B' },
], { limit: 2 }).map((r) => r.title), ['有効A', '有効B']);

console.log('\n── 学習: 採用・却下から好みを取り出す ──');
eq('N-gramを2〜3文字で取る', ngrams('還元').sort(), ['還元']);
ok('3文字も取る', ngrams('エアドロップ').includes('エアド'));
ok('数字は語にしない', !ngrams('20%還元').some((g) => /\d/.test(g)));

const learned = learnWeights(
  // 正例: サウナ関連を採用してきた
  ['サウナ新店オープン', 'サウナ施設が開業', 'サウナととのい体験', 'サウナ新規オープン', '新サウナ登場'],
  // 負例: 仮想通貨を却下してきた
  ['仮想通貨キャンペーン', '仮想通貨エアドロップ', '仮想通貨の配布', '仮想通貨上場記念', '仮想通貨プレゼント'],
  { minCount: 2, maxTerms: 100 },
);
const wOf = (t) => learned.find((w) => w.term === t)?.weight ?? 0;
ok('採用側の語は正の重み', wOf('サウナ') > 0);
ok('却下側の語は負の重み', wOf('仮想通') < 0);
ok('重みは上限内に収まる', learned.every((w) => Math.abs(w.weight) <= 3));

console.log('\n── 学習がスコアに乗るか ──');
setLearned(learned);
const liked = score({ title: 'サウナが新規オープンします', category: 'おでかけ', url: 'https://e.com/1' });
const disliked = score({ title: '仮想通貨のキャンペーンを開始', category: 'お金', url: 'https://e.com/2' });
ok('好む語を含む方が上', liked.total > disliked.total);
ok('理由に過去の傾向が出る', liked.reasons.some((r) => r.includes('過去の傾向')));

// 好みで「終了しました」を救い上げてはいけない
const endedButLiked = score({ title: 'サウナのキャンペーンは終了しました', category: 'おでかけ', url: 'https://e.com/3' });
ok('好む語があっても終了済みは負のまま', endedButLiked.total < 0);
setLearned(null);

const noLearn = score({ title: 'サウナが新規オープンします', category: 'おでかけ', url: 'https://e.com/1' });
ok('学習結果が無くても動く', noLearn.total > 0 && !noLearn.reasons.some((r) => r.includes('過去の傾向')));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
