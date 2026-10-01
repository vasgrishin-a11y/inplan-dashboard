/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: определение «Неограниченный спрос = Покрытый + Непокрытый спрос»
   действует во ВСЁМ дашборде, а не в одном разделе.

   Требование владельца: неограниченный спрос везде — это сумма покрытого
   (`fullfilleddemandqty`) и непокрытого (`unfullfilleddemandqty`) спроса из
   `demand_coverage`. Раньше код предпочитал готовый итог выгрузки
   (`num(cov.demUnc) || (ff+uf)`): пока итог совпадает с составляющими, разницы
   нет, но при расхождении разделы показали бы разные числа и никто бы об этом
   не узнал.

   Проверяется моком, где итог выгрузки намеренно расходится с составляющими
   (итог 9999 против 950 + 250): дашборд обязан показывать 1200 во всех
   разделах и поднять проверку «Неограниченный спрос: определение».

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
const HTML = process.env.INPLAN_HTML ? path.resolve(process.env.INPLAN_HTML) : path.join(ROOT, 'index.html');
const BASE = 'http://localhost:8080';
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };

const localResources = requestInterceptor((request) => {
  const u = new URL(request.url);
  if (u.origin === BASE) {
    const file = path.join(ROOT, u.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile())
      return new Response(fs.readFileSync(file), {
        headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' },
      });
  }
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

const DBS = {
  data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-09-10 08:00:00' },
  data_public_2: { grans: [[4, 100]], n: 900, ts: '2026-09-11 09:00:00' },
};
const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num',
];
const ORDERS_TOT = { orders: 2, rev: 5380, cost: 3170, mar: 2210, dem: 1000, sal: 900, unm: 100, lm: 90, full: 1 };
const BY_OP = [{ t: 'production', c: 500, v: 48, n: 2 }, { t: 'movement', c: 300, v: 40, n: 2 }];
const DIM_P = [{ k: '1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_PR = [{ k: 'P1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_CL = [{ k: 'C1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1', dem: 400, sal: 380, unm: 20, price: 100, cpt: 60, mpt: 40, rev: 1900, cost: 1140, mar: 760, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1', dem: 600, sal: 520, unm: 80, price: 120, cpt: 70, mpt: 50, rev: 3480, cost: 2030, mar: 1450, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 19, r: 26, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
];

/** covTotal — что отдаёт выгрузка в готовом итоге demUnc (может врать). */
function makeRoute(covTotal) {
  const COV = { demUnc: covTotal, ff: 950, uf: 250, inTime: 850, late: 50, lostRev: 120, planRev: 6000, prop: 1200 };
  const COV_P = [{ k: '2026-09', demUnc: covTotal, ff: 950, uf: 250, late: 50 }];
  return function route(sql) {
    const dbm = sql.match(/`(data_public_\d+)`\./);
    const db = dbm && dbm[1];
    if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
    if (/FROM system\.databases/.test(sql))
      return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
    if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
    if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
    if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
    if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
    if (/`operation_type` AS t/.test(sql)) return BY_OP;
    if (/`o_p` AS k/.test(sql)) return DIM_P;
    if (/`o_prod` AS k/.test(sql)) return DIM_PR;
    if (/`o_cl` AS k/.test(sql)) return DIM_CL;
    if (/`lostrevenue`/.test(sql)) return [COV];
    if (/GROUP BY k ORDER BY k/.test(sql)) return COV_P;
    if (/SELECT order_id AS id/.test(sql)) return ORDERS;
    if (/IN \(/.test(sql)) return OPS;
    return [];
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 10000)) {
    try { if (fn()) return; } catch { /* ещё не готово */ }
    await settle(25);
  }
  throw new Error('timeout: ' + (label || 'условие'));
}
const toNum = (s) => Number(String(s).replace(/\u00a0|\u202f|\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));

async function loadCH(covTotal) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const route = makeRoute(covTotal);
  w.fetch = async (url, opts) => {
    const sql = String((opts && opts.body) || '');
    return { ok: true, status: 200, text: async () => route(sql).map((r) => JSON.stringify(r)).join('\n') };
  };
  await w.CHX.connect();
  w.CHX.openModal();
  d.querySelector('input[data-db="data_public_1"]').click();
  await settle();
  d.querySelector('input[data-db="data_public_2"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 2, 20000, 'версии загружены');

  const kpi = (title) => [...d.querySelectorAll('#main .kpi')]
    .find((k) => ((k.querySelector('.t') || {}).textContent || '').trim() === title);
  const goTab = async (id) => { w.go(id); await settle(250); };
  const vsRow = (name) => {
    const tr = [...d.querySelectorAll('#vsMat table tbody tr')].find(
      (x) => (x.querySelector('td') || {}).textContent?.trim().startsWith(name));
    if (!tr) throw new Error('нет строки «' + name + '»');
    return toNum([...tr.querySelectorAll('td')][1].textContent);
  };
  return { window: w, document: d, kpi, goTab, vsRow, close() { try { dom.window.close(); } catch { /* jsdom */ } } };
}

test('неограниченный спрос = покрытый + непокрытый во всех разделах, даже если итог выгрузки говорит другое', async (t) => {
  /* выгрузка отдаёт итог 9999, а составляющие — 950 и 250 */
  const ctx = await loadCH(9999);
  t.after(ctx.close);

  await ctx.goTab('dm');
  const unlim = ctx.kpi('Неограниченный спрос');
  assert.ok(unlim, 'карточка «Неограниченный спрос» есть во вкладке «Спрос и покрытие»');
  assert.equal(toNum(unlim.querySelector('.v').textContent), 1200,
    'показан покрытый 950 + непокрытый 250, а не итог выгрузки 9999');

  /* производные от него величины считаются от того же числа */
  assert.equal(toNum(ctx.kpi('Не принято в план').querySelector('.v').textContent), 200, '1200 − 1000 плана');
  assert.equal(toNum(ctx.kpi('Не покрыто всего').querySelector('.v').textContent), 300, '1200 − 900 отгрузки');

  await ctx.goTab('ov');
  assert.equal(toNum(ctx.kpi('Не покрыто всего').querySelector('.v').textContent), 300,
    '«Общий» использует то же определение');

  await ctx.goTab('vs');
  assert.equal(ctx.vsRow('Неограниченный спрос, т'), 1200, '«Сравнение версий» — то же число');
  assert.equal(ctx.vsRow('Ограниченный спрос, т') + ctx.vsRow('Неудовлетворённый спрос, т'), 1200,
    'покрытый + непокрытый = неограниченный');

  await ctx.goTab('data');
  const checks = [...ctx.document.querySelectorAll('#q3 .dq')].map((x) => x.textContent.replace(/\s+/g, ' '));
  const def = checks.find((x) => /Неограниченный спрос: определение/.test(x));
  assert.ok(def, 'во вкладке «Данные и качество» есть проверка определения');
  assert.match(def, /9 999/, 'расхождение с итогом выгрузки названо числом');
  assert.match(def, /расхождение/, 'проверка сообщает о расхождении, а не молчит');
});

test('когда итог выгрузки согласован с составляющими — проверка определения зелёная', async (t) => {
  const ctx = await loadCH(1200);
  t.after(ctx.close);

  await ctx.goTab('dm');
  assert.equal(toNum(ctx.kpi('Неограниченный спрос').querySelector('.v').textContent), 1200);

  await ctx.goTab('data');
  const checks = [...ctx.document.querySelectorAll('#q3 .dq')].map((x) => x.textContent.replace(/\s+/g, ' '));
  const def = checks.find((x) => /Неограниченный спрос: определение/.test(x));
  assert.ok(def, 'проверка выполняется и в согласованном случае');
  assert.match(def, /совпадает с суммой покрытого и непокрытого/,
    'подтверждение, а не предупреждение');
});
