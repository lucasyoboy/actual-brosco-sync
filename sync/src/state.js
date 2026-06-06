const state = {
  isSyncing: false,
  lastSync: null,        // ISO string
  lastSyncStatus: null,  // 'ok' | 'error'
  lastSyncError: null,
  accounts: {},          // { '8227200': { added: 87, updated: 0 } }
};

module.exports = state;
