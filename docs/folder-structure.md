# Folder Structure

```text
SNS-Reader/
  AGENTS.md
  README.md
  package.json
  index.html
  vite.config.mts       Vite dev server + dev API (/api/*) + PDF generation backend
  electron/
    main.ts
    preload.ts
  src/
    App.tsx
    main.tsx
    components/
    settings/
      defaults.ts
      storage.ts
      llm.ts
    styles/
      app.css
    types/
      domain.ts
  tools/                 Node CLI scripts: import/update collectors, dedupe, validate, enrich, audit
  docs/
    architecture.md
    folder-structure.md
    ui-layout.md
    roadmap.md
  assets/                Cover images and other bundled app assets
  data/
    sample-md/
    runtime/             Local settings JSON, Playwright browser profile (gitignored)
    credentials/         (gitignored, not committed)
  exports/
  memory-bank/
    active-context.md
    STATE.md
    CACHE.md
    knowledge/
      PATTERNS.md
      RULES.md
      trouble-shooting.md
```

## 역할

- `electron/`: PC 앱 창, 로컬 파일 접근, 향후 보안 저장소 연동
- `vite.config.mts`: dev 모드에서 `/api/markdown-cards`, `/api/media`, `/api/settings`, PDF 생성 등 백엔드 역할을 겸하는 Vite 미들웨어. 원래 계획했던 `src/services/*` 모듈 경계 대신 여기와 `tools/*.mjs`에 실제 로직이 있다.
- `src/`: React UI와 앱 상태
- `src/settings/`: 설정 기본값, localStorage/API 저장, LLM 프로바이더 설정
- `src/types/`: SNS 계정, Obsidian export, PDF export 공통 타입
- `tools/`: 플랫폼별 수집/업데이트, 중복 제거, 검증, LLM 보강, 감사용 CLI 스크립트 (npm script로 연결됨)
- `docs/`: 설계, UI 배치, 개발 로드맵
- `data/sample-md/`: PDF 변환 테스트용 Markdown 샘플
- `data/runtime/`, `data/credentials/`: 로컬 전용 런타임 상태 (git에 포함되지 않음)
- `exports/`: 생성된 PDF 또는 임시 산출물
- `memory-bank/`: 프로젝트 진행 상태와 재사용 지식

## Obsidian 결과물 폴더 구조

앱이 생성하는 Markdown과 그림은 사용자가 지정한 Obsidian 폴더 아래에 저장합니다. 기본 구조는 **SNS별 폴더 → YYYY-MM 폴더 → 글 파일과 assets 폴더**입니다.

```text
ObsidianVault/
  SNS/
    instagram/
      2026-07/
        2026-07-22_1530_instagram_Cx9ab12.md
        assets/
          2026-07-22_1530_instagram_Cx9ab12/
            image-001.jpg
            image-002.jpg
            collage.jpg
            meta.json
    naver-blog/
      2026-07/
        2026-07-20_1012_naver-blog_223456789.md
        assets/
          2026-07-20_1012_naver-blog_223456789/
            image-001.jpg
            collage.jpg
```

## 기본 저장 규칙

- Markdown 파일은 `YYYY-MM-DD_HHmm_platform_post-id.md` 형식으로 저장합니다.
- SNS별 폴더는 `facebook`, `instagram`, `x`, `naver-blog`처럼 고정된 영문 키를 사용합니다.
- 월별 폴더는 게시글 작성일 기준 `YYYY-MM`으로 만듭니다.
- 그림은 Markdown 파일이 있는 월별 폴더 안의 `assets/{post-file-id}/`에 저장합니다.
- 그림이 여러 장이면 `collage.jpg`를 추가로 만들고, 원본 그림도 모두 보존합니다.
- 댓글, 요약, 태그는 Markdown 내부 섹션과 frontmatter에 저장합니다.

## 예시

Instagram 글 하나를 저장하면 아래처럼 만들어집니다.

```text
C:\Users\me\Obsidian\SNS\instagram\2026-07\
  2026-07-22_1530_instagram_Cx9ab12.md
  assets\
    2026-07-22_1530_instagram_Cx9ab12\
      image-001.jpg
      image-002.jpg
      collage.jpg
      meta.json
```

Markdown 내부에서는 상대 경로로 그림을 참조합니다.

```markdown
![그림 콜라주](assets/2026-07-22_1530_instagram_Cx9ab12/collage.jpg)
```

## PDF 결과물 폴더 구조

PDF는 사용자가 지정한 PDF 저장 폴더 아래에 생성합니다.

```text
PDFExports/
  yearly/
    SNS_2024.pdf
    SNS_2025.pdf
  date-range/
    SNS_2024-03-11_2025-03-10.pdf
  page-count/
    SNS_part-001.pdf
    SNS_part-002.pdf
```
