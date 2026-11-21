package com.blogstat.collector;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.options.Cookie;
import com.microsoft.playwright.options.SameSiteAttribute;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * 로그인 쿠키를 JSON 파일로 저장/복원한다.
 * 네이버 로그인 쿠키가 persistent profile만으로는 다음 실행에 유지되지 않아서 둔 보완책이다.
 * 파일에는 쿠키 값(=로그인 권한)이 그대로 들어 있으므로 .playwright-profile/ 아래(gitignore)에만 둔다.
 * 쿠키 값은 절대 로그에 출력하지 않는다.
 */
@Component
public class SessionStore {

    private static final Set<String> LOGIN_COOKIES = Set.of("NID_SES", "NID_AUT");

    private final Path file;
    private final int warnDays;
    private final ObjectMapper mapper = new ObjectMapper();

    public SessionStore(@Value("${app.profile-dir}") String profileDir,
                        @Value("${app.session.warn-days}") int warnDays) {
        this.file = Paths.get(profileDir).toAbsolutePath().resolve("session-cookies.json");
        this.warnDays = warnDays;
    }

    public boolean exists() {
        return Files.exists(file);
    }

    /**
     * 저장된 로그인 쿠키(NID_SES, NID_AUT)의 상태를 돌려준다. 쿠키 값은 읽어도 밖으로 내보내지 않는다.
     * 둘 중 가장 빠른 만료 시각이 실질적인 로그인 만료 시각이다.
     */
    public SessionStatus status(Instant now) {
        if (!exists()) {
            return SessionStatus.missing();
        }
        JsonNode cookies;
        try {
            cookies = mapper.readTree(file.toFile()).path("cookies");
        } catch (IOException e) {
            throw new UncheckedIOException("세션 쿠키 파일을 읽지 못했습니다", e);
        }

        boolean foundLoginCookie = false;
        double earliest = Double.MAX_VALUE;
        for (JsonNode c : cookies) {
            if (!LOGIN_COOKIES.contains(c.path("name").asText())) {
                continue;
            }
            foundLoginCookie = true;
            double expires = c.path("expires").asDouble(-1);
            if (expires > 0) {
                earliest = Math.min(earliest, expires);
            }
        }
        if (!foundLoginCookie) {
            return SessionStatus.missing();
        }
        if (earliest == Double.MAX_VALUE) {
            return SessionStatus.sessionOnly();
        }
        return SessionStatus.fromExpiry(Instant.ofEpochSecond((long) earliest), now, warnDays);
    }

    /** 컨텍스트의 현재 쿠키를 파일로 저장한다. */
    public void save(BrowserContext context) {
        try {
            Files.createDirectories(file.getParent());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        context.storageState(new BrowserContext.StorageStateOptions().setPath(file));
    }

    /** 저장된 쿠키를 컨텍스트에 복원하고 복원한 개수를 반환한다. 파일이 없으면 0. */
    public int restore(BrowserContext context) {
        if (!exists()) {
            return 0;
        }
        JsonNode cookies;
        try {
            cookies = mapper.readTree(file.toFile()).path("cookies");
        } catch (IOException e) {
            throw new UncheckedIOException("세션 쿠키 파일을 읽지 못했습니다", e);
        }

        List<Cookie> result = new ArrayList<>();
        for (JsonNode c : cookies) {
            Cookie cookie = new Cookie(c.path("name").asText(), c.path("value").asText())
                    .setDomain(c.path("domain").asText())
                    .setPath(c.path("path").asText("/"))
                    .setHttpOnly(c.path("httpOnly").asBoolean(false))
                    .setSecure(c.path("secure").asBoolean(false));
            double expires = c.path("expires").asDouble(-1);
            if (expires > 0) {
                cookie.setExpires(expires);
            }
            SameSiteAttribute sameSite = sameSite(c.path("sameSite").asText(""));
            if (sameSite != null) {
                cookie.setSameSite(sameSite);
            }
            result.add(cookie);
        }
        context.addCookies(result);
        return result.size();
    }

    private static SameSiteAttribute sameSite(String value) {
        return switch (value) {
            case "Strict" -> SameSiteAttribute.STRICT;
            case "Lax" -> SameSiteAttribute.LAX;
            case "None" -> SameSiteAttribute.NONE;
            default -> null;
        };
    }
}
