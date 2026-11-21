// 유입분석 탭: 상세 유입 URL을 사람이 읽는 라벨로 풀이한다(표시 전용, 네이버 요청 없음).
// 원문은 항상 그대로 보여 주고, 그 위에 라벨·태그를 붙인다. 규칙은 설계 문서(referrer-detail-expand.md)의 표를 따른다.
// 규칙에 안 맞는 URL은 classified=false로 돌려 화면이 "분류 안 됨" 개수로 보여 준다(규칙 보강 신호).

export interface UrlInfo {
  label: string;
  tags: string[];
  /** 플레이스 URL의 검색어(bk_query·n_query·query, 디코딩됨) */
  placeQuery?: string;
  /** 플레이스 번호 */
  placeId?: string;
  /** 내 글 번호(내 글에서 이동) */
  postNo?: string;
  classified: boolean;
}

const BLOG_HOSTS = new Set(['blog.naver.com', 'm.blog.naver.com']);
const PLACE_HOSTS = new Set(['m.place.naver.com', 'pcmap.place.naver.com', 'place.naver.com']);
const MAIN_HOSTS = new Set(['m.naver.com', 'www.naver.com', 'naver.com']);
const PLACE_TABS: Record<string, string> = { home: '홈', review: '리뷰', menu: '메뉴', photo: '사진', booking: '예약', information: '정보', around: '주변' };
const PAGE = /^[^/]+\.(naver|nhn)$/i;

/** 표시용 퍼센트 디코딩. 실패하면 원문. */
export function decodeForDisplay(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function parse(url: string): URL | null {
  const raw = url.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return null;
  }
}

/** 쿼리 파라미터 이름을 대소문자 구분 없이 찾는다(네이버 URL은 blogId·blogid가 섞여 온다). */
function param(u: URL, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of u.searchParams) if (k.toLowerCase() === lower) return v;
  return null;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function describeUrl(url: string, myBlogId: string | null): UrlInfo {
  const u = parse(url);
  if (!u) return { label: '분류 안 됨', tags: [], classified: false };
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const page = segs.length === 1 && PAGE.test(segs[0]!) ? segs[0]!.replace(/\.(naver|nhn)$/i, '').toLowerCase() : null;

  if (BLOG_HOSTS.has(host)) {
    if (page === 'feedlist') return { label: '이웃 새글 피드', tags: [], classified: true };
    let blogId: string | null = null;
    let logNo: string | null = null;
    if (page === 'postview') {
      blogId = param(u, 'blogId');
      logNo = param(u, 'logNo');
    } else if (segs.length === 2 && /^\d+$/.test(segs[1]!)) {
      blogId = segs[0]!;
      logNo = segs[1]!;
    }
    if (blogId && logNo) {
      if (same(blogId, myBlogId)) return { label: '내 글에서 이동', tags: [], postNo: logNo, classified: true };
      const tags = ['블로그 ' + blogId];
      if (param(u, 'recommendTrackingCode') !== null || param(u, 'recommendCode') !== null) tags.push('추천');
      if ((param(u, 'enterPage') ?? '').toLowerCase() === 'feed') tags.push('피드');
      return { label: '다른 블로그 글', tags, classified: true };
    }
    if (page === 'postlist') {
      const id = param(u, 'blogId');
      const tags: string[] = [];
      const cat = param(u, 'categoryNo');
      const tab = param(u, 'tab');
      if (cat !== null) tags.push('카테고리 ' + cat);
      if (tab !== null) tags.push('탭 ' + tab);
      if (same(id, myBlogId)) return { label: '내 블로그 글 목록', tags, classified: true };
      if (id) return { label: '다른 블로그 글 목록', tags: ['블로그 ' + id, ...tags], classified: true };
    }
    if (segs.length === 1 && !page) {
      return same(segs[0], myBlogId)
        ? { label: '내 블로그 홈', tags: [], classified: true }
        : { label: '다른 블로그 홈', tags: ['블로그 ' + segs[0]], classified: true };
    }
  }

  if (host === 'section.blog.naver.com' && page === 'themepost') {
    const dir = param(u, 'directoryNo');
    return { label: '블로그 홈 주제별 글', tags: dir !== null ? ['주제 ' + dir] : [], classified: true };
  }

  if (host === 'admin.blog.naver.com' && page === 'buddylistmanage') {
    const id = param(u, 'blogId');
    if (same(id, myBlogId)) return { label: '내 이웃 관리 화면', tags: [], classified: true };
    return { label: (id ?? '알 수 없는 블로그') + '의 이웃 관리 화면', tags: [], classified: true };
  }

  if (PLACE_HOSTS.has(host)) {
    // /<업종>/<placeId>/<탭> (탭이 없으면 홈)
    const idx = segs.findIndex((s) => /^\d+$/.test(s));
    if (idx >= 0) {
      const placeId = segs[idx]!;
      const tab = segs[idx + 1] ?? 'home';
      const tags: string[] = [];
      if (idx > 0) tags.push(segs[idx - 1]!);
      if (param(u, 'n_ad_group_type') !== null) tags.push('광고 영역(추정)');
      const q = param(u, 'bk_query') ?? param(u, 'n_query') ?? param(u, 'query');
      const info: UrlInfo = { label: '플레이스 ' + placeId + ' ' + (PLACE_TABS[tab.toLowerCase()] ?? tab), tags, placeId, classified: true };
      if (q !== null && q.trim() !== '') info.placeQuery = q.trim();
      return info;
    }
  }

  if (MAIN_HOSTS.has(host) && segs.length === 0) return { label: '네이버 메인', tags: [], classified: true };

  return { label: host + (u.pathname === '/' ? '' : u.pathname), tags: [], classified: false };
}
