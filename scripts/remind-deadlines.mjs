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

/** 1行分の表示。タスク名は改行可なので1行に潰す。 */
export function formatTask(t) {
  const name = String(t.name).replace(/\s*\n+\s*/g, ' ').trim();
  const icon = t.icon ? `${t.icon} ` : '';
  const loc = t.location ? `　📍${t.location}` : '';
  const url = t.url ? `　<${t.url}|リンク>` : '';
  return `• ${icon}*${name}*　_${t.deadline}（${humanDays(t.days)}）_${loc}${url}`;
}

/** Slack に送る本文を組み立てる。対象ゼロなら null（＝送らない）。 */
export function buildMessage(tasks, { slot = 'morning', today } = {}) {
  if (!tasks.length) return null;

  const heading = slot === 'evening'
    ? `🌆 今日中のタスク確認（${today}）`
    : `🌅 今日の期限リマインド（${today}）`;

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

async function postSlack(text) {
  const hook = process.env.SLACK_WEBHOOK_URL || '';
  if (!hook) throw new Error('SLACK_WEBHOOK_URL が未設定です');
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, mrkdwn: true }),
  });
  const body = await res.text();
  // Slack は失敗時も 200 を返さないので、本文まで見て判断する
  if (!res.ok || body.trim() !== 'ok') {
    throw new Error(`Slack 送信失敗: status=${res.status} body=${body.slice(0, 200)}`);
  }
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
  const message = buildMessage(tasks, { slot, today });

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

  await postSlack(message);
  await writeFile(stateFile, JSON.stringify({ lastSent: key, at: new Date().toISOString() }, null, 2));
  console.log('Slack へ送信しました。');
}

// テストから import したときに実行されないよう、直接実行のときだけ動かす。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error('❌ 失敗:', e.message); process.exit(1); });
}
