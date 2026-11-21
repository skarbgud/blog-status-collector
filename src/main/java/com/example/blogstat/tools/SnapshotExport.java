package com.example.blogstat.tools;

import com.fasterxml.jackson.core.JsonEncoding;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;

/**
 * 크롬 확장으로 옮기기 위한 1회용 내보내기. 스냅샷(data/replica/snapshot.sql)을 인메모리 H2에 올려 세 표를 JSON으로 쓴다.
 * 원본 파일 DB(./data/blogstat)를 열지 않으므로 수집·대시보드 프로세스와 잠금 충돌이 없다. Spring을 띄우지 않는다.
 *
 * 실행: ./gradlew exportJson -Psnapshot=data/replica/snapshot.sql -Pout=data/export/blogstat-export.json
 * 결과는 개인 통계 데이터라 data/ 아래(gitignore)에 둔다.
 */
public final class SnapshotExport {

    public static final String FORMAT = "blogstat-export";
    public static final int VERSION = 1;

    private SnapshotExport() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("사용법: SnapshotExport <snapshot.sql> <out.json>");
            System.exit(2);
        }
        Path snapshot = Path.of(args[0]).toAbsolutePath();
        Path out = Path.of(args[1]).toAbsolutePath();
        if (!Files.isRegularFile(snapshot)) {
            throw new IllegalArgumentException("스냅샷이 없습니다: " + snapshot);
        }
        Files.createDirectories(out.getParent());
        Path tmp = out.resolveSibling(out.getFileName() + ".tmp");

        try (Connection c = DriverManager.getConnection("jdbc:h2:mem:export;DB_CLOSE_DELAY=-1", "sa", "");
             Statement st = c.createStatement()) {
            st.execute("RUNSCRIPT FROM '" + snapshot.toString().replace("'", "''") + "'");
            int[] counts = new int[3];
            try (JsonGenerator g = new JsonFactory().createGenerator(tmp.toFile(), JsonEncoding.UTF8)) {
                g.writeStartObject();
                g.writeStringField("format", FORMAT);
                g.writeNumberField("version", VERSION);
                g.writeStringField("exportedAt", Instant.now().toString());
                counts[0] = referrers(st, g);
                counts[1] = queries(st, g);
                counts[2] = metrics(st, g);
                g.writeEndObject();
            }
            Files.move(tmp, out, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            System.out.println("[내보내기] 유입경로 " + counts[0] + "행, 검색어 " + counts[1] + "행, 지표 " + counts[2] + "행 → " + out);
        }
    }

    private static int referrers(Statement st, JsonGenerator g) throws SQLException, IOException {
        g.writeArrayFieldStart("referrerDaily");
        int n = 0;
        try (ResultSet r = st.executeQuery("SELECT STAT_DATE, REFERRER_NAME, SEARCH_ENGINE, VISITS, RATIO, COLLECTED_AT "
                + "FROM REFERRER_DAILY ORDER BY ID")) {
            while (r.next()) {
                g.writeStartObject();
                g.writeStringField("statDate", r.getDate(1).toLocalDate().toString());
                g.writeStringField("referrerName", r.getString(2));
                g.writeBooleanField("searchEngine", r.getBoolean(3));
                g.writeNumberField("visits", r.getInt(4));
                g.writeNumberField("ratio", r.getDouble(5));
                g.writeStringField("collectedAt", r.getTimestamp(6).toInstant().toString());
                g.writeEndObject();
                n++;
            }
        }
        g.writeEndArray();
        return n;
    }

    private static int queries(Statement st, JsonGenerator g) throws SQLException, IOException {
        g.writeArrayFieldStart("searchQueryDaily");
        int n = 0;
        try (ResultSet r = st.executeQuery("SELECT STAT_DATE, REFERRER_NAME, SEARCH_QUERY, VISITS, RATIO, COLLECTED_AT "
                + "FROM SEARCH_QUERY_DAILY ORDER BY ID")) {
            while (r.next()) {
                g.writeStartObject();
                g.writeStringField("statDate", r.getDate(1).toLocalDate().toString());
                g.writeStringField("referrerName", r.getString(2));
                g.writeStringField("searchQuery", r.getString(3));
                g.writeNumberField("visits", r.getInt(4));
                g.writeNumberField("ratio", r.getDouble(5));
                g.writeStringField("collectedAt", r.getTimestamp(6).toInstant().toString());
                g.writeEndObject();
                n++;
            }
        }
        g.writeEndArray();
        return n;
    }

    private static int metrics(Statement st, JsonGenerator g) throws SQLException, IOException {
        g.writeArrayFieldStart("metricRows");
        int n = 0;
        try (ResultSet r = st.executeQuery("SELECT STAT_DATE, METRIC, ROW_KEY, PAYLOAD, COLLECTED_AT FROM METRIC_ROW ORDER BY ID")) {
            while (r.next()) {
                g.writeStartObject();
                g.writeStringField("statDate", r.getDate(1).toLocalDate().toString());
                g.writeStringField("metric", r.getString(2));
                g.writeStringField("rowKey", r.getString(3));
                g.writeStringField("payload", r.getString(4));
                g.writeStringField("collectedAt", r.getTimestamp(5).toInstant().toString());
                g.writeEndObject();
                n++;
            }
        }
        g.writeEndArray();
        return n;
    }
}
