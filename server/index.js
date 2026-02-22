const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
let mysql;
try {
  mysql = require("mysql2/promise");
} catch (error) {
  if (error.code === "MODULE_NOT_FOUND") {
    console.error(
      "의존성 'mysql2'가 설치되어 있지 않습니다.\n실행: npm install (server 디렉터리에서)\n또는 npm install mysql2"
    );
    process.exit(1);
  }
  throw error;
}

function loadEnvFromFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx === -1) return;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadEnvFromFile();

const PORT = Number(process.env.PORT || 4000);
const BASE_DIR = path.join(__dirname, "..");
const DATA_FILE = path.join(__dirname, "data.json");

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "cityline_bank",
};

const app = express();
let db = null;

const defaultState = {
  config: {
    approvalThreshold: 100000,
  },
  accounts: [
    {
      accountNo: "ADMIN",
      role: "admin",
      name: "Cityline Bank 관리자",
      pin: "0000",
      balance: 0,
      frozen: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      accountNo: "1000001",
      role: "customer",
      name: "김하늘",
      pin: "1234",
      balance: 120000,
      frozen: false,
      createdAt: "2026-01-05T00:00:00.000Z",
    },
    {
      accountNo: "1000002",
      role: "customer",
      name: "박소윤",
      pin: "4321",
      balance: 76000,
      frozen: false,
      createdAt: "2026-01-06T00:00:00.000Z",
    },
  ],
  nextSeq: 1000003,
  sessions: {},
};

let state = loadState();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static(BASE_DIR));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function randomToken() {
  return `sess_${Date.now()}_${crypto.randomBytes(16).toString("hex")}`;
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = clone(defaultState);
    persistState(initial);
    return initial;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    const state = clone(defaultState);
    state.config = { ...defaultState.config, ...(parsed.config || {}) };
    state.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : state.accounts;
    state.nextSeq = Number.isFinite(parsed.nextSeq) ? parsed.nextSeq : state.nextSeq;
    state.sessions = {};
    return state;
  } catch {
    const initial = clone(defaultState);
    persistState(initial);
    return initial;
  }
}

function persistState(store = state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

function publicAccount(account) {
  return {
    accountNo: account.accountNo,
    role: account.role,
    name: account.name,
    balance: account.balance,
    frozen: account.frozen,
    createdAt: account.createdAt,
  };
}

function findAccount(accountNo) {
  return state.accounts.find((account) => account.accountNo === accountNo);
}

function normalizeDate(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapTxnTypeToUi(type) {
  const map = {
    DEPOSIT: "입금",
    WITHDRAW: "출금",
    TRANSFER: "이체",
    ACCOUNT_CREATE: "계좌 생성",
    ADMIN_ADJUST: "관리자 조정",
    ACCOUNT_FREEZE: "계좌 잠금",
    ACCOUNT_UNFREEZE: "계좌 해제",
  };
  return map[type] || type;
}

function mapTxnTypeToDb(type) {
  const map = {
    입금: "DEPOSIT",
    출금: "WITHDRAW",
    이체: "TRANSFER",
    "계좌 생성": "ACCOUNT_CREATE",
    "관리자 조정": "ADMIN_ADJUST",
    "계좌 잠금": "ACCOUNT_FREEZE",
    "계좌 해제": "ACCOUNT_UNFREEZE",
  };
  return map[type] || type;
}

function mapStatusToDecision(status) {
  if (status === "COMPLETED") return "APPROVED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "FAILED") return "REJECTED";
  return null;
}

function mapTxnRow(row) {
  return {
    id: row.txn_id,
    ts: normalizeDate(row.ts),
    type: mapTxnTypeToUi(row.type),
    actor: row.actor,
    from: row.from_account || row.from,
    to: row.to_account || row.to,
    amount: Number(row.amount || 0),
    memo: row.memo,
    status: row.status,
    approval: row.approval_actor || row.approval_at || row.approval_reason
      ? {
          by: row.approval_actor || null,
          at: row.approval_at ? normalizeDate(row.approval_at) : null,
          reason: row.approval_reason || null,
        }
      : null,
  };
}

async function initDb() {
  const safeDatabase = DB_CONFIG.database.replace(/`/g, "``");
  const bootstrap = mysql.createPool({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
    waitForConnections: true,
    connectionLimit: 2,
  });

  try {
    await bootstrap.execute(`CREATE DATABASE IF NOT EXISTS \`${safeDatabase}\``);
  } finally {
    await bootstrap.end();
  }

  db = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 4,
  });
  const createSql = `
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      role ENUM('admin', 'customer') NOT NULL DEFAULT 'customer',
      login_id VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(80) NOT NULL,
      pin_hash VARBINARY(128) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      PRIMARY KEY (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS accounts (
      account_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      account_no VARCHAR(64) NOT NULL UNIQUE,
      user_id BIGINT UNSIGNED NOT NULL,
      balance BIGINT NOT NULL DEFAULT 0,
      is_frozen TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      PRIMARY KEY (account_id),
      CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      txn_key VARCHAR(64) NOT NULL UNIQUE,
      type ENUM('DEPOSIT', 'WITHDRAW', 'TRANSFER', 'ACCOUNT_CREATE', 'ADMIN_ADJUST', 'ACCOUNT_FREEZE', 'ACCOUNT_UNFREEZE') NOT NULL,
      status ENUM('PENDING_APPROVAL', 'COMPLETED', 'REJECTED', 'FAILED') NOT NULL DEFAULT 'COMPLETED',
      actor_account_id BIGINT UNSIGNED NULL,
      memo VARCHAR(255),
      request_ip VARBINARY(16) NULL,
      idempotency_key VARCHAR(128) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      PRIMARY KEY (transaction_id),
      CONSTRAINT fk_transactions_actor_account FOREIGN KEY (actor_account_id) REFERENCES accounts (account_id) ON UPDATE CASCADE ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS transaction_entries (
      entry_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      transaction_id BIGINT UNSIGNED NOT NULL,
      account_id BIGINT UNSIGNED NOT NULL,
      entry_type ENUM('DEBIT', 'CREDIT') NOT NULL,
      amount BIGINT NOT NULL CHECK (amount > 0),
      counterparty_account_id BIGINT UNSIGNED NULL,
      balance_after BIGINT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (entry_id),
      CONSTRAINT fk_entries_txn FOREIGN KEY (transaction_id) REFERENCES transactions (transaction_id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT fk_entries_account FOREIGN KEY (account_id) REFERENCES accounts (account_id) ON UPDATE CASCADE ON DELETE RESTRICT,
      INDEX idx_entries_account_created (account_id, created_at),
      INDEX idx_entries_txn (transaction_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS transaction_reviews (
      review_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      transaction_id BIGINT UNSIGNED NOT NULL,
      reviewer_account_id BIGINT UNSIGNED NULL,
      decision ENUM('APPROVED', 'REJECTED') NOT NULL,
      reason VARCHAR(255) NULL,
      decided_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (review_id),
      CONSTRAINT fk_reviews_txn FOREIGN KEY (transaction_id) REFERENCES transactions (transaction_id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT fk_reviews_reviewer FOREIGN KEY (reviewer_account_id) REFERENCES accounts (account_id) ON UPDATE CASCADE ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  const conn = await db.getConnection();
  try {
    const statements = createSql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await conn.query(`${statement};`);
    }
  } finally {
    conn.release();
  }
}

async function query(sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows;
}

function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    const error = new Error("금액은 숫자여야 합니다.");
    error.code = "BAD_AMOUNT";
    throw error;
  }
  if (Math.floor(amount) !== amount || amount <= 0) {
    const error = new Error("금액은 1 이상의 정수여야 합니다.");
    error.code = "BAD_AMOUNT";
    throw error;
  }
  return amount;
}

function parseSignedAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount === 0) {
    const error = new Error("금액은 0이 아닌 정수여야 합니다.");
    error.code = "BAD_AMOUNT";
    throw error;
  }
  return amount;
}

async function ensureDbAccount(accountNo) {
  const account = findAccount(accountNo);
  if (!account) {
    const error = new Error("ACCOUNT_NOT_FOUND");
    error.code = "ACCOUNT_NOT_FOUND";
    throw error;
  }

  await query(
    "INSERT INTO users (role, login_id, name, pin_hash) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role), updated_at = CURRENT_TIMESTAMP(6)",
    [account.role === "admin" ? "admin" : "customer", accountNo, account.name, crypto.createHash("sha256").update(String(account.pin || "0000")).digest()]
  );

  const userRows = await query("SELECT user_id FROM users WHERE login_id = ?", [accountNo]);
  const userId = userRows[0]?.user_id;
  if (!userId) {
    const error = new Error("USER_CREATE_FAILED");
    error.code = "USER_CREATE_FAILED";
    throw error;
  }

  await query(
    "INSERT INTO accounts (account_no, user_id, balance, is_frozen) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE balance = VALUES(balance), is_frozen = VALUES(is_frozen), updated_at = CURRENT_TIMESTAMP(6)",
    [accountNo, userId, account.balance, account.frozen ? 1 : 0]
  );

  const accountRows = await query("SELECT account_id FROM accounts WHERE account_no = ?", [accountNo]);
  if (!accountRows.length) {
    const error = new Error("ACCOUNT_CREATE_FAILED");
    error.code = "ACCOUNT_CREATE_FAILED";
    throw error;
  }
  return accountRows[0].account_id;
}

function getTxnSelectSql({ where = "", orderBy = true } = {}) {
  return `
    SELECT
      t.txn_key AS txn_id,
      t.type,
      a_actor.account_no AS actor,
      a_debit.account_no AS from_account,
      a_credit.account_no AS to_account,
      COALESCE(te.debit_amount, te.credit_amount, 0) AS amount,
      t.memo,
      t.status,
      t.created_at AS ts,
      a_approver.account_no AS approval_actor,
      rl.decided_at AS approval_at,
      rl.reason AS approval_reason
    FROM transactions t
    LEFT JOIN accounts a_actor ON a_actor.account_id = t.actor_account_id
    LEFT JOIN (
      SELECT
        transaction_id,
        MAX(CASE WHEN entry_type = 'DEBIT' THEN amount END) AS debit_amount,
        MAX(CASE WHEN entry_type = 'CREDIT' THEN amount END) AS credit_amount,
        MAX(CASE WHEN entry_type = 'DEBIT' THEN account_id END) AS debit_account_id,
        MAX(CASE WHEN entry_type = 'CREDIT' THEN account_id END) AS credit_account_id
      FROM transaction_entries
      GROUP BY transaction_id
    ) te ON te.transaction_id = t.transaction_id
    LEFT JOIN accounts a_debit ON a_debit.account_id = te.debit_account_id
    LEFT JOIN accounts a_credit ON a_credit.account_id = te.credit_account_id
    LEFT JOIN (
      SELECT r1.transaction_id, r1.reviewer_account_id, r1.reason, r1.decided_at
      FROM transaction_reviews r1
      INNER JOIN (
        SELECT transaction_id, MAX(review_id) AS review_id
        FROM transaction_reviews
        GROUP BY transaction_id
      ) r2 ON r2.transaction_id = r1.transaction_id AND r2.review_id = r1.review_id
    ) rl ON rl.transaction_id = t.transaction_id
    LEFT JOIN accounts a_approver ON a_approver.account_id = rl.reviewer_account_id
    ${where ? `WHERE ${where}` : ""}
    ${orderBy ? "ORDER BY t.created_at DESC" : ""}
  `;
}

function requireAuth(req, res, next) {
  const token = req.headers["x-auth-token"];
  const session = token && state.sessions[token];

  if (!session) {
    return res.status(401).json({ error: "AUTH_TOKEN_REQUIRED" });
  }
  const account = findAccount(session.accountNo);
  if (!account) {
    delete state.sessions[token];
    persistState();
    return res.status(401).json({ error: "ACCOUNT_NOT_FOUND" });
  }
  req.auth = { token, session, account };
  session.lastActiveAt = now();
  next();
}

function requireAdmin(req, res, next) {
  if (req.auth.account.role !== "admin") {
    return res.status(403).json({ error: "FORBIDDEN" });
  }
  next();
}

function applyBadRequest(res, err) {
  return res.status(400).json({ error: err.message || "BAD_REQUEST" });
}

async function createTxn(payload) {
  const txn = {
    id: `txn_${Date.now()}_${Math.floor(Math.random() * 9999)}`,
    ts: now(),
    status: "COMPLETED",
    ...payload,
  };

  const dbType = mapTxnTypeToDb(txn.type);
  if (!dbType) {
    const error = new Error("지원되지 않는 거래 유형입니다.");
    error.code = "BAD_TXN_TYPE";
    throw error;
  }

  const actorId = await ensureDbAccount(txn.actor);
  const fromId = txn.from ? await ensureDbAccount(txn.from) : actorId;
  const toId = txn.to ? await ensureDbAccount(txn.to) : actorId;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [txInsert] = await conn.execute(
      "INSERT INTO transactions (txn_key, type, status, actor_account_id, memo, request_ip, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [txn.id, dbType, txn.status, actorId, txn.memo || null, txn.requestIp || null, txn.idempotencyKey || null]
    );
    const transactionId = txInsert.insertId;

    const insertEntry = async (entryType, accountId, amount, counterpartyId = null) => {
      if (!Number(amount) || Number(amount) <= 0) return;
      await conn.execute(
        "INSERT INTO transaction_entries (transaction_id, account_id, entry_type, amount, counterparty_account_id) VALUES (?, ?, ?, ?, ?)",
        [transactionId, accountId, entryType, amount, counterpartyId]
      );
    };

    if (dbType === "DEPOSIT") {
      await insertEntry("CREDIT", toId, txn.amount, fromId);
    } else if (dbType === "WITHDRAW") {
      await insertEntry("DEBIT", fromId, txn.amount, toId);
    } else if (dbType === "TRANSFER") {
      await insertEntry("DEBIT", fromId, txn.amount, toId);
      await insertEntry("CREDIT", toId, txn.amount, fromId);
    } else if (dbType === "ACCOUNT_CREATE") {
      await insertEntry("CREDIT", toId, txn.amount, actorId);
    } else if (dbType === "ADMIN_ADJUST") {
      if (fromId && toId) {
        await insertEntry("DEBIT", fromId, txn.amount, toId);
        await insertEntry("CREDIT", toId, txn.amount, fromId);
      }
    }

    await conn.commit();
    return txn;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function getTransactions({ accountNo = null, status = null } = {}) {
  const conditions = [];
  const params = [];
  if (accountNo) {
    const accountRows = await query("SELECT account_id FROM accounts WHERE account_no = ?", [accountNo]);
    if (!accountRows.length) return [];
    const accountId = accountRows[0].account_id;
    conditions.push("(t.actor_account_id = ? OR te.debit_account_id = ? OR te.credit_account_id = ?)");
    params.push(accountId, accountId, accountId);
  }
  if (status) {
    conditions.push("t.status = ?");
    params.push(status);
  }
  const where = conditions.length ? conditions.join(" AND ") : "";
  const rows = await query(getTxnSelectSql({ where, orderBy: true }), params);
  return rows.map(mapTxnRow);
}

async function findTxn(txnId) {
  const rows = await query(
    getTxnSelectSql({ where: "t.txn_key = ?", orderBy: false }),
    [txnId]
  );
  if (!rows.length) return null;
  return mapTxnRow(rows[0]);
}

async function setTxnStatus(txnId, status, approval = {}) {
  const existing = await query("SELECT transaction_id FROM transactions WHERE txn_key = ?", [txnId]);
  if (!existing.length) return null;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute("UPDATE transactions SET status = ? WHERE txn_key = ?", [status, txnId]);
    if (!result.affectedRows) {
      await conn.rollback();
      return null;
    }

    const decision = mapStatusToDecision(status);
    if (decision && (approval.by || approval.reason)) {
      const transactionId = existing[0].transaction_id;
      const reviewerAccountId = approval.by ? await ensureDbAccount(approval.by) : null;
      await conn.execute(
        "INSERT INTO transaction_reviews (transaction_id, reviewer_account_id, decision, reason) VALUES (?, ?, ?, ?)",
        [transactionId, reviewerAccountId, decision, approval.reason || null]
      );
    }

    await conn.commit();
    return findTxn(txnId);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

function logDbError(res, error, fallbackStatus = 500) {
  console.error("DB error:", error);
  return res.status(fallbackStatus).json({ error: "DB_ERROR", message: error.message });
}

app.get("/api/health", async (_, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    logDbError(res, error);
  }
});

app.post("/api/login", (req, res) => {
  const { accountNo, pin, role } = req.body || {};
  const account = findAccount(String(accountNo || "").trim());
  if (!account || account.role !== role) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  if (account.pin !== String(pin || "")) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  const token = randomToken();
  state.sessions[token] = {
    accountNo: account.accountNo,
    createdAt: now(),
    lastActiveAt: now(),
  };
  persistState();
  return res.json({
    token,
    account: publicAccount(account),
    approvalThreshold: state.config.approvalThreshold,
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  delete state.sessions[req.auth.token];
  persistState();
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    account: publicAccount(req.auth.account),
    approvalThreshold: state.config.approvalThreshold,
  });
});

app.get("/api/config", requireAuth, (req, res) => {
  res.json({
    approvalThreshold: state.config.approvalThreshold,
  });
});

app.get("/api/accounts", requireAuth, requireAdmin, (req, res) => {
  res.json({
    accounts: state.accounts.map(publicAccount),
  });
});

app.get("/api/transactions", requireAuth, async (req, res) => {
  try {
    const status = req.query.status;
    const filter = req.auth.account.role === "admin" ? {} : { accountNo: req.auth.account.accountNo };
    if (status) filter.status = status;
    const transactions = await getTransactions(filter);
    return res.json({ transactions });
  } catch (error) {
    return logDbError(res, error);
  }
});

app.get("/api/pending-transfers", requireAuth, async (req, res) => {
  try {
    const status = "PENDING_APPROVAL";
    const accountNo = req.auth.account.role === "admin" ? null : req.auth.account.accountNo;
    let pending = await getTransactions({ status, accountNo });
    if (req.auth.account.role === "admin") {
      pending = pending.filter((txn) => txn.type === "이체");
    }
    if (req.auth.account.role !== "admin") {
      pending = pending.filter((txn) => txn.type === "이체");
    }
    return res.json({ transactions: pending });
  } catch (error) {
    return logDbError(res, error);
  }
});

app.post("/api/deposit", requireAuth, async (req, res) => {
  const account = req.auth.account;
  try {
    const amount = parseAmount(req.body.amount);
    const memo = String(req.body.memo || "입금").slice(0, 200);
    if (account.frozen) {
      return res.status(423).json({ error: "ACCOUNT_FROZEN" });
    }
    const prevBalance = account.balance;
    account.balance += amount;
    try {
      const txn = await createTxn({
        type: "입금",
        actor: account.accountNo,
        from: account.accountNo,
        to: account.accountNo,
        amount,
        memo,
        status: "COMPLETED",
      });
      persistState();
      return res.status(201).json({ transaction: txn });
    } catch (error) {
      account.balance = prevBalance;
      return logDbError(res, error, 500);
    }
  } catch (error) {
    if (error.code === "BAD_AMOUNT") return applyBadRequest(res, error);
    return logDbError(res, error, 500);
  }
});

app.post("/api/withdraw", requireAuth, async (req, res) => {
  const account = req.auth.account;
  try {
    const amount = parseAmount(req.body.amount);
    const memo = String(req.body.memo || "출금").slice(0, 200);
    if (account.frozen) {
      return res.status(423).json({ error: "ACCOUNT_FROZEN" });
    }
    if (account.balance < amount) {
      return res.status(409).json({ error: "INSUFFICIENT_FUNDS" });
    }
    const prevBalance = account.balance;
    account.balance -= amount;
    try {
      const txn = await createTxn({
        type: "출금",
        actor: account.accountNo,
        from: account.accountNo,
        to: account.accountNo,
        amount,
        memo,
        status: "COMPLETED",
      });
      persistState();
      return res.status(201).json({ transaction: txn });
    } catch (error) {
      account.balance = prevBalance;
      return logDbError(res, error, 500);
    }
  } catch (error) {
    if (error.code === "BAD_AMOUNT") return applyBadRequest(res, error);
    return logDbError(res, error, 500);
  }
});

app.post("/api/transfer", requireAuth, async (req, res) => {
  const from = req.auth.account;
  if (from.frozen) {
    return res.status(423).json({ error: "ACCOUNT_FROZEN" });
  }
  try {
    const toAccountNo = String(req.body.toAccountNo || "").trim();
    const amount = parseAmount(req.body.amount);
    const memo = String(req.body.memo || `이체 ${toAccountNo}`).slice(0, 200);
    const to = findAccount(toAccountNo);
    if (!toAccountNo) {
      return res.status(400).json({ error: "RECEIVER_REQUIRED" });
    }
    if (!to) {
      return res.status(404).json({ error: "RECEIVER_NOT_FOUND" });
    }
    if (to.frozen) {
      return res.status(423).json({ error: "RECEIVER_FROZEN" });
    }
    if (to.accountNo === from.accountNo) {
      return res.status(409).json({ error: "SELF_TRANSFER_NOT_ALLOWED" });
    }
    if (from.balance < amount) {
      return res.status(409).json({ error: "INSUFFICIENT_FUNDS" });
    }

    if (amount >= state.config.approvalThreshold) {
      const txn = await createTxn({
        type: "이체",
        actor: from.accountNo,
        from: from.accountNo,
        to: to.accountNo,
        amount,
        memo,
        status: "PENDING_APPROVAL",
      });
      persistState();
      return res.status(202).json({ transaction: txn, isPendingApproval: true });
    }

    const prevFromBalance = from.balance;
    const prevToBalance = to.balance;
    from.balance -= amount;
    to.balance += amount;
    try {
      const txn = await createTxn({
        type: "이체",
        actor: from.accountNo,
        from: from.accountNo,
        to: to.accountNo,
        amount,
        memo,
        status: "COMPLETED",
      });
      persistState();
      return res.status(201).json({ transaction: txn, isPendingApproval: false });
    } catch (error) {
      from.balance = prevFromBalance;
      to.balance = prevToBalance;
      return logDbError(res, error, 500);
    }
  } catch (error) {
    if (error.code === "BAD_AMOUNT") return applyBadRequest(res, error);
    return logDbError(res, error, 500);
  }
});

app.post("/api/admin/accounts", requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const pin = String(req.body.pin || "");
  const initialBalance = Number(req.body.initialBalance || 0);

  if (!name) {
    return res.status(400).json({ error: "NAME_REQUIRED" });
  }
  if (!/^[0-9]{4,8}$/.test(pin)) {
    return res.status(400).json({ error: "BAD_PIN" });
  }
  if (!Number.isFinite(initialBalance) || initialBalance < 0 || Math.floor(initialBalance) !== initialBalance) {
    return res.status(400).json({ error: "BAD_INITIAL_BALANCE" });
  }

  const accountNo = String(state.nextSeq++);
  const account = {
    accountNo,
    role: "customer",
    name,
    pin,
    balance: initialBalance,
    frozen: false,
    createdAt: now(),
  };
  state.accounts.push(account);

  try {
    const txn = await createTxn({
      type: "계좌 생성",
      actor: req.auth.account.accountNo,
      from: req.auth.account.accountNo,
      to: accountNo,
      amount: initialBalance,
      memo: `${name} 계좌 생성`,
      status: "COMPLETED",
    });
    persistState();
    return res.status(201).json({
      accountNo,
      account: publicAccount(account),
      transaction: txn,
    });
  } catch (error) {
    state.accounts = state.accounts.filter((item) => item.accountNo !== accountNo);
    state.nextSeq -= 1;
    return logDbError(res, error, 500);
  }
});

app.post("/api/admin/accounts/:accountNo/adjust", requireAuth, requireAdmin, async (req, res) => {
  const account = findAccount(req.params.accountNo);
  if (!account) {
    return res.status(404).json({ error: "ACCOUNT_NOT_FOUND" });
  }
  if (account.role === "admin") {
    return res.status(403).json({ error: "CANNOT_MODIFY_ADMIN_ACCOUNT" });
  }
  try {
    const amount = parseSignedAmount(req.body.amount);
    const memo = String(req.body.memo || "관리자 조정").slice(0, 200);
    if (account.frozen && amount < 0) {
      return res.status(423).json({ error: "ACCOUNT_FROZEN" });
    }
    if (amount < 0 && account.balance + amount < 0) {
      return res.status(409).json({ error: "INSUFFICIENT_FUNDS" });
    }
    const prevBalance = account.balance;
    account.balance += amount;
    try {
      const txn = await createTxn({
        type: "관리자 조정",
        actor: req.auth.account.accountNo,
        from: amount >= 0 ? req.auth.account.accountNo : account.accountNo,
        to: amount >= 0 ? account.accountNo : req.auth.account.accountNo,
        amount: Math.abs(amount),
        memo,
        status: "COMPLETED",
      });
      persistState();
      return res.status(201).json({ account: publicAccount(account), transaction: txn });
    } catch (error) {
      account.balance = prevBalance;
      return logDbError(res, error, 500);
    }
  } catch (error) {
    if (error.code === "BAD_AMOUNT") return applyBadRequest(res, error);
    return logDbError(res, error, 500);
  }
});

app.post("/api/admin/accounts/:accountNo/freeze", requireAuth, requireAdmin, async (req, res) => {
  const account = findAccount(req.params.accountNo);
  if (!account) {
    return res.status(404).json({ error: "ACCOUNT_NOT_FOUND" });
  }
  if (account.role === "admin") {
    return res.status(403).json({ error: "CANNOT_MODIFY_ADMIN_ACCOUNT" });
  }

  const desired = typeof req.body.frozen === "boolean" ? req.body.frozen : !account.frozen;
  if (account.frozen === desired) {
    return res.json({ account: publicAccount(account), updated: false });
  }
  account.frozen = desired;
  try {
    const txn = await createTxn({
      type: desired ? "계좌 잠금" : "계좌 해제",
      actor: req.auth.account.accountNo,
      from: account.accountNo,
      to: account.accountNo,
      amount: 0,
      memo: desired ? "관리자에 의해 잠금 처리" : "관리자에 의해 잠금 해제",
      status: "COMPLETED",
    });
    persistState();
    return res.json({ account: publicAccount(account), transaction: txn, updated: true });
  } catch (error) {
    account.frozen = !desired;
    return logDbError(res, error, 500);
  }
});

app.post("/api/admin/transactions/:txnId/approve", requireAuth, requireAdmin, async (req, res) => {
  try {
    const txn = await findTxn(req.params.txnId);
    if (!txn) {
      return res.status(404).json({ error: "TRANSACTION_NOT_FOUND" });
    }
    if (txn.status !== "PENDING_APPROVAL") {
      return res.status(409).json({ error: "TRANSACTION_NOT_PENDING", transaction: txn });
    }
    const from = findAccount(txn.from);
    const to = findAccount(txn.to);
    const reason = String(req.body.reason || "관리자 승인");

    if (!from || !to) {
      const updated = await setTxnStatus(txn.id, "FAILED", {
        by: req.auth.account.accountNo,
        reason: "INVALID_ACCOUNT",
      });
      return res.status(409).json({ error: "INVALID_ACCOUNT", transaction: updated });
    }
    if (from.frozen || to.frozen) {
      const updated = await setTxnStatus(txn.id, "FAILED", {
        by: req.auth.account.accountNo,
        reason: "ACCOUNT_FROZEN",
      });
      return res.status(409).json({ error: "ACCOUNT_FROZEN", transaction: updated });
    }
    if (from.balance < txn.amount) {
      const updated = await setTxnStatus(txn.id, "FAILED", {
        by: req.auth.account.accountNo,
        reason: "INSUFFICIENT_FUNDS",
      });
      return res.status(409).json({ error: "INSUFFICIENT_FUNDS", transaction: updated });
    }

    const prevFromBalance = from.balance;
    const prevToBalance = to.balance;
    from.balance -= txn.amount;
    to.balance += txn.amount;
    try {
      const updated = await setTxnStatus(txn.id, "COMPLETED", {
        by: req.auth.account.accountNo,
        reason,
      });
      if (!updated) {
        from.balance = prevFromBalance;
        to.balance = prevToBalance;
        return res.status(409).json({ error: "TRANSACTION_STATE_CHANGED", transaction: await findTxn(txn.id) });
      }
      persistState();
      return res.json({ transaction: updated });
    } catch (error) {
      from.balance = prevFromBalance;
      to.balance = prevToBalance;
      return logDbError(res, error, 500);
    }
  } catch (error) {
    return logDbError(res, error, 500);
  }
});

app.post("/api/admin/transactions/:txnId/reject", requireAuth, requireAdmin, async (req, res) => {
  try {
    const txn = await findTxn(req.params.txnId);
    if (!txn) {
      return res.status(404).json({ error: "TRANSACTION_NOT_FOUND" });
    }
    if (txn.status !== "PENDING_APPROVAL") {
      return res.status(409).json({ error: "TRANSACTION_NOT_PENDING", transaction: txn });
    }
    const reason = String(req.body.reason || "관리자 거부");
    const updated = await setTxnStatus(req.params.txnId, "REJECTED", {
      by: req.auth.account.accountNo,
      reason,
    });
    if (!updated) {
      return res.status(409).json({ error: "TRANSACTION_STATE_CHANGED", transaction: await findTxn(req.params.txnId) });
    }
    return res.json({ transaction: updated });
  } catch (error) {
    return logDbError(res, error, 500);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Cityline Bank API 서버 시작: http://localhost:${PORT}`);
      console.log("MariaDB transactions table:", DB_CONFIG.database);
    });
  } catch (error) {
    console.error("서버 초기화 실패:", error.message);
    process.exit(1);
  }
})();
