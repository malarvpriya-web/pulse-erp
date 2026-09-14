// Runs one SQL statement read from a FILE, so nothing has to survive shell quoting.
import fs from 'node:fs';
const q = fs.readFileSync(process.argv[2], 'utf8');
const pool = (await import('file:///' + process.argv[3])).default;
const r = await pool.query(q);
console.log('ROWS:' + JSON.stringify(r.rows));
await pool.end();
