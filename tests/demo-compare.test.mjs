/* ─────────────────────────────────────────────────────────────────────────────
   Демо-набор «металлургия»: подпись активной версии и показательное сравнение.

   1. В шапке — ровно одно название: «Активная версия · Демо-набор: металлургия».
      Технические хвосты (тип источника, «схема <db>», имя файла) из строки
      убраны; для ClickHouse предпочитается расшифровка версии из БД, иначе —
      техническое имя схемы.
   2. Демо-набор сразу содержит две версии для «Сравнения версий»: активный
      сценарий «фокус на маржу» и сохранённый «базовый план».
   3. В сравнении заполнены все графики и таблица отличий: ни одна строка
      не остаётся прочерком, счёт заказов сходится (невязка 0), теплокарта
      «продукт × период» есть у обеих версий.

   Запуск:  npm test
   ───────────────────────────────────────────────────────────────────────────── */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INPLAN_HTML
  ? path.resolve(process.env.INPLAN_HTML)
  : path.join(ROOT, 'index.html');
const BASE = 'http://localhost:8080';
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

const localResources = requestInterceptor((request) => {
  const u = new URL(request.url);
  if (u.origin === BASE) {
    const file = path.join(ROOT, u.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), {
        headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' },
      });
    }
  }
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

async function loadApp() {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 450));
  const window = dom.window;
  return {
    dom, window,
    document: window.document,
    ev: (code) => window.eval(code),
    async go(tab, ms = 350) {
      window.eval(`go(${JSON.stringify(tab)})`);
      await new Promise((r) => setTimeout(r, ms));
    },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/* ─────────────── 1. Подпись активной версии ─────────────── */

test('в шапке демо-набора — только «Активная версия» и название набора', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const ver = clean(ctx.document.getElementById('pgVer').textContent);
  assert.match(ver, /^Активная версия/i, 'строка начинается с подписи «Активная версия»');
  assert.match(ver, /Демо-набор: металлургия/, 'название демо-набора видно в шапке');
  assert.ok(!/run 19|cfg 300|ds 14/.test(ver), 'технические хвосты прежнего имени убраны');
  assert.ok(!/демо-набор\s*$|схема\s/i.test(ver), 'тип источника и «схема …» в строке не дублируются');
  assert.equal(ver, 'Активная версия Демо-набор: металлургия',
    `в шапке ровно два элемента (получено: «${ver}»)`);
});

test('ClickHouse: расшифровка версии из БД, иначе техническое имя схемы', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const caption = (label) => {
    ctx.ev(`CHX.versions=[{id:'data_public_1',label:${JSON.stringify(label)},isBase:true}]; render();`);
    return clean(ctx.document.getElementById('pgVer').textContent);
  };
  assert.equal(caption('data_public_1'), 'Активная версия data_public_1',
    'без сценария в БД показывается техническое имя схемы — без типа источника');
  assert.equal(caption('Версия 2026-09 / прогноз 4'), 'Активная версия Версия 2026-09 / прогноз 4',
    'расшифровка версии из БД имеет приоритет и не дублируется хвостом');
});

/* ─────────────── 2. Две демо-версии ─────────────── */

test('демо-набор сразу содержит базовую версию и активный сценарий', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const vers = JSON.parse(ctx.ev('JSON.stringify(getVers())'));
  assert.equal(vers.length, 1, 'сохранена ровно одна версия — базовый план');
  assert.match(vers[0].name, /Демо-набор: металлургия · базовый план/, 'имя базовой версии понятное');
  assert.ok(vers[0].pp && vers[0].pp.rows.length > 0, 'у базовой версии есть разрез «продукт × период»');
  assert.ok(vers[0].orderTotal > 0 && vers[0].orderDelta === 0,
    'у базовой версии заполнен счёт заказов и нулевая невязка');

  assert.equal(ctx.ev('DS._demo'), true, 'активный демо-датасет помечен как демо');
  const focus = JSON.parse(ctx.ev('JSON.stringify(snap(DS))'));
  assert.notEqual(focus.mar, vers[0].mar, 'активный сценарий отличается от базового плана по марже');
  assert.ok(focus.pp && focus.pp.rows.length > 0, 'у активного сценария есть разрез «продукт × период»');
});

test('сценарий «фокус на маржу» сохраняет тождества демо-данных', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const bad = JSON.parse(ctx.ev(`JSON.stringify(DS.orders.filter(o=>
    Math.abs(o.sal+o.unm-o.dem)>1e-6 ||
    Math.abs(o.sal*o.price-o.rev)>Math.max(1,o.rev*1e-6) ||
    Math.abs(o.rev-o.cost-o.mar)>Math.max(1,o.rev*1e-6) ).map(o=>o.id))`));
  assert.deepEqual(bad, [], 'sal+unm=dem, rev=sal×price, mar=rev−cost во всех заказах сценария');

  const caps = JSON.parse(ctx.ev('JSON.stringify(DS.capacity.map(c=>({u:c.util,f:c.free,a:c.avail})))'));
  assert.ok(caps.length > 0, 'мощности пересчитаны');
  for (const c of caps) {
    assert.ok(c.u >= 0 && Number.isFinite(c.u), 'загрузка ресурса — конечное неотрицательное число');
    assert.ok(c.f >= 0, 'свободный остаток не отрицательный');
  }
});

/* ─────────────── 3. Сравнение заполнено целиком ─────────────── */

test('сравнение демо-версий: все графики и таблица отличий заполнены', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('vs', 450);

  const doc = ctx.document;
  const selects = [...doc.querySelectorAll('#vsA option, #vsB option')].map((o) => clean(o.textContent));
  assert.ok(selects.some((s) => /базовый план/.test(s)), 'в выборе версий есть базовый план');
  assert.ok(selects.some((s) => /фокус на маржу \(текущая\)/.test(s)),
    'в выборе версий активный сценарий подписан по-человечески, а не вторым «Демо-набор: металлургия»');

  for (const id of ['v4', 'v5', 'v1', 'v2', 'v7']) {
    assert.ok(doc.getElementById(id), `график #${id} отрисован`);
  }
  assert.ok(doc.getElementById('vsHeatMode'), 'у теплокарты есть переключатель A / B / B − A');
  assert.ok(doc.querySelectorAll('#main .vboard .vb').length >= 6, 'вердикт-борд заполнен блоками плана');

  const rows = [...doc.querySelectorAll('#v3 tbody tr')]
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => clean(td.textContent)));
  assert.ok(rows.length >= 20, `в таблице отличий ${rows.length} строк`);
  const dashed = rows.filter((r) => r[1] === '—' || r[2] === '—');
  assert.deepEqual(dashed.map((r) => r[0]), [], 'ни одна строка таблицы не осталась без данных в A или B');

  const row = (name) => {
    const r = rows.find((x) => x[0] === name);
    assert.ok(r, `строка «${name}» есть в таблице`);
    return r;
  };
  const total = row('Заказов неограниченного спроса (independent_demand)');
  assert.notEqual(total[1], '—', 'счёт входных заказов версии A заполнен');
  assert.notEqual(total[2], '—', 'счёт входных заказов версии B заполнен');
  assert.equal(row('Невязка заказов (должна быть 0)')[1], '0', 'невязка версии A нулевая');
  assert.equal(row('Невязка заказов (должна быть 0)')[2], '0', 'невязка версии B нулевая');
  assert.match(row('Упущенная маржа')[0], /Упущенная маржа/, 'строка упущенной маржи на месте');
  assert.match(clean(doc.querySelector('#main').textContent), /проверено 2 из 2 версий/,
    'подпись сообщает, что проверены обе версии');

  const heat = ctx.ev(`(()=>{const S1=getVers()[0],S2=snap(DS);
    const rs=[...new Set([...S1.pp.rows,...S2.pp.rows])], cs=[...new Set([...S1.pp.cols,...S2.pp.cols])];
    const get=(s,p,c0)=>{const i=s.pp.rows.indexOf(p),j=s.pp.cols.indexOf(c0);
      return (i<0||j<0)?0:(s.pp.m[i][j]||0)};
    let changed=0;rs.forEach(p=>cs.forEach(c0=>{if(get(S1,p,c0)!==get(S2,p,c0))changed++}));
    return JSON.stringify({rows:rs.length,cols:cs.length,changed})})()`);
  const h = JSON.parse(heat);
  assert.ok(h.rows >= 5 && h.cols >= 2, `теплокарта ${h.rows}×${h.cols} заполнена`);
  assert.ok(h.changed > 0, 'версии действительно расходятся в разрезе «продукт × период»');
});
