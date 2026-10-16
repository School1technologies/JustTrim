-- Just Trim database schema (PostgreSQL 14+). Safe to run more than once.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,          -- scrypt hash, never the password itself
  phone text,
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','owner','admin')),
  points int NOT NULL DEFAULT 0 CHECK (points >= 0),
  lang text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS salons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  brand text NOT NULL,
  name text NOT NULL,
  area text NOT NULL,
  address text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (type IN ('Men','Women','Unisex')),
  open_min int NOT NULL DEFAULT 540,
  close_min int NOT NULL DEFAULT 1260,
  off_days int[] NOT NULL DEFAULT '{}',
  holidays date[] NOT NULL DEFAULT '{}',
  offer_code text,
  offer_pct int CHECK (offer_pct BETWEEN 0 AND 50),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  declared_staff int NOT NULL DEFAULT 0,
  rating numeric(2,1) NOT NULL DEFAULT 0,
  joined date NOT NULL DEFAULT CURRENT_DATE,
  paid_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (close_min > open_min)
);
-- Added after the first release (safe to run again)
ALTER TABLE salons ADD COLUMN IF NOT EXISTS billing_name text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS billing_email text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS gstin text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS billing_agreed_at timestamptz;
ALTER TABLE salons DROP CONSTRAINT IF EXISTS salons_status_check;
ALTER TABLE salons ADD CONSTRAINT salons_status_check CHECK (status IN ('draft','pending','approved','rejected','suspended'));
CREATE INDEX IF NOT EXISTS salons_status_area ON salons (status, area);

CREATE TABLE IF NOT EXISTS staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name text NOT NULL,
  spec text NOT NULL DEFAULT '',
  photo text,                       -- small data URL; move to object storage (S3) at scale
  active boolean NOT NULL DEFAULT true,
  leave date[] NOT NULL DEFAULT '{}',
  rating numeric(2,1) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name text NOT NULL,
  price int NOT NULL CHECK (price >= 0),
  dur_min int NOT NULL CHECK (dur_min > 0),
  active boolean NOT NULL DEFAULT true
);

-- Which services a stylist does, with an optional personal time that overrides the default
CREATE TABLE IF NOT EXISTS staff_services (
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  dur_min int CHECK (dur_min > 0),
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS combos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name text NOT NULL,
  price int NOT NULL CHECK (price >= 0),
  dur_min int NOT NULL CHECK (dur_min > 0)
);
ALTER TABLE combos ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS combo_items (
  combo_id uuid NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (combo_id, service_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id),
  staff_id uuid NOT NULL REFERENCES staff(id),
  customer_id uuid REFERENCES users(id),
  customer_name text NOT NULL DEFAULT '',
  customer_contact text NOT NULL DEFAULT '',
  date date NOT NULL,
  start_min int NOT NULL CHECK (start_min >= 0 AND start_min < 1440),
  dur_min int NOT NULL CHECK (dur_min > 0),
  price int NOT NULL DEFAULT 0,
  discount int NOT NULL DEFAULT 0,
  advance int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','inservice','done','noshow','cancelled')),
  type text NOT NULL DEFAULT 'online' CHECK (type IN ('online','walkin')),
  token int NOT NULL,
  items jsonb NOT NULL,
  rating int CHECK (rating BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The database itself refuses a double booking, even under heavy parallel requests
  CONSTRAINT no_double_booking EXCLUDE USING gist
    (staff_id WITH =, date WITH =, int4range(start_min, start_min + dur_min) WITH &&)
    WHERE (status IN ('booked','inservice','done'))
);
CREATE INDEX IF NOT EXISTS bookings_salon_date ON bookings (salon_id, date);
CREATE INDEX IF NOT EXISTS bookings_customer ON bookings (customer_id, date);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id),
  amount int NOT NULL,             -- rupees, excluding GST
  gst int NOT NULL DEFAULT 0,
  issued date NOT NULL DEFAULT CURRENT_DATE,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'paid',
  gateway_ref text
);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS invoices_gateway_ref ON invoices (gateway_ref) WHERE gateway_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  text text NOT NULL,
  seen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id),
  booking_id uuid REFERENCES bookings(id),
  customer_id uuid REFERENCES users(id),
  text text NOT NULL,
  amount int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','refunded','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE salons ADD COLUMN IF NOT EXISTS custom_price int CHECK (custom_price >= 0);

-- Questions from salon owners to Super Admin
CREATE TABLE IF NOT EXISTS queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  salon_id uuid REFERENCES salons(id) ON DELETE SET NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS query_messages (
  id bigserial PRIMARY KEY,
  query_id uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('owner','admin')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queries_status ON queries (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO settings (key, value) VALUES
  ('saas_price','1499'),('trial_months','3'),('grace_days','7'),
  ('slot_buffer_min','5'),('advance_amount','30'),('gst_pct','18'),('customer_fee','0')
ON CONFLICT (key) DO NOTHING;
