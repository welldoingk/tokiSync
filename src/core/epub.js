/** XML/XHTML 특수문자 이스케이프 — 미이스케이프 시 OPF/NCX/XHTML 파싱이 깨져
 *  Kavita 등에서 메타데이터/본문이 잘못 읽힌다(한글 제목·본문의 & < > 등). */
function xmlEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export class EpubBuilder {
    constructor() {
        this.chapters = [];
    }

    addChapter(title, textContent) {
        // Simple text to HTML conversion
        // Splits by newlines and wraps in <p>
        const htmlContent = textContent
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => `<p>${xmlEsc(line)}</p>`)
            .join('\n');

        this.chapters.push({ title, content: htmlContent });
    }

    async build(metadata = {}) {
        try {
            const zip = new JSZip();
            const title = metadata.title || "Unknown Title";
            const author = metadata.author || metadata.writer || "Unknown Author";
            const uid = "urn:uuid:" + (crypto.randomUUID ? crypto.randomUUID() : Date.now());

            // [Kavita] 시리즈 그룹핑 메타데이터 — calibre:series(시리즈명) + series_index(회차번호).
            //   회차마다 series 가 동일해야 한 시리즈로 묶이고, series_index 로 정렬된다.
            const series = metadata.series || "";
            const _idxMatch = String(metadata.number == null ? '' : metadata.number).match(/\d+(?:\.\d+)?/);
            const seriesIndex = _idxMatch ? String(parseFloat(_idxMatch[0])) : ""; // "0001"→"1", "0814화"→"814"
            const summary = metadata.summary || "";
            const tags = Array.isArray(metadata.tags) ? metadata.tags : (metadata.tags ? [metadata.tags] : []);

            // 1. mimetype (must be first, uncompressed)
            zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

            // 2. container.xml
            zip.folder("META-INF").file("container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`);

            // 3. OEBPS Folder
            const oebps = zip.folder("OEBPS");

            // styles.css
            oebps.file("styles.css", `body { font-family: sans-serif; } p { text-indent: 1em; margin-bottom: 0.5em; }`);

            // Chapters
            this.chapters.forEach((chapter, index) => {
                const filename = `chapter_${index + 1}.xhtml`;
                const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title>${xmlEsc(chapter.title)}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
<h2>${xmlEsc(chapter.title)}</h2>
${chapter.content}
</body>
</html>`;
                oebps.file(filename, xhtml);
            });

            // content.opf
            let manifest = `<item id="style" href="styles.css" media-type="text/css"/>\n`;
            let spine = ``;
            let tocNav = `<navMap>\n`;

            this.chapters.forEach((c, i) => {
                const id = `chap${i + 1}`;
                const href = `chapter_${i + 1}.xhtml`;
                manifest += `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
                spine += `<itemref idref="${id}"/>\n`;
                tocNav += `<navPoint id="${id}" playOrder="${i+1}"><navLabel><text>${xmlEsc(c.title)}</text></navLabel><content src="${href}"/></navPoint>\n`;
            });
            // Add NCX to manifest
            manifest += `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;

            // [표지] Kavita 는 파일명에 "cover" 든 이미지를 표지로 사용(OPF meta cover 필드는 무시).
            //   → 실제 cover.<ext> 이미지 파일을 넣고, spine 첫 장(cover.xhtml)으로도 표시한다.
            //   metadata.cover = { blob: Blob, type: 'image/...' }. 없으면 표지 생략(기존 동작).
            let coverManifest = '', coverSpine = '', coverMeta = '', coverGuide = '';
            const cover = metadata.cover;
            if (cover && cover.blob) {
                const ct = String(cover.type || 'image/jpeg').toLowerCase();
                const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg';
                const coverImg = `cover.${ext}`;
                oebps.file(coverImg, cover.blob);
                oebps.file("cover.xhtml", `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title><style type="text/css">body{margin:0;padding:0;text-align:center}img{max-width:100%;height:auto}</style></head>
<body><div><img src="${coverImg}" alt="cover"/></div></body>
</html>`);
                coverManifest = `<item id="cover-image" href="${coverImg}" media-type="${ct}"/>\n        <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n        `;
                coverMeta = `        <meta name="cover" content="cover-image"/>\n`;
                coverSpine = `<itemref idref="cover" linear="yes"/>\n        `;
                coverGuide = `    <guide>\n        <reference type="cover" title="Cover" href="cover.xhtml"/>\n    </guide>\n`;
            }

            const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:title>${xmlEsc(title)}</dc:title>
        <dc:creator opf:role="aut">${xmlEsc(author)}</dc:creator>
        <dc:language>ko</dc:language>
        <dc:identifier id="BookId">${uid}</dc:identifier>
${summary ? `        <dc:description>${xmlEsc(summary)}</dc:description>\n` : ''}${tags.map(t => `        <dc:subject>${xmlEsc(t)}</dc:subject>`).join('\n')}${tags.length ? '\n' : ''}${series ? `        <meta name="calibre:series" content="${xmlEsc(series)}"/>\n` : ''}${series && seriesIndex ? `        <meta name="calibre:series_index" content="${xmlEsc(seriesIndex)}"/>\n` : ''}${coverMeta}    </metadata>
    <manifest>
        ${coverManifest}${manifest}
    </manifest>
    <spine toc="ncx">
        ${coverSpine}${spine}
    </spine>
${coverGuide}</package>`;

            oebps.file("content.opf", opf);

            // toc.ncx
            const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
    <meta name="dtb:uid" content="${uid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${xmlEsc(title)}</text></docTitle>
${tocNav}
</navMap>
</ncx>`;

            oebps.file("toc.ncx", ncx);

            // Return the ZIP object (which IS the EPUB)
            return zip;
        } catch (e) {
            const { LogBox } = await import('./ui.js');
            LogBox.getInstance().critical(`EPUB 빌드 실패: ${e.message} (${metadata.title || 'unknown'})`, 'Builder:EPUB');
            throw e;
        }
    }
}
