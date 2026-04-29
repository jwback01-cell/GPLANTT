-- ================================================
-- GPLAN Supabase 테이블 설정
-- Supabase Dashboard > SQL Editor 에서 실행하세요
-- ================================================

-- 1. 할 일 목록
CREATE TABLE IF NOT EXISTS todos (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  team TEXT DEFAULT '미지정',
  due_text TEXT,
  accent TEXT DEFAULT 'blue',
  completed BOOLEAN DEFAULT FALSE,
  completed_at TEXT,
  date_key TEXT,
  end_date_key TEXT,
  memo TEXT,
  repeat_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 상품 관리
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT DEFAULT '기타',
  stock INTEGER DEFAULT 0,
  safety_stock INTEGER DEFAULT 0,
  cost INTEGER DEFAULT 0,
  supply_price INTEGER DEFAULT 0,
  shipping_fee INTEGER DEFAULT 0,
  shipping_cost INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 기존 테이블이 있다면 누락된 컬럼 추가 (이미 있으면 무시됨)
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supply_price INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_fee INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_cost INTEGER DEFAULT 0;

-- 3. RLS (Row Level Security) 활성화
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- 4. RLS 정책: 로그인한 모든 사용자가 전체 데이터 공유
CREATE POLICY "authenticated_users_manage_all_todos" ON todos
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "authenticated_users_manage_all_products" ON products
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- ================================================
-- 5. 클릭나라 사이트 키-값 저장소 (업로드 데이터/사용자 매핑 백업용)
-- ================================================
CREATE TABLE IF NOT EXISTS clicknara_kv (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT 'null',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE clicknara_kv ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_users_manage_all_clicknara_kv" ON clicknara_kv
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);
