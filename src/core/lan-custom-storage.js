import { uploadWebDav } from './webdav.js';

export function getLanStorageCategory(metadata = {}, extension = '') {
    return metadata.category || (extension === 'epub' ? 'Novel' : 'Webtoon');
}

export async function tryLanSaveFile({ content, type, extension, metadata = {}, fullFileName, logger }) {
    if (type !== 'native' && type !== 'webdav') {
        return { handled: false };
    }

    const folderName = metadata.folderName || 'TokiSync';
    const category = getLanStorageCategory(metadata, extension);

    try {
        await uploadWebDav(content, category, folderName, fullFileName);
        return { handled: true, value: true };
    } catch (err) {
        if (logger && typeof logger.error === 'function') {
            logger.error(`[WebDAV] 업로드 실패: ${err.message}`);
        }
        throw err;
    }
}
