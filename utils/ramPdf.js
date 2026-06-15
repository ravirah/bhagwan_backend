// Server-side राम-repetition PDF generator. Unlike the on-device expo-print path
// (which OOMs on Android above ~10K mantras), this streams directly to the HTTP
// response with PDFKit, so it can write EVERY राम for any count without a memory wall.
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansDevanagari.ttf');
const MANTRA = 'राम';
const SAFFRON = '#FF9933';

// Stream a राम-repetition report PDF into `res`. `payload` mirrors the chant-summary
// shape: { meta, totals, rows:[{ name, mobile, email, totalCount }] }.
function streamRamPdf(res, payload, { appTitle = 'Shri Ram Nam Bank', heading = 'Ram Naam Repetition Report' } = {}) {
  const meta = payload.meta || {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  const doc = new PDFDocument({ size: 'A4', margin: 34, bufferPages: false, autoFirstPage: false });
  doc.registerFont('deva', FONT_PATH);
  doc.pipe(res);

  doc.addPage();

  // ── Header band ──
  doc.rect(0, 0, doc.page.width, 74).fill(SAFFRON);
  doc.fillColor('#ffffff').font('deva').fontSize(16)
    .text(`${appTitle} — ${heading}`, 34, 18, { width: doc.page.width - 68 });
  doc.fontSize(9).fillColor('#fff7ee')
    .text(`Period: ${meta.periodStart || '-'} – ${meta.periodEnd || '-'}   ·   Scope: ${meta.scope === 'single' ? 'Single User' : 'All Users'}   ·   Generated: ${meta.generatedAt ? new Date(meta.generatedAt).toLocaleString('en-IN') : ''}`, 34, 46, { width: doc.page.width - 68 });
  doc.moveDown(2);
  doc.y = 90;

  const contentWidth = doc.page.width - 68;

  for (const r of rows) {
    const total = Math.max(0, Math.floor(Number(r.totalCount || 0)));

    // User heading + summary
    if (doc.y > doc.page.height - 90) doc.addPage();
    doc.fillColor('#2D2D2D').font('deva').fontSize(13).text(r.name || '-', 34, doc.y);
    doc.moveTo(34, doc.y + 2).lineTo(doc.page.width - 34, doc.y + 2).strokeColor(SAFFRON).lineWidth(1.5).stroke();
    doc.moveDown(0.4);
    doc.fillColor('#444').fontSize(10)
      .text(`Mobile: ${r.mobile || '-'}   ·   Email: ${r.email || '-'}   ·   Total Counts: ${total.toLocaleString('en-IN')}`, 34, doc.y, { width: contentWidth });
    doc.moveDown(0.4);

    if (total === 0) {
      doc.fillColor('#999').fontSize(11).text('—', 34, doc.y);
      doc.moveDown(1);
      continue;
    }

    // The mantra body. Build in bounded chunks (never one giant string) and let PDFKit
    // wrap/paginate. continued:true keeps it flowing as one paragraph across pages.
    doc.fillColor(SAFFRON).font('deva').fontSize(11);
    const CHUNK = 500;
    let written = 0;
    while (written < total) {
      const n = Math.min(CHUNK, total - written);
      const isLast = written + n >= total;
      // join with normal spaces; PDFKit handles line wrapping within contentWidth.
      const block = Array(n).fill(MANTRA).join(' ') + (isLast ? '' : ' ');
      doc.text(block, { width: contentWidth, continued: !isLast, lineGap: 1 });
      written += n;
    }
    doc.text('', { continued: false }); // close the paragraph
    doc.moveDown(1.2);
  }

  doc.end();
}

module.exports = { streamRamPdf };
