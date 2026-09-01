// 集めた材料から recs を選んで整形し、Firebase に反映する。LLM を使わないので課金ゼロ。
//
// ★これが最後の一段★
//   ① 収集      collect-x.mjs（X）/ collect-sources.mjs（RSS）… 済
//   ② URL解決   同上 … 済
//   ③ 既出除外  同上 … 済
//   ④ 選別・整形 ← ここ
//
// ★なぜ LLM を使わないか★
// Claude に web_search させる方式は 1回 $0.4 で、その8割超は検索結果の運搬料だった。
// 検索を自前でやる形にしたので、残るのは「77件から15〜25件を選ぶ」判断だけ。
// これはスコアリングで足りる。無料で、毎日回しても $0。
// 生成文の質が要るなら後から LLM を挟めるよう、選別と整形は分けてある。
//
// ★安全側の作り★
//   - 既定は書き込まない（MODE=dry-run）。書くのは MODE=live のときだけ
//   - 書く前に既存を recs-backup.json に保存する
//   - 既存を消さず末尾に足す（アプリの .set() 全置換とは違う）
//   - 0件なら書き込まない
//
// 実行: node scripts/build-recs.mjs            … 選ぶだけ（既定・$0・書かない）
//       MODE=live node scripts/build-recs.mjs  … Firebase に反映（$0）

import { readFile, writeFile } from 'node:fs/promises';
import { ngrams } from './learn-preferences.mjs';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const BASE = 'users/yokota';
const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

const MODE = String(process.env.MODE || 'dry-run').toLowerCase();
const WRITES = MODE === 'live';

// Make.com のプロンプトが「15-25件」を指示していたので、それに合わせる。
const MIN_RECS = Number(process.env.MIN_RECS || 15);
const MAX_RECS = Number(process.env.MAX_RECS || 25);
// 1カテゴリが枠を独占しないようにする。偏ると「おすすめ」として使い物にならない。
const MAX_PER_CATEGORY = Number(process.env.MAX_PER_CATEGORY || 8);
// recommendations 全体の上限。毎日追加するので、これが無いと無限に増える。
// 一覧をスクロールして眺められる量として 60 を既定にした。
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 60);

// Gmail は2経路ある（OAuth / IMAP）。両方走らせて合流させるので両方読む。
// 同じキャンペーンが複数アカウントに届いていても、下でタイトル重複を除く。
const SOURCE_FILES = ['collected-x.json', 'collected-sources.json',
  'collected-gmail.json', 'collected-gmail-imap.json'];
// 収集物をどこまで古くても使うか。日次で回るので、これを過ぎたものは
// 「今日の材料」ではない。廃止した経路の置き土産を混ぜないための線でもある。
const MAX_SOURCE_AGE_H = Number(process.env.MAX_SOURCE_AGE_H || 36);
// learn-preferences.mjs が書き出す学習結果。無ければ手書きの重みだけで動く。
const WEIGHTS_FILE = 'learned-weights.json';
// 学習分がスコア全体を支配しないための上限。手書きの信号は「行動できるか」を
// 見ているので、好み（学習）でそれを覆させない。
const MAX_LEARNED = Number(process.env.MAX_LEARNED || 4);

let LEARNED = null;
export function setLearned(w) { LEARNED = w; }

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

async function fbPut(path, data) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s　"'“”‘’|｜・,、。．.!！?？]/g, '');
const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// ★見出し・詳細のノイズ除去（LLM不使用）★
// 実データを見ると、装飾行の除去（collect-x.mjs）だけでは足りない問題が
// 2つあった。
//   1. メールの宛名（「横田 尚己 様」等）がそのまま詳細欄に出る
//   2. 「画像が表示されない場合はこちら」等、内容と無関係な定型文が
//      文字数を食い、120字に切ると本題に届く前に終わる
// どちらも文面のパターンなので、規則ベースで削れる範囲は削る。

// HTML実体参照。収集元によっては未デコードのまま来る（"&mall" のような
// 中途半端な壊れ方をすることがある＝&amp;mall の "amp;" 部分が既に
// どこかで欠けている、等）。
export const decodeEntities = (s) => String(s)
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, '\'')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ');

// 「〇〇 △△ 様」形式の宛名。スペース区切りの短い語の並びが 様 で終わる
// ときだけ対象にする（"お客様"「皆様」のような一語の敬称はスペースが
// 無いので対象外＝誤って本文を壊さない）。
const SALUTATION = /(?<=^|[\s　])[^\s　、。！？「」『』]{1,10}(?:[ 　][^\s　、。！？「」『』]{1,10}){0,1}[ 　]様/g;
// 「(株式会社|合同会社)+人名+様」形式（スペースが無いパターン）。
// 法人格の文字列という明確な目印があるときだけ対象にする。
const COMPANY_SALUTATION = /[^\s　、。！？「」『』]{0,20}(?:株式会社|合同会社|㈱)[^\s　、。！？「」『』]{1,20}様/g;
// 「横田尚己様」のように会社名もスペースも無い宛名（実在のメールで確認済み。
// SALUTATION はスペース区切りが前提のため素通りしていた）。漢字・カナが
// 2〜8字続いて 様 に直結する箇所を対象にする。「お客様」「皆様」のような
// 一般的な敬称は本名ではないので除外リストで残す。
const GENERIC_SAMA = /^(お客様|皆様|各位様|会員様|ご担当者様|関係者様|保護者様|ご利用者様|ご契約者様)$/;
const PLAIN_SALUTATION = /(?<=^|[\s　、。！？「』])[一-龥ァ-ヶー]{2,8}様/g;

// メール本文に頻出する、案内内容そのものとは無関係な定型文。
const BOILERPLATE = [
  /※?(正しく|画像が)表示されない場合は[^\s　]{0,15}こちら[^\s　]{0,10}/g,
  /※.{0,3}このメールは.{0,40}/g,
  /配信停止(はこちら)?.{0,10}/g,
  /・?\s*【本メールについて】/g,
  /・?\s*本メールに心当たりが(ない|無い)方は[^。]{0,40}。?/g,
  /・?\s*本メールは、?[^。]{0,60}。?/g,
  /この度の.{0,20}(地震|災害|台風).{0,80}お見舞い申し上げます。?/g,
  /TOPICS\s*TOPICS/g,
  /Have a good Cashless\.?/gi,
  /(株式会社|合同会社)[^\s　]{1,20}(セミナー事務局|事務局|担当)です。?/g,
  /\b\d{4}\.\d{1,2}\.\d{1,2}\b/g,
];

// ゼロ幅スペース等の不可視文字。\s に含まれないため放置すると宛名の
// 手前に残り、SALUTATION 系の正規表現の「行頭/空白の直後」判定を
// すり抜ける（実データで発生を確認）。整形の最初に必ず取り除く。
const INVISIBLE = /[​‌‍﻿]/g;

export function cleanText(s) {
  let t = decodeEntities(String(s || '')).replace(INVISIBLE, '');
  t = t.replace(COMPANY_SALUTATION, '').replace(SALUTATION, '')
    .replace(PLAIN_SALUTATION, (m) => (GENERIC_SAMA.test(m) ? m : ''));
  for (const re of BOILERPLATE) t = t.replace(re, '');
  // 定型文除去のあとに箇条書きの「・」だけが孤立して残ることがある。
  t = t.replace(/(?<=^|[\s　])・(?=[\s　]|$)/g, '');
  return t.replace(/[ 　]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
}

// 文字数で機械的に切ると単語の途中で終わる（"そんなあな" 等）。
// 句点・感嘆符・疑問符があればそこで切り、無ければ空白で切る。
// どちらも無いときだけ、最後の手段として文字数で切る。
// 「【」「「」のような開き括弧だけが末尾に残ると尻切れに見える
// （"…ハッカソン、【" のような）ので、切ったあとに落とす。
const stripDanglingOpenBracket = (s) => s.replace(/[「『【([（\s　]+$/, '');

// 末尾の記号だけでなく「「ウイルテック」のように、開き括弧の後ろに
// 固有名詞などが続いた状態で切れることもある。対応が取れていない
// 開き括弧があれば、その手前まで戻す（＝開いたまま終わる引用・カッコを
// 見出しに残さない）。
const OPEN_BRACKETS = '「『【([（';
const CLOSE_BRACKETS = '」』】)]）';
function trimUnclosedBracket(s) {
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    if (OPEN_BRACKETS.includes(s[i])) stack.push(i);
    else if (CLOSE_BRACKETS.includes(s[i]) && stack.length) stack.pop();
  }
  return stack.length ? s.slice(0, stack[0]).trim() : s;
}

export function truncateAtBoundary(s, maxLen) {
  const t = String(s || '');
  if (t.length <= maxLen) return t;
  const head = t.slice(0, maxLen);
  const lastSentenceEnd = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  if (lastSentenceEnd >= Math.floor(maxLen * 0.4)) return trimUnclosedBracket(head.slice(0, lastSentenceEnd + 1));
  const lastComma = head.lastIndexOf('、');
  const lastSpace = head.lastIndexOf(' ');
  const cut = Math.max(lastComma, lastSpace);
  if (cut >= Math.floor(maxLen * 0.4)) {
    const trimmed = stripDanglingOpenBracket(head.slice(0, cut + (cut === lastComma ? 1 : 0)).trim());
    return trimUnclosedBracket(trimmed) || trimmed;
  }
  const trimmed = stripDanglingOpenBracket(head).trim() || head;
  return trimUnclosedBracket(trimmed) || trimmed;
}

// ★見出しをタスク形式にする（LLM不使用）★
// 収集元の文言をそのまま見出しにすると「〇〇キャンペーン開催中！」のような
// 告知文のままで、タスク一覧に並んだときに「何をすればいいか」が読めない。
// 内容の理解や言い換えはできない（LLM無しの制約）ので、代わりに
// 「すでに動詞で終わっている文はそのまま」「そうでなければ内容に合う
// 動詞を機械的に付け足す」という形式面だけの変換に留める。
// 語尾の直後に絵文字（「お急ぎください💨」等）が付くことがあるので、
// 文字列の末尾ぴったりではなく末尾付近を対象にする。
const TASK_VERB_ENDING = /(する|しよう|しましょう|よう|くる|いく|やる|使う|使おう|申し込む|エントリーする|登録する|参加する|確認する|チェックする|手に入れよう|ください|下さい)/;
const isTaskLikeEnding = (t) => TASK_VERB_ENDING.test(t.slice(-12));
const TERMINAL_PUNCT = /[！!。.？?…]$/;
// titleOnly: true の語は、タイトル自身にその語が無いと動詞をつなげても
// 意味が通らない（「クーポン」が desc にしか無いのに見出しに「を使う」を
// 足すと、何を使うのか分からなくなる＝実際に "楽天モバイルの方を使う"
// のような壊れ方をした）。desc だけの一致で足してもまだ意味が壊れにくい
// 語（還元・ポイント・開催系）だけ titleOnly: false にしている。
const TASK_VERBS = [
  { re: /エントリー/, verb: 'にエントリーする', titleOnly: true },
  { re: /(応募|申[込し]み)/, verb: 'に応募する', titleOnly: true },
  { re: /登録/, verb: 'に登録する', titleOnly: true },
  { re: /予約/, verb: 'を予約する', titleOnly: true },
  { re: /(購入|購読)/, verb: 'を検討する', titleOnly: true },
  { re: /(クーポン|割引)/, verb: 'を使う', titleOnly: true },
  { re: /(無料体験|お試し)/, verb: 'を試す', titleOnly: true },
  { re: /(抽選|プレゼント|配布)/, verb: 'に応募する', titleOnly: false },
  { re: /(還元|ポイント)/, verb: 'を確認する', titleOnly: false },
  { re: /(開催|セミナー|イベント|ハッカソン|勉強会|講座)/, verb: 'に参加する', titleOnly: false },
];
const TASK_VERB_DEFAULT = 'をチェックする';

export function toTaskTitle(title, desc) {
  const t = String(title || '').trim();
  if (!t || isTaskLikeEnding(t)) return t;
  const combined = `${t} ${desc || ''}`;
  const hit = TASK_VERBS.find((v) => v.re.test(v.titleOnly ? t : combined));
  const verb = hit ? hit.verb : TASK_VERB_DEFAULT;
  // 動詞と括弧ぶんの余白を引いた範囲で、文の切れ目（句点・空白）を
  // 優先してタイトルの核を切り出す。単語の途中で切って動詞を続けると
  // 「...ハッカソン、【 Entertainmeに参加する」のような壊れ方をする。
  const core = truncateAtBoundary(t, Math.max(60 - verb.length - 2, 10));
  if (TERMINAL_PUNCT.test(core)) {
    // 文として完結している（「〜！」等）ので、そのまま動詞を続けると
    // 文法的に破綻する。見出し全体を主語として括弧でくくる。
    return `「${core}」${verb}`;
  }
  return `${core}${verb}`;
}

// ★スコアリング★
// 「タスク追加傾向を増やしdismiss傾向を減らす」が元プロンプトの狙い。
// LLM の代わりに、その狙いを分解可能な形にして数値で表す。
const SIGNALS = [
  // 行動できるものを上に。締切や金額がある告知は、読んで終わりの記事より価値が高い。
  { re: /(\d+(\.\d+)?\s*[%％]|\d+[,\d]*\s*円|\d+\s*ポイント|最大\s*\d)/, points: 3, why: '具体的な金額や率がある' },
  { re: /(まで|締切|期限|〜\d+\/\d+|\d+月\d+日まで)/, points: 3, why: '期限が示されている' },
  { re: /(開始|スタート|開催|オープン|受付|募集|エントリー|開幕|新登場|リリース)/, points: 2, why: '始まる告知' },
  { re: /(限定|先着|抽選|無料|プレゼント|配布)/, points: 2, why: '取りに行く理由がある' },
  { re: /(新店|新規|初|リニューアル)/, points: 1, why: '新しい' },
];

// ★これに当たったら失格★
// 重みではなく足切りにする。減点にしておくと、他の加点や学習した好みで
// 打ち消されて浮上する。実際テストで「サウナのキャンペーンは終了しました」が
// 好みの加点に救われて正のスコアになった。終わった告知に点数の議論は要らない。
const DISQUALIFY = [
  { re: /(終了しました|終了いたしました|受付終了|募集終了|締め切りました|中止|延期)/, why: '既に終わっている' },
  { re: /(詐欺|注意喚起|被害|流出|不正アクセス|逮捕|炎上)/, why: 'ネガティブな話題' },
];

// 逆に、おすすめとして出しても行動につながらないもの。
const PENALTIES = [
  { re: /(まとめ|ランキング|\d+選|振り返り|とは|徹底解説|比較してみた)/, points: -4, why: '読み物であって行動対象ではない' },
  { re: /^(RT|【PR】|\[PR\])/, points: -3, why: '転載や広告表記' },
];

export function score(item) {
  const text = `${item.title || ''} ${item.desc || ''}`;
  const reasons = [];
  let total = 0;

  // 失格は最初に見る。以降の加点も学習分も見ない。
  for (const d of DISQUALIFY) {
    if (d.re.test(text)) return { total: -100, reasons: [`失格: ${d.why}`], disqualified: true };
  }

  for (const s of SIGNALS) {
    if (s.re.test(text)) { total += s.points; reasons.push(`+${s.points} ${s.why}`); }
  }
  for (const p of PENALTIES) {
    if (p.re.test(text)) { total += p.points; reasons.push(`${p.points} ${p.why}`); }
  }

  // URL があるものを優先する。設計書の「壊れたリンクは無リンクより悪い」の裏返しで、
  // 行き先が無い rec は採用しても何もできない。お金カテゴリは特に効く。
  if (item.url) { total += 3; reasons.push('+3 リンクがある'); }
  else if (item.category === 'お金') { total -= 5; reasons.push('-5 お金なのにリンクが無い'); }

  // 反応が多い投稿は当たりの確率が高い。ただし効きすぎないよう上限を置く。
  const engagement = Number(item.likes || 0) + Number(item.reposts || 0) * 2;
  if (engagement > 0) {
    const bonus = Math.min(3, Math.floor(Math.log10(engagement + 1) * 2));
    if (bonus > 0) { total += bonus; reasons.push(`+${bonus} 反応が多い（${engagement}）`); }
  }

  // 短すぎる見出しは意味が取れない。
  const len = strip(item.title).length;
  if (len < 10) { total -= 3; reasons.push('-3 見出しが短すぎる'); }

  // ★過去の採用・却下から学んだ好み★
  // 上の信号は「行動できる告知か」を見ている。こちらは「あなたが選ぶか」。
  // 別の軸なので足すが、学習分は ±MAX_LEARNED に収める。
  // 好みの強さで「終了しました」を拾い上げるようなことを起こさないため。
  if (LEARNED && LEARNED.length) {
    const grams = new Set(ngrams(text));
    let learned = 0;
    const hits = [];
    for (const w of LEARNED) {
      if (grams.has(w.term)) { learned += w.weight; hits.push(w.term); }
    }
    learned = Math.max(-MAX_LEARNED, Math.min(MAX_LEARNED, learned));
    const rounded = Math.round(learned * 10) / 10;
    if (Math.abs(rounded) >= 0.5) {
      total += rounded;
      reasons.push(`${rounded > 0 ? '+' : ''}${rounded} 過去の傾向（${hits.slice(0, 3).join('/')}）`);
    }
  }

  return { total, reasons };
}

const CATEGORIES = ['契約・手続き', 'お金', 'ヘルスケア', 'グルメ', 'ショッピング', 'おでかけ', 'キャリア・学び', 'ヒト', 'その他'];
const PRIORITIES = ['🟢低', '🟡中', '🔴期限迫'];

// 見出しから締切が読めれば拾う。読めなければ空にする（でっち上げない）。
export function extractDeadline(text) {
  const now = new Date();
  const m = String(text).match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})\s*日?\s*(?:まで|締切|〆)/);
  if (!m) return '';
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  let year = now.getFullYear();
  // 過ぎた月なら来年のものとみなす
  if (month < now.getMonth() + 1) year += 1;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

export function toRec(item) {
  const rawTitle = decodeEntities(strip(item.title));
  const title = toTaskTitle(rawTitle, item.desc).slice(0, 60);
  const deadline = extractDeadline(`${item.title} ${item.desc || ''}`);
  // 期限が近いものだけ上げる。全部を🔴にすると優先度が意味を失う。
  let priority = '🟡中';
  if (deadline) {
    const days = (Date.parse(deadline) - Date.now()) / 86400000;
    priority = days <= 7 ? '🔴期限迫' : '🟡中';
  }
  // 定型文除去でほぼ空になることがある（本文の大半が宛名・注意書きだった場合）。
  // 空の詳細欄を出すより、タイトルを見出しとして繰り返す方がまだ分かる。
  const cleanedDesc = truncateAtBoundary(cleanText(strip(item.desc || item.title)), 120);
  return {
    title,
    desc: cleanedDesc.length >= 4 ? cleanedDesc : title,
    category: CATEGORIES.includes(item.category) ? item.category : 'その他',
    source: item.via === 'gmail' ? 'gmail' : (item.via === 'search' || item.via === 'profile' ? 'x' : 'news'),
    icon: item.icon || '📌',
    priority: PRIORITIES.includes(priority) ? priority : '🟡中',
    deadline,
    // http(s) は通常のリンク。message: は Gmail 由来を iOS の「メール」アプリで
    // 直接開くための Message-ID リンク（collect-gmail.mjs 参照）。それ以外の
    // スキーム（javascript: など）は許可しない。
    url: /^(https?|message):/.test(String(item.url || '')) ? item.url : '',
    location: strip(item.location || ''),
  };
}

// index.html:213 と同じ判定。短い語での巻き込みは避ける。
export function isDismissed(title, dismissedTitles) {
  const t = String(title).trim().toLowerCase();
  return dismissedTitles.some((dt) => {
    if (!dt) return false;
    const d = String(dt).toLowerCase();
    if (d === t) return true;
    const shorter = d.length <= t.length ? d : t;
    if (shorter.length < 6) return false;
    return t.indexOf(d) >= 0 || d.indexOf(t) >= 0;
  });
}

// 2026-08-23 実機確認: max を「今 recommendations に残っている id」だけから
// 求めると、却下・採用されて recommendations から消えた id が数に入らず、
// カウンタが巻き戻る。dismissed は一度入ったら消えない台帳なので、そちらも
// 合わせて見ることで巻き戻りを防ぐ（巻き戻ると新しい rec が過去の
// dismissed id と衝突し、フロント側で「既出」判定されて無限に0件表示になる）。
export function assignIds(recs, existing, dismissedIds = []) {
  let max = 0;
  const scan = (id) => {
    const m = String(id || '').match(/^r(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  };
  for (const r of existing) scan(r?.id);
  for (const id of dismissedIds) scan(id);
  let next = max + 1;
  return recs.map((r) => ({ id: `r${next++}`, ...r }));
}

// ★溜まり続けないようにする★
// 落とす順番に意味がある。まず「もう役に立たない」ものを消し、
// それでも多いときだけ古い順に削る。新しさより有用性を優先する。
export function prune(recs, {
  limit = MAX_TOTAL, today = new Date(),
  dismissedIds = [], dismissedTitles = [],
} = {}) {
  const iso = today.toISOString().slice(0, 10);

  /* ★却下済みを枠から外す★
     アプリの dismissRec は dismissed / dismissedTitles に足すだけで、
     recommendations からは消さない。一方ここは上限 60 で古い順に切る。
     結果、2026-08-31 の実測では **60枠のうち 51枠（85%）が、
     二度と表示されない rec で占められていた**。新しい rec が入る余地を
     毎日削っていたのはこれ。
     アプリが表示しないものを、ここで抱え続ける理由はない。 */
  const deadIds = new Set(dismissedIds.filter(Boolean).map(String));
  const deadTitles = new Set(dismissedTitles.filter(Boolean).map((t) => norm(t)));
  const kept = recs.filter((r) => {
    if (r?.id && deadIds.has(String(r.id))) return false;
    if (r?.title && deadTitles.has(norm(r.title))) return false;
    return true;
  });

  // ① 締切を過ぎたものは、残しても押せない
  const alive = kept.filter((r) => !r?.deadline || r.deadline >= iso);

  // ② 同じタイトルが増えたら新しい方を残す（後勝ち）。
  //    毎日同じキャンペーンが流れてくるので、これが効く。
  const byTitle = new Map();
  for (const r of alive) {
    const k = norm(r?.title);
    if (k) byTitle.set(k, r);
  }
  const unique = [...byTitle.values()];

  // ③ それでも多ければ古い順に落とす。末尾が新しいので後ろから残す。
  return unique.length <= limit ? unique : unique.slice(unique.length - limit);
}

async function loadSources() {
  const items = [];
  const found = [];
  for (const f of SOURCE_FILES) {
    try {
      const data = JSON.parse(await readFile(f, 'utf8'));
      const list = Array.isArray(data.items) ? data.items : [];

      /* ★古い収集物は使わない★
         収集に失敗しても前回のファイルは残る。さらに、経路を廃止すると
         （OAuth をやめて IMAP に一本化する等）そのファイルは二度と
         更新されないまま残り続ける。件数だけ見て読み込むと、
         止まった経路の中身を毎晩いつまでも材料に混ぜることになる。
         日次で回る前提なので、36時間を過ぎたものは黙って外す。 */
      const at = Date.parse(data.collectedAt || '');
      const ageH = Number.isFinite(at) ? (Date.now() - at) / 3600000 : null;
      if (ageH !== null && ageH > MAX_SOURCE_AGE_H) {
        found.push(`${f} (${Math.round(ageH)}時間前のため除外)`);
        continue;
      }

      items.push(...list);
      found.push(`${f} (${list.length}件)`);
    } catch {
      // 片方しか無くても動く。両方無いときだけ後で止める。
    }
  }
  return { items, found };
}

async function main() {
  console.log('=== recs の選別・整形（LLM不使用・API課金なし）===');
  console.log(`モード: ${WRITES ? '🚀 LIVE（Firebaseに書き込む）' : '🧪 DRY RUN（書き込まない）'}\n`);

  // 学習結果があれば読む。無くても手書きの重みだけで動く。
  try {
    const data = JSON.parse(await readFile(WEIGHTS_FILE, 'utf8'));
    if (Array.isArray(data.weights) && data.weights.length) {
      LEARNED = data.weights;
      console.log(`学習済みの好み: ${LEARNED.length}語（${(data.learnedAt || '').slice(0, 10) || '日付不明'} 時点）\n`);
    }
  } catch {
    console.log('学習結果なし。手書きの重みだけで選びます（learn-preferences.mjs で作れます）\n');
  }

  const { items, found } = await loadSources();
  if (!found.length) {
    console.error('❌ 材料がありません。先に collect-x.mjs か collect-sources.mjs を実行してください。');
    process.exit(1);
  }
  console.log(`材料: ${found.join(' / ')} = 合計 ${items.length}件\n`);

  const existingRaw = (await fbGet(`${BASE}/recommendations`).catch(() => [])) || [];
  const existing = Array.isArray(existingRaw) ? existingRaw.filter(Boolean) : [];
  const dismissedTitles = (await fbGet(`${BASE}/dismissedTitles`).catch(() => [])) || [];
  const dismissedIds = (await fbGet(`${BASE}/dismissed`).catch(() => [])) || [];
  const tasks = (await fbGet(`${BASE}/tasks`).catch(() => [])) || [];
  const taskNames = (Array.isArray(tasks) ? tasks : Object.values(tasks))
    .filter(Boolean).map((t) => norm(t.name));
  console.log(`既存recs ${existing.length}件 / dismissedTitles ${dismissedTitles.length}件 / tasks ${taskNames.length}件\n`);

  // ── 除外 ──
  const seen = new Set(existing.map((r) => norm(r.title)));
  const dropped = { dup: 0, dismissed: 0, alreadyTask: 0, lowScore: 0 };
  const scored = [];

  for (const item of items) {
    /* ★照合は「保存する文字列」で行う★
       ここは長く、素材（メール・X）の生タイトルで重複と却下を判定していた。
       ところが実際に保存する rec のタイトルは toRec が toTaskTitle で
       書き換えたもので、アプリが dismissedTitles に積むのもその書き換え後。
       つまり **照合する文字列と、却下される文字列が別物** だった。

       生タイトルは配信ごとに文言がぶれるので却下判定をすり抜け、
       書き換え後は同じ文言に収束するのでアプリ側で完全一致に当たる。
       結果、同じものが毎日作られてはアプリで黙って消えていた
       （2026-08-31 の実測で 13件中 4件）。

       既存 recs（seen）も書き換え後のタイトルを持っているので、
       生タイトルで突き合わせても一致しないという同じずれがあった。 */
    const finalTitle = toRec(item).title;
    const key = norm(finalTitle);
    if (!key || seen.has(key)) { dropped.dup += 1; continue; }
    // 生と書き換え後の両方を見る。古い dismissedTitles には
    // 生タイトルのまま積まれたものも混ざっているため。
    if (isDismissed(finalTitle, dismissedTitles) || isDismissed(item.title, dismissedTitles)) {
      dropped.dismissed += 1; continue;
    }
    if (taskNames.includes(key)) { dropped.alreadyTask += 1; continue; }
    seen.add(key);
    const s = score(item);
    // 負の点は「出しても行動につながらない」と判定したもの。
    if (s.total < 0) { dropped.lowScore += 1; continue; }
    scored.push({ item, ...s });
  }

  console.log('── 除外 ──');
  console.log(`  既出・重複 ${dropped.dup}件 / 却下済み ${dropped.dismissed}件 / タスク化済み ${dropped.alreadyTask}件 / スコア不足 ${dropped.lowScore}件`);
  console.log(`  残り ${scored.length}件\n`);

  // ── 選別。点数順に取りつつ、1カテゴリが偏らないようにする ──
  scored.sort((a, b) => b.total - a.total);
  const perCategory = new Map();
  const picked = [];
  for (const s of scored) {
    if (picked.length >= MAX_RECS) break;
    const cat = s.item.category || 'その他';
    const n = perCategory.get(cat) || 0;
    if (n >= MAX_PER_CATEGORY) continue;
    perCategory.set(cat, n + 1);
    picked.push(s);
  }

  console.log('── 選別結果 ──');
  for (const [cat, n] of perCategory) console.log(`  ${cat.padEnd(8, '　')} ${n}件`);
  console.log(`  合計 ${picked.length}件（上限 ${MAX_RECS} / カテゴリ上限 ${MAX_PER_CATEGORY}）\n`);

  console.log('── 上位5件と選ばれた理由 ──');
  for (const s of picked.slice(0, 5)) {
    console.log(`  [${String(s.total).padStart(2)}点] ${strip(s.item.title).slice(0, 40)}`);
    console.log(`         ${s.reasons.join(' / ')}`);
  }
  console.log('');

  const recs = picked.map((s) => toRec(s.item)).filter((r) => r.title);
  const withIds = assignIds(recs, existing, dismissedIds);

  await writeFile('recs-built-preview.json', JSON.stringify(withIds, null, 2));
  console.log(`📦 recs-built-preview.json に ${withIds.length}件を保存`);

  if (!withIds.length) {
    console.error('\n❌ 0件です。書き込みは行いません。');
    console.error('   材料が少ないか、除外が効きすぎている可能性があります。');
    process.exit(1);
  }
  if (withIds.length < MIN_RECS) {
    console.warn(`\n⚠️ ${withIds.length}件で、目標の ${MIN_RECS}件に届いていません（材料不足）。`);
  }

  if (!WRITES) {
    console.log('\n🧪 DRY RUN のため書き込んでいません。');
    console.log('   反映するには MODE=live node scripts/build-recs.mjs');
    console.log('=== 完了・課金は発生していません（$0）===');
    return;
  }

  // ★書き込む前に必ず退避する★
  await writeFile('recs-backup.json', JSON.stringify(existingRaw, null, 2));
  console.log('📦 既存recsを recs-backup.json に退避');

  // 既存を消さず末尾に足す。アプリ側の .set() は全置換なので、ここで消すと復元できない。
  // ただし毎日 20件超が積まれるので、放っておくと1週間で200件を超える。
  // 一覧として使えなくなるだけでなく、既出除外の照合も重くなる。
  const merged = prune(existing.concat(withIds), { dismissedIds, dismissedTitles });
  await fbPut(`${BASE}/recommendations`, merged);
  const removed = existing.length + withIds.length - merged.length;
  console.log(`\n✅ 書き込み完了: ${BASE}/recommendations（既存 ${existing.length} + 新規 ${withIds.length}${removed ? ` − 整理 ${removed}` : ''} = ${merged.length}件）`);

  const after = (await fbGet(`${BASE}/recommendations`).catch(() => null)) || [];
  const n = Array.isArray(after) ? after.filter(Boolean).length : 0;
  console.log(n === merged.length ? `✅ 反映を確認（${n}件）` : `⚠️ 反映後の件数が想定と違います（${n} vs ${merged.length}）`);
  console.log('=== 完了・課金は発生していません（$0）===');
}

// テストから import したときに本体が走らないよう、直接実行のときだけ動かす。
// endsWith だと test-build-recs.mjs も一致してしまうので、ファイル名を厳密に比べる。
const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'build-recs.mjs') main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });
