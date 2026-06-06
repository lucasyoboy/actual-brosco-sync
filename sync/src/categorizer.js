/**
 * Categorization pipeline:
 * 1. No description → null (Actual treats null as "Sin categoría")
 * 2. Pattern rules (defined by user) → category id
 * 3. AI with Claude (if enabled + API key set) → category id, with per-description cache
 * 4. Fallback → null ("Sin categoría")
 */

const fs     = require('fs');
const logger = require('./logger');

const CACHE_FILE = '/app/data/category-cache.json';
let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { _cache = {}; }
  return _cache;
}

function saveCache() {
  if (!_cache) return;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2));
}

function clearCache() {
  _cache = {};
  try { fs.writeFileSync(CACHE_FILE, '{}'); } catch {}
}

// ── Pattern rules ─────────────────────────────────────────────────────────────
function matchPattern(description, rules) {
  if (!rules?.length || !description) return null;
  const rule = rules.find(r =>
    r.pattern && description.toLowerCase().includes(r.pattern.toLowerCase())
  );
  return rule?.categoryId || null;
}

// ── Claude API ────────────────────────────────────────────────────────────────
async function askClaude(description, categories, apiKey, model) {
  const visible = categories.filter(c => !c.hidden);
  const catList = visible.map(c => `id:${c.id} | ${c.groupName} → ${c.name}`).join('\n');

  const prompt = `Sos un categorizador de transacciones bancarias de una cooperativa paraguaya.

Descripción del movimiento: "${description}"

Categorías disponibles:
${catList}

Respondé ÚNICAMENTE con el UUID (id) de la categoría que mejor encaja.
Si ninguna encaja bien, respondé con la palabra: null
Sin explicaciones, solo el id o null.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      model || 'claude-haiku-4-5',
      max_tokens: 60,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Claude [${res.status}]: ${err.error?.message || 'error desconocido'}`);
  }

  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  if (!text || text === 'null') return null;
  // Verify the UUID actually exists
  return categories.find(c => c.id === text)?.id || null;
}

// Descriptions that are internal type codes — not meaningful for AI
const SKIP_AI = /^(INTRA-OUT|INTRA-IN|INTER-OUT|INTER-IN|SIPAP-OUT|SIPAP-IN|QR-PAYMENT|DÉBITO|CRÉDITO|DEBIT|CREDIT)$/i;

// ── Main entry point ──────────────────────────────────────────────────────────
async function categorize(description, rules, categories, cfg) {
  if (!description?.trim()) return null;

  // 1. Pattern rules
  const fromRule = matchPattern(description, rules);
  if (fromRule) return fromRule;

  // 2. AI (if enabled) — skip generic internal codes
  if (!cfg.useAiCategories || !cfg.claudeApiKey) return null;
  if (SKIP_AI.test(description.trim())) return null;

  const key   = description.toLowerCase().trim();
  const cache = loadCache();

  if (key in cache) return cache[key]; // may be null — still cached

  try {
    const id = await askClaude(description, categories, cfg.claudeApiKey, cfg.claudeModel);
    cache[key] = id;
    saveCache();
    const catName = id ? (categories.find(c => c.id === id)?.name || id) : 'Sin categoría';
    logger.info(`IA categorizó "${description}" → ${catName}`);
    return id;
  } catch (err) {
    logger.warn(`IA falló para "${description}": ${err.message.split('.')[0]}`);
    return null;
  }
}

module.exports = { categorize, clearCache, loadCache, matchPattern };
