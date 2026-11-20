package com.example.blogstat.replica;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** 대시보드 API 요청마다 스냅샷이 바뀌었는지 보고, 요청이 끝날 때까지 읽기 잠금을 잡는다. */
@Configuration
@Profile("dashboard")
public class ReplicaWebConfig implements WebMvcConfigurer {

    private final ReplicaLoader loader;

    public ReplicaWebConfig(ReplicaLoader loader) {
        this.loader = loader;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            @Override
            public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
                loader.refreshIfChanged(); // 쓰기 잠금이 필요하므로 읽기 잠금을 잡기 전에 한다.
                loader.beginRead();
                return true;
            }

            @Override
            public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                        Object handler, Exception ex) {
                loader.endRead();
            }
        }).addPathPatterns("/api/dashboard/**");
    }
}
