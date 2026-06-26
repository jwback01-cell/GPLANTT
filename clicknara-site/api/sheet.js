// 기존세팅값 구글 시트(웹 게시된 공개 문서) CSV 프록시
// 브라우저(특히 file:// 로컬 파일)에서 docs.google.com 직접 fetch 시 CORS 차단되므로 서버 경유.
// 사용: /api/sheet?gid=98661656   (시트 ID는 고정)
const SHEET_ID = '12ixpjr9CxQX6aKHGLFfQzB9siGWcBYtt0FXzXP67HgI';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const gid = String((req.query && req.query.gid) || '0').replace(/[^0-9]/g, '') || '0';
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
    const r = await fetch(url);
    if (!r.ok) { res.status(502).json({ error: 'upstream ' + r.status }); return; }
    const csv = await r.text();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    res.status(200).send(csv);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
