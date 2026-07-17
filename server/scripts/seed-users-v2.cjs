// Seed script v2 — uses absolute paths for container
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'proma-team.db') : '/app/data/proma-team.db';
console.log('DB:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const { v4: uuidv4 } = require('uuid');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

function ensureCreditRow(userId) {
  const row = db.prepare('SELECT user_id FROM credits WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, 0, 0, ?)').run(userId, Date.now());
  }
}

const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  // Hash the user email prefix for determinism in seed
  let code = 'U';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function createInviteCode(userId) {
  const ex = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(userId);
  if (ex) return ex.code;
  let code, tries = 0;
  do { code = genCode(); tries++; } while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code) && tries < 10);
  db.prepare('INSERT INTO invite_codes (id, user_id, code, created_at) VALUES (?, ?, ?, ?)').run(uuidv4(), userId, code, Date.now());
  return code;
}

const C = 25000000;
const LIST = [
  ['seed01@profer.local','种子01'],['seed02@profer.local','种子02'],['seed03@profer.local','种子03'],
  ['seed04@profer.local','种子04'],['seed05@profer.local','种子05'],['seed06@profer.local','种子06'],
  ['seed07@profer.local','种子07'],['seed08@profer.local','种子08'],['seed09@profer.local','种子09'],
  ['seed10@profer.local','种子10'],['seed11@profer.local','种子11'],['seed12@profer.local','种子12'],
  ['seed13@profer.local','种子13'],['seed14@profer.local','种子14'],['seed15@profer.local','种子15'],
];

for (const [email, name] of LIST) {
  const ex = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (ex) { console.log('SKIP:', email); continue; }
  const id = uuidv4(), pw = crypto.randomBytes(8).toString('hex'), now = Date.now();
  db.prepare(`INSERT INTO users (id,email,password_hash,display_name,is_vip,membership_tier,multiplier,account_type,balance_purchased,created_at) VALUES (?,?,?,?,1,'pro',0.8,'advanced',?,?)`).run(id, email, hashPassword(pw), name, C, now);
  ensureCreditRow(id);
  db.prepare('UPDATE credits SET balance=?,updated_at=? WHERE user_id=?').run(C, now, id);
  db.prepare(`INSERT INTO credit_transactions (id,user_id,amount,type,description,source_balance,created_at) VALUES (?,?,?,'grant',?,'purchased',?)`).run(uuidv4(), id, C, '种子初始积分', now);
  const code = createInviteCode(id);
  console.log('OK:', email, 'pw=', pw, 'code=', code);
}
console.log('DONE');
process.exit(0);
