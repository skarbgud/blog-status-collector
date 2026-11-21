package com.blogstat.collector;

import com.blogstat.collector.SessionStatus.State;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionStatusTest {

    private static final Instant NOW = Instant.parse("2026-11-20T00:00:00Z");
    private static final int WARN_DAYS = 7;

    // ---- 순수 판정 로직 ----

    @Test
    void 여유가_있으면_OK() {
        SessionStatus s = SessionStatus.fromExpiry(NOW.plus(Duration.ofDays(30)), NOW, WARN_DAYS);

        assertEquals(State.OK, s.state());
        assertEquals(30, s.daysLeft());
        assertFalse(s.needsAttention());
    }

    @Test
    void 경고_기준일_이내면_EXPIRING() {
        SessionStatus s = SessionStatus.fromExpiry(NOW.plus(Duration.ofDays(3)), NOW, WARN_DAYS);

        assertEquals(State.EXPIRING, s.state());
        assertEquals(3, s.daysLeft());
        assertTrue(s.needsAttention());
        assertFalse(s.isBroken());
    }

    @Test
    void 정확히_경고_기준일이면_EXPIRING_경계값_포함() {
        assertEquals(State.EXPIRING,
                SessionStatus.fromExpiry(NOW.plus(Duration.ofDays(WARN_DAYS)), NOW, WARN_DAYS).state());
    }

    @Test
    void 기준일을_1초만_넘으면_OK() {
        Instant expires = NOW.plus(Duration.ofDays(WARN_DAYS)).plusSeconds(1);

        assertEquals(State.OK, SessionStatus.fromExpiry(expires, NOW, WARN_DAYS).state());
    }

    @Test
    void 만료_시각이_지났으면_EXPIRED() {
        SessionStatus s = SessionStatus.fromExpiry(NOW.minus(Duration.ofHours(1)), NOW, WARN_DAYS);

        assertEquals(State.EXPIRED, s.state());
        assertTrue(s.isBroken());
    }

    @Test
    void 만료_시각과_현재가_같으면_이미_만료() {
        assertEquals(State.EXPIRED, SessionStatus.fromExpiry(NOW, NOW, WARN_DAYS).state());
    }

    @Test
    void 하루_미만_남으면_곧_만료라고_안내한다() {
        SessionStatus s = SessionStatus.fromExpiry(NOW.plus(Duration.ofHours(5)), NOW, WARN_DAYS);

        assertEquals(0, s.daysLeft());
        assertTrue(s.message().contains("24시간 이내"));
    }

    @Test
    void 조치가_필요한_상태의_메시지는_재로그인_방법을_알려준다() {
        assertTrue(SessionStatus.missing().message().contains("--app.mode=login"));
        assertTrue(SessionStatus.fromExpiry(NOW.minusSeconds(1), NOW, WARN_DAYS).message().contains("--app.mode=login"));
        assertTrue(SessionStatus.sessionOnly().message().contains("로그인 상태 유지"));
    }

    // ---- 파일에서 읽기 ----

    private static String cookieFile(String... cookieJsons) {
        return "{\"cookies\":[" + String.join(",", cookieJsons) + "],\"origins\":[]}";
    }

    private static String cookie(String name, double expires) {
        return "{\"name\":\"" + name + "\",\"value\":\"SECRET-VALUE\",\"domain\":\".naver.com\","
                + "\"path\":\"/\",\"expires\":" + expires + ",\"httpOnly\":true,\"secure\":true,\"sameSite\":\"None\"}";
    }

    private SessionStore storeWith(Path dir, String json) throws IOException {
        Files.writeString(dir.resolve("session-cookies.json"), json, StandardCharsets.UTF_8);
        return new SessionStore(dir.toString(), WARN_DAYS);
    }

    @Test
    void 파일이_없으면_MISSING(@TempDir Path dir) {
        SessionStore store = new SessionStore(dir.toString(), WARN_DAYS);

        assertEquals(State.MISSING, store.status(NOW).state());
    }

    @Test
    void NID_SES와_NID_AUT_중_빠른_만료를_기준으로_한다(@TempDir Path dir) throws IOException {
        long ses = NOW.plus(Duration.ofDays(20)).getEpochSecond();
        long aut = NOW.plus(Duration.ofDays(400)).getEpochSecond();
        SessionStore store = storeWith(dir, cookieFile(cookie("NID_AUT", aut), cookie("NID_SES", ses)));

        SessionStatus s = store.status(NOW);

        assertEquals(State.OK, s.state());
        assertEquals(20, s.daysLeft());
        assertEquals(Instant.ofEpochSecond(ses), s.expiresAt());
    }

    @Test
    void 로그인과_무관한_쿠키의_만료는_무시한다(@TempDir Path dir) throws IOException {
        long ses = NOW.plus(Duration.ofDays(20)).getEpochSecond();
        long other = NOW.plus(Duration.ofDays(1)).getEpochSecond();
        SessionStore store = storeWith(dir, cookieFile(cookie("NNB", other), cookie("NID_SES", ses)));

        assertEquals(20, store.status(NOW).daysLeft());
    }

    @Test
    void 로그인_쿠키가_모두_세션_쿠키면_SESSION_ONLY(@TempDir Path dir) throws IOException {
        SessionStore store = storeWith(dir, cookieFile(cookie("NID_SES", -1), cookie("NID_AUT", -1)));

        SessionStatus s = store.status(NOW);

        assertEquals(State.SESSION_ONLY, s.state());
        assertNull(s.daysLeft());
    }

    @Test
    void 파일에_로그인_쿠키가_없으면_MISSING(@TempDir Path dir) throws IOException {
        SessionStore store = storeWith(dir, cookieFile(cookie("NNB", NOW.plusSeconds(1000).getEpochSecond())));

        assertEquals(State.MISSING, store.status(NOW).state());
    }

    @Test
    void 상태_객체와_메시지에_쿠키_값이_들어가지_않는다(@TempDir Path dir) throws IOException {
        long ses = NOW.plus(Duration.ofDays(3)).getEpochSecond();
        SessionStore store = storeWith(dir, cookieFile(cookie("NID_SES", ses)));

        SessionStatus s = store.status(NOW);

        assertFalse(s.toString().contains("SECRET-VALUE"));
        assertFalse(s.message().contains("SECRET-VALUE"));
    }
}
