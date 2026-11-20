package com.example.blogstat.replica;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DashboardModeGuardTest {

    @Test
    void 수집_모드와_함께_켜면_시작을_막는다() {
        for (String mode : new String[]{"schedule", "collect", "collect-queries", "login", "explore", "publish"}) {
            IllegalStateException e = assertThrows(IllegalStateException.class, () -> new DashboardModeGuard(mode));
            assertTrue(e.getMessage().contains(mode), mode);
        }
    }

    @Test
    void 모드가_none이면_통과한다() {
        assertDoesNotThrow(() -> new DashboardModeGuard("none"));
    }
}
