const express     = require('express');
const path        = require('path');
const config      = require('./config');
const logger      = require('./logger');
const state       = require('./state');
const actual      = require('./actual');
const brosco      = require('./brosco');
const categorizer = require('./categorizer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Status ──────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({
  isSyncing:      state.isSyncing,
  lastSync:       state.lastSync,
  lastSyncStatus: state.lastSyncStatus,
  lastSyncError:  state.lastSyncError,
  accounts:       state.accounts,
}));

// ─── Config ──────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cfg = config.load();
  res.json({
    ...cfg,
    broscoPassword:        cfg.broscoPassword        ? '••••••' : '',
    actualPassword:        cfg.actualPassword        ? '••••••' : '',
    actualEncryptPassword: cfg.actualEncryptPassword ? '••••••' : '',
  });
});

app.post('/api/config', (req, res) => {
  const current = config.load();
  const inc     = req.body;
  if (inc.broscoPassword        === '••••••') inc.broscoPassword        = current.broscoPassword;
  if (inc.actualPassword        === '••••••') inc.actualPassword        = current.actualPassword;
  if (inc.actualEncryptPassword === '••••••') inc.actualEncryptPassword = current.actualEncryptPassword;
  config.save({ ...current, ...inc });
  actual.reset().catch(() => {});
  require('./brosco').invalidateToken();
  logger.info('Configuración guardada');
  res.json({ ok: true });
});

// ─── Account settings ─────────────────────────────────────────────────────────
app.get('/api/brosco-accounts', (req, res) => {
  const cfg      = config.load();
  const numbers  = cfg.syncAccounts.split(',').map(s => s.trim()).filter(Boolean);
  const settings = cfg.accountSettings || {};
  res.json(numbers.map(num => ({ number: num, settings: settings[num] || {} })));
});

app.post('/api/account-settings/:num', (req, res) => {
  const num     = req.params.num;
  const current = config.load();
  current.accountSettings = current.accountSettings || {};
  current.accountSettings[num] = { ...(current.accountSettings[num] || {}), ...req.body };
  config.save(current);
  actual.reset().catch(() => {});
  logger.info(`Settings actualizados para cuenta ${num}`);
  res.json({ ok: true });
});

// ─── Category rules ───────────────────────────────────────────────────────────
app.get('/api/category-rules', (req, res) => {
  res.json(config.load().categoryRules || []);
});

app.post('/api/category-rules', (req, res) => {
  const current = config.load();
  current.categoryRules = req.body.rules || [];
  config.save(current);
  logger.info(`Reglas de categorías guardadas (${current.categoryRules.length})`);
  res.json({ ok: true });
});

// ─── Actual data ──────────────────────────────────────────────────────────────
app.get('/api/budgets', async (req, res) => {
  if (state.isSyncing) return res.status(409).json({ error: 'Sync en curso' });
  try { res.json(await actual.getBudgets()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/actual-accounts', async (req, res) => {
  try { res.json(await actual.getAccounts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/actual-categories', async (req, res) => {
  try { res.json(await actual.getCategories()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Categorize test ──────────────────────────────────────────────────────────
app.post('/api/categorize-test', async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'description requerida' });
  try {
    const cfg        = config.load();
    const categories = await actual.getCategories().catch(() => []);
    const rules      = cfg.categoryRules || [];
    const fromRule   = categorizer.matchPattern(description, rules);
    let   source     = 'sin_categoria';
    let   categoryId = null;

    if (fromRule) {
      categoryId = fromRule; source = 'regla';
    } else if (cfg.useAiCategories && cfg.claudeApiKey) {
      categoryId = await categorizer.categorize(description, rules, categories, cfg);
      if (categoryId) source = 'ia';
    }

    const cat = categoryId ? categories.find(c => c.id === categoryId) : null;
    res.json({ description, categoryId, categoryName: cat?.name || 'Sin categoría', source });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/category-cache/clear', (req, res) => {
  categorizer.clearCache();
  logger.info('Caché de categorías limpiado');
  res.json({ ok: true });
});

// ─── Detect available periods ─────────────────────────────────────────────────
app.get('/api/detect-periods', async (req, res) => {
  try {
    const cfg      = config.load();
    const accounts = cfg.syncAccounts.split(',').map(s => s.trim()).filter(Boolean);
    logger.info(`Detectando períodos disponibles (${accounts.length} cuentas, 1 consulta c/u)...`);
    // Run all accounts in parallel — one wide-range call each
    const entries = await Promise.all(
      accounts.map(async acct => {
        const periods = await brosco.detectAvailablePeriods(acct, 24);
        const withData = periods.filter(p => p.hasData).length;
        logger.info(`  ${acct}: ${withData} meses con datos`);
        return [acct, periods];
      })
    );
    res.json(Object.fromEntries(entries));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Import specific periods (wizard) ────────────────────────────────────────
app.post('/api/import-periods', (req, res) => {
  if (state.isSyncing) return res.status(409).json({ error: 'Ya sincronizando' });
  const { accountPeriods, force } = req.body;
  if (!accountPeriods || !Object.keys(accountPeriods).length) {
    return res.status(400).json({ error: 'Seleccioná al menos un período' });
  }
  res.json({ ok: true });
  require('./sync').runSyncPeriods(accountPeriods, force === true)
    .catch(err => logger.error(err.message));
});

// ─── Force re-import single account ──────────────────────────────────────────
app.post('/api/force-reimport/:num', async (req, res) => {
  if (state.isSyncing) return res.status(409).json({ error: 'Ya sincronizando' });
  const num = req.params.num;
  try {
    const actualAccounts = await actual.getAccounts();
    const cfg            = config.load();
    const settings       = cfg.accountSettings?.[num] || {};
    let   actualAcc      = actualAccounts.find(a => a.id === settings.actualAccountId)
                        || actualAccounts.find(a => a.name.includes(num));
    if (actualAcc) {
      const deleted = await actual.clearAccountTransactions(actualAcc.id);
      logger.info(`Force re-import ${num}: eliminadas ${deleted} transacciones de "${actualAcc.name}"`);
    } else {
      logger.info(`Force re-import ${num}: cuenta no encontrada en Actual, se creará al sincronizar`);
    }
    res.json({ ok: true });
    // Run normal sync for this account
    require('./sync').runSyncPeriods({ [num]: brosco.recentPeriods(parseInt(cfg.syncMonthsBack||'3')) }, false)
      .catch(err => logger.error(err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sync ────────────────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  if (state.isSyncing) return res.status(409).json({ error: 'Ya sincronizando' });
  res.json({ ok: true });
  require('./sync').runSync().catch(err => logger.error(err.message));
});

// ─── Logs SSE ─────────────────────────────────────────────────────────────────
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  logger.all().forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const unsub = logger.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', unsub);
});

function start(port = 3000) {
  app.listen(port, '0.0.0.0', () => logger.info(`Web UI en http://localhost:${port}`));
}

module.exports = { start };
