package com.blogstat.collector.metric;

import com.blogstat.domain.MetricRow;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 통계 API 응답을 {@link MetricRow}로 푼다.
 * rows는 행 배열이 아니라 컬럼별 배열이라, 같은 인덱스끼리 묶어서 행으로 만든다.
 * 배열 길이가 서로 다르면 어느 값이 어느 행의 것인지 알 수 없으므로 저장하지 않고 예외를 던진다.
 */
@Component
public class MetricParser {

    private final ObjectMapper mapper = new ObjectMapper();

    /**
     * @param requested 하루 단위 지표에서 요청한 날짜(행의 날짜가 된다)
     * @param today     이 날짜 이후의 시계열 행은 집계 중이라 버린다
     */
    public List<MetricRow> parse(String json, MetricSpec spec, LocalDate requested, LocalDate today,
                                 LocalDateTime collectedAt) {
        return parse(json, spec, requested, today, collectedAt, null);
    }

    /**
     * @param key 게시글별 지표에서 행 구분으로 쓸 게시글 번호. 그 밖에는 null
     */
    public List<MetricRow> parse(String json, MetricSpec spec, LocalDate requested, LocalDate today,
                                 LocalDateTime collectedAt, String key) {
        if (spec.isValue()) {
            return parseValue(json, spec, requested, collectedAt, key);
        }
        JsonNode rows = rowsOf(json, spec);
        List<String> names = new ArrayList<>();
        for (Iterator<String> it = rows.fieldNames(); it.hasNext(); ) {
            names.add(it.next());
        }
        int size = rowCount(rows, names, spec);

        List<MetricRow> result = new ArrayList<>();
        for (int i = 0; i < size; i++) {
            Map<String, Object> values = new LinkedHashMap<>();
            for (String name : names) {
                values.put(name, scalar(rows.get(name).get(i)));
            }
            if (spec.isSeries()) {
                LocalDate date = seriesDate(values.remove("date"), spec);
                if (!date.isBefore(today)) {
                    continue; // 오늘은 집계 중이라 확정값이 아니다.
                }
                result.add(new MetricRow(date, spec.id(), key != null ? key : "all", write(values), collectedAt));
            } else {
                result.add(new MetricRow(requested, spec.id(), dayKey(values, i, spec), write(values), collectedAt));
            }
        }
        if (!spec.isSeries() && result.isEmpty()) {
            result.add(new MetricRow(requested, spec.id(), MetricRow.EMPTY_KEY, "{}", collectedAt));
        }
        if (!spec.isSeries() && isPending(rows, spec)) {
            return List.of(); // 집계 전. 저장하지 않으면 빈 표시도 남지 않아 다음 실행에서 다시 받는다.
        }
        return result;
    }

    /**
     * rows가 아니라 data.value 객체로 오는 지표. 지정한 블록들의 value를 훑어서
     * 객체인 항목은 항목 이름을 행 구분으로 한 행으로, 객체가 아닌 값들은 모아서 한 행(value, 또는 게시글 번호)으로 만든다.
     * 지정한 블록이 하나도 없으면 잘못된 응답으로 보고 예외를 던진다. 일부만 없는 것은 허용한다(선택 정보).
     */
    private List<MetricRow> parseValue(String json, MetricSpec spec, LocalDate requested, LocalDateTime collectedAt,
                                       String key) {
        JsonNode root = readRoot(json, spec);
        Map<String, Object> scalars = new LinkedHashMap<>();
        List<MetricRow> result = new ArrayList<>();
        int found = 0;
        for (String blockId : spec.blockIds()) {
            JsonNode value = blockOf(root, blockId).path("data").path("value");
            if (!value.isObject()) {
                continue;
            }
            found++;
            for (Map.Entry<String, JsonNode> field : value.properties()) {
                if (field.getValue().isObject()) {
                    Map<String, Object> nested = new LinkedHashMap<>();
                    field.getValue().properties().forEach(f -> nested.put(f.getKey(), scalar(f.getValue())));
                    result.add(new MetricRow(requested, spec.id(), field.getKey(), write(nested), collectedAt));
                } else {
                    scalars.put(field.getKey(), scalar(field.getValue()));
                }
            }
        }
        if (found == 0) {
            throw new MetricParseException(spec.id() + " 응답에 " + spec.blockId() + " 블록의 value가 없음");
        }
        if (!scalars.isEmpty()) {
            result.add(new MetricRow(requested, spec.id(), key != null ? key : MetricSpec.VALUE_ROW, write(scalars),
                    collectedAt));
        }
        return result;
    }

    /** pendingColumn이 정해진 지표에서 그 컬럼 값이 모두 0이면 네이버가 아직 집계하지 않은 날이다. */
    private static boolean isPending(JsonNode rows, MetricSpec spec) {
        if (spec.pendingColumn() == null) {
            return false;
        }
        JsonNode column = rows.get(spec.pendingColumn());
        if (column == null || !column.isArray()) {
            return false;
        }
        for (JsonNode value : column) {
            if (value.asDouble() != 0) {
                return false;
            }
        }
        return true;
    }

    private JsonNode readRoot(String json, MetricSpec spec) {
        JsonNode root;
        try {
            root = mapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new MetricParseException(spec.id() + " JSON 파싱 실패", e);
        }
        if (root.path("statusCode").asInt() != 200) {
            throw new MetricParseException(spec.id() + " API statusCode가 200이 아님: " + root.path("statusCode"));
        }
        return root;
    }

    /** dataId가 blockId인 블록. 없으면 MissingNode. */
    private static JsonNode blockOf(JsonNode root, String blockId) {
        for (JsonNode block : root.path("result").path("statDataList")) {
            if (blockId.equals(block.path("dataId").asText())) {
                return block;
            }
        }
        return com.fasterxml.jackson.databind.node.MissingNode.getInstance();
    }

    private JsonNode rowsOf(String json, MetricSpec spec) {
        JsonNode block = blockOf(readRoot(json, spec), spec.blockId());
        if (block.isMissingNode()) {
            throw new MetricParseException(spec.id() + " 응답에 " + spec.blockId() + " 블록이 없음");
        }
        JsonNode rows = block.path("data").path("rows");
        if (!rows.isObject()) {
            // 하루 단위 지표는 그 날 항목이 없으면 블록은 오되 rows가 빠진다(예: 재생한 동영상이 없는 날 rank_play_cnt).
            // 블록 자체가 없는 것과 달리 정상 응답이라 빈 날로 읽는다. 시계열은 구조 변경일 수 있어 엄격하게 둔다.
            if (!spec.isSeries()) {
                return mapper.createObjectNode();
            }
            throw new MetricParseException(spec.id() + " 블록 " + spec.blockId() + "에 rows가 없음");
        }
        return rows;
    }

    private static int rowCount(JsonNode rows, List<String> names, MetricSpec spec) {
        int size = -1;
        for (String name : names) {
            JsonNode column = rows.get(name);
            if (!column.isArray()) {
                throw new MetricParseException(spec.id() + " 컬럼 " + name + "이 배열이 아님");
            }
            if (size >= 0 && column.size() != size) {
                throw new MetricParseException(spec.id() + " 컬럼 배열 길이가 서로 다름: " + name
                        + " " + column.size() + " != " + size);
            }
            size = column.size();
        }
        return Math.max(size, 0);
    }

    private static LocalDate seriesDate(Object raw, MetricSpec spec) {
        try {
            return LocalDate.parse(String.valueOf(raw));
        } catch (DateTimeParseException e) {
            throw new MetricParseException(spec.id() + " 날짜 형식을 읽지 못함: " + raw, e);
        }
    }

    /** 행 구분값: 순서 이름 > 지정한 컬럼 값 > 순번(순위처럼 같은 값이 겹칠 수 있는 경우). */
    private static String dayKey(Map<String, Object> values, int index, MetricSpec spec) {
        if (!spec.indexKeys().isEmpty()) {
            return index < spec.indexKeys().size() ? spec.indexKeys().get(index) : "i" + index;
        }
        if (spec.keyColumn() != null) {
            Object key = values.get(spec.keyColumn());
            if (key == null) {
                throw new MetricParseException(spec.id() + " 행 구분 컬럼 " + spec.keyColumn() + "이 없음");
            }
            return String.valueOf(key);
        }
        return String.format("r%03d", index + 1);
    }

    private static Object scalar(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isIntegralNumber()) {
            return node.asLong();
        }
        if (node.isNumber()) {
            return node.asDouble();
        }
        return node.asText();
    }

    private String write(Map<String, Object> values) {
        try {
            return mapper.writeValueAsString(values);
        } catch (JsonProcessingException e) {
            throw new MetricParseException("payload 직렬화 실패", e);
        }
    }
}
