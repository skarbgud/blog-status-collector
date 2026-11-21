package com.example.blogstat.collector.metric;

import com.example.blogstat.collector.core.CollectSettings;
import com.example.blogstat.collector.core.NaverStatClient;
import com.example.blogstat.collector.core.StatHttp;
import com.example.blogstat.domain.MetricRow;
import com.example.blogstat.domain.MetricService;
import com.example.blogstat.replica.SnapshotPublisher;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.ObjectProvider;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 크롬 확장(TS) 이식용 골든 데이터를 만든다. 평소 테스트에서는 꺼져 있고, 환경변수 GOLDEN_DIR이 있을 때만 돈다.
 * <pre>GOLDEN_DIR=extension/test ./gradlew test --tests '*GoldenDumpTest'</pre>
 * - fixtures/parser-cases.json을 MetricParser에 넣은 결과 → golden/metric-parser.json
 * - 수집 시나리오(요청 주소 순서, 응답, 저장·삭제 호출) → golden/metric-job.json
 * TS 테스트는 같은 입력으로 결과가 이 파일과 같은지 확인한다. 저장 시각(collectedAt)은 비교하지 않는다.
 */
@EnabledIfEnvironmentVariable(named = "GOLDEN_DIR", matches = ".+")
class GoldenDumpTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-21T00:00:00Z"), ZoneId.of("Asia/Seoul"));
    private static final String BASE = "https://blog.stat.naver.com";

    private final Path dir = Path.of(System.getenv("GOLDEN_DIR"));

    @Test
    void 파서_골든() throws IOException {
        JsonNode cases = MAPPER.readTree(dir.resolve("fixtures/parser-cases.json").toFile());
        MetricParser parser = new MetricParser();
        ArrayNode out = MAPPER.createArrayNode();
        for (JsonNode c : cases) {
            ObjectNode result = out.addObject();
            result.put("name", c.get("name").asText());
            MetricSpec spec = MetricSpecs.find(c.get("spec").asText()).orElseThrow();
            String key = c.get("key").isNull() ? null : c.get("key").asText();
            try {
                List<MetricRow> rows = parser.parse(MAPPER.writeValueAsString(c.get("body")), spec,
                        LocalDate.parse(c.get("requested").asText()), LocalDate.parse(c.get("today").asText()),
                        CLOCK.instant().atZone(CLOCK.getZone()).toLocalDateTime(), key);
                result.set("rows", rowsJson(rows));
            } catch (MetricParseException e) {
                result.put("error", true);
            }
        }
        write("golden/metric-parser.json", out);
    }

    /** 시나리오 하나: 저장소 상태(이미 받은 날짜·키·게시글)와 응답 규칙. 저장소 상태는 실행 중 바뀌지 않는다. */
    private record Scenario(String name, List<String> specs, String from, String to, boolean force,
                            Map<String, List<String>> datesWith, Map<String, List<String>> keysWith,
                            List<String> postIds, Function<String, Object> responder) {
    }

    @Test
    void 수집_골든() throws IOException {
        List<String> all = MetricSpecs.ALL.stream().map(MetricSpec::id).toList();
        List<Scenario> scenarios = List.of(
                new Scenario("처음 수집 3일, 전체 지표, 게시글 하나는 400", all, "2026-11-18", "2026-11-20", false,
                        Map.of(), Map.of(), List.of("224000000001", "224000000002"),
                        url -> url.contains("contentId=224000000002") ? (Object) 400 : genericBody()),
                new Scenario("이미 받은 날짜·시간대·게시글은 건너뜀, 20일", all, "2026-11-01", "2026-11-20", false,
                        Map.of("DEMO", List.of("2026-11-20", "2026-11-19"),
                                "HOUR", List.of("2026-11-20"),
                                "UPPER_GROUP", List.of("2026-10-01"),
                                "REL_DEMO_ADD", List.of("2026-11-09"),
                                "COUNTRY", List.of("2026-11-05")),
                        Map.of("HOUR_TREND@2026-11-20", hours(0, 21),
                                "ARTICLE_INFO@2026-11-20", List.of("224000000001")),
                        List.of("224000000001", "224000000003", "224000000002"),
                        url -> genericBody()),
                new Scenario("force면 있어도 다시 받음", List.of("VIEWS", "HOUR", "ARTICLE_CV", "ARTICLE_INFO"),
                        "2026-11-19", "2026-11-20", true,
                        Map.of("HOUR", List.of("2026-11-20", "2026-11-19")),
                        Map.of("ARTICLE_CV@2026-11-20", List.of("224000000001")),
                        List.of("224000000001"), url -> genericBody()),
                new Scenario("시간대 집계 전이면 지우고 저장 안 함, 다른 날은 저장", List.of("HOUR"),
                        "2026-11-19", "2026-11-20", false, Map.of(), Map.of(), List.of(),
                        url -> url.contains("startDate=2026-11-20")
                                ? body("hour", "{\"date\":[\"00\",\"01\"],\"cv\":[0,0]}")
                                : body("hour", "{\"date\":[\"00\",\"01\"],\"cv\":[1,0]}")),
                new Scenario("응답을 못 읽거나 500이면 그 요청만 실패로 세고 계속", List.of("VIEWS", "DEMO", "COUNTRY"),
                        "2026-11-20", "2026-11-20", false, Map.of(), Map.of(), List.of(),
                        url -> url.contains("/visit/cv") ? body("cv", "{\"date\":[\"2026-11-20\"],\"total\":[1,2]}")
                                : url.contains("/country") ? (Object) 500 : genericBody()),
                new Scenario("주간·월간 경계: 일요일로 끝나는 기간", List.of("REVISIT_WEEKLY", "REL_DEMO_ADD", "UPPER_GROUP"),
                        "2026-10-20", "2026-11-15", false, Map.of(), Map.of(), List.of(), url -> genericBody()));

        ArrayNode out = MAPPER.createArrayNode();
        for (Scenario s : scenarios) {
            out.add(run(s));
        }
        write("golden/metric-job.json", out);
    }

    private ObjectNode run(Scenario s) {
        MetricService service = mock(MetricService.class);
        ObjectNode result = MAPPER.createObjectNode();
        ArrayNode calls = MAPPER.createArrayNode();
        ArrayNode exchanges = MAPPER.createArrayNode();
        List<String> bodies = new ArrayList<>();

        when(service.datesWith(anyString(), any(), any())).thenAnswer(inv -> {
            String metric = inv.getArgument(0);
            LocalDate from = inv.getArgument(1);
            LocalDate to = inv.getArgument(2);
            return s.datesWith().getOrDefault(metric, List.of()).stream().map(LocalDate::parse)
                    .filter(d -> !d.isBefore(from) && !d.isAfter(to)).collect(Collectors.toSet());
        });
        when(service.keysWith(anyString(), any())).thenAnswer(inv ->
                Set.copyOf(s.keysWith().getOrDefault(inv.getArgument(0) + "@" + inv.getArgument(1), List.of())));
        when(service.postIds(any(), any())).thenAnswer(inv -> new TreeSet<>(s.postIds()));
        when(service.replace(anyString(), any(), any())).thenAnswer(inv -> {
            List<MetricRow> rows = inv.getArgument(1);
            ObjectNode call = calls.addObject();
            call.put("op", "replace");
            call.put("metric", (String) inv.getArgument(0));
            call.put("rowKey", (String) inv.getArgument(2));
            call.set("rows", rowsJson(rows));
            return (int) rows.stream().filter(r -> !MetricRow.EMPTY_KEY.equals(r.getRowKey())).count();
        });
        when(service.clear(anyString(), any())).thenAnswer(inv -> {
            ObjectNode call = calls.addObject();
            call.put("op", "clear");
            call.put("metric", (String) inv.getArgument(0));
            call.put("date", inv.getArgument(1).toString());
            return 0;
        });

        CollectSettings settings = mock(CollectSettings.class);
        when(settings.baseUrl()).thenReturn(BASE);
        @SuppressWarnings("unchecked")
        ObjectProvider<SnapshotPublisher> publisher = mock(ObjectProvider.class);
        MetricCollectJob job = new MetricCollectJob(mock(NaverStatClient.class), service, settings, CLOCK, publisher,
                new MetricParser(), 10_000);

        StatHttp http = (url, label) -> {
            String clean = url.replaceAll("&_=[^&]*", "");
            Object response = s.responder().apply(clean);
            ObjectNode ex = exchanges.addObject();
            ex.put("url", clean.substring(BASE.length()));
            if (response instanceof Integer status) {
                ex.put("status", status);
                throw new IllegalStateException(label + " 수집 실패: HTTP " + status);
            }
            ex.put("status", 200);
            int index = bodies.indexOf((String) response);
            if (index < 0) {
                bodies.add((String) response);
                index = bodies.size() - 1;
            }
            ex.put("body", index); // 같은 본문이 반복되므로 bodies 배열의 번호로 남긴다
            return (String) response;
        };

        List<MetricSpec> specs = s.specs().stream().map(id -> MetricSpecs.find(id).orElseThrow()).toList();
        MetricCollectJob.Result r = job.execute(http,
                new MetricCollectJob.Plan(specs, LocalDate.parse(s.from()), LocalDate.parse(s.to()), s.force()));

        result.put("name", s.name());
        ObjectNode input = result.putObject("input");
        input.set("specs", MAPPER.valueToTree(s.specs()));
        input.put("from", s.from());
        input.put("to", s.to());
        input.put("force", s.force());
        input.set("datesWith", MAPPER.valueToTree(s.datesWith()));
        input.set("keysWith", MAPPER.valueToTree(s.keysWith()));
        input.set("postIds", MAPPER.valueToTree(s.postIds()));
        result.set("bodies", MAPPER.valueToTree(bodies));
        result.set("exchanges", exchanges);
        result.set("calls", calls);
        result.set("saved", MAPPER.valueToTree(r.saved()));
        result.put("failures", r.failures());
        return result;
    }

    private static List<String> hours(int fromInclusive, int toExclusive) {
        List<String> list = new ArrayList<>();
        for (int h = fromInclusive; h < toExclusive; h++) {
            list.add(String.format("%02d", h));
        }
        return list;
    }

    private static String body(String blockId, String rows) {
        return "{\"statusCode\":200,\"result\":{\"statDataList\":[{\"dataId\":\"" + blockId
                + "\",\"data\":{\"rows\":" + rows + "}}]}}";
    }

    /** 모든 지표의 블록을 담은 응답. 시계열 행 중 하나는 오늘(11/21)이라 버려져야 한다. */
    private static String genericBody() {
        String rows = "{\"date\":[\"2026-11-19\",\"2026-11-21\"],\"total\":[5,6],\"visit\":[5,6],\"age\":[\"total\",\"01\"],"
                + "\"country\":[\"KR\",\"US\"],\"cv\":[1,2],\"pc\":[1,0],\"mobile\":[2,3],\"dimension1\":[\"주제\",\"기타\"],"
                + "\"searchQuery\":[\"q\",\"r\"],\"referrerDomain\":[\"d\",\"e\"],\"vid\":[\"v1\",\"v2\"],\"rank\":[1,2],"
                + "\"uri\":[\"http://blog.naver.com/me/224000000001\",\"http://blog.naver.com/me/224000000009\"]}";
        StringBuilder blocks = new StringBuilder();
        Set<String> seen = new java.util.HashSet<>();
        for (MetricSpec spec : MetricSpecs.ALL) {
            for (String id : spec.blockIds()) {
                String blockKey = id + (spec.isValue() ? "#v" : "#r");
                if (!seen.add(blockKey) || (!spec.isValue() && seen.contains(id + "#v")) || (spec.isValue() && seen.contains(id + "#r"))) {
                    continue;
                }
                blocks.append(blocks.length() == 0 ? "" : ",");
                blocks.append(spec.isValue()
                        ? "{\"dataId\":\"" + id + "\",\"data\":{\"value\":" + valueFor(id) + "}}"
                        : "{\"dataId\":\"" + id + "\",\"data\":{\"rows\":" + rows + "}}");
            }
        }
        return "{\"statusCode\":200,\"result\":{\"statDataList\":[" + blocks + "]}}";
    }

    private static String valueFor(String blockId) {
        return switch (blockId) {
            case "upperGroup" -> "{\"cv\":{\"top_avg\":10.5,\"service_avg\":4.5,\"max\":99}}";
            case "averageUserData" -> "{\"cv\":16492,\"uv\":9361}";
            case "articleInfo" -> "{\"title\":\"글 제목\",\"url\":\"http://blog.naver.com/me/111\"}";
            default -> "{\"cvTotal\":614,\"likeTotal\":89,\"isToday\":false}";
        };
    }

    private static ArrayNode rowsJson(List<MetricRow> rows) {
        ArrayNode arr = MAPPER.createArrayNode();
        for (MetricRow row : rows) {
            ObjectNode o = arr.addObject();
            o.put("statDate", row.getStatDate().toString());
            o.put("metric", row.getMetric());
            o.put("rowKey", row.getRowKey());
            try {
                o.set("payload", MAPPER.readTree(row.getPayload()));
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }
        return arr;
    }

    private void write(String relative, JsonNode node) throws IOException {
        Path file = dir.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(node) + "\n");
    }
}
