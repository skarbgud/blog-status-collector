package com.example.blogstat.replica;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * `--app.mode=publish`: 수집 없이 현재 DB로 대시보드용 스냅샷만 다시 내보낸다.
 * 스냅샷 기능이 생기기 전의 기존 데이터를 처음 내보낼 때나, 내보내기에 실패했을 때 쓴다.
 */
@Component
@Profile("!dashboard")
@ConditionalOnProperty(name = "app.mode", havingValue = "publish")
public class PublishRunner implements CommandLineRunner {

    private final SnapshotPublisher publisher;

    public PublishRunner(SnapshotPublisher publisher) {
        this.publisher = publisher;
    }

    @Override
    public void run(String... args) {
        publisher.publish();
        System.out.println("[완료] 스냅샷을 내보냈습니다: " + publisher.snapshotFile());
    }
}
