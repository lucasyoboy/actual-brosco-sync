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
    return tx.additionalInfo?.qrPaymentResponse?.payment?.commerce_name
        || tx.additionalInfo?.qrInfoData?.commerce_name
        || 'QR Payment';
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

// ── Merged fetch over an exact date range ─────────────────────────────────────
/**
 * Combines /movements (account statement) + /transactions/list for the SAME date range.
 * Both calls are filtered server-side, so this is light even over long ranges.
 *
 * Dedup strategy: a movement and a transaction with the same date+amount are the SAME
 * operation seen by two systems. We merge them, keeping the richer payee from the
 * transactions API (e.g. "MAURICIO ALMADA" instead of "Extraccion BROSCO").
 * Transactions with no matching movement are added as exclusive entries, and
 * vice-versa, so nothing is lost.
 */
async function getMergedMovements(accountNumber, startDate, endDate) {
  // 1. Account movements (authoritative ledger) — also carries the real balance
  let movements = [];
  let accountInfo = null;
  try {
    const data  = await getMovements(accountNumber, startDate, endDate);
    movements   = (data.movements || []).filter(m => m.movementId);
    accountInfo = data.account || null;
  } catch (err) {
    const level = /\[400\]|\[401\]/.test(err.message) ? 'info' : 'warn';
    logger[level](`Movements ${accountNumber} ${startDate}→${endDate}: ${err.message.split(':')[0]}`);
  }

  // 2. Transactions for the SAME range (enrich + add exclusives)
  let accountTxns = [];
  try {
    const txnList = await getTransactions(startDate, endDate);
    accountTxns   = txnList.filter(tx => txnBelongsTo(tx, accountNumber));
  } catch (err) {
    logger.warn(`Transactions ${startDate}→${endDate}: ${err.message.split(':')[0]}`);
  }

  // Index transactions by "date|amount" for dedup against movements
  const txnByKey = new Map();
  for (const tx of accountTxns) {
    const date = (tx.executed || tx.confirmed || tx.created || '').slice(0, 10);
    const key  = `${date}|${Math.round(txnAmount(tx))}`;
    if (!txnByKey.has(key)) txnByKey.set(key, []);
    txnByKey.get(key).push(tx);
  }

  const result    = [];
  const usedTxns  = new Set();

  // 3. Movements (enriched with transaction payee when date+amount match)
  for (const mov of movements) {
    const isDebit = mov.type === 'DEBIT';
    const date    = mov.movementDate.slice(0, 10);
    const key     = `${date}|${Math.round(mov.amount.value)}`;

    let matchedTx = null;
    for (const tx of (txnByKey.get(key) || [])) {
      if (!usedTxns.has(tx)) { matchedTx = tx; usedTxns.add(tx); break; }
    }

    const payee = (matchedTx ? richPayee(matchedTx) : null) || mov.description || (isDebit ? 'Débito' : 'Crédito');
    result.push({
      importedId:  `stmt_${accountNumber}_${mov.movementId}`,
      date,
      amount:      isDebit ? -Math.round(mov.amount.value * 100) : Math.round(mov.amount.value * 100),
      description: payee,
      rawDesc:     mov.description,
    });
  }

  // 4. Transactions with no matching movement (exclusive to transactions API)
  let exclusiveCount = 0;
  for (const tx of accountTxns) {
    if (usedTxns.has(tx)) continue;
    exclusiveCount++;
    const isDebit = OUT_TYPES.has(tx.type);
    const amt     = txnAmount(tx);
    const txId    = (tx.token?.length > 10) ? tx.token : `${tx.type}_${tx.executed}_${tx.externalId || ''}`;
    result.push({
      importedId:  `txn_${accountNumber}_${txId}`,
      date:        (tx.executed || tx.confirmed || tx.created).slice(0, 10),
      amount:      isDebit ? -Math.round(amt * 100) : Math.round(amt * 100),
      description: richPayee(tx) || (isDebit ? 'Débito' : 'Crédito'),
      rawDesc:     tx.type,
    });
  }

  // Attach real balance info (in PYG, not cents) for reconciliation & display
  result.balance          = accountInfo?.balance?.value ?? null;
  result.availableBalance = accountInfo?.availableBalance?.value ?? null;
  result.holdBalance      = accountInfo?.holdBalance?.value ?? null;

  logger.info(`Account ${accountNumber} [${startDate}→${endDate}]: ${movements.length} movements + ${exclusiveCount} exclusivas = ${result.length} total | saldo ${result.balance ?? '?'} Gs`);
  return result;
}

// Quick balance fetch (tiny range — just for the account header info)
async function getBalance(accountNumber) {
  const today = new Date().toISOString().slice(0, 10);
  const data  = await getMovements(accountNumber, today, today);
  return {
    balance:          data.account?.balance?.value ?? null,
    availableBalance: data.account?.availableBalance?.value ?? null,
    holdBalance:      data.account?.holdBalance?.value ?? null,
    accountType:      data.account?.accountType ?? null,
  };
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
  login, getMovements, getTransactions, getMergedMovements, getBalance,
  detectAvailablePeriods, periodToRange, recentDateRange, recentPeriods,
  invalidateToken,
};
