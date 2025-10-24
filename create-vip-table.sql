CREATE TABLE IF NOT EXISTS vip_access (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) UNIQUE NOT NULL,
  expiry_date TIMESTAMP NOT NULL,
  product_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_vip_user ON vip_access(user_id);
CREATE INDEX idx_vip_expiry ON vip_access(expiry_date);
