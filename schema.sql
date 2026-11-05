CREATE DATABASE unilift
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 
USE unilift;

CREATE TABLE IF NOT EXISTS users (
  email          VARCHAR(100) NOT NULL,
  name           VARCHAR(80)  NOT NULL,
  phone          VARCHAR(20)  NOT NULL,
  role           VARCHAR(10)  NOT NULL,
  pass_hash      VARCHAR(200) NOT NULL,
  question       VARCHAR(120) NOT NULL,
  answer_hash    VARCHAR(200) NOT NULL,
  token_version  INT          NOT NULL DEFAULT 0,
  created_at     BIGINT       NOT NULL,
  PRIMARY KEY (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vehicles (
  email           VARCHAR(100) NOT NULL,
  make            VARCHAR(40)  NOT NULL,
  model           VARCHAR(40)  NOT NULL,
  vehicle_year    SMALLINT     NOT NULL,
  colour          VARCHAR(30)  NOT NULL,
  plate           VARCHAR(14)  NOT NULL,
  seats           TINYINT      NOT NULL,
  bank_name       VARCHAR(30)  NOT NULL,
  account_type    VARCHAR(30)  NOT NULL,
  account_holder  VARCHAR(80)  NOT NULL,
  account_number  VARCHAR(13)  NOT NULL,
  branch_code     CHAR(6)      NOT NULL,
  registered_at   BIGINT       NOT NULL,
  PRIMARY KEY (email),
  FOREIGN KEY (email) REFERENCES users (email) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rides (
  id            CHAR(16)      NOT NULL,
  driver_email  VARCHAR(100)  NOT NULL,
  from_place    VARCHAR(80)   NOT NULL,
  to_place      VARCHAR(80)   NOT NULL,
  ride_date     CHAR(10)      NOT NULL,
  ride_time     CHAR(5)       NOT NULL,
  seats         TINYINT       NOT NULL,
  price         DECIMAL(8,2)  NOT NULL,
  notes         VARCHAR(120)  NOT NULL DEFAULT '',
  return_time   CHAR(5)       NOT NULL DEFAULT '',
  created_at    BIGINT        NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (driver_email) REFERENCES users (email) ON DELETE CASCADE,
  KEY idx_rides_date (ride_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bookings (
  id               CHAR(16)      NOT NULL,
  ride_id          CHAR(16)      NOT NULL,
  passenger_email  VARCHAR(100)  NOT NULL,
  driver_email     VARCHAR(100)  NOT NULL,
  method           VARCHAR(10)   NOT NULL,
  status           VARCHAR(20)   NOT NULL,
  price            DECIMAL(8,2)  NOT NULL,
  pickup_phone     VARCHAR(20)   NOT NULL DEFAULT '',
  pickup_address   VARCHAR(255)  NOT NULL DEFAULT '',
  cancelled        TINYINT(1)    NOT NULL DEFAULT 0,
  created_at       BIGINT        NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (ride_id) REFERENCES rides (id) ON DELETE CASCADE,
  FOREIGN KEY (passenger_email) REFERENCES users (email) ON DELETE CASCADE,
  FOREIGN KEY (driver_email) REFERENCES users (email) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cards (
  email     VARCHAR(100) NOT NULL,
  brand     VARCHAR(12)  NOT NULL,
  last4     CHAR(4)      NOT NULL,
  expiry    CHAR(5)      NOT NULL,
  holder    VARCHAR(60)  NOT NULL,
  auto_pay  TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (email),
  FOREIGN KEY (email) REFERENCES users (email) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS timetables (
  email       VARCHAR(100) NOT NULL,
  days_json   TEXT         NOT NULL,
  file_name   VARCHAR(120) NULL,
  file_type   VARCHAR(20)  NULL,
  file_size   INT          NULL,
  file_data   MEDIUMBLOB   NULL,
  updated_at  BIGINT       NOT NULL,
  PRIMARY KEY (email),
  FOREIGN KEY (email) REFERENCES users (email) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id          CHAR(16)      NOT NULL,
  email       VARCHAR(100)  NOT NULL,
  message     VARCHAR(500)  NOT NULL,
  created_at  BIGINT        NOT NULL,
  is_read     TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  FOREIGN KEY (email) REFERENCES users (email) ON DELETE CASCADE,
  KEY idx_notifications_email (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  setting_key    VARCHAR(50)   NOT NULL,
  setting_value  VARCHAR(200)  NOT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS reviews (
  id              CHAR(16)      NOT NULL,
  driver_email    VARCHAR(100)  NOT NULL,
  reviewer_email  VARCHAR(100)  NOT NULL,
  rating          TINYINT       NOT NULL,
  comment         VARCHAR(255)  NOT NULL DEFAULT '',
  created_at      BIGINT        NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (driver_email) REFERENCES users (email) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_email) REFERENCES users (email) ON DELETE CASCADE,
  KEY idx_reviews_driver (driver_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warnings (
  id          CHAR(16)      NOT NULL,
  email       VARCHAR(100)  NOT NULL,
  title       VARCHAR(80)   NOT NULL,
  detail      VARCHAR(255)  NOT NULL DEFAULT '',
  created_at  BIGINT        NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (email) REFERENCES users (email) ON DELETE CASCADE,
  KEY idx_warnings_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS geocode_cache (
  query_key   VARCHAR(150)  NOT NULL,
  lat         DOUBLE        NULL,
  lng         DOUBLE        NULL,
  label       VARCHAR(200)  NOT NULL DEFAULT '',
  created_at  BIGINT        NOT NULL,
  PRIMARY KEY (query_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ride_offers (
  id             CHAR(16)      NOT NULL,
  ride_id        CHAR(16)      NOT NULL,
  driver_email   VARCHAR(100)  NOT NULL,
  student_email  VARCHAR(100)  NOT NULL,
  message        VARCHAR(150)  NOT NULL DEFAULT '',
  status         VARCHAR(10)   NOT NULL DEFAULT 'pending',
  created_at     BIGINT        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_offer (ride_id, student_email),
  FOREIGN KEY (ride_id) REFERENCES rides (id) ON DELETE CASCADE,
  FOREIGN KEY (driver_email) REFERENCES users (email) ON DELETE CASCADE,
  FOREIGN KEY (student_email) REFERENCES users (email) ON DELETE CASCADE,
  KEY idx_offers_student (student_email, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
