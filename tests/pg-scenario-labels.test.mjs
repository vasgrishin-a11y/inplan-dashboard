/* Автоматические подписи ClickHouse-версий из PostgreSQL metadata-БД и поиск
   по названию / номеру. Сетевые запросы к ClickHouse и backend подменены.
   Запуск: npm test
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 5000, label = 'условие') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (fn()) return; } catch { /* дождаться готовности DOM */ }
    await settle();
  }
  throw new Error(`timeout: ${label}`);
}

async function boot(t) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(250);
  t.after(() => { try { dom.window.close(); } catch { /* jsdom */ } });
  return { w: dom.window, d: dom.window.document };
}

test('подписи загружаются из pgs_app_metadata_db, а выбор ищется по имени и номеру', async (t) => {
  const { w, d } = await boot(t);
  const metadataBodies = [];
  let metadataAvailable = true;
  w.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('/api/pg/scenarios')) {
      metadataBodies.push(JSON.parse(String(options.body || '{}')));
      if (!metadataAvailable)
        return { ok: false, status: 400, json: async () => ({ ok: false,
          service: 'inplan-dashboard', api: 8, error: 'scenario недоступна' }) };
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, scenarios: [
          { sys_id: '4899', name: 'Версия осеннего плана' },
          { sys_id: '4941', name: 'Версия после корректировки' },
        ] }),
      };
    }
    if (u.includes('/api/pg/'))
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    return { ok: true, status: 200, text: async () => '' };
  };

  w.PGX.cfg.host = 'pg.example.test';
  w.PGX.cfg.user = 'reader';
  w.PGX.cfg.password = 'secret';
  w.CHX.state.connected = true;
  w.CHX.state.dbs = ['data_public_4899', 'data_public_4941', 'data_public_6000'];
  w.CHX.state.meta = {};
  w.CHX.state.granOptions = [{ t: 4, n: 10 }];
  w.CHX.state.granByDb = {};
  w.CHX.cfg.schemas = [];
  w.CHX.cfg.base = '';
  /* Старый XLSX-справочник остаётся резервным источником для несопоставленной версии. */
  w.CHX.state.scenario.set('id:6000', { name: 'Старая подпись из XLSX' });

  w.CHX.openModal();
  d.querySelector('input[data-db="data_public_4899"]').click();
  await waitFor(() => w.CHX.state.pgScenario.size === 2, 5000, 'имена из scenario');

  assert.equal(metadataBodies.length, 1, 'справочник запрашивается автоматически при выборе версии');
  assert.equal(metadataBodies[0].database, 'pgs_app_metadata_db');
  assert.equal(metadataBodies[0].user, 'reader');
  assert.equal(w.PGX.cfg.database, 'pgs_app_data_db', 'настройка основной PG-БД не меняется');
  assert.equal(w.CHX.labelFor('data_public_4899'), 'Версия осеннего плана');
  assert.equal(w.CHX.labelFor('data_public_4941'), 'Версия после корректировки');
  assert.equal(w.CHX.labelFor('data_public_6000'), 'Старая подпись из XLSX',
    'если metadata-строки нет, продолжает работать прежнее сопоставление');

  const visibleIds = () => [...d.querySelectorAll('#chmDbList .chm-item')]
    .filter((row) => row.style.display !== 'none')
    .map((row) => row.dataset.dbrow);
  const search = d.getElementById('chmDbQ');
  search.value = 'после корректировки';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.deepEqual(visibleIds(), ['data_public_4941'], 'поиск находит по названию scenario.name');

  search.value = '4899';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.deepEqual(visibleIds(), ['data_public_4899'], 'поиск находит по цифровому суффиксу версии');

  /* Если metadata-БД/таблица стали недоступны, это не ломает выбор:
     сбрасываются только новые подписи, legacy scenario.xlsx остаётся. */
  metadataAvailable = false;
  w.PGX.invalidateScenarioNames();
  await w.CHX.refreshPostgresScenarioLabels({ force: true });
  assert.equal(metadataBodies.length, 2, 'повторный запрос использовал тот же metadata endpoint');
  assert.match(w.PGX.state.scenarioNamesError, /scenario недоступна/);
  assert.equal(w.CHX.labelFor('data_public_4899'), 'data_public_4899');
  assert.equal(w.CHX.labelFor('data_public_6000'), 'Старая подпись из XLSX');
});
