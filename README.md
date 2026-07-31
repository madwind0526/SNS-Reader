# SNS Reader

SNS Reader는 Facebook, Instagram, X, Naver Blog 같은 SNS/블로그 글을 읽어서 Obsidian용 Markdown Database와 PDF 책으로 정리하는 PC 앱입니다.

## 현재 상태 (2026-07-31, v0.7.0)

- Electron + React + TypeScript + Vite 앱, Obsidian DB 만들기 / PDF 만들기 / Mesh View / 설정 메뉴 구현
- SNS 수집: Facebook·Instagram·Threads(공식 export + 로그인 브라우저 세션), Naver Blog(공개 크롤링 + 증분 업데이트), YouTube(Takeout 커뮤니티) — `tools/import-*.mjs`
- 로그인 필요 플랫폼은 Playwright 지속 프로필 기반 로그인 브라우저로 세션 수집
- SNS Update는 마지막 글 날짜에서 설정 가능한 며칠(`snsUpdateLookbackDays`, 기본 3일) 앞부터 재확인해 최근 글의 수정(이미지 추가 등)도 반영하고, 글마다 실제 사진(Instagram/Threads는 og:image, Facebook은 크롤러 User-Agent 경로)을 내려받으며, Threads의 글자 수 제한으로 나뉜 본문+답글은 자동으로 하나의 글로 합쳐진다
- 앱 첫 로드 시 짧은 인트로 화면(`assets/Intro.png`)을 보여주고, 상단 "SNS Reader" 제목 클릭으로 다시 재생 가능
- LLM 기반 요약/태그 자동 보강 + 재개 가능한 감사 파이프라인 (`tools/enrich-sns-markdown.mjs`, `tools/audit-sns-enrichment.mjs`)
- PDF Maker: 연도/날짜/페이지 수 분할, 표지·콜라주·오버뷰·워드클라우드, 타이포그래피 설정, SNS 플랫폼 선택 필터
- Mesh View: 태그 공유 기반 포스트 그래프 시각화
- 카드 목록은 가상화(virtualization)로 렌더링되고 목록/상세 API 응답이 분리되어 있어 대용량 아카이브(수천 건)에서도 가볍게 동작하며, `/api/*` 엔드포인트에는 CSRF/경로 순회 방어가 적용되어 있다
- 남은 큰 작업: Windows 설치 파일 패키징 (`docs/roadmap.md`의 Wave 6 참고)

## 실행

Windows 앱(Electron 창)으로 바로 실행:

```bash
npm install
npm start
```

`npm start`는 Electron 메인 프로세스를 빌드하고, Vite 개발 서버를 띄운 뒤, 그 서버에 연결된 Electron 창을 자동으로 엽니다 (`tools/start-app.mjs`).

브라우저에서만 UI를 확인하려면:

```bash
npm run dev
```

으로 Vite 개발 서버만 띄우고 `http://127.0.0.1:5173`을 열면 됩니다.

## 주요 문서

- `docs/folder-structure.md`
- `docs/ui-layout.md`
- `docs/architecture.md`
- `docs/roadmap.md`
