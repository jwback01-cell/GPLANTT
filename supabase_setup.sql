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
  auto_order BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. RLS (Row Level Security) 활성화
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- 4. RLS 정책: 로그인한 사용자만 자기 데이터 접근
CREATE POLICY "users_manage_own_todos" ON todos
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_manage_own_products" ON products
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
