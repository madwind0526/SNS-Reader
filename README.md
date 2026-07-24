# SNS Reader

SNS Reader는 Facebook, Instagram, X, Naver Blog 같은 SNS/블로그 글을 읽어서 Obsidian용 Markdown Database와 PDF 책으로 정리하는 PC 앱입니다.

## 현재 상태

- Electron + React + TypeScript 프로젝트 초기화
- Obsidian DB 만들기 / PDF 만들기 / 설정 메뉴 UI 초안
- 라이트/다크 모드 토글
- 설계 문서와 폴더 구조 문서 작성

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
