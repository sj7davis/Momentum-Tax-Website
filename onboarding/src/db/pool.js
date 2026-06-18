const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway Postgres needs SSL; relax cert check as Railway does internally
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
};
