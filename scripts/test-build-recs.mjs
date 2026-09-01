// build-recs.mjs の判断部分を通信なしで検証する。
//
// スコアリングは「どれを recs に出すか」を決める。ここが狂うと、
// 終わったキャンペーンやまとめ記事が毎日おすすめに並ぶ。
// LLM を使わない以上、この判断の質＝機能の質なので、実物に近い見出しで固定しておく。
//
// 実行: node scripts/test-build-recs.mjs

import { score, extractDeadline, toRec, isDismissed, assignIds, prune, setLearned, cleanText, truncateAtBoundary, decodeEntities, toTaskTitle } from './build-recs.mjs';
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
eq('HTMLタグを除去し空白を畳む（+タスク形式の動詞が付く）', rec.title, 'タグ入り タイトルをチェックする');
eq('不正なカテゴリは その他 に落とす', rec.category, 'その他');
eq('http で始まらない url は空', rec.url, '');
eq('message: は Gmail の iOS メールアプリ向けリンクとして許可する',
  toRec({ title: 'メール件名', url: 'message:%3Cid%40mail.gmail.com%3E', via: 'gmail' }).url,
  'message:%3Cid%40mail.gmail.com%3E');
eq('javascript: のような未知のスキームは通さない',
  toRec({ title: 'x', url: 'javascript:alert(1)', via: 'search' }).url,
  '');

console.log('\n── 整形: 詳細文からノイズを削る（メールの宛名・定型文） ──');
eq('HTML実体参照をデコードする', decodeEntities('A&amp;B &quot;test&quot;'), 'A&B "test"');
eq('スペース区切りの宛名（実在しそうな人名）を削る',
  cleanText('新着情報です 横田 尚己 様 メンバーズプログラム'),
  '新着情報です メンバーズプログラム');
eq('一語の敬称（お客様・皆様）は削らない',
  cleanText('お客様には日頃よりご愛顧いただき、皆様に感謝申し上げます。'),
  'お客様には日頃よりご愛顧いただき、皆様に感謝申し上げます。');
eq('法人格+人名+様（スペース無し）の宛名を削る',
  cleanText('Fieldbeside合同会社横田尚己様 お世話になっております。'),
  'お世話になっております。');
eq('会社名なし・スペースなしの宛名（実データで発見）も削る',
  cleanText('横田尚己様 会計事務所SoVaの酒出です。'),
  '会計事務所SoVaの酒出です。');
eq('ゼロ幅スペースに阻まれず宛名を削る',
  cleanText('​​​​ 横田尚己様 会計事務所SoVaの酒出です。'),
  '会計事務所SoVaの酒出です。');
eq('「画像が表示されない場合はこちら」等の定型文を削る',
  cleanText('クーポン配布中 ※画像が表示されない場合はこちらから確認 今すぐチェック'),
  'クーポン配布中 今すぐチェック');
eq('句点があれば句点で切る（単語の途中で切らない）',
  truncateAtBoundary('最大20%還元キャンペーン開催中。詳細はこちらのページからご確認いただけます。', 20),
  '最大20%還元キャンペーン開催中。');
eq('句点が無ければ空白で切る',
  truncateAtBoundary('最大20%還元 キャンペーン開催中 詳細はこちら', 12),
  '最大20%還元');
eq('句点も空白も使える位置に無ければ文字数で切る',
  truncateAtBoundary('あいうえおかきくけこさしすせそ', 10),
  'あいうえおかきくけこ');
eq('元の長さが上限以下ならそのまま', truncateAtBoundary('短い文', 20), '短い文');
eq('toRec の desc はノイズ除去してから整形される',
  toRec({ title: 'x', desc: '横田 尚己 様 最大20%還元キャンペーン開催中。詳細はこちら', via: 'gmail' }).desc,
  '最大20%還元キャンペーン開催中。詳細はこちら');
eq('「本メールについて」の注意書きブロックを削る',
  cleanText('【本メールについて】 ・本メールに心当たりがない方はお手数ですが削除くださいますようお願いいたします。 ・本メールは、会員のお客様にお送りしております。 今週のおすすめ商品をご紹介！'),
  '今週のおすすめ商品をご紹介！');
eq('定型文除去で詳細がほぼ空になったら（タスク形式の）タイトルで埋める',
  toRec({ title: 'キャンペーンのお知らせ', desc: '【本メールについて】 ・本メールに心当たりがない方はお手数ですが削除くださいますようお願いいたします。', via: 'gmail' }).desc,
  'キャンペーンのお知らせをチェックする');

console.log('\n── 見出しをタスク形式にする ──');
eq('すでに動詞で終わる見出しはそのまま',
  toTaskTitle('今月貯めた・使ったポイントを確認する', ''),
  '今月貯めた・使ったポイントを確認する');
eq('意志形（〜しよう！）もタスク的とみなしそのまま',
  toTaskTitle('ポイントを手に入れよう！', ''),
  'ポイントを手に入れよう！');
eq('文が完結している告知文は括弧でくくって動詞を足す',
  toTaskTitle('🎉 毎週報酬を受け取れる！', ''),
  '「🎉 毎週報酬を受け取れる！」をチェックする');
eq('「エントリー」を含む名詞句には「にエントリーする」を足す',
  toTaskTitle('夏のボーナスキャンペーン エントリー受付中', ''),
  '夏のボーナスキャンペーン エントリー受付中にエントリーする');
eq('「クーポン」を含む名詞句には「を使う」を足す',
  toTaskTitle('Vクーポン・Vミッションがリニューアル【2026年8月号】', ''),
  'Vクーポン・Vミッションがリニューアル【2026年8月号】を使う');
eq('該当する語が無ければ「をチェックする」で汎用的に締める',
  toTaskTitle('サウナメッツァ大井町 3/28', 'サウナシュラン1位おおたか竜泉寺の湯の新業態'),
  'サウナメッツァ大井町 3/28をチェックする');
eq('空タイトルは空のまま', toTaskTitle('', ''), '');
eq('desc にしか無い「クーポン」だけでは「を使う」を足さない（意味が壊れる）',
  toTaskTitle('楽天モバイルの方', '最大20%OFFクーポン実施中'),
  '楽天モバイルの方をチェックする');
eq('タイトル自身に「クーポン」があれば「を使う」を足す',
  toTaskTitle('楽天モバイルクーポン配布中', ''),
  '楽天モバイルクーポン配布中を使う');
eq('desc の「還元・ポイント」は意味が壊れにくいので「を確認する」を足してよい',
  toTaskTitle('毎月のご利用ありがとうございます', 'ポイント還元のお知らせ'),
  '毎月のご利用ありがとうございますを確認する');
eq('desc の「開催」は「に参加する」を足してよい',
  toTaskTitle('学生向けの企画です', 'ハッカソンを開催します'),
  '学生向けの企画ですに参加する');

console.log('\n── 見出しの切り詰め: 開いたままの括弧を残さない ──');
eq('対応の取れていない開き括弧の手前まで戻す',
  truncateAtBoundary('RobotMateHub関西圏初のハッカソン「ウイルテック株式会社と共催', 24),
  'RobotMateHub関西圏初のハッカソン');
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

/* ── prune が却下済みを枠から外すか ──
   2026-08-31 の実測で、60枠のうち 51枠が「二度と表示されない rec」で
   埋まっていた。アプリは却下しても recommendations から消さず、
   ここは上限で古い順に切るだけだったため、新しい rec の入る余地が
   毎日削られていた。ここが緩むと同じ詰まりに戻る。 */
const pRecs = [
  { id: 'r1', title: '却下済みのID' },
  { id: 'r2', title: '却下済みのタイトル' },
  { id: 'r3', title: '生きている' },
];
eq('却下を渡さなければ全部残る', prune(pRecs, { limit: 60 }).length, 3);

const pKept = prune(pRecs, { limit: 60, dismissedIds: ['r1'], dismissedTitles: ['却下済みのタイトル'] });
eq('ID で却下されたものを外す', pKept.some((r) => r.id === 'r1'), false);
eq('タイトルで却下されたものを外す', pKept.some((r) => r.id === 'r2'), false);
eq('生きているものは残る', pKept.some((r) => r.id === 'r3'), true);

// アプリ側は trim+toLowerCase、build-recs は記号も落とす。物差しが違うので、
// 空白や記号の有無で取りこぼさないことを確かめる。
eq('空白の違いを吸収する',
  prune([{ id: 'x', title: 'あ い う' }], { dismissedTitles: ['あいう'] }).length, 0);
eq('却下リストが空でも壊れない',
  prune(pRecs, { dismissedIds: [], dismissedTitles: [] }).length, 3);
eq('null が混ざっていても落ちない',
  prune(pRecs, { dismissedIds: [null], dismissedTitles: [null, ''] }).length, 3);

/* ── 却下判定は「保存する文字列」で行う ──
   長く、素材の生タイトルで重複と却下を判定していた。実際に保存されるのは
   toRec が書き換えたタイトルで、アプリが dismissedTitles に積むのもそちら。
   生タイトルは書き換え後の部分文字列になることが多いので普段は当たるが、
   **60字で切り詰められると当たらなくなる**。そこをすり抜けた rec が
   毎日作られては、アプリ側の完全一致で黙って消えていた
   （2026-08-31 の実測で 13件中 4件）。 */
const longItem = {
  title: '【期間限定】dポイント最大50%還元の超大型キャンペーンが本日より全国のドコモショップおよびオンラインで一斉スタート',
  desc: 'エントリー必須です', category: 'お金', url: 'https://e.com/1',
};
const storedTitle = toRec(longItem).title;
const dtStored = [storedTitle.trim().toLowerCase()];

eq('切り詰めが起きると生タイトルでは却下に当たらない',
  isDismissed(longItem.title, dtStored), false);
eq('保存するタイトルなら却下に当たる',
  isDismissed(storedTitle, dtStored), true);

// 既存 recs との重複判定も、既存側は書き換え後を持っているので
// 生タイトルのキーでは一致しない。
eq('既存recsとの重複も保存タイトルでないと一致しない',
  [storedTitle].map((t) => t.toLowerCase().replace(/[\s　]/g, '')).includes(
    longItem.title.toLowerCase().replace(/[\s　]/g, '')), false);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
