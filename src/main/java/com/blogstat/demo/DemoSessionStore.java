package com.blogstat.demo;

import com.blogstat.collector.SessionStatus;
import com.blogstat.collector.SessionStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

/**
 * 데모에서는 실제 로그인 쿠키 파일을 읽지 않는다. 시연하는 PC에 쿠키가 없어도
 * "로그인 쿠키 없음" 경고 배너가 뜨지 않도록, 항상 정상(30일 남음)으로 답한다.
 */
@Component
@Primary
@Profile("demo")
public class DemoSessionStore extends SessionStore {

    public DemoSessionStore(@Value("${app.session.warn-days}") int warnDays) {
        // 존재하지 않는 경로. 쿠키를 읽거나 쓰는 메서드는 데모에서 불리지 않는다.
        super("build/demo-no-session", warnDays);
    }

    @Override
    public SessionStatus status(Instant now) {
        return new SessionStatus(SessionStatus.State.OK, 30L, now.plus(Duration.ofDays(30)));
    }
}
