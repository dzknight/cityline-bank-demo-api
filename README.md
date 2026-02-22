# Cityline Bank Ops (Frontend + Express API)

## 실행 방법

1. 의존성 설치

```
cd server
npm install
cd ..
```

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

2. 백엔드/정적 서버 실행

```
npm --prefix server run start
```

3. 브라우저에서 접속

- `http://localhost:4000`

## 기본 계정

- 관리자: `ADMIN / PIN: 0000`
- 고객: `1000001 / PIN: 1234`
- 고객: `1000002 / PIN: 4321`

## 주요 동작

- 로그인은 서버의 토큰 기반 인증으로 동작
- 이체 금액이 `100000`원 이상이면 `PENDING_APPROVAL` 상태로 저장
- 관리자 화면에서 대기 이체를 **승인/거부** 가능
- 감사 로그와 계좌 상태/조정 내역은 모두 서버 트랜잭션으로 기록
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
