package com.blogstat.collector;

import com.fasterxml.jackson.databind.JsonNode;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 통계 메뉴 탐색(catalog)의 순수 로직. 브라우저 없이 테스트한다.
 * 값은 다루지 않고 구조(키, 컬럼 이름, 개수)만 뽑는다. 개인 통계 값이 콘솔에 찍히지 않게 하려는 것이다.
 */
public final class CatalogSupport {

    static final String STAT_HOST = "blog.stat.naver.com";
    // 객체 중첩만 센다(배열은 세지 않음). 네이버 응답은 result.statDataList[].data.rows.<컬럼> 정도로 깊다.
    private static final int MAX_DEPTH = 6;
    private static final int MAX_KEYS = 25;

    private CatalogSupport() {
    }

    /** 같은 통계 도메인의 /m/blog/ 페이지만 남기고, 순서를 지키며 중복을 없앤다. */
    public static List<String> statPageLinks(Collection<String> hrefs) {
        Set<String> out = new LinkedHashSet<>();
        for (String href : hrefs) {
            if (href == null) {
                continue;
            }
            try {
                URI uri = URI.create(href.trim());
                if (!"https".equalsIgnoreCase(uri.getScheme()) || !STAT_HOST.equalsIgnoreCase(uri.getHost())) {
                    continue;
                }
                String path = uri.getRawPath() == null ? "" : uri.getRawPath();
                if (!path.startsWith("/m/blog")) {
                    continue;
                }
                // 쿼리는 떼고 경로만으로 페이지를 구분한다. #ct(본문 바로가기), # 같은 앵커는 같은 화면이라 버리고,
                // #/... 형태의 해시 라우트만 다른 화면으로 본다.
                String fragment = uri.getRawFragment();
                boolean hashRoute = fragment != null && fragment.startsWith("/");
                out.add("https://" + STAT_HOST + path + (hashRoute ? "#" + fragment : ""));
            } catch (IllegalArgumentException ignored) {
                // javascript: 등 URI가 아닌 href
            }
        }
        return new ArrayList<>(out);
    }

    /**
     * 같은 종류의 화면을 한 번만 보기 위한 키. 글 번호처럼 긴 숫자는 {id}로 바꾼다.
     * 예: /m/blog/article/224000000101/cv → /m/blog/article/{id}/cv (글마다 같은 API를 부른다)
     */
    public static String pagePattern(String pageUrl) {
        return pageUrl.replaceAll("/\\d{6,}(?=/|$|#)", "/{id}");
    }

    /** 통계 API 응답인지(같은 도메인의 /api/). */
    public static boolean isStatApi(String url) {
        try {
            URI uri = URI.create(url);
            return STAT_HOST.equalsIgnoreCase(uri.getHost())
                    && uri.getRawPath() != null && uri.getRawPath().startsWith("/api/");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** API 경로(쿼리 제외). 같은 API를 한 번만 저장하는 키로 쓴다. */
    public static String apiPath(String url) {
        return URI.create(url).getRawPath();
    }

    /** 쿼리 파라미터. 캐시 방지용 `_`는 매번 바뀌므로 뺀다. 값은 디코딩한다. */
    public static Map<String, String> params(String url) {
        Map<String, String> out = new LinkedHashMap<>();
        String query = URI.create(url).getRawQuery();
        if (query == null || query.isEmpty()) {
            return out;
        }
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String key = decode(eq < 0 ? pair : pair.substring(0, eq));
            String value = eq < 0 ? "" : decode(pair.substring(eq + 1));
            if (!"_".equals(key)) {
                out.put(key, value);
            }
        }
        return out;
    }

    /**
     * JSON의 구조만 한 줄로 요약한다. 객체는 키, 배열은 길이와 첫 원소의 구조, 값은 타입만 쓴다.
     * 예: {result:{rows:{date:[30]str, cv:[30]num}}}
     */
    public static String shape(JsonNode node) {
        StringBuilder sb = new StringBuilder();
        shape(node, 0, sb);
        return sb.toString();
    }

    private static void shape(JsonNode node, int depth, StringBuilder sb) {
        if (node == null || node.isNull()) {
            sb.append("null");
        } else if (node.isObject()) {
            if (depth >= MAX_DEPTH) {
                sb.append("{…}");
                return;
            }
            sb.append('{');
            Iterator<Map.Entry<String, JsonNode>> it = node.properties().iterator();
            int n = 0;
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                if (n++ > 0) {
                    sb.append(", ");
                }
                if (n > MAX_KEYS) {
                    sb.append("…+").append(node.size() - MAX_KEYS);
                    break;
                }
                sb.append(e.getKey()).append(':');
                shape(e.getValue(), depth + 1, sb);
            }
            sb.append('}');
        } else if (node.isArray()) {
            sb.append('[').append(node.size()).append(']');
            if (node.size() > 0) {
                shape(node.get(0), depth, sb);
            }
        } else if (node.isNumber()) {
            sb.append("num");
        } else if (node.isBoolean()) {
            sb.append("bool");
        } else {
            sb.append("str");
        }
    }

    private static String decode(String s) {
        return URLDecoder.decode(s, StandardCharsets.UTF_8);
    }
}
