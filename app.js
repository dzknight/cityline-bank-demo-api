const API_BASE =
  window.location.protocol === "file:"
    ? "http://localhost:4000/api"
    : `${window.location.origin}/api`;
const AUTH_STORAGE_KEY = "cityline_bank_session_v2";
const FX_TICKER_INTERVAL_MS = 60_000;
const FX_TICKER_ENDPOINT = "/fx?from=USD&to=KRW";

const state = {
  token: localStorage.getItem(AUTH_STORAGE_KEY),
  me: null,
  config: { approvalThreshold: 100000 },
  accounts: [],
  txns: [],
  pendingApprovals: [],
  selectedAccountNo: null,
};
let fxTickerTimer = null;
let isFxRefreshing = false;
let fxLastUpdatedAt = null;
let fxLastUpdateStatus = "갱신 대기 중";

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
  profileSection: document.getElementById("profileSection"),
  profileAccount: document.getElementById("profileAccount"),
  profileName: document.getElementById("profileName"),
  profileEmail: document.getElementById("profileEmail"),
  profilePostcode: document.getElementById("profilePostcode"),
  profileAddress: document.getElementById("profileAddress"),
  profileAddressSearchBtn: document.getElementById("profileAddressSearchBtn"),
  profileCurrentPin: document.getElementById("profileCurrentPin"),
  profileNewPin: document.getElementById("profileNewPin"),
  updateProfileBtn: document.getElementById("updateProfileBtn"),
  fxTicker: document.getElementById("fxTicker"),
  fxRate: document.getElementById("fxRate"),
  fxUpdated: document.getElementById("fxUpdated"),
  fxRefreshBtn: document.getElementById("fxRefreshBtn"),
  fxRefreshLabel: document.querySelector("#fxRefreshBtn .fx-refresh-label"),
  fxRefreshIcon: document.querySelector("#fxRefreshBtn .fx-refresh-icon"),
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
  newEmail: document.getElementById("newEmail"),
  newPostcode: document.getElementById("newPostcode"),
  newAddress: document.getElementById("newAddress"),
  newAddressSearchBtn: document.getElementById("newAddressSearchBtn"),
  initialBalance: document.getElementById("initialBalance"),
  createAccountBtn: document.getElementById("createAccountBtn"),
  selectedAccount: document.getElementById("selectedAccount"),
  targetEmail: document.getElementById("targetEmail"),
  targetAmount: document.getElementById("targetAmount"),
  targetMemo: document.getElementById("targetMemo"),
  adjustBtn: document.getElementById("adjustBtn"),
  freezeBtn: document.getElementById("freezeBtn"),
  updateEmailBtn: document.getElementById("updateEmailBtn"),
};

function money(num) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
  }).format(Math.round(num || 0));
}

function fxMoney(num) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(num) ? num : 0);
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
  el.profileName.value = "";
  el.profileEmail.value = "";
  el.profilePostcode.value = "";
  el.profileAddress.value = "";
  el.profileCurrentPin.value = "";
  el.profileNewPin.value = "";
  el.newName.value = "";
  el.newPin.value = "";
  el.newEmail.value = "";
  el.newPostcode.value = "";
  el.newAddress.value = "";
  el.initialBalance.value = "";
  el.targetEmail.value = "";
  el.targetAmount.value = "";
  el.targetMemo.value = "";
}

function statusTag(status) {
  if (status === "PENDING_APPROVAL") return '<span class="tag warn">승인대기</span>';
  if (status === "REJECTED") return '<span class="tag freeze">거부</span>';
  if (status === "FAILED") return '<span class="tag freeze">실패</span>';
  return '<span class="tag">완료</span>';
}

function parseEmailChangeMemo(txn) {
  if (txn.type !== "이메일 변경") return null;
  const text = String(txn.memo || "");
  const matched = text.match(/^(.*?)\s*->\s*(.*?)$/);
  if (!matched) return { before: "-", after: "-" };
  const before = matched[1]?.trim() || "-";
  const after = matched[2]?.trim() || "-";
  return { before, after };
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
  el.profileSection.classList.toggle("hidden", !isSignedIn);
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

function renderProfilePanel() {
  if (!state.me) return;
  el.profileAccount.textContent = `${state.me.name} (${state.me.accountNo})`;
  el.profileName.value = state.me.name || "";
  el.profileEmail.value = state.me.email || "";
  el.profilePostcode.value = state.me.postcode || "";
  el.profileAddress.value = state.me.address || "";
  el.profileCurrentPin.value = "";
  el.profileNewPin.value = "";
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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function openDaumPostcode({ postcodeInput, addressInput }) {
  if (!window.daum || typeof window.daum.Postcode !== "function") {
    throw new Error("우편번호 검색 API 스크립트가 로드되지 않았습니다.");
  }

  new window.daum.Postcode({
    oncomplete: (data) => {
      postcodeInput.value = data.zonecode || "";
      addressInput.value = data.roadAddress || data.jibunAddress || data.address || "";
    },
  }).open();
}

async function fetchUsdToKrwRate() {
  const response = await fetch(`${API_BASE}${FX_TICKER_ENDPOINT}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`환율 API 응답 실패 (${response.status})`);
  }
  const data = await response.json();
  if (!Number.isFinite(Number(data.rate))) {
    throw new Error("환율 데이터 형식이 올바르지 않습니다.");
  }
  return {
    rate: Number(data.rate),
    source: data.source || "internal",
    fetchedAt: data.fetchedAt || null,
    cached: Boolean(data.cached),
    stale: Boolean(data.stale),
  };
}

async function refreshFxTicker() {
  if (!el.fxRate) return;
  if (isFxRefreshing) return;
  isFxRefreshing = true;
  if (el.fxRefreshBtn) {
    el.fxRefreshBtn.disabled = true;
    el.fxRefreshBtn.classList.add("is-refreshing");
    el.fxRefreshBtn.title = "환율 조회중...";
  }
  if (el.fxRefreshLabel) {
    el.fxRefreshLabel.textContent = "조회중...";
  }
  try {
    const { rate, source, fetchedAt, cached, stale } = await fetchUsdToKrwRate();
    const numericRate = Number(rate);
    if (!Number.isFinite(numericRate) || numericRate <= 0) {
      throw new Error("환율 데이터가 유효하지 않습니다.");
    }

    const suffix = stale ? " (임시)" : " (매매)";
    el.fxRate.textContent = `USD/KRW : ${fxMoney(numericRate)}${suffix}`;
    el.fxRate.classList.remove("fx-error", "fx-stale");
    if (stale) el.fxRate.classList.add("fx-stale");

    const updatedText = fetchedAt ? new Date(fetchedAt).toLocaleString("ko-KR") : new Date().toLocaleString("ko-KR");
    const statusText = stale ? "캐시(실시간 조회 실패)" : cached ? "캐시" : "실시간";
    fxLastUpdatedAt = updatedText;
    fxLastUpdateStatus = statusText;
    if (el.fxUpdated) {
      el.fxUpdated.textContent = `${updatedText} · ${source} · ${statusText}`;
    }
    const tooltipText = `마지막 갱신: ${updatedText}\n출처: ${source}\n상태: ${statusText}`;
    if (el.fxRefreshBtn) {
      el.fxRefreshBtn.title = tooltipText;
    }
    if (el.fxTicker) {
      el.fxTicker.title = tooltipText;
    }
  } catch (error) {
    el.fxRate.textContent = "USD/KRW: 조회 실패";
    el.fxRate.classList.add("fx-error");
    if (el.fxUpdated) {
      const failedAt = new Date().toLocaleTimeString("ko-KR");
      const recentText = fxLastUpdatedAt || failedAt;
      const statusText = fxLastUpdatedAt ? "최근 성공 갱신값 사용 중" : "갱신 실패";
      el.fxUpdated.textContent = `마지막 실패: ${failedAt} · ${statusText}`;
      const tooltipText = `마지막 갱신: ${recentText}\n현재 상태: ${statusText}`;
      if (el.fxRefreshBtn) {
        el.fxRefreshBtn.title = tooltipText;
      }
      if (el.fxTicker) {
        el.fxTicker.title = tooltipText;
      }
    }
    console.error("환율 조회 실패:", error.message);
  } finally {
    isFxRefreshing = false;
    if (el.fxRefreshBtn) {
      el.fxRefreshBtn.disabled = false;
      el.fxRefreshBtn.classList.remove("is-refreshing");
      if (fxLastUpdatedAt) {
        el.fxRefreshBtn.title = `마지막 갱신: ${fxLastUpdatedAt}\n상태: ${fxLastUpdateStatus}`;
      } else {
        el.fxRefreshBtn.title = "마지막 갱신: 없음";
      }
    }
    if (el.fxRefreshLabel) {
      el.fxRefreshLabel.textContent = "새로고침";
    }
  }
}

function startFxTicker() {
  if (fxTickerTimer) clearInterval(fxTickerTimer);
  void refreshFxTicker();
  fxTickerTimer = setInterval(() => {
    if (!document.hidden) void refreshFxTicker();
  }, FX_TICKER_INTERVAL_MS);
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
        <td>${account.email || "-"}</td>
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
          <th>이메일</th>
          <th>잔액</th>
          <th>상태</th>
          <th>작업</th>
        </tr>
      </thead>
      <tbody>${rows || "<tr><td colspan='6'>고객 계좌가 없습니다.</td></tr>"}</tbody>
    </table>
  `;

  const selected = state.accounts.find((account) => account.accountNo === state.selectedAccountNo);
  el.selectedAccount.textContent = selected ? `${selected.name} (${selected.accountNo})` : "없음";
  el.targetEmail.value = selected ? selected.email || "" : "";
  el.adjustBtn.disabled = !selected;
  el.freezeBtn.disabled = !selected;
  el.updateEmailBtn.disabled = !selected;

  if (state.txns.length === 0) {
    el.adminLedger.innerHTML = '<div class="ledger-item">감사 로그가 없습니다.</div>';
  } else {
    const emailChangeRows = state.txns.map((txn) => {
      const counterpart = `${txn.from || "-"} → ${txn.to || "-"}`;
      const emailChange = parseEmailChangeMemo(txn) || { before: "-", after: "-" };

      return `
        <tr>
          <td>${formatDateTime(txn.ts)}</td>
          <td>${txn.type}</td>
          <td>${txn.actor || "-"}</td>
          <td>${counterpart}</td>
          <td>${statusTag(txn.status)}</td>
          <td>${txn.type === "이메일 변경" ? "-" : money(txn.amount)}</td>
          <td>${emailChange.before}</td>
          <td>${emailChange.after}</td>
          <td>${txn.memo || "-"}</td>
        </tr>
      `;
    });

    el.adminLedger.innerHTML = `
      <table class="audit-log-table">
        <thead>
          <tr>
            <th>일시</th>
            <th>유형</th>
            <th>요청자</th>
            <th>상대</th>
            <th>상태</th>
            <th>금액</th>
            <th>이전 이메일</th>
            <th>변경 이메일</th>
            <th>메모</th>
          </tr>
        </thead>
        <tbody>${emailChangeRows.join("")}</tbody>
      </table>
    `;
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
  renderProfilePanel();

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
  const email = el.newEmail.value.trim();
  const postcode = el.newPostcode.value.trim();
  const address = el.newAddress.value.trim();
  const initialBalance = Number(el.initialBalance.value || 0);
  if (!name) throw new Error("예금주명을 입력하세요.");
  if (!/^[0-9]{4,8}$/.test(pin)) throw new Error("PIN은 숫자 4~8자리여야 합니다.");
  if (!Number.isFinite(initialBalance) || initialBalance < 0 || Math.floor(initialBalance) !== initialBalance) {
    throw new Error("초기 입금은 0 이상의 정수여야 합니다.");
  }
  if (email && !isValidEmail(email)) throw new Error("이메일 형식이 올바르지 않습니다.");
  const created = await api("/admin/accounts", {
    method: "POST",
    body: { name, pin, email: email || null, postcode, address, initialBalance },
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

async function updateSelectedEmail() {
  const account = validateAdminTarget();
  const emailValue = el.targetEmail.value.trim();
  if (emailValue && !isValidEmail(emailValue)) {
    throw new Error("이메일 형식이 올바르지 않습니다.");
  }
  await api(`/admin/accounts/${account.accountNo}/email`, {
    method: "PATCH",
    body: { email: emailValue || null },
  });
  await render();
  clearInputs();
  showToast("계좌 이메일이 수정되었습니다.");
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

async function updateProfile() {
  if (!state.me) throw new Error("로그인 후 이용 가능합니다.");

  const currentPin = el.profileCurrentPin.value.trim();
  const nextName = el.profileName.value.trim();
  const nextEmail = el.profileEmail.value.trim();
  const nextPostcode = el.profilePostcode.value.trim();
  const nextAddress = el.profileAddress.value.trim();
  const nextPin = el.profileNewPin.value.trim();

  if (!currentPin) throw new Error("현재 PIN을 입력하세요.");

  const hasNameChange = nextName !== (state.me.name || "");
  const hasEmailChange = nextEmail !== (state.me.email || "");
  const hasPostcodeChange = nextPostcode !== (state.me.postcode || "");
  const hasAddressChange = nextAddress !== (state.me.address || "");
  const hasPinChange = Boolean(nextPin);

  if (!hasNameChange && !hasEmailChange && !hasPostcodeChange && !hasAddressChange && !hasPinChange) {
    throw new Error("변경할 항목을 입력하세요.");
  }

  if (nextName === "") throw new Error("이름은 비워둘 수 없습니다.");
  if (hasPinChange && !/^[0-9]{4,8}$/.test(nextPin)) {
    throw new Error("새 PIN은 숫자 4~8자리여야 합니다.");
  }
  if (hasEmailChange && nextEmail && !isValidEmail(nextEmail)) {
    throw new Error("이메일 형식이 올바르지 않습니다.");
  }

  const body = { currentPin };
  if (hasNameChange) body.name = nextName;
  if (hasEmailChange) body.email = nextEmail || null;
  if (hasPostcodeChange) body.postcode = nextPostcode || null;
  if (hasAddressChange) body.address = nextAddress || null;
  if (hasPinChange) body.newPin = nextPin;

  const data = await api("/me", { method: "PATCH", body });
  state.me = data.account;
  await render();
  el.profileCurrentPin.value = "";
  el.profileNewPin.value = "";
  clearInputs();
  showToast(data.updated ? "내 정보가 수정되었습니다." : "변경된 내용이 없습니다.");
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
el.newAddressSearchBtn.addEventListener(
  "click",
  wrapHandler(() => openDaumPostcode({ postcodeInput: el.newPostcode, addressInput: el.newAddress }))
);
el.updateProfileBtn.addEventListener("click", wrapHandler(updateProfile));
el.profileAddressSearchBtn.addEventListener(
  "click",
  wrapHandler(() => openDaumPostcode({ postcodeInput: el.profilePostcode, addressInput: el.profileAddress }))
);
el.adjustBtn.addEventListener("click", wrapHandler(() => guard("admin", adjustBalance)));
el.freezeBtn.addEventListener("click", wrapHandler(() => guard("admin", toggleFreeze)));
el.updateEmailBtn.addEventListener("click", wrapHandler(() => guard("admin", updateSelectedEmail)));
el.fxRefreshBtn.addEventListener("click", () => {
  void refreshFxTicker();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !state.me) {
    wrapHandler(login)();
  }
});

(async function init() {
  startFxTicker();
  const restored = await restoreSession();
  if (!restored) {
    setSessionView(false);
    return;
  }
  await render();
})();
