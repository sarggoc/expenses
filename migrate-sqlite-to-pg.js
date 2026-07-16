const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = path.join(__dirname, 'sargtech_expenses.sqlite');
if (!fs.existsSync(dbPath)) {
    console.error('❌ SQLite database not found at:', dbPath);
    process.exit(1);
}

const pemPath = path.join(__dirname, 'global-bundle.pem');
let ssl = false;
if (fs.existsSync(pemPath)) {
    ssl = {
        rejectUnauthorized: true,
        ca: fs.readFileSync(pemPath).toString()
    };
    console.log('Postgres: SSL configured using global-bundle.pem');
} else {
    ssl = { rejectUnauthorized: false };
}

const pgConfig = {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'asargeant',
    password: process.env.PGPASSWORD || 'Aaden8899$',
    database: process.env.PGDATABASE || 'postgres',
    ssl: ssl
};

const pgPool = new Pool(pgConfig);
const sqliteDb = new sqlite3.Database(dbPath);

// List of tables to migrate in order of dependencies (parent tables first)
const tables = [
    { name: 'divisions', sequence: 'divisions_id_seq' },
    { name: 'users', sequence: 'users_id_seq' },
    { name: 'supervisors', sequence: 'supervisors_id_seq' },
    { name: 'job_numbers', sequence: 'job_numbers_id_seq' },
    { name: 'card_whitelist', sequence: 'card_whitelist_id_seq' },
    { name: 'gas_cards', sequence: 'gas_cards_id_seq' },
    { name: 'groups', sequence: 'groups_id_seq' },
    { name: 'expenses', sequence: 'expenses_id_seq' },
    { name: 'settings', sequence: null },
    { name: 'notifications', sequence: 'notifications_id_seq' },
    { name: 'group_members', sequence: null },
    { name: 'expense_logs', sequence: 'expense_logs_id_seq' },
    { name: 'gas_expenses', sequence: 'gas_expenses_id_seq' },
    { name: 'reimbursement_types', sequence: 'reimbursement_types_id_seq' }
];

async function run() {
    try {
        console.log('Connecting to PostgreSQL...');
        const client = await pgPool.connect();
        console.log('PostgreSQL connected successfully.');
        client.release();

        // 1. Clear existing data in PostgreSQL tables using CASCADE in reverse dependency order
        console.log('\n🧹 Clearing existing records in PostgreSQL...');
        for (let i = tables.length - 1; i >= 0; i--) {
            const table = tables[i];
            console.log(`Truncating table: ${table.name}...`);
            await pgPool.query(`TRUNCATE TABLE "${table.name}" CASCADE`);
        }

        // 2. Migrate data table by table
        console.log('\n🚀 Starting SQLite -> PostgreSQL migration...');
        for (const table of tables) {
            console.log(`Reading table "${table.name}" from SQLite...`);
            
            const rows = await new Promise((resolve, reject) => {
                sqliteDb.all(`SELECT * FROM "${table.name}"`, [], (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            if (rows.length === 0) {
                console.log(`Table "${table.name}" is empty. Skipping.`);
                continue;
            }

            const columns = Object.keys(rows[0]);
            const colNamesStr = columns.map(c => `"${c}"`).join(', ');
            
            console.log(`Inserting ${rows.length} rows into PostgreSQL "${table.name}"...`);
            for (const row of rows) {
                const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
                const values = columns.map(c => row[c]);
                const insertQuery = `INSERT INTO "${table.name}" (${colNamesStr}) VALUES (${placeholders})`;
                await pgPool.query(insertQuery, values);
            }

            // Reset SERIAL sequence if applicable so that future Postgres inserts don't conflict
            if (table.sequence) {
                console.log(`Resetting PostgreSQL serial sequence for "${table.name}"...`);
                await pgPool.query(`
                    SELECT setval(
                        pg_get_serial_sequence($1, 'id'), 
                        COALESCE((SELECT MAX(id) FROM "${table.name}"), 1)
                    )
                `, [table.name]);
            }
        }

        console.log('\n🎉 Migration completed successfully! SQLite data is now active in PostgreSQL.');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Migration failed:', err);
        process.exit(1);
    }
}

run();
