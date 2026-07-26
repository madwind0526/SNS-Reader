# Roadmap

## Wave 1: Project Scaffold — 완료

- 폴더 구조 생성
- Electron + React + TypeScript 기본 앱 생성
- Obsidian/PDF 메뉴 UI 초안 생성
- 설계 문서 작성
- git 초기화

## Wave 2: Settings Persistence — 완료

- 설정 저장/불러오기 (`src/settings/storage.ts`, localStorage + Electron/Vite dev API)
- SNS 계정 추가/삭제 UI
- 폴더 선택 다이얼로그
- 테마 저장 (일반 설정으로 통합)

## Wave 3: Obsidian Export MVP — 완료

- Markdown 생성, 게시글별 미디어 폴더, 콜라주 이미지, Markdown 미리보기
- 확장: `tools/validate-sns-markdown.mjs`, `tools/dedupe-sns-markdown.mjs`(플랫폼 스코프 중복 제거)로 데이터 무결성 확보
- 확장: `tools/enrich-sns-markdown.mjs` + `tools/audit-sns-enrichment.mjs`로 LLM 기반 요약/태그 보강 및 재개 가능한 감사(3901/3901 완료, 누락 0건)

## Wave 4: Source Collectors — 완료 (원래 범위보다 확장)

- Naver Blog 공개 글 수집 + 증분 업데이트 (RSS, 전체글 목록, MemoLog)
- Facebook, Instagram, Threads: 공식 export(JSON/zip) 및 로그인 브라우저 세션 수집 모두 구현
- YouTube: Takeout 커뮤니티 게시물 + 커뮤니티 업데이트 수집 추가 (원 로드맵에는 없던 범위)
- 로그인 필요 플로우: Playwright 지속 프로필(`data/runtime/browser-profile`) 기반 로그인 브라우저 + CDP 폴백

## Wave 5: PDF Export MVP — 완료 (원래 범위보다 확장)

- Markdown 파서, 책 단위 분할(연도/날짜/페이지 수), 표지/요약/본문 페이지 렌더링, 게시글별 새 페이지 보장
- 확장: 표지 이미지 교체, 콜라주/오버뷰/월별 헤더, 타이포그래피 설정, 워드클라우드, 기간 단위 요약 내러티브, 이미지 화질 업그레이드(Naver), 페이지 수 분할 최소 청크 보장

## Wave 4.5 (비공식): Mesh View — 완료, 원 로드맵에 없던 추가 기능

- 태그 공유 기반 포스트 그래프 시각화, 연결 수 기반 노드 크기, Top TAG 패널, 휠 줌 + 드래그 팬, 라이트/다크 모드 가시성 튜닝

## Wave 6: Packaging — 미착수 (다음 목표)

- Windows 설치 파일 생성 (electron-builder 설정 없음 — `dist-electron/`만 존재, 패키징 스크립트 없음)
- 설정 마이그레이션
- 오류 로그와 복구 화면
- Electron 메인 프로세스와 Vite dev API/PDF 백엔드(`vite.config.mts`)의 프로덕션 연결 정리

---

*2026-07-26 기준. `memory-bank/STATE.md`의 Wave 번호는 세션 단위 작업 배치를 추적하는 별도 카운터이며, 위 로드맵 Wave 번호(제품 마일스톤)와 다르다.*
