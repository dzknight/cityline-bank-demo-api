# Cityline Bank Ops (Frontend + Express API)

## 실행 방법

1. 의존성 설치

```
cd server
npm install
cd ..
```

2) `.env` 환경 변수 준비

루트의 `.env.example`을 복사해서 `server/.env`를 만듭니다.

```powershell
cp .env.example server/.env
```

아래 항목을 실제 값으로 변경합니다.

```env
PORT=4000

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_db_password
DB_NAME=cityline_bank

JWT_SECRET=change_me_to_random_value

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
EMAIL_FROM=Cityline Bank <your_email@gmail.com>
```

이체 완료 시 고객 메일 알림을 사용하려면 `.env`에 SMTP를 설정하세요.

`server/.env`에 추가:

```env
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=mail-user@example.com
SMTP_PASS=mail-password
EMAIL_FROM="Cityline Bank <noreply@cityline-bank.local>"
```

실행 후 콘솔에 `메일 발송 비활성화` 메시지가 보이면 아래 중 하나가 비어 있는 상태입니다.

- `SMTP_HOST`
- `SMTP_USER`
- `SMTP_PASS`

설정값을 채운 뒤 서버를 재시작해야 즉시 반영됩니다.

3) MariaDB 실행 및 환경 변수 설정

`server/.env` 예시:

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=1111
MYSQL_DATABASE=cityline_bank
PORT=4000
```

`.env` 파일은 `server/.env.example`을 복사해 사용하세요.
`server/.env`의 DB 계정이 생성/쓰기 권한이 있으면 서버 기동 시 데이터베이스(`cityline_bank`)를 자동 생성합니다.

3. 백엔드/정적 서버 실행

```
npm --prefix server run start
```

4. 브라우저에서 접속

- `http://localhost:4000`

## 기본 계정

- 관리자: `ADMIN / PIN: 0000`
- 고객: `1000001 / PIN: 1234`
- 고객: `1000002 / PIN: 4321`

## 주요 동작

- 로그인은 서버의 토큰 기반 인증으로 동작
- 이체 금액이 `100000`원 이상이면 `PENDING_APPROVAL` 상태로 저장
- 관리자 화면에서 대기 이체를 **승인/거부** 가능
- 감사 로그와 계좌 상태/조정/이메일 변경 내역은 모두 서버 트랜잭션으로 기록
- 거래 기록(transactions)은 MariaDB(`transactions` 테이블)에 영구 저장

## API 명세서

- 전체 API 스펙: [`API.md`](API.md)
- Swagger(OpenAPI): [`openapi.yaml`](openapi.yaml)

## Swagger UI 실행 방법

`openapi.yaml`을 바로 확인하려면 Swagger 공식 Docker 이미지를 사용하세요.

1) Docker 실행

```bash
docker run --rm \
  -p 8080:8080 \
  -e SWAGGER_JSON=/spec/openapi.yaml \
  -v "%CD%\\openapi.yaml:/spec/openapi.yaml" \
  swaggerapi/swagger-ui
```

2) 브라우저에서 접속

- `http://localhost:8080`

3) (선택) 서버 주소 변경

- Swagger UI 상단의 "Try it out"에서 `Servers`의 URL을 `http://localhost:4000`로 맞추면 `/api/*` 호출이 백엔드로 연결됩니다.

## 개발 시 참고

- 백엔드가 `http://localhost:4000`에서 동작해야 Swagger 요청이 정상 동작합니다.
