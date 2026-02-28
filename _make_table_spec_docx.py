import datetime
import html
import re
import zipfile
from pathlib import Path

sections = [
    {
        "name": "users",
        "type": "테이블",
        "desc": "고객·관리자 기본 계정 정보 마스터.",
        "columns": [
            ["user_id", "BIGINT UNSIGNED", "PK, AUTO_INCREMENT", "사용자 고유 ID"],
            ["role", "ENUM('admin','customer')", "NOT NULL, DEFAULT 'customer'", "권한 구분"],
            ["login_id", "VARCHAR(64)", "UNIQUE, NOT NULL", "로그인 ID"],
            ["name", "VARCHAR(80)", "NOT NULL", "사용자 이름"],
            ["pin_hash", "VARBINARY(128)", "NOT NULL", "PIN 해시값"],
            ["is_active", "TINYINT(1)", "NOT NULL, DEFAULT 1", "활성 상태(1=활성, 0=비활성)"],
            ["created_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6)", "생성일시"],
            ["updated_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)", "수정일시"],
        ],
        "constraints": [
            ["PK", "PRIMARY KEY (user_id)"],
            ["UK", "UNIQUE KEY (login_id)"],
        ]
    },
    {
        "name": "accounts",
        "type": "테이블",
        "desc": "사용자 소유의 은행 계좌 정보. 다수 계좌 확장을 고려한 구조.",
        "columns": [
            ["account_id", "BIGINT UNSIGNED", "PK, AUTO_INCREMENT", "계좌 고유 ID"],
            ["account_no", "VARCHAR(64)", "UNIQUE, NOT NULL", "계좌번호"],
            ["user_id", "BIGINT UNSIGNED", "FK, NOT NULL", "사용자(user) 참조 키"],
            ["balance", "BIGINT", "NOT NULL, DEFAULT 0", "현재 잔액"],
            ["is_frozen", "TINYINT(1)", "NOT NULL, DEFAULT 0", "잠김 상태(1=동결)"],
            ["created_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6)", "생성일시"],
            ["updated_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)", "수정일시"],
        ],
        "constraints": [
            ["PK", "PRIMARY KEY (account_id)"],
            ["FK", "fk_accounts_user: accounts.user_id -> users.user_id (ON UPDATE CASCADE, ON DELETE RESTRICT)"],
            ["UK", "UNIQUE KEY (account_no)"],
            ["IDX", "INDEX idx_accounts_user (user_id)"],
            ["IDX", "INDEX idx_accounts_frozen (is_frozen)"],
        ]
    },
    {
        "name": "transactions",
        "type": "테이블",
        "desc": "거래 본문(헤더). 승인대기/완료/반려 상태를 관리.",
        "columns": [
            ["transaction_id", "BIGINT UNSIGNED", "PK, AUTO_INCREMENT", "거래 고유 ID"],
            ["txn_key", "VARCHAR(64)", "UNIQUE, NOT NULL", "거래키(중복방지용)"],
            ["type", "ENUM('DEPOSIT','WITHDRAW','TRANSFER','ACCOUNT_CREATE','ADMIN_ADJUST','ACCOUNT_FREEZE','ACCOUNT_UNFREEZE')", "NOT NULL", "거래 유형"],
            ["status", "ENUM('PENDING_APPROVAL','COMPLETED','REJECTED','FAILED')", "NOT NULL, DEFAULT 'COMPLETED'", "거래 상태"],
            ["actor_account_id", "BIGINT UNSIGNED", "NULL 허용, FK", "요청 계좌"],
            ["memo", "VARCHAR(255)", "NULL 허용", "거래 메모"],
            ["request_ip", "VARBINARY(16)", "NULL 허용", "요청 IP"],
            ["idempotency_key", "VARCHAR(128)", "UNIQUE, NULL 허용", "멱등키"],
            ["created_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6)", "생성일시"],
            ["updated_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)", "수정일시"],
        ],
        "constraints": [
            ["PK", "PRIMARY KEY (transaction_id)"],
            ["FK", "fk_transactions_actor_account: transactions.actor_account_id -> accounts.account_id (ON UPDATE CASCADE, ON DELETE SET NULL)"],
            ["UK", "UNIQUE KEY uniq_idempotency (idempotency_key)"],
            ["IDX", "INDEX idx_tx_status_created (status, created_at)"],
            ["IDX", "INDEX idx_tx_actor_created (actor_account_id, created_at)"],
        ]
    },
    {
        "name": "transaction_entries",
        "type": "테이블",
        "desc": "거래 항목(이중분개). 하나의 거래를 여러 계좌 항목으로 분해.",
        "columns": [
            ["entry_id", "BIGINT UNSIGNED", "PK, AUTO_INCREMENT", "항목 고유 ID"],
            ["transaction_id", "BIGINT UNSIGNED", "FK, NOT NULL", "거래 헤더 참조"],
            ["account_id", "BIGINT UNSIGNED", "FK, NOT NULL", "계좌 참조"],
            ["entry_type", "ENUM('DEBIT','CREDIT')", "NOT NULL", "차변/대변"],
            ["amount", "BIGINT", "NOT NULL, CHECK (amount > 0)", "금액"],
            ["counterparty_account_id", "BIGINT UNSIGNED", "NULL 허용, FK", "상대 계좌"],
            ["balance_after", "BIGINT", "NULL 허용", "처리 후 잔액"],
            ["created_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6)", "생성일시"],
        ],
        "constraints": [
            ["PK", "PRIMARY KEY (entry_id)"],
            ["FK", "fk_entries_txn: transaction_entries.transaction_id -> transactions.transaction_id (ON UPDATE CASCADE, ON DELETE CASCADE)"],
            ["FK", "fk_entries_account: transaction_entries.account_id -> accounts.account_id (ON UPDATE CASCADE, ON DELETE RESTRICT)"],
            ["FK", "fk_entries_counterparty: transaction_entries.counterparty_account_id -> accounts.account_id (ON UPDATE CASCADE, ON DELETE SET NULL)"],
            ["UK", "UNIQUE KEY uniq_entry_side (transaction_id, account_id, entry_type)"],
            ["IDX", "INDEX idx_entries_account_created (account_id, created_at)"],
            ["IDX", "INDEX idx_entries_txn (transaction_id)"],
        ]
    },
    {
        "name": "transaction_reviews",
        "type": "테이블",
        "desc": "승인/반려 이력 테이블(고액 이체 등 승인 워크플로우).",
        "columns": [
            ["review_id", "BIGINT UNSIGNED", "PK, AUTO_INCREMENT", "심사 이력 ID"],
            ["transaction_id", "BIGINT UNSIGNED", "FK, NOT NULL", "거래 참조"],
            ["reviewer_account_id", "BIGINT UNSIGNED", "NULL 허용, FK", "승인자 계좌"],
            ["decision", "ENUM('APPROVED','REJECTED')", "NOT NULL", "승인/반려"],
            ["reason", "VARCHAR(255)", "NULL 허용", "승인/반려 사유"],
            ["decided_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6)", "의사결정일시"],
        ],
        "constraints": [
            ["PK", "PRIMARY KEY (review_id)"],
            ["FK", "fk_reviews_txn: transaction_reviews.transaction_id -> transactions.transaction_id (ON UPDATE CASCADE, ON DELETE CASCADE)"],
            ["FK", "fk_reviews_reviewer: transaction_reviews.reviewer_account_id -> accounts.account_id (ON UPDATE CASCADE, ON DELETE SET NULL)"],
            ["IDX", "INDEX idx_reviews_txn (transaction_id)"],
            ["IDX", "INDEX idx_reviews_reviewer (reviewer_account_id, decided_at)"],
        ]
    },
    {
        "name": "account_status_history",
        "type": "테이블",
        "desc": "계좌 상태 변경 이력(동결/해제 추적).",
        "columns": [
            ["history_id", "BIGINT UNSIGNED", "PK, AUTO_INCREMENT", "이력 ID"],
            ["account_id", "BIGINT UNSIGNED", "FK, NOT NULL", "대상 계좌"],
            ["changed_by_account_id", "BIGINT UNSIGNED", "NULL 허용, FK", "변경자"],
            ["previous_state", "TINYINT(1)", "NOT NULL", "이전 상태"],
            ["new_state", "TINYINT(1)", "NOT NULL", "변경 후 상태"],
            ["reason", "VARCHAR(255)", "NULL 허용", "변경 사유"],
            ["changed_at", "DATETIME(6)", "NOT NULL, DEFAULT CURRENT_TIMESTAMP(6)", "변경일시"],
        ],
        "constraints": [
            ["PK", "PRIMARY KEY (history_id)"],
            ["FK", "fk_status_history_account: account_status_history.account_id -> accounts.account_id (ON UPDATE CASCADE, ON DELETE RESTRICT)"],
            ["FK", "fk_status_history_actor: account_status_history.changed_by_account_id -> accounts.account_id (ON UPDATE CASCADE, ON DELETE SET NULL)"],
            ["IDX", "INDEX idx_status_history_account (account_id, changed_at)"],
        ]
    },
    {
        "name": "v_account_balance_snapshot",
        "type": "뷰",
        "desc": "대시보드 조회용 잔액 스냅샷 뷰.",
        "columns": [
            ["account_id", "BIGINT", "", "계좌 ID"],
            ["account_no", "VARCHAR(64)", "", "계좌번호"],
            ["balance", "BIGINT", "", "현재 잔액"],
            ["name", "VARCHAR(80)", "", "소유자 이름"],
            ["login_id", "VARCHAR(64)", "", "로그인 ID"],
            ["role", "ENUM('admin','customer')", "", "권한"],
            ["is_frozen", "TINYINT(1)", "", "잠김 상태"],
            ["updated_at", "DATETIME(6)", "", "최근 업데이트 일시"],
        ],
        "constraints": [
            ["Type", "CREATE OR REPLACE VIEW"],
            ["Source", "accounts JOIN users ON users.user_id = accounts.user_id"],
            ["Columns", "account_id, account_no, balance, name, login_id, role, is_frozen, updated_at"],
        ]
    },
]

def esc(s: str) -> str:
    return html.escape(s or "")


def para(text: str, bold: bool = False, size: str | None = None) -> str:
    text = esc(text)
    rprops = ""
    if bold:
        rprops += '<w:b/>'
    if size:
        rprops += f'<w:sz w:val="{size}"/>'
    if rprops:
        rprops = f'<w:rPr>{rprops}</w:rPr>'
    return f'<w:p><w:r>{rprops}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def heading(text: str, level: int = 1) -> str:
    # Heading1, Heading2를 스타일 참조
    style = 'Heading1' if level == 1 else 'Heading2'
    size = '36' if level == 1 else '28'
    text = esc(text)
    return f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="{size}"/></w:rPr><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def build_table(headers, rows, widths):
    def col(text, w, bold=False):
        t = esc(text)
        rpr = '<w:rPr><w:b/></w:rPr>' if bold else ''
        return (
            '<w:tc>'
            f'<w:tcPr><w:tcW w:w="{w}" w:type="dxa"/></w:tcPr>'
            '<w:p><w:r>' + rpr + f'<w:t xml:space="preserve">{t}</w:t></w:r></w:p>'
            '</w:tc>'
        )

    def row(values, is_header=False):
        cells = ''.join(col(v, w, is_header) for (v, w) in zip(values, widths))
        return f'<w:tr>{cells}</w:tr>'

    grid = ''.join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    body = row(headers, True) + ''.join(row(r) for r in rows)
    return (
        '<w:tbl>'
        '<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
        f'<w:tblGrid>{grid}</w:tblGrid>'
        f'{body}'
        '</w:tbl>'
    )


def section(item):
    out = []
    out.append(heading(f"{item['name']} ({item['type']})", 2))
    out.append(para(item['desc']))

    out.append(heading('컬럼 정의', 2))
    out.append(build_table(
        ["컬럼명", "자료형", "제약/기본값", "설명"],
        item['columns'],
        ['1800', '2600', '2200', '2400']
    ))

    out.append(heading('제약/인덱스/관계', 2))
    out.append(build_table(
        ["구분", "내용"],
        item['constraints'],
        ['1600', '6800']
    ))
    return ''.join(out)


def document_xml(sections):
    parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>']
    body = [
        '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
        ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
        ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
        ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
        ' xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
        ' xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"',
        ' mc:Ignorable="w14 w15 w16se">',
    ]
    body.append('<w:body>')
    body.append(heading('MariaDB 정규화 스키마 테이블명세서', 1))
    body.append(para(f"작성일시: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"))
    body.append(para('본 문서는 대규모 사용자를 고려해 정규화한 핵심 스키마 기준으로 작성되었습니다.'))

    body.append(heading('개요(ERD 관점)', 2))
    body.append(para('users 1:N accounts, accounts 1:N transactions/transaction_entries/transaction_reviews/account_status_history'))
    body.append(para('transactions 1:N transaction_entries 및 transaction_reviews'))

    for item in sections:
        body.append(section(item))

    body.append('<w:sectPr>')
    body.append('<w:pgSz w:w="12240" w:h="15840"/>')
    body.append('<w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="720" w:footer="720" w:gutter="0"/>')
    body.append('<w:cols w:space="720"/>')
    body.append('<w:docGrid w:linePitch="360"/>')
    body.append('</w:sectPr>')

    body.append('</w:body></w:document>')
    return '\n'.join(parts + body)


def content_types():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''


def root_rels():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''


def doc_rels():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def styles():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr/></w:rPrDefault>
    <w:pPrDefault><w:pPr/></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:qFormat/>
  </w:style>
</w:styles>'''


def core_props():
    now = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:dcterms="http://purl.org/dc/terms/"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>MariaDB Table Specification</dc:title>
  <dc:creator>Cityline</dc:creator>
  <cp:lastModifiedBy>Cityline</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>'''


def app_props():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Cityline Bank Demo</Application>
  <Company>Cityline</Company>
</Properties>'''


def sanitize(text: str) -> str:
    return re.sub(r'[^\x20-\x7E\uAC00-\uD7A3\u3130-\u318F]', '', text)

out = Path('d:/260222/table-spec.docx')
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('[Content_Types].xml', content_types())
    zf.writestr('_rels/.rels', root_rels())
    zf.writestr('word/document.xml', document_xml(sections))
    zf.writestr('word/_rels/document.xml.rels', doc_rels())
    zf.writestr('word/styles.xml', styles())
    zf.writestr('docProps/core.xml', core_props())
    zf.writestr('docProps/app.xml', app_props())

print(str(out))
