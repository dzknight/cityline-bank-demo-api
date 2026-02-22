const API_BASE =
  window.location.protocol === "file:"
    ? "http://localhost:4000/api"
    : `${window.location.origin}/api`;
const AUTH_STORAGE_KEY = "cityline_bank_session_v2";

const state = {
  token: localStorage.getItem(AUTH_STORAGE_KEY),
  me: null,
  config: { approvalThreshold: 100000 },
  accounts: [],
  txns: [],
  pendingApprovals: [],
  selectedAccountNo: null,
};

const el = {
  loginSection: document.getElementById("loginSection"),
  customerSection: document.getElementById("customerSection"),
  adminSection: document.getElementById("adminSection"),
  logoutBtn: document.getElementById("logoutBtn"),
  accountInput: document.getElementById("accountInput"),
  pinInput: document.getElementById("pinInput"),
  roleSelect: document.getElementById("roleSelect"),
  loginBtn: document.getElementById("loginBtn"),
  toast: document.getElementById("toast"),
  sessionInfo: document.getElementById("sessionInfo"),
  custName: document.getElementById("custName"),
  custNo: document.getElementById("custNo"),
  custBalance: document.getElementById("custBalance"),
  custStatus: document.getElementById("custStatus"),
  depositAmount: document.getElementById("depositAmount"),
  depositMemo: document.getElementById("depositMemo"),
  depositBtn: document.getElementById("depositBtn"),
  withdrawAmount: document.getElementById("withdrawAmount"),
  withdrawMemo: document.getElementById("withdrawMemo"),
  withdrawBtn: document.getElementById("withdrawBtn"),
  transferTo: document.getElementById("transferTo"),
  transferAmount: document.getElementById("transferAmount"),
  transferBtn: document.getElementById("transferBtn"),
  transferThresholdHint: document.getElementById("transferThresholdHint"),
  customerLedger: document.getElementById("customerLedger"),
  customerPendingApprovals: document.getElementById("customerPendingApprovals"),
  adminTotalAccounts: document.getElementById("adminTotalAccounts"),
  adminTotalAssets: document.getElementById("adminTotalAssets"),
  adminTxnCount: document.getElementById("adminTxnCount"),
  adminFrozenCount: document.getElementById("adminFrozenCount"),
  accountsTable: document.getElementById("accountsTable"),
  adminLedger: document.getElementById("adminLedger"),
  adminPendingApprovals: document.getElementById("adminPendingApprovals"),
  newName: document.getElementById("newName"),
  newPin: document.getElementById("newPin"),
  initialBalance: document.getElementById("initialBalance"),
  createAccountBtn: document.getElementById("createAccountBtn"),
  selectedAccount: document.getElementById("selectedAccount"),
  targetAmount: document.getElementById("targetAmount"),
  targetMemo: document.getElementById("targetMemo"),
  adjustBtn: document.getElementById("adjustBtn"),
  freezeBtn: document.getElementById("freezeBtn"),
};

function money(num) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
  }).format(Math.round(num || 0));
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("ko-KR");
}

function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.style.color = isError ? "var(--danger)" : "var(--text)";
  el.toast.classList.remove("hidden");
  setTimeout(() => el.toast.classList.add("hidden"), 1800);
}

function clearInputs() {
  el.depositAmount.value = "";
  el.depositMemo.value = "";
  el.withdrawAmount.value = "";
  el.withdrawMemo.value = "";
  el.transferTo.value = "";
  el.transferAmount.value = "";
  el.newName.value = "";
  el.newPin.value = "";
  el.initialBalance.value = "";
  el.targetAmount.value = "";
  el.targetMemo.value = "";
}

function statusTag(status) {
  if (status === "PENDING_APPROVAL") return '<span class="tag warn">승인대기</span>';
  if (status === "REJECTED") return '<span class="tag freeze">거부</span>';
  if (status === "FAILED") return '<span class="tag freeze">실패</span>';
  return '<span class="tag">완료</span>';
}

function signedAmountClass(amount, txn) {
  if (txn.status === "PENDING_APPROVAL") return "warn";
  return amount >= 0 ? "pos" : "neg";
}

function signedAmountValue(txn, accountNo) {
  if (txn.status === "PENDING_APPROVAL") return 0;

  if (txn.type === "입금") return txn.amount;
  if (txn.type === "출금") return -txn.amount;
  if (txn.type === "계좌 생성") return txn.to === accountNo ? txn.amount : -txn.amount;
  if (txn.type === "관리자 조정") return txn.to === accountNo ? txn.amount : -txn.amount;

  if (txn.type === "이체") {
    if (txn.to === accountNo && txn.from !== accountNo) return txn.amount;
    if (txn.from === accountNo && txn.to !== accountNo) return -txn.amount;
  }

  return txn.to === accountNo ? txn.amount : -txn.amount;
}

function signedAmountLabel(txn, accountNo) {
  if (txn.status === "PENDING_APPROVAL") {
    return "승인 필요";
  }
  const value = signedAmountValue(txn, accountNo);
  return value >= 0 ? `+${money(value)}` : `-${money(Math.abs(value))}`;
}

function rowSummary(txn, me) {
  const amount = signedAmountValue(txn, me);
  return `
    <div class="ledger-item">
      <div class="ledger-main">
        <strong>${txn.type}</strong>
        <span class="${signedAmountClass(amount, txn)}">${signedAmountLabel(txn, me)}</span>
      </div>
      <div class="ledger-meta">
        ${formatDateTime(txn.ts)} · ${statusTag(txn.status)}
        <br/>상대: ${txn.from === me ? txn.to : txn.from}
        <br/>메모: ${txn.memo || "-"}
      </div>
    </div>
  `;
}

function api(path, options = {}) {
  const config = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
    },
  };
  if (state.token) config.headers["x-auth-token"] = state.token;
  if (options.body) config.body = JSON.stringify(options.body);

  return fetch(`${API_BASE}${path}`, config).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = data.error || data.message || `요청 실패 (${response.status})`;
      throw new Error(error);
    }
    return data;
  });
}

function setSessionView(isSignedIn, role) {
  el.loginSection.classList.toggle("hidden", isSignedIn);
  el.customerSection.classList.toggle("hidden", !isSignedIn || role !== "customer");
  el.adminSection.classList.toggle("hidden", !isSignedIn || role !== "admin");
  el.logoutBtn.disabled = !isSignedIn;
  if (!isSignedIn) {
    el.sessionInfo.textContent = "로그인 필요";
    return;
  }
  el.sessionInfo.textContent = role === "admin" ? "관리자 계정 로그인됨" : "고객 계정 로그인됨";
}

function clearSession() {
  state.token = null;
  state.me = null;
  state.accounts = [];
  state.txns = [];
  state.pendingApprovals = [];
  state.selectedAccountNo = null;
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function parseAmount(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0 || Math.floor(normalized) !== normalized) {
    throw new Error("금액은 1 이상 정수여야 합니다.");
  }
  return normalized;
}

function parseAdjustAmount(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized === 0 || Math.floor(normalized) !== normalized) {
    throw new Error("조정 금액은 0이 아닌 정수여야 합니다.");
  }
  return normalized;
}

async function restoreSession() {
  if (!state.token) return false;
  try {
    const me = await api("/me");
    const cfg = await api("/config").catch(() => ({ approvalThreshold: 100000 }));
    state.me = me.account;
    state.config.approvalThreshold = cfg.approvalThreshold || state.config.approvalThreshold;
    return true;
  } catch (error) {
    clearSession();
    return false;
  }
}

async function fetchCustomerData() {
  const [txnsRes, pendingRes] = await Promise.all([
    api("/transactions"),
    api("/pending-transfers"),
  ]);
  state.txns = txnsRes.transactions || [];
  state.pendingApprovals = pendingRes.transactions || [];
}

async function fetchAdminData() {
  const [accountsRes, txnsRes, pendingRes] = await Promise.all([
    api("/accounts"),
    api("/transactions"),
    api("/pending-transfers"),
  ]);
  state.accounts = accountsRes.accounts || [];
  state.txns = txnsRes.transactions || [];
  state.pendingApprovals = pendingRes.transactions || [];
}

function renderCustomer() {
  el.custName.textContent = state.me.name;
  el.custNo.textContent = state.me.accountNo;
  el.custBalance.textContent = money(state.me.balance);
  el.custStatus.innerHTML = state.me.frozen
    ? '<span class="tag freeze">잠김</span>'
    : '<span class="tag">정상</span>';
  el.transferThresholdHint.textContent = `참고: ${money(state.config.approvalThreshold)} 이상 이체는 승인 대상입니다.`;

  if (state.txns.length === 0) {
    el.customerLedger.innerHTML = '<div class="ledger-item">거래 내역이 없습니다.</div>';
  } else {
    el.customerLedger.innerHTML = state.txns
      .map((txn) => rowSummary(txn, state.me.accountNo))
      .join("");
  }

  if (state.pendingApprovals.length === 0) {
    el.customerPendingApprovals.innerHTML = '<div class="ledger-item">승인 대기중인 이체가 없습니다.</div>';
  } else {
    el.customerPendingApprovals.innerHTML = state.pendingApprovals
      .map((txn) => rowSummary(txn, state.me.accountNo))
      .join("");
  }
}

function renderAdmin() {
  const customers = state.accounts.filter((account) => account.role === "customer");
  const totalAssets = customers.reduce((sum, account) => sum + account.balance, 0);
  const frozenCount = customers.filter((account) => account.frozen).length;

  el.adminTotalAccounts.textContent = customers.length;
  el.adminTotalAssets.textContent = money(totalAssets);
  el.adminTxnCount.textContent = state.txns.length;
  el.adminFrozenCount.textContent = frozenCount;

  const rows = customers
    .map(
      (account) => `
      <tr class="row ${state.selectedAccountNo === account.accountNo ? "selected" : ""}">
        <td>${account.accountNo}</td>
        <td>${account.name}</td>
        <td>${money(account.balance)}</td>
        <td>${account.frozen ? '<span class="tag freeze">잠김</span>' : '<span class="tag">정상</span>'}</td>
        <td><button class="ghost-btn" data-select="${account.accountNo}">선택</button></td>
      </tr>
    `
    )
    .join("");

  el.accountsTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>계좌번호</th>
          <th>예금주</th>
          <th>잔액</th>
          <th>상태</th>
          <th>작업</th>
        </tr>
      </thead>
      <tbody>${rows || "<tr><td colspan='5'>고객 계좌가 없습니다.</td></tr>"}</tbody>
    </table>
  `;

  const selected = state.accounts.find((account) => account.accountNo === state.selectedAccountNo);
  el.selectedAccount.textContent = selected ? `${selected.name} (${selected.accountNo})` : "없음";
  el.adjustBtn.disabled = !selected;
  el.freezeBtn.disabled = !selected;

  if (state.txns.length === 0) {
    el.adminLedger.innerHTML = '<div class="ledger-item">감사 로그가 없습니다.</div>';
  } else {
    el.adminLedger.innerHTML = state.txns
      .map((txn) => {
        const counterpart = `${txn.from} → ${txn.to}`;
        return `
          <div class="ledger-item">
            <div class="ledger-main">
              <strong>${txn.type}</strong>
              <span>${money(txn.amount)}</span>
            </div>
            <div class="ledger-meta">
              ${formatDateTime(txn.ts)} · ${txn.actor || "-"} · ${counterpart} · ${statusTag(txn.status)}
              <br/>메모: ${txn.memo || "-"}
            </div>
          </div>
        `;
      })
      .join("");
  }

  if (state.pendingApprovals.length === 0) {
    el.adminPendingApprovals.innerHTML = '<div class="ledger-item">승인 대기 이체가 없습니다.</div>';
  } else {
    el.adminPendingApprovals.innerHTML = state.pendingApprovals
      .map(
        (txn) => `
          <div class="ledger-item">
            <div class="ledger-main">
              <strong>${txn.type}</strong>
              <span class="warn">${money(txn.amount)}</span>
            </div>
            <div class="ledger-meta">
              요청자: ${txn.actor || txn.from} · 대상: ${txn.to}
              <br/>요청 시각: ${formatDateTime(txn.ts)}
              <br/>메모: ${txn.memo || "-"}
              <div class="ledger-actions">
                <button class="btn-primary small-btn" data-txn="${txn.id}" data-action="approve">승인</button>
                <button class="ghost-btn small-btn" data-txn="${txn.id}" data-action="reject">거부</button>
              </div>
            </div>
          </div>
        `
      )
      .join("");
  }

  el.accountsTable.querySelectorAll("button[data-select]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedAccountNo = btn.getAttribute("data-select");
      render();
    });
  });

  el.adminPendingApprovals.querySelectorAll("button[data-action]").forEach((btn) => {
    const txnId = btn.getAttribute("data-txn");
    if (btn.getAttribute("data-action") === "approve") {
      btn.addEventListener("click", () => approvePendingTransaction(txnId));
    } else {
      btn.addEventListener("click", () => rejectPendingTransaction(txnId));
    }
  });
}

async function render() {
  if (!state.me) {
    setSessionView(false);
    return;
  }

  setSessionView(true, state.me.role);
  if (state.me.role === "admin") {
    await fetchAdminData();
    renderAdmin();
    return;
  }

  await fetchCustomerData();
  renderCustomer();
}

async function login() {
  const accountNo = el.accountInput.value.trim();
  const pin = el.pinInput.value.trim();
  const role = el.roleSelect.value;
  if (!accountNo || !pin) {
    throw new Error("계좌번호/ID와 PIN을 입력하세요.");
  }
  const data = await api("/login", {
    method: "POST",
    body: { accountNo, pin, role },
  });
  state.token = data.token;
  localStorage.setItem(AUTH_STORAGE_KEY, state.token);
  state.me = data.account;
  state.config.approvalThreshold = data.approvalThreshold || state.config.approvalThreshold;
  el.accountInput.value = "";
  el.pinInput.value = "";
  await render();
  clearInputs();
  showToast("로그인되었습니다.");
}

async function logout() {
  if (state.token) {
    await api("/logout", { method: "POST" }).catch(() => {});
  }
  clearSession();
  setSessionView(false);
  showToast("로그아웃 되었습니다.");
}

async function doDeposit() {
  const amount = parseAmount(el.depositAmount.value);
  const memo = el.depositMemo.value.trim();
  await api("/deposit", { method: "POST", body: { amount, memo } });
  await render();
  clearInputs();
  showToast("입금 처리되었습니다.");
}

async function doWithdraw() {
  const amount = parseAmount(el.withdrawAmount.value);
  const memo = el.withdrawMemo.value.trim();
  await api("/withdraw", { method: "POST", body: { amount, memo } });
  await render();
  clearInputs();
  showToast("출금 처리되었습니다.");
}

async function doTransfer() {
  const toAccountNo = el.transferTo.value.trim();
  const amount = parseAmount(el.transferAmount.value);
  const memo = `이체 ${toAccountNo}`;
  const data = await api("/transfer", { method: "POST", body: { toAccountNo, amount, memo } });

  if (data.transaction?.status === "PENDING_APPROVAL") {
    showToast("대량 이체 요청이 승인 대기 상태로 등록되었습니다.", false);
  } else {
    showToast("이체가 완료되었습니다.", false);
  }
  await render();
  clearInputs();
}

async function createAccount() {
  const name = el.newName.value.trim();
  const pin = el.newPin.value.trim();
  const initialBalance = Number(el.initialBalance.value || 0);
  if (!name) throw new Error("예금주명을 입력하세요.");
  if (!/^[0-9]{4,8}$/.test(pin)) throw new Error("PIN은 숫자 4~8자리여야 합니다.");
  if (!Number.isFinite(initialBalance) || initialBalance < 0 || Math.floor(initialBalance) !== initialBalance) {
    throw new Error("초기 입금은 0 이상의 정수여야 합니다.");
  }
  const created = await api("/admin/accounts", {
    method: "POST",
    body: { name, pin, initialBalance },
  });
  await render();
  clearInputs();
  showToast(`새 계좌 ${created.accountNo}가 생성되었습니다.`);
}

function validateAdminTarget() {
  if (!state.selectedAccountNo) throw new Error("관리 대상 계좌를 선택하세요.");
  const account = state.accounts.find((item) => item.accountNo === state.selectedAccountNo);
  if (!account) throw new Error("선택한 계좌가 없습니다.");
  return account;
}

async function adjustBalance() {
  const account = validateAdminTarget();
  const amount = parseAdjustAmount(el.targetAmount.value);
  const memo = el.targetMemo.value.trim();
  await api(`/admin/accounts/${account.accountNo}/adjust`, {
    method: "POST",
    body: { amount, memo },
  });
  await render();
  clearInputs();
  showToast("잔액 조정이 완료되었습니다.");
}

async function toggleFreeze() {
  const account = validateAdminTarget();
  await api(`/admin/accounts/${account.accountNo}/freeze`, {
    method: "POST",
    body: {},
  });
  await render();
  showToast(account.frozen ? "계좌가 해제될 예정입니다." : "계좌가 잠금 처리되었습니다.");
}

async function approvePendingTransaction(txnId) {
  const reason = window.prompt("승인 메모 (선택)") || "관리자 승인";
  await api(`/admin/transactions/${txnId}/approve`, {
    method: "POST",
    body: { reason },
  });
  await render();
  showToast("이체를 승인했습니다.");
}

async function rejectPendingTransaction(txnId) {
  const reason = window.prompt("거부 사유를 입력하세요.") || "관리자 거부";
  await api(`/admin/transactions/${txnId}/reject`, {
    method: "POST",
    body: { reason },
  });
  await render();
  showToast("이체 요청을 거부했습니다.");
}

function guard(role, callback) {
  if (!state.me || state.me.role !== role) {
    throw new Error("권한이 없습니다.");
  }
  return callback();
}

function wrapHandler(fn) {
  return async () => {
    try {
      await fn();
    } catch (error) {
      showToast(error.message || "요청을 처리하지 못했습니다.", true);
    }
  };
}

el.loginBtn.addEventListener("click", wrapHandler(login));
el.logoutBtn.addEventListener("click", wrapHandler(logout));
el.depositBtn.addEventListener("click", wrapHandler(doDeposit));
el.withdrawBtn.addEventListener("click", wrapHandler(doWithdraw));
el.transferBtn.addEventListener("click", wrapHandler(doTransfer));
el.createAccountBtn.addEventListener("click", wrapHandler(createAccount));
el.adjustBtn.addEventListener("click", wrapHandler(() => guard("admin", adjustBalance)));
el.freezeBtn.addEventListener("click", wrapHandler(() => guard("admin", toggleFreeze)));

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !state.me) {
    wrapHandler(login)();
  }
});

(async function init() {
  const restored = await restoreSession();
  if (!restored) {
    setSessionView(false);
    return;
  }
  await render();
})();
