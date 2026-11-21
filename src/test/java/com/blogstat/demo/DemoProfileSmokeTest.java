package com.blogstat.demo;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 데모 프로필을 실제로 띄워, 가짜 데이터로 검색어 변화 패널의 경우가 모두 보이는지 확인한다.
 * 시연 직전에 깨진 걸 발견하지 않도록 하는 테스트다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK,
        properties = "spring.datasource.url=jdbc:h2:mem:demotest;DB_CLOSE_DELAY=-1")
@ActiveProfiles("demo")
@AutoConfigureMockMvc
class DemoProfileSmokeTest {

    @Autowired
    MockMvc mvc;

    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode getJson(String url) throws Exception {
        String body = mvc.perform(get(url)).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        return mapper.readTree(body);
    }

    private static List<String> queries(JsonNode list) {
        List<String> out = new ArrayList<>();
        list.forEach(n -> out.add(n.get("query").asText()));
        return out;
    }

    @Test
    void 검색어_변화의_모든_경우가_보인다() throws Exception {
        JsonNode r = getJson("/api/dashboard/keyword-trends");

        assertThat(queries(r.get("fresh"))).contains("Claude Code 사용법", "H2 파일 잠금 해결", "Playwright 자바 크롤링");
        assertThat(queries(r.get("rising"))).contains("자바 레코드 사용법", "도커 컴포즈 예제");
        assertThat(queries(r.get("falling"))).contains("인텔리제이 단축키", "깃 리베이스 취소");
        // 다시 온 검색어와 띄어쓰기만 다른 표기는 새 검색어로 잡히면 안 된다.
        assertThat(queries(r.get("fresh"))).doesNotContain("도커 컴포즈 예제", "스프링부트 시작하기", "스프링 부트 시작하기");
        assertThat(r.get("historyDays").asInt()).isEqualTo(28);
    }

    @Test
    void 기존_대시보드_API도_데모_데이터로_동작하고_세션_경고가_없다() throws Exception {
        JsonNode summary = getJson("/api/dashboard/summary");
        assertThat(summary.get("collectedDays").asInt()).isEqualTo(30);
        assertThat(summary.get("searchVisits").asLong()).isPositive();

        assertThat(getJson("/api/dashboard/session").get("state").asText()).isEqualTo("OK");
    }
}
