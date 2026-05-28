
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
        // 연재/완결 → Genre 태그 (Kavita에서 장르 칩으로 표시·필터)
        const statusGenre = this.normalizeStatus(metadata.status);
        const genreTag = statusGenre ? `\n  <Genre>${this.escapeXml(statusGenre)}</Genre>` : "";

        return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>${this.escapeXml(series)}</Series>
  <Number>${number}</Number>
  <Title>${this.escapeXml(title)}</Title>
  <Writer>${this.escapeXml(writer)}</Writer>${genreTag}${summaryTag}
  <LanguageISO>ko</LanguageISO>
  <PageCount>${pageCount}</PageCount>
  <Manga>YesAndRightToLeft</Manga>
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
