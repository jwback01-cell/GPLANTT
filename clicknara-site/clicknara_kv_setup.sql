-- CLICKNARA 클라우드 동기화 테이블 (GPLAN 과 통합된 Supabase 프로젝트에서 1회 실행)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run.
-- (이 테이블이 없어도 로그인과 앱 동작은 정상 — 여러 기기 간 데이터 동기화에만 필요)

create table if not exists public.clicknara_kv (
  key        text primary key,
  data       jsonb,
  updated_at timestamptz default now(),
  updated_by uuid
);

alter table public.clicknara_kv enable row level security;

-- 로그인한 사용자(authenticated)면 읽기/쓰기 허용 (공용 워크스페이스 — key 단일 PK 설계)
drop policy if exists "clicknara_kv authenticated all" on public.clicknara_kv;
create policy "clicknara_kv authenticated all"
  on public.clicknara_kv
  for all
  to authenticated
  using (true)
  with check (true);
