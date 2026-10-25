#!/usr/bin/env node
/* 日次バッチが「動いたこと」を GitHub に書き戻す。
 *
 * ★なぜ要るのか★
 *   バッチは Mac の launchd で回っていて、結果は Firebase に入る。
 *   ところがクラウドの Claude Code セッションは Firebase に鍵を持たず
 *   （鍵は mac/.env にしかない）、Mac にも届かない（SSH 不可、
 *   Remote Control は Mac 側が起動していないと繋がらない）。
 *   つまり「昨夜ちゃんと動いたのか」「Gmail は何アカウント繋がっているのか」を
 *   確かめる手段が無い。実際にそれで、既に終わっている作業を
 *   未完了として報告する事故が起きた。
 *
 *   リポジトリに一行残せば、GitHub API だけで状態が見える。
 *
 * ★出していいもの・いけないもの★
 *   このリポジトリは public。タスクにもメールにも個人情報が入る。
 *   だからここでは **counts だけ** を読む。items は開かない。
 *   件名・タスク名・URL・メールアドレスは一切書かない。
 *   docs/CURRENT_SPEC.md と同じ方針（scripts/inspect-tasks.mjs が先例）。
 */

import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'mac/last-run.md';

/* counts だけ取り出す。items には触れない。
   ファイルが無い・壊れている場合は null を返して「不明」として扱う。 */
async function counts(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj.counts === 'object' ? obj.counts : null;
  } catch {
    return null;
  }
}

/* 収集ファイルの付帯情報（いつ・どの経路で採れたか）。
   ★これが無いと心拍が嘘をつく★ 収集に失敗しても前回のファイルは残るので、
   counts だけ読むと「昨日の件数」を今日の成果として書いてしまう。
   失敗しているのに健全に見えるのが一番まずい。

   時刻のフィールド名は収集物が collectedAt、recs-stats.json が at で揃っていない。
   collectedAt だけを見ていたため、在庫欄が常に stale 扱い＝「不明」になり、
   60枠の上限警告も出ないままだった（2026-10-03 に判明）。両方を受け付ける。 */
async function meta(file, maxAgeHours = 12) {
  try {
    const obj = JSON.parse(await readFile(file, 'utf8'));
    const at = Date.parse(obj?.collectedAt || obj?.at || '');
    const ageH = Number.isFinite(at) ? (Date.now() - at) / 3600000 : null;
    return {
      method: obj?.method || null,
      ageH,
      stale: ageH === null ? true : ageH > maxAgeHours,
    };
  } catch {
    return { method: null, ageH: null, stale: true };
  }
}

/* メール判定の結果（LLM が効いたか、効かなかった理由の分類）だけ取り出す。
   collect-gmail-imap.mjs が分類済みの短い文字列だけを入れている。 */
async function classifyInfo(file) {
  try {
    const c = JSON.parse(await readFile(file, 'utf8'))?.classify;
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}

export function classifyLine(c) {
  if (!c) return null;
  if (c.mode === 'off') return 'キーワードのみ（CLASSIFY=off）';
  const cred = { env: '環境変数の鍵', ant: 'ant のトークン', none: '取れず', unused: '新着なし' }[c.credential] || '不明';
  if (c.used === 'llm') return `LLM（認証: ${cred}）`;
  return `⚠️ キーワードに後退 — ${c.reason || '理由不明'}（認証: ${cred}）`;
}

/* recs-stats.json の selection（出どころ/カテゴリ別の件数）だけ取り出す。 */
async function selectionInfo(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'))?.selection;
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

const SOURCE_LABEL = { x: 'X', gmail: 'メール', news: 'ニュース' };

/* {"x/お金": 3, "x/グルメ": 5, "gmail/お金": 4} を
   「X 8（お金 3）/ メール 4（お金 4）」にする。お金だけ別に出すのは、
   X のポイ活とメールのお得が同じ「お金」枠を取り合うため。 */
export function sourceSummary(map) {
  if (!map || typeof map !== 'object') return '不明';
  const by = {};
  for (const [k, v] of Object.entries(map)) {
    const [src, cat] = k.split('/');
    by[src] = by[src] || { total: 0, money: 0 };
    by[src].total += Number(v) || 0;
    if (cat === 'お金') by[src].money += Number(v) || 0;
  }
  const parts = ['x', 'gmail', 'news'].filter((s) => by[s])
    .map((s) => `${SOURCE_LABEL[s]} ${by[s].total}（お金 ${by[s].money}）`);
  return parts.length ? parts.join(' / ') : '0件';
}

export function topicSummary(byTopic) {
  if (!byTopic || typeof byTopic !== 'object') return null;
  return Object.entries(byTopic).map(([k, v]) => `${k} ${v}`).join(' / ');
}

/* 配列の「長さ」だけ。中身は見ない。 */
async function length(file) {
  try {
    const obj = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(obj)) return obj.length;
    if (Array.isArray(obj?.recs)) return obj.recs.length;
    if (Array.isArray(obj?.items)) return obj.items.length;
    return null;
  } catch {
    return null;
  }
}

function jst(d = new Date()) {
  const t = new Date(d.getTime() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())} JST`;
}

const n = (v) => (v === null || v === undefined ? '不明' : String(v));

/* 経過時間を読める形に。日次バッチは 00:00 に走るので、日中に手で
   確かめると 20 時間超になる。「0 日前」では何も伝わらない。 */
function age(hours) {
  if (hours === null || hours === undefined) return '時期不明';
  if (hours < 48) return `${Math.round(hours)} 時間前`;
  return `${Math.floor(hours / 24)} 日前`;
}

async function main() {
  const status = process.env.HEARTBEAT_STATUS || '不明';
  const mode = process.env.HEARTBEAT_MODE || '不明';
  const sha = (process.env.HEARTBEAT_SHA || '').slice(0, 7) || '不明';

  const x = await counts('collected-x.json');
  const xMeta = await meta('collected-x.json');
  const gmail = await counts('collected-gmail.json');
  const gmailImap = await counts('collected-gmail-imap.json');
  const learn = await counts('learned-weights.json');
  const built = await length('recs-built-preview.json');
  const stats = await counts('recs-stats.json');
  const statsMeta = await meta('recs-stats.json');
  const selection = statsMeta.stale ? null : await selectionInfo('recs-stats.json');
  const xTopics = x && !xMeta.stale ? topicSummary(x.byTopic) : null;

  /* Gmail は2経路を併用する（OAuth / IMAP）。**経路ごとに出す。**
     合算して1行にすると、片方が死んでももう片方の件数で健全に見えてしまう。
     どちらが倒れたかが分からなければ、直しようもない。 */
  const gmailMeta = await meta('collected-gmail.json');
  const gmailImapMeta = await meta('collected-gmail-imap.json');

  function routeLine(c, m, configured, label) {
    if (!configured) return null;                       // その経路は使っていない
    if (!c || m.stale) {
      return c && m.stale
        ? `⚠️ 今回は採れず（残っているのは ${age(m.ageH)}のファイル）`
        : '⚠️ 今回は採れず';
    }
    const ok = (c.accounts ?? 0) - (c.failures ?? 0);
    let line = `${n(ok)} / ${n(c.accounts)} アカウント成功、${n(c.total)}件`;
    // 経路が2つある（お得情報 / 対応が要るもの）。合算だけだと、
    // 片方が 0 になっても総数で隠れる。要対応が急に 0 なら判定が壊れた合図。
    if (c.promo !== undefined || c.action !== undefined) {
      line += `（お得 ${n(c.promo)} / 要対応 ${n(c.action)}）`;
    } else if (c.failures) line += `（失敗 ${c.failures}）`;
    if (c.failures && (c.promo !== undefined || c.action !== undefined)) line += `　失敗 ${c.failures}`;
    return line;
  }

  const oauthLine = routeLine(gmail, gmailMeta, process.env.GMAIL_REFRESH_TOKENS, 'OAuth');
  const imapLine = routeLine(gmailImap, gmailImapMeta, process.env.GMAIL_IMAP_ACCOUNTS, 'IMAP');
  const judgeLine = process.env.GMAIL_IMAP_ACCOUNTS && !gmailImapMeta.stale
    ? classifyLine(await classifyInfo('collected-gmail-imap.json'))
    : null;
  const configured = process.env.GMAIL_IMAP_ACCOUNTS || process.env.GMAIL_REFRESH_TOKENS;

  /* 見出しに劣化を出す。
     2026-08-31 の実行は 3 アカウント中 2 つが失敗したのに、見出しは
     「正常終了」のままだった。Gmail の行を読めば分かるとはいえ、
     結果の欄だけ見て健全だと思うのが普通の読み方で、実際そうなりかけた。
     一部でも落ちていれば見出しに出す。 */
  const notes = [];
  for (const [label, c, m, cfg] of [
    ['OAuth', gmail, gmailMeta, process.env.GMAIL_REFRESH_TOKENS],
    ['IMAP', gmailImap, gmailImapMeta, process.env.GMAIL_IMAP_ACCOUNTS],
  ]) {
    if (!cfg) continue;
    if (!c || m.stale) notes.push(`⚠️ Gmail(${label}) 収集できず`);
    else if (c.failures) notes.push(`⚠️ Gmail(${label}) ${c.failures}/${n(c.accounts)} アカウント失敗`);
  }
  if (!x || xMeta.stale) notes.push('⚠️ X 収集できず');
  const degraded = notes.length ? `　${notes.join(' / ')}` : '';

  const body = `# 日次バッチの最終実行

このファイルは \`mac/run-daily.sh\` が毎回上書きします。手で編集しても次の実行で消えます。
**件数だけを書きます。**タスク名・メールの件名・URL は書きません（このリポジトリは public）。

| | |
|---|---|
| 実行 | ${jst()} |
| 結果 | ${status}${degraded} |
| mode | ${mode} |
| コード | ${sha} |

## 収集

| 材料 | 結果 |
|---|---|
| X | ${x && !xMeta.stale ? `${n(x.total)}件（検索 ${n(x.search)} / アカウント ${n(x.profile)}）` : '⚠️ 今回は採れず'} |
${xTopics ? `| X の内訳 | ${xTopics} |\n` : ''}${oauthLine ? `| Gmail (OAuth) | ${oauthLine} |` : ''}${oauthLine && imapLine ? '\n' : ''}${imapLine ? `| Gmail (IMAP) | ${imapLine} |` : ''}${judgeLine ? `\n| メール判定 | ${judgeLine} |` : ''}${!configured ? '| Gmail | 未設定のため省略（docs/gmail-setup.md） |' : ''}

## 学習

${learn ? `採用 ${n(learn.adopted)}件 / 却下 ${n(learn.dismissed)}件 から ${n(learn.terms)}語を学習` : '不明（学習に失敗したか、まだ材料が無い）'}

## 選別

${built === null ? '不明' : `${built}件を選定`}
${selection ? `
| | |
|---|---|
| 候補 | ${sourceSummary(selection.candidates)} |
| 選定 | ${sourceSummary(selection.picked)} |
| 点数で除外 | ${Object.entries(selection.lowScoreBySource || {}).map(([k, v]) => `${SOURCE_LABEL[k] || k} ${v}`).join(' / ') || '0件'} |
` : ''}
## おすすめの在庫

${stats && !statsMeta.stale
  ? `${n(stats.total)} / ${n(stats.limit)}件（既存 ${n(stats.existing)} + 新規 ${n(stats.added)}${stats.removed ? ` − 整理 ${stats.removed}` : ''}）`
    + (stats.total >= stats.limit ? '　⚠️ 上限に達しています' : '')
  : '不明'}

---

これが数日更新されていなければ、Mac が動いていないか launchd が発火していません。
Mac 側で \`launchctl list | grep bubblesnow\` と \`tail mac/logs/daily.out.log\` を見てください。
`;

  await writeFile(OUT, body);
  console.log(`📦 ${OUT} を更新（結果=${status}）`);
}

const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'write-heartbeat.mjs') {
  main().catch((e) => {
    /* 心拍が書けなかっただけでバッチを失敗にしない。本体の成否とは別の話。 */
    console.error(`⚠️ ${OUT} を更新できませんでした: ${e.message}`);
    process.exit(0);
  });
}

export { counts, length, meta, jst };
