import { GenericParser } from './GenericParser.js';
import { detectSite } from '../detector.js';
import { getGlobalUrlExcludeList } from '../config.js';

/**
 * ParserFactory
 * Creates and provides the appropriate parser for the current site.
 */
export class ParserFactory {
    static #instance = null;

    /**
     * Get the appropriate parser for the current site (Singleton)
     * @returns {Promise<BaseParser|null>}
     */
    static async getParser() {
        if (this.#instance) return this.#instance;

        const siteInfo = await detectSite();
        if (!siteInfo) {
            console.error('[ParserFactory] Failed to detect site');
            alert("TokiSync 파서 에러: 매칭되는 파싱 룰이 없습니다.\n\n해당 사이트를 지원하려면 설정에서 커스텀 파싱 룰(JSON)을 등록해야 합니다.\n(자세한 방법은 Github의 rules.sample.json을 참조하세요)");
            return null;
        }

        const { site, protocolDomain, matchedRule } = siteInfo;

        // Dynamic Generic Parser
        if (site === 'generic' && matchedRule) {
            // [custom] 전역 URL 차단 패턴을 룰에 자동 주입 (룰 수정 불가능한 원격 룰 보완용)
            const ruleWithGlobal = ParserFactory._injectGlobalUrlExclude(matchedRule);
            this.#instance = new GenericParser(protocolDomain, ruleWithGlobal);
            return this.#instance;
        }

        return null;
    }

    static _injectGlobalUrlExclude(rule) {
        // 빌트인 광고 CDN 차단 패턴 (LAN custom build에 항상 포함)
        const BUILTIN_URL_EXCLUDE = [
            '/board_uploads/',
        ];
        const globals = [...BUILTIN_URL_EXCLUDE, ...getGlobalUrlExcludeList()];
        if (!globals.length) return rule;
        const cloned = JSON.parse(JSON.stringify(rule));
        cloned.viewer = cloned.viewer || {};
        const existing = cloned.viewer.urlExclude || cloned.viewer.urlBlocklist;
        const existingList = existing
            ? (Array.isArray(existing) ? existing : [existing])
            : [];
        cloned.viewer.urlExclude = Array.from(new Set([...existingList, ...globals]));
        console.log(`[ParserFactory] URL 차단 패턴 주입 (빌트인 ${BUILTIN_URL_EXCLUDE.length} + 사용자 ${globals.length - BUILTIN_URL_EXCLUDE.length}):`, cloned.viewer.urlExclude);
        return cloned;
    }
}
