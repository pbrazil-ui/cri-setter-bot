import { config } from '../config.js';

const mod = config.dbMode === 'memory' ? await import('./memory.js') : await import('./supabase.js');
export const db = mod.db;
