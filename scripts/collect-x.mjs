// X（Twitter）から recs の材料を集める。読み取りのみ・Firebaseには書かない・API課金なし。
//
// ★X API は使わない★
// X API は 2026-02 に無料枠が廃止され、投稿の読み取りは $0.005/件 の従量課金になった。
// ここで使うのは Web クライアントと同じ経路で、自分のログイン済みセッションで読む。
// 自分のアカウントで自分が見られるものを見るだけなので、未認証アクセスではない。
//
// ★2つの取り方を用意して、通ったほうを使う★
//   A) 検索        … Cookie が要る。X_AUTH_TOKEN / X_CT0 があれば試す
//   B) プロフィール … Cookie 不要。特定アカウントの新着を拾う（生 fetch で可）
// A が通らなくても B だけで材料は集まるので、鍵なしでも動く。
//
// ★A（検索）は生 fetch では通らない★
// 2026-08-16 実機確認: 正しい queryId・パス（/graphql/、旧 /i/api/graphql/ は
// 404 になる）と正しい Cookie を使っても 401。X 側がリクエストごとの署名
// （x-client-transaction-id など、ブラウザで JS を実行しないと算出できない値）
// を要求しているためと判明。curl や fetch では原理的に回避できない
// （Cloudflare の TLS/HTTP2 フィンガープリント判定と推測）。
// 実ブラウザ（Playwright で headless 起動した実 Chrome、channel: 'chrome'）
// 経由なら Cookie を積むだけで 200 になることを確認済み。以降、検索は
// Playwright 経由で行う。プロフィールは生 fetch のままで十分（Cookie 不要）。
//
// ★静かにゼロ件になるのを防ぐ★
// X はこの種の経路を継続的に塞ぐ。壊れたときに「今日は何も無かった」と
// 区別がつかないのが一番まずいので、方式ごとの成否と件数を必ず出す。
//
// 実行: node scripts/collect-x.mjs

import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const AUTH_TOKEN = process.env.X_AUTH_TOKEN || '';
const CT0 = process.env.X_CT0 || '';
const HAS_COOKIE = Boolean(AUTH_TOKEN && CT0);

const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 14);

// 「ちゃんと話題になっているもの」だけを拾うための既定のいいね下限。
// 以前は下限が無く、収集100件の中央値が3いいね・28件が0いいねだった。
// 反応の無い告知が候補に混ざると、選ぶ側の負担だけが増える。
const DEFAULT_MIN_FAVES = Number(process.env.MIN_FAVES || 30);

// 検索演算子が無視された場合の保険。トピックごとの下限より緩くしておき、
// 「明らかに話題になっていないもの」だけを落とす。
const MIN_FAVES_FLOOR = Number(process.env.MIN_FAVES_FLOOR || 10);

/**
 * 検索語に X の検索演算子を足す。
 *   min_faves … 話題になっているものだけに絞る。収集時点で切るのが一番効く
 *   lang:ja   … 日本語の告知だけ
 *   -filter:retweets … 同じ告知がRTで重複するのを防ぐ
 * 旧コードの `-is:retweet` は API v2 の書き方で、web 検索では効かない。
 */
const q = (text, minFaves = DEFAULT_MIN_FAVES) =>
  `${text} min_faves:${minFaves} lang:ja -filter:retweets`;

// 検索語と、拾いたいアカウント。アカウントは「告知が流れてくる場所」を選ぶ。
//
// カテゴリは index.html の9カテゴリに合わせる。
// （契約・手続き / お金 / ヘルスケア / グルメ / ショッピング / おでかけ /
//   キャリア・学び / ヒト / その他）
// エンタメ専用のカテゴリは無いので、映画・ライブ・展示は「おでかけ」に寄せる。
//
// ★お得情報は「お金」に集めず、対象カテゴリ側に置く★
// 飲食の半額はグルメ、旅行セールはおでかけ、物販セールはショッピング。
// 全部お金に入れると、その日の関心（何を食べる・どこへ行く）から探せなくなる。
const TOPICS = [
  // ── グルメ ──────────────────────────────────────────
  {
    key: 'グルメ', category: 'グルメ', icon: '🍽️',
    queries: [q('新店 オープン 話題'), q('期間限定 メニュー 登場'), q('food フェア 開催')],
    accounts: [],
    must: ['オープン', '開店', '限定', 'メニュー', '新作', 'フェア', '発売'],
  },
  {
    key: 'グルメお得', category: 'グルメ', icon: '🍜',
    // 半額・無料は反応が伸びやすいので下限を上げても取りこぼさない
    queries: [q('半額 クーポン 飲食', 50), q('食べ放題 キャンペーン', 30), q('無料 配布 ドリンク', 50)],
    accounts: [],
    must: ['半額', 'クーポン', '無料', '割引', '食べ放題', 'キャンペーン'],
  },

  // ── おでかけ（旅行・エンタメ・サウナ）────────────────
  {
    key: '旅行', category: 'おでかけ', icon: '✈️',
    queries: [q('航空券 セール 期間限定'), q('ホテル 割引 キャンペーン'), q('新幹線 旅行 お得 きっぷ')],
    accounts: [],
    must: ['セール', '割引', 'キャンペーン', '予約', '就航', 'きっぷ', 'プラン'],
  },
  {
    key: 'エンタメ', category: 'おでかけ', icon: '🎬',
    // 映画・ライブは母数が大きく反応も伸びるため下限を高めにして雑音を落とす
    queries: [q('映画 公開 話題', 100), q('ライブ チケット 先行 発売', 50), q('展覧会 開催 東京', 50)],
    accounts: [],
    must: ['公開', '上映', 'ライブ', 'チケット', '展覧会', '開催', '発売', '開幕'],
  },
  {
    key: 'サウナ', category: 'おでかけ', icon: '♨️',
    queries: [q('サウナ 新店 オープン', 20), q('サウナ オープン 東京', 20)],
    accounts: ['saunaikitai'],
    must: ['サウナ', 'ととのい', '温浴', 'スパ'],
  },

  // ── ショッピング ────────────────────────────────────
  {
    key: 'ショッピング', category: 'ショッピング', icon: '🛍️',
    queries: [q('セール 開催 お得', 50), q('ポイント還元 セール', 30), q('発売 予約開始 限定', 50)],
    accounts: [],
    must: ['セール', '発売', '予約', '限定', 'ポイント', '還元', '割引'],
  },

  // ── お金（カテゴリを跨ぐ、金融そのものの話）──────────
  {
    key: 'ポイ活', category: 'お金', icon: '💰',
    // payannounce・rakutenpay は 2026-08-16 時点でアカウント消滅（404）のため削除
    queries: [q('ポイ活 キャンペーン 還元', 20), q('キャッシュバック キャンペーン 開始', 20)],
    accounts: [],
    must: ['キャンペーン', '還元', 'ポイント', 'キャッシュバック', '増量'],
  },
  {
    key: 'クリプト', category: 'お金', icon: '🪙',
    queries: [q('エアドロップ 配布 キャンペーン', 20), q('暗号資産 取引所 キャンペーン', 20)],
    accounts: ['bitbank_inc', 'coincheckjp'],
    must: ['キャンペーン', 'エアドロップ', '配布', '付与', '上場'],
  },

  // ── キャリア・学び ──────────────────────────────────
  {
    key: 'テック', category: 'キャリア・学び', icon: '💻',
    // connpass は 2026-08-16 時点でハンドルが別人（無関係な鍵垢）に
    // 乗っ取られているため削除
    queries: [q('カンファレンス 開催 エンジニア', 20), q('ハッカソン 募集', 20)],
    accounts: [],
    must: ['カンファレンス', '勉強会', 'ハッカソン', 'イベント', '登壇', '募集'],
  },
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// プロフィールページ（HTML ルート）は API 用の authorization ヘッダーを
// 付けると 401 になる（2026-08-16 実機確認）。UA と言語だけの素のブラウザ
// リクエストにする。
function profileHeaders() {
  return {
    'User-Agent': UA,
    'Accept-Language': 'ja,en;q=0.8',
  };
}

async function get(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── A) 検索（Cookie が要る・headless 実 Chrome で実行）──
//
// 検索ページを開いて SearchTimeline への応答を横取りする。ページの JS が
// 署名ヘッダーの算出からリクエスト送信まで全部やってくれるので、こちらは
// Cookie を積んでナビゲートするだけでいい。ブラウザは呼び出し側
// （runSearches）で 1 回だけ起動し、使い回す。
async function searchX(context, query) {
  const page = await context.newPage();
  try {
    const respPromise = page.waitForResponse(
      (res) => res.url().includes('/SearchTimeline'),
      { timeout: 20000 },
    );
    const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const res = await respPromise;
    if (!res.ok()) return { ok: false, status: res.status(), items: [] };
    const json = await res.json();
    return { ok: true, status: res.status(), items: extractFromGraphql(json) };
  } catch (e) {
    return { ok: false, status: e.name === 'TimeoutError' ? 'timeout' : e.message, items: [] };
  } finally {
    await page.close();
  }
}

// 検索に使うブラウザコンテキストを 1 回だけ用意する。Chrome 本体
// （channel: 'chrome'）を headless 起動する。バンドルされた Chromium だと
// ボット判定に弾かれやすいが、実 Chrome なら通ることを実機確認済み。
async function openSearchContext() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  await context.addCookies([
    { name: 'auth_token', value: AUTH_TOKEN, domain: '.x.com', path: '/' },
    { name: 'ct0', value: CT0, domain: '.x.com', path: '/' },
  ]);
  return { browser, context };
}

// GraphQL の入れ子は版によって変わるので、決め打ちで辿らずに
// 「legacy を持つオブジェクト」を再帰で拾う。多少の構造変更なら耐える。
function extractFromGraphql(root) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const lg = node.legacy;
    if (lg && (lg.full_text || lg.text) && (lg.id_str || node.rest_id)) {
      const id = lg.id_str || node.rest_id;
      if (!seen.has(id)) {
        seen.add(id);
        const handle = node.core?.user_results?.result?.legacy?.screen_name
          || node.core?.screen_name || '';
        out.push({
          id,
          text: String(lg.full_text || lg.text),
          createdAt: lg.created_at || '',
          handle,
          likes: Number(lg.favorite_count || 0),
          reposts: Number(lg.retweet_count || 0),
        });
      }
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(root);
  return out;
}

// ── B) プロフィール（Cookie 不要。実測で通ることを確認済み）──
//
// 2026-08-16 実機確認: プロフィール HTML は schema.org の microdata で
// 投稿を埋め込む形式に変わっている。1投稿が
//   <article ... data-tweet-id="123">
//     <meta content="ID" itemProp="identifier"/>
//     <meta content="2026-08-14T..." itemProp="dateCreated"/>
//     <meta content="本文" itemProp="text"/>
//     ...
//   </article>
// という並び（content 属性が先、itemProp が後）。旧コードは
// "full_text":"..." という GraphQL JSON 埋め込み（すでに廃止済み）を
// 探していたため、200 が返っても常に 0 件だった。
async function fetchProfile(handle) {
  const res = await get(`https://x.com/${handle}`, profileHeaders());
  if (!res.ok) return { ok: false, status: res.status, items: [] };
  const items = [];
  const seen = new Set();
  for (const chunk of res.text.split('<article ').slice(1)) {
    const idm = chunk.match(/data-tweet-id="(\d+)"/);
    const textm = chunk.match(/content="((?:[^"\\]|\\.)*)" itemProp="text"/);
    const datem = chunk.match(/content="([^"]*)" itemProp="dateCreated"/);
    if (!idm || !textm) continue;
    const id = idm[1];
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text: decodeHtmlText(textm[1]), createdAt: datem ? datem[1] : '', handle, likes: 0, reposts: 0 });
  }
  return { ok: true, status: res.status, items };
}

function decodeHtmlText(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const norm = (s) => s.toLowerCase().replace(/[\s　"'“”‘’|｜・,、。．.]/g, '');

function withinAge(createdAt) {
  if (!createdAt) return true;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) / 86400000 <= MAX_AGE_DAYS;
}

// 装飾絵文字・記号だけの行（"🎪08.23(sun)°🌙 •┈˙˚ʚ♡ɞ˚˙┈• 再掲" のような）は
// 文字数はあっても中身が無い。日付の数字などが混じると単純な文字数閾値だけでは
// すり抜けるので、文字・数字（漢字仮名含む）が行全体の半分以上を占めることも要求する。
const meaningfulLen = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;
const isMeaningfulLine = (s) => {
  const ml = meaningfulLen(s);
  return ml >= 6 && ml / s.length >= 0.5;
};

// 投稿本文はそのままだと rec のタイトルに長すぎる。1行目を見出しとして使う。
// ただし装飾だけの行は飛ばして、内容のある行を探す。
export function toTitle(text) {
  const lines = text.split('\n').map((s) => s.trim());
  const first = lines.find(isMeaningfulLine) || lines.find((s) => s.length >= 6) || text.trim();
  // 60字ではなく90字まで残す。build-recs.mjs 側で「〜を確認する」のような
  // タスク形式の動詞を足すため、素材に少し余白を持たせておく。
  return first.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// 以前は desc を作っていなかったため、rec の「詳細」欄はタイトルの
// コピーになっていた（=中身が無い）。投稿本文の全行（見出しに使った行も
// 含む）を URL 抜きで並べたものを渡す。長さの調整・整形は build-recs.mjs
// 側で行う（ここでは素材をなるべく残す）。
export function toDesc(text) {
  return String(text)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  console.log('=== X から recs の材料を収集（読み取りのみ・X API不使用・課金なし）===');
  console.log(`Cookie: ${HAS_COOKIE ? 'あり（検索も試す）' : 'なし（プロフィールのみ）'}`);
  console.log(`対象期間: 直近 ${MAX_AGE_DAYS} 日\n`);

  const collected = [];
  const seen = new Set();
  const report = [];

  let browser = null;
  let context = null;
  if (HAS_COOKIE) {
    try {
      ({ browser, context } = await openSearchContext());
    } catch (e) {
      console.warn(`⚠️ headless Chrome の起動に失敗。検索は今回スキップします: ${e.message}`);
    }
  }

  for (const topic of TOPICS) {
    let viaSearch = 0;
    let viaProfile = 0;
    let belowFaves = 0;
    const failures = [];

    if (context) {
      for (const q of topic.queries) {
        const r = await searchX(context, q);
        if (!r.ok) { failures.push(`検索 status ${r.status}`); continue; }
        for (const it of r.items) {
          if (!withinAge(it.createdAt)) continue;
          // min_faves は検索側で効くはずだが、演算子が無視された場合に
          // 反応ゼロの投稿がそのまま入るので、手元でも同じ線で切る。
          if (Number(it.likes || 0) < MIN_FAVES_FLOOR) { belowFaves += 1; continue; }
          const title = toTitle(it.text);
          const key = norm(title);
          if (!key || seen.has(key)) continue;
          if (!topic.must.some((w) => it.text.includes(w))) continue;
          seen.add(key);
          collected.push({ ...pick(topic), title, desc: toDesc(it.text), url: `https://x.com/i/status/${it.id}`, via: 'search', likes: it.likes });
          viaSearch += 1;
        }
      }
    }

    for (const handle of topic.accounts) {
      const r = await fetchProfile(handle);
      if (!r.ok) { failures.push(`@${handle} status ${r.status}`); continue; }
      for (const it of r.items) {
        const title = toTitle(it.text);
        const key = norm(title);
        if (!key || seen.has(key)) continue;
        if (!topic.must.some((w) => it.text.includes(w))) continue;
        seen.add(key);
        collected.push({ ...pick(topic), title, desc: toDesc(it.text), url: `https://x.com/${handle}/status/${it.id}`, via: 'profile', likes: 0 });
        viaProfile += 1;
      }
    }

    report.push({
      key: topic.key, viaSearch, viaProfile, belowFaves, failures,
    });
  }

  if (browser) await browser.close();

  console.log('── 方式別の取得件数 ──');
  for (const r of report) {
    console.log(`  ${r.key.padEnd(6, '　')} 検索 ${String(r.viaSearch).padStart(3)}件 / プロフィール ${String(r.viaProfile).padStart(3)}件 / 反応不足で除外 ${String(r.belowFaves ?? 0).padStart(3)}件`);
    for (const f of r.failures) console.log(`      ⚠️ ${f}`);
  }

  const totalSearch = report.reduce((a, r) => a + r.viaSearch, 0);
  const totalProfile = report.reduce((a, r) => a + r.viaProfile, 0);
  console.log(`\n  合計 ${collected.length}件（検索 ${totalSearch} / プロフィール ${totalProfile}）\n`);

  // ★静かにゼロ件で終わらせない★
  if (!collected.length) {
    console.error('❌ 1件も取れていません。X 側の仕様変更か Cookie の失効が疑われます。');
    console.error('   ・検索が全滅 → X_AUTH_TOKEN / X_CT0 の失効、headless Chrome 起動失敗、または X 側のページ構造変更');
    console.error('   ・プロフィールも全滅 → X が未認証アクセスを塞いだ可能性');
    process.exit(1);
  }
  if (HAS_COOKIE && totalSearch === 0) {
    console.warn('⚠️ Cookie はあるのに検索が0件。Cookie 失効・queryId 変更・headless Chrome 起動失敗のいずれかを疑う（プロフィール分だけ使います）');
  }

  console.log('── 見出しの例（各カテゴリ最大3件）──');
  for (const topic of TOPICS) {
    const list = collected.filter((c) => c.key === topic.key).slice(0, 3);
    if (!list.length) continue;
    console.log(`  【${topic.key}】`);
    for (const c of list) console.log(`    ・${c.title}`);
  }

  await writeFile('collected-x.json', JSON.stringify({
    collectedAt: new Date().toISOString(),
    counts: { total: collected.length, search: totalSearch, profile: totalProfile },
    items: collected,
  }, null, 2));

  console.log(`\n📦 collected-x.json に ${collected.length}件を保存`);
  console.log('=== 収集完了・課金は発生していません（$0）===');
}

const pick = (t) => ({ key: t.key, category: t.category, icon: t.icon });

const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'collect-x.mjs') main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });
