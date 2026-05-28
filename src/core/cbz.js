
export class CbzBuilder {
    constructor() {
        this.chapters = [];
    }

    addChapter(title, images) {
        // images: array of { blob, ext }
        this.chapters.push({ title, images });
    }

    async build(metadata = {}) {
        try {
            const zip = new JSZip();
            
            // Kavita Compatibility: Images at root, no subfolders
            // Note: As per new strategy, we only build one chapter per CBZ.
            this.chapters.forEach((chapter) => {
                chapter.images.forEach((img, idx) => {
                    if (img && img.blob) {
                        const filename = img.isMissing 
                            ? `[PAGE_MISSING]_image_${String(idx).padStart(4, '0')}${img.ext}`
                            : `image_${String(idx).padStart(4, '0')}${img.ext}`;
                        zip.file(filename, img.blob);
                    }
                });
            });

            const comicInfo = this.generateComicInfo(metadata);
            zip.file("ComicInfo.xml", comicInfo);

            return zip;
        } catch (e) {
            const { LogBox } = await import('./ui.js');
            LogBox.getInstance().critical(`CBZ 빌드 실패: ${e.message} (${metadata.title || 'unknown'})`, 'Builder:CBZ');
            throw e;
        }
    }

    generateComicInfo(metadata) {
        const series = metadata.series || "Unknown Series";
        const title = metadata.title || "";
        const number = metadata.number || "";
        const writer = metadata.writer || "";
        const summary = metadata.summary || "";
        const pageCount = this.chapters.reduce((acc, chap) => acc + chap.images.length, 0);

        const summaryTag = summary ? `\n  <Summary>${this.escapeXml(summary)}</Summary>` : "";
        // 장르 = 연재/완결 상태 + 추출한 태그(판타지/먹방 등) 통합 (콤마 구분 → Kavita 장르 칩)
        const statusGenre = this.normalizeStatus(metadata.status);
        const tagList = Array.isArray(metadata.tags) ? metadata.tags : [];
        const genres = [...new Set([statusGenre, ...tagList].map(s => (s || '').trim()).filter(Boolean))];
        const genreTag = genres.length ? `\n  <Genre>${this.escapeXml(genres.join(', '))}</Genre>` : "";
        // 읽기 방향: 웹툰=세로(LTR), 만화=일본식 우→좌. 카테고리로 분기 (기존 RTL 하드코딩 수정)
        const cat = (metadata.category || '').toString().toLowerCase();
        const mangaTag = cat === 'webtoon' ? '<Manga>No</Manga>' : '<Manga>YesAndRightToLeft</Manga>';

        return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>${this.escapeXml(series)}</Series>
  <Number>${number}</Number>
  <Title>${this.escapeXml(title)}</Title>
  <Writer>${this.escapeXml(writer)}</Writer>${genreTag}${summaryTag}
  <LanguageISO>ko</LanguageISO>
  <PageCount>${pageCount}</PageCount>
  ${mangaTag}
</ComicInfo>`;
    }

    /** "● 완결" / "completed" / "연재중" 등 → "완결" | "연재중" | "" (정규화) */
    normalizeStatus(raw) {
        if (!raw) return "";
        const t = String(raw).replace(/[●•\s]/g, "");
        if (/(완결|completed|complete|end|finished)/i.test(t)) return "완결";
        if (/(연재|연중|진행|ongoing|serializing)/i.test(t)) return "연재중";
        return "";
    }

    escapeXml(unsafe) {
        return unsafe.replace(/[<>&"']/g, (c) => {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '"': return '&quot;';
                case "'": return '&apos;';
            }
        });
    }
}
