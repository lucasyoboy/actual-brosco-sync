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
    type:           settings.accountType || 'checking',
    onBudget:       settings.onBudget    !== false,
    openingBalance: 0, // opening handled by setOpeningBalance with the real Brosco value
  });
  logger.info(`Creada cuenta "${name}" en Actual`);
  return { id, name };
}

// Categorize + import movements, then anchor the real opening balance
async function importAccount(accountNumber, data, actualAcc, cfg, categories) {
  const rules = cfg.categoryRules || [];

  // Pre-categorize unique descriptions (cache + avoids AI rate limits)
  const uniqueDescs = [...new Set(data.movements.map(m => m.description).filter(Boolean))];
  const catCache    = new Map();
  for (const desc of uniqueDescs) {
    catCache.set(desc, await categorizer.categorize(desc, rules, categories, cfg));
  }

  const transactions = data.movements.map(m => {
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

  // Anchor the real opening balance — movements carry it to the real current balance
  if (cfg.reconcileBalance !== false && data.openingBalance != null) {
    await actual.setOpeningBalance(
      accountNumber, actualAcc.id,
      Math.round(data.openingBalance * 100),
      data.openingDate
    );
    logger.info(`Account ${accountNumber}: saldo inicial ${data.openingBalance.toLocaleString('es-PY')} Gs anclado → saldo actual ${(data.currentBalance ?? 0).toLocaleString('es-PY')} Gs`);
  }

  state.accounts[accountNumber] = {
    added, updated,
    actualName: actualAcc.name,
    balance:    data.currentBalance,
    available:  data.availableBalance,
  };
  logger.info(`Account ${accountNumber}: ${added} nuevos, ${updated} actualizados → "${actualAcc.name}"`);
}

// Shared driver for a set of accounts over a set of periods
async function syncPeriods(accountPeriods, { force = false, label = 'Sync' } = {}) {
  if (state.isSyncing) { logger.warn('Sync ya en curso, saltando'); return; }
  state.isSyncing     = true;
  state.lastSyncError = null;
  logger.info(`${label} iniciado`);

  try {
    const cfg            = config.load();
    const actualAccounts = await actual.getAccounts();
    const settings       = cfg.accountSettings || {};
    const needCats       = (cfg.categoryRules?.length > 0) || cfg.useAiCategories;
    const categories     = needCats ? await actual.getCategories().catch(() => []) : [];
    if (cfg.useAiCategories) logger.info(`IA activa (${categories.length} categorías)`);

    for (const [accountNumber, periods] of Object.entries(accountPeriods)) {
      if (!periods?.length) continue;
      logger.info(`Cuenta ${accountNumber}: ${periods.length} mes(es) [${periods.join(', ')}]`);

      const data = await brosco.getAccountData(accountNumber, periods);
      if (!data.movements.length && data.openingBalance == null) {
        logger.info(`Account ${accountNumber}: sin datos`);
        state.accounts[accountNumber] = { added: 0, updated: 0 };
        continue;
      }

      const actualAcc = await resolveActualAccount(accountNumber, actualAccounts, settings[accountNumber] || {});

      if (force) {
        const deleted = await actual.clearAccountTransactions(actualAcc.id);
        logger.info(`Force: eliminadas ${deleted} transacciones de "${actualAcc.name}"`);
      }

      await importAccount(accountNumber, data, actualAcc, cfg, categories);
    }

    state.lastSync       = new Date().toISOString();
    state.lastSyncStatus = 'ok';
    logger.info(`${label} completo`);
  } catch (err) {
    state.lastSyncStatus = 'error';
    state.lastSyncError  = err.message;
    logger.error(`${label} falló: ${err.message}`);
  } finally {
    state.isSyncing = false;
  }
}

// Scheduled sync: last N months for every configured account
async function runSync() {
  const cfg          = config.load();
  const accounts     = cfg.syncAccounts.split(',').map(s => s.trim()).filter(Boolean);
  const monthsBack   = parseInt(cfg.syncMonthsBack || '3', 10);
  const periods      = brosco.recentPeriods(monthsBack);
  const accountPeriods = Object.fromEntries(accounts.map(a => [a, periods]));
  return syncPeriods(accountPeriods, { label: 'Sync' });
}

// Wizard: import exactly the selected months
async function runSyncPeriods(accountPeriods, force = false) {
  return syncPeriods(accountPeriods, { force, label: 'Importación por meses' });
}

module.exports = { runSync, runSyncPeriods };
