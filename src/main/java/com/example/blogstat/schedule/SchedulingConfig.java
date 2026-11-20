package com.example.blogstat.schedule;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** `--app.mode=schedule`일 때만 스케줄링을 켠다. */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "app.mode", havingValue = "schedule")
public class SchedulingConfig {
}
