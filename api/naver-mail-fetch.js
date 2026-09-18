// Vercel Serverless Function — 네이버 메일함에서 첨부파일 가져오기
// URL: GET /api/naver-mail-fetch?sender=seoulbjs@naver.com&days=7
//
// 🔧 Vercel 환경변수 설정 (한 번만):
//  Vercel Dashboard → 프로젝트 → Settings → Environment Variables
//   • NAVER_IMAP_USER  = gplan23@naver.com  (또는 NAVER_SMTP_USER 와 동일)
//   • NAVER_IMAP_PASS  = (네이버 메일 → 환경설정 → POP3/IMAP 설정 → 발급된 비밀번호)
//                        ※ SMTP 비밀번호와 다를 수 있음. IMAP/POP3 설정 페이지에서 별도 발급
//
// 동작:
//  - imap.naver.com:993 (SSL) 접속
//  - INBOX 에서 sender 발신 + 지난 days 일 내 메일 검색
//  - 각 메일의 .xlsx/.xls/.csv 첨부파일을 base64 로 인코딩해 반환
//  - 호출자(프론트엔드)가 직접 파싱·저장

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export const config = {
  api: {
    // 첨부파일이 다수면 응답 크기가 커질 수 있어 일반 호출이지만 안전 마진
    bodyParser: { sizeLimit: '1mb' },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const IMAP_USER = process.env.NAVER_IMAP_USER || process.env.NAVER_SMTP_USER;
  const IMAP_PASS = process.env.NAVER_IMAP_PASS || process.env.NAVER_SMTP_PASS;
  if (!IMAP_USER || !IMAP_PASS) {
    res.status(500).json({
      error: 'Naver IMAP 환경변수 미설정',
      hint: 'Vercel Dashboard → Settings → Environment Variables 에 NAVER_IMAP_USER, NAVER_IMAP_PASS 등록 후 재배포해주세요.',
    });
    return;
  }

  // 쿼리 파라미터 (GET) — 본문(POST) 도 허용
  const q = req.query || {};
  const body = (req.method === 'POST' && req.body) ? req.body : {};
  // sender: 빈 문자열이면 발신자 필터 생략 (제목/파일명만으로 검색)
  const senderRaw = q.sender !== undefined ? q.sender : (body.sender !== undefined ? body.sender : 'seoulbjs@naver.com');
  const sender = String(senderRaw || '').trim();
  // filenamePattern: 첨부 파일명의 부분문자열 (대소문자 무시) — 빈 값이면 필터 안 함
  const filenamePattern = String(q.filenamePattern || body.filenamePattern || '').trim().toLowerCase();
  const days   = parseInt(q.days || body.days || 7, 10);
  const limit  = parseInt(q.limit || body.limit || 10, 10); // 최대 처리 건수 (응답 크기 보호)
  // offset: 페이지네이션용 — IMAP 연결(로그인 등) 자체가 수 초 걸려 Vercel 함수 제한시간(10초) 안에
  //   전체 기간을 한 번에 처리 못 할 수 있음(발신자 필터 없는 조회 등). 프론트가 offset 을 늘려가며
  //   여러 번 호출해 나눠 처리할 수 있도록 지원. hasMore=true 면 offset+limit 로 다음 페이지 요청.
  const offset = Math.max(0, parseInt(q.offset || body.offset || 0, 10) || 0);
  const since  = new Date(Date.now() - Math.max(1, Math.min(30, days)) * 24 * 60 * 60 * 1000);
  // uid: 지정하면 검색을 건너뛰고 이 메일 1건만 원문(+첨부)을 내려받는다 — "찾기(가벼움)"와
  //   "받기(그 1건만)"를 분리해 각 호출이 확실히 제한시간 안에 끝나게 하려는 용도.
  const targetUid = parseInt(q.uid || body.uid || 0, 10) || 0;
  // metaOnly: 실제 첨부 내용은 받지 않고 구조(제목/날짜/파일명/크기)만 가볍게 조회 — 빠름.
  //   프론트는 이걸로 원하는 메일의 uid 를 먼저 찾은 뒤, uid 파라미터로 그 1건만 다시 요청한다.
  const metaOnly = String(q.metaOnly || body.metaOnly || '') === '1';

  const client = new ImapFlow({
    host: 'imap.naver.com',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  const results = [];
  let connected = false;
  let hasMore = false;
  let totalMatched = 0;
  let pageSizeUsed = 0;
  try {
    await client.connect();
    connected = true;
    const lock = await client.getMailboxLock('INBOX');
    try {
      // uid 지정 시: 검색 생략하고 그 메일 1건만 원문(+첨부) 다운로드 — "찾기"와 분리된 "받기" 전용 경로.
      if (targetUid > 0) {
        let parsed = null;
        try {
          const msg = await client.fetchOne(targetUid, { source: true, envelope: true }, { uid: true });
          if (msg && msg.source) parsed = await simpleParser(msg.source);
        } catch (uidErr) {
          console.warn('[naver-mail-fetch] uid 단건 조회 실패 uid=' + targetUid, uidErr && uidErr.message);
        }
        const uidResults = [];
        if (parsed) {
          const attachments = (parsed.attachments || []).filter(a => {
            if (!a || !a.filename) return false;
            if (!/\.(xlsx|xls|csv)$/i.test(a.filename)) return false;
            if (filenamePattern) {
              const fn = a.filename.toLowerCase().replace(/\s+/g, '');
              const pat = filenamePattern.replace(/\s+/g, '');
              if (fn.indexOf(pat) === -1) return false;
            }
            return true;
          });
          for (const att of attachments) {
            uidResults.push({
              uid: targetUid,
              messageId: parsed.messageId || '',
              from: (parsed.from && parsed.from.text) || sender,
              subject: parsed.subject || '',
              date: (parsed.date && parsed.date.toISOString()) || '',
              fileName: att.filename,
              fileSize: att.size || (att.content && att.content.length) || 0,
              fileBase64: att.content.toString('base64'),
            });
          }
        }
        await safeLogout(client);
        res.status(200).json({ ok: true, sender, sinceDays: days, count: uidResults.length, items: uidResults, hasMore: false, totalMatched: uidResults.length });
        return;
      }
      // 검색: from(있을 때만) + since
      // imapflow.search() 는 기본적으로 sequence 번호 반환 — uid 옵션으로 UID 반환
      const criteria = sender ? { from: sender, since } : { since };
      const uids = await client.search(criteria, { uid: true });
      if (!Array.isArray(uids) || uids.length === 0) {
        await safeLogout(client);
        res.status(200).json({ ok: true, sender, sinceDays: days, count: 0, items: [], hasMore: false, totalMatched: 0, note: '조건에 맞는 메일이 없습니다.' });
        return;
      }
      // 최신순(큰 UID 부터) 정렬 후 offset~offset+limit 구간만 처리 (페이지네이션)
      const allSorted = uids.slice().sort((a, b) => b - a);
      totalMatched = allSorted.length;
      const pageSize = Math.max(1, Math.min(50, limit));
      const sortedUids = allSorted.slice(offset, offset + pageSize);
      pageSizeUsed = sortedUids.length;
      hasMore = offset + sortedUids.length < allSorted.length;
      if (!sortedUids.length) {
        await safeLogout(client);
        res.status(200).json({ ok: true, sender, sinceDays: days, count: 0, items: [], hasMore: false, totalMatched, note: '더 이상 조회할 메일이 없습니다.' });
        return;
      }

      // 1단계: 가벼운 구조 메타(bodyStructure)만 벌크로 조회 — 첨부 실제 내용은 아직 안 받음.
      //   기존엔 메시지마다 전체 원문(source, 첨부 바이너리 포함)을 개별로 내려받아 파싱했는데,
      //   발신자 필터가 없는 호출(외부업체 발주 메일 등)은 최근 N일의 모든 메일을 전부 다운로드하게 돼
      //   Vercel 함수 제한시간(10초) 안에 못 끝나 504가 발생했다. 구조 조회로 후보만 먼저 좁힌다.
      const _attsOf = (bs, out) => {
        if (!bs) return out;
        const fn = (bs.dispositionParameters && bs.dispositionParameters.filename)
          || (bs.parameters && bs.parameters.name) || '';
        if (fn) out.push({ name: String(fn), size: Number(bs.size) || 0 });
        if (Array.isArray(bs.childNodes)) bs.childNodes.forEach(c => _attsOf(c, out));
        return out;
      };
      let candidateUids = [];
      const metaByUid = new Map(); // uid → { envelope, atts: [{name,size}] } — metaOnly 응답 조립용
      try {
        for await (const msg of client.fetch(sortedUids, { envelope: true, bodyStructure: true }, { uid: true })) {
          const atts = _attsOf(msg.bodyStructure, []);
          const names = atts.map(a => a.name);
          if (!names.some(n => /\.(xlsx|xls|csv)$/i.test(n))) continue;
          if (filenamePattern) {
            const pat = filenamePattern.replace(/\s+/g, '');
            if (!names.some(n => n.toLowerCase().replace(/\s+/g, '').indexOf(pat) !== -1)) continue;
          }
          candidateUids.push(msg.uid);
          metaByUid.set(msg.uid, { envelope: msg.envelope, atts });
        }
      } catch (structErr) {
        console.warn('[naver-mail-fetch] bodyStructure 조회 실패, 전체 조회로 폴백:', structErr && structErr.message);
        candidateUids = sortedUids.slice(); // 폴백: 구조 조회가 안 되면 기존 방식대로 전부 시도
      }
      // ⚠ IMAP 서버는 벌크 fetch 결과를 요청 순서(최신순)가 아니라 항상 UID 오름차순(오래된 순)으로 반환한다.
      //   정렬을 안 하면 items[0](호출부가 "가장 최신"으로 취급)이 실제로는 가장 오래된 후보가 되어,
      //   최신 메일(예: 오늘 도착한 첨부)을 두고 며칠 전 파일을 잘못 가져오는 문제가 있었다.
      candidateUids.sort((a, b) => b - a);

      // metaOnly: 실제 첨부 내용(fileBase64)은 받지 않고 구조 정보만으로 응답 — 훨씬 빠름.
      //   프론트는 이 결과에서 원하는 uid 를 골라 uid 파라미터로 그 1건만 다시 요청해 내용을 받는다.
      if (metaOnly) {
        for (const uid of candidateUids) {
          const meta = metaByUid.get(uid);
          if (!meta) continue;
          const env = meta.envelope || {};
          for (const att of meta.atts) {
            if (!/\.(xlsx|xls|csv)$/i.test(att.name)) continue;
            if (filenamePattern) {
              const fn = att.name.toLowerCase().replace(/\s+/g, '');
              const pat = filenamePattern.replace(/\s+/g, '');
              if (fn.indexOf(pat) === -1) continue;
            }
            results.push({
              uid,
              from: (env.from && env.from[0] && (env.from[0].name ? `"${env.from[0].name}" <${env.from[0].address}>` : env.from[0].address)) || sender,
              subject: env.subject || '',
              date: env.date ? new Date(env.date).toISOString() : '',
              fileName: att.name,
              fileSize: att.size,
            });
          }
        }
        await safeLogout(client);
        res.status(200).json({ ok: true, sender, sinceDays: days, count: results.length, items: results, hasMore, totalMatched, offset, pageSize: pageSizeUsed });
        return;
      }

      // 2단계: 조건에 맞는 후보 메일만 실제 원문(+첨부)을 내려받는다.
      //   ⚠ 벌크 client.fetch 로 바꿔봤으나 실측 결과 개선이 없었음(오히려 근소하게 느려짐) —
      //   단순 개별 fetchOne 로 되돌림. candidateUids 는 이미 최신순으로 정렬돼 있어 순서 보장됨.
      for (const uid of candidateUids) {
        let parsed = null;
        try {
          const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!msg || !msg.source) continue;
          parsed = await simpleParser(msg.source);
        } catch (perMsgErr) {
          console.warn('[naver-mail-fetch] 단일 메일 처리 실패 uid=' + uid, perMsgErr && perMsgErr.message);
          continue;
        }
        const attachments = (parsed.attachments || []).filter(a => {
          if (!a || !a.filename) return false;
          if (!/\.(xlsx|xls|csv)$/i.test(a.filename)) return false;
          // 파일명 패턴 필터 (대소문자 무시 + 공백 무시 부분문자열)
          if (filenamePattern) {
            const fn = a.filename.toLowerCase().replace(/\s+/g, '');
            const pat = filenamePattern.replace(/\s+/g, '');
            if (fn.indexOf(pat) === -1) return false;
          }
          return true;
        });
        if (!attachments.length) continue;
        for (const att of attachments) {
          results.push({
            uid,
            messageId: parsed.messageId || '',
            from: (parsed.from && parsed.from.text) || sender,
            subject: parsed.subject || '',
            date: (parsed.date && parsed.date.toISOString()) || '',
            fileName: att.filename,
            fileSize: att.size || (att.content && att.content.length) || 0,
            fileBase64: att.content.toString('base64'),
          });
        }
      }
    } finally {
      lock.release();
    }
    await safeLogout(client);
    res.status(200).json({ ok: true, sender, sinceDays: days, count: results.length, items: results, hasMore, totalMatched, offset, pageSize: pageSizeUsed });
  } catch (err) {
    console.error('[naver-mail-fetch] 실패:', err);
    if (connected) await safeLogout(client);
    res.status(500).json({
      error: err.message || String(err),
      code: err.code,
      hint: '네이버 메일 환경설정에서 IMAP/POP3 가 활성화되어 있고, 발급받은 비밀번호가 NAVER_IMAP_PASS 에 등록되었는지 확인해주세요.',
    });
  }
}

async function safeLogout(client) {
  try { await client.logout(); } catch (_) {}
}
