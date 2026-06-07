const fs = require('fs');

const FILE = '/app/data/config.json';

function defaults() {
  return {
    broscoApiKey:          process.env.BROSCO_API_KEY           || '',
    broscoUser:            process.env.BROSCO_USER              || '',
    broscoPassword:        process.env.BROSCO_PASSWORD          || '',
    broscoDeviceId:        process.env.BROSCO_DEVICE_ID         || '',
    broscoSsign:           process.env.BROSCO_SSIGN             || '',
    actualServerUrl:       process.env.ACTUAL_SERVER_URL        || '',
    actualPassword:        process.env.ACTUAL_PASSWORD          || '',
    actualBudgetId:        process.env.ACTUAL_BUDGET_ID         || '',
    actualEncryptPassword: process.env.ACTUAL_ENCRYPT_PASSWORD  || '',
    syncCron:              process.env.SYNC_CRON                || '0 */6 * * *',
    syncAccounts:          process.env.SYNC_ACCOUNTS            || '8227200,8227201',
    syncMonthsBack:        process.env.SYNC_MONTHS_BACK         || '3',
    // Per-account settings: { "8227200": { actualAccountId, displayName, onBudget, accountType, openingBalance } }
    accountSettings: {},
    // Category rules: [{ pattern: "DEUDORES", categoryId: "uuid", categoryName: "Nombre" }]
    categoryRules: [],
    // AI categorization via Claude API
    useAiCategories: false,
    claudeApiKey:    process.env.CLAUDE_API_KEY || '',
    claudeModel:     'claude-haiku-4-5',
    aiInstructions:  '', // free-text rules the user gives the AI in natural language
    // Balance reconciliation: keep Actual's balance equal to Brosco's real balance
    reconcileBalance: true,
  };
}

function load() {
  if (fs.existsSync(FILE)) {
    try {
      return { ...defaults(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    } catch {}
  }
  return defaults();
}

function save(cfg) {
  fs.mkdirSync('/app/data', { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}

module.exports = { load, save };
