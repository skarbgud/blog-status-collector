package com.blogstat.collector.source;

import com.blogstat.collector.RefererDay;
import com.blogstat.collector.RefererParseException;
import com.blogstat.collector.RefererParser;
import com.blogstat.collector.RefererRow;
import com.blogstat.collector.SearchQueryRow;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;

/**
 * 크롬 확장(TS) 이식용 유입경로·검색어 골든 데이터. GOLDEN_DIR이 있을 때만 돈다.
 * fixtures/referer-cases.json → golden/referer.json (요청 주소 순서, 유입경로 행, 검색어 행, 오늘 데이터, 파싱 오류)
 */
@EnabledIfEnvironmentVariable(named = "GOLDEN_DIR", matches = ".+")
class RefererGoldenDumpTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String BASE = "https://blog.stat.naver.com";

    private final Path dir = Path.of(System.getenv("GOLDEN_DIR"));

    @Test
    void 유입경로_골든() throws IOException {
        JsonNode fx = MAPPER.readTree(dir.resolve("fixtures/referer-cases.json").toFile());
        LocalDate date = LocalDate.parse(fx.get("date").asText());
        RefererParser parser = new RefererParser();
        RefererSource source = new RefererSource(parser, BASE, 100, () -> "n");
        ObjectNode out = MAPPER.createObjectNode();

        out.set("normal", fetch(source, fx, fx.get("total"), date));

        ObjectNode today = fx.get("total").deepCopy();
        ((ObjectNode) today.get("result").get("statDataList").get(2).get("data").get("value")).put("isToday", true);
        out.set("today", fetch(source, fx, today, date));

        ArrayNode errors = out.putArray("parseErrors");
        for (JsonNode c : fx.get("parseErrors")) {
            ObjectNode e = errors.addObject();
            e.put("name", c.get("name").asText());
            try {
                parser.parse(MAPPER.writeValueAsString(c.get("body")), date);
                e.put("error", false);
            } catch (RefererParseException ex) {
                e.put("error", true);
            }
        }

        Path file = dir.resolve("golden/referer.json");
        Files.createDirectories(file.getParent());
        Files.writeString(file, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(out) + "\n");
    }

    private ObjectNode fetch(RefererSource source, JsonNode fx, JsonNode total, LocalDate date) throws IOException {
        ObjectNode result = MAPPER.createObjectNode();
        ArrayNode urls = result.putArray("urls");
        String totalBody = MAPPER.writeValueAsString(total);
        RefererDay day = source.fetch((url, label) -> {
            String clean = url.replaceAll("&_=[^&]*", "");
            urls.add(clean.substring(BASE.length()));
            if (!clean.contains("/detail?")) {
                return totalBody;
            }
            String domain = URLDecoder.decode(clean.replaceAll(".*refererDomain=([^&]*).*", "$1"), StandardCharsets.UTF_8);
            JsonNode detail = fx.get("details").get(domain);
            if (detail.isInt()) {
                throw new IllegalStateException(label + " 수집 실패: HTTP " + detail.asInt());
            }
            try {
                return MAPPER.writeValueAsString(detail);
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }, date);

        result.put("today", day.today());
        result.put("totalCount", day.totalCount());
        ArrayNode rows = result.putArray("rows");
        for (RefererRow r : day.rows()) {
            ObjectNode o = rows.addObject();
            o.put("date", r.date().toString());
            o.put("referrer", r.referrer());
            o.put("searchEngine", r.searchEngine());
            o.put("visits", r.visits());
            o.put("ratio", r.ratio());
        }
        ArrayNode queries = result.putArray("queries");
        for (SearchQueryRow q : day.queries()) {
            ObjectNode o = queries.addObject();
            o.put("date", q.date().toString());
            o.put("referrer", q.referrer());
            o.put("query", q.query());
            o.put("visits", q.visits());
            o.put("ratio", q.ratio());
        }
        return result;
    }
}
