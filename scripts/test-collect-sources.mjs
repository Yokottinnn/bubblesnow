// collect-sources.mjs の純粋な部分を通信なしで検証する。
//
// ここで見るのは、初回実行（2026-08-16）で実際に壊れていた3点。
//   ① 見出しが &#x9759; のまま出た      … 実体参照の16進と二重エスケープ
//   ② URL解決が 92件中 11件しか通らない  … Google ニュースのリンクを通信なしで解く
//   ③ 静岡の道の駅や神社の例大祭が混ざる … 見出しでの話題の足切り
//
// どれも「本番で回して初めて分かる」類なので、通信なしで再現できる形に落としてある。
// 実行: node scripts/test-collect-sources.mjs

import {
  decodeXml, stripOutlet, isRelevant, isDismissed, parseRss, decodeGoogleNewsLink, SOURCES,
} from './collect-sources.mjs';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  if (got === want) { pass += 1; console.log(`  OK   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`); }
}

const src = (key) => SOURCES.find((s) => s.key === key);

console.log('── ① 実体参照のデコード ──');
// はてブが二重にエスケープして返してきた実際の形
eq('二重エスケープ＋16進', decodeXml('&amp;#x9759;&amp;#x5CA1;&amp;#x770C;'), '静岡県');
eq('16進1回', decodeXml('&#x30B5;&#x30A6;&#x30CA;'), 'サウナ');
eq('10進', decodeXml('&#26481;&#20140;'), '東京');
eq('大文字X', decodeXml('&#X6771;&#X4EAC;'), '東京');
eq('CDATA', decodeXml('<![CDATA[展覧会 開幕]]>'), '展覧会 開幕');
eq('タグ除去と空白畳み', decodeXml('<b>展</b>   覧  会'), '展 覧 会');
eq('&amp; を壊さない', decodeXml('AT&amp;T'), 'AT&T');
// &amp;amp; は「&amp;」を表す。2回展開して「&」まで行き過ぎないこと自体は許容だが、
// 少なくとも例外を投げず有限で止まることを見る。
eq('不正な実体参照で落ちない', decodeXml('&#xZZZZ; ok'), '&#xZZZZ; ok');

console.log('\n── ② Google ニュースのリンク解決（通信なし）──');
const real = 'https://example.com/news/sauna-open-2026';
const encoded = Buffer.from(`"${real}Ò`, 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
eq('base64から発行元URLを取り出す',
  decodeGoogleNewsLink(`https://news.google.com/rss/articles/${encoded}?oc=5`), real);
eq('該当しない形は空を返す', decodeGoogleNewsLink('https://news.google.com/foo'), '');
eq('壊れたbase64でも落ちない', decodeGoogleNewsLink('https://news.google.com/rss/articles/!!!!!!!!!!!!!!!!'), '');

console.log('\n── ③ 話題の足切り ──');
// 初回に実際に混ざった見出し
eq('静岡の道の駅はサウナから外れる',
  isRelevant('静岡県の道の駅27駅を全制覇したのでオススメ10選を紹介する', src('サウナ')), false);
eq('神社の例大祭はアートから外れる',
  isRelevant('7月28日は俱知安神社例大祭、北海へそ祭り', src('アート')), false);
eq('AI勉強サイト100選はテックから外れる',
  isRelevant('AIを勉強するのに役立つサイト100選（2026年版）', src('テック')), false);
eq('「なぜMUFGスタジアムは」はポイ活から外れる',
  isRelevant('なぜ、MUFGスタジアムは「ドコモスタジアム」じゃないのか', src('ポイ活')), false);
eq('ハッカー被害はクリプトから外れる',
  isRelevant('北朝鮮ハッカーがマルウェアに自爆感染、1,640社の侵害を特定', src('クリプト')), false);

eq('本物のサウナ新店は通る',
  isRelevant('渋谷にサウナ「◯◯」が新規オープン', src('サウナ')), true);
eq('本物のカンファレンスは通る',
  isRelevant('エンジニア向けカンファレンスが11月に開催', src('テック')), true);
eq('本物の展覧会は通る',
  isRelevant('国立新美術館で企画展が開幕', src('アート')), true);
eq('本物の還元キャンペーンは通る',
  isRelevant('PayPay、最大20%還元キャンペーンを開始', src('ポイ活')), true);
eq('本物のエアドロップは通る',
  isRelevant('取引所が新規上場記念エアドロップを実施', src('クリプト')), true);

console.log('\n── その他 ──');
eq('媒体名を落とす', stripOutlet('サウナが新規オープン - 東京新聞'), 'サウナが新規オープン');
eq('ハイフン入りの本文は削らない', stripOutlet('AI-OCR の話'), 'AI-OCR の話');

eq('却下済みは弾く', isDismissed('楽天ペイ チャージの日エントリー', ['楽天ペイ チャージの日エントリー']), true);
eq('短い語では巻き込まない', isDismissed('サウナ新店オープン', ['サウナ']), false);
eq('無関係は通す', isDismissed('全然ちがう見出し', ['楽天ペイ チャージの日エントリー']), false);

const rss = `<rss><channel>
<item><title>&#x30B5;&#x30A6;&#x30CA;&#x65B0;&#x5E97;</title><link>https://example.com/a</link><pubDate>Sat, 15 Aug 2026 10:00:00 GMT</pubDate></item>
<item><title><![CDATA[展覧会が開幕]]></title><link>https://example.com/b</link></item>
<item><title>リンクなし</title></item>
</channel></rss>`;
const items = parseRss(rss);
eq('RSSの件数（linkなしは捨てる）', items.length, 2);
eq('RSSの1件目タイトル', items[0].title, 'サウナ新店');
eq('RSSの2件目タイトル', items[1].title, '展覧会が開幕');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
