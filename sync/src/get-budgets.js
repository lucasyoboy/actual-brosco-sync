// Helper: lista los presupuestos disponibles en tu Actual Budget server
// Uso: docker compose run --rm brosco-sync node src/get-budgets.js

const api = require('@actual-app/api');
const fs = require('fs');

async function main() {
  const dataDir = '/app/data';
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  await api.init({
    dataDir,
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });

  const budgets = await api.getBudgets();
  console.log('\nPresupuestos disponibles (objeto completo):\n');
  console.log(JSON.stringify(budgets, null, 2));

  // No llamar shutdown para evitar el error de timestamp
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
