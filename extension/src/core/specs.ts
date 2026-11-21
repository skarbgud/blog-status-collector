// 수집할 지표 정의. Java collector/metric/MetricSpec·MetricSpecs를 그대로 옮겼다(설명은 Java 쪽 주석과 CLAUDE.md 참고).
// id는 저장 식별자(metric_row.metric)라 바꾸면 기존 저장분과 연결이 끊긴다.

export type Kind = 'SERIES' | 'DAY' | 'VALUE';

export interface MetricSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: Kind;
  readonly path: string;
  readonly timeDim: 'DATE' | 'WEEK' | 'MONTH';
  /** 읽을 블록 dataId. VALUE는 쉼표로 여러 블록 */
  readonly blockId: string;
  /** 하루 단위에서 행 구분 컬럼(없으면 indexKeys 또는 순번) */
  readonly keyColumn: string | null;
  readonly indexKeys: readonly string[];
  /** 화면이 함께 보내는 추가 쿼리(앞에 &), 없으면 '' */
  readonly extraQuery: string;
  /** 이 컬럼 합이 0이면 네이버가 아직 집계하지 않은 날로 보고 저장하지 않는다 */
  readonly pendingColumn: string | null;
  readonly perPost: boolean;
  readonly perHour: boolean;
}

/** 시계열 한 건이 끌어오는 일수. */
export const SERIES_WINDOW_DAYS = 15;
/** 값(VALUE) 지표에서 객체가 아닌 값들을 모은 행 이름. */
export const VALUE_ROW = 'value';
/** 하루 단위 지표에서 데이터가 없는 날 남기는 표시 행. */
export const EMPTY_KEY = '_empty';

const base = {
  keyColumn: null, indexKeys: [], extraQuery: '', pendingColumn: null, perPost: false, perHour: false,
} as const;

function series(id: string, label: string, path: string, timeDim: 'DATE' | 'WEEK', blockId: string): MetricSpec {
  return { ...base, id, label, kind: 'SERIES', path, timeDim, blockId };
}

function day(id: string, label: string, path: string, blockId: string, keyColumn: string | null,
  indexKeys: readonly string[] = [], extraQuery = ''): MetricSpec {
  return { ...base, id, label, kind: 'DAY', path, timeDim: 'DATE', blockId, keyColumn, indexKeys, extraQuery };
}

function week(id: string, label: string, path: string, blockId: string, keyColumn: string): MetricSpec {
  return { ...base, id, label, kind: 'DAY', path, timeDim: 'WEEK', blockId, keyColumn };
}

function value(id: string, label: string, path: string, timeDim: 'DATE' | 'MONTH', blockIds: string): MetricSpec {
  return { ...base, id, label, kind: 'VALUE', path, timeDim, blockId: blockIds };
}

export const VIEWS = series('VIEWS', '조회수(이웃 구분별)', '/api/blog/visit/cv', 'DATE', 'cv');
export const VISITORS = series('VISITORS', '순방문자수(이웃 구분별)', '/api/blog/visit/uv', 'DATE', 'uv');
export const VISITS = series('VISITS', '방문횟수', '/api/blog/visit/visit', 'DATE', 'visit');
export const DURATION = series('DURATION', '평균 사용시간(이웃 구분별)', '/api/blog/visit/averageDuration', 'DATE', 'averageDuration');
export const RELATION_VISIT = series('RELATION_VISIT', '이웃 방문 현황', '/api/blog/user/relationVisitCv', 'DATE', 'relationVisit');
export const RELATION_DELTA = series('RELATION_DELTA', '이웃 증감', '/api/blog/user/relationDelta', 'DATE', 'relationDelta');
export const AVG_VISIT_WEEKLY = series('AVG_VISIT_WEEKLY', '평균 방문횟수(주간)', '/api/blog/visit/averageVisit', 'WEEK', 'averageVisit');
export const REVISIT_WEEKLY = series('REVISIT_WEEKLY', '재방문율(주간)', '/api/blog/visit/revisit', 'WEEK', 'revisit');

export const DEMO = day('DEMO', '성별·연령별 분포', '/api/blog/user/demoCv', 'demo', 'age');
export const DEMO_FOLLOW = day('DEMO_FOLLOW', '성별·연령별 분포(피이웃)', '/api/blog/user/demoCv', 'demoFollow', 'age');
export const DEMO_FRIEND = day('DEMO_FRIEND', '성별·연령별 분포(서로이웃)', '/api/blog/user/demoCv', 'demoFriend', 'age');
export const DEMO_ETC = day('DEMO_ETC', '성별·연령별 분포(이웃 아님)', '/api/blog/user/demoCv', 'demoEtc', 'age');
/** 구분 컬럼 없이 4행이 온다. 행별 pc+mobile 합이 조회수 total, etc, follow, friend와 같아 이 순서로 이름을 붙였다. */
export const DEVICE = day('DEVICE', '기기별 분포(PC/모바일)', '/api/blog/user/device/mobile', 'device', null,
  ['total', 'etc', 'follow', 'friend']);
/** 어제분이 늦게 집계되면 cv가 모두 0으로 온다. 그런 날은 저장하지 않고 다음에 다시 받는다. */
export const HOUR: MetricSpec = {
  ...day('HOUR', '시간대별 조회수', '/api/blog/user/hour/cv', 'hour', 'date', [], '&hour=12'),
  pendingColumn: 'cv',
};
export const COUNTRY = day('COUNTRY', '국가별 분포', '/api/blog/user/country', 'country', 'country');
export const RANK_POST = day('RANK_POST', '게시글 조회수 순위', '/api/blog/rank/cvContentPc', 'rankCv', null);
export const RANK_SUBJECT = day('RANK_SUBJECT', '주제별 조회수 순위', '/api/blog/rank/cvSubjectPc', 'rankCv', null);
export const RANK_LIKE = day('RANK_LIKE', '게시글 공감수 순위', '/api/blog/rank/likePc', 'rankLike', null);
export const RANK_COMMENT = day('RANK_COMMENT', '게시글 댓글수 순위', '/api/blog/rank/commentPc', 'rankComment', null);

export const DAILY_SUMMARY: MetricSpec = {
  ...value('DAILY_SUMMARY', '일간 현황(공감·댓글·재생수)', '/api/blog/daily/cv', 'DATE', 'dashboard'),
  extraQuery: '&additionalTimeDimension=WEEK',
};
export const VIDEO_RANK = day('VIDEO_RANK', '동영상 재생 순위', '/api/blog/daily/cv', 'rank_play_cnt', null, [],
  '&additionalTimeDimension=WEEK');

export const REFERER_SEARCH = day('REFERER_SEARCH', '검색어(전체 엔진 합계)', '/api/blog/user/referer/search',
  'refererSearch', 'searchQuery');
export const REFERER_SITE = day('REFERER_SITE', '사이트 유입', '/api/blog/user/referer/site', 'refererSite', 'referrerDomain');

export const REL_DEMO_ADD = week('REL_DEMO_ADD', '이웃 추가한 사람의 성별·연령(주간)', '/api/blog/user/relationDemoAdd',
  'relationDemo', 'age');

export const UPPER_GROUP = value('UPPER_GROUP', '서비스·상위 그룹 평균 비교(월간)', '/api/blog/average/upperGroup', 'MONTH',
  'upperGroup,averageUserData');

export const ARTICLE_CV: MetricSpec = {
  ...series('ARTICLE_CV', '게시글별 일 조회수', '/api/blog/article/cv', 'DATE', 'cv'), perPost: true,
};
export const ARTICLE_INFO: MetricSpec = {
  ...value('ARTICLE_INFO', '게시글 정보와 누적 수치', '/api/blog/article/cv', 'DATE', 'articleInfo,dashboard'), perPost: true,
};

/** 한 시간대의 일별 조회수(15일치). hour는 반드시 두 자리(05)로 보낸다. */
export const HOUR_TREND: MetricSpec = {
  ...series('HOUR_TREND', '시간대별 일별 조회수', '/api/blog/user/hour/hourCv', 'DATE', 'hour'), perHour: true,
};

/** 수집 순서. 요청이 적은 것부터, 게시글별은 순위가 먼저 있어야 해서 맨 끝. */
export const ALL: readonly MetricSpec[] = [
  VIEWS, VISITORS, VISITS, DURATION, RELATION_VISIT, RELATION_DELTA, AVG_VISIT_WEEKLY, REVISIT_WEEKLY,
  DEMO, DEMO_FOLLOW, DEMO_FRIEND, DEMO_ETC, DEVICE, HOUR, COUNTRY, RANK_POST, RANK_SUBJECT, RANK_LIKE,
  RANK_COMMENT, DAILY_SUMMARY, VIDEO_RANK, REFERER_SEARCH, REFERER_SITE, REL_DEMO_ADD, UPPER_GROUP, HOUR_TREND,
  ARTICLE_CV, ARTICLE_INFO,
];

/**
 * 더는 받지 않는 지표(2026-11-21 요청 수 줄이기). 정의는 남겨 이미 저장된 행을 읽을 수 있게 한다.
 * - REFERER_SEARCH·REFERER_SITE: 유입경로·검색어 표와 값이 같고 해상도만 낮다(대시보드 미사용)
 * - RELATION_VISIT: 대시보드 미사용
 * - HOUR_TREND: HOUR(날짜×시간)와 같은 값이라 화면이 HOUR에서 계산한다(시간대당 요청 24회 절감)
 */
export const RETIRED = new Set(['REFERER_SEARCH', 'REFERER_SITE', 'RELATION_VISIT', 'HOUR_TREND']);
/** 수집기가 실제로 받는 지표. */
export const COLLECTED: readonly MetricSpec[] = ALL.filter((s) => !RETIRED.has(s.id));

export function findSpec(id: string): MetricSpec | undefined {
  return ALL.find((s) => s.id.toLowerCase() === id.toLowerCase());
}

export const isSeries = (s: MetricSpec) => s.kind === 'SERIES';
export const isValue = (s: MetricSpec) => s.kind === 'VALUE';
export const blockIds = (s: MetricSpec) => s.blockId.split(',');
/** 같은 요청으로 함께 받을 수 있는 지표인지 가르는 값. */
export const requestKey = (s: MetricSpec) => [s.path, s.timeDim, s.extraQuery, s.perPost, s.perHour].join('|');
