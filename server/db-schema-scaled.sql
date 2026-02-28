-- 스케일 아웃 대비 정규화 스키마 (MariaDB / InnoDB)
-- 목적:
-- 1) 계좌/사용자/거래 본문/거래 항목을 분리
-- 2) 조회 패턴(고객별 내역, 상태 조회, 승인 대기 조회)에 맞춘 인덱스 강화
-- 3) 감사 추적 및 승인 이력 보존

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS `cityline_bank`;
USE `cityline_bank`;

-- 사용자/고객 마스터
CREATE TABLE IF NOT EXISTS `users` (
  `user_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `role` ENUM('admin', 'customer') NOT NULL DEFAULT 'customer',
  `login_id` VARCHAR(64) NOT NULL UNIQUE,
  `name` VARCHAR(80) NOT NULL,
  `email` VARCHAR(255) NULL,
  `postcode` VARCHAR(20) NULL,
  `address` VARCHAR(255) NULL,
  `pin_hash` VARBINARY(128) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 계좌 마스터 (한 계좌는 한 명의 사용자 소유, 다중 계좌 설계를 고려)
CREATE TABLE IF NOT EXISTS `accounts` (
  `account_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `account_no` VARCHAR(64) NOT NULL UNIQUE,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `balance` BIGINT NOT NULL DEFAULT 0,
  `is_frozen` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`account_id`),
  CONSTRAINT `fk_accounts_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  INDEX `idx_accounts_user` (`user_id`),
  INDEX `idx_accounts_frozen` (`is_frozen`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 거래 본문: 입금/출금/이체/조정/잠금처리/승인 처리 타입 저장
CREATE TABLE IF NOT EXISTS `transactions` (
  `transaction_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `txn_key` VARCHAR(64) NOT NULL UNIQUE,
  `type` ENUM('DEPOSIT', 'WITHDRAW', 'TRANSFER', 'ACCOUNT_CREATE', 'ADMIN_ADJUST', 'ACCOUNT_FREEZE', 'ACCOUNT_UNFREEZE') NOT NULL,
  `status` ENUM('PENDING_APPROVAL', 'COMPLETED', 'REJECTED', 'FAILED') NOT NULL DEFAULT 'COMPLETED',
  `actor_account_id` BIGINT UNSIGNED NULL,
  `memo` VARCHAR(255) NULL,
  `request_ip` VARBINARY(16) NULL,
  `idempotency_key` VARCHAR(128) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`transaction_id`),
  CONSTRAINT `fk_transactions_actor_account`
    FOREIGN KEY (`actor_account_id`) REFERENCES `accounts` (`account_id`)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  INDEX `idx_tx_status_created` (`status`, `created_at`),
  INDEX `idx_tx_actor_created` (`actor_account_id`, `created_at`),
  UNIQUE KEY `uniq_idempotency` (`idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 거래 항목(이중분개): 하나의 거래는 여러 계좌 항목을 가짐
CREATE TABLE IF NOT EXISTS `transaction_entries` (
  `entry_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `transaction_id` BIGINT UNSIGNED NOT NULL,
  `account_id` BIGINT UNSIGNED NOT NULL,
  `entry_type` ENUM('DEBIT', 'CREDIT') NOT NULL,
  `amount` BIGINT NOT NULL CHECK (`amount` > 0),
  `counterparty_account_id` BIGINT UNSIGNED NULL,
  `balance_after` BIGINT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`entry_id`),
  CONSTRAINT `fk_entries_txn`
    FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`transaction_id`)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT `fk_entries_account`
    FOREIGN KEY (`account_id`) REFERENCES `accounts` (`account_id`)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT `fk_entries_counterparty`
    FOREIGN KEY (`counterparty_account_id`) REFERENCES `accounts` (`account_id`)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  UNIQUE KEY `uniq_entry_side` (`transaction_id`, `account_id`, `entry_type`),
  INDEX `idx_entries_account_created` (`account_id`, `created_at`),
  INDEX `idx_entries_txn` (`transaction_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
/* 월별 파티션(선택)
PARTITION BY RANGE (TO_DAYS(created_at)) (
  PARTITION p_2026_01 VALUES LESS THAN (TO_DAYS('2026-02-01')),
  PARTITION p_2026_02 VALUES LESS THAN (TO_DAYS('2026-03-01')),
  PARTITION p_max    VALUES LESS THAN MAXVALUE
)
*/;

-- 승인/반려 이력 분리
CREATE TABLE IF NOT EXISTS `transaction_reviews` (
  `review_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `transaction_id` BIGINT UNSIGNED NOT NULL,
  `reviewer_account_id` BIGINT UNSIGNED NULL,
  `decision` ENUM('APPROVED', 'REJECTED') NOT NULL,
  `reason` VARCHAR(255) NULL,
  `decided_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`review_id`),
  CONSTRAINT `fk_reviews_txn`
    FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`transaction_id`)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT `fk_reviews_reviewer`
    FOREIGN KEY (`reviewer_account_id`) REFERENCES `accounts` (`account_id`)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  INDEX `idx_reviews_txn` (`transaction_id`),
  INDEX `idx_reviews_reviewer` (`reviewer_account_id`, `decided_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 계좌 상태 변화 감사를 별도 적재(감사/감사추적 확장용)
CREATE TABLE IF NOT EXISTS `account_status_history` (
  `history_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `account_id` BIGINT UNSIGNED NOT NULL,
  `changed_by_account_id` BIGINT UNSIGNED NULL,
  `previous_state` TINYINT(1) NOT NULL,
  `new_state` TINYINT(1) NOT NULL,
  `reason` VARCHAR(255) NULL,
  `changed_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`history_id`),
  CONSTRAINT `fk_status_history_account`
    FOREIGN KEY (`account_id`) REFERENCES `accounts` (`account_id`)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT `fk_status_history_actor`
    FOREIGN KEY (`changed_by_account_id`) REFERENCES `accounts` (`account_id`)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  INDEX `idx_status_history_account` (`account_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 읽기 최적화용 집계 뷰(대시보드용)
CREATE OR REPLACE VIEW `v_account_balance_snapshot` AS
SELECT
  a.account_id,
  a.account_no,
  a.balance,
  u.name,
  u.login_id,
  u.role,
  a.is_frozen,
  a.updated_at
FROM accounts a
JOIN users u ON u.user_id = a.user_id;
