# Cityline Bank API 명세서

최종 반영 기준: `server/index.js` 현재 라우트 기준

## 1) 공통

- Base URL: `http://localhost:4000`
- Content-Type: `application/json`
- 인증 헤더: `x-auth-token: <token>` (`/api/login` 응답 토큰 사용)
- 인증 필요 라우트: 로그인/승인/거래/관리 API 대부분

## 2) 공통 응답 포맷

- 성공
  - `200 OK`
  - `200`, `201`, `202` 응답 모두 JSON 바디를 반환
- 실패
  - 에러 응답은 보통 `{ "error": "ERROR_CODE", "message": "..." }`
  - 일부 라우트는 추가 데이터(`transaction`)가 함께 반환됨

## 3) 공통 데이터 스키마

- 계좌 객체
```json
{
  "accountNo": "1000001",
  "role": "customer",
  "name": "홍길동",
  "balance": 120000,
  "frozen": false,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

- 거래 객체
```json
{
  "id": "txn_1710000000000_1234",
  "ts": "2026-02-22T00:00:00.000Z",
  "type": "이체",
  "actor": "1000001",
  "from": "1000001",
  "to": "1000002",
  "amount": 3000,
  "memo": "이체 1000002",
  "status": "COMPLETED",
  "approval": {
    "by": "ADMIN",
    "at": "2026-02-22T00:00:01.000Z",
    "reason": "관리자 승인"
  }
}
```

- 승인이 없는 경우: `"approval": null`

## 4) 인증/세션

### 4.1 `POST /api/login`
- 설명: 계좌번호/핀으로 로그인
- 인증 불필요
- Request
```json
{
  "accountNo": "1000001",
  "pin": "1234",
  "role": "customer"
}
```
- Success `200`
```json
{
  "token": "sess_...",
  "account": { ...계좌객체 },
  "approvalThreshold": 100000
}
```
- Error
  - `401` `INVALID_CREDENTIALS`

### 4.2 `POST /api/logout`
- 설명: 현재 세션 토큰 무효화
- Header: `x-auth-token`
- Success `200`
```json
{ "ok": true }
```

## 5) 계정/설정 조회

### 5.1 `GET /api/health`
- 설명: 서버/DB 연결 확인
- 인증 불필요
- Success `200`
```json
{ "ok": true }
```

### 5.2 `GET /api/me`
- Header: `x-auth-token`
- Success `200`
```json
{
  "account": { ...계좌객체 },
  "approvalThreshold": 100000
}
```

### 5.3 `GET /api/config`
- Header: `x-auth-token`
- Success `200`
```json
{ "approvalThreshold": 100000 }
```

### 5.4 `GET /api/fx`
- 설명: 환율 조회 프록시(운영용)
- 인증 불필요
- Query
  - `from` (optional): 통화 코드 3자리, 기본값 `USD`
  - `to` (optional): 통화 코드 3자리, 기본값 `KRW`
- Success `200`
```json
{
  "pair": "USD_KRW",
  "from": "USD",
  "to": "KRW",
  "rate": 1387.25,
  "source": "api.frankfurter.app (rates)",
  "fetchedAt": "2026-02-28T12:34:56.789Z",
  "cached": false,
  "stale": false
}
```
- 비고
  - 환율 조회 실패 시 캐시값이 있으면 `cached: true`, `stale: true`로 응답합니다.
- Error
  - `400` `BAD_CURRENCY`
  - `502` `FX_RATE_FETCH_ERROR`

### 5.5 `GET /api/fx/usd-krw`
- 설명: 레거시 호환 USD/KRW 전용 엔드포인트
- 인증 불필요
- Success는 5.4와 동일한 스키마를 반환합니다.

## 6) 거래 조회

### 6.1 `GET /api/transactions`
- Header: `x-auth-token`
- Query
  - `status` (optional): `COMPLETED`, `PENDING_APPROVAL`, `REJECTED`, `FAILED`
- 권한
  - customer: 본인 계좌 관련 거래만 반환
  - admin: 전체 거래 반환
- Success `200`
```json
{ "transactions": [ { ...거래객체 }, ... ] }
```

### 6.2 `GET /api/pending-transfers`
- Header: `x-auth-token`
- 설명: 이체(`이체`) 중 `PENDING_APPROVAL` 상태만 반환
- Success `200`
```json
{ "transactions": [ { ...거래객체 }, ... ] }
```

## 7) 고객 거래 API

### 7.1 `POST /api/deposit`
- Header: `x-auth-token` (고객/관리자 모두 가능)
- Request
```json
{
  "amount": 10000,
  "memo": "자유 입력"
}
```
- Success `201`
```json
{ "transaction": { ...거래객체 } }
```
- Error
  - `400` `BAD_AMOUNT`
  - `423` `ACCOUNT_FROZEN`
  - `500` `DB_ERROR`

### 7.2 `POST /api/withdraw`
- Header: `x-auth-token`
- Request
```json
{
  "amount": 5000,
  "memo": "자유 입력"
}
```
- Success `201`
- Error
  - `400` `BAD_AMOUNT`
  - `409` `INSUFFICIENT_FUNDS`
  - `423` `ACCOUNT_FROZEN`

### 7.3 `POST /api/transfer`
- Header: `x-auth-token`
- Request
```json
{
  "toAccountNo": "1000002",
  "amount": 20000,
  "memo": "이체 1000002"
}
```
- Success
  - `201` 즉시 완료
  - `202` 임계치(현재 `approvalThreshold`) 초과/해당 시 승인대기
```json
{
  "transaction": { ...거래객체 },
  "isPendingApproval": false
}
```
- Error
  - `400` `RECEIVER_REQUIRED`
  - `404` `RECEIVER_NOT_FOUND`
  - `409` `INSUFFICIENT_FUNDS`, `SELF_TRANSFER_NOT_ALLOWED`
  - `423` `ACCOUNT_FROZEN`, `RECEIVER_FROZEN`

## 8) 관리자 전용 API

공통: `requireAdmin` 적용, `x-auth-token` 필수

### 8.1 `GET /api/accounts`
- 계정 목록 반환
- Success `200`
```json
{ "accounts": [ { ...계좌객체 }, ... ] }
```

### 8.2 `POST /api/admin/accounts`
- 새 고객 계좌 생성
- Request
```json
{
  "name": "홍길동",
  "pin": "5678",
  "initialBalance": 10000
}
```
- Success `201`
```json
{
  "accountNo": "1000003",
  "account": { ...계좌객체 },
  "transaction": { ...거래객체 }
}
```
- Error
  - `400` `NAME_REQUIRED`, `BAD_PIN`, `BAD_INITIAL_BALANCE`

### 8.3 `POST /api/admin/accounts/:accountNo/adjust`
- 특정 계좌 잔액 조정 (+/-)
- Request
```json
{
  "amount": -5000,
  "memo": "수수료 조정"
}
```
- Success `201`
```json
{ "account": { ...계좌객체 }, "transaction": { ...거래객체 } }
```
- Error
  - `400` `BAD_AMOUNT`
  - `404` `ACCOUNT_NOT_FOUND`
  - `409` `INSUFFICIENT_FUNDS`
  - `423` `ACCOUNT_FROZEN`
  - `403` `CANNOT_MODIFY_ADMIN_ACCOUNT`

### 8.4 `POST /api/admin/accounts/:accountNo/freeze`
- 계좌 잠금/해제 토글
- Request (optional)
```json
{ "frozen": true }
```
- Success `200`
```json
{ "account": { ...계좌객체 }, "transaction": { ...거래객체 }, "updated": true }
```

### 8.5 `POST /api/admin/transactions/:txnId/approve`
- 대기 거래 승인
- Request
```json
{ "reason": "승인 사유" }
```
- Success `200`
```json
{ "transaction": { ...거래객체 } }
```
- Error
  - `404` `TRANSACTION_NOT_FOUND`
  - `409` `TRANSACTION_NOT_PENDING`, `INVALID_ACCOUNT`, `ACCOUNT_FROZEN`, `INSUFFICIENT_FUNDS`, `TRANSACTION_STATE_CHANGED`

### 8.6 `POST /api/admin/transactions/:txnId/reject`
- 대기 거래 반려
- Request
```json
{ "reason": "반려 사유" }
```
- Success `200`
```json
{ "transaction": { ...거래객체 } }
```
- Error
  - `404` `TRANSACTION_NOT_FOUND`
  - `409` `TRANSACTION_NOT_PENDING`, `TRANSACTION_STATE_CHANGED`

## 9) 에러 코드 정리 (자주 사용)

- 인증/권한: `AUTH_TOKEN_REQUIRED`(401), `FORBIDDEN`(403)
- 유효성: `BAD_AMOUNT`, `BAD_PIN`, `BAD_INITIAL_BALANCE`, `RECEIVER_REQUIRED`
- 환율: `BAD_CURRENCY`, `FX_RATE_FETCH_ERROR`
- 상태전이: `TRANSACTION_NOT_PENDING`, `TRANSACTION_STATE_CHANGED`
- 계좌 상태: `ACCOUNT_FROZEN`, `CANNOT_MODIFY_ADMIN_ACCOUNT`
- 거래 상태: `INSUFFICIENT_FUNDS`, `RECEIVER_NOT_FOUND`, `SELF_TRANSFER_NOT_ALLOWED`, `REJECTED`, `FAILED`
- 서버: `DB_ERROR`(5xx)

## 10) 요청 예시 (cURL)

- 건강체크
```bash
curl http://localhost:4000/api/health
```

- 로그인
```bash
curl -X POST http://localhost:4000/api/login \
  -H "Content-Type: application/json" \
  -d '{ "accountNo":"1000001", "pin":"1234", "role":"customer" }'
```

- 이체
```bash
curl -X POST http://localhost:4000/api/transfer \
  -H "Content-Type: application/json" \
  -H "x-auth-token: <TOKEN>" \
  -d '{ "toAccountNo":"1000002", "amount": 50000, "memo":"이체 1000002" }'
```

- 환율 조회 (USD→KRW)
```bash
curl "http://localhost:4000/api/fx?from=USD&to=KRW"
```

## 11) 참고

- 거래 내역은 `txn.type`이 한글로 내려오며(`입금`, `출금`, `이체`, `계좌 생성`, `관리자 조정`, `계좌 잠금`, `계좌 해제`) DB 저장 시에는 정규화 스키마 기준 enum으로 매핑됩니다.
- `/api/pending-transfers`는 현재 프런트 로직 기준 이체(`이체`)만 반환되도록 필터링됩니다.
