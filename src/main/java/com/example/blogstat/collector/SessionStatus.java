package com.example.blogstat.collector;

import java.time.Duration;
import java.time.Instant;

/**
 * 저장된 로그인 쿠키의 상태. 쿠키 값은 담지 않고 상태와 만료 시각만 다룬다.
 *
 * @param daysLeft  만료까지 남은 일수(내림). 만료됐으면 0 이하. 알 수 없으면 null
 * @param expiresAt 로그인 쿠키 중 가장 빠른 만료 시각. 알 수 없으면 null
 */
public record SessionStatus(State state, Long daysLeft, Instant expiresAt) {

    public enum State {
        /** 만료까지 여유가 있다. */
        OK,
        /** 경고 기준일 이내로 만료가 임박했다. */
        EXPIRING,
        /** 이미 만료됐다. */
        EXPIRED,
        /** 만료 시각이 있는 로그인 쿠키가 없다(세션 쿠키뿐). 언제 끊길지 알 수 없다. */
        SESSION_ONLY,
        /** 저장된 로그인 쿠키가 없다. */
        MISSING
    }

    public static SessionStatus missing() {
        return new SessionStatus(State.MISSING, null, null);
    }

    public static SessionStatus sessionOnly() {
        return new SessionStatus(State.SESSION_ONLY, null, null);
    }

    /**
     * @param expiresAt 로그인 쿠키 중 가장 빠른 만료 시각
     * @param warnDays  남은 기간이 이 일수 이하이면 EXPIRING (경계값 포함)
     */
    public static SessionStatus fromExpiry(Instant expiresAt, Instant now, int warnDays) {
        Duration left = Duration.between(now, expiresAt);
        long daysLeft = left.toDays();
        if (left.isNegative() || left.isZero()) {
            return new SessionStatus(State.EXPIRED, daysLeft, expiresAt);
        }
        State state = left.compareTo(Duration.ofDays(warnDays)) <= 0 ? State.EXPIRING : State.OK;
        return new SessionStatus(state, daysLeft, expiresAt);
    }

    /** 이 상태가 사용자에게 조치(재로그인)를 요구하는지. */
    public boolean needsAttention() {
        return state != State.OK;
    }

    /** 만료됐거나 쿠키가 없어 수집이 실패할 상태인지. */
    public boolean isBroken() {
        return state == State.EXPIRED || state == State.MISSING;
    }

    public String message() {
        String relogin = " `--app.mode=login`으로 다시 로그인하세요.";
        return switch (state) {
            case OK -> "로그인 세션이 " + daysLeft + "일 뒤 만료됩니다.";
            case EXPIRING -> "로그인 세션이 " + (daysLeft == 0 ? "곧(24시간 이내)" : daysLeft + "일 뒤") + " 만료됩니다." + relogin;
            case EXPIRED -> "로그인 세션이 만료되었습니다. 수집이 실패합니다." + relogin;
            case SESSION_ONLY -> "만료 시각이 있는 로그인 쿠키가 없어 언제 끊길지 알 수 없습니다."
                    + " 로그인 화면에서 '로그인 상태 유지'를 체크하고 다시 로그인하세요.";
            case MISSING -> "저장된 로그인 쿠키가 없습니다. 수집이 실패합니다." + relogin;
        };
    }
}
