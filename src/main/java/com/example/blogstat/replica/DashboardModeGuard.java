package com.example.blogstat.replica;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * 대시보드는 읽기 전용 프로세스다. 인메모리 복제본에 수집 결과를 쓰면 조용히 사라지므로,
 * 수집/로그인 모드와 함께 켜지면 시작을 막는다.
 */
@Component
@Profile("dashboard")
public class DashboardModeGuard {

    public DashboardModeGuard(@Value("${app.mode}") String mode) {
        if (!"none".equals(mode)) {
            throw new IllegalStateException("대시보드는 읽기 전용 프로세스라 --app.mode=" + mode
                    + "와 함께 켤 수 없습니다. 수집(collect/schedule)은 별도 프로세스로 실행하세요. "
                    + "수집이 끝나면 대시보드가 스냅샷을 자동으로 다시 읽습니다.");
        }
    }
}
