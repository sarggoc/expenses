const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
require('dotenv').config();
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'sargtech_secure_key_789!',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const dbConfig = {
    host: process.env.NODE_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.NODE_DB_PORT) || 3306,
    user: process.env.NODE_DB_USER || 'sargtech_sarg',
    password: process.env.NODE_DB_PASSWORD || 'Aaden8899$',
    database: process.env.NODE_DB_NAME || 'sargtech_testbase'
};

let dbMode = 'sqlite';
let pool = null;
let pgPool = null;
let sqliteDb = null;
let lastBackupTime = null;
let nextBackupTime = null;

function translateSql(sql) {
    let converted = sql;
    // Replace INSERT IGNORE or INSERT OR IGNORE with ON CONFLICT DO NOTHING
    converted = converted.replace(/INSERT\s+(?:OR\s+)?IGNORE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i, (match, table, cols, vals) => {
        const conflictCol = table.toLowerCase() === 'settings' ? 'key_name' : (table.toLowerCase() === 'job_numbers' ? 'job_number' : (table.toLowerCase() === 'card_whitelist' ? 'card_digits' : 'id'));
        return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT (${conflictCol}) DO NOTHING`;
    });
    
    // Replace backticks with double quotes
    converted = converted.replace(/`/g, '"');
    
    // Replace ? placeholders with $1, $2, $3...
    let index = 1;
    converted = converted.replace(/\?/g, () => `$${index++}`);
    return converted;
}

async function dbQuery(sql, params = []) {
    if (dbMode === 'postgres') {
        const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
        let converted = translateSql(sql);
        
        if (isInsert && !converted.toUpperCase().includes('RETURNING')) {
            converted += ' RETURNING id';
        }
        
        const res = await pgPool.query(converted, params);
        if (isInsert) {
            const insertId = res.rows[0]?.id || null;
            return [{ insertId, affectedRows: res.rowCount }, null];
        }
        return [res.rows, null];
    }
    if (dbMode === 'mysql') return await pool.query(sql, params);
    return new Promise((resolve, reject) => {
        const t = sql.trim().toUpperCase();
        if (t.startsWith('SELECT') || t.startsWith('WITH')) {
            sqliteDb.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve([rows, null]);
            });
        } else {
            sqliteDb.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve([{ insertId: this.lastID, affectedRows: this.changes }, null]);
            });
        }
    });
}

async function runSQLite(sql) {
    return new Promise((resolve, reject) => {
        sqliteDb.run(sql, [], (err) => { resolve(); });
    });
}

async function initSQLite() {
    const dbPath = path.join(__dirname, 'sargtech_expenses.sqlite');
    sqliteDb = new sqlite3.Database(dbPath);
    await new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
            sqliteDb.run('PRAGMA foreign_keys = ON;');
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                first_name TEXT NOT NULL, last_name TEXT NOT NULL,
                username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL, card_last_digits TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                spending_limit REAL DEFAULT NULL,
                profile_photo_path TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS supervisors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL, email TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS job_numbers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_number TEXT NOT NULL UNIQUE, description TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL, store_name TEXT NOT NULL,
                transaction_id TEXT NOT NULL, date TEXT NOT NULL,
                job_number TEXT, supervisor TEXT,
                description TEXT,
                receipt_photo_path TEXT,
                total_amount REAL NOT NULL, tax_type TEXT NOT NULL,
                tax_amount REAL NOT NULL, net_amount REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                payment_type TEXT NOT NULL DEFAULT 'Reimbursement',
                rejection_reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS settings (
                key_name TEXT PRIMARY KEY, value_name TEXT NOT NULL
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS card_whitelist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                card_digits TEXT NOT NULL UNIQUE, label TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                approver_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE SET NULL
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                is_read INTEGER NOT NULL DEFAULT 0,
                expense_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE SET NULL
            );`);
            sqliteDb.run(`CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                PRIMARY KEY (group_id, user_id),
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );`, (err) => { if (err) reject(err); else resolve(); });
        });
    });
    // Migrate: add columns if missing
    try { await runSQLite(`ALTER TABLE users ADD COLUMN spending_limit REAL DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE users ADD COLUMN profile_photo_path TEXT`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE users ADD COLUMN reimbursement_cap REAL DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'Reimbursement'`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN description TEXT`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN rejection_reason TEXT`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE notifications ADD COLUMN expense_id INTEGER`); } catch (e) {}
    // New v2 migrations
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN fees_json TEXT`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN void_reason TEXT`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN submitted_at DATETIME DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN approved_at DATETIME`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN approved_by INTEGER`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN voided_at DATETIME`); } catch (e) {}
    try { await runSQLite(`CREATE TABLE IF NOT EXISTS expense_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id INTEGER NOT NULL,
        user_id INTEGER,
        action TEXT NOT NULL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    )`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE job_numbers ADD COLUMN pending_confirmation INTEGER DEFAULT 0`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE job_numbers ADD COLUMN submitted_by INTEGER`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`); } catch (e) {}
    try { await runSQLite(`CREATE TABLE IF NOT EXISTS divisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE users ADD COLUMN division_id INTEGER DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE gas_cards ADD COLUMN user_id INTEGER DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE gas_cards ADD COLUMN active INTEGER NOT NULL DEFAULT 1`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE card_whitelist ADD COLUMN expiry_date TEXT DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE card_whitelist ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN wbs_code TEXT DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`ALTER TABLE expenses ADD COLUMN expense_type TEXT DEFAULT NULL`); } catch (e) {}
    try { await runSQLite(`CREATE TABLE IF NOT EXISTS reimbursement_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        wbs_code TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`); } catch (e) {}
    try { await runSQLite(`CREATE TABLE IF NOT EXISTS gas_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_number TEXT NOT NULL UNIQUE,
        card_type TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        truck_assigned TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`); } catch (e) {}
    try { await runSQLite(`CREATE TABLE IF NOT EXISTS gas_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        gas_card_id INTEGER NOT NULL,
        store_name TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        date TEXT NOT NULL,
        job_number TEXT,
        net_amount REAL NOT NULL,
        tax_amount REAL NOT NULL,
        fees_amount REAL NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL,
        liters_in_tank REAL NOT NULL,
        description TEXT,
        receipt_photo_path TEXT,
        status TEXT NOT NULL DEFAULT 'valid',
        contested_reason TEXT,
        rebuttal_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (gas_card_id) REFERENCES gas_cards(id) ON DELETE CASCADE
    )`); } catch (e) {}
    console.log('SQLite ready.');
}

async function initPostgres() {
    const pemPath = path.join(__dirname, 'global-bundle.pem');
    let ssl = false;
    if (fs.existsSync(pemPath)) {
        ssl = {
            rejectUnauthorized: true,
            ca: fs.readFileSync(pemPath).toString()
        };
        console.log('Postgres: SSL configured using global-bundle.pem');
    } else {
        console.warn('Postgres: global-bundle.pem not found. Connecting with self-signed SSL configuration.');
        ssl = { rejectUnauthorized: false };
    }

    const pgConfig = {
        host: process.env.PGHOST || process.env.NODE_DB_HOST || '127.0.0.1',
        port: parseInt(process.env.PGPORT || process.env.NODE_DB_PORT) || 5432,
        user: process.env.PGUSER || process.env.NODE_DB_USER || 'asargeant',
        password: process.env.PGPASSWORD || process.env.NODE_DB_PASSWORD || 'Aaden8899$',
        database: process.env.PGDATABASE || process.env.NODE_DB_NAME || 'expenses',
        ssl: ssl,
        connectionTimeoutMillis: 3000
    };

    console.log(`Connecting to PostgreSQL at ${pgConfig.host}:${pgConfig.port}...`);
    pgPool = new Pool(pgConfig);

    // Test connection
    const client = await pgPool.connect();
    console.log('PostgreSQL connected successfully.');
    client.release();

    // Create tables
    await pgPool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50) NOT NULL,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        card_last_digits VARCHAR(4) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'user',
        spending_limit DECIMAL(10,2) DEFAULT NULL,
        reimbursement_cap DECIMAL(10,2) DEFAULT NULL,
        profile_photo_path VARCHAR(255) DEFAULT NULL,
        division_id INTEGER DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS supervisors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS job_numbers (
        id SERIAL PRIMARY KEY,
        job_number VARCHAR(50) NOT NULL UNIQUE,
        description VARCHAR(200),
        active INTEGER NOT NULL DEFAULT 1,
        pending_confirmation INTEGER DEFAULT 0,
        submitted_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        store_name VARCHAR(100) NOT NULL,
        transaction_id VARCHAR(100) NOT NULL,
        date DATE NOT NULL,
        job_number VARCHAR(50),
        supervisor VARCHAR(100),
        description TEXT,
        receipt_photo_path VARCHAR(255),
        total_amount DECIMAL(10,2) NOT NULL,
        tax_type VARCHAR(20) NOT NULL,
        tax_amount DECIMAL(10,2) NOT NULL,
        net_amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        payment_type VARCHAR(20) NOT NULL DEFAULT 'Reimbursement',
        rejection_reason VARCHAR(255) DEFAULT NULL,
        fees_json TEXT,
        void_reason TEXT,
        wbs_code VARCHAR(50),
        expense_type VARCHAR(50),
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMP DEFAULT NULL,
        approved_by INTEGER,
        voided_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS settings (
        key_name VARCHAR(50) PRIMARY KEY,
        value_name VARCHAR(255) NOT NULL
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS card_whitelist (
        id SERIAL PRIMARY KEY,
        card_digits VARCHAR(4) NOT NULL UNIQUE,
        label VARCHAR(100),
        expiry_date VARCHAR(20),
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description VARCHAR(255),
        approver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message VARCHAR(500) NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        PRIMARY KEY (group_id, user_id)
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_logs (
        id SERIAL PRIMARY KEY,
        expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        user_id INTEGER,
        action VARCHAR(50) NOT NULL,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS divisions (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS gas_cards (
        id SERIAL PRIMARY KEY,
        card_number VARCHAR(50) NOT NULL UNIQUE,
        card_type VARCHAR(50) NOT NULL,
        expiry_date VARCHAR(20) NOT NULL,
        truck_assigned VARCHAR(50),
        user_id INTEGER DEFAULT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS gas_expenses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        gas_card_id INTEGER NOT NULL REFERENCES gas_cards(id) ON DELETE CASCADE,
        store_name VARCHAR(100) NOT NULL,
        transaction_id VARCHAR(100) NOT NULL,
        date DATE NOT NULL,
        job_number VARCHAR(50),
        net_amount DECIMAL(10,2) NOT NULL,
        tax_amount DECIMAL(10,2) NOT NULL,
        fees_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        total_amount DECIMAL(10,2) NOT NULL,
        liters_in_tank DECIMAL(10,2) NOT NULL,
        description TEXT,
        receipt_photo_path VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'valid',
        contested_reason TEXT,
        rebuttal_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pgPool.query(`CREATE TABLE IF NOT EXISTS reimbursement_types (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        wbs_code VARCHAR(50) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('PostgreSQL schema initialized.');
}

async function initDB() {
    const dbType = process.env.DB_TYPE || process.env.NODE_DB_TYPE || '';
    if (dbType.toLowerCase() === 'postgres' || process.env.PGHOST) {
        try {
            await initPostgres();
            dbMode = 'postgres';
            console.log('PostgreSQL connected.');
            
            const defaults = [['supervisor_required','true'],['job_number_required','true'],['spending_limit','0']];
            for (const [k, v] of defaults) {
                try {
                    await dbQuery(`INSERT INTO settings (key_name,value_name) VALUES (?,?) ON CONFLICT (key_name) DO NOTHING`, [k, v]);
                } catch (e) {}
            }
            
            try {
                const [rows] = await dbQuery("SELECT id FROM users WHERE username='admin' LIMIT 1");
                if (!rows.length) {
                    const hash = await bcrypt.hash('adminpassword123', 10);
                    await dbQuery(`INSERT INTO users (first_name,last_name,username,email,password_hash,card_last_digits,role) VALUES (?,?,?,?,?,?,?)`,
                        ['System','Administrator','admin','admin@sargtech.com',hash,'9999','admin']);
                    console.log('Admin seeded: username=admin password=adminpassword123');
                }
            } catch (e) { console.error('Seed error:', e.message); }
            
            await syncSupervisorsToUsers();
            return;
        } catch (pgErr) {
            console.warn('Postgres connection failed, falling back to MySQL/SQLite. Reason:', pgErr.message);
        }
    }

    try {
        console.log(`Trying MySQL: ${dbConfig.user}@${dbConfig.host}/${dbConfig.database}...`);
        const t = await mysql.createConnection({ ...dbConfig, connectTimeout: 5000 });
        await t.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await t.end();
        pool = mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 10 });
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY, first_name VARCHAR(50) NOT NULL, last_name VARCHAR(50) NOT NULL,
            username VARCHAR(50) NOT NULL UNIQUE, email VARCHAR(100) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL, card_last_digits VARCHAR(4) NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user', 
            spending_limit DECIMAL(10,2) DEFAULT NULL,
            profile_photo_path VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS supervisors (
            id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(100),
            active TINYINT NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS job_numbers (
            id INT AUTO_INCREMENT PRIMARY KEY, job_number VARCHAR(50) NOT NULL UNIQUE,
            description VARCHAR(200), active TINYINT NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS expenses (
            id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, store_name VARCHAR(100) NOT NULL,
            transaction_id VARCHAR(100) NOT NULL, date DATE NOT NULL, job_number VARCHAR(50),
            supervisor VARCHAR(100), description TEXT, receipt_photo_path VARCHAR(255),
            total_amount DECIMAL(10,2) NOT NULL, tax_type VARCHAR(20) NOT NULL,
            tax_amount DECIMAL(10,2) NOT NULL, net_amount DECIMAL(10,2) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending', 
            payment_type VARCHAR(20) NOT NULL DEFAULT 'Reimbursement',
            rejection_reason VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS settings (
            key_name VARCHAR(50) PRIMARY KEY, value_name VARCHAR(255) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS card_whitelist (
            id INT AUTO_INCREMENT PRIMARY KEY, card_digits VARCHAR(4) NOT NULL UNIQUE,
            label VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS groups (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            description VARCHAR(255),
            approver_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            message VARCHAR(500) NOT NULL,
            is_read TINYINT NOT NULL DEFAULT 0,
            expense_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS group_members (
            group_id INT NOT NULL,
            user_id INT NOT NULL,
            PRIMARY KEY (group_id, user_id),
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        try { await pool.query(`ALTER TABLE users ADD COLUMN spending_limit DECIMAL(10,2) DEFAULT NULL`); } catch (e) {}
        try { await pool.query(`ALTER TABLE users ADD COLUMN profile_photo_path VARCHAR(255) DEFAULT NULL`); } catch (e) {}
        try { await pool.query(`ALTER TABLE users ADD COLUMN reimbursement_cap DECIMAL(10,2) DEFAULT NULL`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN payment_type VARCHAR(20) NOT NULL DEFAULT 'Reimbursement'`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN description TEXT`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN rejection_reason VARCHAR(255) DEFAULT NULL`); } catch (e) {}
        try { await pool.query(`ALTER TABLE notifications ADD COLUMN expense_id INT`); } catch (e) {}
        // New v2 migrations
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN fees_json TEXT`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN void_reason TEXT`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN approved_at TIMESTAMP NULL`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN approved_by INT`); } catch (e) {}
        try { await pool.query(`ALTER TABLE expenses ADD COLUMN voided_at TIMESTAMP NULL`); } catch (e) {}
        try { await pool.query(`CREATE TABLE IF NOT EXISTS expense_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            expense_id INT NOT NULL,
            user_id INT,
            action VARCHAR(50) NOT NULL,
            reason TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); } catch (e) {}
        try { await pool.query(`ALTER TABLE job_numbers ADD COLUMN pending_confirmation TINYINT DEFAULT 0`); } catch (e) {}
        try { await pool.query(`ALTER TABLE job_numbers ADD COLUMN submitted_by INT`); } catch (e) {}
        dbMode = 'mysql';
        console.log('MySQL connected.');
    } catch (err) {
        console.warn('MySQL unavailable, using SQLite. Reason:', err.message);
        await initSQLite();
        dbMode = 'sqlite';
    }

    // Default settings
    const defaults = [['supervisor_required','true'],['job_number_required','true'],['spending_limit','0']];
    for (const [k, v] of defaults) {
        try {
            const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
            await dbQuery(`${ign} settings (key_name,value_name) VALUES (?,?)`, [k, v]);
        } catch (e) {}
    }

    // Seed admin
    try {
        const [rows] = await dbQuery("SELECT id FROM users WHERE username='admin' LIMIT 1");
        if (!rows.length) {
            const hash = await bcrypt.hash('adminpassword123', 10);
            await dbQuery(`INSERT INTO users (first_name,last_name,username,email,password_hash,card_last_digits,role) VALUES (?,?,?,?,?,?,?)`,
                ['System','Administrator','admin','admin@sargtech.com',hash,'9999','admin']);
            console.log('Admin seeded: username=admin password=adminpassword123');
        }
    } catch (e) { console.error('Seed error:', e.message); }
    
    // Auto-sync supervisors to users on startup
    await syncSupervisorsToUsers();
}

async function syncSupervisorsToUsers() {
    try {
        const [sups] = await dbQuery("SELECT id, name, email FROM supervisors WHERE active=1");
        console.log('Syncing supervisors:', sups);
        const defaultHash = await bcrypt.hash('password123', 10);
        for (const s of sups) {
            const email = s.email || `${s.name.toLowerCase().replace(/[^a-z0-9]/g, '')}@sargtech.local`;
            console.log(`Checking supervisor: ${s.name}, email: ${email}`);
            
            // Check if user exists by email
            const [userCheck] = await dbQuery("SELECT id, role FROM users WHERE email=? LIMIT 1", [email]);
            console.log(`userCheck result for ${email}:`, userCheck);
            
            if (userCheck && userCheck.length > 0) {
                const u = userCheck[0];
                console.log(`User already exists: ID ${u.id}, Role ${u.role}`);
                if (u.role === 'user') {
                    await dbQuery("UPDATE users SET role='approver' WHERE id=?", [u.id]);
                    console.log(`Promoted user ID ${u.id} to approver`);
                }
            } else {
                let username = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (!username) username = 'supervisor' + s.id;
                
                const [usernameCheck] = await dbQuery("SELECT id FROM users WHERE username=? LIMIT 1", [username]);
                if (usernameCheck && usernameCheck.length > 0) {
                    username = username + s.id;
                }

                const parts = s.name.trim().split(/\s+/);
                const firstName = parts[0] || 'Supervisor';
                const lastName = parts.slice(1).join(' ') || 'User';

                console.log(`Creating new user account for supervisor: ${username}, email: ${email}`);
                await dbQuery(`
                    INSERT INTO users (first_name, last_name, username, email, password_hash, card_last_digits, role)
                    VALUES (?, ?, ?, ?, ?, '0000', 'approver')
                `, [firstName, lastName, username, email, defaultHash]);
                console.log(`Synced supervisor user account created: ${username} (password: password123)`);
            }
        }
    } catch (e) {
        console.error('Error syncing supervisors to users:', e);
    }
}

async function getSettings() {
    try {
        const [rows] = await dbQuery('SELECT key_name,value_name FROM settings');
        const s = { supervisor_required: true, job_number_required: true, spending_limit: 0 };
        rows.forEach(r => {
            if (r.key_name === 'supervisor_required') s.supervisor_required = r.value_name === 'true';
            else if (r.key_name === 'job_number_required') s.job_number_required = r.value_name === 'true';
            else if (r.key_name === 'spending_limit') s.spending_limit = parseFloat(r.value_name) || 0;
        });
        return s;
    } catch (e) { return { supervisor_required: true, job_number_required: true, spending_limit: 0 }; }
}

async function getDropdowns() {
    try {
        const [sups] = await dbQuery("SELECT id,name,email FROM supervisors WHERE active=1 ORDER BY name ASC");
        const [jobNumbers]  = await dbQuery("SELECT id,job_number,description FROM job_numbers WHERE active=1 ORDER BY job_number ASC");
        
        const [groupsRows] = await dbQuery("SELECT id, name, approver_id FROM groups").catch(() => [[]]);
        const [usersRows] = await dbQuery("SELECT id, username, email FROM users").catch(() => [[]]);
        const [membersRows] = await dbQuery("SELECT group_id, user_id FROM group_members").catch(() => [[]]);
        
        const supervisors = sups.map(s => {
            const email = s.email || `${s.name.toLowerCase().replace(/[^a-z0-9]/g, '')}@sargtech.local`;
            const username = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            
            const matchingUser = usersRows.find(u => 
                u.email.toLowerCase() === email.toLowerCase() || 
                u.username.toLowerCase() === username.toLowerCase()
            );
            
            let groupName = null;
            if (matchingUser) {
                let g = groupsRows.find(grp => grp.approver_id === matchingUser.id);
                if (g) {
                    groupName = g.name;
                } else {
                    const memberMapping = membersRows.find(m => m.user_id === matchingUser.id);
                    if (memberMapping) {
                        const memberGroup = groupsRows.find(grp => grp.id === memberMapping.group_id);
                        if (memberGroup) groupName = memberGroup.name;
                    }
                }
            }
            return { ...s, group_name: groupName };
        });

        return { supervisors, jobNumbers };
    } catch (e) {
        return { supervisors: [], jobNumbers: [] };
    }
}

async function getUserSpendingSummary(userId) {
    try {
        const [cardRows] = await dbQuery(`
            SELECT status, COALESCE(SUM(total_amount), 0) as sum 
            FROM expenses 
            WHERE user_id = ? AND payment_type = 'Company Card' AND status IN ('approved', 'pending')
            GROUP BY status
        `, [userId]);
        let cardApproved = 0, cardPending = 0;
        cardRows.forEach(r => {
            if (r.status === 'approved') cardApproved += parseFloat(r.sum);
            else if (r.status === 'pending') cardPending += parseFloat(r.sum);
        });

        const [reimbRows] = await dbQuery(`
            SELECT status, COALESCE(SUM(total_amount), 0) as sum 
            FROM expenses 
            WHERE user_id = ? AND payment_type != 'Company Card' AND status IN ('approved', 'pending')
            GROUP BY status
        `, [userId]);
        let reimbApproved = 0, reimbPending = 0;
        reimbRows.forEach(r => {
            if (r.status === 'approved') reimbApproved += parseFloat(r.sum);
            else if (r.status === 'pending') reimbPending += parseFloat(r.sum);
        });

        const [userRows] = await dbQuery(`SELECT spending_limit, reimbursement_cap FROM users WHERE id=? LIMIT 1`, [userId]);
        const userLimit = userRows.length > 0 ? parseFloat(userRows[0].spending_limit) : null;
        const userReimbCap = userRows.length > 0 ? parseFloat(userRows[0].reimbursement_cap) : null;

        const settings = await getSettings();
        
        const limit = (userLimit !== null && userLimit > 0) ? userLimit : (parseFloat(settings.spending_limit) || 0);
        const remaining = limit > 0 ? Math.max(0, limit - cardApproved - cardPending) : null;

        const defaultReimbCap = parseFloat(settings.reimbursement_cap) || 1000;
        const reimbLimit = (userReimbCap !== null && userReimbCap > 0) ? userReimbCap : defaultReimbCap;
        const reimbRemaining = reimbLimit > 0 ? Math.max(0, reimbLimit - reimbApproved - reimbPending) : null;

        return { 
            approved: cardApproved, 
            pending: cardPending, 
            total: cardApproved + cardPending, 
            limit, 
            remaining,
            reimb: {
                approved: reimbApproved,
                pending: reimbPending,
                total: reimbApproved + reimbPending,
                limit: reimbLimit,
                remaining: reimbRemaining
            }
        };
    } catch (e) { 
        return { 
            approved: 0, pending: 0, total: 0, limit: 0, remaining: null,
            reimb: { approved: 0, pending: 0, total: 0, limit: 0, remaining: null }
        }; 
    }
}

// Tax helper — FORWARD calculation: user enters NET (pre-tax), tax is added on top
function calcTax(netAmount, taxType) {
    const rates = { GST: 0.05, HST13: 0.13, HST15: 0.15, None: 0 };
    const rate = rates[taxType] ?? 0;
    const net   = parseFloat(netAmount) || 0;
    const tax   = net * rate;
    const total = net + tax;
    return { net, tax, total, rate };
}

// Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const up = path.join(__dirname, 'public/uploads');
        if (!fs.existsSync(up)) fs.mkdirSync(up, { recursive: true });
        cb(null, up);
    },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname)); }
});
const upload = multer({
    storage, limits: { fileSize: 10*1024*1024 },
    fileFilter: (req, file, cb) => {
        if (/jpeg|jpg|png|gif|webp|heic|heif/i.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files allowed.'));
    }
});

// Auth middleware
function requireAuth(req, res, next) { if (!req.session.user) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) {
    if (!req.session.user || (req.session.user.role !== 'admin' && req.session.user.role !== 'accounting'))
        return res.status(403).render('error', { title: 'Access Denied', message: 'Admin or Accounting only.', user: req.session.user || null });
    next();
}

function requireAdminOrApprover(req, res, next) {
    if (!req.session.user || (req.session.user.role !== 'admin' && req.session.user.role !== 'accounting' && req.session.user.role !== 'approver' && req.session.user.role !== 'pm'))
        return res.status(403).render('error', { title: 'Access Denied', message: 'Access denied.', user: req.session.user || null });
    next();
}
app.use(async (req, res, next) => {
    res.locals.user        = req.session.user || null;
    res.locals.hasGasCard  = false;
    res.locals.supervisors = [];
    res.locals.jobNumbers  = [];
    res.locals.whitelist   = [];
    res.locals.activePage  = '';
    res.locals.activeView  = req.query.view || '';
    res.locals.notifications = [];
    res.locals.unreadNotificationsCount = 0;
    
    // Pre-load dropdowns and notifications for all authenticated requests
    if (req.session.user) {
        try {
            const [gasCardRows] = await dbQuery('SELECT id FROM gas_cards WHERE user_id=? AND active=1 LIMIT 1', [req.session.user.id]).catch(() => [[]]);
            res.locals.hasGasCard = (gasCardRows && gasCardRows.length > 0) || req.session.user.role === 'admin' || req.session.user.role === 'accounting';

            const [sups] = await dbQuery("SELECT id,name,email FROM supervisors WHERE active=1 ORDER BY name ASC");
            const [jobs] = await dbQuery("SELECT id,job_number,description FROM job_numbers WHERE active=1 ORDER BY job_number ASC");
            
            const [groupsRows] = await dbQuery("SELECT id, name, approver_id FROM groups").catch(() => [[]]);
            const [usersRows] = await dbQuery("SELECT id, username, email FROM users").catch(() => [[]]);
            const [membersRows] = await dbQuery("SELECT group_id, user_id FROM group_members").catch(() => [[]]);
            
            const supervisorsWithGroups = sups.map(s => {
                const email = s.email || `${s.name.toLowerCase().replace(/[^a-z0-9]/g, '')}@sargtech.local`;
                const username = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                
                const matchingUser = usersRows.find(u => 
                    u.email.toLowerCase() === email.toLowerCase() || 
                    u.username.toLowerCase() === username.toLowerCase()
                );
                
                let groupName = null;
                if (matchingUser) {
                    let g = groupsRows.find(grp => grp.approver_id === matchingUser.id);
                    if (g) {
                        groupName = g.name;
                    } else {
                        const memberMapping = membersRows.find(m => m.user_id === matchingUser.id);
                        if (memberMapping) {
                            const memberGroup = groupsRows.find(grp => grp.id === memberMapping.group_id);
                            if (memberGroup) groupName = memberGroup.name;
                        }
                    }
                }
                return { ...s, group_name: groupName };
            });

            res.locals.supervisors = supervisorsWithGroups || [];
            res.locals.jobNumbers  = jobs || [];
            
            const [notifs] = await dbQuery(`
                SELECT n.id, n.message, n.is_read, n.created_at, n.expense_id,
                       e.store_name, e.transaction_id, e.date, e.job_number, e.supervisor,
                       e.description, e.receipt_photo_path, e.total_amount, e.tax_type,
                       e.tax_amount, e.net_amount, e.status, e.payment_type, e.rejection_reason
                FROM notifications n
                LEFT JOIN expenses e ON n.expense_id = e.id
                WHERE n.user_id = ?
                ORDER BY n.created_at DESC
                LIMIT 15
            `, [req.session.user.id]);
            const [unreadCount] = await dbQuery("SELECT COUNT(*) AS unread FROM notifications WHERE user_id=? AND is_read=0", [req.session.user.id]);
            res.locals.notifications = notifs || [];
            res.locals.unreadNotificationsCount = unreadCount[0]?.unread || 0;
        } catch (e) { /* keep defaults */ }
    }
    next();
});

// Remove stale app.locals (res.locals takes precedence anyway)
app.locals.supervisors = [];
app.locals.jobNumbers  = [];
app.locals.whitelist   = [];

// ─────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('login', { title: 'Login', mode: 'login', error: req.query.error || null, success: req.query.success || null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.render('login', { title:'Login', mode:'login', error:'Please fill in all fields.', success:null });
    try {
        const [rows] = await dbQuery('SELECT * FROM users WHERE username=? OR email=? LIMIT 1', [username, username]);
        if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
            return res.render('login', { title:'Login', mode:'login', error:'Invalid username or password.', success:null });
        const u = rows[0];
        req.session.user = { id: u.id, first_name: u.first_name, last_name: u.last_name, username: u.username, email: u.email, card_last_digits: u.card_last_digits, role: u.role, profile_photo_path: u.profile_photo_path };
        res.redirect((u.role === 'admin' || u.role === 'accounting') ? '/admin' : '/dashboard');
    } catch (e) { console.error(e); res.render('login', { title:'Login', mode:'login', error:'Server error.', success:null }); }
});

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('login', { title:'Register', mode:'register', error: req.query.error || null, success:null });
});

app.post('/register', async (req, res) => {
    const { first_name, last_name, username, email, card_last_digits, password } = req.body;
    if (!first_name || !last_name || !username || !email || !password)
        return res.render('login', { title:'Register', mode:'register', error:'All fields except Card Reference are required.', success:null });
    
    const cardRef = card_last_digits?.trim() || 'None';
    if (cardRef !== 'None' && !/^\d{4}$/.test(cardRef))
        return res.render('login', { title:'Register', mode:'register', error:'Card digits must be exactly 4 numbers.', success:null });
        
    try {
        const [existing] = await dbQuery("SELECT id FROM users WHERE username=? OR email=? LIMIT 1", [username.trim(), email.trim()]);
        if (existing.length > 0) {
            return res.render('login', { title:'Register', mode:'register', error:'Username or email is already registered.', success:null });
        }

        if (cardRef !== 'None') {
            const [whitelist] = await dbQuery('SELECT card_digits, status FROM card_whitelist').catch(() => [[]]);
            const [gasCards] = await dbQuery('SELECT id, card_number, active FROM gas_cards').catch(() => [[]]);
            
            const hasRules = whitelist.length > 0 || gasCards.length > 0;
            if (hasRules) {
                const matchWhitelist = whitelist.find(r => r.card_digits === cardRef);
                const matchGas = gasCards.find(g => g.card_number.endsWith(cardRef));
                
                if (!matchWhitelist && !matchGas) {
                    return res.render('login', { title:'Register', mode:'register', error:'Your card is not authorized. Contact your administrator.', success:null });
                }
                if (matchWhitelist && matchWhitelist.status === 'suspended') {
                    return res.render('login', { title:'Register', mode:'register', error:'Your card is suspended. Contact your administrator.', success:null });
                }
                if (matchGas && matchGas.active === 0) {
                    return res.render('login', { title:'Register', mode:'register', error:'Your gas card is suspended. Contact your administrator.', success:null });
                }
            }
        }
        const hash = await bcrypt.hash(password, 10);
        const [insertResult] = await dbQuery(`INSERT INTO users (first_name,last_name,username,email,password_hash,card_last_digits,role) VALUES (?,?,?,?,?,?,'user')`,
            [first_name, last_name, username.trim(), email.trim(), hash, cardRef]);
        
        const newUserId = insertResult.insertId || insertResult.lastID;
        if (newUserId && cardRef !== 'None') {
            const [gasCards] = await dbQuery('SELECT id, card_number FROM gas_cards').catch(() => [[]]);
            const matchGas = gasCards.find(g => g.card_number.endsWith(cardRef));
            if (matchGas) {
                await dbQuery('UPDATE gas_cards SET user_id=? WHERE id=?', [newUserId, matchGas.id]);
            }
        }
        res.redirect('/login?success=Account created! Please log in.');
    } catch (e) { console.error(e); res.render('login', { title:'Register', mode:'register', error:'Server error during registration.', success:null }); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.post('/notifications/read-all', requireAuth, async (req, res) => {
    const referrer = req.get('Referrer') || '/dashboard';
    try {
        await dbQuery('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.session.user.id]);
        res.redirect(referrer);
    } catch (e) {
        console.error(e);
        res.redirect(referrer);
    }
});

// ─────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────
app.get('/dashboard', requireAuth, async (req, res) => {
    res.locals.activePage = 'dashboard';
    const activeView = req.query.view || '';
    if (activeView === 'add-cc' && (!req.session.user.card_last_digits || req.session.user.card_last_digits === 'None')) {
        return res.redirect('/dashboard?error=' + encodeURIComponent('You do not have an assigned credit card to add credit card expenses.'));
    }
    try {
        const [expenses] = await dbQuery('SELECT * FROM expenses WHERE user_id=? ORDER BY date DESC, created_at DESC', [req.session.user.id]);
        const settings = await getSettings();
        const spending = await getUserSpendingSummary(req.session.user.id);
        const { supervisors, jobNumbers } = await getDropdowns();
        const [reimbursementTypes] = await dbQuery('SELECT * FROM reimbursement_types ORDER BY name ASC').catch(() => [[]]);
        res.render('dashboard', { title:'My Expenses', expenses, settings, spending, supervisors, jobNumbers, reimbursementTypes, activeView, error: req.query.error || null, success: req.query.success || null });
    } catch (e) {
        console.error(e);
        res.render('dashboard', { title:'My Expenses', expenses:[], settings: await getSettings(), spending:{approved:0,pending:0,total:0,limit:0,remaining:null}, supervisors:[], jobNumbers:[], reimbursementTypes:[], activeView, error:'Could not load expenses.', success:null });
    }
});

// AI Receipt Scanner using Gemini 2.0 Flash Multimodal Vision API
app.post('/expenses/scan-receipt', requireAuth, (req, res, next) => {
    upload.single('receipt_photo')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        next();
    });
}, async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(400).json({ error: 'No GEMINI_API_KEY set in .env' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No receipt photo uploaded' });
    }

    const filePath = req.file.path;
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const base64Data = fileBuffer.toString('base64');
        const mimeType = req.file.mimetype;

        const prompt = `You are a receipt analysis AI. Extract key transaction details from this receipt image. Return structured JSON matching the provided schema. If a value is missing or hard to read, make your best guess. For tax_type, map to one of: GST, HST13, HST15, or None based on the province/tax rate listed.`;

        const requestBody = JSON.stringify({
            contents: [
                {
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: base64Data
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        store_name: { type: "STRING" },
                        date: { type: "STRING", description: "Format: YYYY-MM-DD" },
                        total_amount: { type: "NUMBER" },
                        tax_type: { type: "STRING", enum: ["None", "GST", "HST13", "HST15"] },
                        net_amount: { type: "NUMBER" },
                        tax_amount: { type: "NUMBER" },
                        description: { type: "STRING" }
                    },
                    required: ["store_name", "date", "total_amount", "tax_type"]
                }
            }
        });

        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
            };
            const request = https.request(options, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Invalid JSON from Gemini')); }
                });
            });
            request.on('error', reject);
            request.write(requestBody);
            request.end();
        });

        // Clean up uploaded temporary scan file
        try { fs.unlinkSync(filePath); } catch (e) { console.error('Failed to clean up scan file:', e); }

        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            console.error('Gemini API response missing text:', JSON.stringify(result));
            return res.status(500).json({ error: 'No response from Gemini API — check image visibility.' });
        }

        const parsedData = JSON.parse(text);
        res.json(parsedData);
    } catch (error) {
        // Clean up file if it exists and error happened
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
        console.error('Scan receipt error:', error);
        res.status(500).json({ error: 'Receipt scan failed: ' + error.message });
    }
});

app.post('/expenses/add', requireAuth, (req, res, next) => {
    upload.single('receipt_photo')(req, res, err => { if (err) return res.redirect('/dashboard?error='+encodeURIComponent(err.message)); next(); });
}, async (req, res) => {
    const { store_name, transaction_id, date, job_number, job_number_manual, supervisor, amount, tax_type, payment_type, description, fees_json } = req.body;
    const jobNum = (job_number_manual && job_number_manual.trim()) ? job_number_manual.trim() : (job_number?.trim() || null);
    try {
        const settings = await getSettings();
        if (settings.supervisor_required && !supervisor?.trim())
            return res.redirect('/dashboard?error='+encodeURIComponent('Supervisor is required.'));
        if (settings.job_number_required && !jobNum)
            return res.redirect('/dashboard?error='+encodeURIComponent('Job Number is required.'));

        // Parse and validate fees
        let feesData = [];
        try { feesData = fees_json ? JSON.parse(fees_json) : []; } catch(e) { feesData = []; }
        const feesTotal = feesData.reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);

        const { net, tax, total: baseTax } = calcTax(amount, tax_type);
        if (isNaN(net) || net <= 0)
            return res.redirect('/dashboard?error='+encodeURIComponent('Enter a valid amount.'));
        const total = baseTax + feesTotal;

        // Spending limit check (only credit card counts against limit)
        if (payment_type === 'Company Card') {
            if (!req.session.user.card_last_digits || req.session.user.card_last_digits === 'None') {
                return res.redirect('/dashboard?error='+encodeURIComponent('You do not have an assigned credit card to submit credit card expenses.'));
            }
            const spending = await getUserSpendingSummary(req.session.user.id);
            if (spending.limit > 0) {
                if (spending.total + total > spending.limit)
                    return res.redirect('/dashboard?error='+encodeURIComponent(`This would exceed your $${spending.limit.toFixed(2)} limit. Remaining: $${(spending.limit - spending.total).toFixed(2)}`));
            }
        }

        const payType = ['Company Card', 'Reimbursement'].includes(payment_type) ? payment_type : 'Reimbursement';
        const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
        const feesJsonStr = feesData.length > 0 ? JSON.stringify(feesData) : null;

        // If manual job number entered, add as pending if new, and always notify admin if still pending
        if (job_number_manual && job_number_manual.trim()) {
            const [existingJob] = await dbQuery('SELECT id, active, pending_confirmation FROM job_numbers WHERE job_number=? LIMIT 1', [jobNum]);
            if (!existingJob.length) {
                // Brand new job number — insert as pending and notify
                await dbQuery('INSERT INTO job_numbers (job_number, description, active, pending_confirmation, submitted_by) VALUES (?, ?, 0, 1, ?)',
                    [jobNum, `Submitted by ${req.session.user.first_name} ${req.session.user.last_name}`, req.session.user.id]);
                const [admins] = await dbQuery("SELECT id FROM users WHERE role IN ('admin','accounting') LIMIT 5");
                for (const a of admins) {
                    await dbQuery('INSERT INTO notifications (user_id, message, is_read) VALUES (?, ?, 0)',
                        [a.id, `**${req.session.user.first_name} ${req.session.user.last_name}** submitted a new job number **${jobNum}** that needs your confirmation.`]);
                }
            } else if (existingJob[0].pending_confirmation) {
                // Already pending — notify admin again so it doesn't get missed
                const [admins] = await dbQuery("SELECT id FROM users WHERE role IN ('admin','accounting') LIMIT 5");
                for (const a of admins) {
                    await dbQuery('INSERT INTO notifications (user_id, message, is_read) VALUES (?, ?, 0)',
                        [a.id, `**${req.session.user.first_name} ${req.session.user.last_name}** submitted another expense using unconfirmed job number **${jobNum}** — approval still needed.`]);
                }
            }
        }

        const expType = payType === 'Reimbursement' ? (req.body.expense_type?.trim() || null) : null;
        const wbsCode = payType === 'Reimbursement' ? (req.body.wbs_code?.trim() || null) : null;

        const [result] = await dbQuery(`INSERT INTO expenses (user_id,store_name,transaction_id,date,job_number,supervisor,description,receipt_photo_path,total_amount,tax_type,tax_amount,net_amount,status,payment_type,fees_json,expense_type,wbs_code,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,CURRENT_TIMESTAMP)`,
            [req.session.user.id, store_name.trim(), transaction_id.trim(), date, jobNum, supervisor?.trim()||null, description?.trim()||null, photoPath, total, tax_type, tax, net, payType, feesJsonStr, expType, wbsCode]);

        const expId = result.insertId || result.lastID;
        await dbQuery('INSERT INTO expense_logs (expense_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
            [expId, req.session.user.id, 'submitted', null]);

        res.redirect('/dashboard?view=history&success='+encodeURIComponent('Expense submitted!'));
    } catch (e) { console.error(e); res.redirect('/dashboard?view=history&error='+encodeURIComponent('Failed to save expense.')); }
});

app.post('/expenses/edit/:id', requireAuth, (req, res, next) => {
    upload.single('receipt_photo')(req, res, err => { if (err) return res.redirect('/dashboard?error='+encodeURIComponent(err.message)); next(); });
}, async (req, res) => {
    const { store_name, transaction_id, date, job_number, job_number_manual, supervisor, amount, edit_tax_type, payment_type, description, fees_json } = req.body;
    const jobNum = (job_number_manual && job_number_manual.trim()) ? job_number_manual.trim() : (job_number?.trim() || null);
    try {
        const [expRows] = await dbQuery("SELECT * FROM expenses WHERE id=? LIMIT 1", [req.params.id]);
        if (!expRows.length) return res.redirect('/dashboard?error=' + encodeURIComponent('Expense not found.'));
        const exp = expRows[0];
        if (exp.user_id !== req.session.user.id) {
            return res.redirect('/dashboard?error=' + encodeURIComponent('Access denied.'));
        }
        if (!['pending', 'rejected'].includes(exp.status)) {
            return res.redirect('/dashboard?error=' + encodeURIComponent('Only pending or rejected expenses can be edited.'));
        }

        const settings = await getSettings();
        if (settings.supervisor_required && !supervisor?.trim())
            return res.redirect('/dashboard?error='+encodeURIComponent('Supervisor is required.'));
        if (settings.job_number_required && !jobNum)
            return res.redirect('/dashboard?error='+encodeURIComponent('Job Number is required.'));

        let feesData = [];
        try { feesData = fees_json ? JSON.parse(fees_json) : []; } catch(e) { feesData = []; }
        const feesTotal = feesData.reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);

        const { net, tax, total: baseTax } = calcTax(amount, edit_tax_type);
        if (isNaN(net) || net <= 0)
            return res.redirect('/dashboard?error='+encodeURIComponent('Enter a valid amount.'));
        const total = baseTax + feesTotal;

        if (payment_type === 'Company Card') {
            if (!req.session.user.card_last_digits || req.session.user.card_last_digits === 'None') {
                return res.redirect('/dashboard?error='+encodeURIComponent('You do not have an assigned credit card to use the Company Card payment method.'));
            }
            const spending = await getUserSpendingSummary(req.session.user.id);
            if (spending.limit > 0) {
                const diff = total - exp.total_amount;
                if (spending.total + diff > spending.limit)
                    return res.redirect('/dashboard?error='+encodeURIComponent(`This would exceed your $${spending.limit.toFixed(2)} limit. Remaining: $${(spending.limit - spending.total).toFixed(2)}`));
            }
        }

        const payType = ['Company Card', 'Reimbursement'].includes(payment_type) ? payment_type : 'Reimbursement';
        const feesJsonStr = feesData.length > 0 ? JSON.stringify(feesData) : null;
        
        let photoPath = exp.receipt_photo_path;
        if (req.file) {
            if (exp.receipt_photo_path && exp.receipt_photo_path.startsWith('/uploads/')) {
                const oldPath = path.join(__dirname, 'public', exp.receipt_photo_path);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            photoPath = `/uploads/${req.file.filename}`;
        }

        // If manual job number not in list, add as pending confirmation
        if (job_number_manual && job_number_manual.trim()) {
            const [existingJob] = await dbQuery('SELECT id FROM job_numbers WHERE job_number=? LIMIT 1', [jobNum]);
            if (!existingJob.length) {
                await dbQuery('INSERT INTO job_numbers (job_number, description, active, pending_confirmation, submitted_by) VALUES (?, ?, 0, 1, ?)',
                    [jobNum, `Submitted by ${req.session.user.first_name} ${req.session.user.last_name}`, req.session.user.id]);
                // Notify admin
                const [admins] = await dbQuery("SELECT id FROM users WHERE role IN ('admin','accounting') LIMIT 5");
                for (const a of admins) {
                    await dbQuery('INSERT INTO notifications (user_id, message, is_read) VALUES (?, ?, 0)',
                        [a.id, `**${req.session.user.first_name} ${req.session.user.last_name}** submitted a new job number **${jobNum}** that needs your confirmation.`]);
                }
            }
        }

        const expType = payType === 'Reimbursement' ? (req.body.edit_expense_type?.trim() || null) : null;
        const wbsCode = payType === 'Reimbursement' ? (req.body.edit_wbs_code?.trim() || null) : null;

        const wasRejected = exp.status === 'rejected';
        await dbQuery(`
            UPDATE expenses 
            SET store_name=?, transaction_id=?, date=?, job_number=?, supervisor=?, description=?, receipt_photo_path=?, total_amount=?, tax_type=?, tax_amount=?, net_amount=?, payment_type=?, fees_json=?, expense_type=?, wbs_code=?, status='pending', rejection_reason=NULL
            WHERE id=?
        `, [store_name.trim(), transaction_id.trim(), date, jobNum, supervisor?.trim()||null, description?.trim()||null, photoPath, total, edit_tax_type, tax, net, payType, feesJsonStr, expType, wbsCode, req.params.id]);

        await dbQuery('INSERT INTO expense_logs (expense_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, wasRejected ? 'resubmitted_after_rejection' : 'edited', null]);

        res.redirect('/dashboard?view=history&success='+encodeURIComponent('Expense updated successfully!'));
    } catch (e) { 
        console.error(e); 
        res.redirect('/dashboard?view=history&error='+encodeURIComponent('Failed to update expense.')); 
    }
});

// ─────────────────────────────────────────────
//  ADMIN — MAIN
// ─────────────────────────────────────────────
app.post('/admin/expense/:id/status', requireAuth, async (req, res) => {
    const { status } = req.body;
    const referrer = req.get('Referrer') || '/admin/reports';
    if (!['approved','pending','rejected'].includes(status)) return res.redirect(referrer);
    try {
        const currentUser = req.session.user;
        const [expRows] = await dbQuery('SELECT user_id FROM expenses WHERE id=? LIMIT 1', [req.params.id]);
        if (!expRows.length) return res.redirect(referrer);
        const expenseUserId = expRows[0].user_id;

        let allowed = false;
        if (currentUser.role === 'admin' || currentUser.role === 'accounting') {
            allowed = true;
        } else if (currentUser.role === 'approver' || currentUser.role === 'pm') {
            const [grpRows] = await dbQuery(`
                SELECT g.id FROM groups g
                JOIN group_members gm ON g.id = gm.group_id
                WHERE g.approver_id = ? AND gm.user_id = ? LIMIT 1
            `, [currentUser.id, expenseUserId]);
            if (grpRows.length > 0) {
                allowed = true;
                
                if (currentUser.role === 'pm' && status === 'approved') {
                    const [expenseDetails] = await dbQuery('SELECT total_amount, payment_type FROM expenses WHERE id=? LIMIT 1', [req.params.id]);
                    if (expenseDetails.length > 0 && expenseDetails[0].payment_type !== 'Company Card') {
                        const amount = parseFloat(expenseDetails[0].total_amount);
                        const [pmDetails] = await dbQuery('SELECT reimbursement_cap FROM users WHERE id=? LIMIT 1', [currentUser.id]);
                        if (pmDetails.length > 0 && pmDetails[0].reimbursement_cap !== null) {
                            const cap = parseFloat(pmDetails[0].reimbursement_cap);
                            if (amount > cap) {
                                return res.status(403).send(`Expense amount ($${amount.toFixed(2)}) exceeds your reimbursement approval cap ($${cap.toFixed(2)}). Please escalate to Admin or Accounting.`);
                            }
                        }
                    }
                }
            }
        }

        if (!allowed) {
            return res.status(403).send('Not authorized to approve/reject this expense.');
        }

        const reason = status === 'rejected' ? (req.body.rejection_reason || 'No reason specified') : null;
        const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL';
        
        if (status === 'approved') {
            await dbQuery('UPDATE expenses SET status=?, rejection_reason=NULL, approved_at=CURRENT_TIMESTAMP, approved_by=? WHERE id=?',
                [status, currentUser.id, req.params.id]);
        } else {
            await dbQuery('UPDATE expenses SET status=?, rejection_reason=?, approved_at=NULL, approved_by=NULL WHERE id=?', [status, reason, req.params.id]);
        }

        // Log the action
        await dbQuery('INSERT INTO expense_logs (expense_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
            [req.params.id, currentUser.id, status, reason]);

        // Get details to write notification
        const [details] = await dbQuery('SELECT store_name, total_amount, user_id FROM expenses WHERE id=? LIMIT 1', [req.params.id]);
        if (details.length > 0) {
            const exp = details[0];
            const amountStr = parseFloat(exp.total_amount).toFixed(2);
            let msg = `Your expense at **${exp.store_name}** for **$${amountStr}** has been **${status}**.`;
            if (status === 'rejected' && reason) {
                msg += ` Reason: **${reason}**`;
            }
            await dbQuery('INSERT INTO notifications (user_id, message, is_read, expense_id) VALUES (?, ?, 0, ?)', [exp.user_id, msg, req.params.id]);
        }

        res.redirect(referrer);
    } catch (e) { console.error(e); res.status(500).send('Failed to update status.'); }
});

// ── Void expense (user can void own pending expenses)
app.post('/expenses/void/:id', requireAuth, async (req, res) => {
    const { void_reason } = req.body;
    if (!void_reason?.trim()) return res.redirect('/dashboard?view=history&error='+encodeURIComponent('A reason is required to void an expense.'));
    try {
        const [rows] = await dbQuery('SELECT * FROM expenses WHERE id=? AND user_id=? LIMIT 1', [req.params.id, req.session.user.id]);
        if (!rows.length) return res.redirect('/dashboard?view=history&error='+encodeURIComponent('Expense not found.'));
        if (rows[0].status !== 'pending') return res.redirect('/dashboard?view=history&error='+encodeURIComponent('Only pending expenses can be voided.'));

        await dbQuery("UPDATE expenses SET status='voided', void_reason=?, voided_at=CURRENT_TIMESTAMP WHERE id=?",
            [void_reason.trim(), req.params.id]);
        await dbQuery('INSERT INTO expense_logs (expense_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, 'voided', void_reason.trim()]);

        res.redirect('/dashboard?view=history&success='+encodeURIComponent('Expense voided successfully.'));
    } catch (e) { console.error(e); res.redirect('/dashboard?view=history&error='+encodeURIComponent('Failed to void expense.')); }
});

// ── Admin delete expense
app.post('/admin/expense/:id/delete', requireAuth, requireAdmin, async (req, res) => {
    const { delete_reason } = req.body;
    const referrer = req.get('Referrer') || '/admin/reports';
    if (!delete_reason?.trim()) return res.redirect(referrer + '?error='+encodeURIComponent('A reason is required to delete an expense.'));
    try {
        await dbQuery('INSERT INTO expense_logs (expense_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, 'deleted_by_admin', delete_reason.trim()]);
        await dbQuery('DELETE FROM expenses WHERE id=?', [req.params.id]);
        res.redirect(referrer + '?success='+encodeURIComponent('Expense deleted.'));
    } catch (e) { console.error(e); res.redirect(referrer + '?error='+encodeURIComponent('Failed to delete expense.')); }
});

// ── Expense logs viewer (accessible to owner or admin/approver/pm/accounting)
app.get('/expenses/:id/logs', requireAuth, async (req, res) => {
    try {
        const currentUser = req.session.user;
        const [expRows] = await dbQuery('SELECT user_id FROM expenses WHERE id=? LIMIT 1', [req.params.id]);
        if (!expRows.length) return res.status(404).json({ error: 'Expense not found', logs: [] });
        
        const ownerId = expRows[0].user_id;
        
        let authorized = (currentUser.id === ownerId);
        if (!authorized && ['admin', 'accounting', 'approver', 'pm'].includes(currentUser.role)) {
            authorized = true;
        }
        
        if (!authorized) {
            return res.status(403).json({ error: 'Access denied', logs: [] });
        }

        const [logs] = await dbQuery(`
            SELECT el.*, u.first_name || ' ' || u.last_name AS actor_name
            FROM expense_logs el
            LEFT JOIN users u ON el.user_id = u.id
            WHERE el.expense_id = ?
            ORDER BY el.created_at DESC
        `, [req.params.id]).catch(async () => {
            const [r] = await dbQuery(`
                SELECT el.*, CONCAT(u.first_name,' ',u.last_name) AS actor_name
                FROM expense_logs el
                LEFT JOIN users u ON el.user_id = u.id
                WHERE el.expense_id = ?
                ORDER BY el.created_at DESC
            `, [req.params.id]);
            return [r];
        });
        res.json({ logs: logs || [] });
    } catch (e) { console.error(e); res.status(500).json({ logs: [] }); }
});

// Backward compatible logs endpoint redirection
app.get('/admin/expense/:id/logs', requireAuth, async (req, res) => {
    res.redirect(`/expenses/${req.params.id}/logs`);
});

// Safe redirect on GET void requests
app.get('/expenses/void/:id', requireAuth, (req, res) => {
    res.redirect('/dashboard');
});

// ─────────────────────────────────────────────
//  GAS CARD EXPENSES
// ─────────────────────────────────────────────

// GET gas-expenses page
app.get('/gas-expenses', requireAuth, async (req, res) => {
    res.locals.activePage = 'gas-expenses';
    
    // Check if user has an active gas card or is admin/accounting
    if (!res.locals.hasGasCard) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have an active gas card assigned to you.', user: req.session.user });
    }

    try {
        let myGasCards = [];
        if (req.session.user.role === 'admin' || req.session.user.role === 'accounting') {
            const [allActiveCards] = await dbQuery(dbMode === 'mysql'
                ? `SELECT gc.*, CONCAT(u.first_name, ' ', u.last_name) AS user_name FROM gas_cards gc LEFT JOIN users u ON gc.user_id = u.id WHERE gc.active=1`
                : `SELECT gc.*, (u.first_name || ' ' || u.last_name) AS user_name FROM gas_cards gc LEFT JOIN users u ON gc.user_id = u.id WHERE gc.active=1`
            ).catch(() => [[]]);
            myGasCards = allActiveCards;
        } else {
            const [userCards] = await dbQuery('SELECT * FROM gas_cards WHERE user_id=? AND active=1', [req.session.user.id]).catch(() => [[]]);
            myGasCards = userCards;
        }

        let gasExpenses = [];
        if (req.session.user.role === 'admin' || req.session.user.role === 'accounting' || req.session.user.role === 'approver' || req.session.user.role === 'pm') {
            const [allExpenses] = await dbQuery(dbMode === 'mysql'
                ? `SELECT ge.*, gc.card_number, gc.card_type, CONCAT(u.first_name, ' ', u.last_name) AS user_name 
                   FROM gas_expenses ge 
                   JOIN gas_cards gc ON ge.gas_card_id = gc.id 
                   JOIN users u ON ge.user_id = u.id 
                   ORDER BY ge.date DESC`
                : `SELECT ge.*, gc.card_number, gc.card_type, (u.first_name || ' ' || u.last_name) AS user_name 
                   FROM gas_expenses ge 
                   JOIN gas_cards gc ON ge.gas_card_id = gc.id 
                   JOIN users u ON ge.user_id = u.id 
                   ORDER BY ge.date DESC`
            ).catch(() => [[]]);
            gasExpenses = allExpenses;
        } else {
            const [userExpenses] = await dbQuery(
                `SELECT ge.*, gc.card_number, gc.card_type 
                 FROM gas_expenses ge 
                 JOIN gas_cards gc ON ge.gas_card_id = gc.id 
                 WHERE ge.user_id = ? 
                 ORDER BY ge.date DESC`, [req.session.user.id]
            ).catch(() => [[]]);
            gasExpenses = userExpenses;
        }

        res.render('gas_expenses', {
            title: 'Gas Card Expenses',
            myGasCards,
            gasExpenses,
            activeView: req.query.view || '',
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Database error in gas expenses panel.');
    }
});

// POST add gas expense
app.post('/gas-expenses/add', requireAuth, async (req, res) => {
    // Check access
    if (!res.locals.hasGasCard) {
        return res.redirect('/dashboard?error=' + encodeURIComponent('Access denied: no active gas card.'));
    }

    upload.single('receipt_photo')(req, res, async err => {
        if (err) return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent(err.message));
        
        const { gas_card_id, store_name, transaction_id, date, job_number, job_number_manual, net_amount, tax_amount, fees_amount, description } = req.body;
        
        if (!gas_card_id || !store_name?.trim() || !transaction_id?.trim() || !date || !net_amount) {
            return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Please fill in all required fields.'));
        }

        try {
            // Verify card belongs to user (or user is admin/accounting)
            if (req.session.user.role !== 'admin' && req.session.user.role !== 'accounting') {
                const [cardCheck] = await dbQuery('SELECT id FROM gas_cards WHERE id=? AND user_id=? AND active=1 LIMIT 1', [gas_card_id, req.session.user.id]);
                if (cardCheck.length === 0) {
                    return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Invalid or inactive gas card selected.'));
                }
            }

            const net = parseFloat(net_amount);
            const tax = parseFloat(tax_amount || 0);
            const fees = parseFloat(fees_amount || 0);
            const total = net + tax + fees;
            const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
            // Sanitize: if dropdown sentinel '__manual__' was submitted without a manual value, treat as null
            const rawJob = job_number === '__manual__' ? null : job_number?.trim();
            const jobNum = (job_number_manual && job_number_manual.trim()) ? job_number_manual.trim() : (rawJob || null);

            // If manual job number not in list, add as pending confirmation
            if (job_number_manual && job_number_manual.trim()) {
                const [existingJob] = await dbQuery('SELECT id FROM job_numbers WHERE job_number=? LIMIT 1', [jobNum]);
                if (!existingJob.length) {
                    await dbQuery('INSERT INTO job_numbers (job_number, description, active, pending_confirmation, submitted_by) VALUES (?, ?, 0, 1, ?)',
                        [jobNum, `Submitted by ${req.session.user.first_name} ${req.session.user.last_name}`, req.session.user.id]);
                    // Notify admin
                    const [admins] = await dbQuery("SELECT id FROM users WHERE role IN ('admin','accounting') LIMIT 5");
                    for (const a of admins) {
                        await dbQuery('INSERT INTO notifications (user_id, message, is_read) VALUES (?, ?, 0)',
                            [a.id, `**${req.session.user.first_name} ${req.session.user.last_name}** submitted a new job number **${jobNum}** that needs your confirmation.`]);
                    }
                }
            }

            await dbQuery(
                `INSERT INTO gas_expenses (user_id, gas_card_id, store_name, transaction_id, date, job_number, net_amount, tax_amount, fees_amount, total_amount, liters_in_tank, description, receipt_photo_path, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid')`,
                [req.session.user.id, gas_card_id, store_name.trim(), transaction_id.trim(), date, jobNum, net, tax, fees, total, parseFloat(req.body.liters_in_tank || 0), description?.trim() || null, photoPath]
            );

            res.redirect('/gas-expenses?view=history&success=' + encodeURIComponent('Gas expense added successfully.'));
        } catch (e) {
            console.error(e);
            res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Failed to add gas expense: ' + e.message));
        }
    });
});

// POST upload photo later
app.post('/gas-expenses/upload-photo/:id', requireAuth, async (req, res) => {
    upload.single('receipt_photo')(req, res, async err => {
        if (err) return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent(err.message));
        if (!req.file) return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Please select an image file to upload.'));

        try {
            // Verify ownership or admin
            const [expRows] = await dbQuery('SELECT user_id, receipt_photo_path FROM gas_expenses WHERE id=? LIMIT 1', [req.params.id]);
            if (!expRows.length) return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Expense not found.'));
            
            if (expRows[0].user_id !== req.session.user.id && req.session.user.role !== 'admin' && req.session.user.role !== 'accounting') {
                return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Access denied.'));
            }

            // Delete old photo if it exists
            if (expRows[0].receipt_photo_path && expRows[0].receipt_photo_path.startsWith('/uploads/')) {
                const oldPath = path.join(__dirname, 'public', expRows[0].receipt_photo_path);
                fs.unlink(oldPath, () => {});
            }

            const photoPath = `/uploads/${req.file.filename}`;
            await dbQuery('UPDATE gas_expenses SET receipt_photo_path=? WHERE id=?', [photoPath, req.params.id]);
            res.redirect('/gas-expenses?view=history&success=' + encodeURIComponent('Receipt photo added successfully.'));
        } catch (e) {
            console.error(e);
            res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Failed to upload receipt: ' + e.message));
        }
    });
});

// POST delete gas expense
app.post('/gas-expenses/delete/:id', requireAuth, async (req, res) => {
    try {
        const [expRows] = await dbQuery('SELECT user_id, receipt_photo_path FROM gas_expenses WHERE id=? LIMIT 1', [req.params.id]);
        if (!expRows.length) return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Expense not found.'));

        // Allow owner (if not contested/rebutted or admin/accounting)
        const isOwner = expRows[0].user_id === req.session.user.id;
        const isAdmin = req.session.user.role === 'admin' || req.session.user.role === 'accounting';

        if (!isOwner && !isAdmin) {
            return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Access denied.'));
        }

        // Delete receipt file
        if (expRows[0].receipt_photo_path && expRows[0].receipt_photo_path.startsWith('/uploads/')) {
            const oldPath = path.join(__dirname, 'public', expRows[0].receipt_photo_path);
            fs.unlink(oldPath, () => {});
        }

        await dbQuery('DELETE FROM gas_expenses WHERE id=?', [req.params.id]);
        res.redirect('/gas-expenses?view=history&success=' + encodeURIComponent('Gas expense deleted successfully.'));
    } catch (e) {
        console.error(e);
        res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Failed to delete gas expense.'));
    }
});

// POST user submit rebuttal
app.post('/gas-expenses/rebut/:id', requireAuth, async (req, res) => {
    const { rebuttal_reason } = req.body;
    if (!rebuttal_reason?.trim()) {
        return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Rebuttal reason is required.'));
    }
    try {
        const [expRows] = await dbQuery('SELECT user_id, status FROM gas_expenses WHERE id=? LIMIT 1', [req.params.id]);
        if (!expRows.length) return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Expense not found.'));

        if (expRows[0].user_id !== req.session.user.id) {
            return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Access denied.'));
        }

        await dbQuery("UPDATE gas_expenses SET status='rebutted', rebuttal_reason=? WHERE id=?", [rebuttal_reason.trim(), req.params.id]);
        res.redirect('/gas-expenses?view=history&success=' + encodeURIComponent('Rebuttal submitted successfully.'));
    } catch (e) {
        console.error(e);
        res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Failed to submit rebuttal.'));
    }
});

// POST admin contest gas expense
app.post('/gas-expenses/contest/:id', requireAuth, requireAdmin, async (req, res) => {
    const { contested_reason } = req.body;
    if (!contested_reason?.trim()) {
        return res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Contested reason is required.'));
    }
    try {
        await dbQuery("UPDATE gas_expenses SET status='contested', contested_reason=? WHERE id=?", [contested_reason.trim(), req.params.id]);
        res.redirect('/gas-expenses?view=history&success=' + encodeURIComponent('Gas expense marked as contested.'));
    } catch (e) {
        console.error(e);
        res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Failed to contest gas expense.'));
    }
});

// POST admin validate gas expense
app.post('/gas-expenses/validate/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery("UPDATE gas_expenses SET status='valid', contested_reason=NULL, rebuttal_reason=NULL WHERE id=?", [req.params.id]);
        res.redirect('/gas-expenses?view=history&success=' + encodeURIComponent('Gas expense validated.'));
    } catch (e) {
        console.error(e);
        res.redirect('/gas-expenses?view=history&error=' + encodeURIComponent('Failed to validate gas expense.'));
    }
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect('/admin/settings/general' + query);
});

app.get('/admin/status', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'status';
    try {
        const uptime = process.uptime();
        const nodeVersion = process.version;
        const platform = process.platform;
        const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024; // MB
        
        // Git Version & Sync status
        let runningCommit = 'N/A';
        let runningCommitMsg = 'N/A';
        let runningCommitDate = 'N/A';
        try {
            runningCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
            runningCommitMsg = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim().split('\n')[0];
            runningCommitDate = execSync('git log -1 --format="%cd (%cr)"', { encoding: 'utf8' }).trim();
        } catch (e) {
            // Fail silently
        }

        let githubCommit = 'N/A';
        let deploymentStatus = 'Unknown';
        try {
            const response = await fetch('https://api.github.com/repos/sarggoc/expenses/commits/main', {
                headers: { 'User-Agent': 'Sargtech-Expenses-Server' },
                signal: AbortSignal.timeout(2000)
            });
            if (response.ok) {
                const data = await response.json();
                githubCommit = data.sha.substring(0, 7);
                if (runningCommit !== 'N/A') {
                    if (runningCommit === githubCommit) {
                        deploymentStatus = 'Fully Synced (Latest GitHub commit matches active server code)';
                    } else {
                        deploymentStatus = `Pending Update (Server is running ${runningCommit}, GitHub is at ${githubCommit})`;
                    }
                }
            }
        } catch (err) {
            deploymentStatus = 'Unable to verify (GitHub API unreachable)';
        }

        const gitInfo = {
            runningCommit,
            runningCommitMsg,
            runningCommitDate,
            githubCommit,
            deploymentStatus
        };

        // Database stats
        let dbStatus = 'Disconnected';
        let dbHost = 'N/A';
        let dbPort = 'N/A';
        let dbUser = 'N/A';
        let dbName = 'N/A';
        let sslStatus = 'Disabled';
        
        if (dbMode === 'postgres') {
            dbStatus = 'Connected (PostgreSQL)';
            dbHost = process.env.PGHOST || '127.0.0.1';
            dbPort = process.env.PGPORT || '5432';
            dbUser = process.env.PGUSER || 'asargeant';
            dbName = process.env.PGDATABASE || 'postgres';
            sslStatus = fs.existsSync(path.join(__dirname, 'global-bundle.pem')) ? 'Enabled (AWS PKI SSL Bundle Verified)' : 'Enabled (Self-signed / Unverified)';
        } else if (dbMode === 'mysql') {
            dbStatus = 'Connected (MySQL)';
            dbHost = dbConfig.host;
            dbPort = dbConfig.port;
            dbUser = dbConfig.user;
            dbName = dbConfig.database;
        } else {
            dbStatus = 'Connected (SQLite local fallback)';
            dbName = 'sargtech_expenses.sqlite';
        }
        
        // Count queries
        const [usersRows] = await dbQuery("SELECT COUNT(*) as count FROM users").catch(() => [[{count: 0}]]);
        const [expensesRows] = await dbQuery("SELECT COUNT(*) as count FROM expenses").catch(() => [[{count: 0}]]);
        const [supsRows] = await dbQuery("SELECT COUNT(*) as count FROM supervisors").catch(() => [[{count: 0}]]);
        const [jobsRows] = await dbQuery("SELECT COUNT(*) as count FROM job_numbers").catch(() => [[{count: 0}]]);
        const [gasRows] = await dbQuery("SELECT COUNT(*) as count FROM gas_expenses").catch(() => [[{count: 0}]]);
        
        const stats = {
            users: usersRows?.[0]?.count || 0,
            expenses: expensesRows?.[0]?.count || 0,
            supervisors: supsRows?.[0]?.count || 0,
            jobs: jobsRows?.[0]?.count || 0,
            gasExpenses: gasRows?.[0]?.count || 0
        };

        const configChecks = {
            geminiApiKey: process.env.GEMINI_API_KEY ? 'Configured (Active)' : 'Missing',
            sessionSecret: process.env.SESSION_SECRET ? 'Configured' : 'Default (Insecure)',
            sslPemExists: fs.existsSync(path.join(__dirname, 'global-bundle.pem')) ? 'Found' : 'Missing'
        };

        // Backup statistics
        const backupDir = path.join(__dirname, 'backups');
        let backupCount = 0;
        let lastBackupFile = 'None';
        let lastBackupSize = '0 KB';
        
        if (fs.existsSync(backupDir)) {
            const files = fs.readdirSync(backupDir).filter(f => f.startsWith('backup_'));
            backupCount = files.length;
            if (backupCount > 0) {
                files.sort((a, b) => {
                    return fs.statSync(path.join(backupDir, b)).mtime.getTime() - fs.statSync(path.join(backupDir, a)).mtime.getTime();
                });
                lastBackupFile = files[0];
                try {
                    const statsObj = fs.statSync(path.join(backupDir, lastBackupFile));
                    lastBackupSize = (statsObj.size / 1024).toFixed(2) + ' KB';
                    if (!lastBackupTime) {
                        lastBackupTime = statsObj.mtime;
                    }
                } catch (err) {}
            }
        }

        const backupsInfo = {
            intervalHours: (parseInt(process.env.BACKUP_INTERVAL_HOURS) || 6),
            lastTime: lastBackupTime ? lastBackupTime.toLocaleString() : 'Never',
            nextTime: nextBackupTime ? nextBackupTime.toLocaleString() : 'Pending',
            count: backupCount,
            lastFile: lastBackupFile,
            lastSize: lastBackupSize
        };

        // Measure database query latency
        const latencyStart = Date.now();
        await dbQuery("SELECT 1").catch(() => {});
        const dbLatency = Date.now() - latencyStart;

        // AWS details
        let awsRegion = 'N/A';
        let awsService = 'Local / Fallback';
        if (dbMode === 'postgres') {
            awsService = 'AWS RDS (PostgreSQL)';
            if (dbHost.includes('.rds.amazonaws.com')) {
                const parts = dbHost.split('.');
                if (parts.length >= 3) {
                    awsRegion = parts[2];
                }
            }
        }

        res.render('admin/status', {
            title: 'System & Database Status',
            dbMode,
            dbStatus,
            dbHost,
            dbPort,
            dbUser,
            dbName,
            sslStatus,
            uptime: formatUptime(uptime),
            nodeVersion,
            platform,
            memoryUsage: memoryUsage.toFixed(2),
            stats,
            configChecks,
            backupsInfo,
            awsInfo: {
                region: awsRegion,
                service: awsService,
                latency: dbLatency + ' ms'
            },
            gitInfo,
            error: null,
            success: null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading status page: ' + e.message);
    }
});

// ─────────────────────────────────────────────
//  AWS / DATABASE MASTER DATA EXPLORER
// ─────────────────────────────────────────────
app.get('/admin/master-data', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'master-data';
    const selectedTable = req.query.table || '';

    try {
        let tables = [];
        // Fetch list of tables
        if (dbMode === 'postgres') {
            const result = await dbQuery(`
                SELECT table_name AS name 
                FROM information_schema.tables 
                WHERE table_schema='public' AND table_type='BASE TABLE'
                ORDER BY table_name ASC
            `);
            tables = result[0] || [];
        } else if (dbMode === 'mysql') {
            const result = await dbQuery('SHOW TABLES');
            const rows = result[0] || [];
            tables = rows.map(r => {
                const keys = Object.keys(r);
                return { name: r[keys[0]] };
            });
        } else {
            // SQLite
            const result = await dbQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
            tables = result[0] || [];
        }

        let columns = [];
        let rows = [];

        if (selectedTable) {
            // Security check: ensure the table name is valid and exists in our list
            const tableExists = tables.some(t => t.name === selectedTable);
            if (!tableExists) {
                return res.redirect('/admin/master-data?error=' + encodeURIComponent('Invalid table selected.'));
            }

            // Fetch columns
            if (dbMode === 'postgres') {
                const colResult = await dbQuery(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_schema='public' AND table_name = ?
                    ORDER BY ordinal_position ASC
                `, [selectedTable]);
                columns = (colResult[0] || []).map(c => c.column_name);
            } else if (dbMode === 'mysql') {
                const colResult = await dbQuery(`DESCRIBE \`${selectedTable}\``);
                columns = (colResult[0] || []).map(c => c.Field);
            } else {
                const colResult = await dbQuery(`PRAGMA table_info(\`${selectedTable}\`)`);
                columns = (colResult[0] || []).map(c => c.name);
            }

            // Fetch rows (limit to 300)
            const rowResult = await dbQuery(`SELECT * FROM "${selectedTable}" LIMIT 300`);
            rows = rowResult[0] || [];
        }

        res.render('admin/master_data', {
            title: 'AWS Master Data Explorer',
            tables,
            selectedTable,
            columns,
            rows,
            dbMode,
            error: req.query.error || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Master Data error: ' + e.message);
    }
});

function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    
    const dDisplay = d > 0 ? d + (d === 1 ? " day, " : " days, ") : "";
    const hDisplay = h > 0 ? h + (h === 1 ? " hour, " : " hours, ") : "";
    const mDisplay = m > 0 ? m + (m === 1 ? " minute, " : " minutes, ") : "";
    const sDisplay = s > 0 ? s + (s === 1 ? " second" : " seconds") : "";
    return dDisplay + hDisplay + mDisplay + sDisplay || "0 seconds";
}

app.get('/admin/settings/general', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'settings-general';
    try {
        const settings = await getSettings();
        res.render('admin/settings_general', {
            title: 'General Settings',
            settings,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Database error in settings.');
    }
});

app.get('/admin/settings/supervisors', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'settings-supervisors';
    try {
        const [sups] = await dbQuery('SELECT * FROM supervisors ORDER BY name ASC').catch(() => [[]]);
        const [groupsRows] = await dbQuery("SELECT id, name, approver_id FROM groups").catch(() => [[]]);
        const [usersRows] = await dbQuery("SELECT id, username, email FROM users").catch(() => [[]]);
        const [membersRows] = await dbQuery("SELECT group_id, user_id FROM group_members").catch(() => [[]]);

        const supervisors = sups.map(s => {
            const email = s.email || `${s.name.toLowerCase().replace(/[^a-z0-9]/g, '')}@sargtech.local`;
            const username = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            
            const matchingUser = usersRows.find(u => 
                u.email.toLowerCase() === email.toLowerCase() || 
                u.username.toLowerCase() === username.toLowerCase()
            );
            
            let groupName = null;
            if (matchingUser) {
                let g = groupsRows.find(grp => grp.approver_id === matchingUser.id);
                if (g) {
                    groupName = g.name;
                } else {
                    const memberMapping = membersRows.find(m => m.user_id === matchingUser.id);
                    if (memberMapping) {
                        const memberGroup = groupsRows.find(grp => grp.id === memberMapping.group_id);
                        if (memberGroup) groupName = memberGroup.name;
                    }
                }
            }
            return { ...s, group_name: groupName };
        });

        res.render('admin/settings_supervisors', {
            title: 'Supervisor Management',
            supervisors,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Database error in settings.');
    }
});

app.get('/admin/settings/jobnumbers', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'settings-jobnumbers';
    try {
        const [jobNumbers] = await dbQuery('SELECT * FROM job_numbers ORDER BY job_number ASC').catch(() => [[]]);
        res.render('admin/settings_jobnumbers', {
            title: 'Job Number Management',
            jobNumbers,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Database error in settings.');
    }
});

app.get('/admin/settings/categories', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'settings-categories';
    try {
        const [divisions] = await dbQuery('SELECT * FROM divisions ORDER BY name ASC').catch(() => [[]]);
        const [reimbursementTypes] = await dbQuery('SELECT * FROM reimbursement_types ORDER BY name ASC').catch(() => [[]]);
        res.render('admin/settings_categories', {
            title: 'Expense Categories',
            divisions,
            reimbursementTypes,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Database error in settings.');
    }
});

app.get('/admin/settings/cards', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'settings-cards';
    try {
        const [whitelist] = await dbQuery('SELECT id,card_digits,label,expiry_date,status,created_at FROM card_whitelist ORDER BY created_at DESC').catch(() => [[]]);
        const [users] = await dbQuery("SELECT id, username, email, first_name, last_name FROM users ORDER BY first_name ASC, last_name ASC").catch(() => [[]]);
        const [gasCards] = await dbQuery(dbMode === 'mysql'
            ? `SELECT gc.*, CONCAT(u.first_name, ' ', u.last_name) AS user_name FROM gas_cards gc LEFT JOIN users u ON gc.user_id = u.id ORDER BY gc.created_at DESC`
            : `SELECT gc.*, (u.first_name || ' ' || u.last_name) AS user_name FROM gas_cards gc LEFT JOIN users u ON gc.user_id = u.id ORDER BY gc.created_at DESC`
        ).catch(() => [[]]);

        res.render('admin/settings_cards', {
            title: 'Card Whitelist & Gas Cards',
            whitelist,
            gasCards,
            users,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Database error in settings.');
    }
});

app.post('/admin/settings', requireAuth, requireAdmin, async (req, res) => {
    const sup   = req.body.supervisor_required  === 'true' ? 'true' : 'false';
    const job   = req.body.job_number_required  === 'true' ? 'true' : 'false';
    const limit = parseFloat(req.body.spending_limit) || 0;
    try {
        const upsert = dbMode === 'mysql' ? 'REPLACE INTO' : 'INSERT OR REPLACE INTO';
        await dbQuery(`${upsert} settings (key_name,value_name) VALUES (?,?)`, ['supervisor_required', sup]);
        await dbQuery(`${upsert} settings (key_name,value_name) VALUES (?,?)`, ['job_number_required', job]);
        await dbQuery(`${upsert} settings (key_name,value_name) VALUES (?,?)`, ['spending_limit', limit.toString()]);
        res.redirect('/admin/settings/general?success='+encodeURIComponent('Settings saved.'));
    } catch (e) { res.redirect('/admin/settings/general?error='+encodeURIComponent('Failed to save settings.')); }
});

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
//  ADMIN — GROUPS MANAGEMENT
// ─────────────────────────────────────────────
app.get('/admin/groups', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'groups-list';
    try {
        const [groupsRows] = await dbQuery(`
            SELECT g.*, u.first_name || ' ' || u.last_name AS approver_name
            FROM groups g
            LEFT JOIN users u ON g.approver_id = u.id
            ORDER BY g.name ASC
        `).catch(async () => {
            const [r] = await dbQuery(`
                SELECT g.*, CONCAT(u.first_name, ' ', u.last_name) AS approver_name
                FROM groups g
                LEFT JOIN users u ON g.approver_id = u.id
                ORDER BY g.name ASC
            `);
            return [r];
        });

        const groupsWithMembers = await Promise.all(groupsRows.map(async g => {
            const [members] = await dbQuery(`
                SELECT u.id, u.first_name, u.last_name, u.username
                FROM users u
                JOIN group_members gm ON u.id = gm.user_id
                WHERE gm.group_id = ?
                ORDER BY u.first_name ASC
            `, [g.id]);
            return { ...g, members };
        }));

        const [allUsers] = await dbQuery('SELECT id, first_name, last_name, username, role FROM users ORDER BY first_name ASC');
        const approvers = allUsers.filter(u => u.role === 'admin' || u.role === 'accounting' || u.role === 'approver');

        res.render('admin/groups', {
            title: 'Groups Management',
            groups: groupsWithMembers,
            allUsers,
            approvers,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading groups.');
    }
});

app.get('/admin/groups/create', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'groups-add';
    try {
        const [allUsers] = await dbQuery('SELECT id, first_name, last_name, username, role FROM users ORDER BY first_name ASC');
        const approvers = allUsers.filter(u => u.role === 'admin' || u.role === 'accounting' || u.role === 'approver');

        res.render('admin/groups_create', {
            title: 'Create Group',
            approvers,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading groups.');
    }
});

app.post('/admin/groups/add', requireAuth, requireAdmin, async (req, res) => {
    const { name, description, approver_id } = req.body;
    if (!name?.trim()) return res.redirect('/admin/groups/create?error=' + encodeURIComponent('Group name is required.'));
    const approverVal = approver_id ? parseInt(approver_id) : null;
    try {
        await dbQuery('INSERT INTO groups (name, description, approver_id) VALUES (?, ?, ?)', [name.trim(), description?.trim()||null, approverVal]);
        res.redirect('/admin/groups?success=' + encodeURIComponent(`Group "${name.trim()}" created.`));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/groups/create?error=' + encodeURIComponent('Group already exists or failed to create.'));
    }
});

app.post('/admin/groups/delete/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery('DELETE FROM groups WHERE id=?', [req.params.id]);
        res.redirect('/admin/groups?success=' + encodeURIComponent('Group deleted successfully.'));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/groups?error=' + encodeURIComponent('Failed to delete group.'));
    }
});

app.post('/admin/groups/:id/members/add', requireAuth, requireAdmin, async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.redirect('/admin/groups?error=' + encodeURIComponent('Select a user.'));
    try {
        const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
        await dbQuery(`${ign} group_members (group_id, user_id) VALUES (?, ?)`, [req.params.id, user_id]);
        res.redirect('/admin/groups?success=' + encodeURIComponent('Member added.'));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/groups?error=' + encodeURIComponent('Failed to add member.'));
    }
});

app.post('/admin/groups/:id/members/remove/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery('DELETE FROM group_members WHERE group_id=? AND user_id=?', [req.params.id, req.params.userId]);
        res.redirect('/admin/groups?success=' + encodeURIComponent('Member removed.'));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/groups?error=' + encodeURIComponent('Failed to remove member.'));
    }
});

app.post('/admin/groups/:id/approver', requireAuth, requireAdmin, async (req, res) => {
    const { approver_id } = req.body;
    const approverVal = approver_id ? parseInt(approver_id) : null;
    try {
        await dbQuery('UPDATE groups SET approver_id=? WHERE id=?', [approverVal, req.params.id]);
        res.redirect('/admin/groups?success=' + encodeURIComponent('Group approver updated.'));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/groups?error=' + encodeURIComponent('Failed to update approver.'));
    }
});

// ─────────────────────────────────────────────
//  ADMIN — EMPLOYEE SPENDING OVERVIEW
// ─────────────────────────────────────────────
app.get('/admin/spending', requireAuth, requireAdminOrApprover, async (req, res) => {
    res.locals.activePage = 'spending';
    const currentUser = req.session.user;
    try {
        let users;
        if (currentUser.role === 'admin' || currentUser.role === 'accounting') {
            const [uRows] = await dbQuery('SELECT id, first_name, last_name, username, email, role, card_last_digits, spending_limit FROM users ORDER BY first_name ASC');
            users = uRows;
        } else {
            const [uRows] = await dbQuery(`
                SELECT DISTINCT u.id, u.first_name, u.last_name, u.username, u.email, u.role, u.card_last_digits, u.spending_limit
                FROM users u
                JOIN group_members gm ON u.id = gm.user_id
                JOIN groups g ON gm.group_id = g.id
                WHERE g.approver_id = ?
                ORDER BY u.first_name ASC
            `, [currentUser.id]);
            users = uRows;
        }

        const settings = await getSettings();
        const usersWithStats = await Promise.all(users.map(async u => {
            const stats = await getUserSpendingSummary(u.id);
            const [grpRows] = await dbQuery(`
                SELECT g.name, 'member' AS role FROM groups g
                JOIN group_members gm ON g.id = gm.group_id
                WHERE gm.user_id = ?
                UNION
                SELECT g.name, 'approver' AS role FROM groups g
                WHERE g.approver_id = ?
            `, [u.id, u.id]);
            const groups = grpRows.map(r => r.role === 'approver' ? `${r.name} (Approver)` : r.name);
            return { ...u, stats, groups };
        }));

        res.render('admin/spending', {
            title: 'Employee Spending',
            users: usersWithStats,
            settings,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading employee spending.');
    }
});

app.post('/admin/user/:id/update', requireAuth, requireAdmin, async (req, res) => {
    const { role, spending_limit } = req.body;
    const limitVal = spending_limit && parseFloat(spending_limit) > 0 ? parseFloat(spending_limit) : null;
    try {
        await dbQuery('UPDATE users SET role=?, spending_limit=? WHERE id=?', [role, limitVal, req.params.id]);
        res.redirect('/admin/spending?success=' + encodeURIComponent('User updated successfully.'));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/spending?error=' + encodeURIComponent('Failed to update user.'));
    }
});

// ─────────────────────────────────────────────
//  ADMIN — EXPENSE REPORTS PER EMPLOYEE
// ─────────────────────────────────────────────
app.get('/admin/reports', requireAuth, requireAdminOrApprover, async (req, res) => {
    res.locals.activePage = 'reports';
    const currentUser = req.session.user;
    const today = new Date().toISOString().split('T')[0];
    const defaultStart = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const startDate = req.query.start_date || defaultStart;
    const endDate   = req.query.end_date   || today;
    const selectedUserId = req.query.user_id || '';

    try {
        let users;
        if (currentUser.role === 'admin' || currentUser.role === 'accounting') {
            const [uRows] = await dbQuery('SELECT id, first_name, last_name, username FROM users ORDER BY first_name ASC');
            users = uRows;
        } else {
            const [uRows] = await dbQuery(`
                SELECT DISTINCT u.id, u.first_name, u.last_name, u.username
                FROM users u
                JOIN group_members gm ON u.id = gm.user_id
                JOIN groups g ON gm.group_id = g.id
                WHERE g.approver_id = ?
                ORDER BY u.first_name ASC
            `, [currentUser.id]);
            users = uRows;
        }

        let expenses = [];
        let gasExpenses = [];
        let selectedUser = null;
        const pendingJobsMap = {};

        if (selectedUserId) {
            const [uCheck] = await dbQuery('SELECT * FROM users WHERE id=? LIMIT 1', [selectedUserId]);
            if (uCheck.length > 0) {
                selectedUser = uCheck[0];
                const [expRows] = await dbQuery(`
                    SELECT e.*, u_app.first_name || ' ' || u_app.last_name AS approved_by_name
                    FROM expenses e
                    LEFT JOIN users u_app ON e.approved_by = u_app.id
                    WHERE e.user_id=? AND e.date BETWEEN ? AND ?
                    AND e.status NOT IN ('voided')
                    ORDER BY e.date DESC
                `, [selectedUserId, startDate, endDate]).catch(async () => {
                    return await dbQuery(`
                        SELECT e.*, CONCAT(u_app.first_name, ' ', u_app.last_name) AS approved_by_name
                        FROM expenses e
                        LEFT JOIN users u_app ON e.approved_by = u_app.id
                        WHERE e.user_id=? AND e.date BETWEEN ? AND ?
                        AND e.status NOT IN ('voided')
                        ORDER BY e.date DESC
                    `, [selectedUserId, startDate, endDate]);
                });
                expenses = expRows;

                const [gasRows] = await dbQuery(`
                    SELECT ge.*, gc.card_number, gc.card_type 
                    FROM gas_expenses ge 
                    JOIN gas_cards gc ON ge.gas_card_id = gc.id 
                    WHERE ge.user_id=? AND ge.date BETWEEN ? AND ? 
                    ORDER BY ge.date DESC
                `, [selectedUserId, startDate, endDate]);
                gasExpenses = gasRows;

                // Load pending job numbers to support inline approval
                const [pendingJobs] = await dbQuery('SELECT id, job_number FROM job_numbers WHERE pending_confirmation=1');
                pendingJobs.forEach(j => {
                    pendingJobsMap[j.job_number.trim().toUpperCase()] = j.id;
                });
            }
        }

        res.render('admin/reports', {
            title: 'Expense Reports',
            users,
            expenses,
            gasExpenses,
            selectedUser,
            pendingJobsMap,
            startDate,
            endDate,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error loading reports.');
    }
});

//  ADMIN - SUPERVISOR MANAGEMENT
// ─────────────────────────────────────────────
app.post('/admin/supervisors/add', requireAuth, requireAdmin, async (req, res) => {
    const { name, email } = req.body;
    if (!name?.trim()) return res.redirect('/admin/settings/supervisors?error='+encodeURIComponent('Supervisor name is required.'));
    try {
        await dbQuery('INSERT INTO supervisors (name,email) VALUES (?,?)', [name.trim(), email?.trim()||null]);
        await syncSupervisorsToUsers();
        res.redirect('/admin/settings/supervisors?success='+encodeURIComponent(`Supervisor "${name.trim()}" added and user account synced.`));
    } catch (e) { res.redirect('/admin/settings/supervisors?error='+encodeURIComponent('Failed to add supervisor.')); }
});

app.post('/admin/supervisors/remove/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery('DELETE FROM supervisors WHERE id=?', [req.params.id]);
        res.redirect('/admin/settings/supervisors?success='+encodeURIComponent('Supervisor removed.'));
    } catch (e) { res.redirect('/admin/settings/supervisors?error='+encodeURIComponent('Failed to remove.')); }
});

// ─────────────────────────────────────────────
//  ADMIN — JOB NUMBER MANAGEMENT
// ─────────────────────────────────────────────
app.post('/admin/jobnumbers/add', requireAuth, requireAdmin, async (req, res) => {
    const { job_number, description } = req.body;
    if (!job_number?.trim()) return res.redirect('/admin/settings/jobnumbers?error='+encodeURIComponent('Job number is required.'));
    try {
        const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
        await dbQuery(`${ign} job_numbers (job_number,description,active,pending_confirmation) VALUES (?,?,1,0)`, [job_number.trim().toUpperCase(), description?.trim()||null]);
        res.redirect('/admin/settings/jobnumbers?success='+encodeURIComponent(`Job ${job_number.trim().toUpperCase()} added.`));
    } catch (e) { res.redirect('/admin/settings/jobnumbers?error='+encodeURIComponent('Failed to add job number.')); }
});

app.post('/admin/jobnumbers/confirm/:id', requireAuth, requireAdminOrApprover, async (req, res) => {
    try {
        const [jobRows] = await dbQuery('SELECT * FROM job_numbers WHERE id=? LIMIT 1', [req.params.id]);
        if (jobRows.length > 0) {
            const j = jobRows[0];
            await dbQuery('UPDATE job_numbers SET active=1, pending_confirmation=0 WHERE id=?', [req.params.id]);

            // Update any expenses that stored this job number while it was pending
            await dbQuery('UPDATE expenses SET job_number=? WHERE job_number=?', [j.job_number, j.job_number]).catch(() => {});
            await dbQuery('UPDATE gas_expenses SET job_number=? WHERE job_number=?', [j.job_number, j.job_number]).catch(() => {});

            if (j.submitted_by) {
                await dbQuery('INSERT INTO notifications (user_id, message, is_read) VALUES (?, ?, 0)',
                    [j.submitted_by, `Your manually submitted job number **${j.job_number}** has been confirmed and activated.`]);
            }
        }
        const ref = req.get('Referrer') || '/admin/settings/jobnumbers';
        res.redirect(ref + (ref.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent('Job number confirmed and activated.'));
    } catch (e) {
        const ref = req.get('Referrer') || '/admin/settings/jobnumbers';
        res.redirect(ref + (ref.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Failed to confirm job number.'));
    }
});

app.post('/admin/jobnumbers/reject/:id', requireAuth, requireAdminOrApprover, async (req, res) => {
    try {
        const [jobRows] = await dbQuery('SELECT * FROM job_numbers WHERE id=? LIMIT 1', [req.params.id]);
        if (jobRows.length > 0) {
            const j = jobRows[0];
            await dbQuery('DELETE FROM job_numbers WHERE id=?', [req.params.id]);
            
            if (j.submitted_by) {
                await dbQuery('INSERT INTO notifications (user_id, message, is_read) VALUES (?, ?, 0)',
                    [j.submitted_by, `Your manually submitted job number **${j.job_number}** was rejected/denied.`]);
            }
        }
        const ref = req.get('Referrer') || '/admin/settings/jobnumbers';
        res.redirect(ref + (ref.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent('Job number rejected and deleted.'));
    } catch (e) {
        const ref = req.get('Referrer') || '/admin/settings/jobnumbers';
        res.redirect(ref + (ref.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Failed to reject job number.'));
    }
});

app.post('/admin/jobnumbers/remove/:id', requireAuth, requireAdminOrApprover, async (req, res) => {
    try {
        await dbQuery('DELETE FROM job_numbers WHERE id=?', [req.params.id]);
        const ref = req.get('Referrer') || '/admin/settings/jobnumbers';
        res.redirect(ref + (ref.includes('?') ? '&' : '?') + 'success=' + encodeURIComponent('Job number removed.'));
    } catch (e) {
        const ref = req.get('Referrer') || '/admin/settings/jobnumbers';
        res.redirect(ref + (ref.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Failed to remove.'));
    }
});

// ─────────────────────────────────────────────
//  ADMIN — CARD WHITELIST
// ─────────────────────────────────────────────
app.post('/admin/whitelist/add', requireAuth, requireAdmin, async (req, res) => {
    const { card_digits, label, expiry_date } = req.body;
    if (!/^\d{4}$/.test(card_digits)) return res.redirect('/admin/settings/cards?error='+encodeURIComponent('Card digits must be exactly 4 numbers.'));
    try {
        const expDate = expiry_date?.trim() || null;
        const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
        await dbQuery(`${ign} card_whitelist (card_digits,label,expiry_date,status) VALUES (?,?,?, 'active')`, [card_digits, label?.trim()||null, expDate]);
        res.redirect('/admin/settings/cards?success='+encodeURIComponent(`Card ****${card_digits} added to whitelist.`));
    } catch (e) { res.redirect('/admin/settings/cards?error='+encodeURIComponent('Failed to add card.')); }
});

app.post('/admin/whitelist/remove/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery('DELETE FROM card_whitelist WHERE id=?', [req.params.id]);
        res.redirect('/admin/settings/cards?success='+encodeURIComponent('Card removed from whitelist.'));
    } catch (e) { res.redirect('/admin/settings/cards?error='+encodeURIComponent('Failed to remove card.')); }
});

app.post('/admin/whitelist/suspend/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [rows] = await dbQuery('SELECT status FROM card_whitelist WHERE id=?', [req.params.id]);
        if (rows.length > 0) {
            const currentStatus = rows[0].status;
            const newStatus = currentStatus === 'suspended' ? 'active' : 'suspended';
            await dbQuery('UPDATE card_whitelist SET status=? WHERE id=?', [newStatus, req.params.id]);
            res.redirect('/admin/settings/cards?success='+encodeURIComponent(`Card status updated to ${newStatus}.`));
        } else {
            res.redirect('/admin/settings/cards?error='+encodeURIComponent('Card not found.'));
        }
    } catch (e) { res.redirect('/admin/settings/cards?error='+encodeURIComponent('Failed to update card status.')); }
});

// Gas Cards Management
app.post('/admin/gas-cards/add', requireAuth, requireAdmin, async (req, res) => {
    const { card_number, card_type, expiry_date, truck_assigned, user_id } = req.body;
    if (!card_number?.trim() || !card_type?.trim() || !expiry_date?.trim()) {
        return res.redirect('/admin/settings/cards?error=' + encodeURIComponent('Card number, type and expiry date are required.'));
    }
    try {
        const assignedUserId = user_id ? parseInt(user_id) : null;
        const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
        await dbQuery(`${ign} gas_cards (card_number, card_type, expiry_date, truck_assigned, user_id, active) VALUES (?,?,?,?,?,1)`,
            [card_number.trim(), card_type.trim(), expiry_date.trim(), truck_assigned?.trim() || null, assignedUserId]);
        res.redirect('/admin/settings/cards?success=' + encodeURIComponent('Gas card added successfully.'));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/settings/cards?error=' + encodeURIComponent('Failed to add gas card: ' + e.message));
    }
});

app.post('/admin/gas-cards/delete/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery('DELETE FROM gas_cards WHERE id=?', [req.params.id]);
        res.redirect('/admin/settings/cards?success=' + encodeURIComponent('Gas card deleted.'));
    } catch (e) {
        res.redirect('/admin/settings/cards?error=' + encodeURIComponent('Failed to delete gas card.'));
    }
});

app.post('/admin/gas-cards/toggle/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [rows] = await dbQuery('SELECT active FROM gas_cards WHERE id=?', [req.params.id]);
        if (rows.length > 0) {
            const newActive = rows[0].active === 1 ? 0 : 1;
            await dbQuery('UPDATE gas_cards SET active=? WHERE id=?', [newActive, req.params.id]);
            res.redirect('/admin/settings/cards?success=' + encodeURIComponent('Gas card status updated.'));
        } else {
            res.redirect('/admin/settings/cards?error=' + encodeURIComponent('Gas card not found.'));
        }
    } catch (e) {
        res.redirect('/admin/settings/cards?error=' + encodeURIComponent('Failed to update gas card status.'));
    }
});

app.post('/admin/gas-cards/assign/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const assignedUserId = req.body.user_id ? parseInt(req.body.user_id) : null;
        await dbQuery('UPDATE gas_cards SET user_id=? WHERE id=?', [assignedUserId, req.params.id]);
        res.redirect('/admin/settings/cards?success=' + encodeURIComponent('Gas card assignment updated.'));
    } catch (e) {
        res.redirect('/admin/settings/cards?error=' + encodeURIComponent('Failed to assign gas card.'));
    }
});

// Divisions
app.post('/admin/divisions/add', requireAuth, requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.redirect('/admin/settings/categories?error='+encodeURIComponent('Division name is required.'));
    try {
        const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
        await dbQuery(`${ign} divisions (name) VALUES (?)`, [name.trim()]);
        res.redirect('/admin/settings/categories?success='+encodeURIComponent(`Division ${name.trim()} added.`));
    } catch (e) { res.redirect('/admin/settings/categories?error='+encodeURIComponent('Failed to add division.')); }
});

app.post('/admin/divisions/delete/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery('DELETE FROM divisions WHERE id=?', [req.params.id]);
        res.redirect('/admin/settings/categories?success='+encodeURIComponent('Division deleted.'));
    } catch (e) { res.redirect('/admin/settings/categories?error='+encodeURIComponent('Failed to delete division.')); }
});

// Reimbursement Types & WBS Codes
app.post('/admin/reimbursement-types/add', requireAuth, requireAdmin, async (req, res) => {
    const { name, wbs_code } = req.body;
    if (!name?.trim()) return res.redirect('/admin/settings/categories?error='+encodeURIComponent('Name is required.'));
    try {
        const wbs = wbs_code?.trim() || null;
        const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
        await dbQuery(`${ign} reimbursement_types (name, wbs_code) VALUES (?, ?)`, [name.trim(), wbs]);
        res.redirect('/admin/settings/categories?success='+encodeURIComponent(`Reimbursement type ${name.trim()} added.`));
    } catch (e) { res.redirect('/admin/settings/categories?error='+encodeURIComponent('Failed to add reimbursement type.')); }
});

app.post('/admin/reimbursement-types/delete/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbQuery('DELETE FROM reimbursement_types WHERE id=?', [req.params.id]);
        res.redirect('/admin/settings/categories?success='+encodeURIComponent('Reimbursement type deleted.'));
    } catch (e) { res.redirect('/admin/settings/categories?error='+encodeURIComponent('Failed to delete.')); }
});

// CSV Job Numbers Import & Template
app.get('/admin/jobnumbers/template', requireAuth, requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="JobNumbersTemplate.csv"');
    res.status(200).send("job_number,description\nJOB-101,Highway Construction Project\nJOB-102,Office General Overhead");
});

app.post('/admin/jobnumbers/import', requireAuth, requireAdmin, (req, res, next) => {
    upload.single('csv_file')(req, res, err => {
        if (err) return res.redirect('/admin/settings/jobnumbers?error=' + encodeURIComponent(err.message));
        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.redirect('/admin/settings/jobnumbers?error=' + encodeURIComponent('Please upload a CSV file.'));
    }
    try {
        const filePath = req.file.path;
        const csvContent = fs.readFileSync(filePath, 'utf8');
        fs.unlinkSync(filePath); // delete temp file

        const lines = csvContent.split(/\r?\n/);
        let imported = 0;
        let errors = 0;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parts = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || line.split(',');
            if (parts.length >= 1) {
                const job_number = parts[0].replace(/"/g, '').trim().toUpperCase();
                const description = parts[1] ? parts[1].replace(/"/g, '').trim() : null;

                if (job_number) {
                    const ign = dbMode === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
                    await dbQuery(`${ign} job_numbers (job_number, description, active, pending_confirmation) VALUES (?, ?, 1, 0)`, [job_number, description]);
                    imported++;
                } else {
                    errors++;
                }
            }
        }
        res.redirect('/admin/settings/jobnumbers?success=' + encodeURIComponent(`Successfully imported ${imported} job number(s).` + (errors ? ` Failed to import ${errors} row(s).` : '')));
    } catch (e) {
        console.error(e);
        res.redirect('/admin/settings/jobnumbers?error=' + encodeURIComponent('Error parsing CSV file: ' + e.message));
    }
});

// ─────────────────────────────────────────────
//  ANALYTICS PAGE
// ─────────────────────────────────────────────
app.get('/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'analytics';
    try {
        // Per-job totals
        const [perJob] = await dbQuery(`
            SELECT job_number, COUNT(id) AS count, COALESCE(SUM(total_amount),0) AS total
            FROM expenses WHERE job_number IS NOT NULL AND job_number != ''
            GROUP BY job_number ORDER BY total DESC LIMIT 20`);

        // Per-person totals
        let perPersonQuery = '';
        if (dbMode === 'mysql') {
            perPersonQuery = `
                SELECT CONCAT(u.first_name,' ',u.last_name) AS name,
                    COUNT(e.id) AS count, COALESCE(SUM(e.total_amount),0) AS total
                FROM users u LEFT JOIN expenses e ON u.id=e.user_id
                WHERE u.role != 'admin'
                GROUP BY u.id, u.first_name, u.last_name 
                ORDER BY total DESC`;
        } else {
            // Postgres & SQLite
            perPersonQuery = `
                SELECT u.first_name || ' ' || u.last_name AS name,
                    COUNT(e.id) AS count, COALESCE(SUM(e.total_amount),0) AS total
                FROM users u LEFT JOIN expenses e ON u.id=e.user_id
                WHERE u.role != 'admin'
                GROUP BY u.id, u.first_name, u.last_name 
                ORDER BY total DESC`;
        }
        const [perPerson] = await dbQuery(perPersonQuery);

        // Monthly trend (last 6 months)
        let monthlyQuery = '';
        if (dbMode === 'postgres') {
            monthlyQuery = `
                SELECT to_char(date, 'YYYY-MM') AS month, COALESCE(SUM(total_amount),0) AS total
                FROM expenses 
                WHERE date >= CURRENT_DATE - INTERVAL '6 months'
                GROUP BY to_char(date, 'YYYY-MM') 
                ORDER BY month ASC`;
        } else if (dbMode === 'mysql') {
            monthlyQuery = `
                SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total_amount),0) AS total
                FROM expenses 
                WHERE date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
                GROUP BY month 
                ORDER BY month ASC`;
        } else {
            // SQLite
            monthlyQuery = `
                SELECT strftime('%Y-%m', date) AS month, COALESCE(SUM(total_amount),0) AS total
                FROM expenses 
                WHERE date >= date('now','-6 months')
                GROUP BY month 
                ORDER BY month ASC`;
        }
        const [monthly] = await dbQuery(monthlyQuery);

        // Tax type breakdown
        const [byTax] = await dbQuery(`
            SELECT tax_type, COUNT(id) AS count, COALESCE(SUM(total_amount),0) AS total
            FROM expenses GROUP BY tax_type ORDER BY total DESC`);

        // Recent expenses for AI context (last 100)
        let recentQuery = '';
        if (dbMode === 'mysql') {
            recentQuery = `
                SELECT e.*, CONCAT(u.first_name,' ',u.last_name) AS employee_name
                FROM expenses e JOIN users u ON e.user_id=u.id
                ORDER BY e.date DESC LIMIT 100`;
        } else {
            recentQuery = `
                SELECT e.*, u.first_name || ' ' || u.last_name AS employee_name
                FROM expenses e JOIN users u ON e.user_id=u.id
                ORDER BY e.date DESC LIMIT 100`;
        }
        const [recent] = await dbQuery(recentQuery);

        res.render('analytics', {
            title: 'Analytics',
            perJob, perPerson, monthly, byTax, recent,
            hasAiKey: !!process.env.GEMINI_API_KEY,
            error: req.query.error || null
        });
    } catch (e) { console.error(e); res.status(500).send('Analytics error: ' + e.message); }
});

// AI Analysis endpoint
app.post('/admin/ai-analysis', requireAuth, requireAdmin, async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ error: 'No GEMINI_API_KEY set in .env — add it to enable AI analysis.' });

    try {
        // Build data summary for context
        const [expenses] = await dbQuery(`
            SELECT e.date, e.store_name, e.job_number, e.supervisor, e.total_amount, e.tax_type, e.status,
                u.first_name || ' ' || u.last_name AS employee
            FROM expenses e JOIN users u ON e.user_id=u.id
            ORDER BY e.date DESC LIMIT 200`).catch(async () => {
            const [r] = await dbQuery(`
                SELECT e.date, e.store_name, e.job_number, e.supervisor, e.total_amount, e.tax_type, e.status,
                    CONCAT(u.first_name,' ',u.last_name) AS employee
                FROM expenses e JOIN users u ON e.user_id=u.id
                ORDER BY e.date DESC LIMIT 200`);
            return [r];
        });

        const summary = expenses.map(e =>
            `${e.date} | ${e.employee} | Job: ${e.job_number||'N/A'} | Store: ${e.store_name} | $${parseFloat(e.total_amount).toFixed(2)} | ${e.tax_type} | ${e.status}`
        ).join('\n');

        const prompt = `You are an expense analysis AI for Sargtech, a field services company. Analyze the following expense records and provide:

1. **Per-Job Analysis**: What is being purchased for each job number? Any concerns?
2. **Per-Employee Trends**: Spending patterns per person. Anyone unusually high or low?
3. **Purchase Category Trends**: Common store types, what supplies are being bought?
4. **Anomalies / Red Flags**: Any suspicious patterns, duplicate dates, unusually large amounts?
5. **Recommendations**: Actionable suggestions for management.

Be concise, specific, and use $ values. Format with clear headers.

EXPENSE DATA (most recent 200 records):
${summary}`;

        const requestBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1500 }
        });

        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
            };
            const request = https.request(options, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Invalid JSON from Gemini')); }
                });
            });
            request.on('error', reject);
            request.write(requestBody);
            request.end();
        });

        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return res.json({ error: 'No response from Gemini. Check your API key.' });
        res.json({ analysis: text });
    } catch (e) {
        console.error('AI analysis error:', e);
        res.json({ error: 'AI analysis failed: ' + e.message });
    }
});

// ─────────────────────────────────────────────
//  EXPORTS — PDF
// ─────────────────────────────────────────────
app.get('/admin/export/pdf/:userId', requireAuth, requireAdmin, async (req, res) => {
    const startDate = req.query.start_date || '';
    const endDate   = req.query.end_date   || '';
    const reportType = req.query.type || 'all'; // 'reimbursements', 'cards', 'gas', or 'all'
    try {
        const [uRows] = await dbQuery('SELECT * FROM users WHERE id=? LIMIT 1', [req.params.userId]);
        if (!uRows.length) return res.status(404).send('User not found');
        const u = uRows[0];
        
        const [expenses] = await dbQuery(`
            SELECT e.*, u_app.first_name || ' ' || u_app.last_name AS approved_by_name
            FROM expenses e
            LEFT JOIN users u_app ON e.approved_by = u_app.id
            WHERE e.user_id=? AND e.date BETWEEN ? AND ? AND e.status NOT IN ('voided')
            ORDER BY e.payment_type ASC, e.job_number ASC, e.date ASC
        `, [u.id, startDate, endDate]).catch(async () => {
            return await dbQuery(`
                SELECT e.*, CONCAT(u_app.first_name, ' ', u_app.last_name) AS approved_by_name
                FROM expenses e
                LEFT JOIN users u_app ON e.approved_by = u_app.id
                WHERE e.user_id=? AND e.date BETWEEN ? AND ? AND e.status NOT IN ('voided')
                ORDER BY e.payment_type ASC, e.job_number ASC, e.date ASC
            `, [u.id, startDate, endDate]);
        });
        const [gasExpenses] = await dbQuery(`
            SELECT ge.*, gc.card_number, gc.card_type 
            FROM gas_expenses ge 
            JOIN gas_cards gc ON ge.gas_card_id = gc.id 
            WHERE ge.user_id=? AND ge.date BETWEEN ? AND ? 
            ORDER BY ge.job_number ASC, ge.date ASC
        `, [u.id, startDate, endDate]);

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        
        let filenameSuffix = reportType;
        if (reportType === 'all') filenameSuffix = 'All_Expenses';
        res.setHeader('Content-Disposition', `attachment; filename="Expenses_${u.last_name}_${startDate}_${endDate}_${filenameSuffix}.pdf"`);
        doc.pipe(res);

        doc.rect(0, 0, 595, 60).fill('#0073EA');
        doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold').text('Sargtech Expenses Report', 50, 18);
        doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toLocaleDateString('en-CA')}`, 400, 25, { align: 'right' });
        doc.moveDown(3);
        doc.fillColor('#323338').fontSize(13).font('Helvetica-Bold').text('Employee Details', 50);
        doc.moveDown(0.5);
        doc.fontSize(10).font('Helvetica').fillColor('#676879');
        doc.text(`Name: ${u.first_name} ${u.last_name}     Email: ${u.email}     Card Ref: ${u.card_last_digits}`);
        doc.text(`Cycle: ${startDate}  to  ${endDate}`);
        doc.moveDown(1.5);

        const reimbursements = expenses.filter(e => e.payment_type !== 'Company Card');
        const companyCards = expenses.filter(e => e.payment_type === 'Company Card');

        const cols = [50, 115, 210, 285, 340, 410, 480];

        // --- SECTION 1: REIMBURSEMENTS ---
        if (reportType === 'all' || reportType === 'reimbursements') {
            doc.fillColor('#0073EA').fontSize(13).font('Helvetica-Bold').text('Employee Reimbursement Claims', 50);
            doc.moveDown(0.8);

            if (reimbursements.length === 0) {
                doc.fillColor('#676879').fontSize(10).font('Helvetica-Oblique').text('No reimbursement claims during this cycle.', 50);
                doc.moveDown(1.5);
            } else {
                const byJob = {};
                reimbursements.forEach(e => {
                    const k = e.job_number || 'No Job #';
                    if (!byJob[k]) byJob[k] = [];
                    byJob[k].push(e);
                });

                let sectionTotal = 0;
                for (const [jobKey, jobExpenses] of Object.entries(byJob)) {
                    const rBarY1 = doc.y;
                    doc.fillColor('#0073EA').fontSize(9).font('Helvetica-Bold').text(`Job: ${jobKey}`, 57, rBarY1 + 4, { lineBreak: false });
                    doc.y = rBarY1 + 16;

                    doc.rect(50, doc.y, 495, 18).fill('#F6F8FA');
                    const ty = doc.y + 4;
                    doc.fillColor('#676879').fontSize(7.5).font('Helvetica-Bold');
                    ['Date','Store','Txn ID','Supervisor','Tax','Net $','Total $'].forEach((h, i) => doc.text(h, cols[i], ty));
                    doc.moveDown(1.5);

                    let jobTotal = 0;
                    jobExpenses.forEach((e, idx) => {
                        const rowY = doc.y;
                        const hasApproval = e.status === 'approved' && e.approved_at;
                        const rowHeight = hasApproval ? 23 : 16;
                        if (idx % 2 === 0) doc.rect(50, rowY - 2, 495, rowHeight).fill('#FAFBFB');
                        const d = typeof e.date === 'string' ? e.date.split('T')[0] : '';
                        doc.fillColor('#323338').fontSize(7.5).font('Helvetica');
                        doc.text(d, cols[0], rowY, { width: 60 });
                        doc.text(e.store_name, cols[1], rowY, { width: 90 });
                        if (hasApproval) {
                            const appBy = e.approved_by_name ? `by ${e.approved_by_name}` : '';
                            const appAt = typeof e.approved_at === 'string' ? e.approved_at.split('T')[0] : '';
                            doc.fillColor('#0073EA').fontSize(6).font('Helvetica-Oblique');
                            doc.text(`Approved ${appBy} on ${appAt}`, cols[1], rowY + 9, { width: 90 });
                        }
                        doc.fillColor('#323338').fontSize(7.5).font('Helvetica');
                        doc.text(e.transaction_id, cols[2], rowY, { width: 70 });
                        doc.text(e.supervisor || '-', cols[3], rowY, { width: 65 });
                        doc.text(e.tax_type, cols[4], rowY, { width: 55 });
                        doc.text(`$${parseFloat(e.net_amount).toFixed(2)}`, cols[5], rowY, { width: 60 });
                        doc.text(`$${parseFloat(e.total_amount).toFixed(2)}`, cols[6], rowY, { width: 60 });
                        if (hasApproval) {
                            doc.moveDown(1.4);
                        } else {
                            doc.moveDown(1);
                        }
                        jobTotal += parseFloat(e.total_amount);
                    });

                    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#323338');
                    doc.text(`Job Subtotal: $${jobTotal.toFixed(2)}`, 380, doc.y, { align: 'right', width: 165 });
                    doc.moveDown(1.5);
                    sectionTotal += jobTotal;
                }
                doc.fillColor('#0073EA').fontSize(11).font('Helvetica-Bold').text(`Total Reimbursable: $${sectionTotal.toFixed(2)}`, 300, doc.y, { align: 'right', width: 245 });
                doc.moveDown(2);
            }
        }

        // --- SECTION 2: COMPANY CARD ---
        if (reportType === 'all' || reportType === 'cards') {
            doc.fillColor('#323338').fontSize(13).font('Helvetica-Bold').text('Company Credit Card Expenses', 50);
            doc.moveDown(0.8);

            if (companyCards.length === 0) {
                doc.fillColor('#676879').fontSize(10).font('Helvetica-Oblique').text('No company credit card expenses during this cycle.', 50);
                doc.moveDown(1.5);
            } else {
                const byJob = {};
                companyCards.forEach(e => {
                    const k = e.job_number || 'No Job #';
                    if (!byJob[k]) byJob[k] = [];
                    byJob[k].push(e);
                });

                let sectionTotal = 0;
                for (const [jobKey, jobExpenses] of Object.entries(byJob)) {
                    const rBarY2 = doc.y;
                    doc.fillColor('#323338').fontSize(9).font('Helvetica-Bold').text(`Job: ${jobKey}`, 57, rBarY2 + 4, { lineBreak: false });
                    doc.y = rBarY2 + 16;

                    doc.rect(50, doc.y, 495, 18).fill('#F6F8FA');
                    const ty = doc.y + 4;
                    doc.fillColor('#676879').fontSize(7.5).font('Helvetica-Bold');
                    ['Date','Store','Txn ID','Supervisor','Tax','Net $','Total $'].forEach((h, i) => doc.text(h, cols[i], ty));
                    doc.moveDown(1.5);

                    let jobTotal = 0;
                    jobExpenses.forEach((e, idx) => {
                        const rowY = doc.y;
                        const hasApproval = e.status === 'approved' && e.approved_at;
                        const rowHeight = hasApproval ? 23 : 16;
                        if (idx % 2 === 0) doc.rect(50, rowY - 2, 495, rowHeight).fill('#FAFBFB');
                        const d = typeof e.date === 'string' ? e.date.split('T')[0] : '';
                        doc.fillColor('#323338').fontSize(7.5).font('Helvetica');
                        doc.text(d, cols[0], rowY, { width: 60 });
                        doc.text(e.store_name, cols[1], rowY, { width: 90 });
                        if (hasApproval) {
                            const appBy = e.approved_by_name ? `by ${e.approved_by_name}` : '';
                            const appAt = typeof e.approved_at === 'string' ? e.approved_at.split('T')[0] : '';
                            doc.fillColor('#0073EA').fontSize(6).font('Helvetica-Oblique');
                            doc.text(`Approved ${appBy} on ${appAt}`, cols[1], rowY + 9, { width: 90 });
                        }
                        doc.fillColor('#323338').fontSize(7.5).font('Helvetica');
                        doc.text(e.transaction_id, cols[2], rowY, { width: 70 });
                        doc.text(e.supervisor || '-', cols[3], rowY, { width: 65 });
                        doc.text(e.tax_type, cols[4], rowY, { width: 55 });
                        doc.text(`$${parseFloat(e.net_amount).toFixed(2)}`, cols[5], rowY, { width: 60 });
                        doc.text(`$${parseFloat(e.total_amount).toFixed(2)}`, cols[6], rowY, { width: 60 });
                        if (hasApproval) {
                            doc.moveDown(1.4);
                        } else {
                            doc.moveDown(1);
                        }
                        jobTotal += parseFloat(e.total_amount);
                    });

                    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#323338');
                    doc.text(`Job Subtotal: $${jobTotal.toFixed(2)}`, 380, doc.y, { align: 'right', width: 165 });
                    doc.moveDown(1.5);
                    sectionTotal += jobTotal;
                }
                doc.fillColor('#323338').fontSize(11).font('Helvetica-Bold').text(`Total Company Card Cost: $${sectionTotal.toFixed(2)}`, 300, doc.y, { align: 'right', width: 245 });
                doc.moveDown(2);
            }
        }

        // --- SECTION 3: GAS EXPENSES ---
        if (reportType === 'all' || reportType === 'gas') {
            doc.fillColor('#E67E22').fontSize(13).font('Helvetica-Bold').text('Gas Card Expenses', 50);
            doc.moveDown(0.8);

            if (gasExpenses.length === 0) {
                doc.fillColor('#676879').fontSize(10).font('Helvetica-Oblique').text('No gas card expenses during this cycle.', 50);
                doc.moveDown(1.5);
            } else {
                const byJob = {};
                gasExpenses.forEach(e => {
                    const k = e.job_number || 'No Job #';
                    if (!byJob[k]) byJob[k] = [];
                    byJob[k].push(e);
                });

                // Gas-specific column positions: Date | Store | Card # | Liters | Tax | Net $ | Total $
                const gCols = [50, 118, 218, 290, 348, 396, 466];
                let sectionTotal = 0;
                for (const [jobKey, jobExpenses] of Object.entries(byJob)) {
                    const gBarY = doc.y;
                    doc.fillColor('#E67E22').fontSize(9).font('Helvetica-Bold').text(`Job: ${jobKey}`, 57, gBarY + 4, { lineBreak: false });
                    doc.y = gBarY + 16;

                    const hBarY = doc.y;
                    doc.rect(50, hBarY, 495, 16).fill('#F0EDE8');
                    doc.fillColor('#676879').fontSize(7.5).font('Helvetica-Bold');
                    const gHeaders = ['Date','Store / Vendor','Card #','Liters','Tax','Net ($)','Total ($)'];
                    const gWidths  = [63,   95,             65,     50,     43,   64,       75];
                    gHeaders.forEach((h, i) => doc.text(h, gCols[i], hBarY + 4, { width: gWidths[i], lineBreak: false }));
                    doc.y = hBarY + 20;

                    let jobTotal = 0;
                    jobExpenses.forEach((e, idx) => {
                        const rowY = doc.y;
                        if (idx % 2 === 0) doc.rect(50, rowY - 1, 495, 15).fill('#FAFBFB');
                        const d = typeof e.date === 'string' ? e.date.split('T')[0] : '';
                        doc.fillColor('#323338').fontSize(7.5).font('Helvetica');
                        doc.text(d,                                               gCols[0], rowY, { width: gWidths[0], lineBreak: false });
                        doc.text(e.store_name,                                    gCols[1], rowY, { width: gWidths[1], lineBreak: false });
                        doc.text(e.card_number ? `****${e.card_number.slice(-4)}` : '-', gCols[2], rowY, { width: gWidths[2], lineBreak: false });
                        doc.text(e.liters_in_tank ? `${parseFloat(e.liters_in_tank).toFixed(1)}L` : '-', gCols[3], rowY, { width: gWidths[3], lineBreak: false });
                        doc.text(e.tax_type || 'GST',                             gCols[4], rowY, { width: gWidths[4], lineBreak: false });
                        doc.text(`$${parseFloat(e.net_amount).toFixed(2)}`,       gCols[5], rowY, { width: gWidths[5], lineBreak: false });
                        doc.font('Helvetica-Bold').text(`$${parseFloat(e.total_amount).toFixed(2)}`, gCols[6], rowY, { width: gWidths[6], lineBreak: false });
                        doc.font('Helvetica');
                        doc.y = rowY + 14;
                        jobTotal += parseFloat(e.total_amount);
                    });

                    doc.moveDown(0.3);
                    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#323338');
                    doc.text(`Job Subtotal: $${jobTotal.toFixed(2)}`, 350, doc.y, { align: 'right', width: 195 });
                    doc.moveDown(1.2);
                    sectionTotal += jobTotal;
                }
                doc.fillColor('#E67E22').fontSize(11).font('Helvetica-Bold').text(`Total Gas Card Cost: $${sectionTotal.toFixed(2)}`, 300, doc.y, { align: 'right', width: 245 });
            }
        }

        doc.end();
    } catch (e) { console.error(e); res.status(500).send('PDF error.'); }
});

// ─────────────────────────────────────────────
//  EXPORTS — EXCEL
// ─────────────────────────────────────────────
app.get('/admin/export/excel/:userId', requireAuth, requireAdmin, async (req, res) => {
    const startDate = req.query.start_date || '';
    const endDate   = req.query.end_date   || '';
    const reportType = req.query.type || 'all'; // 'reimbursements', 'cards', 'gas', or 'all'
    try {
        const [uRows] = await dbQuery('SELECT * FROM users WHERE id=? LIMIT 1', [req.params.userId]);
        if (!uRows.length) return res.status(404).send('User not found');
        const u = uRows[0];
        
        const [expenses] = await dbQuery(`
            SELECT e.*, u_app.first_name || ' ' || u_app.last_name AS approved_by_name
            FROM expenses e
            LEFT JOIN users u_app ON e.approved_by = u_app.id
            WHERE e.user_id=? AND e.date BETWEEN ? AND ? AND e.status NOT IN ('voided')
            ORDER BY e.payment_type ASC, e.date ASC
        `, [u.id, startDate, endDate]).catch(async () => {
            return await dbQuery(`
                SELECT e.*, CONCAT(u_app.first_name, ' ', u_app.last_name) AS approved_by_name
                FROM expenses e
                LEFT JOIN users u_app ON e.approved_by = u_app.id
                WHERE e.user_id=? AND e.date BETWEEN ? AND ? AND e.status NOT IN ('voided')
                ORDER BY e.payment_type ASC, e.date ASC
            `, [u.id, startDate, endDate]);
        });
        const [gasExpenses] = await dbQuery(`
            SELECT ge.*, gc.card_number, gc.card_type 
            FROM gas_expenses ge 
            JOIN gas_cards gc ON ge.gas_card_id = gc.id 
            WHERE ge.user_id=? AND ge.date BETWEEN ? AND ? 
            ORDER BY ge.date ASC
        `, [u.id, startDate, endDate]);

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Sargtech Expenses';

        const reimbursements = expenses.filter(e => e.payment_type !== 'Company Card');
        const companyCards = expenses.filter(e => e.payment_type === 'Company Card');

        function addExpenseSheet(sheetName, list, titleText, headerBgColor) {
            const ws = wb.addWorksheet(sheetName);
            ws.mergeCells('A1:M1');
            ws.getCell('A1').value = titleText;
            ws.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
            ws.getCell('A1').fill = { type:'pattern', pattern:'solid', fgColor:{ argb: headerBgColor } };
            ws.getCell('A1').alignment = { vertical:'middle', horizontal:'center' };
            ws.getRow(1).height = 28;
            ws.addRow([]);

            ws.columns = [
                { key:'date', width:14 }, { key:'store_name', width:24 }, { key:'description', width:30 }, { key:'transaction_id', width:20 },
                { key:'job_number', width:14 }, { key:'supervisor', width:20 }, { key:'tax_type', width:12 },
                { key:'net_amount', width:16 }, { key:'tax_amount', width:16 }, { key:'total_amount', width:16 }, { key:'status', width:12 },
                { key:'approved_at', width:20 }, { key:'approved_by_name', width:24 }
            ];
            
            const hRow = ws.addRow(['Date','Store','Description','Transaction ID','Job #','Supervisor','Tax Type','Net ($)','Tax ($)','Total ($)','Status','Approved At','Approved By']);
            hRow.eachCell(cell => {
                cell.font = { bold:true, color:{ argb:'FFFFFFFF' } };
                cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF323338' } };
                cell.alignment = { vertical:'middle', horizontal:'center' };
            });
            hRow.height = 20;

            let totNet = 0, totTax = 0, totTotal = 0;
            list.forEach((e, idx) => {
                const d = typeof e.date === 'string' ? e.date.split('T')[0] : '';
                const net = parseFloat(e.net_amount), tax = parseFloat(e.tax_amount), total = parseFloat(e.total_amount);
                const appAtStr = e.approved_at ? new Date(e.approved_at).toISOString().replace('T', ' ').substring(0, 19) : '';
                const row = ws.addRow({ 
                    date:d, store_name:e.store_name, description:e.description||'', transaction_id:e.transaction_id, 
                    job_number:e.job_number||'N/A', supervisor:e.supervisor||'N/A', tax_type:e.tax_type, 
                    net_amount:net, tax_amount:tax, total_amount:total, status:e.status,
                    approved_at:appAtStr, approved_by_name:e.approved_by_name||''
                });
                if (idx % 2 === 0) row.eachCell(cell => { cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFAFBFB' } }; });
                totNet += net; totTax += tax; totTotal += total;
            });
            
            ws.addRow([]);
            const sumRow = ws.addRow(['','','','','','TOTALS','',totNet,totTax,totTotal,'','','']);
            sumRow.eachCell((cell, col) => {
                cell.font = { bold:true };
                if (col >= 8 && col <= 10) { cell.numFmt = '"$"#,##0.00'; cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE5F3FF' } }; }
                if (col === 6) cell.font = { bold:true, color:{ argb:headerBgColor } };
            });
        }

        function addGasSheet(sheetName, list, titleText, headerBgColor) {
            const ws = wb.addWorksheet(sheetName);
            ws.mergeCells('A1:J1');
            ws.getCell('A1').value = titleText;
            ws.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
            ws.getCell('A1').fill = { type:'pattern', pattern:'solid', fgColor:{ argb: headerBgColor } };
            ws.getCell('A1').alignment = { vertical:'middle', horizontal:'center' };
            ws.getRow(1).height = 28;
            ws.addRow([]);

            ws.columns = [
                { key:'date', width:14 }, { key:'store_name', width:24 }, { key:'description', width:30 }, { key:'transaction_id', width:20 },
                { key:'job_number', width:14 }, { key:'card_number', width:16 }, { key:'liters', width:12 },
                { key:'net_amount', width:16 }, { key:'tax_amount', width:16 }, { key:'total_amount', width:16 }
            ];
            
            const hRow = ws.addRow(['Date','Store','Description','Transaction ID','Job #','Card Number','Liters','Net ($)','Tax ($)','Total ($)']);
            hRow.eachCell(cell => {
                cell.font = { bold:true, color:{ argb:'FFFFFFFF' } };
                cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF323338' } };
                cell.alignment = { vertical:'middle', horizontal:'center' };
            });
            hRow.height = 20;

            let totNet = 0, totTax = 0, totTotal = 0;
            list.forEach((e, idx) => {
                const d = typeof e.date === 'string' ? e.date.split('T')[0] : '';
                const net = parseFloat(e.net_amount), tax = parseFloat(e.tax_amount), total = parseFloat(e.total_amount);
                const card = e.card_number ? `****${e.card_number.slice(-4)}` : 'N/A';
                const row = ws.addRow({ date:d, store_name:e.store_name, description:e.description||'', transaction_id:e.transaction_id, job_number:e.job_number||'N/A', card_number:card, liters:e.liters_in_tank || 0, net_amount:net, tax_amount:tax, total_amount:total });
                if (idx % 2 === 0) row.eachCell(cell => { cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFAFBFB' } }; });
                totNet += net; totTax += tax; totTotal += total;
            });
            
            ws.addRow([]);
            const sumRow = ws.addRow(['','','','','','TOTALS','',totNet,totTax,totTotal]);
            sumRow.eachCell((cell, col) => {
                cell.font = { bold:true };
                if (col >= 8 && col <= 10) { cell.numFmt = '"$"#,##0.00'; cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE5F3FF' } }; }
                if (col === 6) cell.font = { bold:true, color:{ argb:headerBgColor } };
            });
        }

        if (reportType === 'all' || reportType === 'reimbursements') {
            addExpenseSheet('Reimbursements', reimbursements, `Employee Reimbursements — ${u.first_name} ${u.last_name} (${startDate} to ${endDate})`, 'FF0073EA');
        }
        if (reportType === 'all' || reportType === 'cards') {
            addExpenseSheet('Company Card Cost', companyCards, `Company Credit Card Expenses — ${u.first_name} ${u.last_name} (${startDate} to ${endDate})`, 'FF323338');
        }
        if (reportType === 'all' || reportType === 'gas') {
            addGasSheet('Gas Cost', gasExpenses, `Gas Card Expenses — ${u.first_name} ${u.last_name} (${startDate} to ${endDate})`, 'FFE67E22');
        }

        // ── Sheet 3: Per-Job Summary
        const wsSummary = wb.addWorksheet('Per Job Summary');
        wsSummary.columns = [
            { key:'job', width:22 }, 
            { key:'reimb_count', width:16 }, { key:'reimb_total', width:20 }, 
            { key:'card_count', width:16 }, { key:'card_total', width:20 },
            { key:'gas_count', width:16 }, { key:'gas_total', width:20 }
        ];
        
        const hTitle = wsSummary.addRow(['Job Number','Reimbursements Count','Reimbursement Total ($)','Company Card Count','Company Card Total ($)','Gas Count','Gas Total ($)']);
        hTitle.eachCell(cell => {
            cell.font = { bold:true, color:{ argb:'FFFFFFFF' } };
            cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF0073EA' } };
            cell.alignment = { vertical:'middle', horizontal:'center' };
        });
        hTitle.height = 22;

        const byJob = {};
        
        if (reportType === 'all' || reportType === 'reimbursements') {
            reimbursements.forEach(e => {
                const k = e.job_number || 'No Job #';
                if (!byJob[k]) byJob[k] = { reimbCount: 0, reimbTotal: 0, cardCount: 0, cardTotal: 0, gasCount: 0, gasTotal: 0 };
                byJob[k].reimbCount++;
                byJob[k].reimbTotal += parseFloat(e.total_amount || 0);
            });
        }
        if (reportType === 'all' || reportType === 'cards') {
            companyCards.forEach(e => {
                const k = e.job_number || 'No Job #';
                if (!byJob[k]) byJob[k] = { reimbCount: 0, reimbTotal: 0, cardCount: 0, cardTotal: 0, gasCount: 0, gasTotal: 0 };
                byJob[k].cardCount++;
                byJob[k].cardTotal += parseFloat(e.total_amount || 0);
            });
        }
        if (reportType === 'all' || reportType === 'gas') {
            gasExpenses.forEach(e => {
                const k = e.job_number || 'No Job #';
                if (!byJob[k]) byJob[k] = { reimbCount: 0, reimbTotal: 0, cardCount: 0, cardTotal: 0, gasCount: 0, gasTotal: 0 };
                byJob[k].gasCount++;
                byJob[k].gasTotal += parseFloat(e.total_amount || 0);
            });
        }

        Object.entries(byJob).forEach(([job, d]) => {
            const row = wsSummary.addRow({ 
                job, 
                reimb_count: d.reimbCount, reimb_total: d.reimbTotal,
                card_count: d.cardCount, card_total: d.cardTotal,
                gas_count: d.gasCount, gas_total: d.gasTotal
            });
            row.getCell(3).numFmt = '"$"#,##0.00';
            row.getCell(5).numFmt = '"$"#,##0.00';
            row.getCell(7).numFmt = '"$"#,##0.00';
        });

        let filenameSuffix = reportType;
        if (reportType === 'all') filenameSuffix = 'All_Expenses';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Expenses_${u.last_name}_${startDate}_${endDate}_${filenameSuffix}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { console.error(e); res.status(500).send('Excel error.'); }
});

app.get('/admin/export/csv/:userId', requireAuth, requireAdminOrApprover, async (req, res) => {
    const startDate = req.query.start_date || '';
    const endDate   = req.query.end_date   || '';
    const paymentType = req.query.payment_type || 'both'; // 'reimbursement', 'card', or 'both'
    const columnsParam = req.query.columns || 'date,store_name,description,job_number,supervisor,tax_type,net_amount,tax_amount,fees_total,total_amount,status';
    
    const activeColumns = columnsParam.split(',').map(s => s.trim()).filter(Boolean);

    try {
        const [uRows] = await dbQuery('SELECT * FROM users WHERE id=? LIMIT 1', [req.params.userId]);
        if (!uRows.length) return res.status(404).send('User not found');
        const u = uRows[0];

        let query = `SELECT * FROM expenses WHERE user_id=? AND date BETWEEN ? AND ? AND status NOT IN ('voided')`;
        const params = [u.id, startDate, endDate];

        if (paymentType === 'reimbursement') {
            query += ` AND payment_type != 'Company Card'`;
        } else if (paymentType === 'card') {
            query += ` AND payment_type = 'Company Card'`;
        }
        query += ` ORDER BY date ASC`;

        const [expenses] = await dbQuery(query, params);

        // Fetch users to map approved_by IDs to names
        const [usersList] = await dbQuery('SELECT id, first_name, last_name FROM users');
        const userMap = {};
        usersList.forEach(userItem => {
            userMap[userItem.id] = `${userItem.first_name} ${userItem.last_name}`;
        });

        // Define headers maps
        const columnHeaders = {
            date: 'Date',
            store_name: 'Store/Merchant',
            transaction_id: 'Transaction ID',
            job_number: 'Job Number',
            supervisor: 'Supervisor',
            description: 'Description',
            status: 'Status',
            payment_type: 'Payment Method',
            net_amount: 'Net Amount ($)',
            tax_type: 'Tax Type',
            tax_amount: 'Tax Amount ($)',
            fees_breakdown: 'Extra Fees Breakdown',
            fees_total: 'Extra Fees Total ($)',
            total_amount: 'Total Cost ($)',
            submitted_at: 'Submitted At',
            approved_at: 'Approved At',
            approved_by: 'Approved By',
            voided_at: 'Voided At',
            void_reason: 'Void Reason'
        };

        // Build CSV Content
        const csvRows = [];
        
        // Header Row
        const headers = activeColumns.map(col => columnHeaders[col] || col);
        csvRows.push(headers.map(h => `"${h.replace(/"/g, '""')}"`).join(','));

        // Data Rows
        expenses.forEach(e => {
            // Parse fees if present
            let feesBreakdownStr = '';
            let feesTotal = 0;
            if (e.fees_json) {
                try {
                    const fees = JSON.parse(e.fees_json);
                    if (Array.isArray(fees) && fees.length > 0) {
                        feesBreakdownStr = fees.map(f => `${f.name}: $${parseFloat(f.amount).toFixed(2)}`).join('; ');
                        feesTotal = fees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);
                    }
                } catch(err) {}
            }

            const row = activeColumns.map(col => {
                let val = '';
                if (col === 'date') val = e.date ? e.date.split('T')[0] : '';
                else if (col === 'store_name') val = e.store_name || '';
                else if (col === 'transaction_id') val = e.transaction_id || '';
                else if (col === 'job_number') val = e.job_number || '';
                else if (col === 'supervisor') val = e.supervisor || '';
                else if (col === 'description') val = e.description || '';
                else if (col === 'status') val = e.status || '';
                else if (col === 'payment_type') val = e.payment_type || '';
                else if (col === 'net_amount') val = parseFloat(e.net_amount || 0).toFixed(2);
                else if (col === 'tax_type') val = e.tax_type || '';
                else if (col === 'tax_amount') val = parseFloat(e.tax_amount || 0).toFixed(2);
                else if (col === 'fees_breakdown') val = feesBreakdownStr;
                else if (col === 'fees_total') val = feesTotal.toFixed(2);
                else if (col === 'total_amount') val = parseFloat(e.total_amount || 0).toFixed(2);
                else if (col === 'submitted_at') val = e.submitted_at ? new Date(e.submitted_at).toISOString().split('T')[0] : '';
                else if (col === 'approved_at') val = e.approved_at ? new Date(e.approved_at).toISOString().split('T')[0] : '';
                else if (col === 'approved_by') val = e.approved_by ? (userMap[e.approved_by] || `User #${e.approved_by}`) : '';
                else if (col === 'voided_at') val = e.voided_at ? new Date(e.voided_at).toISOString().split('T')[0] : '';
                else if (col === 'void_reason') val = e.void_reason || '';
                
                return `"${String(val).replace(/"/g, '""')}"`;
            });
            csvRows.push(row.join(','));
        });

        const csvContent = csvRows.join('\r\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="Export_${paymentType}_${u.last_name}_${startDate}_${endDate}.csv"`);
        res.status(200).send(csvContent);
    } catch(err) {
        console.error(err);
        res.status(500).send('CSV export error: ' + err.message);
    }
});

// ─────────────────────────────────────────────
//  USER & PROFILE MANAGEMENT ROUTES
// ─────────────────────────────────────────────

app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'users-list';
    try {
        const [users] = await dbQuery(`
            SELECT u.*, d.name AS division_name 
            FROM users u 
            LEFT JOIN divisions d ON u.division_id = d.id 
            ORDER BY u.first_name, u.last_name
        `);
        const [divisions] = await dbQuery('SELECT * FROM divisions ORDER BY name ASC').catch(() => [[]]);
        res.render('admin/users', {
            title: 'Users Management',
            user: req.session.user,
            users: users || [],
            divisions: divisions || [],
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        res.status(500).send('Database error: ' + e.message);
    }
});

app.get('/admin/users/add', requireAuth, requireAdmin, async (req, res) => {
    res.locals.activePage = 'users-add';
    try {
        const [divisions] = await dbQuery('SELECT * FROM divisions ORDER BY name ASC').catch(() => [[]]);
        res.render('admin/users_add', {
            title: 'Add New User',
            divisions: divisions || [],
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (e) {
        res.status(500).send('Database error: ' + e.message);
    }
});

app.post('/admin/users/add', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { first_name, last_name, username, email, password, card_last_digits, role, spending_limit, reimbursement_cap, division_id } = req.body;
        if (!first_name || !last_name || !username || !email || !password || !role) {
            return res.redirect('/admin/users/add?error=' + encodeURIComponent('Please fill all required fields.'));
        }
        
        const [existing] = await dbQuery("SELECT id FROM users WHERE username=? OR email=? LIMIT 1", [username.trim(), email.trim()]);
        if (existing && existing.length > 0) {
            return res.redirect('/admin/users/add?error=' + encodeURIComponent('Username or email already exists.'));
        }

        const hash = await bcrypt.hash(password, 10);
        const limitVal = spending_limit ? parseFloat(spending_limit) : null;
        const reimbCapVal = reimbursement_cap ? parseFloat(reimbursement_cap) : null;
        const divId = division_id ? parseInt(division_id) : null;
        const cardDigits = card_last_digits?.trim() || 'None';
        
        await dbQuery(`
            INSERT INTO users (first_name, last_name, username, email, password_hash, card_last_digits, role, spending_limit, reimbursement_cap, division_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [first_name.trim(), last_name.trim(), username.trim().toLowerCase(), email.trim().toLowerCase(), hash, cardDigits, role, limitVal, reimbCapVal, divId]);
        
        res.redirect('/admin/users?success=' + encodeURIComponent('User created successfully.'));
    } catch (e) {
        res.redirect('/admin/users/add?error=' + encodeURIComponent(e.message));
    }
});

app.post('/admin/users/edit', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id, first_name, last_name, username, email, card_last_digits, role, spending_limit, reimbursement_cap, division_id, password } = req.body;
        if (!id || !first_name || !last_name || !username || !email || !role) {
            return res.redirect('/admin/users?error=' + encodeURIComponent('Please fill all required fields.'));
        }

        const [existing] = await dbQuery("SELECT id FROM users WHERE (username=? OR email=?) AND id!=? LIMIT 1", [username.trim(), email.trim(), id]);
        if (existing && existing.length > 0) {
            return res.redirect('/admin/users?error=' + encodeURIComponent('Username or email already in use.'));
        }

        const limitVal = spending_limit ? parseFloat(spending_limit) : null;
        const reimbCapVal = reimbursement_cap ? parseFloat(reimbursement_cap) : null;
        const divId = division_id ? parseInt(division_id) : null;
        const cardDigits = card_last_digits?.trim() || 'None';

        if (password && password.trim().length > 0) {
            const hash = await bcrypt.hash(password, 10);
            await dbQuery(`
                UPDATE users SET first_name=?, last_name=?, username=?, email=?, card_last_digits=?, role=?, spending_limit=?, reimbursement_cap=?, division_id=?, password_hash=?
                WHERE id=?
            `, [first_name.trim(), last_name.trim(), username.trim().toLowerCase(), email.trim().toLowerCase(), cardDigits, role, limitVal, reimbCapVal, divId, hash, id]);
        } else {
            await dbQuery(`
                UPDATE users SET first_name=?, last_name=?, username=?, email=?, card_last_digits=?, role=?, spending_limit=?, reimbursement_cap=?, division_id=?
                WHERE id=?
            `, [first_name.trim(), last_name.trim(), username.trim().toLowerCase(), email.trim().toLowerCase(), cardDigits, role, limitVal, reimbCapVal, divId, id]);
        }
        
        if (parseInt(id) === req.session.user.id) {
            req.session.user.first_name = first_name.trim();
            req.session.user.last_name = last_name.trim();
            req.session.user.username = username.trim().toLowerCase();
            req.session.user.email = email.trim().toLowerCase();
            req.session.user.role = role;
            req.session.user.card_last_digits = cardDigits;
        }

        res.redirect('/admin/users?success=' + encodeURIComponent('User updated successfully.'));
    } catch (e) {
        res.redirect('/admin/users?error=' + encodeURIComponent(e.message));
    }
});

app.post('/admin/users/delete/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (parseInt(id) === req.session.user.id) {
            return res.redirect('/admin/users?error=' + encodeURIComponent('You cannot delete yourself.'));
        }
        await dbQuery("DELETE FROM users WHERE id=?", [id]);
        res.redirect('/admin/users?success=' + encodeURIComponent('User deleted successfully.'));
    } catch (e) {
        res.redirect('/admin/users?error=' + encodeURIComponent(e.message));
    }
});

app.post('/profile/edit', requireAuth, (req, res) => {
    upload.single('profile_photo')(req, res, async (err) => {
        if (err) {
            return res.redirect('/dashboard?error=' + encodeURIComponent(err.message));
        }
        
        try {
            const { first_name, last_name, username, email, password } = req.body;
            const userId = req.session.user.id;
            
            if (!first_name || !last_name || !username || !email) {
                return res.redirect('/dashboard?error=' + encodeURIComponent('First name, last name, username, and email are required.'));
            }

            const [existing] = await dbQuery("SELECT id FROM users WHERE (username=? OR email=?) AND id!=? LIMIT 1", [username.trim(), email.trim(), userId]);
            if (existing && existing.length > 0) {
                return res.redirect('/dashboard?error=' + encodeURIComponent('Username or email already in use.'));
            }

            let profilePhotoPath = req.session.user.profile_photo_path || null;
            if (req.file) {
                profilePhotoPath = '/uploads/' + req.file.filename;
                if (req.session.user.profile_photo_path && req.session.user.profile_photo_path.startsWith('/uploads/')) {
                    const oldPath = path.join(__dirname, 'public', req.session.user.profile_photo_path);
                    if (fs.existsSync(oldPath)) {
                        try { fs.unlinkSync(oldPath); } catch (e) { console.error('Error deleting old avatar:', e); }
                    }
                }
            }

            if (password && password.trim().length > 0) {
                const hash = await bcrypt.hash(password, 10);
                await dbQuery(`
                    UPDATE users SET first_name=?, last_name=?, username=?, email=?, password_hash=?, profile_photo_path=?
                    WHERE id=?
                `, [first_name.trim(), last_name.trim(), username.trim().toLowerCase(), email.trim().toLowerCase(), hash, profilePhotoPath, userId]);
            } else {
                await dbQuery(`
                    UPDATE users SET first_name=?, last_name=?, username=?, email=?, profile_photo_path=?
                    WHERE id=?
                `, [first_name.trim(), last_name.trim(), username.trim().toLowerCase(), email.trim().toLowerCase(), profilePhotoPath, userId]);
            }

            req.session.user.first_name = first_name.trim();
            req.session.user.last_name = last_name.trim();
            req.session.user.username = username.trim().toLowerCase();
            req.session.user.email = email.trim().toLowerCase();
            req.session.user.profile_photo_path = profilePhotoPath;

            res.redirect('/dashboard?success=' + encodeURIComponent('Profile updated successfully.'));
        } catch (e) {
            res.redirect('/dashboard?error=' + encodeURIComponent(e.message));
        }
    });
});

// 404
app.use((req, res) => res.status(404).render('error', { title:'404', message:'Page not found.', user: req.session.user || null }));

const BACKUP_INTERVAL = (parseInt(process.env.BACKUP_INTERVAL_HOURS) || 6) * 60 * 60 * 1000;

async function backupPostgresData(backupDir) {
    try {
        const tables = ['users', 'supervisors', 'job_numbers', 'expenses', 'settings', 'card_whitelist', 'groups', 'notifications', 'group_members', 'expense_logs', 'divisions', 'gas_cards', 'gas_expenses', 'reimbursement_types'];
        const backupData = {};
        
        for (const table of tables) {
            try {
                const [rows] = await dbQuery(`SELECT * FROM "${table}"`);
                backupData[table] = rows;
            } catch (e) {
                // Table might not exist yet
            }
        }
        
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `backup_postgres_${timestamp}.json`);
        
        fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), (err) => {
            if (err) {
                console.error('PostgreSQL database backup failed:', err);
            } else {
                lastBackupTime = new Date();
                console.log('PostgreSQL database backup created successfully:', backupPath);
            }
        });
    } catch (e) {
        console.error('PostgreSQL backup data extraction failed:', e);
    }
}

function runDatabaseBackup() {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
        try { fs.mkdirSync(backupDir, { recursive: true }); } catch (e) { console.error('Failed to create backup dir:', e); }
    }
    
    nextBackupTime = new Date(Date.now() + BACKUP_INTERVAL);

    if (dbMode === 'postgres') {
        backupPostgresData(backupDir);
    } else {
        const dbPath = path.join(__dirname, 'sargtech_expenses.sqlite');
        if (!fs.existsSync(dbPath)) return;

        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `backup_sqlite_${timestamp}.sqlite`);

        fs.copyFile(dbPath, backupPath, (err) => {
            if (err) {
                console.error('SQLite database backup failed:', err);
            } else {
                lastBackupTime = new Date();
                console.log('SQLite database backup created successfully:', backupPath);
            }
        });
    }
}
setInterval(runDatabaseBackup, BACKUP_INTERVAL);
setTimeout(runDatabaseBackup, 5000);

initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀 Sargtech Expenses → http://localhost:${PORT}\n`);
    });
}).catch(err => {
    console.error('Fatal database initialization error:', err);
    process.exit(1);
});
