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
  const sender = String(q.sender || body.sender || 'seoulbjs@naver.com').trim();
  const days   = parseInt(q.days || body.days || 7, 10);
  const limit  = parseInt(q.limit || body.limit || 10, 10); // 최대 처리 건수 (응답 크기 보호)
  const since  = new Date(Date.now() - Math.max(1, Math.min(30, days)) * 24 * 60 * 60 * 1000);

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
  try {
    await client.connect();
    connected = true;
    const lock = await client.getMailboxLock('INBOX');
    try {
      // 검색: from + since
      // imapflow.search() 는 기본적으로 sequence 번호 반환 — uid 옵션으로 UID 반환
      const uids = await client.search({ from: sender, since }, { uid: true });
      if (!Array.isArray(uids) || uids.length === 0) {
        await safeLogout(client);
        res.status(200).json({ ok: true, sender, sinceDays: days, count: 0, items: [], note: '조건에 맞는 메일이 없습니다.' });
        return;
      }
      // 최신순(큰 UID 부터)으로 limit 만큼만 처리
      const sortedUids = uids.slice().sort((a, b) => b - a).slice(0, Math.max(1, Math.min(50, limit)));

      for (const uid of sortedUids) {
        try {
          const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const attachments = (parsed.attachments || []).filter(a =>
            a && a.filename && /\.(xlsx|xls|csv)$/i.test(a.filename)
          );
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
        } catch (perMsgErr) {
          console.warn('[naver-mail-fetch] 단일 메일 처리 실패 uid=' + uid, perMsgErr && perMsgErr.message);
          // 한 건 실패는 무시하고 계속
        }
      }
    } finally {
      lock.release();
    }
    await safeLogout(client);
    res.status(200).json({ ok: true, sender, sinceDays: days, count: results.length, items: results });
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
