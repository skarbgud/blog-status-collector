package com.example.blogstat.collector.source;

import com.example.blogstat.collector.RefererDay;
import com.example.blogstat.collector.RefererParseException;
import com.example.blogstat.collector.RefererParser;
import com.example.blogstat.collector.RefererRow;
import com.example.blogstat.collector.SearchQueryRow;
import com.example.blogstat.collector.core.CollectSettings;
import com.example.blogstat.collector.core.StatHttp;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;

/**
 * 유입경로 합계 + 검색 유입처별 검색어. 하루에 1 + (검색 유입처 수)번 요청한다.
 */
@Component
public class RefererSource implements StatSource<RefererDay> {

    public static final String ID = "REFERER";
    private static final String API_PATH = "/api/blog/daily/referer/total";

    private final RefererParser parser;
    private final String baseUrl;
    private final int querySize;
    private final Supplier<String> nonce;

    @Autowired
    public RefererSource(RefererParser parser, CollectSettings settings) {
        this(parser, settings.baseUrl(), settings.querySize(), RefererSource::randomNonce);
    }

    RefererSource(RefererParser parser, String baseUrl, int querySize, Supplier<String> nonce) {
        this.parser = parser;
        this.baseUrl = baseUrl;
        this.querySize = querySize;
        this.nonce = nonce;
    }

    @Override
    public String id() {
        return ID;
    }

    @Override
    public RefererDay fetch(StatHttp http, LocalDate date) {
        RefererDay day = parser.parse(http.get(totalUrl(baseUrl, date, nonce.get()), date.toString()), date);
        if (day.today()) {
            return day; // 집계 중인 오늘 데이터는 저장하지 않으므로 검색어도 가져오지 않는다.
        }
        return day.withQueries(fetchQueries(http, day));
    }

    /**
     * 검색 유입처(searchEngine=true)마다 하위 검색어를 가져온다.
     * 한 유입처의 검색어를 못 가져와도 그 날의 나머지 데이터는 살린다.
     * 세션 만료와 예산 소진은 IllegalStateException이 아니므로 잡히지 않고 그대로 중단된다.
     */
    private List<SearchQueryRow> fetchQueries(StatHttp http, RefererDay day) {
        List<SearchQueryRow> all = new ArrayList<>();
        for (RefererRow row : day.rows()) {
            if (!row.searchEngine()) {
                continue;
            }
            String label = day.date() + " " + row.referrer() + " 검색어";
            try {
                String url = detailUrl(baseUrl, day.date(), row.referrer(), querySize, nonce.get());
                List<SearchQueryRow> queries = parser.parseQueries(http.get(url, label), day.date(), row.referrer());
                int sum = queries.stream().mapToInt(SearchQueryRow::visits).sum();
                if (sum != row.visits()) {
                    System.out.println("[경고] " + label + " 합계 " + sum + " != 유입처 방문수 " + row.visits()
                            + " (상한 size=" + querySize + " 때문에 일부만 왔을 수 있음)");
                }
                all.addAll(queries);
            } catch (IllegalStateException | RefererParseException e) {
                if (Thread.currentThread().isInterrupted()) {
                    throw e;
                }
                System.out.println("[경고] " + label + " 수집 실패, 이 유입처의 검색어는 건너뜁니다: " + e.getMessage());
            }
        }
        return all;
    }

    static String totalUrl(String baseUrl, LocalDate date, String nonce) {
        return baseUrl + API_PATH
                + "?timeDimension=DATE&additionalTimeDimension=WEEK"
                + "&startDate=" + date
                + "&exclude=weekAndMonthAnalysis"
                + "&_=" + nonce;
    }

    /** 검색 유입처 하나의 하위 항목(검색어) API 주소. 공백은 화면과 같이 %20으로 인코딩한다. */
    static String detailUrl(String baseUrl, LocalDate date, String referrer, int size, String nonce) {
        String encoded = URLEncoder.encode(referrer, StandardCharsets.UTF_8).replace("+", "%20");
        return baseUrl + API_PATH + "/detail"
                + "?timeDimension=DATE&additionalTimeDimension=WEEK"
                + "&startDate=" + date
                + "&searchEngine=1"
                + "&refererDomain=" + encoded
                + "&size=" + size
                + "&exclude="
                + "&_=" + nonce;
    }

    private static String randomNonce() {
        return System.currentTimeMillis() + "_" + ThreadLocalRandom.current().nextInt(10_000);
    }
}
