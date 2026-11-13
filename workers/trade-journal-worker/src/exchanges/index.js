import { binance } from './binance.js';
import { bitget } from './bitget.js';

export { detectBitgetMode } from './bitget.js';

export function adapter(acc) {
  if (acc.exchange === 'binance') return binance(acc);
  if (acc.exchange === 'bitget')  return bitget(acc);
  throw new Error(`Exchange no soportado: ${acc.exchange}`);
}
