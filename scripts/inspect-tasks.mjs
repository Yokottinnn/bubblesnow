// users/yokota/tasks の「構造だけ」を調べる読み取り専用スクリプト。
//
// ★プライバシー方針★
// このリポジトリは public で、Actions のログも公開される。
// タスク名・詳細・備考などの中身は絶対に出力しない。
// 出力するのは「配列かオブジェクトか」「件数」「存在するフィールド名」「status別件数」だけ。

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const BASE = 'users/yokota';

if (!FIREBASE_URL) {
  console.error('FIREBASE_URL が未設定です');
  process.exit(1);
}

const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

function describe(label, data) {
  console.log(`\n── ${label} ──`);
  if (data === null || data === undefined) {
    console.log('  (空 / null)');
    return;
  }
  const isArr = Array.isArray(data);
  console.log(`  型: ${isArr ? 'Array' : typeof data}`);
  if (isArr) {
    console.log(`  要素数: ${data.length}`);
    // 配列に穴（null要素）があると Object.values との差が出るので確認する
    const holes = data.filter((x) => x === null || x === undefined).length;
    if (holes) console.log(`  ⚠️ null要素: ${holes}件`);
  } else if (typeof data === 'object') {
    const keys = Object.keys(data);
    console.log(`  キー数: ${keys.length}`);
    // キー名が 0,1,2... の連番ならFirebaseが配列を落としただけ
    const numeric = keys.every((k) => /^\d+$/.test(k));
    console.log(`  キーは連番か: ${numeric ? 'はい（実質配列）' : 'いいえ（マップ）'}`);
  }
}

function describeTasks(data) {
  describe('users/yokota/tasks', data);
  if (!data) return;
  const arr = (Array.isArray(data) ? data : Object.values(data)).filter((t) => t && t.name);
  console.log(`  有効タスク数（name有り）: ${arr.length}`);

  // フィールド名の出現数だけを集計する（値は出さない）
  const fieldCount = {};
  for (const t of arr) {
    for (const k of Object.keys(t)) fieldCount[k] = (fieldCount[k] || 0) + 1;
  }
  console.log('  フィールド出現数:');
  for (const [k, n] of Object.entries(fieldCount).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${n}/${arr.length}`);
  }

  // status と id 形式の分布（値の種類のみ。個人情報ではない）
  const byStatus = {};
  for (const t of arr) byStatus[t.status || '(未設定)'] = (byStatus[t.status || '(未設定)'] || 0) + 1;
  console.log(`  status別: ${JSON.stringify(byStatus)}`);

  const idShapes = {};
  for (const t of arr) {
    const shape = /^t\d{10,}$/.test(String(t.id)) ? 't+epoch' : /^t\d+$/.test(String(t.id)) ? 't+連番' : 'その他';
    idShapes[shape] = (idShapes[shape] || 0) + 1;
  }
  console.log(`  id形式: ${JSON.stringify(idShapes)}`);
}

async function main() {
  console.log('=== Firebase 構造調査（中身は出力しません）===');
  const tasks = await fbGet(`${BASE}/tasks`).catch((e) => {
    console.log(`tasks 取得失敗: ${e.message}`);
    return null;
  });
  describeTasks(tasks);

  for (const p of ['dismissed', 'dismissedTitles', 'recommendations']) {
    const d = await fbGet(`${BASE}/${p}`).catch(() => null);
    describe(`${BASE}/${p}`, d);
  }

  // 直下に他のキーがないかも確認（キー名のみ）
  const root = await fbGet(BASE).catch(() => null);
  if (root && typeof root === 'object') {
    console.log(`\n── ${BASE} 直下のキー ──\n  ${Object.keys(root).join(', ')}`);
  }
  console.log('\n=== 調査完了 ===');
}

main().catch((err) => {
  console.error('❌ 失敗:', err);
  process.exit(1);
});
