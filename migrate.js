const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'sargtech_expenses.sqlite'));

db.serialize(() => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
        if (err) console.error('List error:', err.message);
        else console.log('Existing tables:', rows.map(r => r.name).join(', '));
    });

    db.run(`CREATE TABLE IF NOT EXISTS supervisors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, err => { if (err) console.error('supervisors:', err.message); else console.log('supervisors table OK'); });

    db.run(`CREATE TABLE IF NOT EXISTS job_numbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_number TEXT NOT NULL UNIQUE,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, err => { if (err) console.error('job_numbers:', err.message); else console.log('job_numbers table OK'); });

    db.run(`CREATE TABLE IF NOT EXISTS card_whitelist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_digits TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, err => { if (err) console.error('card_whitelist:', err.message); else console.log('card_whitelist table OK'); });

    db.run(`ALTER TABLE expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`, err => {
        if (err && err.message.includes('duplicate')) console.log('status column already exists');
        else if (err) console.log('status col note:', err.message);
        else console.log('status column added');
        db.close(() => console.log('Migration complete.'));
    });
});
