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

// Anchor the account with the REAL opening balance from Brosco (initialBalance of
// the oldest imported month). The real movements then carry it to today's balance
// automatically — no difference-based adjustment that drifts or duplicates.
// Idempotent: the previous opening transaction is removed and recreated each run.
async function setOpeningBalance(accountNumber, accountId, openingCents, openingDate) {
  await init();
  const openingId = `opening_${accountNumber}`;
  const today     = new Date().toISOString().slice(0, 10);

  // Remove any previous opening AND legacy adjustment transactions
  const txns = await api.getTransactions(accountId, ALL_FROM, today);
  for (const t of txns) {
    if (t.imported_id === openingId || t.imported_id === `balance_adjust_${accountNumber}`) {
      await api.deleteTransaction(t.id);
    }
  }

  if (openingCents && openingCents !== 0) {
    await api.importTransactions(accountId, [{
      date:        openingDate || today,
      amount:      openingCents,
      payee_name:  'Saldo inicial',
      notes:       'Saldo inicial real de Brosco (ancla de reconciliación)',
      imported_id: openingId,
      cleared:     true,
    }]);
  }
  return openingCents;
}

async function shutdown() { await reset(); }

module.exports = { init, reset, getBudgets, getAccounts, getCategories, createAccount, importTransactions, clearAccountTransactions, setOpeningBalance, shutdown };
