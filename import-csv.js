// Usage: node scripts/import-csv.js path/to/leads.csv ["Property Name"]
// Uploads to your deployed bot (PUBLIC_URL + INGEST_SECRET from .env).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [file, property] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/import-csv.js leads.csv ["Property Name"]'); process.exit(1); }
const form = new FormData();
form.append('file', new Blob([readFileSync(file)], { type: 'text/csv' }), basename(file));
if (property) form.append('property', property);
const res = await fetch(`${process.env.PUBLIC_URL}/ingest/csv?key=${encodeURIComponent(process.env.INGEST_SECRET)}`, { method: 'POST', body: form });
console.log(res.status, JSON.stringify(await res.json(), null, 2));
