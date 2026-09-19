// 期限が近づいたタスクを Slack にリマインドする。
//
// ★プライバシー方針★
// このリポジトリは public。リマインド本文にはタスク名が載るので、
// 送信先の Slack 以外には絶対に出さない。標準出力に本文を出すのは
// DRY_RUN のときだけで、その用途はローカル（ログ非公開）に限る。
// 定期実行は Mac の launchd で回す前提。GitHub Actions では動かさないこと。
//
// 環境変数:
//   FIREBASE_URL        必須
//   FIREBASE_SECRET     必須（DBは認証必須。未指定だと401になる）
//   SLACK_WEBHOOK_URL   必須（未設定なら送信せず終了。DRY_RUN では不要）
//   SLACK_MENTION       任意。期限切れ／本日期限がある時だけ先頭に付ける
//                       （例 <@U0A5V22PVTQ>）。未設定ならメンションしない
//   SLOT                morning | evening（既定 morning）
//   DRY_RUN             true なら送信せず本文を標準出力に出す
//   STATE_FILE          二重送信防止の記録先（既定 .remind-state.json）
//
// 実行: node scripts/remind-deadlines.mjs

import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'users/yokota';

// どの残り日数でリマインドするか。ここに載らない日数は通知しない。
// 8日以上先のものは毎日流すと慣れて無視されるので、意図的に外している。
export const THRESHOLDS = [
  { key: 'overdue', label: '期限切れ', emoji: '🚨', match: (d) => d < 0 },
  { key: 'today', label: '本日が期限', emoji: '⏰', match: (d) => d === 0 },
  { key: 'tomorrow', label: '明日が期限', emoji: '⚠️', match: (d) => d === 1 },
  { key: 'd3', label: '3日以内', emoji: '📌', match: (d) => d >= 2 && d <= 3 },
  { key: 'd7', label: '7日以内', emoji: '🗓️', match: (d) => d >= 4 && d <= 7 },
];

// 夕方は「今日中に片づける必要があるもの」だけに絞る。
// 朝に全部見せているので、夕方も同じ量を流すと通知疲れを起こす。
export const SLOT_KEYS = {
  morning: ['overdue', 'today', 'tomorrow', 'd3', 'd7'],
  evening: ['overdue', 'today'],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD を JST の日付として解釈し、基準日との日数差を返す。 */
export function daysUntil(deadline, today) {
  if (!DATE_RE.test(deadline || '')) return null;
  const d = new Date(`${deadline}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  const base = new Date(`${today}T00:00:00+09:00`);
  return Math.round((d - base) / 86400000);
}

/** JST の今日を YYYY-MM-DD で返す。サーバのTZに依存させない。 */
export function todayJst(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** 生のタスク配列から、通知対象を残り日数つきで抽出する。 */
export function selectTasks(raw, today, slot = 'morning') {
  const arr = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter((t) => t && t.name);
  const allowed = new Set(SLOT_KEYS[slot] || SLOT_KEYS.morning);

  const picked = [];
  for (const t of arr) {
    if (t.status === 'done') continue;
    const days = daysUntil(t.deadline, today);
    if (days === null) continue;
    const bucket = THRESHOLDS.find((b) => b.match(days));
    if (!bucket || !allowed.has(bucket.key)) continue;
    picked.push({ ...t, days, bucket: bucket.key });
  }
  // 期限が近い順。同じ日ならタスク名で安定させる。
  picked.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name), 'ja'));
  return picked;
}

/** 残り日数を人が読む形に。 */
export function humanDays(days) {
  if (days < 0) return `${Math.abs(days)}日超過`;
  if (days === 0) return '本日';
  if (days === 1) return '明日';
  return `あと${days}日`;
}

/**
 * Slack でリンクとして機能するURLかどうか。
 * タスクの url には Gmail のメッセージID（message:<...@...>）のような
 * http 以外のスキームが入ることがあり、そのまま <url|リンク> にすると
 * クリックできない壊れたリンクになる。実データで確認済み。
 */
export function isLinkable(url) {
  return /^https?:\/\/\S+$/i.test(String(url || '').trim());
}

/** 1行分の表示。タスク名は改行可なので1行に潰す。 */
export function formatTask(t) {
  const name = String(t.name).replace(/\s*\n+\s*/g, ' ').trim();
  const icon = t.icon ? `${t.icon} ` : '';
  const loc = t.location ? `　📍${t.location}` : '';
  const url = isLinkable(t.url) ? `　<${t.url}|リンク>` : '';
  return `• ${icon}*${name}*　_${t.deadline}（${humanDays(t.days)}）_${loc}${url}`;
}

/**
 * メンションを付ける区分。期限切れと本日期限だけに絞る。
 * 全部の通知でメンションすると通知が日常化して効かなくなるので、
 * 「今すぐ手を打つ必要があるもの」がある時だけ鳴らす。
 */
export const MENTION_KEYS = ['overdue', 'today'];

/** メンションすべきか。該当区分が1件でもあれば true。 */
export function needsMention(tasks) {
  return tasks.some((t) => MENTION_KEYS.includes(t.bucket));
}

/** Slack に送る本文を組み立てる。対象ゼロなら null（＝送らない）。 */
export function buildMessage(tasks, { slot = 'morning', today, mention = '' } = {}) {
  if (!tasks.length) return null;

  const base = slot === 'evening'
    ? `🌆 今日中のタスク確認（${today}）`
    : `🌅 今日の期限リマインド（${today}）`;
  // メンションは先頭に置く。本文の途中だと通知のプレビューで見えない。
  const heading = mention && needsMention(tasks) ? `${mention} ${base}` : base;

  const lines = [heading, ''];
  for (const b of THRESHOLDS) {
    const group = tasks.filter((t) => t.bucket === b.key);
    if (!group.length) continue;
    lines.push(`${b.emoji} *${b.label}*　${group.length}件`);
    for (const t of group) lines.push(formatTask(t));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * 同じ枠で同じ日に二度送らないための鍵。
 * launchd は復帰時に取りこぼした起動をまとめて実行することがあるため、
 * 日付＋枠で1回に制限する。
 */
export function stateKey(today, slot) {
  return `${today}#${slot}`;
}

async function fbGet(path) {
  const url = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
  const secret = process.env.FIREBASE_SECRET || '';
  if (!url) throw new Error('FIREBASE_URL が未設定です');
  const auth = secret ? `?auth=${secret}` : '';
  const res = await fetch(`${url}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Slack へ送る。失敗したら間隔を空けて数回試す。
 *
 * 1日2回しか走らないので、1回落とすとその枠の通知が丸ごと消える。
 * 実際に hooks.slack.com へ数分間つながらない事象が起き、launchd 経由の
 * 実行が fetch failed で終わった（2026-09-20）。数分の瞬断で期限切れの
 * 通知が静かに失われるのは困るので、待ってから鳴らし直す。
 *
 * 4xx（URL誤り・アプリ削除など）は何度試しても直らないので即座に諦める。
 */
export async function postSlack(text, { fetchImpl = fetch, retries = 4, baseDelayMs = 5000 } = {}) {
  const hook = process.env.SLACK_WEBHOOK_URL || '';
  if (!hook) throw new Error('SLACK_WEBHOOK_URL が未設定です');

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mrkdwn: true }),
      });
      const body = (await res.text()).trim();
      if (res.ok && body === 'ok') return attempt;

      // 429 は待てば通る。それ以外の 4xx は設定が悪いので再試行しても無駄。
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Slack 送信失敗（設定を確認）: status=${res.status} body=${body.slice(0, 200)}`);
      }
      lastError = new Error(`Slack 送信失敗: status=${res.status} body=${body.slice(0, 200)}`);
    } catch (e) {
      if (String(e.message).includes('設定を確認')) throw e;
      lastError = e;
    }

    if (attempt < retries) {
      const wait = baseDelayMs * 2 ** (attempt - 1);
      console.log(`  送信に失敗（${attempt}/${retries}）。${wait / 1000}秒後に再試行: ${lastError.message}`);
      await sleep(wait);
    }
  }
  throw new Error(`Slack 送信に${retries}回失敗しました: ${lastError.message}`);
}

async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}

async function main() {
  const slot = (process.env.SLOT || 'morning').toLowerCase();
  if (!SLOT_KEYS[slot]) throw new Error(`SLOT が不正です: ${slot}`);
  const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
  const stateFile = process.env.STATE_FILE || '.remind-state.json';
  const today = todayJst();
  const key = stateKey(today, slot);

  const state = await readState(stateFile);
  if (!dryRun && state.lastSent === key) {
    console.log(`既に送信済みのためスキップ: ${key}`);
    return;
  }

  const tasks = selectTasks(await fbGet(`${BASE}/tasks`), today, slot);
  const mention = process.env.SLACK_MENTION || '';
  const message = buildMessage(tasks, { slot, today, mention });

  // ★件数だけをログに出す。タスク名は絶対に出さない★
  console.log(`[${new Date().toISOString()}] slot=${slot} today=${today} 対象=${tasks.length}件`);
  const byBucket = {};
  for (const t of tasks) byBucket[t.bucket] = (byBucket[t.bucket] || 0) + 1;
  for (const b of THRESHOLDS) if (byBucket[b.key]) console.log(`  ${b.label}: ${byBucket[b.key]}件`);

  if (!message) {
    console.log('対象なし。送信しません。');
    return;
  }

  if (dryRun) {
    console.log('\n--- DRY_RUN のため送信しません。以下が送られる本文です ---');
    console.log(message);
    return;
  }

  const attempts = await postSlack(message);
  await writeFile(stateFile, JSON.stringify({ lastSent: key, at: new Date().toISOString() }, null, 2));
  console.log(`Slack へ送信しました。${attempts > 1 ? `（${attempts}回目で成功）` : ''}`);
}

// テストから import したときに実行されないよう、直接実行のときだけ動かす。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error('❌ 失敗:', e.message); process.exit(1); });
}
