/* 関連タスク機能のブラウザ検証。
//
// 実行: node scripts/test-related-task-ui.mjs
//   playwright と Chromium が要る（package.json の依存に入っている）。
//   入っていなければ npx playwright install chromium。
//
// ★本番データには触らない★
//   Firebase は initializeApp が投げるスタブに差し替え、gstatic.com の
//   本物の SDK は読み込ませない。index.html は初期化に失敗すると db=null に
//   落ちて localStorage に逃げるので、users/yokota には一切書かれない。
//
// ★なぜブラウザで見るのか★
//   この機能の肝は「保存ボタンを押すまで保存されない」こと。これは
//   関数単体では確かめられず、モーダルを閉じた／キャンセルした後に
//   保存先が増えていないことまで見ないと意味がない。 */
import { chromium } from 'playwright';

const STUB = `
window.firebase = {
  initializeApp: function(){ throw new Error('test stub: no firebase'); },
  database: function(){ throw new Error('test stub'); },
  auth: function(){ return {
    getRedirectResult: function(){ return Promise.resolve({}); },
    onAuthStateChanged: function(cb){ cb({ uid:'test', displayName:'Test' }); return function(){}; },
    signOut: function(){ return Promise.resolve(); }
  }; }
};
`;

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ''}`); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 820 } });
await page.addInitScript(STUB);
await page.route('**gstatic.com/**', (r) => r.abort());
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });

await page.goto('file:///Users/ny/bubblesnow/index.html');
await page.waitForSelector('text=BubblesNow', { timeout: 15000 });

/* ★バブルは物理演算で常に動いている★
   Playwright の click は要素が静止するまで待つので永久に待たされ、force で
   座標を指定しても測ってから押すまでに流れていて外れる。
   React の onMouseDown は root への委譲なので、要素に bubbles:true の
   mousedown を投げれば届く。mouseup は window の生リスナーが拾う。
   単発タップは二度押し判定の待ち（350ms）明けに onTap が走る。 */
const tapBubble = (name) => page.evaluate((name) => {
  const el = [...document.querySelectorAll('div[style*="position: absolute"]')]
    .find((d) => d.textContent.includes(name) && d.querySelector('[data-bbl]'));
  if (!el) throw new Error('バブルが見つからない: ' + name);
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
}, name);
/* 二度押しの判定は el<350 かつ **el>0**。同じミリ秒に2発打つと el===0 で
   「別々の単発タップ」になってしまうので、間を空ける。実際の指では
   起こらない、テストだけの都合。 */
const dblTapBubble = async (name) => {
  await tapBubble(name);
  await page.waitForTimeout(90);
  await tapBubble(name);
};

/* 下書きモーダルの中身を読む。
   見出しから上にたどってモーダル本体を取る（div を上から探すとアプリ全体の
   div が先に当たる）。入力欄はラベルの直後を見る。親の中の最初の入力欄を
   取ると、詳細や備考のようにラベルと入力欄がモーダル直下に並んでいる場合に
   タスク名の欄を拾ってしまう。 */
const draft = () => page.evaluate(() => {
  const h2 = [...document.querySelectorAll('h2')].find((x) => /関連タスクを作る/.test(x.textContent));
  if (!h2) return null;
  const root = h2.parentElement;
  const labelled = (lab) => {
    const l = [...root.querySelectorAll('label')].find((x) => x.textContent.trim() === lab);
    if (!l) return null;
    const n = l.nextElementSibling;
    if (n && /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName)) return n.value;
    const el = l.parentElement.querySelector('input,select,textarea');
    return el ? el.value : null;
  };
  const q = (sel) => { const e = root.querySelector(sel); return e ? e.value : null; };
  return {
    name: q('input[placeholder="タスク名を入力"]'),
    /* ★カテゴリはプルダウンではなくチップ★
       複数選べるようにしたため select ではなくなった。
       選ばれているものは太字で、先頭（代表）には ★ が付く。
       代表は ★ を外した名前で返し、全部の一覧も別に返す。 */
    category: (function () {
      const l = [...root.querySelectorAll('label')].find((x) => /^カテゴリ/.test(x.textContent.trim()));
      if (!l) return null;
      const on = [...l.parentElement.querySelectorAll('button')]
        .filter((b) => Number(getComputedStyle(b).fontWeight) >= 700)
        .map((b) => b.textContent.replace(/^★\s*/, ''));
      return on.length ? on[0] : null;
    })(),
    categories: (function () {
      const l = [...root.querySelectorAll('label')].find((x) => /^カテゴリ/.test(x.textContent.trim()));
      if (!l) return [];
      return [...l.parentElement.querySelectorAll('button')]
        .filter((b) => Number(getComputedStyle(b).fontWeight) >= 700)
        .map((b) => b.textContent.replace(/^★\s*/, ''));
    })(),
    priority: labelled('優先度'),
    deadline: labelled('期限'),
    detail: labelled('詳細'),
    url: q('input[placeholder="https://..."]'),
    note: labelled('備考'),
  };
});

const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem('users/yokota/tasks') || '[]'));
const relBtn = () => page.locator('button:has-text("このタスクから関連タスクを作る")');
/* 注意書きの文中にも「追加する」が入っているので、button で絞る */
const addBtn = () => page.locator('button:has-text("追加する")');
const cancelBtn = () => page.locator('button:has-text("キャンセル")');
const draftOpen = () => page.locator('h2:has-text("関連タスクを作る")').count();

const t0 = await tasks();
console.log(`初期タスク ${t0.length}件`);
ok('初期タスクが読み込まれている', t0.length > 0);

const TARGET = '確定申告';
const target = t0.find((t) => t.name === TARGET);
ok(`"${TARGET}" が存在する`, Boolean(target));

await tapBubble(TARGET);
await page.waitForTimeout(500);
await relBtn().waitFor({ timeout: 5000 });
ok('詳細モーダルに「関連タスクを作る」ボタンが出る', true);

console.log('\n── 下書きに引き継がれる内容 ──');
await relBtn().click({ force: true });
await page.waitForSelector('h2:has-text("関連タスクを作る")', { timeout: 5000 });
const d = await draft();
eq('タスク名を引き継ぐ', d.name, target.name);
eq('カテゴリを引き継ぐ', d.category, target.category);
eq('重要度（優先度）を引き継ぐ', d.priority, target.priority);
eq('詳細を引き継ぐ', d.detail, target.detail);
eq('備考を引き継ぐ', d.note, target.note);
eq(`過ぎた期限は引き継がない（元: ${target.deadline}）`, d.deadline, '');

console.log('\n── 保存を押すまで保存されない ──');
await cancelBtn().click({ force: true });
await page.waitForTimeout(400);
eq('キャンセルでは1件も増えない', (await tasks()).length, t0.length);
eq('下書きモーダルは閉じている', await draftOpen(), 0);

console.log('\n── 添付リンクの引き継ぎ ──');
const withUrl = t0.find((t) => t.url && t.status === 'active');
await tapBubble(withUrl.name.split('\n')[0]);
await page.waitForTimeout(500);
await relBtn().click({ force: true });
await page.waitForSelector('h2:has-text("関連タスクを作る")', { timeout: 5000 });
eq('参考URLを引き継ぐ', (await draft()).url, withUrl.url);

console.log('\n── 編集して保存すると新しいタスクになる ──');
const NEW = '関連タスクのテスト';
await page.locator('input[placeholder="タスク名を入力"]').fill(NEW);
await addBtn().click({ force: true });
await page.waitForTimeout(600);
const t1 = await tasks();
eq('1件だけ増える', t1.length, t0.length + 1);
const made = t1.find((t) => t.name === NEW);
ok('新しいタスクが保存されている', Boolean(made));
if (made) {
  eq('元のカテゴリを保ったまま保存される', made.category, withUrl.category);
  eq('元の優先度を保ったまま保存される', made.priority, withUrl.priority);
  eq('元のURLを保ったまま保存される', made.url, withUrl.url);
  eq('status は active', made.status, 'active');
  ok('元のタスクとは別のIDが振られる', made.id !== withUrl.id, `${made.id} vs ${withUrl.id}`);
  ok('completedAt を引き継がない', made.completedAt === undefined, `got: ${JSON.stringify(made.completedAt)}`);
  eq('wip は false', made.wip, false);
  ok('scale は持たない（優先度から出し直す）', made.scale === undefined, `got: ${JSON.stringify(made.scale)}`);
  ok('元のタスクは残っている', t1.some((t) => t.id === withUrl.id));
}

console.log('\n── 完了した直後に案内が出る ──');
await dblTapBubble(NEW);
await page.waitForTimeout(300);
await page.waitForSelector('text=タスクを完了しますか？', { timeout: 5000 });
ok('ダブルタップで完了確認が出る', true);
await page.waitForTimeout(700); // 誤タップ防止の 500ms 明け
await page.locator('button:has-text("完了する！")').click({ force: true });
await page.waitForSelector('text=続きや似たタスクを作りますか？', { timeout: 6000 });
ok('完了直後に関連タスクの案内が出る', true);
const afterDone = await tasks();
eq('完了しても件数は変わらない', afterDone.length, t1.length);
eq('対象は done になっている', afterDone.find((t) => t.name === NEW).status, 'done');

await page.locator('button:has-text("作る")').click({ force: true });
await page.waitForSelector('h2:has-text("関連タスクを作る")', { timeout: 5000 });
eq('案内から開いた下書きも名前を引き継ぐ', (await draft()).name, NEW);
eq('下書きを開いた時点で案内は消えている', await page.locator('text=続きや似たタスクを作りますか？').count(), 0);
await cancelBtn().click({ force: true });
await page.waitForTimeout(400);
eq('案内から開いても保存を押さなければ増えない', (await tasks()).length, afterDone.length);

console.log('\n── 案内は放っておくと9秒で消える ──');
const other = (await tasks()).find((t) => t.status === 'active');
await dblTapBubble(other.name.split("\n")[0]);
await page.waitForTimeout(300);
await page.waitForTimeout(700);
await page.locator('button:has-text("完了する！")').click({ force: true });
await page.waitForSelector('text=続きや似たタスクを作りますか？', { timeout: 6000 });
ok('2件目の完了でも案内が出る', true);
await page.waitForTimeout(9500);
eq('放置すると案内は消える', await page.locator('text=続きや似たタスクを作りますか？').count(), 0);
eq('案内が消えてもタスクは増えていない', (await tasks()).length, afterDone.length);

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
