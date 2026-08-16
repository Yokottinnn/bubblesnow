// X（Twitter）に「認証なしで」どこまで届くかを実測する。読み取りのみ・課金なし。
//
// ★なぜ測るのか★
// 「インターネットに出られるPCがあれば無料で検索できるのでは」という見立ては
// 回線の話としては正しい。GitHub Actions のランナーは egress 制限がなく実行時間も無料で、
// 実際そこから Google ニュースや はてブは取れている。
// 問題は回線ではなく X 側の認証で、API 料金は「回線代」ではなく
// 「認証済みでデータを取る権利」の値段。
//
// ただしそれが現時点で実際どうなのかは測っていない。推測で結論を出さずに確かめる。
// 各エンドポイントに1回ずつ当てて、ステータスと「ログイン壁かどうか」だけを見る。
//
// ★ログに中身は出さない★
// このリポジトリは public。投稿本文やユーザー名は出さず、
// ステータス・バイト数・判定結果だけを出力する。
//
// 実行: node scripts/probe-x-access.mjs

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 認証なしで叩ける可能性がある口を、性質の違うものから選ぶ。
const TARGETS = [
  { name: 'x.com 検索ページ',        url: 'https://x.com/search?q=%E3%83%9D%E3%82%A4%E6%B4%BB&f=live' },
  { name: 'x.com プロフィール',      url: 'https://x.com/elonmusk' },
  { name: 'twitter.com 検索',        url: 'https://twitter.com/search?q=%E3%83%9D%E3%82%A4%E6%B4%BB' },
  { name: 'syndication タイムライン', url: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/elonmusk' },
  { name: 'publish.twitter oEmbed',  url: 'https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Felonmusk%2Fstatus%2F20' },
  { name: 'nitter.net',              url: 'https://nitter.net/search?q=poikatsu' },
];

// ログイン壁・JSシェルだけ返ってきたかの見分け。
// 本文は出さず、目印が含まれるかどうかだけを見る。
const WALL_MARKS = [
  'Log in to X', 'ログイン', 'JavaScript is not available',
  'Something went wrong', 'signup', 'guest_token',
];

async function probe(t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    const ms = Date.now() - started;

    // 実際に投稿が入っていそうかの目安。JSONなら本文キー、HTMLなら投稿リンク。
    const hasTweetLinks = /\/status\/\d{8,}/.test(body);
    const hasJsonText = /"full_text"|"text"\s*:/.test(body);
    const wall = WALL_MARKS.filter((w) => body.includes(w));

    return {
      name: t.name,
      status: res.status,
      finalHost: new URL(res.url).host,
      bytes: body.length,
      ms,
      hasTweetLinks,
      hasJsonText,
      wallMarks: wall.length,
      usable: res.ok && (hasTweetLinks || hasJsonText),
    };
  } catch (e) {
    return { name: t.name, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const t of TARGETS) {
  results.push(await probe(t));
}

console.log('=== X への認証なしアクセス実測（読み取りのみ・課金なし）===');
console.log('※ 投稿本文やユーザー名は出力しません。ステータスと判定のみ\n');

for (const r of results) {
  if (r.error) {
    console.log(`  ❌ ${r.name.padEnd(22, '　')} 失敗: ${r.error}`);
    continue;
  }
  const verdict = r.usable ? '✅ 投稿が取れている' : (r.wallMarks ? '🚧 ログイン壁/JSシェル' : '⚠️ 中身なし');
  console.log(`  ${verdict}  ${r.name}`);
  console.log(`      status ${r.status} / 最終ホスト ${r.finalHost} / ${r.bytes}バイト / ${r.ms}ms`);
  console.log(`      投稿リンク ${r.hasTweetLinks ? 'あり' : 'なし'} / 本文キー ${r.hasJsonText ? 'あり' : 'なし'} / 壁の目印 ${r.wallMarks}種`);
}

const ok = results.filter((r) => r.usable);
console.log(`\n結論: ${ok.length}/${results.length} が認証なしで投稿を取得できた`);
if (ok.length) {
  console.log('  → 無料で X を情報源にできる可能性がある:');
  for (const r of ok) console.log(`     ・${r.name}`);
  console.log('  ※ ただし X は未認証アクセスを絞る方針なので、いつ塞がれてもおかしくない。');
  console.log('    塞がれた場合に静かにゼロ件にならないよう、件数が落ちたら気づける形にすること。');
} else {
  console.log('  → 認証なしでは取れない。回線ではなく X 側の認証が壁になっている。');
}
console.log('\n=== 実測完了・課金は発生していません（$0）===');
