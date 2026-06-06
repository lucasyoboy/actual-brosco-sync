// Polyfill browser globals required by @actual-app/api in Node.js
if (typeof navigator === 'undefined') global.navigator = { platform: 'linux', userAgent: 'node' };
if (typeof window   === 'undefined') global.window   = global;

const api = require('@actual-app/api');
const fs  = require('fs');
const config = require('./config');

const DATA_DIR = '/app/data';
let initialized = false;

async function init() {
  if (initialized) return;
  const cfg = config.load();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await api.init({ dataDir: DATA_DIR, serverURL: cfg.actualServerUrl, password: cfg.actualPassword });
  const encryptOpts = cfg.actualEncryptPassword ? { password: cfg.actualEncryptPassword } : {};
  await api.downloadBudget(cfg.actualBudgetId, encryptOpts);
  initialized = true;
}

async function reset() {
  if (initialized) {
    await api.shutdown().catch(() => {});
    initialized = false;
  }
}

async function getBudgets() {
  const cfg = config.load();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const wasInit = initialized;
  if (!wasInit) {
    await api.init({ dataDir: DATA_DIR, serverURL: cfg.actualServerUrl, password: cfg.actualPassword });
  }
  const budgets = await api.getBudgets();
  if (!wasInit) await api.shutdown().catch(() => {});
  return budgets;
}

async function getAccounts() {
  await init();
  return api.getAccounts();
}

async function getCategories() {
  await init();
  // Returns flat list with groups; we normalize to { id, name, groupName }
  const groups = await api.getCategoryGroups();
  const flat = [];
  for (const group of groups) {
    for (const cat of (group.categories || [])) {
      flat.push({ id: cat.id, name: cat.name, groupName: group.name, hidden: cat.hidden });
    }
  }
  return flat;
}

async function createAccount(name, options = {}) {
  await init();
  const { type = 'checking', onBudget = true, openingBalance = 0 } = options;
  const id = await api.createAccount(
    { name, type, offbudget: !onBudget },
    Math.round(openingBalance * 100)
  );
  return id;
}

async function importTransactions(accountId, transactions) {
  await init();
  return api.importTransactions(accountId, transactions);
}

// Delete all transactions in an account so Actual forgets their imported_ids
// This enables a clean re-import when the user manually deleted transactions
async function clearAccountTransactions(accountId) {
  await init();
  const txns = await api.getTransactions(accountId);
  if (!txns?.length) return 0;
  for (const tx of txns) {
    await api.deleteTransaction(tx.id);
  }
  return txns.length;
}

const ALL_FROM = '2015-01-01';

// Reconcile so the account's Actual balance equals the real Brosco balance.
// Creates/updates a single "Ajuste de saldo Brosco" transaction holding the difference.
async function reconcileBalance(accountNumber, accountId, targetBalanceCents) {
  await init();
  const adjustId = `balance_adjust_${accountNumber}`;
  const today    = new Date().toISOString().slice(0, 10);

  const txns = await api.getTransactions(accountId, ALL_FROM, today);
  let sum = 0, oldAdjust = null;
  for (const t of txns) {
    if (t.imported_id === adjustId) { oldAdjust = t; continue; }
    sum += t.amount;
  }

  const adjustment = targetBalanceCents - sum;

  // Remove the previous adjustment so it doesn't accumulate
  if (oldAdjust) await api.deleteTransaction(oldAdjust.id);

  if (adjustment !== 0) {
    await api.importTransactions(accountId, [{
      date:        today,
      amount:      adjustment,
      payee_name:  'Ajuste de saldo Brosco',
      notes:       `Reconciliación automática — saldo real ${(targetBalanceCents/100).toLocaleString('es-PY')} Gs`,
      imported_id: adjustId,
      cleared:     true,
    }]);
  }
  return adjustment;
}

async function shutdown() { await reset(); }

module.exports = { init, reset, getBudgets, getAccounts, getCategories, createAccount, importTransactions, clearAccountTransactions, reconcileBalance, shutdown };
