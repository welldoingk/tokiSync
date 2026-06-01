import { GenericParser } from './GenericParser.js';
import { detectSite } from '../detector.js';
import { RuleManager } from './RuleManager.js';

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
            this.#instance = new GenericParser(protocolDomain, matchedRule);
            return this.#instance;
        }

        return null;
    }

    /**
     * 특정 URL 에 매칭되는 룰로 파서 생성(현재 location 무관, 싱글톤 #instance 와 독립).
     *   멀티-IP lease/자동펼침처럼 "부모 페이지와 다른 카테고리(만화↔소설)"의 URL 을 처리할 때 사용.
     *   부모가 만화 페이지에 고정된 채 소설 회차를 받아도 unit.url 기준으로 소설 룰을 정확히 선택한다.
     * @returns {Promise<GenericParser|null>}
     */
    static async getParserForUrl(url) {
        try {
            const rule = await RuleManager.matchRule(url);
            if (!rule) return null;
            let origin = '';
            try { origin = new URL(url).origin; } catch (e) {}
            return new GenericParser(origin, rule);
        } catch (e) { return null; }
    }
}
