const brosco      = require('./brosco');
const actual      = require('./actual');
const config      = require('./config');
const logger      = require('./logger');
const state       = require('./state');
const categorizer = require('./categorizer');

// Resolve (or create) the Actual account linked to a Brosco account number
async function resolveActualAccount(accountNumber, actualAccounts, settings) {
  if (settings.actualAccountId) {
    const found = actualAccounts.find(a => a.id === settings.actualAccountId);
    if (found) return found;
  }
  const byName = actualAccounts.find(a => a.name.includes(accountNumber));
  if (byName) return byName;

  const name = settings.displayName || `Brosco ${accountNumber} (PYG)`;
  const id   = await actual.createAccount(name, {
    type:           settings.accountType    || 'checking',
    onBudget:       settings.onBudget       !== false,
    openingBalance: settings.openingBalance || 0,
  });
  logger.info(`Creada cuenta "${name}" en Actual`);
  return { id, name };
}

// Categorize a list of merged movements, then push them into Actual
async function importMovements(accountNumber, movements, actualAcc, cfg, categories) {
  const rules = cfg.categoryRules || [];

  // Pre-categorize unique descriptions (cache + avoids AI rate limits)
  const uniqueDescs = [...new Set(movements.map(m => m.description).filter(Boolean))];
  const catCache    = new Map();
  for (const desc of uniqueDescs) {
    catCache.set(desc, await categorizer.categorize(desc, rules, categories, cfg));
  }

  const transactions = movements.map(m => {
    const catId = catCache.get(m.description) ?? null;
    return {
      date:        m.date,
      amount:      m.amount,
      payee_name:  m.description,
      notes:       m.rawDesc && m.rawDesc !== m.description ? `[${m.rawDesc}]` : undefined,
      imported_id: m.importedId,
      cleared:     true,
      ...(catId ? { category: catId } : {}),
    };
  });

  const result  = await actual.importTransactions(actualAcc.id, transactions);
  const added   = result.added?.length   ?? 0;
  const updated = result.updated?.length ?? 0;

  // Reconcile so Actual's balance matches Brosco's real balance
  const realBalance = movements.balance; // PYG (may be null if movements call failed)
  let adjustment = null;
  if (cfg.reconcileBalance !== false && realBalance != null) {
    adjustment = await actual.reconcileBalance(accountNumber, actualAcc.id, Math.round(realBalance * 100));
    logger.info(`Account ${accountNumber}: saldo reconciliado a ${realBalance.toLocaleString('es-PY')} Gs (ajuste ${(adjustment/100).toLocaleString('es-PY')} Gs)`);
  }

  state.accounts[accountNumber] = {
    added, updated,
    actualName: actualAcc.name,
    balance:    realBalance,
    available:  movements.availableBalance,
  };
  logger.info(`Account ${accountNumber}: ${added} nuevos, ${updated} actualizados → "${actualAcc.name}"`);
}

// ── Regular scheduled sync: one continuous range over the last N months ────────
async function runSync() {
  if (state.isSyncing) { logger.warn('Sync ya en curso, saltando'); return; }
  state.isSyncing     = true;
  state.lastSyncError = null;
  logger.info('Sync iniciado');

  try {
    const cfg            = config.load();
    const targetAccounts = cfg.syncAccounts.split(',').map(s => s.trim()).filter(Boolean);
    const monthsBack     = parseInt(cfg.syncMonthsBack || '3', 10);
    const { start, end } = brosco.recentDateRange(monthsBack);
    const actualAccounts = await actual.getAccounts();
    const settings       = cfg.accountSettings || {};
    const needCats       = (cfg.categoryRules?.length > 0) || cfg.useAiCategories;
    const categories     = needCats ? await actual.getCategories().catch(() => []) : [];

    logger.info(`Rango: ${start} → ${end} (${monthsBack} meses)`);
    if (cfg.useAiCategories) logger.info(`IA activa (${categories.length} categorías)`);

    for (const accountNumber of targetAccounts) {
      const movements = await brosco.getMergedMovements(accountNumber, start, end);
      if (!movements.length) { logger.info(`Account ${accountNumber}: sin movimientos`); state.accounts[accountNumber] = { added: 0, updated: 0 }; continue; }
      const actualAcc = await resolveActualAccount(accountNumber, actualAccounts, settings[accountNumber] || {});
      await importMovements(accountNumber, movements, actualAcc, cfg, categories);
    }

    state.lastSync       = new Date().toISOString();
    state.lastSyncStatus = 'ok';
    logger.info('Sync completo');
  } catch (err) {
    state.lastSyncStatus = 'error';
    state.lastSyncError  = err.message;
    logger.error(`Sync falló: ${err.message}`);
  } finally {
    state.isSyncing = false;
  }
}

// ── Wizard: import exactly the selected months (each as its own date range) ─────
async function runSyncPeriods(accountPeriods, force = false) {
  if (state.isSyncing) { logger.warn('Sync ya en curso'); return; }
  state.isSyncing     = true;
  state.lastSyncError = null;
  logger.info(`Importación por meses iniciada (force=${force})`);

  try {
    const cfg            = config.load();
    const actualAccounts = await actual.getAccounts();
    const settings       = cfg.accountSettings || {};
    const needCats       = (cfg.categoryRules?.length > 0) || cfg.useAiCategories;
    const categories     = needCats ? await actual.getCategories().catch(() => []) : [];

    for (const [accountNumber, periods] of Object.entries(accountPeriods)) {
      if (!periods?.length) continue;
      logger.info(`Cuenta ${accountNumber}: meses ${periods.join(', ')}`);

      // Fetch each selected month as its own date range — nothing else leaks in
      const movements = [];
      for (const period of periods) {
        const { start, end } = brosco.periodToRange(period);
        const monthMovs = await brosco.getMergedMovements(accountNumber, start, end);
        movements.push(...monthMovs);
      }

      // Always reconcile to the CURRENT real balance (independent of imported months)
      try {
        const bal = await brosco.getBalance(accountNumber);
        movements.balance          = bal.balance;
        movements.availableBalance = bal.availableBalance;
      } catch {}

      if (!movements.length) { logger.info(`Account ${accountNumber}: sin movimientos en los meses seleccionados`); continue; }

      const actualAcc = await resolveActualAccount(accountNumber, actualAccounts, settings[accountNumber] || {});

      if (force) {
        const deleted = await actual.clearAccountTransactions(actualAcc.id);
        logger.info(`Force: eliminadas ${deleted} transacciones de "${actualAcc.name}"`);
      }

      await importMovements(accountNumber, movements, actualAcc, cfg, categories);
    }

    state.lastSync       = new Date().toISOString();
    state.lastSyncStatus = 'ok';
    logger.info('Importación por meses completa');
  } catch (err) {
    state.lastSyncStatus = 'error';
    state.lastSyncError  = err.message;
    logger.error(`Importación falló: ${err.message}`);
  } finally {
    state.isSyncing = false;
  }
}

module.exports = { runSync, runSyncPeriods };
