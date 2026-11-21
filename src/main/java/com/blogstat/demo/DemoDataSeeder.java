package com.blogstat.demo;

import com.blogstat.collector.RefererDay;
import com.blogstat.collector.RefererRow;
import com.blogstat.collector.SearchQueryRow;
import com.blogstat.domain.ReferrerDailyService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * `--spring.profiles.active=demo`: 시연용. 인메모리 H2에 가짜 통계를 넣고 대시보드를 띄운다.
 *
 * 시연 중에는 수집을 돌리지 않는다. 실제 DB 파일(./data)도, 로그인 쿠키도, 네이버도 건드리지 않으므로
 * H2 파일 잠금이나 세션 만료 때문에 시연이 깨지지 않고, 개인 통계나 실제 검색어가 화면에 나오지 않는다.
 *
 * 데이터는 시드가 고정된 난수라 매번 같다. 검색어 변화 패널의 각 경우가 다 보이도록 시나리오를 넣었다:
 * 꾸준함, 상승, 하락, 끊김, 다시 온 검색어(새 검색어 아님), 새로 뜬 검색어, 띄어쓰기만 다른 표기.
 * 실제 수집과 같은 저장 경로(ReferrerDailyService.save)로 넣는다.
 */
@Component
@Profile("demo")
public class DemoDataSeeder implements ApplicationRunner {

    static final int DAYS = 42;

    private static final String INTEGRATED = "네이버 통합검색_모바일";
    private static final String BLOG_SEARCH = "네이버 블로그검색_모바일";
    private static final String GOOGLE = "Google";
    private static final List<String> ENGINES = List.of(INTEGRATED, BLOG_SEARCH, GOOGLE);

    /** 롱테일: 가끔 1회씩 들어오는 검색어. */
    private static final List<String> TAIL = List.of(
            "스프링 트랜잭션 전파", "자바 스트림 그룹핑", "레디스 캐시 만료", "코틀린 코루틴 입문",
            "MySQL 인덱스 설계", "Gradle 멀티모듈", "테스트 픽스처 관리", "REST API 버전 관리",
            "JUnit5 파라미터 테스트", "HTTP 429 재시도");

    private final ReferrerDailyService service;
    private final Clock clock;

    public DemoDataSeeder(ReferrerDailyService service, Clock clock, Environment env,
                          @Value("${app.mode}") String mode) {
        // 데모는 인메모리 DB만 쓴다. 수집 모드나 대시보드(스냅샷) 프로필과 섞이면 의미가 꼬이므로 막는다.
        if (!"none".equals(mode)) {
            throw new IllegalStateException("demo 프로필은 --app.mode=" + mode + "와 함께 켤 수 없습니다.");
        }
        if (env.matchesProfiles("dashboard")) {
            throw new IllegalStateException("demo와 dashboard 프로필은 함께 켤 수 없습니다. demo만 켜세요.");
        }
        this.service = service;
        this.clock = clock;
    }

    @Override
    public void run(ApplicationArguments args) {
        LocalDate yesterday = LocalDate.now(clock).minusDays(1);
        for (RefererDay day : generate(yesterday)) {
            service.save(day);
        }
        System.out.println("[데모] 가짜 데이터 " + DAYS + "일치를 넣었습니다(" + yesterday.minusDays(DAYS - 1L)
                + " ~ " + yesterday + "). 실제 DB와 네이버는 건드리지 않습니다.");
    }

    /** 기준일(어제)까지 DAYS일. 순수 함수라 테스트에서 그대로 쓴다. */
    static List<RefererDay> generate(LocalDate lastDay) {
        Random rnd = new Random(42);
        List<RefererDay> days = new ArrayList<>();
        for (int i = DAYS - 1; i >= 0; i--) {
            LocalDate date = lastDay.minusDays(i);
            // ago: 기준일로부터 며칠 전인지. 0~6 = 이번 주, 7~13 = 지난주
            days.add(day(date, i, rnd));
        }
        return days;
    }

    private static RefererDay day(LocalDate date, int ago, Random rnd) {
        boolean thisWeek = ago <= 6;
        boolean lastWeek = ago >= 7 && ago <= 13;
        Map<String, Integer> q = new LinkedHashMap<>();

        // 꾸준함 + 띄어쓰기만 다른 표기(같은 검색어로 합쳐져야 한다)
        q.put("스프링 부트 시작하기", 2 + rnd.nextInt(3));
        if (rnd.nextInt(3) == 0) {
            q.put("스프링부트 시작하기", 1);
        }
        // 상승: 지난주까지 드문드문, 이번 주 급증
        q.put("자바 레코드 사용법", thisWeek ? 4 + rnd.nextInt(4) : rnd.nextInt(2));
        q.put("JPA N+1 해결", thisWeek ? 3 + rnd.nextInt(2) : 1 + rnd.nextInt(2));
        // 하락: 꾸준하다가 이번 주에 줄어듦
        q.put("인텔리제이 단축키", thisWeek ? rnd.nextInt(2) : 3 + rnd.nextInt(3));
        // 끊김: 지난주에만 반짝, 이번 주 0
        if (lastWeek) {
            q.put("깃 리베이스 취소", 2 + rnd.nextInt(2));
        }
        // 다시 온 검색어: 한 달쯤 전에 있다가 지난주엔 없고 이번 주에 다시 → 상승(새 검색어 아님)
        if ((ago >= 25 && ago <= 32) || ago <= 4) {
            q.put("도커 컴포즈 예제", 1 + rnd.nextInt(2));
        }
        // 새로 뜬 검색어: 이번 주에 처음 등장
        if (ago <= 3) {
            q.put("Claude Code 사용법", 3 + rnd.nextInt(4));
        }
        if (ago <= 2) {
            q.put("H2 파일 잠금 해결", 1 + rnd.nextInt(2));
        }
        if (ago <= 1) {
            q.put("Playwright 자바 크롤링", 1);
        }
        // 롱테일
        for (String t : TAIL) {
            if (rnd.nextInt(6) == 0) {
                q.put(t, 1);
            }
        }
        q.values().removeIf(v -> v <= 0);

        // 검색어를 검색 유입처에 나눠 담는다. 유입처 방문수 = 그 유입처 검색어 합계.
        Map<String, Integer> engineVisits = new LinkedHashMap<>();
        List<SearchQueryRow> queries = new ArrayList<>();
        for (Map.Entry<String, Integer> e : q.entrySet()) {
            String engine = ENGINES.get(rnd.nextInt(10) < 6 ? 0 : (rnd.nextInt(3) < 2 ? 1 : 2));
            engineVisits.merge(engine, e.getValue(), Integer::sum);
            queries.add(new SearchQueryRow(date, engine, e.getKey(), e.getValue(), 0));
        }

        Map<String, Integer> visits = new LinkedHashMap<>();
        visits.put("네이버 블로그_모바일", 35 + rnd.nextInt(30));
        visits.put("네이버 블로그_PC", 15 + rnd.nextInt(15));
        visits.putAll(engineVisits);
        visits.put("네이버 메인_모바일", 2 + rnd.nextInt(5));
        int total = visits.values().stream().mapToInt(Integer::intValue).sum();

        List<RefererRow> rows = new ArrayList<>();
        visits.forEach((name, v) -> rows.add(new RefererRow(date, name, ENGINES.contains(name), v,
                Math.round(v * 10000.0 / total) / 100.0)));
        // 수집기와 같은 순서(파서가 만든 하루치에 검색어를 붙인다)로 만든다.
        return new RefererDay(date, rows, total, false).withQueries(queries);
    }
}
