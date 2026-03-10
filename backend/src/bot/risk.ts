import { RiskSettings } from '../config/settings';
import { getBalances, placeOrder, closePosition } from './exchange';
import logger from '../utils/logger';

export const getRiskSettings = async (apiKeyName: string): Promise<RiskSettings[]> => {
  // Загрузка из БД
  const { db } = await import('../utils/database');
  const settings = await db.all('SELECT * FROM risk_settings WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)', [apiKeyName]);
  return settings;
};

export const updateRiskSettings = async (apiKeyName: string, settings: RiskSettings) => {
  const { db } = await import('../utils/database');
  await db.run(
    'UPDATE risk_settings SET long_enabled = ?, short_enabled = ?, lot_long_percent = ?, lot_short_percent = ?, max_deposit = ?, margin_type = ?, leverage = ?, fixed_lot = ?, reinvest_percent = ? WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)',
    [settings.long_enabled, settings.short_enabled, settings.lot_long_percent, settings.lot_short_percent, settings.max_deposit, settings.margin_type, settings.leverage, settings.fixed_lot, settings.reinvest_percent, apiKeyName]
  );
  logger.info(`Updated risk settings for ${apiKeyName}`);
};

export const calculateLotSize = (balance: number, riskSettings: RiskSettings, side: 'long' | 'short'): number => {
  const percent = side === 'long' ? riskSettings.lot_long_percent : riskSettings.lot_short_percent;
  return (balance * percent / 100);
};

export const checkRiskLimits = (balance: number, riskSettings: RiskSettings): boolean => {
  return balance <= riskSettings.max_deposit;
};
