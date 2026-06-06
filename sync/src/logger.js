const MAX = 500;
const entries = [];
let listeners = [];

function log(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  listeners.forEach(fn => fn(entry));
  const out = level === 'error' ? console.error : console.log;
  out(`[${entry.ts}] [${level.toUpperCase()}] ${message}`);
}

module.exports = {
  info:  msg => log('info', msg),
  warn:  msg => log('warn', msg),
  error: msg => log('error', msg),
  all:   ()  => [...entries],
  subscribe(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter(l => l !== fn); };
  },
};
