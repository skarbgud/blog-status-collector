package com.example.blogstat.collector;

import com.example.blogstat.collector.core.NaverStatClient;
import com.example.blogstat.collector.source.RefererSource;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * 유입경로 소스를 날짜 목록에 대해 한 회차로 실행한다.
 * 요청 정책(지연·예산·재시도·세션)은 {@link NaverStatClient}, 요청/파싱은 {@link RefererSource}가 맡는다.
 */
@Component
public class RefererCollector {

    private final NaverStatClient client;
    private final RefererSource source;

    public RefererCollector(NaverStatClient client, RefererSource source) {
        this.client = client;
        this.source = source;
    }

    /** from~to(양끝 포함)를 날짜 순으로 수집한다. */
    public List<RefererDay> collect(LocalDate from, LocalDate to) {
        List<RefererDay> result = new ArrayList<>();
        collect(from, to, result::add);
        return result;
    }

    /**
     * 날짜 하나를 받을 때마다 onDay를 바로 호출한다. 중간에 실패해도 이미 받은 날짜는 처리된 상태로 남는다.
     */
    public void collect(LocalDate from, LocalDate to, Consumer<RefererDay> onDay) {
        if (from.isAfter(to)) {
            throw new IllegalArgumentException("from이 to보다 늦습니다: " + from + " > " + to);
        }
        List<LocalDate> dates = new ArrayList<>();
        for (LocalDate date = from; !date.isAfter(to); date = date.plusDays(1)) {
            dates.add(date);
        }
        collect(dates, onDay);
    }

    /** 지정한 날짜들만 주어진 순서대로 수집한다. 이미 받은 날짜를 건너뛸 때 쓴다. */
    public void collect(List<LocalDate> dates, Consumer<RefererDay> onDay) {
        if (dates.isEmpty()) {
            return;
        }
        client.run(session -> {
            for (LocalDate date : dates) {
                onDay.accept(source.fetch(session, date));
            }
        });
    }
}
