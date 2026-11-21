package com.blogstat.replica;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;

/**
 * 쓰기 쪽(collect/schedule)이 DB를 바꾼 뒤, 읽기 전용 복제본(대시보드)이 가져갈 스냅샷 파일을 내보낸다.
 * H2 파일 DB는 한 프로세스만 열 수 있어서, 대시보드는 원본을 열지 않고 이 스냅샷만 읽는다.
 *
 * 스냅샷은 SQL 스크립트(SCRIPT)다. 임시 파일에 먼저 쓰고 이름을 바꿔서, 읽는 쪽이 쓰다 만 파일을 보지 못한다.
 */
@Component
@Profile("!dashboard")
public class SnapshotPublisher {

    private final JdbcTemplate jdbc;
    private final Path snapshot;

    @Autowired
    public SnapshotPublisher(DataSource dataSource, @Value("${app.replica.file}") String file) {
        this(new JdbcTemplate(dataSource), Paths.get(file).toAbsolutePath());
    }

    /** 테스트에서 경로를 직접 지정하려고 열어 둔 생성자. */
    public SnapshotPublisher(JdbcTemplate jdbc, Path snapshot) {
        this.jdbc = jdbc;
        this.snapshot = snapshot;
    }

    public Path snapshotFile() {
        return snapshot;
    }

    public void publish() {
        Path tmp = snapshot.resolveSibling(snapshot.getFileName() + ".tmp");
        try {
            Files.createDirectories(snapshot.getParent());
            Files.deleteIfExists(tmp);
            // 비밀번호/설정은 내보내지 않는다(NOPASSWORDS, NOSETTINGS). DROP은 같은 이름의 객체를 먼저 지우는 문장을 넣는다.
            jdbc.execute("SCRIPT NOPASSWORDS NOSETTINGS DROP TO '" + sqlPath(tmp) + "'");
            try {
                Files.move(tmp, snapshot, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, snapshot, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("스냅샷을 내보내지 못했습니다: " + snapshot, e);
        }
    }

    /** H2 SQL 문자열 리터럴에 넣을 경로. 역슬래시는 슬래시로, 작은따옴표는 두 번 쓴다. */
    static String sqlPath(Path path) {
        return path.toAbsolutePath().toString().replace('\\', '/').replace("'", "''");
    }
}
