import { startRemoteSync, registerRemoteMenu } from './remote.js';

export function registerLanCustomMenus() {
    registerRemoteMenu();
}

export function startLanCustomRuntime() {
    try {
        startRemoteSync();
    } catch (e) {
        console.warn('[TokiSync] 원격 동기화 시작 실패:', e);
    }
}

export async function testLanNativeDownload(saveFile) {
    try {
        const testBlob = new Blob(['TokiSync Native Mode Test File'], { type: 'text/plain' });
        await saveFile(testBlob, 'test', 'native', 'txt', { folderName: '_Test' });
        return true;
    } catch (e) {
        console.error('[Native Test Failed]', e);
        return false;
    }
}
