package com.blogstat.collector;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;

/**
 * /api/blog/daily/referer/total 응답을 파싱한다.
 * rows는 행 배열이 아니라 컬럼별 배열이라, 같은 인덱스끼리 묶어서 행으로 만든다.
 */
@Component
public class RefererParser {

    private static final String DATA_ID_TOTAL = "refererTotal";
    private static final String DATA_ID_TOTAL_COUNT = "refererTotalCount";
    private static final String DATA_ID_DASHBOARD = "dashboard";

    private final ObjectMapper mapper = new ObjectMapper();

    public RefererDay parse(String json, LocalDate requestedDate) {
        JsonNode root;
        try {
            root = mapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new RefererParseException("JSON 파싱 실패", e);
        }

        if (root.path("statusCode").asInt() != 200) {
            throw new RefererParseException("API statusCode가 200이 아님: " + root.path("statusCode"));
        }

        JsonNode list = root.path("result").path("statDataList");
        JsonNode total = find(list, DATA_ID_TOTAL);
        if (total == null) {
            throw new RefererParseException("응답에 " + DATA_ID_TOTAL + " 블록이 없음");
        }

        JsonNode rows = total.path("data").path("rows");
        JsonNode dates = column(rows, "date");
        JsonNode domains = column(rows, "referrerDomain");
        JsonNode engines = column(rows, "referrerSearchEngine");
        JsonNode visits = column(rows, "cv");
        JsonNode ratios = column(rows, "cv_p");

        int size = dates.size();
        if (domains.size() != size || engines.size() != size || visits.size() != size || ratios.size() != size) {
            throw new RefererParseException("컬럼 배열 길이가 서로 다름");
        }

        List<RefererRow> result = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            LocalDate rowDate = parseDate(dates.get(i).asText());
            if (!rowDate.equals(requestedDate)) {
                throw new RefererParseException(
                        "요청 날짜(" + requestedDate + ")와 응답 날짜(" + rowDate + ")가 다름");
            }
            result.add(new RefererRow(
                    rowDate,
                    domains.get(i).asText(),
                    "1".equals(engines.get(i).asText()),
                    visits.get(i).asInt(),
                    ratios.get(i).asDouble()));
        }

        int totalCount = readTotalCount(list);
        int sum = result.stream().mapToInt(RefererRow::visits).sum();
        if (totalCount >= 0 && sum != totalCount) {
            throw new RefererParseException(
                    "유입 합계 불일치: 행 합계 " + sum + " != refererTotalCount " + totalCount);
        }

        boolean today = find(list, DATA_ID_DASHBOARD) != null
                && find(list, DATA_ID_DASHBOARD).path("data").path("value").path("isToday").asBoolean(false);

        return new RefererDay(requestedDate, List.copyOf(result), totalCount, today);
    }

    /**
     * /api/blog/daily/referer/total/detail (검색 유입처 하나의 하위 항목) 응답에서 검색어를 읽는다.
     * 합계 검증은 하지 않는다. size 상한 때문에 일부만 올 수 있어서, 호출한 쪽이 유입처 방문수와 비교해 경고한다.
     */
    public List<SearchQueryRow> parseQueries(String json, LocalDate requestedDate, String referrerName) {
        JsonNode root;
        try {
            root = mapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new RefererParseException("검색어 응답 JSON 파싱 실패", e);
        }
        if (root.path("statusCode").asInt() != 200) {
            throw new RefererParseException("검색어 API statusCode가 200이 아님: " + root.path("statusCode"));
        }
        JsonNode detail = find(root.path("result").path("statDataList"), "refererDetail");
        if (detail == null) {
            throw new RefererParseException("검색어 응답에 refererDetail 블록이 없음");
        }

        JsonNode rows = detail.path("data").path("rows");
        JsonNode dates = column(rows, "date");
        JsonNode queries = column(rows, "searchQuery");
        JsonNode visits = column(rows, "cv");
        JsonNode ratios = column(rows, "cv_p");

        int size = dates.size();
        if (queries.size() != size || visits.size() != size || ratios.size() != size) {
            throw new RefererParseException("검색어 컬럼 배열 길이가 서로 다름");
        }

        List<SearchQueryRow> result = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            LocalDate rowDate = parseDate(dates.get(i).asText());
            if (!rowDate.equals(requestedDate)) {
                throw new RefererParseException(
                        "요청 날짜(" + requestedDate + ")와 검색어 응답 날짜(" + rowDate + ")가 다름");
            }
            String query = queries.get(i).asText("").strip();
            if (query.isEmpty()) {
                continue; // 검색어가 비어 있는 행은 목록에 보여줄 수 없다.
            }
            result.add(new SearchQueryRow(rowDate, referrerName, query, visits.get(i).asInt(),
                    ratios.get(i).asDouble()));
        }
        return result;
    }

    private static JsonNode find(JsonNode statDataList, String dataId) {
        for (JsonNode node : statDataList) {
            if (dataId.equals(node.path("dataId").asText())) {
                return node;
            }
        }
        return null;
    }

    private static JsonNode column(JsonNode rows, String name) {
        JsonNode col = rows.path(name);
        if (!col.isArray()) {
            throw new RefererParseException("rows." + name + " 컬럼이 없거나 배열이 아님");
        }
        return col;
    }

    private static int readTotalCount(JsonNode list) {
        JsonNode node = find(list, DATA_ID_TOTAL_COUNT);
        if (node == null || !node.path("data").path("value").isNumber()) {
            return -1;
        }
        return node.path("data").path("value").asInt();
    }

    private static LocalDate parseDate(String text) {
        try {
            return LocalDate.parse(text);
        } catch (DateTimeParseException e) {
            throw new RefererParseException("날짜 형식 오류: " + text, e);
        }
    }
}
