const config = require('./config');
const logger = require('./logger');

const API_BASE = 'https://api.brosco.com.py/brosco-api';

const OUT_TYPES = new Set(['INTRA-OUT', 'INTER-OUT', 'SIPAP-OUT', 'QR-PAYMENT']);
const IN_TYPES  = new Set(['INTRA-IN', 'INTER-IN']);

let cachedToken = null;
let tokenExpiry = null;

// ── Auth ──────────────────────────────────────────────────────────────────────

async function login(force = false) {
  if (!force && cachedToken && tokenExpiry && new Date() < new Date(tokenExpiry)) {
    return cachedToken;
  }
  const cfg    = config.load();
  const tstamp = new Date().toISOString().slice(0, -1);
  const res    = await fetch(`${API_BASE}/brosco-auth/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-RshkMichi-ApiKey': cfg.broscoApiKey },
    body: JSON.stringify({
      deviceId: cfg.broscoDeviceId, authType: 'NEUD-AUTH', authVersion: '1.0.0',
      clientType: 'NEUD-WEB', clientVersion: '1.0.2', userType: 'BROSCO-NEUD-USER',
      userValue: cfg.broscoUser, password: cfg.broscoPassword, ssign: cfg.broscoSsign, tstamp,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Login falló [${res.status}]: ${e.message || 'unknown'}`);
  }
  const data   = await res.json();
  cachedToken  = data.accessToken;
  const expiry = new Date(data.session.expiration);
  expiry.setMinutes(expiry.getMinutes() - 2);
  tokenExpiry  = expiry.toISOString();
  return cachedToken;
}

async function authedGet(url) {
  const cfg     = config.load();
  const headers = t => ({ 'X-RshkMichi-ApiKey': cfg.broscoApiKey, 'X-RshkMichi-AccessToken': t });
  let   token   = await login();
  let   res     = await fetch(url, { headers: headers(token) });
  // 401 = session expired, 400 sometimes = stale token on Brosco's side.
  // A fresh login resolves both — retry once.
  if (res.status === 401 || res.status === 400) {
    token = await login(true);
    res   = await fetch(url, { headers: headers(token) });
  }
  return res;
}

// ── Raw fetchers (server-side date filtering) ─────────────────────────────────

// Account movements within an exact date range
async function getMovements(accountNumber, startDate, endDate) {
  const url = `${API_BASE}/brosco-accounts/accounts/${accountNumber}/movements?startingDate=${startDate}&endingDate=${endDate}`;
  const res = await authedGet(url);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Movements [${accountNumber} ${startDate}→${endDate}] [${res.status}]: ${e.message || 'unknown'}`);
  }
  return res.json();
}

// Account statement for one month — includes initialBalance / endingBalance
async function getStatements(accountNumber, period) {
  const url = `${API_BASE}/brosco-accounts/accounts/${accountNumber}/statements?period=${period}`;
  const res = await authedGet(url);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Statements [${accountNumber}/${period}] [${res.status}]: ${e.message || 'unknown'}`);
  }
  return res.json();
}

// Transactions list, optionally filtered by date range (server-side)
async function getTransactions(from, to) {
  let url = `${API_BASE}/brosco-transactions/transactions/list`;
  if (from && to) url += `?from=${from}&to=${to}&sort=DESC`;
  const res = await authedGet(url);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Transactions [${res.status}]: ${e.message || 'unknown'}`);
  }
  return res.json();
}

// ── Rich payee from transactions API ─────────────────────────────────────────

function richPayee(tx) {
  if (tx.type === 'QR-PAYMENT') {
    const pay = tx.additionalInfo?.qrPaymentResponse?.payment || {};
    // Prefer the human branch/commerce name, fall back to QR data
    return pay.branch_name
        || pay.commerce_name
        || tx.additionalInfo?.qrInfoData?.commerce_name
        || tx.additionalInfo?.qrInfoData?.payment_alias
        || 'Pago QR';
  }
  if (IN_TYPES.has(tx.type)) {
    return tx.additionalInfo?.sender?.name
        || tx.details?.[0]?.source?.name
        || 'Transferencia recibida';
  }
  return tx.details?.[0]?.destination?.name
      || tx.additionalInfo?.recipient?.name
      || null;
}

function txnAmount(tx) {
  const d = tx.details?.[0];
  return OUT_TYPES.has(tx.type)
    ? (d?.debitedAmount?.value ?? 0)
    : (d?.creditedAmount?.value ?? 0);
}

function txnBelongsTo(tx, accountNumber) {
  if (tx.status !== 'CONFIRMED') return false;
  const d = tx.details?.[0];
  const isOut = OUT_TYPES.has(tx.type);
  const isIn  = IN_TYPES.has(tx.type);
  return (isOut && d?.source?.account === accountNumber)
      || (isIn  && d?.destination?.account === accountNumber);
}

// ── Account data over a set of months (period-based) ─────────────────────────
/**
 * Statements (/movements?period=) are the single source of truth for the ledger
 * AND the balance: each month exposes its real initialBalance / endingBalance.
 *
 * - movements = every operation that affects the account → drives the balance
 * - transactions = only enriches the payee name (commerce / person) by date+amount;
 *   it never adds new entries, so it can't cause duplicates or break the balance.
 *
 * Returns:
 *   { movements: [{importedId,date,amount,description,rawDesc}],
 *     openingBalance, openingDate,   // initialBalance of the OLDEST month (PYG)
 *     currentBalance, availableBalance }   // real account balance today
 */
async function getAccountData(accountNumber, periods) {
  const sorted = [...periods].sort();               // ascending → oldest first
  const rawMovements = [];                            // { mov, period }
  let openingBalance = null, openingDate = null;
  let currentBalance = null, availableBalance = null;

  for (const period of sorted) {
    let stmt;
    try {
      stmt = await getStatements(accountNumber, period);
    } catch (err) {
      const level = /\[400\]|\[401\]/.test(err.message) ? 'info' : 'warn';
      logger[level](`Statements ${accountNumber}/${period}: ${err.message.split(':')[0]}`);
      continue;
    }
    // Opening balance = initialBalance of the first (oldest) month with data
    if (openingBalance === null && stmt.initialBalance?.value != null) {
      openingBalance = stmt.initialBalance.value;
      openingDate    = stmt.startingDate || periodToRange(period).start;
    }
    if (stmt.account?.balance?.value != null)          currentBalance   = stmt.account.balance.value;
    if (stmt.account?.availableBalance?.value != null) availableBalance = stmt.account.availableBalance.value;

    for (const m of (stmt.movements || [])) {
      if (m.movementId) rawMovements.push(m);
    }
  }

  // Enrich payees from the transactions API over the whole span (one call)
  const txnByKey = new Map();
  if (rawMovements.length) {
    const from = periodToRange(sorted[0]).start;
    const to   = new Date().toISOString().slice(0, 10);
    try {
      const txns = (await getTransactions(from, to)).filter(tx => txnBelongsTo(tx, accountNumber));
      for (const tx of txns) {
        const date = (tx.executed || tx.confirmed || tx.created || '').slice(0, 10);
        const key  = `${date}|${Math.round(txnAmount(tx))}`;
        if (!txnByKey.has(key)) txnByKey.set(key, []);
        txnByKey.get(key).push(tx);
      }
    } catch (err) {
      logger.warn(`Transactions enriquecimiento: ${err.message.split(':')[0]}`);
    }
  }

  const usedTxns  = new Set();
  const movements = rawMovements.map(mov => {
    const isDebit = mov.type === 'DEBIT';
    const date    = mov.movementDate.slice(0, 10);
    const key     = `${date}|${Math.round(mov.amount.value)}`;

    let matchedTx = null;
    for (const tx of (txnByKey.get(key) || [])) {
      if (!usedTxns.has(tx)) { matchedTx = tx; usedTxns.add(tx); break; }
    }
    const payee = (matchedTx ? richPayee(matchedTx) : null)
               || mov.description || (isDebit ? 'Débito' : 'Crédito');

    return {
      importedId:  `stmt_${accountNumber}_${mov.movementId}`,
      date,
      amount:      isDebit ? -Math.round(mov.amount.value * 100) : Math.round(mov.amount.value * 100),
      description: payee,
      rawDesc:     mov.description,
    };
  });

  logger.info(`Account ${accountNumber} [${sorted[0]}…${sorted[sorted.length-1]}]: ${movements.length} movimientos | saldo inicial ${openingBalance ?? '?'} → actual ${currentBalance ?? '?'} Gs`);
  return { movements, openingBalance, openingDate, currentBalance, availableBalance };
}

// Quick current-balance fetch (one statement call for the current month)
async function getBalance(accountNumber) {
  const period = recentPeriods(1)[0];
  try {
    const stmt = await getStatements(accountNumber, period);
    return {
      balance:          stmt.account?.balance?.value ?? null,
      availableBalance: stmt.account?.availableBalance?.value ?? null,
      accountType:      stmt.account?.accountType ?? null,
    };
  } catch {
    return { balance: null, availableBalance: null, accountType: null };
  }
}

// ── Period / date helpers ─────────────────────────────────────────────────────

// "202606" → { start: "2026-06-01", end: "2026-06-30" }
function periodToRange(period) {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4, 6), 10);
  const lastDay = new Date(y, m, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay)}` };
}

// Continuous range covering the last N months up to today
function recentDateRange(monthsBack = 3) {
  const now   = new Date();
  const end   = now.toISOString().slice(0, 10);
  const start = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1)
    .toISOString().slice(0, 10);
  return { start, end };
}

function recentPeriods(monthsBack = 3) {
  const periods = [];
  const now     = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return periods;
}

// Detect which months have data — ONE wide-range call, grouped client-side.
// Far faster than probing month by month (1 request vs maxMonthsBack requests).
async function detectAvailablePeriods(accountNumber, maxMonthsBack = 24) {
  const periods = recentPeriods(maxMonthsBack);            // current month first
  const counts  = Object.fromEntries(periods.map(p => [p, 0]));

  const oldest = periods[periods.length - 1];             // e.g. "202406"
  const start  = periodToRange(oldest).start;             // first day of oldest month
  const end    = new Date().toISOString().slice(0, 10);   // today

  try {
    const data = await getMovements(accountNumber, start, end);
    for (const m of (data.movements || [])) {
      if (!m.movementId || !m.movementDate) continue;
      const ym = m.movementDate.slice(0, 7).replace('-', ''); // "2026-06" → "202606"
      if (ym in counts) counts[ym]++;
    }
  } catch (err) {
    logger.warn(`Detección ${accountNumber}: ${err.message}`);
  }

  return periods.map(period => ({
    period,
    count:   counts[period],
    hasData: counts[period] > 0,
  }));
}

function invalidateToken() { cachedToken = null; tokenExpiry = null; }

module.exports = {
  login, getMovements, getTransactions, getAccountData, getBalance,
  detectAvailablePeriods, periodToRange, recentDateRange, recentPeriods,
  invalidateToken,
};
