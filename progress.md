# Progress Log — 대량 리스트 UI 성능 개선 (2026-07-27)

React + Vite 데스크톱 앱(SNS Reader)에서 대량(약 4,700개) 리스트를 다루면서 겪은 두 가지 성능 문제와 해결 패턴을 정리한다. 둘 다 **다른 프로젝트에서도 그대로 재사용 가능한 일반 패턴**이라 상세히 남긴다.

---

## 1. 카드 그리드 가상화 (Virtualization) — 라이브러리 없이 구현

### 문제

`posts.map(post => <Card />)` 형태로 필터링된 게시물을 **전부** 렌더링하고 있었음. 필터 없이 "전체"를 보면 최대 ~4,700개의 카드 DOM 노드 + `<img>` 태그가 한 번에 생성됨.

- 실제로 화면에 보이는 카드는 스크롤 위치 기준 20~30개뿐인데 나머지 수천 개도 이미 DOM에 존재
- 스크롤/검색/필터/폴링 갱신마다 수천 개 노드를 diff/reconcile 해야 해서 전체적으로 느려짐

### 왜 라이브러리(react-window, react-virtuoso 등) 없이 직접 구현했는가

가상화 라이브러리가 어려운 이유는 대부분 **"아이템 높이가 가변적"**이거나 **"컬럼 수가 반응형으로 계속 바뀌는"** 경우다. 이 프로젝트는 우연히 둘 다 아니었다:

- CSS에서 카드 높이가 `height: 250px`로 **고정**되어 있었음 (내용이 넘치면 `overflow: hidden`으로 잘림)
- 그리드 컬럼 수도 `grid-template-columns: repeat(2, minmax(360px, 1fr))`로 **사실상 고정 2열** (반응형 1열 브레이크포인트가 있긴 하지만, Electron 창의 `minWidth`가 그 브레이크포인트보다 커서 실제로는 절대 발동하지 않음)

→ **"행 높이 × 컬럼 수"가 고정값이면, 스크롤 위치만으로 어떤 행이 보이는지 계산 가능** → 별도 라이브러리 없이 "windowing"을 직접 구현 가능.

### 구현 패턴: 상/하단 스페이서(spacer) 방식

핵심 아이디어: **실제로 그릴 아이템만 남기고, 그리지 않는 위/아래 공간은 높이만 차지하는 빈 `<div>`(스페이서)로 채운다.** 이렇게 하면:
- 스크롤바 크기(전체 콘텐츠 높이)가 원래와 동일하게 유지됨
- 남은 아이템들의 화면상 위치도 정확히 유지됨 (스페이서가 그만큼의 공간을 미리 차지하고 있으므로)

```tsx
const ROW_HEIGHT = 250 + 14; // 카드 높이 + gap (CSS와 반드시 일치시켜야 함)
const OVERSCAN_ROWS = 3;      // 스크롤 튐 방지용 여유 행

function VirtualizedGrid({ items }: { items: Item[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, clientHeight: 0, columnCount: 2 });

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const updateViewport = () => {
      setViewport({
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        columnCount: node.clientWidth <= MOBILE_BREAKPOINT ? 1 : 2, // CSS 미디어쿼리와 동일한 기준값 사용
      });
    };

    updateViewport();
    node.addEventListener("scroll", updateViewport, { passive: true });
    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(node);

    return () => {
      node.removeEventListener("scroll", updateViewport);
      resizeObserver.disconnect();
    };
  }, []);

  const { columnCount, scrollTop, clientHeight } = viewport;
  const totalRows = Math.ceil(items.length / columnCount);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const lastRow = Math.min(totalRows, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);

  const windowed = items.slice(firstRow * columnCount, Math.min(items.length, lastRow * columnCount));
  const topSpacerHeight = firstRow * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (totalRows - lastRow) * ROW_HEIGHT);

  return (
    <div className="grid" ref={scrollRef}> {/* CSS: display:grid; overflow:auto; */}
      {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight, gridColumn: "1 / -1" }} />}
      {windowed.map((item) => <Card key={item.id} item={item} />)}
      {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight, gridColumn: "1 / -1" }} />}
    </div>
  );
}
```

CSS에는 스페이서용 클래스 한 줄만 추가하면 된다: `.grid-spacer { grid-column: 1 / -1; }` — CSS Grid는 `grid-column: 1 / -1`인 요소를 자동으로 자기만의 행(row)으로 배치하므로, 스페이서 앞뒤의 실제 카드들은 정상적으로 auto-flow 배치된다.

### 적용 전 확인해야 할 전제조건

1. **아이템 높이가 진짜 고정인가?** (내용에 따라 늘어난다면 이 방식은 안 됨 → `react-virtuoso` 같은 동적 측정 라이브러리 필요)
2. **컬럼 수가 예측 가능한가?** (완전 반응형 auto-fill 그리드라면 컬럼 수를 JS에서 CSS와 동일한 로직으로 재현해야 함 — 여기서는 미디어쿼리 브레이크포인트를 그대로 JS 상수로 복붙)

### 검증 방법 (라이브러리 없이 만든 만큼 직접 검증이 중요)

Playwright(headless Chromium)로 실제 데이터(4,738개)를 로드한 뒤:
- `scrollHeight`가 `전체 행 수 × ROW_HEIGHT`와 일치하는지 (스크롤바 크기 정확성)
- 스크롤 위치를 top/mid/bottom으로 이동하며 `.card` DOM 노드 개수가 항상 수십 개 수준으로 유지되는지 (실제로 windowing이 동작하는지)
- 스크린샷으로 레이아웃이 어긋나지 않는지 (스페이서 높이 계산 오류 시 카드가 겹치거나 빈틈이 생김)
- 카드 클릭 등 기존 상호작용이 그대로 동작하는지

이 네 가지만 확인하면 육안 회귀 없이 가상화 적용을 신뢰할 수 있었다.

---

## 2. 목록/상세 페이로드 분리 (List/Detail Payload Splitting)

### 문제

목록 API(`GET /api/markdown-cards`)가 카드 하나당 **상세 화면에서만 쓰는 무거운 필드**(전체 본문 `body`, 전체 댓글 `commentsText`)까지 포함해서 응답하고 있었음. 목록 화면은 `bodyPreview`/`summary`(둘 다 이미 서버에서 잘라낸 짧은 문자열)만 사용하는데도.

- 게시물 4,700개 × 각각 긴 본문 텍스트 = 응답이 불필요하게 큼
- 5초 폴링(자동 새로고침)마다 이 무거운 응답을 매번 재전송

### 해결 패턴

**(1) 목록 API는 무거운 필드를 서버에서 잘라내고 응답**

```ts
// 캐시된 payload 객체를 직접 mutate하지 않도록 주의 — map으로 새 배열/객체를 만든다
sendJson(response, 200, {
  ...payload,
  cards: payload.cards.map(({ body, commentsText, ...listCard }) => listCard),
});
```
> ⚠️ 주의: 리스트 캐시가 있는 구조라면(TTL 캐시 등), 캐시가 반환하는 객체 참조를 그대로 mutate하면 캐시 자체가 오염된다. 반드시 새 배열/객체를 만들어서 응답해야 한다.

**(2) 상세 전용 API를 새로 추가** — 이미 있던 "단일 항목 조회" 로직(여기서는 파일 하나를 파싱하는 함수)을 재사용해서, path 하나만 받아 무거운 필드까지 포함한 전체 데이터를 반환.

**(3) 프론트엔드: 클릭 시 "목록 데이터로 즉시 표시 → 상세 fetch로 채우기" 2단계 렌더링**

```tsx
const openDetail = async (item: ListItem) => {
  setSelected(item);        // 목록에 있던 요약 정보로 즉시 모달 오픈 (반응성 유지)
  setIsLoadingDetail(true);
  try {
    const detail = await fetch(`/api/detail?id=${item.id}`).then(r => r.json());
    setSelected((current) => (current?.id === item.id ? { ...current, ...detail } : current));
  } finally {
    setIsLoadingDetail(false);
  }
};
```

### 놓치기 쉬운 함정: "목록 새로고침이 열려있는 상세를 덮어쓴다"

목록이 5초마다 폴링되는 구조였고, 기존 코드는 "선택된 항목을 최신 목록 데이터와 동기화"하는 `useEffect`가 있었다:

```tsx
// BEFORE (버그): 폴링마다 selected를 목록의 (이제는 body가 빠진) 항목으로 통째로 교체 → 상세 내용이 사라짐
useEffect(() => {
  setSelected((current) => current && (items.find(i => i.id === current.id) ?? null));
}, [items]);
```

목록 응답에서 무거운 필드를 뺀 순간, 이 sync 로직이 **상세 fetch로 채워놓은 내용을 5초마다 목록 데이터로 덮어써서 지워버리는** 부작용이 생긴다. 페이로드를 분리할 때는 반드시 "목록 갱신 시 상세 화면 상태를 어떻게 할지"를 같이 점검해야 한다.

수정: "동기화(내용 교체)"가 아니라 "존재 여부 확인(삭제됐으면 닫기)"으로 책임을 좁힘.

```tsx
// AFTER: 삭제된 경우에만 모달을 닫고, 그 외에는 이미 로드된 상세 내용을 그대로 유지
useEffect(() => {
  setSelected((current) => {
    if (!current) return current;
    return items.some((i) => i.id === current.id) ? current : null;
  });
}, [items]);
```

### 검증 방법

- 목록 API 응답에 무거운 필드가 실제로 빠졌는지 (`Object.prototype.hasOwnProperty`)
- 상세 API가 전체 필드를 정상 반환하는지
- 상세 모달을 연 상태로 **폴링 주기(5초)를 넘겨 대기**한 뒤에도 내용이 그대로인지 (이게 핵심 회귀 테스트 — 실제로 위 버그를 이 방법으로 잡았다)

---

## 공통 교훈

1. **"라이브러리 없이 직접 구현"이 가능한지는 CSS 제약(고정 높이/고정 컬럼)을 먼저 확인**하면 판단할 수 있다. 제약이 있는 만큼 구현이 단순해지고 회귀 위험도 줄어든다.
2. **응답 페이로드를 줄일 때는 "그 데이터를 나중에 참조하는 다른 로직"이 있는지 반드시 찾아본다.** 이번 경우 폴링 sync effect가 그 예시였고, 놓쳤다면 "상세를 열자마자 잠깐 보이다가 사라짐" 같은 재현하기 까다로운 버그가 됐을 것이다.
3. **가상화·페이로드 분리처럼 "눈에 보이는 회귀"가 날 수 있는 변경은, 실제 데이터 규모로 headless 브라우저 검증(스크린샷 + DOM 카운트 + 폴링 경과 후 상태 비교)까지 하고 나서 커밋하는 것이 안전하다.** 타입체크 통과만으로는 이런 종류의 버그(레이아웃 어긋남, 폴링 시 상태 덮어쓰기)를 잡을 수 없었다.
