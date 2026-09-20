// learn-preferences.mjs の判定部分を通信なしで検証する。
//
// ここで守りたいのは、自動学習が静かに壊れて「何も学ばない」あるいは
// 「間違ったものを嫌いになる」状態にならないこと。
//   ① 反応の畳み込み … 追記キー（recId__kind）を rec 単位にまとめる
//   ② 無反応の判定   … 出したばかりのものを負例にしない／経過不明を巻き込まない
//   ③ 重みの向き     … 正例に寄った語は正、負例に寄った語は負
//
// 実行: node scripts/test-learn-preferences.mjs

import { groupEvents, findIgnored, learnWeights, ngrams } from './learn-preferences.mjs';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log(`  OK   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n       got:  ${g}\n       want: ${w}`); }
}
function ok(label, cond) { eq(label, !!cond, true); }

const DAY = 86400000;
const NOW = Date.parse('2026-09-20T00:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

console.log('── ① 反応の畳み込み ──');
const raw = {
  r1__open: { id: 'r1', title: 'くら寿司フェア', kind: 'open', at: ago(1) },
  r1__add: { id: 'r1', title: 'くら寿司フェア', kind: 'add', at: ago(1) },
  r2__dismiss: { id: 'r2', title: '暗号資産キャンペーン', kind: 'dismiss', at: ago(2) },
  broken1: null,
  broken2: { title: 'idが無い', kind: 'open' },
  broken3: { id: 'r9', title: 'kindが無い' },
};
const ev = groupEvents(raw);
eq('反応のあった rec だけが残る', [...ev.keys()].sort(), ['r1', 'r2']);
ok('同じ rec の複数の反応がまとまる', ev.get('r1').kinds.has('open') && ev.get('r1').kinds.has('add'));
eq('タイトルを保持する', ev.get('r2').title, '暗号資産キャンペーン');
eq('空でも落ちない', groupEvents(null).size, 0);
eq('壊れた行は無視する', groupEvents({ a: null, b: {} }).size, 0);

console.log('\n── ② 無反応の判定 ──');
const recs = [
  { id: 'r1', title: '反応あり', createdAt: ago(30) },
  { id: 'r3', title: '無反応で30日', createdAt: ago(30) },
  { id: 'r4', title: '無反応だが昨日出した', createdAt: ago(1) },
  { id: 'r5', title: '無反応でちょうど7日', createdAt: ago(7) },
  { id: 'r6', title: '無反応だが出した日が不明' },
  { id: 'r7', createdAt: ago(30) },
  null,
];
const ign = findIgnored(recs, ev, NOW);
eq('無反応かつ日数が経ったものだけ', ign, ['無反応で30日', '無反応でちょうど7日']);
ok('反応があったものは含めない', ign.indexOf('反応あり') < 0);
ok('出したばかりは含めない', ign.indexOf('無反応だが昨日出した') < 0);
ok('createdAt が無いものは含めない', ign.indexOf('無反応だが出した日が不明') < 0);
eq('日数を変えれば範囲も変わる', findIgnored(recs, ev, NOW, 29), ['無反応で30日']);
eq('おすすめが空でも落ちない', findIgnored([], ev, NOW), []);
eq('createdAt が壊れていても落ちない',
  findIgnored([{ id: 'x', title: 'A', createdAt: 'ではない' }], ev, NOW), []);

console.log('\n── ③ 重みの向き ──');
// 正例にだけ出る語は正、負例にだけ出る語は負になること
const adopted = Array(8).fill('くら寿司の北海フェアに行く');
const dismissed = Array(8).fill('暗号資産のエアドロップに応募する');
const w = learnWeights(adopted, dismissed, { minCount: 3, maxTerms: 200 });
const find = (t) => w.find((x) => x.term === t);
ok('正例側の語は正の重み', (find('くら') || {}).weight > 0);
ok('負例側の語は負の重み', (find('暗号') || {}).weight < 0);
ok('両方に出ない語は持たない', !find('ぜんぜん'));

/* 本機能の肝。件数は実運用に近い規模で確かめる。
   正例が1件しかない状態だと「その語は正例の100%に出る」ことになり、
   負例を足しても正の相関が残る（確信度が上がる分むしろ強まる）。
   これは式として正しい挙動なので、小さすぎる集合で検証しない。 */
const POS = [...Array(3).fill('サウナの新店に行く'), ...Array(17).fill('Kindleのセールを見る')];
const NEG = Array(20).fill('暗号資産のエアドロップ');
const wb = (list) => (list.find((x) => x.term === 'サウ') || { weight: 0 }).weight;

const base = learnWeights(POS, NEG, { minCount: 1 });
ok('反応のある話題は正の重みになる', wb(base) > 0);

// 「開いた」を正例に足すと、その話題の重みが上がる
const boosted = learnWeights([...POS, ...Array(10).fill('サウナ特集を開いた')], NEG, { minCount: 1 });
ok('開いた記録が増えるとその話題の重みが上がる', wb(boosted) > wb(base));

// 「無反応」を負例に足すと、その話題の重みが下がる
const ignored10 = learnWeights(POS, [...NEG, ...Array(10).fill('サウナ特集を見なかった')], { minCount: 1 });
const ignored30 = learnWeights(POS, [...NEG, ...Array(30).fill('サウナ特集を見なかった')], { minCount: 1 });
ok('無反応が増えるとその話題の重みが下がる', wb(ignored10) < wb(base));
ok('無反応が積み上がるほど強く下がる', wb(ignored30) < wb(ignored10));
ok('無反応が続けば負に転じる', wb(ignored10) < 0);

console.log('\n── ④ N-gram ──');
ok('2文字と3文字を取る', ngrams('サウナ').indexOf('サウ') >= 0 && ngrams('サウナ').indexOf('サウナ') >= 0);
eq('1文字は取らない', ngrams('あ'), []);
eq('数字は語にしない', ngrams('2026'), []);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
