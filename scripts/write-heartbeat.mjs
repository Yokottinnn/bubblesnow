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
   失敗しているのに健全に見えるのが一番まずい。 */
async function meta(file, maxAgeHours = 12) {
  try {
    const obj = JSON.parse(await readFile(file, 'utf8'));
    const at = Date.parse(obj?.collectedAt || '');
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

async function main() {
  const status = process.env.HEARTBEAT_STATUS || '不明';
  const mode = process.env.HEARTBEAT_MODE || '不明';
  const sha = (process.env.HEARTBEAT_SHA || '').slice(0, 7) || '不明';

  const x = await counts('collected-x.json');
  const xMeta = await meta('collected-x.json');
  const gmail = await counts('collected-gmail.json');
  const learn = await counts('learned-weights.json');
  const built = await length('recs-built-preview.json');

  /* Gmail は「設定されていない」「今回採れなかった」「採れた」を区別する。
     どれも対応が違うので、まとめて「不明」にしない。 */
  const gmailMeta = await meta('collected-gmail.json');
  const configured = process.env.GMAIL_IMAP_ACCOUNTS || process.env.GMAIL_REFRESH_TOKENS;
  let gmailLine;
  if (!gmail || gmailMeta.stale) {
    if (!configured) {
      gmailLine = '未設定のため省略（docs/gmail-setup.md）';
    } else if (gmail && gmailMeta.stale) {
      // 前回のファイルが残っているだけ。件数を書くと今日の成果に見えるので書かない。
      const days = gmailMeta.ageH === null ? '?' : Math.floor(gmailMeta.ageH / 24);
      gmailLine = `⚠️ 今回は採れず（残っているのは ${days} 日前のファイル）`;
    } else {
      gmailLine = '⚠️ 今回は採れず（collected-gmail.json が無い）';
    }
  } else {
    const ok = (gmail.accounts ?? 0) - (gmail.failures ?? 0);
    const via = gmailMeta.method === 'imap' ? 'IMAP' : gmailMeta.method === 'oauth' ? 'OAuth' : '経路不明';
    gmailLine = `${via}: ${n(ok)} / ${n(gmail.accounts)} アカウント成功、${n(gmail.total)}件`;
    if (gmail.failures) gmailLine += `（失敗 ${gmail.failures}）`;
  }

  const body = `# 日次バッチの最終実行

このファイルは \`mac/run-daily.sh\` が毎回上書きします。手で編集しても次の実行で消えます。
**件数だけを書きます。**タスク名・メールの件名・URL は書きません（このリポジトリは public）。

| | |
|---|---|
| 実行 | ${jst()} |
| 結果 | ${status} |
| mode | ${mode} |
| コード | ${sha} |

## 収集

| 材料 | 結果 |
|---|---|
| X | ${x && !xMeta.stale ? `${n(x.total)}件（検索 ${n(x.search)} / プロフィール ${n(x.profile)}）` : '⚠️ 今回は採れず'} |
| Gmail | ${gmailLine} |

## 学習

${learn ? `採用 ${n(learn.adopted)}件 / 却下 ${n(learn.dismissed)}件 から ${n(learn.terms)}語を学習` : '不明（学習に失敗したか、まだ材料が無い）'}

## 選別

${built === null ? '不明' : `${built}件を選定`}

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
