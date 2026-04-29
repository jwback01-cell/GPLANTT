-- ================================================
-- 지플랜(GPLAN) 클라우드 동기화 테이블 설정
-- 실행 위치: Supabase 대시보드 (지플랜 프로젝트)
--   URL: https://gdsutxmceghvkemcfyuw.supabase.co
--   메뉴: SQL Editor → New Query → 아래 전체 복사 붙여넣기 → Run
-- ================================================

-- 키-값 저장소 (업로드 데이터, 송장, 이카운트 설정, 키워드 추적 등 백업)
CREATE TABLE IF NOT EXISTS gplan_kv (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT 'null',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE gplan_kv ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_users_manage_all_gplan_kv" ON gplan_kv;
CREATE POLICY "authenticated_users_manage_all_gplan_kv" ON gplan_kv
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION _gplan_kv_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gplan_kv_touch ON gplan_kv;
CREATE TRIGGER gplan_kv_touch
  BEFORE UPDATE ON gplan_kv
  FOR EACH ROW EXECUTE FUNCTION _gplan_kv_touch_updated_at();

-- 확인용 (실행하면 빈 결과가 나옵니다 — 정상)
SELECT * FROM gplan_kv;
