package com.blogstat.collector;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class CatalogSupportTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void 같은_통계_도메인의_m_blog_페이지만_남기고_중복을_없앤다() {
        List<String> links = CatalogSupport.statPageLinks(Arrays.asList(
                "https://blog.stat.naver.com/m/blog/daily/cv",
                "https://blog.stat.naver.com/m/blog/daily/cv?startDate=2026-11-01", // 쿼리만 다르면 같은 페이지
                "https://blog.stat.naver.com/m/blog/daily/cv#ct", // 본문 바로가기 앵커는 같은 화면
                "https://blog.stat.naver.com/m/blog/daily/cv#",
                "https://blog.stat.naver.com/m/blog/rank/cv#/week", // 해시 라우트는 다른 화면
                "https://blog.stat.naver.com/api/blog/user",   // API는 페이지가 아님
                "https://m.blog.naver.com/someone/123",        // 다른 도메인
                "http://blog.stat.naver.com/m/blog/daily/uv",  // https만
                "javascript:void(0)",
                null));

        assertThat(links).containsExactly(
                "https://blog.stat.naver.com/m/blog/daily/cv",
                "https://blog.stat.naver.com/m/blog/rank/cv#/week");
    }

    @Test
    void 글_번호가_다른_같은_종류의_화면은_같은_패턴이다() {
        assertThat(CatalogSupport.pagePattern("https://blog.stat.naver.com/m/blog/article/224000000101/cv"))
                .isEqualTo(CatalogSupport.pagePattern("https://blog.stat.naver.com/m/blog/article/224000000102/cv"))
                .isEqualTo("https://blog.stat.naver.com/m/blog/article/{id}/cv");
        assertThat(CatalogSupport.pagePattern("https://blog.stat.naver.com/m/blog/daily/cv"))
                .isEqualTo("https://blog.stat.naver.com/m/blog/daily/cv");
    }

    @Test
    void 통계_API만_고른다() {
        assertThat(CatalogSupport.isStatApi("https://blog.stat.naver.com/api/blog/daily/cv?x=1")).isTrue();
        assertThat(CatalogSupport.isStatApi("https://blog.stat.naver.com/m/blog/daily/cv")).isFalse();
        assertThat(CatalogSupport.isStatApi("https://nlog.naver.com/api/collect")).isFalse();
        assertThat(CatalogSupport.isStatApi("not a url")).isFalse();
    }

    @Test
    void 파라미터는_디코딩하고_캐시방지용_언더스코어는_뺀다() {
        String url = "https://blog.stat.naver.com/api/blog/daily/referer/total/detail"
                + "?startDate=2026-11-19&refererDomain=%EB%84%A4%EC%9D%B4%EB%B2%84%20%ED%86%B5%ED%95%A9%EA%B2%80%EC%83%89&exclude=&_=1763_42";

        assertThat(CatalogSupport.apiPath(url)).isEqualTo("/api/blog/daily/referer/total/detail");
        assertThat(CatalogSupport.params(url)).containsExactly(
                Map.entry("startDate", "2026-11-19"),
                Map.entry("refererDomain", "네이버 통합검색"),
                Map.entry("exclude", ""));
    }

    @Test
    void 쿼리가_없으면_빈_파라미터() {
        assertThat(CatalogSupport.params("https://blog.stat.naver.com/api/blog/user")).isEmpty();
    }

    @Test
    void 구조만_요약하고_값은_내보내지_않는다() throws Exception {
        String json = """
                {"result":{"statDataList":[{"data":{"rows":{"date":["2026-11-19","2026-11-20"],"cv":[175,144]}}}],
                 "secret":"비밀값", "ok":true, "none":null}}
                """;

        String shape = CatalogSupport.shape(mapper.readTree(json));

        assertThat(shape).isEqualTo(
                "{result:{statDataList:[1]{data:{rows:{date:[2]str, cv:[2]num}}}, secret:str, ok:bool, none:null}}");
        assertThat(shape).doesNotContain("비밀값", "175", "2026-11-19");
    }

    @Test
    void 얕은_rows는_컬럼과_길이를_보여준다() throws Exception {
        String shape = CatalogSupport.shape(mapper.readTree("{\"rows\":{\"date\":[\"a\",\"b\"],\"cv\":[1,2]}}"));

        assertThat(shape).isEqualTo("{rows:{date:[2]str, cv:[2]num}}");
    }

    @Test
    void 너무_깊은_객체는_줄인다() throws Exception {
        String shape = CatalogSupport.shape(mapper.readTree("{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{\"f\":{\"g\":1}}}}}}}"));

        assertThat(shape).isEqualTo("{a:{b:{c:{d:{e:{f:{…}}}}}}}");
    }

    @Test
    void 키가_너무_많으면_줄인다() throws Exception {
        StringBuilder sb = new StringBuilder("{");
        for (int i = 0; i < 30; i++) {
            sb.append(i == 0 ? "" : ",").append("\"k").append(i).append("\":1");
        }
        String shape = CatalogSupport.shape(mapper.readTree(sb.append('}').toString()));

        assertThat(shape).contains("k24:num").doesNotContain("k25:").endsWith("…+5}");
    }
}
