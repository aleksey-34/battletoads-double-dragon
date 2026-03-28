const { initDB } = require('../backend/dist/utils/database');
const { stopStrategy } = require('../backend/dist/bot/strategy');
const { ensureExchangeClientInitialized } = require('../backend/dist/bot/exchange');

const API_KEY = 'BTDD_D1';
const IDS = [80064, 80065, 80066, 80067, 80068, 80069];

async function main() {
	await initDB();
	await ensureExchangeClientInitialized(API_KEY);
	for (const id of IDS) {
		try {
			const result = await stopStrategy(API_KEY, id);
			console.log(JSON.stringify({ id, ok: true, is_active: result.is_active, last_action: result.last_action, state: result.state }));
		} catch (error) {
			console.log(JSON.stringify({ id, ok: false, error: String(error && error.message ? error.message : error) }));
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
