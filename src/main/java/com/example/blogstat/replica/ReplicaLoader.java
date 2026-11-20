package com.example.blogstat.replica;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.FileTime;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 읽기 전용 복제본(대시보드). 인메모리 DB에 스냅샷을 올려 두고, 스냅샷 파일이 바뀌면 다시 올린다.
 * 원본 파일 DB를 열지 않으므로 쓰기 프로세스와 파일 잠금으로 부딪치지 않고, 원본을 바꿀 방법도 없다.
 *
 * 다시 올리는 동안에는 쓰기 잠금으로 요청을 잠깐 막아, 요청이 반쯤 비어 있는 DB를 보지 않게 한다.
 */
@Component
@Profile("dashboard")
public class ReplicaLoader {

    private final JdbcTemplate jdbc;
    private final Path snapshot;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    private FileTime loadedModified;
    private long loadedSize = -1;

    @Autowired
    public ReplicaLoader(DataSource dataSource, @Value("${app.replica.file}") String file) {
        this(new JdbcTemplate(dataSource), Paths.get(file).toAbsolutePath());
    }

    /** 테스트에서 경로를 직접 지정하려고 열어 둔 생성자. */
    public ReplicaLoader(JdbcTemplate jdbc, Path snapshot) {
        this.jdbc = jdbc;
        this.snapshot = snapshot;
    }

    /**
     * 스냅샷이 마지막으로 올린 것과 다르면 다시 올린다. 읽기 잠금을 잡기 전에 호출해야 한다.
     *
     * @return 이번 호출에서 다시 올렸으면 true. 스냅샷이 없거나 그대로면 false
     */
    public boolean refreshIfChanged() {
        if (!Files.exists(snapshot) || !changedSinceLoad()) {
            return false;
        }
        lock.writeLock().lock();
        try {
            if (!changedSinceLoad()) {
                return false; // 기다리는 사이 다른 요청이 이미 올렸다.
            }
            FileTime modified = Files.getLastModifiedTime(snapshot);
            long size = Files.size(snapshot);
            jdbc.execute("DROP ALL OBJECTS");
            jdbc.execute("RUNSCRIPT FROM '" + SnapshotPublisher.sqlPath(snapshot) + "' CHARSET 'UTF-8'");
            loadedModified = modified;
            loadedSize = size;
            return true;
        } catch (IOException e) {
            throw new UncheckedIOException("스냅샷을 읽지 못했습니다: " + snapshot, e);
        } finally {
            lock.writeLock().unlock();
        }
    }

    private boolean changedSinceLoad() {
        try {
            return !Files.getLastModifiedTime(snapshot).equals(loadedModified) || Files.size(snapshot) != loadedSize;
        } catch (IOException e) {
            return false; // 파일이 막 교체되는 중이면 다음 요청에서 다시 본다.
        }
    }

    /** 요청이 DB를 읽는 동안 다시 올리기가 끼어들지 못하게 한다. */
    public void beginRead() {
        lock.readLock().lock();
    }

    public void endRead() {
        lock.readLock().unlock();
    }
}
