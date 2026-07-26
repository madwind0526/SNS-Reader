# SNS Reader

SNS Reader는 Facebook, Instagram, X, Naver Blog 같은 SNS/블로그 글을 읽어서 Obsidian용 Markdown Database와 PDF 책으로 정리하는 PC 앱입니다.

## 현재 상태 (2026-07-26, v0.6.0)

- Electron + React + TypeScript + Vite 앱, Obsidian DB 만들기 / PDF 만들기 / Mesh View / 설정 메뉴 구현
- SNS 수집: Facebook·Instagram·Threads(공식 export), Naver Blog(공개 크롤링 + 증분 업데이트), YouTube(Takeout 커뮤니티) — `tools/import-*.mjs`
- 로그인 필요 플랫폼은 Playwright 지속 프로필 기반 로그인 브라우저로 세션 수집
- LLM 기반 요약/태그 자동 보강 + 재개 가능한 감사 파이프라인 (`tools/enrich-sns-markdown.mjs`, `tools/audit-sns-enrichment.mjs`)
- PDF Maker: 연도/날짜/페이지 수 분할, 표지·콜라주·오버뷰·워드클라우드, 타이포그래피 설정
- Mesh View: 태그 공유 기반 포스트 그래프 시각화
- 남은 큰 작업: Windows 설치 파일 패키징 (`docs/roadmap.md`의 Wave 6 참고)

## 실행

```bash
npm install
npm run dev
```

브라우저에서 Vite 개발 서버를 열어 UI를 확인할 수 있습니다. Electron 앱 실행 스크립트는 다음 구현 단계에서 dev server와 연결해 확장합니다.

## 주요 문서

- `docs/folder-structure.md`
- `docs/ui-layout.md`
- `docs/architecture.md`
- `docs/roadmap.md`
